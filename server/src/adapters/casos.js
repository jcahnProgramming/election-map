// California Secretary of State results API (api.sos.ca.gov/returns), the JSON behind electionresults.sos.ca.gov.
// (The human site's front page sits behind Imperva; the API answers plain requests, so we only use the API.)
//
// File layout (verified live on 2026-11-03):
//   {base}/governor                 { raceTitle, Reporting:"0% (0 of 23,860) precincts reporting",
//                                     ReportingTime:"November 2, 2026, 6:28 p.m." (Pacific), candidates:[{ Name, Party, Votes, Percent, incumbent }] }
//   {base}/maps/governor            { statewide:{ same }, alameda:{ same }, "contra-costa":{ same }, ... }  one call, every county
//   {base}/us-rep/district/all      [ { raceTitle:"U.S. House of Representatives District 1 - Districtwide Results", ... } ] all 52
//   {base}/ballot-measures          { raceTitle, Reporting, ReportingTime, "ballot-measures":[{ Name (the title), Number:"01",
//                                     yesVotes, yesPercent, noVotes, noPercent }] }
//   {base}/ballot-measures/county/{slug}   the same, for one county
//   {base}/status                   { statewide:{...}, alameda:{ precinctsReporting, precinctsTotal, voterTurnout,
//                                     totalRegisteredVoters, voterTurnoutPercentage, lastReportTimestamp:"202409160932", ... } }
// Not found: a county breakdown for House (maps/us-rep/... is not a route), unprocessed-ballot counts (/unprocessed-ballots 500).
// Numbers are strings with thousands separators. Change detection: a hash of the statewide files.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → content hash

function targets() {
  const cfg = readConfig('sources/casos.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `casos/${e.key}`,
      base: cfg.base,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      levels: ['state', 'county'],
      races: [...new Set([...(e.candidateRaces ?? []).map((r) => r.office), ...(e.houseSlug ? ['house'] : [])])],
      measures: Boolean(e.measuresSlug),
      url: e.url,
      timeZone: e.timeZone ?? 'America/Los_Angeles',
      candidateRaces: e.candidateRaces ?? [],
      houseSlug: e.houseSlug ?? null,
      measuresSlug: e.measuresSlug ?? null,
      countyMeasures: e.countyMeasures === true,
      statusSlug: e.statusSlug ?? null,
    }));
}

const num = (x) => {
  if (x == null || x === '') return null;
  const n = Number(String(x).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round1 = (x) => Math.round(x * 10) / 10;

/** "0% (0 of 23,860) precincts reporting" → { reporting, total, pct } */
export function parseReporting(s) {
  const m = String(s ?? '').match(/\(([\d,]+) of ([\d,]+)\)/);
  if (!m) return { reporting: null, total: null, pct: null };
  const reporting = num(m[1]); const total = num(m[2]);
  return { reporting, total, pct: total ? round1((100 * reporting) / total) : null };
}

/** Wall-clock time in a named zone → ISO UTC. */
function wallToIso(y, mo, d, h, mi, timeZone) {
  const wall = Date.UTC(y, mo, d, h, mi, 0);
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - off(wall);
  t = wall - off(t);
  return new Date(t).toISOString();
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "November 2, 2026, 6:28 p.m." (Pacific) → ISO UTC, or null. */
export function parseReportingTime(s, timeZone = 'America/Los_Angeles') {
  const m = String(s ?? '').trim().match(/^([A-Za-z]+)\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}) ?([ap])\.?m\.?$/i);
  if (!m) return null;
  const mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (mo < 0) return null;
  let h = Number(m[4]) % 12;
  if (m[6].toLowerCase() === 'p') h += 12;
  return wallToIso(+m[3], mo, +m[2], h, +m[5], timeZone);
}

const countyOf = (state, slug, unmatched, ctx) => {
  const m = matchCounty(state, String(slug).replace(/-/g, ' '));
  if (!m) unmatched('county', slug, ctx);
  return m;
};

const cleanTitle = (t) => String(t ?? '').replace(/\s+-\s+(Statewide|Districtwide|[A-Za-z .]+ County) Results\s*$/i, '').trim();

function candidateChoices(state, title, cands, unmatched) {
  return cands.map((c) => {
    const name = String(c.Name ?? '').replace(/\s+/g, ' ').trim();
    const { party, known } = normalizeParty(c.Party);
    if (!known) unmatched('party', c.Party ?? '', `${state} ${title} / ${name}`);
    return { name, party, partyRaw: c.Party ?? '' };
  });
}

function unitFrom(entry, names, base) {
  const rep = parseReporting(entry?.Reporting);
  const byName = new Map((entry?.candidates ?? []).map((c) => [String(c.Name ?? '').replace(/\s+/g, ' ').trim(), num(c.Votes) ?? 0]));
  return { ...base, votes: names.map((n) => byName.get(n) ?? 0), precinctsReporting: rep.reporting, precinctsTotal: rep.total, pctReporting: rep.pct };
}

/**
 * Pure parse of the CA SOS files into the adapter result (docs/data-contract.md).
 * @param {object} files { candidate:[{ office, statewide, map }], house:[...]|null, measures:{...}|null,
 *                         measuresByCounty:{ slug: {...} }, status:{...}|null }
 */
export function parseCaSos(files, t, unmatched = () => {}) {
  const races = [];
  const times = [];

  for (const cr of files.candidate ?? []) {
    const sw = cr.map?.statewide ?? cr.statewide;
    if (!sw?.candidates?.length) continue;
    const title = cleanTitle(sw.raceTitle);
    const cls = classifyContest(title);
    if (!cls || cls.office !== cr.office) unmatched('contest', title, `${t.state} expected ${cr.office}`);
    const choices = candidateChoices(t.state, title, sw.candidates, unmatched);
    const names = choices.map((c) => c.name);
    times.push(sw.ReportingTime);
    const units = [unitFrom(sw, names, { level: 'state', name: t.state })];
    for (const [slug, entry] of Object.entries(cr.map ?? {})) {
      if (slug === 'statewide') continue;
      const m = countyOf(t.state, slug, unmatched, `${t.state} ${title}`);
      if (m) units.push(unitFrom(entry, names, { level: 'county', countyFips: m.fips, name: m.name }));
    }
    races.push({ office: cr.office, district: null, name: title, key: cr.office, voteFor: 1, statewide: true, title: null, choices, units });
  }

  for (const h of files.house ?? []) {
    const title = cleanTitle(h.raceTitle);
    const cls = classifyContest(title);
    if (!cls || cls.office !== 'house') { unmatched('contest', title, `${t.state} House file`); continue; }
    const choices = candidateChoices(t.state, title, h.candidates ?? [], unmatched);
    times.push(h.ReportingTime);
    races.push({
      office: 'house', district: cls.district, name: title, key: `us-rep-${cls.district}`, voteFor: 1, statewide: true, title: null,
      choices, units: [unitFrom(h, choices.map((c) => c.name), { level: 'state', name: t.state })],
    });
  }

  if (files.measures) {
    const rep = parseReporting(files.measures.Reporting);
    times.push(files.measures.ReportingTime);
    const countyRows = []; // [{ m, rep, list }]
    for (const [slug, f] of Object.entries(files.measuresByCounty ?? {})) {
      const m = countyOf(t.state, slug, unmatched, `${t.state} ballot measures`);
      if (m) countyRows.push({ m, rep: parseReporting(f?.Reporting), list: f?.['ballot-measures'] ?? [] });
    }
    for (const bm of files.measures['ballot-measures'] ?? []) {
      if (!bm?.Number) continue;
      const no = String(bm.Number).trim();
      const unit = (base, row, r) => ({
        ...base, votes: [num(row?.yesVotes) ?? 0, num(row?.noVotes) ?? 0], yes: num(row?.yesVotes) ?? 0, no: num(row?.noVotes) ?? 0,
        precinctsReporting: r.reporting, precinctsTotal: r.total, pctReporting: r.pct,
      });
      const units = [unit({ level: 'state', name: t.state }, bm, rep)];
      for (const c of countyRows) {
        const row = c.list.find((x) => String(x.Number).trim() === no);
        if (row) units.push(unit({ level: 'county', countyFips: c.m.fips, name: c.m.name }, row, c.rep));
      }
      races.push({
        office: 'measure', district: null, name: `Proposition ${Number(no) || no}`, key: `prop-${no}`, voteFor: 1, statewide: true,
        title: bm.Name ? String(bm.Name).trim() : null,
        choices: [{ name: 'Yes', party: 'OTHER', partyRaw: '' }, { name: 'No', party: 'OTHER', partyRaw: '' }],
        units,
      });
    }
  }

  // Turnout from /status, but only when it belongs to this election (it can hold old test data).
  const turnout = [];
  const minStamp = t.date ? t.date.replace(/-/g, '') : null;
  for (const [slug, s] of Object.entries(files.status ?? {})) {
    if (!s || typeof s !== 'object') continue;
    const stamp = String(s.lastReportTimestamp ?? '');
    if (!minStamp || !/^\d{8}/.test(stamp) || stamp.slice(0, 8) < minStamp) continue;
    const base = slug === 'statewide' ? { level: 'state', name: t.state } : (() => {
      const m = countyOf(t.state, slug, unmatched, `${t.state} status`);
      return m ? { level: 'county', countyFips: m.fips, name: m.name } : null;
    })();
    if (!base) continue;
    turnout.push({
      ...base, registered: num(s.totalRegisteredVoters), ballotsCast: num(s.voterTurnout), turnoutPct: num(s.voterTurnoutPercentage),
      ballotsOutstanding: null, precinctsReporting: num(s.precinctsReporting), precinctsTotal: num(s.precinctsTotal),
    });
  }

  const stamps = times.map((x) => parseReportingTime(x, t.timeZone)).filter(Boolean).sort();
  return {
    election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: t.date, url: t.url },
    version: files.version ?? null,
    sourceUpdatedAt: stamps.at(-1) ?? null,
    turnout,
    races,
  };
}

async function fetchTarget(t, { http, unmatched, log }) {
  const get = async (slug) => (await http.get(`${t.base}/${slug}`, { accept: 'application/json' })).text;
  const texts = {};
  for (const cr of t.candidateRaces) texts[`c:${cr.office}`] = await get(cr.countyMap ?? cr.slug);
  if (t.houseSlug) texts.house = await get(t.houseSlug);
  if (t.measuresSlug) texts.measures = await get(t.measuresSlug);
  if (t.statusSlug) {
    texts.status = await get(t.statusSlug).catch((err) => { log?.warn?.(`casos: status unavailable: ${err.message}`); return null; });
  }
  const version = createHash('sha1').update(JSON.stringify(texts)).digest('hex').slice(0, 16);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const parse = (s) => (s ? JSON.parse(s) : null);
  const files = {
    version,
    candidate: t.candidateRaces.map((cr) => {
      const j = parse(texts[`c:${cr.office}`]);
      return cr.countyMap ? { office: cr.office, map: j } : { office: cr.office, statewide: j };
    }),
    house: parse(texts.house),
    measures: parse(texts.measures),
    status: parse(texts.status),
    measuresByCounty: {},
  };
  if (t.countyMeasures && t.measuresSlug) {
    // County slugs come from the source's own county map (or status), never a hardcoded list. Sequential, to stay polite.
    const slugs = Object.keys(files.candidate.find((c) => c.map)?.map ?? files.status ?? {}).filter((s) => s !== 'statewide' && s !== '');
    for (const slug of slugs) {
      try {
        files.measuresByCounty[slug] = parse(await get(`${t.measuresSlug}/county/${slug}`));
      } catch (err) {
        log?.warn?.(`casos: measures for ${slug} unavailable: ${err.message}`);
      }
    }
  }
  const result = parseCaSos(files, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result };
}

export default {
  id: 'casos',
  name: 'California Secretary of State results API',
  homepage: 'https://electionresults.sos.ca.gov/',
  targets,
  fetch: fetchTarget,
};
