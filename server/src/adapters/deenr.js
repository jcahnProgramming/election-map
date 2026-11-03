// Delaware Department of Elections ENR (elections.delaware.gov/results/enr/{electionId}.html).
//
// Files (verified live on 2026-11-03 for GE2026; the page's own js/results.js names them; plain JSON, ETag'd,
// max-age=180):
//   Election_StatewideResults_ID_{id}.json       one row per candidate: "Contest Title", "Candidate Name", "Party Name",
//                                                "Pos", "Total Precincts", "Precincts Reported", "Machine Votes",
//                                                "Absentee Votes", "Early Voting Votes", "Total Votes" (strings),
//                                                "ReportTime" ("2026-09-29T09:35:45.646-04:00", the page's "Data as of")
//   Election_ByCountyWithWilmington_ID_{id}.json same rows with "New Castle", "Kent", "Sussex", "State" vote columns
//                                                (also "Wilmington" / "Rest of New Castle", sub-county, unused). No
//                                                precincts or vote types per county.
//   Election_VoterTurnout_ID_{id}.json           per state representative district plus "ALL": "Ballots Cast",
//                                                "Reg Voters" (the page hard-codes registration because this was "0"),
//                                                "Percentage". A zero registration is treated as unpublished (null).
// Delaware has no county-level turnout and no ballot measures in 2026. No winner flags exist.
// The Socrata copy (data.delaware.gov yg7x-kgjc) is not used: data_as_of was still 2026-09-29 on election night.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const METHODS = [
  ['Machine Votes', 'Machine Votes'],
  ['Absentee Votes', 'Absentee Votes'],
  ['Early Voting Votes', 'Early Voting Votes'],
];
const lastVersion = new Map();

function targets() {
  const c = readConfig('sources/deenr.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `DE/${e.electionId}`,
      electionId: e.electionId,
      base: e.base ?? c.base,
      state: e.state ?? 'DE',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      countyColumns: e.countyColumns ?? ['New Castle', 'Kent', 'Sussex'],
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 3000,
      url: e.url ?? `${e.base ?? c.base}/${e.electionId}.html`,
    }));
}

async function fetchTarget(t, { http, unmatched }) {
  const file = (name) => `${t.base}/Election_${name}_ID_${encodeURIComponent(t.electionId)}.json`;
  // One at a time with a pause between: the site's firewall answers back-to-back requests with a "Request Rejected"
  // page (seen 2026-11-03). We slow down rather than retry; a rejection fails the poll and the poller backs off.
  const s = await http.get(file('StatewideResults'), { conditional: true });
  await pause(t.requestGapMs);
  const c = await http.get(file('ByCountyWithWilmington'), { conditional: true });
  await pause(t.requestGapMs);
  const v = await http.get(file('VoterTurnout'), { conditional: true }).catch(() => null); // turnout is optional
  const version = createHash('sha1').update(s.text).update(c.text).update(v?.text ?? '').digest('hex').slice(0, 16);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const result = parseDeEnr({
    statewide: parseArray(s.text, 'StatewideResults'),
    byCounty: parseArray(c.text, 'ByCountyWithWilmington'),
    turnout: v ? optional(() => parseArray(v.text, 'VoterTurnout')) : null,
  }, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
function optional(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function parseArray(text, what) {
  // The firewall's block page comes back as HTTP 200 HTML. Fail the poll (the poller backs off); never work around it.
  if (/<title>\s*Request Rejected/i.test(text)) throw new Error(`DE ENR ${what}: blocked by the site firewall ("Request Rejected")`);
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    throw new Error(`DE ENR ${what}: not JSON (${err.message}): ${JSON.stringify(String(text).slice(0, 60))}`);
  }
  if (!Array.isArray(j)) throw new Error(`DE ENR ${what}: not an array`);
  return j;
}

/**
 * Pure parse of the Delaware ENR files into the adapter result (without `version`).
 * @param {{ statewide:object[], byCounty:object[], turnout:object[]|null }} data
 */
export function parseDeEnr({ statewide, byCounty = [], turnout = null }, t, unmatched = () => {}) {
  const state = t.state ?? 'DE';
  const counties = [];
  for (const col of t.countyColumns ?? []) {
    const m = matchCounty(state, col);
    if (!m) unmatched('county', col, `${state} ENR by-county column`);
    else counties.push({ col, ...m });
  }

  let updated = null;
  for (const r of statewide) {
    const d = r.ReportTime ? new Date(r.ReportTime) : null;
    if (d && !Number.isNaN(d.getTime()) && (!updated || d.toISOString() > updated)) updated = d.toISOString();
  }

  const byContest = groupBy(statewide, (r) => r['Contest Title']);
  const countyByContest = groupBy(byCounty, (r) => r['Contest Title']);

  const races = [];
  for (const [title, rowsRaw] of byContest) {
    const rows = [...rowsRaw].sort((a, b) => (num(a.Pos) ?? 0) - (num(b.Pos) ?? 0));
    const labels = rows.map((r) => String(r['Candidate Name'] ?? '').trim());
    const cls = classifyContest(title, labels);
    if (!cls) continue;
    if (cls.office === 'measure' ? !t.measures : !(t.races ?? ['senate', 'governor', 'house']).includes(cls.office)) continue;
    const isMeasure = cls.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;

    const choices = rows.map((r, i) => {
      const split = splitPartyPrefix(labels[i]);
      const raw = String(r['Party Name'] ?? '').trim() || split.partyRaw || '';
      if (isMeasure) return { name: split.name, party: 'OTHER', partyRaw: raw };
      const { party, known } = normalizeParty(raw);
      if (!known) unmatched('party', raw, `${state} ${title} / ${labels[i]}`);
      return { name: split.name, party, partyRaw: raw };
    });

    const withYesNo = (u) => {
      if (isMeasure) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      return u;
    };
    const pr = num(rows[0]['Precincts Reported']);
    const pt = num(rows[0]['Total Precincts']);
    const votes = rows.map((r) => num(r['Total Votes']) ?? 0);
    const methods = METHODS.filter(([f]) => rows.some((r) => r[f] != null)).map(([f, label]) => {
      const v = rows.map((r) => num(r[f]) ?? 0);
      return { label, bucket: methodBucket(label), votes: isMeasure ? [v[yesIdx] ?? 0, v[noIdx] ?? 0] : v };
    });
    const units = [withYesNo({
      level: 'state', name: state, votes, precinctsReporting: pr, precinctsTotal: pt,
      pctReporting: pt ? round1((100 * (pr ?? 0)) / pt) : null,
      ...(methods.length ? { methods } : {}),
    })];

    // County columns, matched to the statewide rows by candidate name. The races we track are statewide, so every
    // county column applies.
    const cRows = countyByContest.get(title) ?? [];
    if (cRows.length) {
      const byName = new Map(cRows.map((r) => [String(r['Candidate Name'] ?? '').trim(), r]));
      for (const cty of counties) {
        if (!cRows.some((r) => r[cty.col] != null)) continue;
        units.push(withYesNo({
          level: 'county', countyFips: cty.fips, name: cty.name,
          votes: labels.map((l) => num(byName.get(l)?.[cty.col]) ?? 0),
          precinctsReporting: null, precinctsTotal: null, pctReporting: null,
        }));
      }
    }

    races.push({
      office: cls.office,
      district: cls.district ?? (cls.office === 'house' ? 'AL' : null),
      name: title,
      key: title,
      voteFor: null,
      statewide: true,
      title: isMeasure ? title : null,
      choices,
      units,
    });
  }

  const turnoutUnits = [];
  const all = turnout?.find((r) => String(r['Representative District']).toUpperCase() === 'ALL');
  if (all) {
    const widest = statewide.reduce((a, r) => ((num(r['Total Precincts']) ?? -1) > (num(a?.['Total Precincts']) ?? -1) ? r : a), null);
    const registered = num(all['Reg Voters']) || null; // "0" here means not filled in, not zero voters
    turnoutUnits.push({
      level: 'state', name: state,
      registered,
      ballotsCast: num(all['Ballots Cast']),
      turnoutPct: registered ? num(all.Percentage) : null,
      precinctsReporting: num(widest?.['Precincts Reported']),
      precinctsTotal: num(widest?.['Total Precincts']),
    });
  }

  return {
    election: { sourceKey: t.key, state, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: updated,
    turnout: turnoutUnits,
    races,
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows ?? []) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const round1 = (x) => Math.round(x * 10) / 10;

export default {
  id: 'deenr',
  name: 'Delaware Department of Elections ENR',
  homepage: 'https://elections.delaware.gov/results/enr/',
  targets,
  fetch: fetchTarget,
};
