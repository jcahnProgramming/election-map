// SQLite store. Results are APPEND-ONLY: every fetch that brings new numbers writes a new snapshot,
// and nothing is ever updated in place. `latest_snapshot` points each election at its newest snapshot,
// which is what the API serves. Older snapshots stay for change-over-time views later.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { currentElectionKey } from './elections.js';
import { methodBucket } from './normalize.js';

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
-- v0.2: election-wide turnout per reporting unit (not per race). NULL = the source doesn't publish it.
CREATE TABLE IF NOT EXISTS unit_turnout (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  unit_id     INTEGER NOT NULL,
  registered          INTEGER,
  ballots_cast        INTEGER,
  turnout_pct         REAL,               -- 0–100 as the source states it
  ballots_outstanding INTEGER,
  precincts_reporting INTEGER,
  precincts_total     INTEGER,
  source      TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, unit_id)
) WITHOUT ROWID;
-- v0.2: votes per vote method (Election Day / Mail / Provisional ...). choice_pos = candidates.position for
-- candidate races; for measures 0 = yes, 1 = no.
CREATE TABLE IF NOT EXISTS method_counts (
  snapshot_id   INTEGER NOT NULL REFERENCES snapshots(id),
  race_id       INTEGER NOT NULL,
  unit_id       INTEGER NOT NULL,
  choice_pos    INTEGER NOT NULL,
  method_raw    TEXT NOT NULL,            -- the source's label, verbatim
  method_bucket TEXT NOT NULL,            -- 'mail_early'|'election_day'|'provisional'|'other'
  method_order  INTEGER NOT NULL DEFAULT 0, -- the source's order of methods
  votes         INTEGER,
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, race_id, unit_id, choice_pos, method_raw)
) WITHOUT ROWID;
`;

// Additive column migrations for databases created by 0.1. Idempotent: a column is added only when missing.
const COLUMNS = [
  ['elections', 'election_key', 'TEXT'],
  ['snapshots', 'source_updated_at', 'TEXT'],
  ['races', 'title', 'TEXT'],
];

function migrate(db) {
  for (const [table, col, type] of COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!have) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  // 0.1 rows predate election keys: they all belong to the election that was current when 0.2 shipped.
  // This fills a NULL once (election metadata, not result rows) so a later change of `current` can't move them.
  db.prepare('UPDATE elections SET election_key = ? WHERE election_key IS NULL').run(currentElectionKey());
  db.exec('CREATE INDEX IF NOT EXISTS elections_by_key ON elections (election_key, state, scope)');
}

export function openDb(file = path.join(config.dataDir, 'election-map.db')) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const int = (x) => (num(x) == null ? null : Math.round(Number(x)));

/**
 * Persist one normalized result set from an adapter as a new snapshot (docs/data-contract.md section 1).
 * Missing optional values are stored as NULL, never 0.
 * @param {import('better-sqlite3').Database} db
 * @param {object} r  { source, fetchedAt, election, version, sourceUpdatedAt?, turnout?, races[] }
 * @returns {number} snapshot id
 */
export function writeSnapshot(db, r) {
  const st = prepared(db);
  return db.transaction(() => {
    const now = r.fetchedAt;
    const e = r.election;
    const electionKey = e.electionKey ?? r.electionKey ?? currentElectionKey();
    st.upsertElection.run({
      sourceKey: e.sourceKey, state: e.state, scope: e.scope, name: e.name ?? null, date: e.date ?? null, url: e.url ?? null,
      source: r.source, county_fips: e.countyFips ?? null, first_seen: now, election_key: electionKey,
    });
    const er = st.electionId.get(r.source, e.sourceKey);
    if (er.election_key !== electionKey) {
      // (source, source_key) is the identity of a source election; one key can't serve two elections.
      throw new Error(`${r.source} source key ${e.sourceKey} already belongs to election ${er.election_key}, not ${electionKey}: adapters must use a sourceKey unique per election`);
    }
    const electionId = er.id;
    const snapshotId = st.insertSnapshot.run(electionId, r.source, r.version == null ? null : String(r.version), now,
      r.sourceUpdatedAt ?? null).lastInsertRowid;
    const unitIdOf = (u) => {
      st.upsertUnit.run({ state: e.state, level: u.level, county_fips: u.countyFips ?? '', name: u.name ?? e.state });
      return st.unitId.get(e.state, u.level, u.countyFips ?? '').id;
    };

    const turnoutSeen = new Set();
    for (const t of r.turnout ?? []) {
      const unitId = unitIdOf(t);
      if (turnoutSeen.has(unitId)) continue; // one row per unit; a duplicate is an adapter bug, keep the first
      turnoutSeen.add(unitId);
      st.insertTurnout.run(snapshotId, unitId, int(t.registered), int(t.ballotsCast), num(t.turnoutPct), int(t.ballotsOutstanding),
        int(t.precinctsReporting), int(t.precinctsTotal), r.source, now);
    }

    for (const race of r.races ?? []) {
      if (race?.key == null || !race.office || !race.name) continue; // malformed contest: skip it, keep the rest
      st.upsertRace.run({
        election_id: electionId, state: e.state, office: race.office, district: race.district ?? null,
        name: race.name, source_key: race.key, vote_for: race.voteFor ?? null, statewide: race.statewide === false ? 0 : 1,
        title: race.title ?? null,
      });
      const raceId = st.raceId.get(electionId, race.key).id;
      const candIds = (race.choices ?? []).map((c, position) => {
        st.upsertCandidate.run({ race_id: raceId, name: c.name, party: c.party, party_raw: c.partyRaw ?? '', position });
        return st.candidateId.get(raceId, position).id;
      });
      const unitsSeen = new Set();
      for (const u of race.units ?? []) {
        if (!u) continue;
        const unitId = unitIdOf(u);
        if (unitsSeen.has(unitId)) continue; // a unit listed twice is an adapter bug: keep the first, never lose the snapshot
        unitsSeen.add(unitId);
        if (race.office === 'measure') {
          st.insertMeasure.run(snapshotId, raceId, unitId, int(u.yes) ?? 0, int(u.no) ?? 0, r.source, now);
        } else {
          // Sources going from empty to populated send null / missing / string counts: tolerate all of them.
          (Array.isArray(u.votes) ? u.votes : []).slice(0, candIds.length)
            .forEach((v, i) => st.insertVotes.run(snapshotId, raceId, unitId, candIds[i], int(v) ?? 0, r.source, now));
        }
        st.insertReporting.run(snapshotId, raceId, unitId, int(u.precinctsReporting), int(u.precinctsTotal),
          num(u.pctReporting), r.source, now);
        (u.methods ?? []).forEach((m, order) => {
          if (m?.label == null) return;
          const label = String(m.label);
          const bucket = m.bucket ?? methodBucket(label);
          const n = race.office === 'measure' ? 2 : candIds.length;
          for (let pos = 0; pos < n; pos++) {
            st.insertMethod.run(snapshotId, raceId, unitId, pos, label, bucket, order, int(m.votes?.[pos]), r.source, now);
          }
        });
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
    upsertElection: db.prepare(`INSERT INTO elections (source, source_key, state, county_fips, scope, name, date, url, first_seen, election_key)
      VALUES (@source, @sourceKey, @state, @county_fips, @scope, @name, @date, @url, @first_seen, @election_key)
      ON CONFLICT (source, source_key) DO UPDATE SET name = excluded.name, date = excluded.date, url = excluded.url`),
    electionId: db.prepare('SELECT id, election_key FROM elections WHERE source = ? AND source_key = ?'),
    insertSnapshot: db.prepare('INSERT INTO snapshots (election_id, source, source_version, fetched_at, source_updated_at) VALUES (?,?,?,?,?)'),
    upsertRace: db.prepare(`INSERT INTO races (election_id, state, office, district, name, source_key, vote_for, statewide, title)
      VALUES (@election_id, @state, @office, @district, @name, @source_key, @vote_for, @statewide, @title)
      ON CONFLICT (election_id, source_key) DO UPDATE SET name = excluded.name, office = excluded.office,
        district = excluded.district, vote_for = excluded.vote_for, statewide = excluded.statewide,
        title = COALESCE(excluded.title, races.title)`),
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
    insertTurnout: db.prepare(`INSERT INTO unit_turnout (snapshot_id, unit_id, registered, ballots_cast, turnout_pct, ballots_outstanding,
      precincts_reporting, precincts_total, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    insertMethod: db.prepare(`INSERT OR IGNORE INTO method_counts (snapshot_id, race_id, unit_id, choice_pos, method_raw, method_bucket,
      method_order, votes, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    setLatest: db.prepare(`INSERT INTO latest_snapshot (election_id, snapshot_id, fetched_at, checked_at) VALUES (?,?,?,?)
      ON CONFLICT (election_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at`),
  };
  cache.set(db, p);
  return p;
}
