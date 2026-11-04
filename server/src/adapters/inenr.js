// Indiana Election Division ENR (https://enr.indianavoters.in.gov/site/index.html): static JSON on Azure blob storage.
//
// Verified live on 2026-11-03 (results already coming in: 1,579 of 5,067 precincts at 01:45 UTC). File names come from
// the site's own jsonDataFetcher: data/{name}.json, or data/{name}_{VersionType}.json for versioned files, where
// settings.VersionType is the live buffer ("A"/"B"):
//   settings.json                    VersionCode ("20261103_204046", moves with every publish), VersionType, CurrentElection,
//                                    PolParties (POLITICALPARTYID → PARTY_NAME). 3.5 KB: read every poll, the change check.
//   statewideElectionsC_{v}.json     office categories (OFFICECATEGORYID, OFFICE_CATEGORY_NAME) under Federal / State /
//                                    Local, plus JurisdictionsReporting { TOTAL_ALLPRECINCTSREPORTING, TOTAL_ALLPRECINCTS }.
//   statewideTurnout_{v}.json        per county REGISTERED_VOTERS, VotersVoting, InPerson, Absentee (0 until a county reports).
//   OffCatC_{OFFICECATEGORYID}_{v}.json  every contest of one category: StatewideSummary.Race[{ OFFICEID, OFFICE_TITLE,
//                                    NumofSeats, Candidates.Candidate[{ NAME_ON_BALLOT, POLITICALPARTYID, PARTY, TOTAL }] }],
//                                    and OfficeCategory.Regions.Region[] (counties: MAP_JURISDICTION_TYPE "Locality", or
//                                    districts) each with RegionSummary.Race = the same contests in that region.
// County units come from the "Locality" regions. No precinct counts per contest (only the statewide total) and no vote
// methods per contest. Referendums are only published as one Yes/No sum per county across ALL questions
// (statewideElectionsR), which would add different questions together: not stored. isWinner flags are ignored.
//
// Requests: settings every poll; on a new VersionCode the categories file, the turnout file and each `detailCategories`
// file; every other category is swept `sweepBatch` per poll, a new sweep at most every `sweepSeconds`.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty } from '../normalize.js';
import { matchCounty } from '../geo.js';

const state = new Map();

function targets() {
  const c = readConfig('sources/inenr.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `IN/${e.id}`,
      state: 'IN',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      currentElection: e.currentElection,
      data: (e.data ?? c.data).replace(/\/$/, ''),
      url: e.url ?? 'https://enr.indianavoters.in.gov/site/index.html',
      detailCategories: e.detailCategories ?? c.detailCategories ?? [],
      categoryHints: c.categoryHints ?? {},
      knownParties: new Set((c.knownOtherParties ?? []).map((p) => p.toLowerCase())),
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: false,
      allContests: e.allContests ?? true,
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 300,
      sweepBatch: e.sweepBatch ?? c.sweepBatch ?? 8,
      sweepSeconds: e.sweepSeconds ?? c.sweepSeconds ?? 300,
    }));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const root = (j) => j?.Root ?? j?.root ?? j;

async function fetchTarget(t, { http, log, unmatched }) {
  const s = state.get(t.key) ?? { code: null, cats: null, catFiles: new Map(), turnout: null, queue: [], sweepCode: null, sweepAt: 0, version: null };
  state.set(t.key, s);
  const now = Date.now();
  const getJ = async (name) => {
    await pause(t.requestGapMs);
    return root(JSON.parse((await http.get(`${t.data}/${name}.json`, { accept: 'application/json' })).text));
  };

  const settings = root(JSON.parse((await http.get(`${t.data}/settings.json`, { accept: 'application/json' })).text));
  if (t.currentElection && settings.CurrentElection !== t.currentElection) {
    log?.warn?.(`IN: the site shows the ${settings.CurrentElection} election, not ${t.currentElection}; nothing stored`);
    return { changed: false, version: s.version };
  }
  const v = settings.VersionType;
  const code = settings.VersionCode;
  if (!v || !code) throw new Error('IN ENR settings.json: no VersionType / VersionCode');

  if (code !== s.code) {
    s.cats = await getJ(`statewideElectionsC_${v}`);
    s.turnout = await getJ(`statewideTurnout_${v}`).catch(() => null);
    for (const id of categoryIds(s.cats).filter((x) => t.detailCategories.includes(x))) s.catFiles.set(id, await getJ(`OffCatC_${id}_${v}`));
    s.code = code;
    s.buffer = v;
  }
  const others = categoryIds(s.cats).filter((x) => !t.detailCategories.includes(x));
  const due = s.sweepCode !== code && now - s.sweepAt >= t.sweepSeconds * 1000;
  if (!s.queue.length && (due || others.some((x) => !s.catFiles.has(x)))) {
    s.queue = others.filter((x) => due || !s.catFiles.has(x));
    s.sweepCode = code;
    s.sweepAt = now;
  }
  for (const id of s.queue.splice(0, t.sweepBatch)) {
    try {
      s.catFiles.set(id, await getJ(`OffCatC_${id}_${s.buffer}`));
    } catch (err) {
      s.queue.unshift(id);
      throw err;
    }
  }

  const result = parseInEnr({ settings, categories: s.cats, turnout: s.turnout, files: [...s.catFiles.values()] }, t, unmatched);
  const version = createHash('sha1').update(JSON.stringify(result)).digest('hex').slice(0, 16);
  if (version === s.version) return { changed: false, version };
  s.version = version;
  if (s.queue.length) log?.info?.(`IN: ${s.queue.length} office categories left in this sweep`);
  return { changed: true, version, result: { ...result, version } };
}

/** OFFICECATEGORYIDs in the categories file, in its order. */
export function categoryIds(cats) {
  return arr(root(cats)?.List).flatMap((h) => arr(h?.Items?.Item)).map((i) => String(i.OFFICECATEGORYID)).filter(Boolean);
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "2026-11-03T20:42:38.767" (Indiana local, EST on election day) → ISO. */
export function parseWriteTime(s, offset = '-05:00') {
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const d = new Date(`${String(s).slice(0, 19)}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Pure parse into the adapter result (without `version`). */
export function parseInEnr({ settings, categories, turnout, files }, t, unmatched = () => {}) {
  const st = 'IN';
  const parties = new Map(arr(settings?.PolParties?.PolParty).map((p) => [String(p.POLITICALPARTYID), String(p.PARTY_NAME ?? '').trim()]));
  const countyCache = new Map();
  const county = (name) => {
    const k = String(name ?? '').trim();
    if (/^total$/i.test(k)) return null; // a statewide "Total" region beside the counties
    if (!countyCache.has(k)) {
      const m = k ? matchCounty(st, k) : null;
      if (!m && k) unmatched('county', k, 'IN ENR region');
      countyCache.set(k, m);
    }
    return countyCache.get(k);
  };

  const races = [];
  let allCounties = 0;
  for (const f of files.map(root)) {
    // The source's office category is a reliable code for the local ones (all "School Board Member" contests are school
    // boards): config categoryHints give those level + office, before the name rules.
    const hint = t.categoryHints?.[String(f?.OfficeCategory?.OFFICECATEGORYID)] ?? null;
    const regions = arr(f?.OfficeCategory?.Regions?.Region).filter((r) => r.MAP_JURISDICTION_TYPE === 'Locality');
    allCounties = Math.max(allCounties, regions.length);
    const byOffice = new Map(); // OFFICEID → [{ m, race }]
    for (const reg of regions) {
      const m = county(reg.MAP_JURISDICTION_NAME);
      if (!m) continue;
      for (const race of arr(reg?.RegionSummary?.Race)) {
        const k = String(race.OFFICEID);
        if (!byOffice.has(k)) byOffice.set(k, []);
        byOffice.get(k).push({ m, race });
      }
    }
    for (const race of arr(f?.StatewideSummary?.Race)) {
      const name = String(race.OFFICE_TITLE ?? '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const cands = arr(race?.Candidates?.Candidate);
      const keyOf = (c) => `${String(c.NAME_ON_BALLOT ?? '').trim()}|${c.POLITICALPARTYID}`;
      const labels = cands.map((c) => String(c.NAME_ON_BALLOT ?? '').replace(/\s+/g, ' ').trim());
      const cls = classifyContest(name, labels);
      const choices = cands.map((c, i) => {
        let raw = parties.get(String(c.POLITICALPARTYID)) || String(c.PARTY ?? '').trim();
        if (/^\(\s*\)$/.test(raw)) raw = ''; // the party list's "(  )" = no party
        const { party, known } = normalizeParty(raw);
        if (!known && !t.knownParties?.has(raw.toLowerCase())) unmatched('party', raw, `IN ${name} / ${labels[i]}`);
        return { name: labels[i], party, partyRaw: raw };
      });
      const idx = new Map(cands.map((c, i) => [keyOf(c), i]));
      const countyUnits = (byOffice.get(String(race.OFFICEID)) ?? []).map(({ m, race: rr }) => {
        const votes = cands.map(() => 0);
        for (const c of arr(rr?.Candidates?.Candidate)) {
          const i = idx.get(keyOf(c));
          if (i != null) votes[i] += num(c.TOTAL) ?? 0;
        }
        return { level: 'county', countyFips: m.fips, name: m.name, votes, precinctsReporting: null, precinctsTotal: null, pctReporting: null };
      });
      const statewide = allCounties > 0 && countyUnits.length === allCounties;
      races.push({
        office: cls?.office ?? (hint ? hint.office : null),
        ...(hint && !cls ? { level: hint.level } : {}),
        district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
        name,
        key: String(race.OFFICEID),
        voteFor: num(race.NumofSeats),
        statewide,
        title: null,
        choices,
        units: [
          { level: 'state', name: statewide ? st : name, votes: cands.map((c) => num(c.TOTAL) ?? 0), precinctsReporting: null, precinctsTotal: null, pctReporting: null },
          ...countyUnits,
        ],
      });
    }
  }

  const turnoutUnits = [];
  const jr = root(categories)?.JurisdictionsReporting;
  let reg = 0, cast = 0, any = false;
  for (const c of arr(root(turnout)?.CountyTurnout)) {
    const m = county(c.County);
    if (!m) continue;
    const registered = num(c.REGISTERED_VOTERS) || null; // 0 until the county reports
    const voting = registered ? num(c.VotersVoting) : null;
    if (registered) {
      any = true;
      reg += registered;
      cast += voting ?? 0;
    }
    turnoutUnits.push({ level: 'county', countyFips: m.fips, name: m.name, registered, ballotsCast: voting, turnoutPct: registered && voting != null ? Math.round((1000 * voting) / registered) / 10 : null });
  }
  turnoutUnits.unshift({
    level: 'state', name: st,
    // Statewide sums only over counties that have reported; registration is unknown for the others.
    registered: null, ballotsCast: any ? cast : null, turnoutPct: null,
    precinctsReporting: num(jr?.TOTAL_ALLPRECINCTSREPORTING), precinctsTotal: num(jr?.TOTAL_ALLPRECINCTS),
  });
  void reg;

  return {
    election: { sourceKey: t.key, state: st, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: parseWriteTime(root(categories)?.WriteTime),
    turnout: turnoutUnits,
    races,
  };
}

export default {
  id: 'inenr',
  name: 'Indiana Election Division ENR',
  homepage: 'https://enr.indianavoters.in.gov/site/index.html',
  targets,
  fetch: fetchTarget,
};
