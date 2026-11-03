// Turns the latest snapshots into what the API serves. Rules that matter:
//  - "Leading" = most votes counted right now. We never call races and never say "winner".
//  - Party totals are never summed across different races. The one sum we do is the U.S. House
//    statewide popular vote: the same office across a state's districts, which is what that view means.
//  - A state with no source says so ("no-source"); a state with no race for the office says that ("no-race").
import { STATES, stateByAbbr, countiesOf } from './geo.js';
import { readConfig } from './config.js';

export const RACES = ['senate', 'governor', 'house'];
const PARTIES = ['DEM', 'REP', 'OTHER'];

export function createResults(db, adapters) {
  const expected = readConfig('races-2026.json', { senate: [], governor: [] });
  const expectsRace = (st, race) => (race === 'house' ? st !== 'DC' : (expected[race] ?? []).includes(st));

  const q = {
    races: db.prepare(`SELECT r.id, r.name, r.district, r.source_key, r.office, e.source, e.scope, e.state,
        l.snapshot_id, l.fetched_at, l.checked_at
      FROM races r JOIN elections e ON e.id = r.election_id JOIN latest_snapshot l ON l.election_id = e.id
      WHERE r.state = ? AND r.office = ? AND e.scope = 'state'
        AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = l.snapshot_id AND x.race_id = r.id)
      ORDER BY CAST(r.source_key AS INTEGER), r.source_key`),
    countyRaces: db.prepare(`SELECT r.id, r.name, r.district, r.source_key, r.office, e.id AS election_id, e.source, e.county_fips,
        l.snapshot_id, l.fetched_at, l.checked_at
      FROM races r JOIN elections e ON e.id = r.election_id JOIN latest_snapshot l ON l.election_id = e.id
      WHERE r.state = ? AND r.office = ? AND e.scope = 'county'
        AND EXISTS (SELECT 1 FROM unit_reporting x WHERE x.snapshot_id = l.snapshot_id AND x.race_id = r.id)
      ORDER BY e.county_fips, CAST(r.source_key AS INTEGER)`),
    votes: db.prepare(`SELECT c.position, c.name, c.party, c.party_raw, v.votes, u.level, u.county_fips, u.name AS unit
      FROM vote_counts v JOIN candidates c ON c.id = v.candidate_id JOIN reporting_units u ON u.id = v.unit_id
      WHERE v.snapshot_id = ? AND v.race_id = ? ORDER BY c.position`),
    reporting: db.prepare(`SELECT u.level, u.county_fips, u.name AS unit, x.precincts_reporting pr, x.precincts_total pt, x.pct_reporting pct
      FROM unit_reporting x JOIN reporting_units u ON u.id = x.unit_id WHERE x.snapshot_id = ? AND x.race_id = ?`),
    measures: db.prepare(`SELECT r.id, r.name, r.state, r.source_key, e.source, l.snapshot_id, l.fetched_at, m.yes, m.no, x.pct_reporting pct
      FROM races r JOIN elections e ON e.id = r.election_id JOIN latest_snapshot l ON l.election_id = e.id
      JOIN reporting_units u ON u.state = r.state AND u.level = 'state' AND u.county_fips = ''
      JOIN measure_counts m ON m.snapshot_id = l.snapshot_id AND m.race_id = r.id AND m.unit_id = u.id
      LEFT JOIN unit_reporting x ON x.snapshot_id = l.snapshot_id AND x.race_id = r.id AND x.unit_id = u.id
      WHERE r.office = 'measure' AND r.statewide = 1 AND e.scope = 'state' AND (? IS NULL OR r.state = ?)
      ORDER BY r.state, CAST(r.source_key AS INTEGER)`),
  };

  /** Which states have a configured state-scope source, from the adapters themselves. */
  function sourcesByState() {
    const m = new Map();
    for (const a of adapters) {
      for (const t of a.targets()) {
        if (!m.has(t.state)) m.set(t.state, []);
        m.get(t.state).push({ source: a.id, ...t });
      }
    }
    return m;
  }

  /** Load one race's latest numbers, grouped by unit key ('state' or county FIPS). */
  function loadRace(r) {
    const units = new Map();
    const unit = (row) => {
      const k = row.level === 'state' ? 'state' : row.county_fips;
      if (!units.has(k)) units.set(k, { level: row.level, fips: row.county_fips, name: row.unit, candidates: [], pr: null, pt: null, pct: null });
      return units.get(k);
    };
    for (const v of q.votes.all(r.snapshot_id, r.id)) {
      unit(v).candidates.push({ name: v.name, party: v.party, partyRaw: v.party_raw, votes: v.votes });
    }
    for (const x of q.reporting.all(r.snapshot_id, r.id)) {
      const pct = x.pct ?? (x.pt ? Math.round((1000 * (x.pr ?? 0)) / x.pt) / 10 : null);
      Object.assign(unit(x), { pr: x.pr, pt: x.pt, pct });
    }
    return units;
  }

  /** Combine a state's House districts into per-party candidate rows, per unit. */
  function combineHouse(raceUnits) {
    const out = new Map();
    for (const units of raceUnits) {
      for (const [k, u] of units) {
        if (!out.has(k)) out.set(k, { ...u, byParty: { DEM: 0, REP: 0, OTHER: 0 }, pr: 0, pt: 0, contests: 0 });
        const o = out.get(k);
        for (const c of u.candidates) o.byParty[c.party] += c.votes;
        o.pr += u.pr ?? 0;
        o.pt += u.pt ?? 0;
        o.contests += 1;
      }
    }
    for (const o of out.values()) {
      o.candidates = PARTIES.filter((p) => o.byParty[p] > 0 || p !== 'OTHER')
        .map((p) => ({ name: `${p} candidates, all districts`, party: p, partyRaw: p, votes: o.byParty[p] }));
      o.pct = o.pt ? Math.round((1000 * o.pr) / o.pt) / 10 : null;
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
   * One state's view of a race: statewide entry + county units.
   * @returns {{ entry:object, counties:Map|null }}
   */
  function stateRace(abbr, race, srcs = sourcesByState()) {
    const st = stateByAbbr(abbr);
    const base = { state: st.abbr, fips: st.fips, name: st.name };
    const empty = { contests: [], candidates: [], parties: { DEM: 0, REP: 0, OTHER: 0 }, totalVotes: 0, leader: null, marginPts: null, pctReporting: null, source: null, fetchedAt: null, checkedAt: null };
    const stateSources = (srcs.get(st.abbr) ?? []).filter((t) => t.scope === 'state');
    const races = q.races.all(st.abbr, race);

    if (!races.length) {
      // A configured source that hasn't produced data yet is still "no data", but not "no race".
      const hasLiveSource = stateSources.length > 0 && db.prepare(`SELECT 1 FROM elections e JOIN latest_snapshot l ON l.election_id = e.id
        WHERE e.state = ? AND e.scope = 'state'`).get(st.abbr);
      const status = hasLiveSource ? 'no-race' : expectsRace(st.abbr, race) ? 'no-source' : 'no-race';
      return { entry: { ...base, status, hasCountyData: false, ...empty, source: stateSources[0]?.source ?? null }, counties: null };
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
        return { name: r.name, ...summarize(u?.candidates ?? [], u?.pct) };
      });
    }
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
      source: races[0].source,
      fetchedAt: races[0].fetched_at,
      checkedAt: races[0].checked_at,
    };
    return { entry, counties };
  }

  function national(race) {
    const srcs = sourcesByState();
    return {
      race,
      generatedAt: new Date().toISOString(),
      states: STATES.map((s) => stateRace(s.abbr, race, srcs).entry),
    };
  }

  /**
   * Counties that run their own results site in a state without a statewide feed. Their numbers are real
   * county totals, but a handful of counties is NOT the state: this never feeds the statewide entry.
   */
  function countySiteUnits(abbr, race) {
    const byElection = new Map();
    for (const r of q.countyRaces.all(abbr, race)) {
      if (!byElection.has(r.election_id)) byElection.set(r.election_id, []);
      byElection.get(r.election_id).push(r);
    }
    const out = new Map();
    for (const races of byElection.values()) {
      // House: that county's districts combined by party. Senate/governor: the county's first contest for the office.
      const units = race === 'house' ? combineHouse(races.map(loadRace)) : loadRace(races[0]);
      for (const [k, u] of units) if (k !== 'state') out.set(k, { ...u, source: races[0].source, fetchedAt: races[0].fetched_at });
    }
    return out;
  }

  function state(abbr, race) {
    const { entry, counties: stateCounties } = stateRace(abbr, race);
    let counties = stateCounties;
    let countyData = 'no-source';
    let countyNote = null;
    const partial = entry.status === 'no-source' ? countySiteUnits(entry.state, race) : null;
    if (partial?.size) {
      counties = partial;
      countyData = 'partial';
      countyNote = `${entry.name} has no statewide results feed we can read yet. ${partial.size} ${partial.size === 1 ? 'county publishes' : 'counties publish'} their own results, shown here; these are not statewide totals.`;
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
    const known = new Map(countiesOf(entry.state).map((c) => [c.fips, c.name]));
    return {
      state: entry.state, fips: entry.fips, name: entry.name, race, status: entry.status,
      statewide: entry, countyData, countyNote,
      counties: [...(counties ?? new Map()).values()].map((u) => ({
        fips: u.fips, name: known.get(u.fips) ?? u.name, ...summarize(u.candidates, u.pct),
      })),
    };
  }

  function measures(abbr) {
    const st = abbr ? stateByAbbr(abbr)?.abbr ?? '__' : null;
    return {
      measures: q.measures.all(st, st).map((m) => ({
        id: `${m.source}:${m.state}:${m.source_key}`,
        state: m.state,
        name: m.name,
        yes: m.yes,
        no: m.no,
        pctYes: m.yes + m.no > 0 ? Math.round((1000 * m.yes) / (m.yes + m.no)) / 10 : null,
        pctReporting: m.pct,
        source: m.source,
        fetchedAt: m.fetched_at,
      })),
    };
  }

  function coverage() {
    const srcs = sourcesByState();
    return {
      generatedAt: new Date().toISOString(),
      states: STATES.map((s) => {
        const t = srcs.get(s.abbr) ?? [];
        const stateLevel = t.filter((x) => x.scope === 'state');
        const levels = [...new Set(stateLevel.flatMap((x) => x.levels))];
        if (!stateLevel.length && t.some((x) => x.scope === 'county')) levels.push('county-partial');
        return {
          state: s.abbr, fips: s.fips, name: s.name,
          sources: [...new Set(t.map((x) => x.source))],
          levels,
          races: Object.fromEntries(RACES.map((r) => [r, expectsRace(s.abbr, r)])),
        };
      }),
    };
  }

  return { national, state, measures, coverage };
}

export const labelOf = (race) => ({ senate: 'U.S. Senate', governor: 'Governor', house: 'U.S. House' })[race] ?? race;
