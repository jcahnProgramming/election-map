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
//   /enr/{folder}/data/results_{cid}.txt     the same rows for one county (cid 1..100), every contest on its ballots.
//   /enr/{folder}/data/contest.txt           contest list (not needed).
// The vote-method labels are NCSBE's own column headings from its precinct export
// (results_pct_{folder}.zip): "Election Day", "Early Voting", "Absentee by Mail", "Provisional".
// No winner flags are published; nothing here calls a race.
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

  // Group rows by contest id, keeping source order.
  const contests = groupBy(statewide, (r) => String(r.gid));
  const countyContests = new Map(); // cid → Map(gid → rows)
  for (const [cid, rows] of countyResults) countyContests.set(String(cid), groupBy(rows, (r) => String(r.gid)));

  const races = [];
  for (const [gid, rows] of contests) {
    const first = rows[0];
    const name = cleanContestName(first.cnm);
    const labels = rows.map((r) => String(r.bnm ?? '').trim());
    const cls = classifyContest(name, labels);
    if (!cls) continue;
    if (cls.office !== 'measure' && !(t.races ?? ['senate', 'governor', 'house']).includes(cls.office)) continue;
    const isMeasure = cls.office === 'measure';

    const choices = rows.map((r, i) => {
      const split = splitPartyPrefix(labels[i]);
      const raw = String(r.pty ?? '').trim() || split.partyRaw || '';
      if (isMeasure) return { name: split.name, party: 'OTHER', partyRaw: raw };
      const { party, known } = normalizeParty(raw);
      if (!known) unmatched('party', raw, `${state} ${name} / ${labels[i]}`);
      return { name: split.name, party, partyRaw: raw };
    });
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;

    const makeUnit = (base, unitRows) => {
      const byName = new Map(unitRows.map((r) => [String(r.bnm ?? '').trim(), r]));
      const ordered = labels.map((l) => byName.get(l) ?? null);
      const any = unitRows[0];
      const pr = num(any?.prt);
      const pt = num(any?.ptl);
      const votes = ordered.map((r) => (r ? num(r.vct) ?? 0 : 0));
      const methods = METHODS.filter(([f]) => ordered.some((r) => r && r[f] != null)).map(([f, label]) => {
        const v = ordered.map((r) => (r ? num(r[f]) ?? 0 : 0));
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

    const units = [makeUnit({ level: 'state', name: state }, rows)];
    for (const [cid, m] of countyById) {
      const cr = countyContests.get(cid)?.get(gid);
      if (!cr || !m) continue; // county doesn't vote on this contest (or was logged as unmatched)
      units.push(makeUnit({ level: 'county', countyFips: m.fips, name: m.name }, cr));
    }

    // A referendum in the statewide file that isn't on every precinct's ballot is local (city bonds, etc.).
    const statewideContest = !isMeasure || (statePrecincts != null && num(first.ptl) === statePrecincts);
    races.push({
      office: cls.office,
      district: cls.district,
      name,
      key: gid,
      voteFor: num(first.vfr),
      statewide: statewideContest,
      title: isMeasure ? name : null,
      choices,
      units,
    });
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
