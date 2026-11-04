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
// Every results section the index names (verified live 2026-11-03): federal (U.S. House / Senate), stateWide (Governor ...
// Attorney General), senate / house (State Senate / State House districts), county (Probate Judge, Assistant Judge,
// State's Attorney, Sheriff, High Bailiff), town (Justice of the Peace; local questions).
const SECTIONS = ['federal', 'stateWide', 'senate', 'house', 'county', 'town'];

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
      // Headline races expected (coverage). Every contest in the sections read is stored whatever this says.
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      sections: e.sections ?? SECTIONS,
      // federal + stateWide + senate + house + county + town is the whole general-election ballot.
      allContests: e.allContests ?? SECTIONS.every((x) => (e.sections ?? SECTIONS).includes(x)),
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

/** Every contest object in a section file: {d:[{o:[...]}]} for most sections, {d:[{co:[...]}]} for the county one. */
function* contestsOf(file) {
  for (const block of file?.d ?? []) {
    for (const o of block?.o ?? []) if (o) yield o;
    for (const o of block?.co ?? []) if (o) yield o;
  }
}

const cleanDist = (s) => String(s ?? '').replace(/_+$/, '').replace(/\s+/g, ' ').trim();
const titleWord = (s) => String(s ?? '').trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Where a contest belongs, from the fields the source puts on it (seen live 2026-11-03):
 *   dn/dc + isrep   a State Senate (isrep false) or State House (isrep true) district: rows are towns + a "District Wide" row
 *   ctyid/ctyn      a county contest (Probate Judge, Assistant Judge, State's Attorney, Sheriff, High Bailiff): "County Wide" row
 *   tid/tn (+ld)    a town contest (Justice of the Peace; local questions)
 *   none of these   a statewide contest (federal / stateWide sections): "STATE WIDE" row
 * The oid is shared by every district / county / town instance of an office, so it is only a key for statewide contests.
 */
function scopeOf(o) {
  if (o.dn != null || o.dc != null) {
    const dist = cleanDist(o.dn ?? o.dc);
    const house = o.isrep === true;
    return {
      kind: 'district', suffix: dist, unitName: dist, district: dist,
      level: 'legislative', office: house ? 'state_house' : 'state_senate',
      key: (x) => `${house ? 'h' : 'sn'}:${x.oid}:${x.dc ?? dist}`,
    };
  }
  if (o.ctyid != null || o.ctyn != null) {
    const county = titleWord(o.ctyn);
    return {
      kind: 'county', suffix: `${String(o.ctyn ?? '').trim()} COUNTY`, unitName: `${county} County`, jurisdiction: county || null,
      key: (x) => `cty:${x.oid}:${x.ctyid ?? x.ctyn}`,
    };
  }
  if (o.tid != null || o.tn != null) {
    const town = titleWord(o.tn);
    const local = o.ld ? ` ${String(o.ld).trim()}` : '';
    return {
      kind: 'town', suffix: `${String(o.tn ?? '').trim()}${local}`, unitName: town, jurisdiction: town || null,
      key: (x) => `t:${x.oid}:${x.tid ?? x.tn}:${x.ldid ?? 0}`,
    };
  }
  return { kind: 'statewide', key: (x) => String(x.oid) };
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

  // Every town and its voting-district count, from the turnout file (it lists all towns, reported or not), and every
  // town per county (turnout file + the index's own town → county list).
  const districtsByTown = new Map(); // tid → [reported, total]
  const allTowns = new Set();
  const townsByCounty = new Map(); // fips → Set(tid)
  const addTown = (tid) => {
    if (tid == null || Number(tid) === 0) return;
    allTowns.add(tid);
    const m = townCounty.get(tid);
    if (m) { if (!townsByCounty.has(m.fips)) townsByCounty.set(m.fips, new Set()); townsByCounty.get(m.fips).add(tid); }
  };
  for (const x of turnoutFile?.d ?? []) {
    if (x.tid == null || Number(x.tid) === 0) continue;
    const tot = num(x.tdis);
    if (tot != null && tot > 0) districtsByTown.set(x.tid, [num(x.tdisr) ?? 0, tot]);
    addTown(x.tid);
  }
  if (!districtsByTown.size) for (const td of index.townDistricts ?? []) addTown(td.townId);

  const races = [];
  for (const file of sections) {
    for (const o of contestsOf(file)) {
      const scope = scopeOf(o);
      const rows = o.cs ?? [];
      const swRow = rows.find((r) => Number(r.tid) === 0);
      const townRows = rows.filter((r) => Number(r.tid) !== 0);
      const sample = swRow ?? townRows[0];
      if (!sample) continue; // no result rows published for this contest yet (town contests before their town reports)
      const cands = (sample.rc ?? []).map((c) => ({ cid: c.cid, name: String(c.cn ?? '').replace(/\s+/g, ' ').trim(), raw: c.pn ?? '' }));
      const baseName = String(o.on ?? '').replace(/\s+/g, ' ').trim();
      // The built-in classifier names the headline offices and yes/no questions; it only sees the bare office name for
      // statewide contests (a district / county / town contest is never U.S. Senate, Governor or a statewide measure).
      const raw = classifyContest(baseName, cands.map((c) => c.name));
      const cls = raw && (scope.kind === 'statewide' || raw.office === 'measure') ? raw : null;
      const isMeasure = cls?.office === 'measure';
      // Contest names repeat across districts / counties / towns ("STATE SENATOR", "SHERIFF"): add the source's own
      // district / county / town name so each contest is told apart.
      const name = scope.suffix ? `${baseName} - ${scope.suffix}` : baseName;

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
      // Once results start, the section file only has rows for towns that have reported, so the denominator must come
      // from every town (the turnout file's tdis), not from the rows present (2 of 247 towns would read "2/2 = 100%").
      const precinctsByTown = new Map(districtsByTown);
      for (const r of townRows) { const f = fraction(r.distReported); if (f && f[1] > 0) precinctsByTown.set(r.tid, f); }

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

      // Every town in a unit counts, reported or not. Without the turnout file we only know the towns with rows:
      // then a unit is only given precincts when rows cover all of its towns (never a "2 of 2" from a partial file).
      const NONE = { precinctsReporting: null, precinctsTotal: null, pctReporting: null };
      const rowTowns = new Set(townRows.map((r) => r.tid));
      const unitPrecincts = (allTids, rowTids) => {
        if (districtsByTown.size) return allTids ? precincts(allTids) : NONE;
        return allTids && allTids.size && [...allTids].every((tid) => rowTids.has(tid)) ? precincts(rowTids) : NONE;
      };
      const countyTowns = (fips, fallback) => townsByCounty.get(fips) ?? fallback;
      // The towns a contest covers: statewide = every town; county = the county's towns; town = that town; a legislative
      // district = unknown (the turnout file doesn't list district towns), so no precincts unless the feed is complete.
      let contestTowns = null;
      if (scope.kind === 'statewide') contestTowns = allTowns.size ? allTowns : rowTowns;
      else if (scope.kind === 'town') contestTowns = rowTowns;
      else if (scope.kind === 'county') {
        const fips = byCounty.size === 1 ? [...byCounty.keys()][0] : null;
        contestTowns = fips ? countyTowns(fips, rowTowns) : null;
      } else if (!districtsByTown.size) contestTowns = rowTowns;
      const units = [{
        level: 'state', name: scope.unitName ?? t.state, votes: swRow ? rowVotes(swRow) : stateSum,
        ...unitPrecincts(contestTowns, rowTowns),
      }];
      for (const c of [...byCounty.values()].sort((a, b) => a.m.fips.localeCompare(b.m.fips))) {
        // A statewide or county contest covers every town in the county; a district / town contest only its own towns.
        const inCounty = scope.kind === 'statewide' || scope.kind === 'county' ? countyTowns(c.m.fips, c.towns)
          : scope.kind === 'town' ? c.towns : (districtsByTown.size ? null : c.towns);
        units.push({ level: 'county', countyFips: c.m.fips, name: c.m.name, votes: c.votes, ...unitPrecincts(inCounty, c.towns) });
      }
      if (isMeasure) {
        const yi = choices.findIndex((ch) => yesNoSide(ch.name) === 'yes');
        const ni = choices.findIndex((ch) => yesNoSide(ch.name) === 'no');
        for (const u of units) { u.yes = u.votes[yi] ?? 0; u.no = u.votes[ni] ?? 0; }
      }
      // vote-for: the office's own vf, or the contest-wide row's when larger (county ASSISTANT JUDGE says 1 on the office,
      // 2 on its rows: two are elected).
      const vf = Math.max(num(o.vf) ?? 0, num(swRow?.vf) ?? 0) || null;
      races.push({
        office: cls?.office ?? scope.office ?? null, ...(!cls && scope.level ? { level: scope.level } : {}),
        district: cls ? cls.district : scope.district ?? null, name, key: scope.key(o),
        voteFor: vf ?? (cls && !isMeasure ? 1 : null),
        statewide: scope.kind === 'statewide' || !isMeasure,
        ...(scope.jurisdiction ? { jurisdiction: scope.jurisdiction } : {}),
        title: isMeasure ? (typeof o.bq === 'string' && o.bq.trim() ? o.bq.trim() : name) : null, choices, units,
      });
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
