// Turns the latest snapshots into what the API serves (docs/data-contract.md section 3). Rules that matter:
//  - "Leading" = most votes counted right now. We never call races and never say "winner".
//  - Party totals are never summed across different races. The one sum we do is the U.S. House
//    statewide popular vote: the same office across a state's districts, which is what that view means
//    (that includes the per-method House split: districts combined by party within each vote method).
//  - A state with no source says so ("no-source"); a state with no race for the office says that ("no-race").
//  - Everything is scoped to one election key (config/elections.json); data never leaks between elections.
//  - null means "the source doesn't publish this"; it is never turned into 0.
import { STATES, stateByAbbr, countiesOf } from './geo.js';
import { readConfig } from './config.js';
import { loadElections } from './elections.js';

export const RACES = ['senate', 'governor', 'house'];
const PARTIES = ['DEM', 'REP', 'OTHER'];

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object[]} adapters  the registry (id, name, targets())
 * @param {{ elections?: { current:string, elections:object[] } }} [opts]  override config/elections.json (tests)
 */
export function createResults(db, adapters, opts = {}) {
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
    if (!expected) return true;
    return (expected[race] ?? []).includes(st);
  }

  const RACE_COLS = `r.id, r.name, r.title, r.district, r.source_key, r.office, e.id AS election_id, e.source, e.scope, e.state,
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
    votes: db.prepare(`SELECT c.position, c.name, c.party, c.party_raw, v.votes, u.level, u.county_fips, u.name AS unit
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
      unit(v).candidates.push({ name: v.name, party: v.party, partyRaw: v.party_raw, votes: v.votes });
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

  function summarize(candidates, pct) {
    const parties = { DEM: 0, REP: 0, OTHER: 0 };
    let total = 0;
    for (const c of candidates) {
      parties[c.party] += c.votes;
      total += c.votes;
    }
    const sorted = [...candidates].sort((a, b) => b.votes - a.votes);
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
    const base = { state: st.abbr, fips: st.fips, name: st.name };
    const empty = {
      contests: [], candidates: [], parties: { DEM: 0, REP: 0, OTHER: 0 }, totalVotes: 0, leader: null, tied: false, marginPts: null,
      pctReporting: null, precinctsReporting: null, precinctsTotal: null, ballotsCast: null,
    };
    const stateSources = (srcs.get(st.abbr) ?? []).filter((t) => t.scope === 'state');
    const races = oneElection(q.races.all(ek, st.abbr, race));

    if (!races.length) {
      // A configured source that hasn't produced data yet is still "no data", but not "no race".
      const hasLiveSource = stateSources.length > 0 && q.liveStateSource.get(ek, st.abbr);
      const status = hasLiveSource ? 'no-race' : expectsRace(ek, st.abbr, race) ? 'no-source' : 'no-race';
      return {
        entry: { ...base, status, hasCountyData: false, ...empty, ...sourceFields(null, stateSources[0]) },
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
      // never summed. The first is the headline; the rest are listed separately.
      const [first, ...rest] = races;
      units = loadRace(first);
      contests = [first.name];
      otherContests = rest.map((r) => {
        const u = loadRace(r).get('state');
        return { name: r.name, ...summarize(u?.candidates ?? [], u?.pct), precinctsReporting: u?.pr ?? null, precinctsTotal: u?.pt ?? null };
      });
    }
    const turnout = loadTurnout(races[0].snapshot_id);
    const sw = units.get('state');
    const s = summarize(sw?.candidates ?? [], sw?.pct);
    const counties = new Map([...units].filter(([k]) => k !== 'state'));
    const entry = {
      ...base,
      status: s.totalVotes > 0 ? 'reporting' : 'awaiting',
      hasCountyData: counties.size > 0,
      contests,
      ...s,
      ...(otherContests.length ? { otherContests } : {}),
      precinctsReporting: sw?.pr ?? null,
      precinctsTotal: sw?.pt ?? null,
      ballotsCast: turnout.get('state')?.ballotsCast ?? null,
      ...sourceFields(races[0]),
    };
    return { entry, counties, turnout, methods: methodsOut(sw?.methods) };
  }

  function national(race, ek = electionsCfg().current) {
    const srcs = sourcesByState(ek);
    return {
      election: ek,
      race,
      generatedAt: new Date().toISOString(),
      states: STATES.map((s) => stateRace(ek, s.abbr, race, srcs).entry),
    };
  }

  /**
   * Counties that run their own results site. Their numbers are real county totals, but a handful of counties
   * is NOT the state: this never feeds the statewide entry or the national map.
   */
  function countySiteUnits(ek, abbr, race) {
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
    const { entry, counties: stateCounties, turnout, methods } = stateRace(ek, abbr, race);
    const known = new Map(countiesOf(entry.state).map((c) => [c.fips, c.name]));
    let counties = stateCounties;
    let countyData = 'no-source';
    let countyNote = null;
    const hasStatewide = entry.status === 'reporting' || entry.status === 'awaiting';
    const sites = entry.status === 'no-source' || (hasStatewide && !stateCounties?.size) ? countySiteUnits(ek, entry.state, race) : null;
    // With a statewide source, county sites only fill in counties the state actually has (they must agree with its list).
    if (sites && hasStatewide) for (const k of [...sites.keys()]) if (!known.has(k)) sites.delete(k);
    const n = sites?.size ?? 0;
    const publish = `${n} ${n === 1 ? 'county publishes' : 'counties publish'} their own results`;
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
      countyNote = `We don't have a results source for ${entry.name} yet, so there are no numbers to show.`;
    } else if (counties?.size) {
      countyData = 'available';
    } else {
      countyData = 'unavailable';
      countyNote = `County results aren't available from ${entry.name}'s source; showing statewide totals.`;
    }
    const st = turnout?.get('state') ?? null;
    return {
      election: ek,
      state: entry.state, fips: entry.fips, name: entry.name, race, status: entry.status,
      statewide: { ...entry, turnout: st, methods },
      countyData, countyNote,
      counties: [...(counties ?? new Map()).values()].map((u) => ({
        fips: u.fips, name: known.get(u.fips) ?? u.name, ...summarize(u.candidates, u.pct),
        precinctsReporting: u.pr ?? null, precinctsTotal: u.pt ?? null,
        turnout: u.turnout !== undefined ? u.turnout : turnout?.get(u.fips) ?? null,
        methods: methodsOut(u.methods),
        ...(countyData === 'partial' ? { source: u.source, sourceName: u.sourceName, sourceUrl: u.sourceUrl, fetchedAt: u.fetchedAt } : {}),
      })),
    };
  }

  function measures(abbr, ek = electionsCfg().current) {
    const st = abbr ? stateByAbbr(abbr)?.abbr ?? '__' : null;
    return {
      election: ek,
      measures: q.measures.all(ek, st, st).map((m) => ({
        id: `${m.source}:${m.state}:${m.source_key}`,
        state: m.state,
        name: m.name,
        title: m.title ?? null,
        yes: m.yes,
        no: m.no,
        pctYes: m.yes + m.no > 0 ? Math.round((1000 * m.yes) / (m.yes + m.no)) / 10 : null,
        pctReporting: m.pct ?? pctOf(m.pr, m.pt),
        source: m.source,
        sourceName: adapterName(m.source),
        sourceUrl: m.url ?? null,
        sourceUpdatedAt: m.source_updated_at ?? null,
        fetchedAt: m.fetched_at,
      })),
    };
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

  return { national, state, measures, coverage, elections, resolveElection };
}

export const labelOf = (race) => ({ senate: 'U.S. Senate', governor: 'Governor', house: 'U.S. House' })[race] ?? race;
