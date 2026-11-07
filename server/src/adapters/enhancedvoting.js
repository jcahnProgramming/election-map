// Enhanced Voting public results (Angular SPA at https://{host}/results/public/{slug}). Used by GA, VA, UT, WA, RI, ID.
//
// API layout (verified live on 2026-11-03 against all six states; no keys, plain JSON, Cache-Control max-age=60):
//   /results/public/api/jurisdictions/{slug}                       election list (elections[].publicElectionId) + childLocalities
//   /results/public/api/elections/{slug}/{publicElectionId}         election metadata (3 KB): asOf, publishDate, publishVersionId,
//                                                                   countGroups (vote methods), parties, totalVoters, ballotsCast
//   /results/public/api/elections/{slug}/{publicElectionId}/data    everything statewide (0.3-1.5 MB):
//        election            the metadata above
//        jurisdiction        incl. childLocalities[] (counties / VA cities / RI towns) with turnoutPercent, precinctsReporting
//        ballotItems[]       every contest: name, contestType ('Candidate'|'BallotMeasure'), voteFor, referendum (measure text),
//                            reportingStatus {reportingUnits,totalUnits} (units = LOCALITIES, not precincts), voteTotal,
//                            summaryResults.ballotOptions[] { id, name, voteCount, party{abbreviation,name}, groupResults[] }
//                            groupResults = votes per count group (vote method), only where the state splits them (GA, VA, RI)
//        localityElections[] per-locality metadata (jurisdictionId = childLocalities id): ballotsCast, totalVoters
//        voterRegistration[] per locality { id, total }
//        statistics[]        free-form stats; WA publishes "Estimated Ballots Left to Count" by county here
//   /results/public/api/elections/{slug}/{publicElectionId}/data/ballot-item/{ballotItemId}
//        the same payload plus ballotItemWithBreakdown.breakdownResults[]: one row per locality with ballotOptions
//        (incl. groupResults) and precinctReportingStatus {reportingUnits,totalUnits} = PRECINCTS in that locality.
//        This is the only county source and it is big (0.3-2 MB each), so it is fetched only for headline contests,
//        only once votes are counted, only when that contest's statewide numbers changed, and at most every few minutes.
//   /turnout, /stats, /localities, /vr also exist; /turnout and /stats were empty tonight and /data already carries the rest.
// The source's own isWinner flags are deliberately ignored (we never call races).
//
// Which elections to poll is config, not code: config/sources/enhancedvoting.json.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty, normCounty, STATE_FIPS } from '../geo.js';

const FULL_REFRESH_MS = 5 * 60 * 1000; // re-read /data at least this often even when the metadata looks unchanged
const BREAKDOWN_MIN_MS = 3 * 60 * 1000; // re-read one contest's county breakdown at most this often
const JUDICIAL = /\b(retain|retained|retention|justice|judge|court)\b/i;

// ---------- small helpers ----------

/** Enhanced Voting text is [{ languageId, text }]; prefer English. */
export const txt = (arr) => {
  if (!Array.isArray(arr)) return arr == null ? '' : String(arr);
  return String((arr.find((l) => l.languageId === 'en') ?? arr[0])?.text ?? '');
};
const round1 = (x) => Math.round(x * 10) / 10;
const posNum = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);
const isoOrNull = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();

/** Precinct counts arrive as a number or as { reportingUnits, totalUnits }. */
function precincts(v) {
  if (v == null) return { rep: null, tot: null };
  if (typeof v === 'number') return { rep: v, tot: null };
  if (typeof v === 'object') {
    const rep = Number.isFinite(v.reportingUnits) ? v.reportingUnits : null;
    const tot = Number.isFinite(v.totalUnits) ? v.totalUnits : null;
    return { rep, tot };
  }
  return { rep: null, tot: null };
}

// Contest names the shared classifier doesn't know yet: VA "Member, United States Senate",
// "Member, House of Representatives (1st District)", RI "Senator in Congress".
function canonicalContestName(name) {
  let n = String(name).trim().replace(/^member,\s*/i, '');
  if (/^senator in congress\b/i.test(n)) n = 'US Senator';
  n = n.replace(/^house of representatives\b/i, 'US House');
  return n;
}

/** Measure choice → 'yes'|'no'|null. Covers Yes/No, For/Against, Approve(d)/Reject(ed), "Levy Yes", "IN FAVOR OF ...". */
export function measureSide(label) {
  const s = String(label ?? '').trim().replace(/\s+/g, ' ');
  const yn = yesNoSide(s);
  if (yn) return yn;
  if (/^(approve|approved|in favor|levy yes|bonds? yes)\b/i.test(s)) return 'yes';
  if (/^(reject|rejected|levy no|bonds? no)\b/i.test(s)) return 'no';
  return null;
}

// ---------- geography ----------

// us-atlas names Virginia's independent cities without "city", and four of them share a name with a county
// (Fairfax, Franklin, Richmond, Roanoke), so a plain name lookup can't tell "RICHMOND CITY" from "RICHMOND COUNTY".
// The FIPS code can: independent cities are 510-840. Same for Baltimore city (MD) and St. Louis city (MO).
const require = createRequire(import.meta.url);
let cityIndex = null;
function independentCities() {
  if (cityIndex) return cityIndex;
  cityIndex = new Map(); // state fips → { cities: Map(norm→{fips,name}), counties: Map(norm→{fips,name}) }
  const atlas = require('us-atlas/counties-albers-10m.json');
  for (const g of atlas.objects.counties.geometries) {
    const st = g.id.slice(0, 2);
    if (!cityIndex.has(st)) cityIndex.set(st, { cities: new Map(), counties: new Map() });
    const which = Number(g.id.slice(2)) >= 500 ? 'cities' : 'counties';
    cityIndex.get(st)[which].set(normCounty(g.properties.name), { fips: g.id, name: g.properties.name });
  }
  return cityIndex;
}

/** Locality name → { fips, name } or null. Handles "X CITY" / "X COUNTY" pairs; otherwise geo.matchCounty. */
export function resolveLocality(state, name) {
  const raw = String(name ?? '').trim();
  const idx = independentCities().get(STATE_FIPS[state]);
  if (idx && idx.cities.size) {
    const city = raw.match(/^(.+?)\s+city$/i);
    if (city && !/\bcounty$/i.test(raw)) {
      const hit = idx.cities.get(normCounty(city[1]));
      if (hit) return { fips: hit.fips, name: `${hit.name} city` };
    }
    const county = raw.match(/^(.+?)\s+county$/i);
    if (county) {
      const hit = idx.counties.get(normCounty(county[1]));
      if (hit) return hit;
    }
  }
  return matchCounty(state, raw);
}

// ---------- parsing (pure) ----------

/** Party for one ballot option: try abbreviation, party name, "(Prefers X Party)" → X, then a prefix in the name. */
function partyOf(opt, unmatched, context) {
  const abbr = String(opt.party?.abbreviation ?? '').trim();
  const pname = txt(opt.party?.name).trim();
  const cleaned = pname.replace(/^\(|\)$/g, '').replace(/^(prefers|states)\s+/i, '').replace(/\s+party(\s+preference)?$/i, '').trim();
  const split = splitPartyPrefix(txt(opt.name));
  const partyRaw = abbr || pname || split.partyRaw || '';
  const tries = [abbr, pname, cleaned, split.partyRaw].filter((x) => x);
  if (!tries.length) return { party: 'OTHER', partyRaw }; // write-in line, no party
  for (const t of tries) {
    const r = normalizeParty(t);
    if (r.known) return { party: r.party, partyRaw };
  }
  unmatched?.('party', partyRaw, context);
  return { party: 'OTHER', partyRaw };
}

/** Clean candidate name: drop a party prefix/suffix ("Mike Collins (Rep)") and GA's incumbent marker "(I)". */
function cleanName(raw) {
  const split = splitPartyPrefix(raw);
  let name = split.name;
  if (split.partyRaw) name = name.replace(/\s*\(I\)$/, '');
  return name.trim();
}

const HEADLINE = ['senate', 'governor', 'house'];
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * Seats a voter may fill, from the item's voteFor text: "Vote for 1", "Vote for only one", "Vote for up to 3".
 * Some states put other text in that field (WA: the contest group, "Congressional"; ID measures: "Requires 50% + 1
 * vote to pass"): that is not a vote-for count → null.
 */
export function parseVoteFor(raw) {
  const m = txt(raw).match(/\bvote for\s+(?:up to\s+|only\s+|no more than\s+|not more than\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
}

/** Two options, one yes-side and one no-side ("Yes"/"No", "For"/"Against", "Approve"/"Reject", "Levy Yes"/…). */
export function isYesNoItem(item) {
  const opts = item?.summaryResults?.ballotOptions ?? [];
  if (opts.length !== 2) return false;
  const sides = opts.map((o) => measureSide(txt(o.name)));
  return sides.includes('yes') && sides.includes('no');
}

/**
 * Every ballot item the feed publishes, with its classification. Nothing is dropped here (only an exact repeat of an
 * item id, which the feed sometimes lists twice):
 * - office 'senate' | 'governor' | 'house' when the built-in classifier knows the contest;
 * - office 'measure' for a real yes/no question; statewide:false when only part of the state votes on it;
 * - office null for everything else (state legislature, judges, judicial retention, county and local offices,
 *   multiple-choice advisory questions …): db.writeSnapshot → contests.enrichRaces classifies those from config rules.
 * `headline` marks the contests fetch() reads county breakdowns for: the target's `races` plus statewide measures.
 * @returns {Array<{ item, office, district, statewide, headline }>}
 */
export function selectItems(data, { races = HEADLINE, measures = true } = {}) {
  const items = data?.ballotItems ?? [];
  let maxUnits = 1;
  for (const b of items) maxUnits = Math.max(maxUnits, b?.reportingStatus?.totalUnits ?? 0);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || item.id == null || seen.has(item.id)) continue;
    seen.add(item.id);
    const name = txt(item.name);
    const yesNo = isYesNoItem(item);
    if (yesNo && !JUDICIAL.test(name)) {
      const units = item.reportingStatus?.totalUnits ?? 0;
      const statewide = maxUnits > 1 && units >= 0.9 * maxUnits;
      out.push({ item, office: 'measure', district: null, statewide, headline: measures && statewide });
      continue;
    }
    // Judicial retention ("Shall X be retained …") is a yes/no about a person, not a measure: it stays a
    // candidate-style contest with choices Yes / No (enrichRaces makes it judicial / retention).
    const cls = item.contestType === 'BallotMeasure' || yesNo
      ? null
      : classifyContest(canonicalContestName(name), (item.summaryResults?.ballotOptions ?? []).map((o) => txt(o.name)));
    const office = cls && cls.office !== 'measure' ? cls.office : null;
    out.push({ item, office, district: office ? cls.district : null, statewide: true, headline: !!office && races.includes(office) });
  }
  return out;
}

/** Methods (vote types) for one set of ballot options, ordered like the election's countGroups. */
function methodsFor(options, groupOrder, toVotes) {
  const byGroup = new Map();
  options.forEach((o, i) => {
    for (const g of o.groupResults ?? []) {
      if (!byGroup.has(g.groupId)) byGroup.set(g.groupId, { label: txt(g.groupName), votes: new Array(options.length).fill(0) });
      byGroup.get(g.groupId).votes[i] = Number(g.voteCount) || 0;
    }
  });
  if (!byGroup.size) return undefined;
  const ids = [...byGroup.keys()].sort((a, b) => (groupOrder.get(a) ?? 99) - (groupOrder.get(b) ?? 99));
  return ids.map((id) => {
    const m = byGroup.get(id);
    return { label: m.label, bucket: methodBucket(m.label), votes: toVotes(m.votes) };
  });
}

/**
 * Parse an Enhanced Voting /data payload (+ optional per-contest breakdowns) into the data-contract shape.
 * @param data        GET .../data JSON
 * @param breakdowns  Map(ballotItemId → ballotItemWithBreakdown) from GET .../data/ballot-item/{id}
 * @param opts        { state, counties:boolean, races, measures, unmatched(kind, value, context) }
 * @returns {{ races, turnout, sourceUpdatedAt }}
 */
export function parseElection(data, breakdowns = new Map(), opts = {}) {
  const { state, counties = true, unmatched = () => {} } = opts;
  const election = data.election ?? {};
  const groupOrder = new Map((election.countGroups ?? []).map((g, i) => [g.groupId, i]));
  const anyVotes = (data.ballotItems ?? []).some((b) => (b.voteTotal ?? 0) > 0);

  const locCache = new Map();
  const locate = (name, context) => {
    if (!counties) return null;
    if (locCache.has(name)) return locCache.get(name);
    const m = resolveLocality(state, name);
    if (!m) unmatched('county', name, context);
    locCache.set(name, m);
    return m;
  };

  const races = [];
  for (const { item, office, district, statewide } of selectItems(data, opts)) {
    const name = txt(item.name);
    const options = item.summaryResults?.ballotOptions ?? [];
    const optIndex = new Map(options.map((o, i) => [o.id, i]));
    const yesNoChoices = office === 'measure' || isYesNoItem(item); // measures and judicial retention: Yes / No
    const choices = options.map((o) => {
      const raw = txt(o.name).trim();
      if (yesNoChoices) return { name: raw, party: 'OTHER', partyRaw: '' };
      return { name: cleanName(raw), ...partyOf(o, unmatched, `${state} ${name} / ${raw}`) };
    });
    const sides = office === 'measure' ? options.map((o) => measureSide(txt(o.name))) : null;
    const yesIdx = sides?.indexOf('yes') ?? -1;
    const noIdx = sides?.indexOf('no') ?? -1;
    const toVotes = office === 'measure' ? (v) => [v[yesIdx] ?? 0, v[noIdx] ?? 0] : (v) => v;
    const finish = (u) => {
      if (office === 'measure') {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      if (!u.methods) delete u.methods;
      return u;
    };

    // County rows (and statewide precinct totals) come from the breakdown, when we have one.
    const bd = breakdowns.get(item.id);
    const rows = bd?.breakdownResults ?? [];
    let pRep = 0;
    let pTot = 0;
    let pKnown = rows.length > 0;
    const countyUnits = [];
    for (const row of rows) {
      const { rep, tot } = precincts(row.precinctReportingStatus);
      if (rep == null || tot == null) pKnown = false;
      else { pRep += rep; pTot += tot; }
      const locName = txt(row.locality?.name);
      const m = locate(locName, `${state} ${name}`);
      if (!m) continue;
      const votes = new Array(options.length).fill(0);
      const ordered = new Array(options.length);
      for (const o of row.ballotOptions ?? []) {
        const i = optIndex.get(o.id);
        if (i == null) continue;
        votes[i] = Number(o.voteCount) || 0;
        ordered[i] = o;
      }
      countyUnits.push(finish({
        level: 'county', countyFips: m.fips, name: m.name, votes,
        precinctsReporting: rep, precinctsTotal: tot,
        pctReporting: tot ? round1((100 * (rep ?? 0)) / tot) : null,
        methods: methodsFor(ordered.map((o) => o ?? { groupResults: [] }), groupOrder, toVotes),
      }));
    }

    const top = finish({
      level: 'state', name: state,
      votes: options.map((o) => Number(o.voteCount) || 0),
      precinctsReporting: pKnown ? pRep : null,
      precinctsTotal: pKnown ? pTot : null,
      pctReporting: pKnown && pTot ? round1((100 * pRep) / pTot) : null,
      methods: methodsFor(options, groupOrder, toVotes),
    });

    const race = {
      office, district, name, key: String(item.id), voteFor: parseVoteFor(item.voteFor), statewide,
      choices, units: [top, ...countyUnits],
    };
    if (office === 'measure') {
      const title = stripHtml(txt(item.referendum));
      race.title = title.length >= 15 ? title.slice(0, 1000) : null;
    }
    races.push(race);
  }

  return { races, turnout: parseTurnout(data, { state, counties, anyVotes, locate }), sourceUpdatedAt: isoOrNull(election.asOf ?? election.publishDate) };
}

/** Election-wide turnout per reporting unit. 0 before anything is counted is "not published yet" → null. */
function parseTurnout(data, { state, counties, anyVotes, locate }) {
  const election = data.election ?? {};
  const localities = data.jurisdiction?.childLocalities ?? [];
  const vr = new Map((data.voterRegistration ?? []).map((v) => [String(v.id).toLowerCase(), v]));
  const le = new Map((data.localityElections ?? []).map((e) => [String(e.jurisdictionId).toLowerCase(), e]));

  // WA: "Estimated Ballots Left to Count", a group with a statewide value and one child per county.
  let outstanding = null;
  for (const s of data.statistics ?? []) {
    for (const g of s.groups ?? []) {
      if (/ballots (left|remaining|outstanding)/i.test(txt(g.name))) outstanding = g;
    }
  }
  const outByName = new Map((outstanding?.children ?? []).map((c) => [normCounty(txt(c.name)), c.value]));
  const outVal = (v) => (anyVotes && typeof v === 'number' && Number.isFinite(v) ? v : null);

  const vrTotal = [...vr.values()].reduce((s, v) => s + (Number(v.total) || 0), 0);
  const sp = precincts(election.precinctsReporting);
  const out = [];
  const stateRow = {
    level: 'state', name: state,
    registered: posNum(election.totalVoters) ?? posNum(vrTotal),
    ballotsCast: posNum(election.ballotsCast),
    turnoutPct: null,
    ballotsOutstanding: outstanding ? outVal(outstanding.value) : null,
    precinctsReporting: sp.rep, precinctsTotal: sp.tot,
  };
  out.push(stateRow);

  if (counties) {
    for (const loc of localities) {
      const locName = txt(loc.name);
      const m = locate(locName, `${state} turnout`);
      if (!m) continue;
      const id = String(loc.id).toLowerCase();
      const e = le.get(id);
      const p = precincts(loc.precinctsReporting ?? e?.precinctsReporting);
      const row = {
        level: 'county', countyFips: m.fips, name: m.name,
        registered: posNum(e?.totalVoters) ?? posNum(Number(vr.get(id)?.total)),
        ballotsCast: posNum(e?.ballotsCast),
        // Enhanced Voting publishes turnoutPercent as a 0–1 share (Ada, ID: 0.7457529 = 232,003 / 311,099);
        // the data contract is 0–100 like every other source.
        turnoutPct: typeof loc.turnoutPercent === 'number' && Number.isFinite(loc.turnoutPercent) && anyVotes
          ? Math.round(loc.turnoutPercent * 10000) / 100 : null,
        ballotsOutstanding: outstanding ? outVal(outByName.get(normCounty(locName))) : null,
        precinctsReporting: p.rep, precinctsTotal: p.tot,
      };
      if (Object.entries(row).some(([k, v]) => !['level', 'countyFips', 'name'].includes(k) && v != null)) out.push(row);
    }
  }
  return out;
}

// ---------- registry plumbing ----------

function targets() {
  const cfg = readConfig('sources/enhancedvoting.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `${e.host}/${e.slug}/${e.publicElectionId}`,
      host: e.host,
      slug: e.slug,
      publicElectionId: e.publicElectionId,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      levels: e.counties === false ? ['state'] : ['state', 'county'],
      counties: e.counties !== false,
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      // /data lists every contest on the ballot and every one is stored (county breakdowns only for headline ones).
      allContests: e.allContests ?? true,
      url: e.url ?? `https://${e.host}/results/public/${e.slug}/elections/${e.publicElectionId}`,
    }));
}

const memo = new Map(); // target key → { metaKey, lastFull, version, stale, bd: Map(itemId → { fp, at, data }) }

const fingerprint = (item) => JSON.stringify([item.voteTotal, item.reportingStatus?.reportingUnits,
  (item.summaryResults?.ballotOptions ?? []).map((o) => o.voteCount)]);

async function fetchTarget(t, { http, log, unmatched }) {
  const m = memo.get(t.key) ?? { metaKey: null, lastFull: 0, version: null, stale: false, bd: new Map() };
  memo.set(t.key, m);
  const base = `https://${t.host}/results/public/api/elections/${encodeURIComponent(t.slug)}/${encodeURIComponent(t.publicElectionId)}`;

  // Cheap check first: the 3 KB election record changes whenever a new set of results is published.
  const meta = (await http.getJson(base)).json;
  const metaKey = [meta.publishVersionId, meta.publishDate, meta.asOf, meta.lastUpdated].join('|');
  if (metaKey === m.metaKey && m.version && !m.stale && Date.now() - m.lastFull < FULL_REFRESH_MS) {
    return { changed: false, version: m.version };
  }

  const data = (await http.getJson(`${base}/data`)).json;
  if (!Array.isArray(data?.ballotItems)) throw new Error(`Unexpected /data payload from ${t.host} (no ballotItems)`);

  // County breakdowns cost one 0.3-2 MB request per contest, so they are read only for the headline contests (the
  // target's races + statewide measures), only once votes are counted, only when that contest's statewide numbers
  // moved, and at most every few minutes. Every other contest is stored from /data alone, as a statewide unit.
  let stale = false;
  const tracked = selectItems(data, t);
  const keep = new Set();
  for (const { item, headline } of tracked) {
    if (!headline || item.hasBreakdownResults === false || !((item.voteTotal ?? 0) > 0)) continue;
    keep.add(item.id);
    const fp = fingerprint(item);
    const prev = m.bd.get(item.id);
    if (prev?.fp === fp) continue;
    if (prev && Date.now() - prev.at < BREAKDOWN_MIN_MS) { stale = true; continue; }
    try {
      const r = await http.getJson(`${base}/data/ballot-item/${encodeURIComponent(item.id)}`, { timeoutMs: 45000 });
      const b = r.json?.ballotItemWithBreakdown;
      if (b?.breakdownResults) m.bd.set(item.id, { fp, at: Date.now(), data: b });
    } catch (err) {
      stale = true;
      log?.warn?.(`breakdown for ${txt(item.name)} failed, keeping the previous one: ${err.message}`);
    }
  }
  for (const id of m.bd.keys()) if (!keep.has(id)) m.bd.delete(id);

  const parsed = parseElection(data, new Map([...m.bd].map(([id, v]) => [id, v.data])), { ...t, unmatched });
  const version = createHash('sha1').update(JSON.stringify([parsed.races, parsed.turnout])).digest('hex').slice(0, 16);
  m.metaKey = metaKey;
  m.lastFull = Date.now();
  m.stale = stale;
  if (version === m.version) return { changed: false, version };
  m.version = version;
  return {
    changed: true,
    version,
    result: {
      election: {
        sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label,
        date: data.election?.electionDate ?? null, url: t.url,
      },
      version,
      sourceUpdatedAt: parsed.sourceUpdatedAt,
      turnout: parsed.turnout,
      races: parsed.races,
    },
  };
}

export default {
  id: 'enhancedvoting',
  name: 'Enhanced Voting election results',
  homepage: 'https://www.enhancedvoting.com/',
  targets,
  fetch: fetchTarget,
};
