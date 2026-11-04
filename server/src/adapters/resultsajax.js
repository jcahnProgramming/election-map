// ASP.NET "ResultsAjax.svc" ENR family (one codebase, run by each state): OR, NM, NE, SD (ND runs a newer variant).
//
// Verified live on 2026-11-03 (results.oregonvotes.gov, electionresults.sos.nm.gov, electionresults.nebraska.gov,
// electionresults.sd.gov). Each site is plain server-rendered HTML plus a WCF JSON service at `serviceRoot`:
//   {site}/resultsSW.aspx?type={TYPE}&map=CTY        one page per contest category (OR: FED, SWPAR, HOUSE, ...; NM: FED, SW,
//                                                     LGX, ...). Every contest on it has a "County Results" button
//                                                     onclick="BuildCounty('{TYPE}', '{raceID}', '{osn}', '{party}')".
//                                                     Used only to list the contests (cached `discoverSeconds`).
//   {serviceRoot}{svc}/GetVoterTurnoutData            per county: Voters (registered), BallotsAccepted (OR only),
//                                                     PrecinctsReporting / TotalPrecincts, calcVoterTurnout. (CurrentDateTime
//                                                     is the server's clock, not a results stamp: not used.)
//                                                     Small; read every poll as the change check.
//   {serviceRoot}{svc}/GetMapData?type=&category=CTY&raceID=&osn=&county=0&party=0
//                                                     one contest by county: rows of { RaceName, VoteFor, CountyID,
//                                                     CountyName, BallotOrder, CandidateID, calcCandidate, PartyName,
//                                                     calcCandidateVotes, PrecinctsReporting, TotalPrecincts }. Exactly the
//                                                     request the site's own "County Results" button makes (plain GET; the
//                                                     JS proxy at {svc}/js marks it useGet). raceID=0 is a 500: per contest only.
// OR wraps responses as { d: [...] }; NM/NE/SD return the bare array. OR's own page zeroes the osn for general elections.
// The CSV/XML "ResultsExport.aspx" needs an ASP.NET postback per download and is deliberately NOT used.
// Winner flags are ignored (we never call races). No vote-method split is published.
//
// Requests (bounded, sequential, `requestGapMs` apart):
//   - every poll: GetVoterTurnoutData (the change check).
//   - when it moved: GetMapData for each contest of `detailTypes` (federal / statewide categories: a handful).
//   - the sweep: every other contest (OR ~190, NE ~450), at most `sweepBatch` per poll, restarted only when turnout moved
//     and at least `sweepSeconds` after the previous sweep started. Between sweeps those contests are re-emitted from cache.
//   - discovery: the category pages, once at start and then every `discoverSeconds`.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const state = new Map(); // target key → { races, discoveredAt, cache: Map(raceKey → rows), detailHash, detailAt, sweepHash, sweepStartedAt, queue, version }

function targets() {
  const c = readConfig('sources/resultsajax.json', { sites: [] });
  return c.sites
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `${e.state}/resultsajax`,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      electionDate: e.electionDate ?? null,
      url: e.site,
      site: e.site.replace(/\/$/, ''),
      service: `${e.serviceRoot.replace(/\/$/, '')}/${e.svc ?? 'ResultsAjax.svc'}`,
      categories: e.categories,
      detailTypes: e.detailTypes ?? [],
      zeroOsn: !!e.zeroOsn,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      allContests: e.allContests ?? true,
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 300,
      sweepBatch: e.sweepBatch ?? c.sweepBatch ?? 25,
      sweepSeconds: e.sweepSeconds ?? c.sweepSeconds ?? 300,
      discoverSeconds: e.discoverSeconds ?? c.discoverSeconds ?? 1800,
    }));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const raceKey = (r) => `${r.type}/${r.raceId}`;

/** Contests listed on one category page: [{ type, raceId, osn, party }], in page order, de-duplicated. */
export function parseCategoryPage(html) {
  const out = [];
  const seen = new Set();
  // "County Results" (BuildCounty) and "Map" (CreateMap) buttons carry the same four ids; ND's newer pages only have CreateMap.
  const re = /(?:BuildCounty|CreateMap)\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
  for (const m of String(html).matchAll(re)) {
    const r = { type: m[1].trim(), raceId: m[2].trim(), osn: m[3].trim(), party: m[4].trim() };
    if (!r.raceId || seen.has(raceKey(r))) continue;
    seen.add(raceKey(r));
    out.push(r);
  }
  return out;
}

/** The election the site is showing: its hidden hidElectionDate field ("11/3/2026"), or null. */
export function pageElectionDate(html) {
  const tag = String(html).match(/<input[^>]*id="hidElectionDate"[^>]*>/i)?.[0];
  return tag?.match(/value="([^"]*)"/i)?.[1] ?? null;
}

/** The change check: turnout without CurrentDateTime (the server's clock, different on every request). */
export function turnoutHash(rows) {
  return sha(JSON.stringify(rows.map(({ CurrentDateTime, ...r }) => r)));
}

/** WCF answers { d: [...] } on some sites and a bare array on others. */
export function rowsOf(j) {
  const d = Array.isArray(j) ? j : j?.d;
  if (!Array.isArray(d)) throw new Error('ResultsAjax: response is not a list');
  return d;
}

async function fetchTarget(t, { http, log, unmatched }) {
  const s = state.get(t.key) ?? { races: null, discoveredAt: 0, cache: new Map(), detailHash: null, detailAt: 0, sweepHash: null, sweepStartedAt: 0, queue: [], version: null };
  state.set(t.key, s);
  const now = Date.now();

  const tr = await http.get(`${t.service}/GetVoterTurnoutData`, { accept: 'application/json' });
  const turnoutRows = rowsOf(JSON.parse(tr.text));
  const tHash = turnoutHash(turnoutRows);

  if (!s.races || now - s.discoveredAt > t.discoverSeconds * 1000) {
    const races = [];
    const seen = new Set();
    for (const cat of t.categories) {
      await pause(t.requestGapMs);
      // A category is a type code ("FED") or, for ND's pages, the page's whole query string ("text=Race&type=SW&map=CTY").
      const q = cat.includes('=') ? cat : `type=${encodeURIComponent(cat)}&map=CTY`;
      const page = await http.get(`${t.site}/resultsSW.aspx?${q}`, { accept: 'text/html' });
      // Between elections a site keeps showing the last one (ND showed 11/5/2024 on the afternoon of 11/3/2026): store
      // nothing until it shows the configured election.
      const shown = pageElectionDate(page.text);
      if (t.electionDate && shown !== t.electionDate) {
        log?.warn?.(`${t.state}: the site shows the ${shown ?? 'unknown'} election, not ${t.electionDate}; nothing stored`);
        return { changed: false, version: s.version };
      }
      for (const r of parseCategoryPage(page.text)) {
        if (seen.has(raceKey(r))) continue;
        seen.add(raceKey(r));
        races.push(r);
      }
    }
    if (!races.length) throw new Error(`ResultsAjax ${t.state}: no contests found on the category pages`);
    const added = races.filter((r) => !s.cache.has(raceKey(r)));
    s.races = races;
    s.discoveredAt = now;
    for (const k of [...s.cache.keys()]) if (!races.some((r) => raceKey(r) === k)) s.cache.delete(k);
    // Contests we have never read go to the front of the sweep.
    s.queue = [...added.filter((r) => !t.detailTypes.includes(r.type)), ...s.queue.filter((r) => !added.includes(r))];
    if (!s.sweepStartedAt) { // the first discovery's queue IS the first sweep
      s.sweepHash = tHash;
      s.sweepStartedAt = now;
    }
  }

  const getRace = async (r) => {
    await pause(t.requestGapMs);
    const osn = t.zeroOsn ? '0' : r.osn || '0';
    const q = `type=${encodeURIComponent(r.type)}&category=CTY&raceID=${encodeURIComponent(r.raceId)}&osn=${encodeURIComponent(osn)}&county=0&party=0`;
    const res = await http.get(`${t.service}/GetMapData?${q}`, { accept: 'application/json' });
    s.cache.set(raceKey(r), rowsOf(JSON.parse(res.text)));
  };

  const detail = s.races.filter((r) => t.detailTypes.includes(r.type));
  // Turnout is the change signal; as a safety net the headline contests are re-read every sweepSeconds anyway.
  if (s.detailHash !== tHash || now - s.detailAt >= t.sweepSeconds * 1000 || detail.some((r) => !s.cache.has(raceKey(r)))) {
    for (const r of detail) await getRace(r);
    s.detailHash = tHash;
    s.detailAt = now;
  }

  const sweepDue = s.sweepHash !== tHash ? now - s.sweepStartedAt >= t.sweepSeconds * 1000 : now - s.sweepStartedAt >= t.discoverSeconds * 1000;
  if (!s.queue.length && sweepDue) {
    s.queue = s.races.filter((r) => !t.detailTypes.includes(r.type));
    s.sweepHash = tHash;
    s.sweepStartedAt = now;
  }
  const batch = s.queue.splice(0, t.sweepBatch);
  for (const r of batch) {
    try {
      await getRace(r);
    } catch (err) {
      s.queue.unshift(r); // retry this one next poll; never drop it
      throw err;
    }
  }

  const contests = s.races.filter((r) => s.cache.has(raceKey(r))).map((r) => ({ ...r, rows: s.cache.get(raceKey(r)) }));
  const result = parseResultsAjax({ contests, turnout: turnoutRows }, t, unmatched);
  const version = sha(JSON.stringify(result));
  if (s.version === version) return { changed: false, version };
  s.version = version;
  if (s.queue.length) log?.info?.(`${t.state}: ${s.queue.length} contests left in this sweep`);
  return { changed: true, version, result: { ...result, version } };
}

function num(v) {
  if (v == null || v === '' || v === '*') return null; // NM shows "*" before a county reports
  const n = Number(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * "Democrat, Working Families" / "Republican, Libertarian": a fusion line. DEM or REP when exactly one of the two majors
 * is listed, else OTHER. Unknown parts are logged.
 */
export function fusionParty(raw, unmatched, context) {
  const parts = String(raw ?? '').split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  let dem = false;
  let rep = false;
  for (const p of parts) {
    const { party, known } = normalizeParty(p);
    if (party === 'DEM') dem = true;
    else if (party === 'REP') rep = true;
    else if (!known) unmatched?.('party', p, context);
  }
  return dem && !rep ? 'DEM' : rep && !dem ? 'REP' : 'OTHER';
}

/**
 * The contest's name. NE's district contests share one RaceName ("For Representative in Congress - 2 Year Term") and
 * carry the district in AreaNum ("District 1"): appended when the name doesn't already hold that number.
 */
export function contestName(row) {
  const base = String(row?.RaceName ?? '').replace(/\s+/g, ' ').trim();
  const area = String(row?.AreaNum ?? '').replace(/\s+/g, ' ').trim();
  const n = area.match(/\d+/)?.[0];
  if (!base || !n) return base;
  const inName = (base.replace(/\b\d+\s*-?\s*years?\s+term\b/gi, '').match(/\d+/g) ?? []).map(Number);
  return inName.includes(Number(n)) ? base : `${base} - ${area}`;
}

/**
 * Pure parse into the adapter result (without `version`).
 * @param {{ contests: {type:string, raceId:string, rows:object[]}[], turnout: object[] }} data
 */
export function parseResultsAjax({ contests, turnout = [] }, t, unmatched = () => {}) {
  const st = t.state;
  const countyCache = new Map();
  const county = (name, context) => {
    const k = String(name ?? '').trim();
    if (!countyCache.has(k)) {
      const bare = k.replace(/\s*\([^)]*\)\s*$/, '').trim(); // SD: "Brookings (Vote Center)" rows beside "Brookings"
      const m = k ? matchCounty(st, k) ?? (bare !== k ? matchCounty(st, bare) : null) : null;
      if (!m && k) unmatched('county', k, `${st} ResultsAjax ${context}`);
      countyCache.set(k, m);
    }
    return countyCache.get(k);
  };

  const turnoutUnits = [];
  const allCounties = new Set();
  let reg = 0, cast = 0, castKnown = false, pr = 0, pt = 0;
  const tByFips = new Map();
  for (const r of turnout) {
    const m = county(r.CountyName, 'turnout');
    if (!m) continue;
    allCounties.add(m.fips);
    const ballots = 'BallotsAccepted' in r ? num(r.BallotsAccepted) : null;
    const registered = num(r.Voters) || null;
    reg += registered ?? 0;
    if (ballots != null) {
      cast += ballots;
      castKnown = true;
    }
    pr += num(r.PrecinctsReporting) ?? 0;
    pt += num(r.TotalPrecincts) ?? 0;
    const prev = tByFips.get(m.fips);
    if (prev) { // a second row for the same county (SD vote centers): add it in; the source's percentage no longer applies
      prev.registered = (prev.registered ?? 0) + (registered ?? 0) || null;
      prev.ballotsCast = ballots == null ? prev.ballotsCast : (prev.ballotsCast ?? 0) + ballots;
      prev.turnoutPct = null;
      prev.precinctsReporting = (prev.precinctsReporting ?? 0) + (num(r.PrecinctsReporting) ?? 0);
      prev.precinctsTotal = (prev.precinctsTotal ?? 0) + (num(r.TotalPrecincts) ?? 0);
      continue;
    }
    const u = {
      level: 'county', countyFips: m.fips, name: m.name, registered, ballotsCast: ballots,
      turnoutPct: num(r.calcVoterTurnout), precinctsReporting: num(r.PrecinctsReporting), precinctsTotal: num(r.TotalPrecincts),
    };
    tByFips.set(m.fips, u);
    turnoutUnits.push(u);
  }
  if (turnoutUnits.length) {
    turnoutUnits.unshift({
      level: 'state', name: st, registered: reg || null, ballotsCast: castKnown ? cast : null,
      turnoutPct: castKnown && reg ? round1((100 * cast) / reg) : null, precinctsReporting: pr, precinctsTotal: pt || null,
    });
  }

  const races = [];
  for (const c of contests) {
    const rows = c.rows ?? [];
    if (!rows.length) continue;
    const name = contestName(rows[0]);
    if (!name) continue;
    // Candidates in ballot order; county blocks keyed by the county name.
    const cands = new Map();
    for (const r of rows) {
      const id = String(r.CandidateID ?? r.calcCandidate);
      if (!cands.has(id)) cands.set(id, { id, name: String(r.calcCandidate ?? '').replace(/\s+/g, ' ').trim(), partyRaw: String(r.PartyName ?? '').trim(), order: num(r.BallotOrder) ?? 999 });
    }
    const list = [...cands.values()].sort((a, b) => a.order - b.order);
    const idx = new Map(list.map((x, i) => [x.id, i]));
    const labels = list.map((x) => x.name);
    const cls = classifyContest(name, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    const choices = list.map((x) => (isMeasure
      ? { name: x.name, party: 'OTHER', partyRaw: x.partyRaw }
      : { name: x.name, party: fusionParty(x.partyRaw, unmatched, `${st} ${name} / ${x.name}`), partyRaw: x.partyRaw }));

    // One block per county name, then merged per county FIPS: SD lists "X (Vote Center)" beside "X".
    const byName = new Map();
    for (const r of rows) {
      const k = String(r.CountyName ?? '').trim();
      if (!byName.has(k)) byName.set(k, { votes: list.map(() => 0), pr: num(r.PrecinctsReporting), pt: num(r.TotalPrecincts) });
      byName.get(k).votes[idx.get(String(r.CandidateID ?? r.calcCandidate))] += num(r.calcCandidateVotes) ?? 0;
    }
    const byCounty = new Map(); // fips (or "?name" when unmatched) → block
    for (const [cname, b] of byName) {
      const m = cname ? county(cname, name) : null;
      const k = m ? m.fips : `?${cname}`;
      const prev = byCounty.get(k);
      if (!prev) {
        byCounty.set(k, { ...b, m });
        continue;
      }
      b.votes.forEach((v, i) => { prev.votes[i] += v; });
      if (b.pt != null) {
        prev.pr = (prev.pr ?? 0) + (b.pr ?? 0);
        prev.pt = (prev.pt ?? 0) + b.pt;
      }
    }
    const withYesNo = (u) => {
      if (isMeasure) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      return u;
    };
    const units = [];
    const total = list.map(() => 0);
    let cpr = 0, cpt = 0, pKnown = false;
    const fipsSeen = new Set();
    for (const b of byCounty.values()) {
      b.votes.forEach((v, i) => { total[i] += v; });
      if (b.pt != null) {
        pKnown = true;
        cpr += b.pr ?? 0;
        cpt += b.pt;
      }
      const { m } = b;
      if (!m) continue;
      fipsSeen.add(m.fips);
      units.push(withYesNo({
        level: 'county', countyFips: m.fips, name: m.name, votes: b.votes,
        precinctsReporting: b.pr, precinctsTotal: b.pt, pctReporting: b.pt ? round1((100 * (b.pr ?? 0)) / b.pt) : null,
      }));
    }
    // Statewide = every county of the state votes on it (or a headline statewide office).
    const isStatewide = cls?.office === 'senate' || cls?.office === 'governor'
      || (allCounties.size > 0 && [...allCounties].every((f) => fipsSeen.has(f)));
    // The rows' precinct counts are the whole COUNTY's (NM: Bernalillo 698 in the Senate and in each House district), not
    // the contest's. They add up to the contest's only when it covers every county; otherwise they are left unknown.
    if (!isStatewide) {
      pKnown = false;
      for (const u of units) {
        u.precinctsReporting = null;
        u.precinctsTotal = null;
        u.pctReporting = null;
      }
    }
    units.unshift(withYesNo({
      level: 'state', name: isStatewide ? st : name, votes: total,
      precinctsReporting: pKnown ? cpr : null, precinctsTotal: pKnown ? cpt : null,
      pctReporting: pKnown && cpt ? round1((100 * cpr) / cpt) : null,
    }));
    const voteFor = num(rows[0].VoteFor);
    races.push({
      office: cls?.office ?? null,
      district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
      name,
      key: `${c.type}/${c.raceId}`,
      voteFor: voteFor || null,
      statewide: isStatewide,
      title: isMeasure ? name : null,
      choices,
      units,
    });
  }

  return {
    election: { sourceKey: t.key, state: st, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    // No results stamp in the JSON: CurrentDateTime is the server's own clock (NE answers in Eastern, SD in Mountain time),
    // and the "last updated" line is only in the HTML pages. Left unknown rather than guessed.
    sourceUpdatedAt: null,
    turnout: turnoutUnits,
    races,
  };
}

export default {
  id: 'resultsajax',
  name: 'State ENR (ResultsAjax.svc)',
  homepage: 'https://results.oregonvotes.gov/',
  targets,
  fetch: fetchTarget,
};
