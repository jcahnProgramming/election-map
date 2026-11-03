// Vermont Secretary of State election results (electionresults.vermont.gov): an Angular app over static Azure JSON.
//
// File layout (verified live on 2026-11-03 against the 2026 general, and the finished 2024 general):
//   {base}/elections/elections.json          [{ electionGuid, electionName, electionDate, isStateWideElection, ... }]
//   {base}/elections/{guid}.json             index (~7 KB, ETag'd, max-age 60): { lastUpdatedDate:"11/03/2026 06:51 PM" (Eastern),
//                                              townsReporting:"0/247", federal:{ path }, stateWide:{ path }, turnOut:{ path },
//                                              townDistricts:[{ townId, townName, countyName, ... }], ... }
//       Each path is "elections\\{guid}-{section}-{yyyymmddhhmmss}.json": the stamp changes with every publish, so it is our version.
//   section file   { d:[{ o:[{ oid, on:"GOVERNOR", vf, cs:[ row ] }] }] }
//       row = one town × state-house district: { tid, tn, distReported:"6/6" (districts reported in the TOWN, repeated on
//             each of its rows), sc ballots cast, sv spoiled, bv blank, rc:[{ cid, cn, vc, pn (party, e.g. "DEM/PROG") }],
//             wc:[ individual write-in names ] };  tid 0 / tn "STATE WIDE" is the source's statewide total.
//       Rows are slices: the town rows sum exactly to the STATE WIDE row (checked on the 2024 general).
//   turnout file   { d:[{ tid, tn, tvr registered, tvc ballots cast, tabs absentee ballots, tdis districts, tdisr reported }] }
// The source reports by town and says which county each town is in, so county units are sums of towns.
// isWinner flags are ignored (we never call races).
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → version

function targets() {
  const cfg = readConfig('sources/vtsos.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `vtsos/${e.guid}`,
      base: cfg.base,
      guid: e.guid,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      sections: e.sections ?? ['federal', 'stateWide'],
      url: e.url,
      timeZone: e.timeZone ?? 'America/New_York',
    }));
}

const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const round1 = (x) => Math.round(x * 10) / 10;
const fraction = (s) => {
  const m = String(s ?? '').match(/^(\d+)\s*\/\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** "11/03/2026 06:51 PM" in a named zone → ISO UTC, or null. */
export function parseUpdated(s, timeZone = 'America/New_York') {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP])M$/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'P') h += 12;
  const wall = Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +(m[6] ?? 0));
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - off(wall);
  t = wall - off(t);
  return new Date(t).toISOString();
}

/** The version stamp in a section path: "elections\\{guid}-f-20261103185112.json" → "20261103185112". */
export const pathStamp = (p) => String(p ?? '').match(/-(\d{14})\.json$/)?.[1] ?? null;
/** Version = the publish stamps of every file we read, so any re-publish is seen. */
export const versionOf = (index, sections) => [...sections.map((s) => pathStamp(index[s]?.path)), pathStamp(index.turnOut?.path)]
  .map((x) => x ?? '-').join('/');
const sectionUrl = (base, p) => `${base}/${String(p).replace(/\\/g, '/')}`;

/**
 * A party label → normalized party. Fusion labels ("DEM/PROG") resolve to the first part we recognise;
 * the raw label is always kept by the caller.
 */
function partyOf(raw) {
  const r = normalizeParty(raw);
  if (r.known || !/\//.test(String(raw ?? ''))) return r;
  for (const part of String(raw).split('/')) {
    const p = normalizeParty(part);
    if (p.known && p.party !== 'OTHER') return { party: p.party, known: true };
  }
  return r;
}

/**
 * Pure parse of the VT index + section files + turnout file into the adapter result (docs/data-contract.md).
 * @param {object} index      the {guid}.json index
 * @param {object[]} sections the section files named in t.sections (already fetched)
 * @param {object|null} turnoutFile
 */
export function parseVt(index, sections, turnoutFile, t, unmatched = () => {}) {
  // town id → { fips, name } of its county, from the source's own town → county list.
  const countyCache = new Map();
  const townCounty = new Map();
  for (const td of index.townDistricts ?? []) {
    if (townCounty.has(td.townId)) continue;
    if (!countyCache.has(td.countyName)) {
      const m = matchCounty(t.state, td.countyName);
      if (!m) unmatched('county', td.countyName ?? '', `${t.state} town ${td.townName}`);
      countyCache.set(td.countyName, m);
    }
    townCounty.set(td.townId, countyCache.get(td.countyName));
  }
  const unknownTowns = new Set();
  const countyOfTown = (tid, tn) => {
    if (!townCounty.has(tid) && !unknownTowns.has(tid)) {
      unknownTowns.add(tid);
      unmatched('town', tn ?? String(tid), `${t.state}: no county for this town in townDistricts`);
    }
    return townCounty.get(tid) ?? null; // null also when the county name itself didn't match (already logged)
  };

  const races = [];
  for (const file of sections) {
    for (const block of file?.d ?? []) {
      for (const o of block.o ?? []) {
        const rows = o.cs ?? [];
        const swRow = rows.find((r) => Number(r.tid) === 0);
        const townRows = rows.filter((r) => Number(r.tid) !== 0);
        const sample = swRow ?? townRows[0];
        if (!sample) continue;
        const cands = (sample.rc ?? []).map((c) => ({ cid: c.cid, name: String(c.cn ?? '').replace(/\s+/g, ' ').trim(), raw: c.pn ?? '' }));
        const cls = classifyContest(o.on, cands.map((c) => c.name));
        if (!cls) continue;
        if (cls.office === 'measure' ? !t.measures : !t.races.includes(cls.office)) continue;
        const isMeasure = cls.office === 'measure';
        const name = String(o.on).replace(/\s+/g, ' ').trim();

        const choices = cands.map((c) => {
          if (isMeasure) return { name: c.name, party: 'OTHER', partyRaw: c.raw };
          const { party, known } = partyOf(c.raw);
          if (!known) unmatched('party', c.raw, `${t.state} ${name} / ${c.name}`);
          return { name: c.name, party, partyRaw: c.raw };
        });
        const hasWriteIns = !isMeasure && rows.some((r) => (r.wc ?? []).length);
        if (hasWriteIns) choices.push({ name: 'Write-ins', party: 'OTHER', partyRaw: '' });

        const rowVotes = (r) => {
          const byCid = new Map((r.rc ?? []).map((c) => [String(c.cid), num(c.vc) ?? 0]));
          const v = cands.map((c) => byCid.get(String(c.cid)) ?? 0);
          if (hasWriteIns) v.push((r.wc ?? []).reduce((s, c) => s + (num(c.vc) ?? 0), 0));
          return v;
        };
        const add = (a, b) => a.map((x, i) => x + b[i]);

        // Precincts = the town's voting districts; distReported is repeated on each of a town's rows, so count each town once.
        const precinctsByTown = new Map();
        for (const r of townRows) { const f = fraction(r.distReported); if (f && !precinctsByTown.has(r.tid)) precinctsByTown.set(r.tid, f); }

        const byCounty = new Map(); // fips → { m, votes, pr, pt, towns:Set }
        let stateSum = new Array(choices.length).fill(0);
        for (const r of townRows) {
          const v = rowVotes(r);
          stateSum = add(stateSum, v);
          const m = countyOfTown(r.tid, r.tn);
          if (!m) continue;
          const c = byCounty.get(m.fips) ?? { m, votes: new Array(choices.length).fill(0), towns: new Set() };
          c.votes = add(c.votes, v);
          c.towns.add(r.tid);
          byCounty.set(m.fips, c);
        }
        const precincts = (tids) => {
          let pr = 0; let pt = 0; let any = false;
          for (const tid of tids) { const f = precinctsByTown.get(tid); if (f) { any = true; pr += f[0]; pt += f[1]; } }
          return any ? { precinctsReporting: pr, precinctsTotal: pt, pctReporting: pt ? round1((100 * pr) / pt) : null }
            : { precinctsReporting: null, precinctsTotal: null, pctReporting: null };
        };

        const units = [{
          level: 'state', name: t.state, votes: swRow ? rowVotes(swRow) : stateSum,
          ...precincts(new Set(townRows.map((r) => r.tid))),
        }];
        for (const c of [...byCounty.values()].sort((a, b) => a.m.fips.localeCompare(b.m.fips))) {
          units.push({ level: 'county', countyFips: c.m.fips, name: c.m.name, votes: c.votes, ...precincts(c.towns) });
        }
        if (isMeasure) {
          const yi = choices.findIndex((ch) => yesNoSide(ch.name) === 'yes');
          const ni = choices.findIndex((ch) => yesNoSide(ch.name) === 'no');
          for (const u of units) { u.yes = u.votes[yi] ?? 0; u.no = u.votes[ni] ?? 0; }
        }
        races.push({
          office: cls.office, district: cls.district, name, key: String(o.oid), voteFor: num(o.vf) ?? 1, statewide: true,
          title: isMeasure ? name : null, choices, units,
        });
      }
    }
  }

  // Turnout, per town → county and state. A town that hasn't reported shows 0 registered, which is "not reported",
  // so registered is only given for a unit once every town in it has reported.
  const turnout = [];
  const towns = turnoutFile?.d ?? [];
  if (towns.length) {
    const agg = (list) => {
      const all = list.every((x) => (num(x.tdisr) ?? 0) > 0);
      const sum = (k) => list.reduce((s, x) => s + (num(x[k]) ?? 0), 0);
      return {
        registered: all ? sum('tvr') : null, ballotsCast: sum('tvc'), turnoutPct: null, ballotsOutstanding: null,
        precinctsReporting: sum('tdisr'), precinctsTotal: sum('tdis'),
      };
    };
    turnout.push({ level: 'state', name: t.state, ...agg(towns) });
    const groups = new Map();
    for (const x of towns) {
      const m = countyOfTown(x.tid, x.tn);
      if (!m) continue;
      if (!groups.has(m.fips)) groups.set(m.fips, { m, list: [] });
      groups.get(m.fips).list.push(x);
    }
    for (const g of [...groups.values()].sort((a, b) => a.m.fips.localeCompare(b.m.fips))) {
      turnout.push({ level: 'county', countyFips: g.m.fips, name: g.m.name, ...agg(g.list) });
    }
  }

  return {
    election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: t.date, url: t.url },
    version: versionOf(index, t.sections),
    sourceUpdatedAt: parseUpdated(index.lastUpdatedDate, t.timeZone),
    turnout,
    races,
  };
}

async function fetchTarget(t, { http, unmatched }) {
  const idxRes = await http.getJson(`${t.base}/elections/${t.guid}.json`, { conditional: true });
  const index = idxRes.json;
  const version = versionOf(index, t.sections);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const sections = [];
  for (const s of t.sections) {
    if (!index[s]?.isEnable || !index[s]?.path) continue;
    sections.push((await http.getJson(sectionUrl(t.base, index[s].path))).json);
  }
  const turnoutFile = index.turnOut?.isEnable && index.turnOut?.path
    ? (await http.getJson(sectionUrl(t.base, index.turnOut.path))).json
    : null;
  const result = parseVt(index, sections, turnoutFile, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result };
}

export default {
  id: 'vtsos',
  name: 'Vermont Secretary of State election results',
  homepage: 'https://electionresults.vermont.gov/',
  targets,
  fetch: fetchTarget,
};
