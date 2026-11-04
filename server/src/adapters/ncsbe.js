// North Carolina State Board of Elections ENR (er.ncsbe.gov). In-house, JSON served as text/plain.
//
// File layout (verified live on 2026-11-03, election folder 20261103):
//   /enr/elections.txt                       [{ edt:"11/03/2026", con, vtm, pct, arc }]  (vtm=1: vote-type splits)
//   /enr/{folder}/data/county.txt            one row per county plus cid 0 = STATE:
//                                            { cid, cnm, prt, ptl (precincts reported/total), bct (ballots cast),
//                                              rtl (registered), bpt ("12.34%" turnout), imp ("Last Updated"),
//                                              sub ("Last Submitted"), e.g. "November 3, 2026 3:31 pm" Eastern }
//   /enr/{folder}/data/results_0.txt         statewide: one row per candidate per contest:
//                                            { cid, cnm (contest, "... (VOTE FOR 1)"), vfr, gid (contest id), bnm (choice),
//                                              pty (party label), vct (total), evc/ovc/avc/pvc (Election Day / Early Voting
//                                              ("One Stop") / Absentee by Mail / Provisional), prt/ptl (precincts for this
//                                              contest), ogl (office group FED/JUD/NCS/NCH/CCL, "" for statewide referenda),
//                                              ref ("1" = referendum) }. Also carries some local referenda (ogl CCL).
//   /enr/{folder}/data/results_{cid}.txt     the same rows for one county (cid 1..100), every contest on its ballots,
//                                            including county-only contests that are NOT in results_0 (county bonds,
//                                            county commission, school board). Their gid is per county (Wake "20" is not
//                                            another county's "20"), except the cid*10000+n form, which can span counties.
//   /enr/{folder}/data/contest.txt           contest list (not needed).
// The vote-method labels are NCSBE's own column headings from its precinct export
// (results_pct_{folder}.zip): "Election Day", "Early Voting", "Absentee by Mail", "Provisional".
// No winner flags are published; nothing here calls a race.
//
// Every contest is emitted (v0.3). U.S. Senate / House / Governor and yes/no referenda keep their built-in office; any
// other contest goes out with office null (NC House / Senate get level + office from ogl NCH / NCS) and is classified
// by server/src/contests.js when the snapshot is written. A county-only contest's state unit is the sum of its
// counties and it is flagged statewide:false. No extra requests: the county files were already being fetched.
//
// Change detection: county.txt and results_0.txt are fetched with ETag/If-Modified-Since, and a county's file is
// only re-downloaded when its `imp` stamp in county.txt changes. The version is a hash of everything parsed.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const METHODS = [
  ['evc', 'Election Day'],
  ['ovc', 'Early Voting'],
  ['avc', 'Absentee by Mail'],
  ['pvc', 'Provisional'],
];

const cfg = () => readConfig('sources/ncsbe.json', { elections: [] });
const lastVersion = new Map(); // target key → version
const countyCache = new Map(); // `${target key}/${cid}` → { imp, rows }

function targets() {
  const c = cfg();
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `NC/${e.folder}`,
      state: e.state ?? 'NC',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      // results_0 + every county file = the whole ballot, down to county and municipal contests.
      allContests: e.allContests ?? true,
      url: e.url,
      dataUrl: `${e.base ?? c.base}/${e.folder}/data`,
      timeZone: e.timeZone ?? c.timeZone ?? 'America/New_York',
      concurrency: c.countyConcurrency ?? 4,
    }));
}

async function fetchTarget(t, { http, log, unmatched }) {
  const [countyRes, stateRes] = await Promise.all([
    http.get(`${t.dataUrl}/county.txt`, { conditional: true }),
    http.get(`${t.dataUrl}/results_0.txt`, { conditional: true }),
  ]);
  const counties = parseJsonText(countyRes.text, 'county.txt');
  const statewide = parseJsonText(stateRes.text, 'results_0.txt');

  // Per-county files, only for counties whose "last updated" stamp moved.
  const todo = counties.filter((c) => c.cid !== '0' && countyCache.get(`${t.key}/${c.cid}`)?.imp !== `${c.imp}|${c.sub}`);
  await pool(todo, t.concurrency, async (c) => {
    try {
      const r = await http.get(`${t.dataUrl}/results_${c.cid}.txt`, { conditional: true });
      countyCache.set(`${t.key}/${c.cid}`, { imp: `${c.imp}|${c.sub}`, rows: parseJsonText(r.text, `results_${c.cid}.txt`) });
    } catch (err) {
      // Keep the previous rows (if any) and retry next poll: the stamp isn't advanced.
      log.warn(`NC county ${c.cnm} (results_${c.cid}.txt) failed: ${err.message}`);
    }
  });
  const countyResults = new Map();
  for (const c of counties) {
    const hit = countyCache.get(`${t.key}/${c.cid}`);
    if (hit) countyResults.set(c.cid, hit.rows);
  }

  const hash = createHash('sha1').update(countyRes.text).update(stateRes.text);
  for (const [cid, rows] of countyResults) hash.update(cid).update(JSON.stringify(rows));
  const version = hash.digest('hex').slice(0, 16);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const result = parseNcsbe({ statewide, counties, countyResults }, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

function parseJsonText(text, what) {
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j)) throw new Error('not an array');
    return j;
  } catch (err) {
    throw new Error(`NCSBE ${what}: unexpected content (${err.message}): ${JSON.stringify(String(text).slice(0, 60))}`);
  }
}

/**
 * Pure parse of the NCSBE files into the adapter result (without `version`).
 * @param {{ statewide:object[], counties:object[], countyResults:Map<string,object[]> }} data
 * @param {{ key, state, label, date, url, races, timeZone }} t
 * @param {(kind:string, value:string, context:string)=>void} unmatched
 */
export function parseNcsbe({ statewide, counties, countyResults = new Map() }, t, unmatched = () => {}) {
  const state = t.state ?? 'NC';
  const tz = t.timeZone ?? 'America/New_York';
  const stateRow = counties.find((c) => String(c.cid) === '0') ?? null;
  const statePrecincts = num(stateRow?.ptl);

  // Counties: cid → { fips, name }. Logged once each when they don't match the atlas.
  const countyById = new Map();
  for (const c of counties) {
    if (String(c.cid) === '0') continue;
    const m = matchCounty(state, c.cnm);
    if (!m) unmatched('county', c.cnm, `${state} county.txt cid ${c.cid}`);
    countyById.set(String(c.cid), m ? { ...m, row: c } : null);
  }

  // Turnout, election-wide.
  const turnout = [];
  if (stateRow) turnout.push({ level: 'state', name: state, ...turnoutOf(stateRow) });
  for (const [, m] of countyById) if (m) turnout.push({ level: 'county', countyFips: m.fips, name: m.name, ...turnoutOf(m.row) });

  // sourceUpdatedAt: the latest "Last Updated" stamp across the state row and counties.
  let updated = null;
  for (const c of counties) {
    for (const s of [c.imp, c.sub]) {
      const iso = zonedToIso(s, tz);
      if (iso && (!updated || iso > updated)) updated = iso;
    }
  }

  // Group rows by contest id + name, keeping source order. County files reuse small per-county ids (Wake's "20" is a
  // Knightdale referendum, another county's "20" is something else), so the name is part of the key.
  const ckey = (r) => `${r.gid}|${cleanContestName(r.cnm).toUpperCase()}`;
  const contests = groupBy(statewide, ckey);
  const countyContests = new Map(); // cid → Map(gid|name → rows)
  for (const [cid, rows] of countyResults) countyContests.set(String(cid), groupBy(rows, ckey));

  // Contests only in county files (county commission, school board, county bond referenda, ...): one contest per
  // county, except NCSBE's county-namespaced ids (cid × 10000 + n, e.g. 800012), which may span counties.
  const localOnly = new Map(); // grouping key → { key, rowsByCid }
  for (const [cid, m] of countyById) {
    const groups = countyContests.get(cid);
    if (!groups || !m) continue; // no file yet, or a county logged as unmatched: its contests can't be placed
    for (const [k, rows] of groups) {
      if (contests.has(k)) continue;
      const gid = String(rows[0].gid);
      const shared = Number(gid) >= 10000;
      const g = shared ? k : `${cid}-${gid}`;
      if (!localOnly.has(g)) localOnly.set(g, { key: shared ? gid : `${cid}-${gid}`, rowsByCid: new Map() });
      localOnly.get(g).rowsByCid.set(cid, rows);
    }
  }

  const races = [];
  const pushRace = ({ key, first, stateRows, countyRows, local }) => {
    const name = cleanContestName(first.cnm);
    const all = stateRows.length ? stateRows : countyRows.flatMap(([, rows]) => rows);
    const labels = [];
    const firstRow = new Map();
    for (const r of [...all, ...(stateRows.length ? countyRows.flatMap(([, rows]) => rows) : [])]) {
      const l = String(r.bnm ?? '').trim();
      if (!firstRow.has(l)) { firstRow.set(l, r); labels.push(l); }
    }
    const cls = classifyContest(name, labels);
    const isMeasure = cls?.office === 'measure';

    const choices = labels.map((l) => {
      const split = splitPartyPrefix(l);
      const raw = String(firstRow.get(l).pty ?? '').trim() || split.partyRaw || '';
      if (isMeasure) return { name: split.name, party: 'OTHER', partyRaw: raw };
      const { party, known } = normalizeParty(raw);
      // An empty label is "no party" (nonpartisan contests, retention, write-ins), not an unknown party.
      if (!known && raw) unmatched('party', raw, `${state} ${name} / ${l}`);
      return { name: split.name, party, partyRaw: raw };
    });
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;

    // One unit from the rows of one file, or of several county files (a county-only contest's total is their sum).
    const makeUnit = (base, unitRows) => {
      const sums = new Map(); // label → { vct, m: { evc: n, ... } }
      const perFile = new Map(); // cid → first row: precinct counts are per contest per file
      for (const r of unitRows) {
        const l = String(r.bnm ?? '').trim();
        if (!sums.has(l)) sums.set(l, { vct: 0, m: {} });
        const s = sums.get(l);
        s.vct += num(r.vct) ?? 0;
        for (const [f] of METHODS) if (r[f] != null) s.m[f] = (s.m[f] ?? 0) + (num(r[f]) ?? 0);
        if (!perFile.has(String(r.cid))) perFile.set(String(r.cid), r);
      }
      const ordered = labels.map((l) => sums.get(l) ?? null);
      const files = [...perFile.values()];
      const sumField = (f) => (files.some((r) => num(r[f]) != null) ? files.reduce((a, r) => a + (num(r[f]) ?? 0), 0) : null);
      const pr = sumField('prt');
      const pt = sumField('ptl');
      const votes = ordered.map((x) => (x ? x.vct : 0));
      const methods = METHODS.filter(([f]) => ordered.some((x) => x && x.m[f] != null)).map(([f, label]) => {
        const v = ordered.map((x) => (x ? x.m[f] ?? 0 : 0));
        return { label, bucket: methodBucket(label), votes: isMeasure ? [v[yesIdx] ?? 0, v[noIdx] ?? 0] : v };
      });
      const u = {
        ...base,
        votes,
        precinctsReporting: pr,
        precinctsTotal: pt,
        pctReporting: pt ? round1((100 * (pr ?? 0)) / pt) : null,
      };
      if (methods.length) u.methods = methods;
      if (isMeasure) {
        u.yes = votes[yesIdx] ?? 0;
        u.no = votes[noIdx] ?? 0;
      }
      return u;
    };

    const units = [makeUnit({ level: 'state', name: state }, all)];
    for (const [cid, rows] of countyRows) {
      const m = countyById.get(cid);
      units.push(makeUnit({ level: 'county', countyFips: m.fips, name: m.name }, rows));
    }

    // Headline offices keep their meaning (part of the statewide picture). Anything else is statewide only when it is
    // on every precinct's ballot: the statewide file also carries city referenda, legislative and judicial districts.
    const headline = cls && !isMeasure;
    const statewideContest = !local && (headline || (statePrecincts != null && num(first.ptl) === statePrecincts));
    const race = {
      office: cls?.office ?? null,
      district: cls?.district ?? null,
      name,
      key,
      voteFor: num(first.vfr) ?? voteForFromName(first.cnm),
      statewide: statewideContest,
      title: isMeasure ? name : null,
      choices,
      units,
    };
    // NCSBE's office group pins the legislature down better than the contest name does.
    const hint = OGL_HINT[String(first.ogl ?? '').trim().toUpperCase()];
    if (!cls && hint) Object.assign(race, hint);
    races.push(race);
  };

  for (const [k, rows] of contests) {
    const countyRows = [];
    for (const [cid, m] of countyById) {
      const cr = m && countyContests.get(cid)?.get(k);
      if (cr) countyRows.push([cid, cr]); // counties that don't vote on it have no rows (or were logged as unmatched)
    }
    pushRace({ key: String(rows[0].gid), first: rows[0], stateRows: rows, countyRows, local: false });
  }
  for (const { key, rowsByCid } of localOnly.values()) {
    const countyRows = [...rowsByCid];
    pushRace({ key, first: countyRows[0][1][0], stateRows: [], countyRows, local: true });
  }

  return {
    election: { sourceKey: t.key, state, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: updated,
    turnout,
    races,
  };
}

function turnoutOf(r) {
  return {
    registered: num(r.rtl),
    ballotsCast: num(r.bct),
    turnoutPct: pctNum(r.bpt),
    precinctsReporting: num(r.prt),
    precinctsTotal: num(r.ptl),
  };
}

const cleanContestName = (s) => String(s ?? '').replace(/\s*\(VOTE FOR \d+\)\s*$/i, '').trim();
const voteForFromName = (s) => {
  const m = String(s ?? '').match(/\(VOTE FOR (\d+)\)\s*$/i);
  return m ? Number(m[1]) : null;
};
// NCSBE office groups (ogl) that pin the office down better than the contest name. The rest (FED, JUD, COS, CCL,
// LOC, ...) are left to the name rules: config/sources/ncsbe.json contestRules, then config/contest-rules.json.
const OGL_HINT = {
  NCS: { level: 'legislative', office: 'state_senate' },
  NCH: { level: 'legislative', office: 'state_house' },
};

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
function pctNum(v) {
  if (v == null || String(v).trim() === '') return null;
  return num(String(v).replace('%', '').trim());
}
const round1 = (x) => Math.round(x * 10) / 10;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "November 3, 2026 3:31 pm" in an IANA zone → ISO 8601 UTC, or null. */
export function zonedToIso(s, timeZone = 'America/New_York') {
  const m = String(s ?? '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let h = Number(m[4]);
  if (m[7]) h = (h % 12) + (/^p/i.test(m[7]) ? 12 : 0);
  const wall = Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5]), Number(m[6] ?? 0));
  // Find the zone's offset at that instant (two passes handle DST edges).
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess).toISOString();
}
function zoneOffsetMs(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export default {
  id: 'ncsbe',
  name: 'North Carolina State Board of Elections ENR',
  homepage: 'https://er.ncsbe.gov/',
  targets,
  fetch: fetchTarget,
};
