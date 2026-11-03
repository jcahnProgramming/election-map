// SQLite store. Results are APPEND-ONLY: every fetch that brings new numbers writes a new snapshot,
// and nothing is ever updated in place. `latest_snapshot` points each election at its newest snapshot,
// which is what the API serves. Older snapshots stay for change-over-time views later.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS elections (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,               -- adapter id
  source_key  TEXT NOT NULL,               -- adapter's own id for this election (e.g. Clarity "CO/127407")
  state       TEXT NOT NULL,               -- USPS abbreviation
  county_fips TEXT,                        -- set when the source covers a single county
  scope       TEXT NOT NULL CHECK (scope IN ('state','county')),
  name        TEXT,
  date        TEXT,
  url         TEXT,
  first_seen  TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE TABLE IF NOT EXISTS races (
  id          INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  state       TEXT NOT NULL,
  office      TEXT NOT NULL CHECK (office IN ('senate','governor','house','measure')),
  district    TEXT,                        -- house district number, 'AL' for at-large
  name        TEXT NOT NULL,               -- contest name as the source gives it
  source_key  TEXT NOT NULL,               -- source's contest id
  vote_for    INTEGER,
  statewide   INTEGER NOT NULL DEFAULT 1,  -- 0 for local measures that appear in a statewide feed
  UNIQUE (election_id, source_key)
);
CREATE TABLE IF NOT EXISTS reporting_units (
  id          INTEGER PRIMARY KEY,
  state       TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('state','county')),
  county_fips TEXT NOT NULL DEFAULT '',    -- '' for the statewide unit
  name        TEXT NOT NULL,
  UNIQUE (state, level, county_fips)
);
CREATE TABLE IF NOT EXISTS candidates (
  id          INTEGER PRIMARY KEY,
  race_id     INTEGER NOT NULL REFERENCES races(id),
  name        TEXT NOT NULL,
  party       TEXT NOT NULL CHECK (party IN ('DEM','REP','OTHER')),
  party_raw   TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL,
  UNIQUE (race_id, position)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY,
  election_id INTEGER NOT NULL REFERENCES elections(id),
  source      TEXT NOT NULL,
  source_version TEXT,                     -- e.g. Clarity's current_ver
  fetched_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vote_counts (
  snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
  race_id      INTEGER NOT NULL,
  unit_id      INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  votes        INTEGER NOT NULL,
  source       TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, race_id, unit_id, candidate_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS measure_counts (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  race_id     INTEGER NOT NULL,
  unit_id     INTEGER NOT NULL,
  yes         INTEGER NOT NULL,
  no          INTEGER NOT NULL,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, race_id, unit_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS unit_reporting (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  race_id     INTEGER NOT NULL,
  unit_id     INTEGER NOT NULL,
  precincts_reporting INTEGER,
  precincts_total     INTEGER,
  pct_reporting       REAL,               -- 0–100, null when the source doesn't say
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, race_id, unit_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS latest_snapshot (
  election_id INTEGER PRIMARY KEY REFERENCES elections(id),
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  fetched_at  TEXT NOT NULL,
  checked_at  TEXT NOT NULL                -- last successful fetch, even when nothing changed
);
CREATE TABLE IF NOT EXISTS unmatched (
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,                -- 'county' | 'party'
  value      TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source, kind, value, context)
);
`;

export function openDb(file = path.join(config.dataDir, 'election-map.db')) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Persist one normalized result set from an adapter as a new snapshot.
 * @param {import('better-sqlite3').Database} db
 * @param {object} r  see adapters/README in CLAUDE.md: { source, election, version, fetchedAt, races[] }
 * @returns {number} snapshot id
 */
export function writeSnapshot(db, r) {
  const st = prepared(db);
  return db.transaction(() => {
    const now = r.fetchedAt;
    const e = r.election;
    st.upsertElection.run({
      sourceKey: e.sourceKey, state: e.state, scope: e.scope, name: e.name ?? null, date: e.date ?? null, url: e.url ?? null,
      source: r.source, county_fips: e.countyFips ?? null, first_seen: now,
    });
    const electionId = st.electionId.get(r.source, e.sourceKey).id;
    const snapshotId = st.insertSnapshot.run(electionId, r.source, r.version ?? null, now).lastInsertRowid;

    for (const race of r.races) {
      st.upsertRace.run({
        election_id: electionId, state: e.state, office: race.office, district: race.district ?? null,
        name: race.name, source_key: race.key, vote_for: race.voteFor ?? null, statewide: race.statewide === false ? 0 : 1,
      });
      const raceId = st.raceId.get(electionId, race.key).id;
      const candIds = race.choices.map((c, position) => {
        st.upsertCandidate.run({ race_id: raceId, name: c.name, party: c.party, party_raw: c.partyRaw ?? '', position });
        return st.candidateId.get(raceId, position).id;
      });
      for (const u of race.units) {
        st.upsertUnit.run({ state: e.state, level: u.level, county_fips: u.countyFips ?? '', name: u.name });
        const unitId = st.unitId.get(e.state, u.level, u.countyFips ?? '').id;
        if (race.office === 'measure') {
          st.insertMeasure.run(snapshotId, raceId, unitId, u.yes ?? 0, u.no ?? 0, r.source, now);
        } else {
          u.votes.forEach((v, i) => st.insertVotes.run(snapshotId, raceId, unitId, candIds[i], v ?? 0, r.source, now));
        }
        st.insertReporting.run(snapshotId, raceId, unitId, u.precinctsReporting ?? null, u.precinctsTotal ?? null,
          u.pctReporting ?? null, r.source, now);
      }
    }
    st.setLatest.run(electionId, snapshotId, now, now);
    return Number(snapshotId);
  })();
}

/** A fetch that succeeded but brought nothing new: just record when we last checked. */
export function markChecked(db, source, sourceKey, at) {
  db.prepare(`UPDATE latest_snapshot SET checked_at = ? WHERE election_id =
    (SELECT id FROM elections WHERE source = ? AND source_key = ?)`).run(at, source, sourceKey);
}

export function recordUnmatched(db, { source, kind, value, context = '' }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO unmatched (source, kind, value, context, first_seen, last_seen) VALUES (?,?,?,?,?,?)
    ON CONFLICT (source, kind, value, context) DO UPDATE SET last_seen = excluded.last_seen, seen_count = seen_count + 1`)
    .run(source, kind, String(value), context, now, now);
}

const cache = new WeakMap();
function prepared(db) {
  if (cache.has(db)) return cache.get(db);
  const p = {
    upsertElection: db.prepare(`INSERT INTO elections (source, source_key, state, county_fips, scope, name, date, url, first_seen)
      VALUES (@source, @sourceKey, @state, @county_fips, @scope, @name, @date, @url, @first_seen)
      ON CONFLICT (source, source_key) DO UPDATE SET name = excluded.name, date = excluded.date, url = excluded.url`),
    electionId: db.prepare('SELECT id FROM elections WHERE source = ? AND source_key = ?'),
    insertSnapshot: db.prepare('INSERT INTO snapshots (election_id, source, source_version, fetched_at) VALUES (?,?,?,?)'),
    upsertRace: db.prepare(`INSERT INTO races (election_id, state, office, district, name, source_key, vote_for, statewide)
      VALUES (@election_id, @state, @office, @district, @name, @source_key, @vote_for, @statewide)
      ON CONFLICT (election_id, source_key) DO UPDATE SET name = excluded.name, office = excluded.office,
        district = excluded.district, vote_for = excluded.vote_for, statewide = excluded.statewide`),
    raceId: db.prepare('SELECT id FROM races WHERE election_id = ? AND source_key = ?'),
    upsertCandidate: db.prepare(`INSERT INTO candidates (race_id, name, party, party_raw, position)
      VALUES (@race_id, @name, @party, @party_raw, @position)
      ON CONFLICT (race_id, position) DO UPDATE SET name = excluded.name, party = excluded.party, party_raw = excluded.party_raw`),
    candidateId: db.prepare('SELECT id FROM candidates WHERE race_id = ? AND position = ?'),
    upsertUnit: db.prepare(`INSERT INTO reporting_units (state, level, county_fips, name) VALUES (@state, @level, @county_fips, @name)
      ON CONFLICT (state, level, county_fips) DO NOTHING`),
    unitId: db.prepare('SELECT id FROM reporting_units WHERE state = ? AND level = ? AND county_fips = ?'),
    insertVotes: db.prepare('INSERT INTO vote_counts VALUES (?,?,?,?,?,?,?)'),
    insertMeasure: db.prepare('INSERT INTO measure_counts VALUES (?,?,?,?,?,?,?)'),
    insertReporting: db.prepare('INSERT INTO unit_reporting VALUES (?,?,?,?,?,?,?,?)'),
    setLatest: db.prepare(`INSERT INTO latest_snapshot (election_id, snapshot_id, fetched_at, checked_at) VALUES (?,?,?,?)
      ON CONFLICT (election_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at`),
  };
  cache.set(db, p);
  return p;
}
