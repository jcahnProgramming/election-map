// Alaska Division of Elections ENR (https://www.elections.alaska.gov/election-results/e/?id={electionId}).
//
// One file, linked from that page (verified live on 2026-11-03 for 26GENR; text/csv, ETag + Last-Modified, ~3 MB):
//   https://www.elections.alaska.gov/enr/{ELECTIONID}/results/GA_ENR_Precinct_State_of_Alaska.csv
// One row per precinct × contest × candidate: Precinct_name, Reporting_flag (0/1), Pct_Id ("01-600"), Reg_voters,
// Contest_Id, Contest_seq_nbr, Contest_title, Selectable_Options (vote for), candidate_id, candidate_name ("Last, First"),
// cand_seq_nbr, Party_Code (REP / DEM / NON / LIB / UND / "DEM/NON" for a ticket; blank for questions), total_ballots,
// total_votes, and the same per vote type: "Election Day_votes", "Absentee_votes", "Early Voting_votes",
// "Question_votes" (questioned ballots), "Remote_votes". Absentee / early / questioned ballots counted district-wide sit
// in pseudo-precincts ("District 12 - Absentee", "HD99 Fed Overseas Absentee"), so summing every row gives the totals.
// Alaska has no counties (elections run by House district): statewide totals only. Ranked-choice contests: these are
// FIRST-CHOICE counts, as the Division publishes them on election night (the RCV tabulation comes later, as PDFs).
// The PDFs (ElectionSummaryReportRPT.pdf, HD{n}.pdf) are not used. No winner flags exist.
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, methodBucket, yesNoSide } from '../normalize.js';

const METHODS = [
  ['Election Day_votes', 'Election Day'],
  ['Absentee_votes', 'Absentee'],
  ['Early Voting_votes', 'Early Voting'],
  ['Question_votes', 'Question'],
  ['Remote_votes', 'Remote'],
];
const STATEWIDE_SHARE = 0.95;
const lastVersion = new Map();

function targets() {
  const c = readConfig('sources/akdoe.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `AK/${e.electionId}`,
      electionId: e.electionId,
      state: 'AK',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      csv: e.csv ?? `${c.base}/enr/${e.electionId}/results/GA_ENR_Precinct_State_of_Alaska.csv`,
      url: e.url ?? `https://www.elections.alaska.gov/election-results/e/?id=${e.electionId.toLowerCase()}`,
      levels: ['state'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      allContests: e.allContests ?? true,
    }));
}

async function fetchTarget(t, { http, unmatched }) {
  const res = await http.get(t.csv, { conditional: true, timeoutMs: 60000, accept: 'text/csv' });
  if (res.notModified && lastVersion.has(t.key)) return { changed: false, version: lastVersion.get(t.key) };
  const lm = res.headers?.get?.('last-modified');
  const version = res.headers?.get?.('etag')?.replace(/"/g, '') || lm || String(res.text.length);
  if (lastVersion.get(t.key) === version) return { changed: false, version };
  const updated = lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : null;
  const result = parseAkCsv(res.text, t, unmatched, updated);
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

/** RFC 4180-ish CSV (quoted fields, doubled quotes). The file ends each line with a trailing comma. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n') {
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round1 = (x) => Math.round(x * 10) / 10;
const isRealPrecinct = (id) => /^\d{2}-\d{3}$/.test(String(id ?? '').trim());

/** "DEM/NON" (a governor ticket) → DEM: one major party decides; unknown parts are logged. */
function ticketParty(raw, unmatched, context) {
  let dem = false;
  let rep = false;
  for (const p of String(raw ?? '').split('/').map((x) => x.trim()).filter(Boolean)) {
    const { party, known } = normalizeParty(p);
    if (party === 'DEM') dem = true;
    else if (party === 'REP') rep = true;
    else if (!known) unmatched('party', p, context);
  }
  return dem && !rep ? 'DEM' : rep && !dem ? 'REP' : 'OTHER';
}

/**
 * Pure parse of the precinct CSV into the adapter result (without `version`).
 * @param {string} text CSV text
 */
export function parseAkCsv(text, t, unmatched = () => {}, sourceUpdatedAt = null) {
  const all = parseCsv(text);
  const header = (all[0] ?? []).map((h) => h.trim());
  if (!header.includes('Contest_title') || !header.includes('total_votes')) {
    throw new Error(`AK ENR CSV: unexpected header ${JSON.stringify(header.slice(0, 8))}`);
  }
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const methodCols = METHODS.filter(([c]) => c in col);
  const get = (r, k) => r[col[k]];

  // Precincts (for registration and reporting) and contests.
  const precincts = new Map(); // Pct_Id → { reg, reported }
  const contests = new Map(); // Contest_Id → { title, voteFor, cands: Map(candId → {...}), pcts: Map(pctId → reported), ballotsByPct }
  for (const r of all.slice(1)) {
    if (r.length < header.length - 1) continue;
    const pid = String(get(r, 'Pct_Id') ?? '').trim();
    const reported = String(get(r, 'Reporting_flag')).trim() === '1';
    if (isRealPrecinct(pid) && !precincts.has(pid)) precincts.set(pid, { reg: num(get(r, 'Reg_voters')), reported });
    const cid = String(get(r, 'Contest_Id')).trim();
    if (!contests.has(cid)) {
      contests.set(cid, {
        title: String(get(r, 'Contest_title') ?? '').replace(/\s+/g, ' ').trim(),
        seq: num(get(r, 'Contest_seq_nbr')) ?? 0,
        voteFor: num(get(r, 'Selectable_Options')),
        cands: new Map(),
        pcts: new Map(),
        ballotsByPct: new Map(),
      });
    }
    const c = contests.get(cid);
    if (isRealPrecinct(pid)) c.pcts.set(pid, reported);
    c.ballotsByPct.set(pid, Math.max(c.ballotsByPct.get(pid) ?? 0, num(get(r, 'total_ballots')) ?? 0));
    const kid = String(get(r, 'candidate_id')).trim();
    if (!c.cands.has(kid)) {
      c.cands.set(kid, {
        name: String(get(r, 'candidate_name') ?? '').replace(/\s+/g, ' ').trim(),
        partyRaw: String(get(r, 'Party_Code') ?? '').trim(),
        seq: num(get(r, 'cand_seq_nbr')) ?? 999,
        votes: 0,
        methods: methodCols.map(() => 0),
      });
    }
    const k = c.cands.get(kid);
    k.votes += num(get(r, 'total_votes')) ?? 0;
    methodCols.forEach(([m], i) => { k.methods[i] += num(get(r, m)) ?? 0; });
  }

  const totalPrecincts = precincts.size;
  const races = [];
  for (const c of [...contests.values()].sort((a, b) => a.seq - b.seq)) {
    if (!c.title) continue;
    const list = [...c.cands.values()].sort((a, b) => a.seq - b.seq);
    const labels = list.map((x) => x.name);
    const cls = classifyContest(c.title, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    const choices = list.map((x) => (isMeasure
      ? { name: x.name, party: 'OTHER', partyRaw: x.partyRaw }
      : { name: x.name, party: ticketParty(x.partyRaw, unmatched, `AK ${c.title} / ${x.name}`), partyRaw: x.partyRaw }));
    const pt = c.pcts.size;
    const pr = [...c.pcts.values()].filter(Boolean).length;
    const statewide = totalPrecincts > 0 && pt >= STATEWIDE_SHARE * totalPrecincts;
    const votes = list.map((x) => x.votes);
    const methods = methodCols.map(([, label], i) => {
      const v = list.map((x) => x.methods[i]);
      return { label, bucket: methodBucket(label), votes: isMeasure ? [v[yesIdx] ?? 0, v[noIdx] ?? 0] : v };
    });
    const unit = {
      level: 'state', name: statewide ? 'AK' : c.title, votes,
      precinctsReporting: pt ? pr : null, precinctsTotal: pt || null, pctReporting: pt ? round1((100 * pr) / pt) : null,
      ...(methods.length ? { methods } : {}),
    };
    if (isMeasure) {
      unit.yes = votes[yesIdx] ?? 0;
      unit.no = votes[noIdx] ?? 0;
    }
    races.push({
      office: cls?.office ?? null,
      district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
      name: c.title,
      key: c.title,
      voteFor: c.voteFor || null,
      statewide,
      title: isMeasure ? c.title : null,
      choices,
      units: [unit],
    });
  }

  // Ballots cast: per (pseudo-)precinct the most ballots any contest there saw, summed.
  const ballotsByPct = new Map();
  for (const c of contests.values()) for (const [p, b] of c.ballotsByPct) ballotsByPct.set(p, Math.max(ballotsByPct.get(p) ?? 0, b));
  const registered = [...precincts.values()].reduce((a, p) => a + (p.reg ?? 0), 0) || null;
  const ballotsCast = [...ballotsByPct.values()].reduce((a, b) => a + b, 0);
  const reportedPcts = [...precincts.values()].filter((p) => p.reported).length;

  return {
    election: { sourceKey: t.key, state: 'AK', scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt,
    turnout: [{
      level: 'state', name: 'AK', registered, ballotsCast,
      turnoutPct: registered ? round1((100 * ballotsCast) / registered) : null,
      precinctsReporting: totalPrecincts ? reportedPcts : null, precinctsTotal: totalPrecincts || null,
    }],
    races,
  };
}

export default {
  id: 'akdoe',
  name: 'Alaska Division of Elections',
  homepage: 'https://www.elections.alaska.gov/election-results/',
  targets,
  fetch: fetchTarget,
};
