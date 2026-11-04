// PCC Technology public election reporting (Connecticut: https://ctemspublic.tgstg.net/).
//
// File layout (verified live on 2026-11-03, election 108):
//   {base}/Elections.json                              [{ ID, Name, DefaultElection }]
//   {base}/election/{id}/Version.json                  { Version: 52085 }   (re-read every poll; tiny)
//   {base}/election/{id}/{ver}/Electiondata.json       ~380 KB:
//       election      { BC ballots cast, RV registered, TO turnout %, PR "n of m (x%)" precincts, T towns reporting }
//       voterTurnout  { townId: { NM, EV registered, VV voted, ABR/ABC absentee rcvd/counted, EBR/EBC early, EDR/EDC EDR, TO } }
//       townStatus    { townId: { TS, PR "n of m (x%)" } }
//       stateVotes    { officeId: [ { candidateLineId: { V, TO } } ] }   one entry per party line
//       townVotes     { townId: { officeId: [ { candidateLineId: { V, TO } } ] } }
//       ballotQuestion{ townName: [ { QN, YES, NO, NTH, NTL } ] }   ("-" before any count)
//       candidateGrouping { officeId: [ { lineId: { V } } ] }  fusion totals per person (statewide only)
//   {base}/election/{id}/{ver}/Lookupdata.json         ~210 KB: townIds, counties, countyTowns, officeList,
//                                                       partyIds { id: { CD, NM } }, candidateIds { id: { NM, P } }
// A {ver} folder is immutable, so we only download it when Version.json changes.
//
// Connecticut reports by TOWN. County units are built (sum of towns) only because Lookupdata.json itself says
// which county each town is in. Fusion voting: one person can appear on several party lines (D + WF); the lines
// of one candidate in one contest are summed into one choice, with every line's code kept in partyRaw ("D/WF").
// That is one person's votes in one contest, never a sum across contests.
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → Version

function targets() {
  const cfg = readConfig('sources/pccct.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `${e.state}/${e.electionId}`,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      base: e.base.replace(/\/$/, ''),
      electionId: String(e.electionId),
      url: e.url,
      date: e.date ?? null,
    }));
}

const int = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[,%\s]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** "12 of 778 (1.54%)" → { reporting: 12, total: 778 } */
const nOfM = (s) => {
  const m = String(s ?? '').match(/(\d[\d,]*)\s+of\s+(\d[\d,]*)/i);
  return m ? { reporting: int(m[1]), total: int(m[2]) } : { reporting: null, total: null };
};
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (r, t) => (t ? round1((100 * (r ?? 0)) / t) : null);
const sumOrNull = (xs) => (xs.length && xs.every((x) => x == null) ? null : xs.reduce((s, x) => s + (x ?? 0), 0));
/** [ { id: {V} }, ... ] → [ [id, votes] ] */
const lines = (arr) => (arr ?? []).map((o) => {
  const [id, v] = Object.entries(o)[0];
  return [id, int(v?.V) ?? 0];
});
const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Pure: Electiondata.json + Lookupdata.json → contract result fields.
 * @returns {{ turnout, races, electionName, electionDate }}
 */
export function parsePcc(data, lookup, t, { unmatched = () => {} } = {}) {
  const state = t.state;
  // town → county
  const counties = new Map(); // countyId → { fips, name }
  for (const [cid, cname] of Object.entries(lookup.counties ?? {})) {
    const m = matchCounty(state, cname);
    if (m) counties.set(String(cid), m);
    else unmatched('county', cname, `${state} PCC county list`);
  }
  const townCounty = new Map(); // townId → { fips, name }
  for (const ct of lookup.countyTowns ?? []) {
    const c = counties.get(String(ct.CountyID));
    if (c) townCounty.set(String(ct.TownID), c);
  }
  for (const [tid, tname] of Object.entries(lookup.townIds ?? {})) {
    if (!townCounty.has(tid)) unmatched('county', tname, `${state} PCC town with no county in countyTowns`);
  }
  const countyList = [...new Map([...townCounty.values()].map((c) => [c.fips, c])).values()];
  const townsOf = (fips) => [...townCounty.entries()].filter(([, c]) => c.fips === fips).map(([tid]) => tid);

  // ---- turnout
  const townPrec = (tid) => nOfM(data.townStatus?.[tid]?.PR);
  const townTurnout = (tid) => {
    const v = data.voterTurnout?.[tid] ?? {};
    const p = townPrec(tid);
    return { registered: int(v.EV) || null, ballotsCast: int(v.VV), precinctsReporting: p.reporting, precinctsTotal: p.total };
  };
  const e = data.election ?? {};
  const statePrec = nOfM(e.PR);
  const turnout = [{
    level: 'state', name: state,
    registered: int(e.RV) || null, // a registered count of 0 means "not published yet", never zero voters
    ballotsCast: int(e.BC),
    turnoutPct: int(e.RV) ? int(e.TO) : null,
    ballotsOutstanding: null,
    precinctsReporting: statePrec.reporting, precinctsTotal: statePrec.total,
  }];
  const countyPrec = new Map();
  for (const c of countyList) {
    const rows = townsOf(c.fips).map(townTurnout);
    const agg = (k) => sumOrNull(rows.map((r) => r[k]));
    countyPrec.set(c.fips, { precinctsReporting: agg('precinctsReporting'), precinctsTotal: agg('precinctsTotal') });
    turnout.push({
      level: 'county', countyFips: c.fips, name: c.name,
      registered: agg('registered'), ballotsCast: agg('ballotsCast'), turnoutPct: null, ballotsOutstanding: null,
      ...countyPrec.get(c.fips),
    });
  }

  // ---- candidate contests
  const offices = Object.assign({}, ...(lookup.officeList ?? []));
  const races = [];
  for (const [oid, office] of Object.entries(offices)) {
    const cls = classifyContest(office.NM, []);
    if (!cls || cls.office === 'measure' || !t.races.includes(cls.office)) continue;
    const district = cls.office === 'house' ? (office.D && office.D !== '0' ? String(Number(office.D)) : cls.district) : null;
    const stLines = lines(data.stateVotes?.[oid]);
    if (!stLines.length) continue;

    // Group party lines by person.
    const choices = [];
    const lineChoice = new Map(); // lineId → choice index
    for (const [lid] of stLines) {
      const cand = lookup.candidateIds?.[lid] ?? {};
      const p = lookup.partyIds?.[cand.P] ?? {};
      const key = normName(cand.NM) || `line ${lid}`;
      let idx = choices.findIndex((c) => c._key === key);
      if (idx < 0) {
        idx = choices.push({ _key: key, name: cand.NM ?? `Candidate ${lid}`, codes: [], parties: [] }) - 1;
      }
      lineChoice.set(lid, idx);
      choices[idx].codes.push(p.CD ?? '');
      choices[idx].parties.push(partyOf(p, `${state} ${office.NM} / ${cand.NM}`, unmatched));
    }
    const outChoices = choices.map((c) => {
      const major = c.parties.find((x) => x === 'DEM' || x === 'REP');
      return { name: c.name, party: major ?? 'OTHER', partyRaw: c.codes.filter(Boolean).join('/') };
    });
    const tally = (ls) => {
      const v = new Array(choices.length).fill(0);
      for (const [lid, n] of ls) {
        const i = lineChoice.get(lid);
        if (i !== undefined) v[i] += n;
      }
      return v;
    };

    const statewide = office.OT === 'SW' || cls.office === 'senate' || cls.office === 'governor';
    const units = [{
      level: 'state', name: statewide ? state : (office.DT || office.NM),
      votes: tally(stLines),
      ...(statewide
        ? { precinctsReporting: statePrec.reporting, precinctsTotal: statePrec.total, pctReporting: pct(statePrec.reporting, statePrec.total) }
        : { precinctsReporting: null, precinctsTotal: null, pctReporting: null }),
    }];
    for (const c of countyList) {
      const towns = townsOf(c.fips).filter((tid) => data.townVotes?.[tid]?.[oid]);
      if (!towns.length) continue;
      const votes = tally(towns.flatMap((tid) => lines(data.townVotes[tid][oid])));
      // Town precinct counts cover the whole town; only a statewide contest can use them.
      const cp = statewide ? countyPrec.get(c.fips) : { precinctsReporting: null, precinctsTotal: null };
      units.push({ level: 'county', countyFips: c.fips, name: c.name, votes, ...cp, pctReporting: pct(cp.precinctsReporting, cp.precinctsTotal) });
    }
    races.push({
      office: cls.office, district, name: office.NM, key: String(oid), voteFor: 1, statewide, title: null,
      choices: outChoices, units,
    });
  }

  // ---- ballot questions: keyed by town. Only a question every town votes on is statewide.
  if (t.measures) {
    const towns = Object.entries(lookup.townIds ?? {});
    const byText = new Map(); // question text → [{ tid, yes, no }]
    const townIdByName = new Map(towns.map(([tid, n]) => [normName(n), tid]));
    for (const [townName, qs] of Object.entries(data.ballotQuestion ?? {})) {
      const tid = townIdByName.get(normName(townName));
      for (const q of qs ?? []) {
        const text = String(q.QN ?? '').replace(/^\s*\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
        if (!byText.has(text)) byText.set(text, { num: String(q.QN ?? '').match(/^\s*(\d+)\./)?.[1] ?? null, rows: [] });
        byText.get(text).rows.push({ tid, yes: int(q.YES), no: int(q.NO) });
      }
    }
    for (const [text, { num, rows }] of byText) {
      if (towns.length === 0 || new Set(rows.map((r) => r.tid)).size < towns.length) continue; // local question
      const sumRows = (rs) => ({ yes: sumOrNull(rs.map((r) => r.yes)) ?? 0, no: sumOrNull(rs.map((r) => r.no)) ?? 0 });
      const s = sumRows(rows);
      const units = [{ level: 'state', name: state, votes: [s.yes, s.no], ...s, precinctsReporting: statePrec.reporting, precinctsTotal: statePrec.total, pctReporting: pct(statePrec.reporting, statePrec.total) }];
      for (const c of countyList) {
        const set = new Set(townsOf(c.fips));
        const cs = sumRows(rows.filter((r) => set.has(r.tid)));
        const cp = countyPrec.get(c.fips);
        units.push({ level: 'county', countyFips: c.fips, name: c.name, votes: [cs.yes, cs.no], ...cs, ...cp, pctReporting: pct(cp.precinctsReporting, cp.precinctsTotal) });
      }
      const name = num ? `Question ${num}` : text.slice(0, 60);
      races.push({
        office: 'measure', district: null, name, key: `q:${name}:${text.slice(0, 40)}`, voteFor: 1, statewide: true, title: text,
        choices: [{ name: 'Yes', party: 'OTHER', partyRaw: '' }, { name: 'No', party: 'OTHER', partyRaw: '' }],
        units,
      });
    }
  }

  return { turnout, races, electionName: lookup.election?.NM ?? null, electionDate: lookup.election?.DT ?? null };
}

/** Party line → DEM/REP/OTHER: the code ("D"), then the name ("Green Party", then "Green"). */
function partyOf(p, context, unmatched) {
  for (const cand of [p.CD, p.NM, String(p.NM ?? '').replace(/\s+party$/i, '')]) {
    if (!cand) continue;
    const r = normalizeParty(cand);
    if (r.known) return r.party;
  }
  if (p.CD || p.NM) unmatched('party', p.CD || p.NM, `${context} (${p.NM ?? ''})`);
  return 'OTHER';
}

async function fetchTarget(t, { http, unmatched }) {
  const root = `${t.base}/election/${t.electionId}`;
  const ver = await http.getJson(`${root}/Version.json`, { conditional: true });
  const version = String(ver.json?.Version ?? '').trim();
  if (!/^\d+$/.test(version)) throw new Error(`Unexpected Version.json: ${ver.text.slice(0, 80)}`);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const [dataRes, lookupRes] = await Promise.all([
    http.getJson(`${root}/${version}/Electiondata.json`),
    http.getJson(`${root}/${version}/Lookupdata.json`),
  ]);
  const parsed = parsePcc(dataRes.json, lookupRes.json, t, { unmatched });
  const lm = dataRes.headers?.get?.('last-modified');
  const sourceUpdatedAt = lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : null;

  lastVersion.set(t.key, version);
  return {
    changed: true,
    version,
    result: {
      election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: t.date, url: t.url },
      version,
      sourceUpdatedAt,
      turnout: parsed.turnout,
      races: parsed.races,
    },
  };
}

export default {
  id: 'pccct',
  name: 'PCC Technology public reporting (Connecticut)',
  targets,
  fetch: fetchTarget,
};
