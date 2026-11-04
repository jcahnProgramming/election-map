// Turns the latest snapshots into what the API serves (docs/data-contract.md section 3). Rules that matter:
//  - "Leading" = most votes counted right now. We never call races and never say "winner".
//  - Party totals are never summed across different races. The one sum we do is the U.S. House
//    statewide popular vote: the same office across a state's districts, which is what that view means
//    (that includes the per-method House split: districts combined by party within each vote method).
//  - A state with no source says so ("no-source"); a state with no race for the office says that ("no-race").
//  - Everything is scoped to one election key (config/elections.json); data never leaks between elections.
//  - null means "the source doesn't publish this"; it is never turned into 0.
//  - Multi-seat contests (vote for 2+) are never shaded as a two-way margin: they report their top-N candidates.
//  - Every state carries its official results page (config/official-results.json): every number one click from its source.
import { STATES, stateByAbbr, countiesOf } from './geo.js';
import { readConfig } from './config.js';
import { loadElections } from './elections.js';
import { officeLabel } from './contests.js';
import { findMeasureInfo, measureInfoList, publicInfo, statePartyNames } from './measureinfo.js';
import { attachPhotos } from './photos.js';

export const COVERAGE_STATUSES = ['live', 'planned', 'blocked', 'no_feed'];

/** The headline offices every election shows; `/api/offices` adds whatever else the feeds carry. */
export const RACES = ['senate', 'governor', 'house'];
const PARTIES = ['DEM', 'REP', 'OTHER'];
export const OFFICE_RE = /^[a-z][a-z_]{1,48}$/;
/** Pseudo-office: each state's top race (Senate, else Governor, else the House statewide popular vote). */
export const TOP = 'top';

/** Selector levels → contest levels they draw from. */
export const SELECT_LEVELS = { top: [], federal: ['federal'], state: ['statewide'] };
const OFFICE_ORDER = ['president', 'senate', 'house', 'governor', 'lieutenant_governor', 'attorney_general', 'secretary_of_state',
  'treasurer', 'auditor', 'controller'];
const GROUPS = [
  ['federal', 'Federal'], ['statewide', 'Statewide'], ['legislative', 'State legislature'], ['county', 'County'],
  ['local', 'Local'], ['judicial', 'Judicial'], ['measure', 'Ballot measures'], ['unclassified', 'Other contests'],
];
const HEADLINE_LEVELS = new Set(['federal', 'measure']);
/** No district, or 'at large' (AL): the contest covers the whole state. */
const wholeState = (d) => !d || d === 'AL';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} adapters  the registry (id, name, targets())
 * @param {{ elections?: { current:string, elections:object[] }, photos?: ReturnType<import('./photos.js').createPhotos> }} [opts]
 *   elections: override config/elections.json (tests); photos: candidate photos (none when absent: initials everywhere)
 */
export function createResults(db, adapters, opts = {}) {
  /** Fairness decision for one contest (photos for every major candidate, or none). */
  const decidePhotos = (ek, state, office, district, candidates) => opts.photos?.decide(ek, state, office, district, candidates) ?? null;
  const electionsLoaded = opts.elections ?? loadElections(); // read once; config changes ship with a restart
  const electionsCfg = () => electionsLoaded;
  const adapterName = (id) => adapters.find((a) => a.id === id)?.name ?? id ?? null;
  const racesFiles = new Map(); // config file → contents (config only changes with a deploy)

  /** Which states are expected to hold which race in an election (only used for states without a live source). */
  function expectsRace(ek, st, race) {
    if (race === 'house') return st !== 'DC';
    const e = electionsCfg().elections.find((x) => x.key === ek);
    if (!e?.races) return true; // unknown: say "no source", never claim there is no race
    if (!racesFiles.has(e.races)) racesFiles.set(e.races, readConfig(e.races, null));
    const expected = racesFiles.get(e.races);
    if (!expected || !Array.isArray(expected[race])) return true; // an office the file doesn't list: unknown, never "no race"
    return expected[race].includes(st);
  }

  const coverageAll = readConfig('coverage-status.json', { states: {} });
  /** Why a state does or doesn't have live results: live | planned | blocked | no_feed (config/coverage-status.json). */
  const coverageStatusOf = (abbr) => (COVERAGE_STATUSES.includes(coverageAll.states?.[abbr]?.status) ? coverageAll.states[abbr].status : null);

  const officialAll = readConfig('official-results.json', { states: {} });
  /** The state's own official results page (config/official-results.json). */
  const officialOf = (abbr, ek) => {
    if (officialAll.election && ek && officialAll.election !== ek) return null; // the links are per election
    const o = officialAll.states?.[abbr];
    return o?.url ? { url: o.url, office: o.office ?? null } : null;
  };

  const RACE_COLS = `r.id, r.name, r.title, r.district, r.source_key, r.office, r.level, r.kind, r.vote_for, r.jurisdiction, r.statewide,
        e.id AS election_id, e.source, e.scope, e.state,
        e.county_fips, e.url, l.snapshot_id, l.fetched_at, l.checked_at, s.source_updated_at`;
  const RACE_FROM = `FROM races r JOIN elections e ON e.id = r.election_id JOIN latest_snapshot l ON l.election_id = e.id
      JOIN snapshots s ON s.id = l.snapshot_id`;
  const q = {
    races: db.prepare(`SELECT ${RACE_COLS} ${RACE_FROM}
      WHERE e.election_key = ? AND r.state = ? AND r.office = ? AND e.scope = 'state'
        AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = l.snapshot_id AND x.race_id = r.id)
      ORDER BY CAST(r.source_key AS INTEGER), r.source_key`),
    countyRaces: db.prepare(`SELECT ${RACE_COLS} ${RACE_FROM}
      WHERE e.election_key = ? AND r.state = ? AND r.office = ? AND e.scope = 'county'
        AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = l.snapshot_id AND x.race_id = r.id)
      ORDER BY e.county_fips, CAST(r.source_key AS INTEGER), r.source_key`),
    liveStateSource: db.prepare(`SELECT 1 FROM elections e JOIN latest_snapshot l ON l.election_id = e.id
      WHERE e.election_key = ? AND e.state = ? AND e.scope = 'state'`),
    votes: db.prepare(`SELECT c.position, c.name, c.party, c.party_raw, c.running_mate, v.votes, u.level, u.county_fips, u.name AS unit
      FROM vote_counts v JOIN candidates c ON c.id = v.candidate_id JOIN reporting_units u ON u.id = v.unit_id
      WHERE v.snapshot_id = ? AND v.race_id = ? ORDER BY c.position`),
    reporting: db.prepare(`SELECT u.level, u.county_fips, u.name AS unit, x.precincts_reporting pr, x.precincts_total pt, x.pct_reporting pct
      FROM unit_reporting x JOIN reporting_units u ON u.id = x.unit_id WHERE x.snapshot_id = ? AND x.race_id = ?`),
    methods: db.prepare(`SELECT u.level, u.county_fips, u.name AS unit, m.choice_pos, m.method_raw, m.method_bucket, m.method_order, m.votes
      FROM method_counts m JOIN reporting_units u ON u.id = m.unit_id WHERE m.snapshot_id = ? AND m.race_id = ?
      ORDER BY m.method_order, m.choice_pos`),
    candParties: db.prepare('SELECT position, party FROM candidates WHERE race_id = ?'),
    turnout: db.prepare(`SELECT u.level, u.county_fips, t.registered, t.ballots_cast, t.turnout_pct, t.ballots_outstanding,
        t.precincts_reporting, t.precincts_total
      FROM unit_turnout t JOIN reporting_units u ON u.id = t.unit_id WHERE t.snapshot_id = ?`),
    measures: db.prepare(`SELECT r.id, r.name, r.title, r.state, r.source_key, e.source, e.url, l.snapshot_id, l.fetched_at,
        s.source_updated_at, m.yes, m.no, x.pct_reporting pct, x.precincts_reporting pr, x.precincts_total pt
      FROM races r JOIN elections e ON e.id = r.election_id JOIN latest_snapshot l ON l.election_id = e.id
      JOIN snapshots s ON s.id = l.snapshot_id
      JOIN reporting_units u ON u.state = r.state AND u.level = 'state' AND u.county_fips = ''
      JOIN measure_counts m ON m.snapshot_id = l.snapshot_id AND m.race_id = r.id AND m.unit_id = u.id
      LEFT JOIN unit_reporting x ON x.snapshot_id = l.snapshot_id AND x.race_id = r.id AND x.unit_id = u.id
      WHERE e.election_key = ? AND r.office = 'measure' AND r.statewide = 1 AND e.scope = 'state' AND (? IS NULL OR r.state = ?)
      ORDER BY r.state, CAST(r.source_key AS INTEGER), r.source_key`),
    // ---- 0.3: offices list and the per-state "All races" list ----
    offices: db.prepare(`SELECT DISTINCT r.office, r.level, r.state, r.district, r.vote_for ${RACE_FROM}
      WHERE e.election_key = ? AND e.scope = 'state' AND r.level IN ('federal','statewide')
        AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = l.snapshot_id AND x.race_id = r.id)`),
    liveElections: db.prepare(`SELECT e.id AS election_id, e.source, e.scope, e.county_fips, e.name, e.url, l.snapshot_id, l.fetched_at,
        l.checked_at, s.source_updated_at
      FROM elections e JOIN latest_snapshot l ON l.election_id = e.id JOIN snapshots s ON s.id = l.snapshot_id
      WHERE e.election_key = ? AND e.state = ? ORDER BY e.scope DESC, e.county_fips, e.id`),
    contestsOf: db.prepare(`SELECT r.id, r.name, r.title, r.office, r.level, r.kind, r.district, r.jurisdiction, r.vote_for, r.statewide,
        r.source_key FROM races r
      WHERE r.election_id = ? AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = ? AND x.race_id = r.id)
      ORDER BY CAST(r.source_key AS INTEGER), r.source_key`),
    unitIdOf: db.prepare('SELECT id FROM reporting_units WHERE state = ? AND level = ? AND county_fips = ?'),
    unitVotes: db.prepare(`SELECT v.race_id, c.position, c.name, c.party, c.party_raw, c.running_mate, v.votes
      FROM vote_counts v JOIN candidates c ON c.id = v.candidate_id WHERE v.snapshot_id = ? AND v.unit_id = ? ORDER BY v.race_id, c.position`),
    countySumVotes: db.prepare(`SELECT v.race_id, c.position, c.name, c.party, c.party_raw, c.running_mate, SUM(v.votes) AS votes
      FROM vote_counts v JOIN candidates c ON c.id = v.candidate_id JOIN reporting_units u ON u.id = v.unit_id
      WHERE v.snapshot_id = ? AND u.level = 'county' GROUP BY v.race_id, c.position ORDER BY v.race_id, c.position`),
    unitMeasures: db.prepare('SELECT race_id, yes, no FROM measure_counts WHERE snapshot_id = ? AND unit_id = ?'),
    unitReporting: db.prepare(`SELECT race_id, precincts_reporting pr, precincts_total pt, pct_reporting pct
      FROM unit_reporting WHERE snapshot_id = ? AND unit_id = ?`),
  };

  /** Which states have configured targets in this election, from the adapters themselves. */
  function sourcesByState(ek) {
    const current = electionsCfg().current;
    const m = new Map();
    for (const a of adapters) {
      for (const t of a.targets()) {
        if ((t.election ?? current) !== ek) continue;
        if (!m.has(t.state)) m.set(t.state, []);
        m.get(t.state).push({ source: a.id, sourceName: a.name, ...t });
      }
    }
    return m;
  }

  const unitKey = (row) => (row.level === 'state' ? 'state' : row.county_fips);
  const pctOf = (pr, pt) => (pt ? Math.round((1000 * (pr ?? 0)) / pt) / 10 : null);

  /** Election-wide turnout per unit key for one snapshot. */
  function loadTurnout(snapshotId) {
    const out = new Map();
    for (const t of q.turnout.all(snapshotId)) {
      out.set(unitKey(t), {
        registered: t.registered, ballotsCast: t.ballots_cast, turnoutPct: t.turnout_pct,
        ballotsOutstanding: t.ballots_outstanding, precinctsReporting: t.precincts_reporting, precinctsTotal: t.precincts_total,
      });
    }
    return out;
  }

  /** Load one race's latest numbers, grouped by unit key ('state' or county FIPS). */
  function loadRace(r) {
    const units = new Map();
    const unit = (row) => {
      const k = unitKey(row);
      if (!units.has(k)) {
        units.set(k, { level: row.level, fips: row.county_fips, name: row.unit, candidates: [], pr: null, pt: null, pct: null, methods: null });
      }
      return units.get(k);
    };
    for (const v of q.votes.all(r.snapshot_id, r.id)) {
      unit(v).candidates.push({ name: v.name, party: v.party, partyRaw: v.party_raw, ...(v.running_mate ? { runningMate: v.running_mate } : {}), votes: v.votes });
    }
    for (const x of q.reporting.all(r.snapshot_id, r.id)) {
      Object.assign(unit(x), { pr: x.pr, pt: x.pt, pct: x.pct ?? pctOf(x.pr, x.pt) });
    }
    const rows = q.methods.all(r.snapshot_id, r.id);
    if (rows.length) {
      const party = new Map(q.candParties.all(r.id).map((c) => [c.position, c.party]));
      for (const m of rows) {
        const u = unit(m);
        u.methods ??= new Map();
        if (!u.methods.has(m.method_raw)) {
          u.methods.set(m.method_raw, { label: m.method_raw, bucket: m.method_bucket, order: m.method_order, total: null, parties: { DEM: 0, REP: 0, OTHER: 0 } });
        }
        const o = u.methods.get(m.method_raw);
        if (m.votes == null) continue; // not published for this choice: stays out of the sums, never becomes 0
        o.parties[party.get(m.choice_pos) ?? 'OTHER'] += m.votes;
        o.total = (o.total ?? 0) + m.votes;
      }
    }
    return units;
  }

  const methodsOut = (methods) => (methods?.size
    ? [...methods.values()].sort((a, b) => a.order - b.order).map(({ label, bucket, total, parties }) => ({ label, bucket, total, parties: { ...parties } }))
    : null);

  /**
   * Combine a state's House districts into per-party rows, per unit (and per vote method within each unit).
   * This is the one cross-contest sum the app makes: same office, same state, by party.
   */
  function combineHouse(raceUnits) {
    const out = new Map();
    for (const units of raceUnits) {
      for (const [k, u] of units) {
        if (!out.has(k)) {
          out.set(k, { level: u.level, fips: u.fips, name: u.name, byParty: { DEM: 0, REP: 0, OTHER: 0 }, parts: [], methods: null });
        }
        const o = out.get(k);
        let votes = 0;
        for (const c of u.candidates) {
          o.byParty[c.party] += c.votes;
          votes += c.votes;
        }
        o.parts.push({ pr: u.pr, pt: u.pt, pct: u.pct, votes });
        for (const m of u.methods?.values() ?? []) {
          o.methods ??= new Map();
          if (!o.methods.has(m.label)) o.methods.set(m.label, { label: m.label, bucket: m.bucket, order: m.order, total: null, parties: { DEM: 0, REP: 0, OTHER: 0 } });
          const t = o.methods.get(m.label);
          for (const p of PARTIES) t.parties[p] += m.parties[p];
          if (m.total != null) t.total = (t.total ?? 0) + m.total;
        }
      }
    }
    for (const o of out.values()) {
      o.candidates = PARTIES.filter((p) => o.byParty[p] > 0 || p !== 'OTHER')
        .map((p) => ({ name: `${p} candidates, all districts`, party: p, partyRaw: p, votes: o.byParty[p] }));
      // Precincts: summed only when every district reports them; otherwise unknown (null), not 0.
      const allPrecincts = o.parts.every((x) => x.pt != null);
      o.pr = allPrecincts ? o.parts.reduce((s, x) => s + (x.pr ?? 0), 0) : null;
      o.pt = allPrecincts ? o.parts.reduce((s, x) => s + x.pt, 0) : null;
      if (allPrecincts) o.pct = pctOf(o.pr, o.pt);
      else if (o.parts.every((x) => x.pct != null)) {
        // Only percentages: a vote-weighted mean across districts (equal weights before any votes).
        const w = o.parts.reduce((s, x) => s + x.votes, 0);
        o.pct = Math.round(10 * (w > 0
          ? o.parts.reduce((s, x) => s + x.pct * x.votes, 0) / w
          : o.parts.reduce((s, x) => s + x.pct, 0) / o.parts.length)) / 10;
      } else o.pct = null;
    }
    return out;
  }

  /**
   * Party totals, leader and margin for one contest. Multi-seat contests (voteFor > 1) elect several candidates, so a
   * margin between the top two means nothing: they get `multiSeat` + `seats` and no leader / margin.
   */
  function summarize(candidates, pct, voteFor = 1) {
    const parties = { DEM: 0, REP: 0, OTHER: 0 };
    let total = 0;
    for (const c of candidates) {
      parties[c.party] += c.votes;
      total += c.votes;
    }
    const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
    const seats = Number(voteFor) > 1 ? Number(voteFor) : 1;
    if (seats > 1) {
      return {
        candidates: sorted, parties, totalVotes: total, leader: null, tied: false, marginPts: null,
        multiSeat: true, seats, pctReporting: pct ?? null,
      };
    }
    const lead = sorted[0];
    const leader = total > 0 && lead.votes > (sorted[1]?.votes ?? 0) ? lead.party : null;
    const marginPts = total > 0 ? Math.round((10000 * (lead.votes - (sorted[1]?.votes ?? 0))) / total) / 100 : null;
    return {
      candidates: sorted,
      parties,
      totalVotes: total,
      leader, // null when tied or nothing counted
      tied: total > 0 && leader === null,
      marginPts,
      pctReporting: pct ?? null,
    };
  }

  /**
   * A state can have more than one state-scope source election (two adapters, say). Their contests must never be
   * combined, so one election is used per state and office: the one checked most recently.
   */
  function oneElection(races) {
    if (!races.length) return races;
    const best = [...races].sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)) || a.election_id - b.election_id)[0];
    return races.filter((r) => r.election_id === best.election_id);
  }

  const sourceFields = (r, t) => ({
    source: r?.source ?? t?.source ?? null,
    sourceName: adapterName(r?.source ?? t?.source) ?? null,
    sourceUrl: r?.url ?? t?.url ?? null,
    sourceUpdatedAt: r?.source_updated_at ?? null,
    fetchedAt: r?.fetched_at ?? null,
    checkedAt: r?.checked_at ?? null,
  });

  /**
   * One state's view of a race: statewide entry + county units + election-wide turnout.
   * @returns {{ entry:object, counties:Map|null, turnout:Map|null, methods:object[]|null }}
   */
  function stateRace(ek, abbr, race, srcs = sourcesByState(ek)) {
    const st = stateByAbbr(abbr);
    const base = { state: st.abbr, fips: st.fips, name: st.name, coverageStatus: coverageStatusOf(st.abbr) };
    const empty = {
      contests: [], candidates: [], parties: { DEM: 0, REP: 0, OTHER: 0 }, totalVotes: 0, leader: null, tied: false, marginPts: null,
      pctReporting: null, precinctsReporting: null, precinctsTotal: null, ballotsCast: null,
    };
    const stateSources = (srcs.get(st.abbr) ?? []).filter((t) => t.scope === 'state');
    base.official = officialOf(st.abbr, ek);
    base.officeLabel = officeLabel(race);
    // The map draws statewide contests only: House is the one sum (all districts); any other office uses contests that
    // cover the whole state (no district), never a county's own office that happens to share a name.
    const all = q.races.all(ek, st.abbr, race).filter((r) => (r.level == null || r.level === 'federal' || r.level === 'statewide'));
    const races = oneElection(race === 'house' ? all : all.filter((r) => wholeState(r.district)));

    if (!races.length) {
      // A configured source that hasn't produced data yet is still "no data", but not "no race". For offices beyond
      // the headline three, "no race" is only claimed when the state's feed carries every contest on the ballot.
      const hasLiveSource = stateSources.length > 0 && q.liveStateSource.get(ek, st.abbr);
      const feedHasAll = RACES.includes(race) || (stateSources.length > 0 && stateSources.every((t) => t.allContests !== false));
      let status;
      if (hasLiveSource) status = feedHasAll ? 'no-race' : 'no-source';
      else status = expectsRace(ek, st.abbr, race) ? 'no-source' : 'no-race';
      return {
        entry: {
          ...base, status, hasCountyData: false, ...empty, ...sourceFields(null, stateSources[0]),
          ...(hasLiveSource && !feedHasAll ? { sourceNote: `Our source for ${st.name} only carries some contests; this office isn't one of them.` } : {}),
        },
        counties: null, turnout: null, methods: null,
      };
    }

    let units;
    let contests;
    let otherContests = [];
    if (race === 'house') {
      units = combineHouse(races.map(loadRace));
      contests = races.map((r) => r.name);
    } else {
      // Two contests for the same office (e.g. a regular and a special Senate race) are different races:
      // never summed. The regular contest is the headline (a special / unexpired-term one goes after it); the rest are
      // listed separately.
      const special = (r) => /\b(special|unexpired|vacancy)\b/i.test(r.name);
      const [first, ...rest] = [...races].sort((a, b) => Number(special(a)) - Number(special(b)));
      units = loadRace(first);
      contests = [first.name];
      otherContests = rest.map((r) => {
        const u = loadRace(r).get('state');
        const sum = summarize(u?.candidates ?? [], u?.pct, r.vote_for);
        sum.candidates = attachPhotos(sum.candidates, decidePhotos(ek, st.abbr, race, r.district, sum.candidates));
        return { name: r.name, ...sum, precinctsReporting: u?.pr ?? null, precinctsTotal: u?.pt ?? null };
      });
    }
    const turnout = loadTurnout(races[0].snapshot_id);
    const sw = units.get('state');
    const voteFor = race === 'house' ? 1 : races[0].vote_for ?? 1;
    const s = summarize(sw?.candidates ?? [], sw?.pct, voteFor);
    // Photos: decided once per contest on the statewide numbers; counties reuse the same decision.
    const photos = race === 'house' ? null : decidePhotos(ek, st.abbr, race, races[0].district, s.candidates);
    s.candidates = attachPhotos(s.candidates, photos);
    const counties = new Map([...units].filter(([k]) => k !== 'state'));
    const entry = {
      ...base,
      status: s.totalVotes > 0 ? 'reporting' : 'awaiting',
      hasCountyData: counties.size > 0,
      voteFor,
      ...(race === 'house' ? { partySum: true } : {}), // the House statewide popular vote: a sum by party, not people
      contests,
      ...s,
      ...(otherContests.length ? { otherContests } : {}),
      precinctsReporting: sw?.pr ?? null,
      precinctsTotal: sw?.pt ?? null,
      ballotsCast: turnout.get('state')?.ballotsCast ?? null,
      ...sourceFields(races[0]),
    };
    return { entry, counties, turnout, methods: methodsOut(sw?.methods), photos };
  }

  function national(race, ek = electionsCfg().current) {
    const srcs = sourcesByState(ek);
    if (race === TOP) {
      return {
        election: ek, race, office: TOP, officeLabel: 'Top race on the ballot', generatedAt: new Date().toISOString(),
        states: STATES.map((s) => topRace(ek, s.abbr, srcs).entry),
      };
    }
    return {
      election: ek,
      race,
      office: race,
      officeLabel: officeLabel(race),
      generatedAt: new Date().toISOString(),
      states: STATES.map((s) => stateRace(ek, s.abbr, race, srcs).entry),
    };
  }

  /** One line about a contest that isn't the one coloring the map: its leading candidate (or party) and margin. */
  function raceLine(office, e, name = null) {
    const lead = e.candidates?.[0];
    return {
      office, label: officeLabel(office), name: name ?? e.contests?.[0] ?? null, status: e.status,
      partySum: !!e.partySum, multiSeat: !!e.multiSeat, seats: e.seats ?? null,
      leader: e.leader ?? null, tied: !!e.tied, marginPts: e.marginPts ?? null, totalVotes: e.totalVotes ?? 0,
      leadName: e.partySum || !e.totalVotes ? null : lead?.name ?? null,
      leadParty: lead?.party ?? null, leadPartyRaw: lead?.partyRaw ?? null,
      pctReporting: e.pctReporting ?? null,
    };
  }

  /**
   * "Top race": each state's highest-office contest this election, Senate, else Governor, else the U.S. House
   * statewide popular vote. The color is that one contest (the House fallback is the one sum CLAUDE.md allows, and
   * says so); the state's other major contests are listed beside it, never added to it.
   */
  function topRace(ek, abbr, srcs = sourcesByState(ek)) {
    const views = Object.fromEntries(RACES.map((o) => [o, stateRace(ek, abbr, o, srcs)]));
    const has = (o) => ['reporting', 'awaiting'].includes(views[o].entry.status);
    const order = ['senate', 'governor', 'house'];
    let pick = order.find(has);
    if (!pick) {
      // Nothing from a source: the top race the state is expected to hold (still "no data source yet").
      pick = order.find((o) => views[o].entry.status === 'no-source') ?? 'senate';
    }
    const chosen = views[pick];
    const otherRaces = [];
    for (const o of order) {
      const e = views[o].entry;
      if (o !== pick && has(o)) otherRaces.push(raceLine(o, e));
      // A second contest for the same office (a special Senate election) is its own line.
      for (const c of e.otherContests ?? []) {
        otherRaces.push(raceLine(o, { ...c, status: c.totalVotes > 0 ? 'reporting' : 'awaiting' }, c.name));
      }
    }
    return {
      ...chosen,
      entry: { ...chosen.entry, topOffice: pick, topLabel: pick === 'house' ? 'U.S. House · statewide popular vote' : officeLabel(pick), otherRaces },
      office: pick,
    };
  }

  /**
   * Which offices the level selector offers, from the data: Federal = U.S. Senate + U.S. House (+ President when
   * present); State = Governor plus every statewide (whole-state, single-district) office that at least one covered
   * state's feed carries in this election. `/api/offices`.
   */
  function offices(ek = electionsCfg().current) {
    const found = new Map(); // office → { level, states:Set, multiSeat }
    for (const r of q.offices.all(ek)) {
      if (r.office !== 'house' && !wholeState(r.district)) continue; // districted statewide boards aren't a state-by-state map
      if (!found.has(r.office)) found.set(r.office, { level: r.level, states: new Set(), multiSeat: false });
      const o = found.get(r.office);
      o.states.add(r.state);
      if (Number(r.vote_for) > 1) o.multiSeat = true;
    }
    const ensure = (office, level) => { if (!found.has(office)) found.set(office, { level, states: new Set(), multiSeat: false }); };
    ensure('senate', 'federal');
    ensure('house', 'federal');
    ensure('governor', 'statewide');
    const rank = (k) => { const i = OFFICE_ORDER.indexOf(k); return i < 0 ? OFFICE_ORDER.length : i; };
    const list = (lvl) => [...found].filter(([, o]) => SELECT_LEVELS[lvl].includes(o.level))
      .sort(([a], [b]) => rank(a) - rank(b) || officeLabel(a).localeCompare(officeLabel(b)))
      .map(([office, o]) => ({ office, label: officeLabel(office), states: [...o.states].sort(), multiSeat: o.multiSeat }));
    return { election: ek, generatedAt: new Date().toISOString(), levels: { federal: list('federal'), state: list('state') } };
  }

  /** Which selector level an office belongs to ('federal' | 'state'), or null when it isn't on the map. */
  function levelOfOffice(office, ek) {
    const o = offices(ek).levels;
    if (o.federal.some((x) => x.office === office)) return 'federal';
    if (o.state.some((x) => x.office === office)) return 'state';
    return null;
  }

  /**
   * Every contest in a state's feeds, grouped Federal / Statewide / State legislature / County / Local / Judicial /
   * Ballot measures / Other, with search over office, district, county and city names. `/api/state/:abbr/contests`.
   * Each contest stands alone: nothing here is summed across contests.
   */
  function contests(abbr, ek = electionsCfg().current, query = '') {
    const st = stateByAbbr(abbr);
    const srcs = sourcesByState(ek).get(st.abbr) ?? [];
    const out = [];
    const sources = [];
    for (const e of q.liveElections.all(ek, st.abbr)) {
      const src = { source: e.source, sourceName: adapterName(e.source), sourceUrl: e.url ?? null, scope: e.scope,
        county: e.scope === 'county' ? e.name : null, sourceUpdatedAt: e.source_updated_at ?? null, fetchedAt: e.fetched_at };
      sources.push(src);
      const top = e.scope === 'state' ? q.unitIdOf.get(st.abbr, 'state', '') : q.unitIdOf.get(st.abbr, 'county', e.county_fips ?? '');
      const byRace = (rows) => {
        const m = new Map();
        for (const r of rows) {
          if (!m.has(r.race_id)) m.set(r.race_id, []);
          m.get(r.race_id).push(r);
        }
        return m;
      };
      const votes = top ? byRace(q.unitVotes.all(e.snapshot_id, top.id)) : new Map();
      let countySums = null; // only for contests the source publishes by county alone
      const meas = new Map((top ? q.unitMeasures.all(e.snapshot_id, top.id) : []).map((r) => [r.race_id, r]));
      const rep = new Map((top ? q.unitReporting.all(e.snapshot_id, top.id) : []).map((r) => [r.race_id, r]));
      for (const r of q.contestsOf.all(e.election_id, e.snapshot_id)) {
        const rp = rep.get(r.id);
        const pct = rp ? rp.pct ?? pctOf(rp.pr, rp.pt) : null;
        let row;
        if (r.office === 'measure') {
          const m = meas.get(r.id);
          const yes = m?.yes ?? 0;
          const no = m?.no ?? 0;
          const total = yes + no;
          row = {
            candidates: [{ name: 'Yes', party: null, votes: yes }, { name: 'No', party: null, votes: no }],
            totalVotes: total,
            lead: total > 0 && yes !== no ? (yes > no ? 'YES' : 'NO') : null,
            marginPts: total > 0 ? Math.round((10000 * Math.abs(yes - no)) / total) / 100 : null,
            measureId: r.statewide && e.scope === 'state' ? `${e.source}:${st.abbr}:${r.source_key}` : null,
          };
        } else {
          let cands = votes.get(r.id);
          if (!cands) {
            countySums ??= byRace(q.countySumVotes.all(e.snapshot_id));
            cands = countySums.get(r.id) ?? [];
          }
          const s = summarize(cands.map((c) => ({ name: c.name, party: c.party, partyRaw: c.party_raw, ...(c.running_mate ? { runningMate: c.running_mate } : {}), votes: c.votes })), pct, r.vote_for);
          if (e.scope === 'state') s.candidates = attachPhotos(s.candidates, decidePhotos(ek, st.abbr, r.office, r.district, s.candidates));
          const yesNo = r.kind === 'retention' || r.kind === 'yes_no';
          const first = s.candidates[0];
          row = {
            candidates: s.candidates,
            totalVotes: s.totalVotes,
            leader: s.leader,
            tied: s.tied,
            marginPts: s.marginPts,
            multiSeat: !!s.multiSeat,
            seats: s.seats ?? 1,
            // Who leads, in the contest's own terms: a party (partisan), a name (nonpartisan), YES/NO (questions).
            lead: !s.totalVotes || s.multiSeat || s.tied ? null
              : yesNo ? (/^(yes|for)\b/i.test(first.name) ? 'YES' : /^(no|against)\b/i.test(first.name) ? 'NO' : first.name)
                : r.kind === 'partisan' ? first.party : first.name,
            leadPartyRaw: !s.totalVotes || s.multiSeat || s.tied || r.kind !== 'partisan' ? null : first.partyRaw || null,
          };
          if (row.marginPts != null) row.marginPts = Math.round(row.marginPts * 100) / 100;
        }
        const totalShare = (v) => (row.totalVotes > 0 ? Math.round((1000 * v) / row.totalVotes) / 10 : null);
        row.candidates = row.candidates.map((c) => ({ ...c, pct: totalShare(c.votes) }));
        out.push({
          id: `${e.source}:${e.election_id}:${r.source_key}`,
          name: r.name,
          title: r.title ?? null,
          level: r.level ?? 'unclassified',
          office: r.office,
          officeLabel: officeLabel(r.office),
          district: r.district ?? null,
          jurisdiction: r.jurisdiction ?? (e.scope === 'county' ? e.name : null),
          kind: r.kind ?? (r.office === 'measure' ? 'yes_no' : 'nonpartisan'),
          voteFor: r.vote_for ?? null,
          statewide: !!r.statewide,
          scope: e.scope,
          ...row,
          pctReporting: pct,
          precinctsReporting: rp?.pr ?? null,
          precinctsTotal: rp?.pt ?? null,
          source: e.source,
        });
      }
    }
    const needle = String(query ?? '').trim().toLowerCase();
    const groupTitle = Object.fromEntries(GROUPS);
    const hay = (c) => [c.name, c.title, c.officeLabel, c.district && `district ${c.district}`, c.jurisdiction, groupTitle[c.level],
      ...(c.candidates ?? []).map((x) => x.name)].filter(Boolean).join(' ').toLowerCase();
    const terms = needle.split(/\s+/).filter(Boolean);
    const matched = terms.length ? out.filter((c) => { const h = hay(c); return terms.every((t) => h.includes(t)); }) : out;
    const groups = GROUPS.map(([level, title]) => ({ level, title, contests: matched.filter((c) => c.level === level) }))
      .filter((g) => g.contests.length);
    const beyondTop = out.some((c) => !HEADLINE_LEVELS.has(c.level) && c.office !== 'governor');
    let note = null;
    if (!sources.length) {
      note = srcs.length
        ? `Our source for ${st.name} hasn't published anything yet.`
        : `We don't have a results source for ${st.name} yet. Its official results page has every contest.`;
    } else if (!beyondTop || srcs.some((t) => t.allContests === false)) {
      // A source we only partly read (allContests:false, e.g. Alabama's first results page) always says so.
      note = `${st.name}'s source in our system publishes only the top races${srcs.some((t) => t.allContests === false) ? ' we read from it' : ''}. Its official results page has every contest.`;
    }
    return {
      election: ek, state: st.abbr, name: st.name, generatedAt: new Date().toISOString(), q: needle || null,
      total: out.length, matched: matched.length, groups, note, sources, official: officialOf(st.abbr, ek), coverageStatus: coverageStatusOf(st.abbr),
    };
  }

  /**
   * Counties that run their own results site. Their numbers are real county totals, but a handful of counties
   * is NOT the state: this never feeds the statewide entry or the national map.
   */
  function countySiteUnits(ek, abbr, race) {
    // Only the headline offices: on a county's own site, "Treasurer" is the county's treasurer, not the state's.
    if (!RACES.includes(race)) return new Map();
    const byElection = new Map();
    for (const r of q.countyRaces.all(ek, abbr, race)) {
      if (!byElection.has(r.election_id)) byElection.set(r.election_id, []);
      byElection.get(r.election_id).push(r);
    }
    const out = new Map();
    for (const races of byElection.values()) {
      // House: that county's districts combined by party. Senate/governor: the county's first contest for the office.
      const units = race === 'house' ? combineHouse(races.map(loadRace)) : loadRace(races[0]);
      const turnout = loadTurnout(races[0].snapshot_id);
      for (const [k, u] of units) {
        if (k === 'state' || out.has(k)) continue;
        out.set(k, { ...u, turnout: turnout.get(k) ?? null, ...sourceFields(races[0]) });
      }
    }
    return out;
  }

  function state(abbr, race, ek = electionsCfg().current) {
    if (race === TOP) {
      // The state's top race: the same view as asking for that office, plus which office it is and the other races.
      const t = topRace(ek, stateByAbbr(abbr).abbr);
      const out = state(abbr, t.office, ek);
      return { ...out, topOffice: t.office, statewide: { ...out.statewide, topOffice: t.office, topLabel: t.entry.topLabel, otherRaces: t.entry.otherRaces } };
    }
    const { entry, counties: stateCounties, turnout, methods, photos } = stateRace(ek, abbr, race);
    const known = new Map(countiesOf(entry.state).map((c) => [c.fips, c.name]));
    let counties = stateCounties;
    let countyData = 'no-source';
    let countyNote = null;
    const hasStatewide = entry.status === 'reporting' || entry.status === 'awaiting';
    const sites = entry.status === 'no-source' || (hasStatewide && !stateCounties?.size) ? countySiteUnits(ek, entry.state, race) : null;
    // With a statewide source, county sites only fill in counties the state actually has (they must agree with its list).
    if (sites && hasStatewide) for (const k of [...sites.keys()]) if (!known.has(k)) sites.delete(k);
    const n = sites?.size ?? 0;
    const publish = `${n} ${n === 1 ? 'county publishes its' : 'counties publish their'} own results`;
    if (n && hasStatewide) {
      counties = sites;
      countyData = 'partial';
      countyNote = `${entry.name}'s statewide source doesn't publish county results. ${publish}, shown here; the statewide totals come only from the statewide source.`;
    } else if (n) {
      counties = sites;
      countyData = 'partial';
      countyNote = `${entry.name} has no statewide results feed we can read yet. ${publish}, shown here; these are not statewide totals.`;
    } else if (entry.status === 'no-race') {
      countyData = 'unavailable';
      countyNote = `There is no ${labelOf(race)} race on this state's ballot in our sources.`;
    } else if (entry.status === 'no-source') {
      countyNote = `No live results for ${entry.name} here yet; its official results page has them.`;
    } else if (counties?.size) {
      countyData = 'available';
    } else {
      countyData = 'unavailable';
      countyNote = `County results aren't available from ${entry.name}'s source; showing statewide totals.`;
    }
    const st = turnout?.get('state') ?? null;
    return {
      election: ek,
      state: entry.state, fips: entry.fips, name: entry.name, race, office: race, officeLabel: officeLabel(race), status: entry.status,
      official: entry.official ?? null,
      statewide: { ...entry, turnout: st, methods },
      countyData, countyNote,
      counties: [...(counties ?? new Map()).values()].map((u) => ({
        fips: u.fips, name: known.get(u.fips) ?? u.name, ...withPhotos(summarize(u.candidates, u.pct, entry.voteFor ?? 1), countyData === 'available' ? photos : null),
        ...(race === 'house' ? { partySum: true } : {}),
        precinctsReporting: u.pr ?? null, precinctsTotal: u.pt ?? null,
        turnout: u.turnout !== undefined ? u.turnout : turnout?.get(u.fips) ?? null,
        methods: methodsOut(u.methods),
        ...(countyData === 'partial' ? { source: u.source, sourceName: u.sourceName, sourceUrl: u.sourceUrl, fetchedAt: u.fetchedAt } : {}),
      })),
    };
  }

  /** A summary with the contest's photo decision applied to its candidates. */
  function withPhotos(sum, decision) {
    return decision ? { ...sum, candidates: attachPhotos(sum.candidates, decision) } : sum;
  }

  function measures(abbr, ek = electionsCfg().current) {
    const st = abbr ? stateByAbbr(abbr)?.abbr ?? '__' : null;
    const used = new Set();
    const live = q.measures.all(ek, st, st).map((m) => {
      // Researched, official information about the measure (docs/measures-data.md), when we have it.
      const info = findMeasureInfo(ek, m.state, m.name, m.title);
      if (info) used.add(info);
      return {
        id: `${m.source}:${m.state}:${m.source_key}`,
        state: m.state,
        name: m.name,
        title: m.title ?? null,
        live: true,
        yes: m.yes,
        no: m.no,
        pctYes: m.yes + m.no > 0 ? Math.round((1000 * m.yes) / (m.yes + m.no)) / 10 : null,
        pctReporting: m.pct ?? pctOf(m.pr, m.pt),
        source: m.source,
        sourceName: adapterName(m.source),
        sourceUrl: m.url ?? null,
        sourceUpdatedAt: m.source_updated_at ?? null,
        fetchedAt: m.fetched_at,
        official: officialOf(m.state, ek),
        info: publicInfo(info, info ? statePartyNames(ek, info.state) : []),
      };
    });
    // Measures we researched but no feed of ours carries (yet): shown with their information, and honestly no counts.
    const staticOnly = measureInfoList(ek, st).filter((m) => !used.has(m)).map((m) => ({
      id: `info:${m.state}:${m.measure_id}`,
      state: m.state,
      name: m.measure_id,
      title: m.official_title?.value ?? null,
      live: false,
      yes: null, no: null, pctYes: null, pctReporting: null,
      source: null, sourceName: null, sourceUrl: null, sourceUpdatedAt: null, fetchedAt: null,
      official: officialOf(m.state, ek),
      info: publicInfo(m, statePartyNames(ek, m.state)),
    }));
    const measures = [...live, ...staticOnly].sort((a, b) => a.state.localeCompare(b.state) || Number(b.live) - Number(a.live));
    return { election: ek, measures };
  }

  function coverage(ek = electionsCfg().current) {
    const srcs = sourcesByState(ek);
    return {
      election: ek,
      generatedAt: new Date().toISOString(),
      states: STATES.map((s) => {
        const t = srcs.get(s.abbr) ?? [];
        const stateLevel = t.filter((x) => x.scope === 'state');
        const levels = [...new Set(stateLevel.flatMap((x) => x.levels ?? []))];
        if (!stateLevel.length && t.some((x) => x.scope === 'county')) levels.push('county-partial');
        return {
          state: s.abbr, fips: s.fips, name: s.name,
          sources: [...new Set(t.map((x) => x.source))],
          levels,
          coverageStatus: coverageStatusOf(s.abbr),
          races: Object.fromEntries(RACES.map((r) => [r, expectsRace(ek, s.abbr, r)])),
        };
      }),
    };
  }

  /** `{ current, elections:[{ key, name, date }] }` */
  function elections() {
    const cfg = electionsCfg();
    return { current: cfg.current, elections: cfg.elections.map(({ key, name, date }) => ({ key, name: name ?? key, date: date ?? null })) };
  }

  /** The election key a request asked for (default current), or null when it's unknown. */
  function resolveElection(key) {
    const cfg = electionsCfg();
    if (key == null || key === '') return cfg.current;
    return cfg.elections.some((e) => e.key === key) ? key : null;
  }

  return { national, state, measures, coverage, elections, resolveElection, offices, levelOfOffice, contests };
}

export const labelOf = (race) => ({ senate: 'U.S. Senate', governor: 'Governor', house: 'U.S. House' })[race] ?? officeLabel(race);
