import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const adapter = {
  id: 'fake', name: 'fake', fetch: async () => ({ changed: false }),
  targets: () => [
    { key: 'CO/1', state: 'CO', scope: 'state', levels: ['state', 'county'] },
    { key: 'TX/Denton/1', state: 'TX', scope: 'county', countyFips: '48121', levels: ['county'] },
  ],
};
const cand = (name, party) => ({ name, party, partyRaw: party });
const unit = (votes, extra = {}) => ({ level: 'state', name: 'CO', votes, precinctsReporting: 50, precinctsTotal: 100, ...extra });
const county = (fips, name, votes) => ({ level: 'county', countyFips: fips, name, votes, precinctsReporting: 1, precinctsTotal: 1 });

function seed() {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'CO/1', state: 'CO', scope: 'state', name: 'CO' },
    races: [
      { office: 'senate', key: '20', name: 'United States Senator', choices: [cand('R', 'REP'), cand('D', 'DEM'), cand('L', 'OTHER')],
        units: [unit([4000, 5000, 1000]), county('08031', 'Denver', [100, 900, 0]), county('08041', 'El Paso', [600, 390, 10])] },
      { office: 'house', key: '110', district: '1', name: 'Rep District 1', choices: [cand('d1', 'DEM'), cand('r1', 'REP')],
        units: [unit([700, 300])] },
      { office: 'house', key: '120', district: '2', name: 'Rep District 2', choices: [cand('r2', 'REP'), cand('d2', 'DEM')],
        units: [unit([550, 450])] },
      { office: 'measure', key: '6000', name: 'Amendment 81', choices: [cand('Yes/For', 'OTHER'), cand('No/Against', 'OTHER')],
        units: [{ ...unit([300, 100]), yes: 300, no: 100 }] },
    ],
  });
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'TX/Denton/1', state: 'TX', scope: 'county', countyFips: '48121', name: 'Denton' },
    races: [{ office: 'senate', key: '1', name: 'US Senator', choices: [cand('P', 'REP'), cand('T', 'DEM')],
      units: [county('48121', 'Denton County, TX', [60, 40])] }],
  });
  return createResults(db, [adapter]);
}

test('national: leader, margin in points, statuses', () => {
  const r = seed().national('senate');
  const co = r.states.find((s) => s.state === 'CO');
  assert.equal(co.status, 'reporting');
  assert.equal(co.leader, 'DEM');
  assert.equal(co.marginPts, 10); // (5000-4000)/10000
  assert.equal(co.pctReporting, 50);
  assert.equal(r.states.find((s) => s.state === 'TX').status, 'no-source'); // county sites never make a statewide total
  assert.equal(r.states.find((s) => s.state === 'IN').status, 'no-race');
  assert.equal(r.states.find((s) => s.state === 'GA').status, 'no-source');
});

test('house is the statewide popular vote across districts, by party', () => {
  const co = seed().national('house').states.find((s) => s.state === 'CO');
  assert.deepEqual(co.parties, { DEM: 1150, REP: 850, OTHER: 0 });
  assert.equal(co.leader, 'DEM');
  assert.equal(co.marginPts, 15);
});

test('state view: counties, partial county sites, measures', () => {
  const res = seed();
  const co = res.state('CO', 'senate');
  assert.equal(co.countyData, 'available');
  assert.equal(co.counties.find((c) => c.fips === '08041').leader, 'REP');
  const tx = res.state('TX', 'senate');
  assert.equal(tx.countyData, 'partial');
  assert.equal(tx.counties[0].fips, '48121');
  assert.match(tx.countyNote, /not statewide totals/);
  assert.match(tx.countyNote, /\b1 county publishes its own results\b/); // singular, not "their"
  const m = res.measures('CO').measures[0];
  assert.deepEqual([m.yes, m.no, m.pctYes], [300, 100, 75]);
});

// ---- v0.2: turnout, precincts, methods, election scoping, migration ----
const ELECTIONS = {
  current: '2026-general',
  elections: [
    { key: '2026-general', name: '2026 General Election', date: '2026-11-03', races: 'races-2026.json' },
    { key: '2028-general', name: '2028 General Election', date: '2028-11-07' },
  ],
};
const meth = (label, bucket, votes) => ({ label, bucket, votes });

function seed2() {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T03:00:00Z', version: '7', sourceUpdatedAt: '2026-11-04T02:58:00Z',
    election: { sourceKey: 'IA/1', state: 'IA', scope: 'state', name: 'IA', url: 'https://example.test/IA/1/', electionKey: '2026-general' },
    turnout: [
      { level: 'state', name: 'IA', registered: 2000, ballotsCast: 900, turnoutPct: 45, precinctsReporting: 10, precinctsTotal: 20 },
      { level: 'county', countyFips: '19001', name: 'Adair', registered: 100, ballotsCast: 60, turnoutPct: 60 },
    ],
    races: [
      { office: 'senate', key: '1000', name: 'United States Senator', choices: [cand('H', 'REP'), cand('T', 'DEM')],
        units: [
          { level: 'state', name: 'IA', votes: [500, 400], precinctsReporting: 10, precinctsTotal: 20,
            methods: [meth('Election Day', 'election_day', [300, 100]), meth('Absentee', 'mail_early', [200, 300])] },
          { level: 'county', countyFips: '19001', name: 'Adair', votes: [40, 20], precinctsReporting: 1, precinctsTotal: 2,
            methods: [meth('Election Day', 'election_day', [30, null]), meth('Absentee', 'mail_early', [10, 20])] },
        ] },
      { office: 'house', key: '1100', district: '1', name: 'Rep District 1', choices: [cand('r1', 'REP'), cand('d1', 'DEM')],
        units: [{ level: 'state', name: 'IA', votes: [100, 200], precinctsReporting: 5, precinctsTotal: 10,
          methods: [meth('Election Day', 'election_day', [60, 50]), meth('Absentee', 'mail_early', [40, 150])] }] },
      { office: 'house', key: '1200', district: '2', name: 'Rep District 2', choices: [cand('d2', 'DEM'), cand('r2', 'REP'), cand('l2', 'OTHER')],
        units: [{ level: 'state', name: 'IA', votes: [300, 250, 10], precinctsReporting: 3, precinctsTotal: 10,
          methods: [meth('Election Day', 'election_day', [100, 200, 5]), meth('Absentee', 'mail_early', [200, 50, 5])] }] },
      { office: 'measure', key: '14600', name: 'Constitutional Amendment 1', title: 'Amendment 1: right to hunt', choices: [cand('Yes', 'OTHER'), cand('No', 'OTHER')],
        units: [{ level: 'state', name: 'IA', votes: [30, 10], yes: 30, no: 10, precinctsReporting: 1, precinctsTotal: 4,
          methods: [meth('Election Day', 'election_day', [20, 5]), meth('Absentee', 'mail_early', [10, 5])] }] },
    ],
  });
  // The same state in a different election: must never show up in 2026 numbers, and vice versa.
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2028-11-08T03:00:00Z', version: '1',
    election: { sourceKey: 'IA/2028', state: 'IA', scope: 'state', name: 'IA 2028', electionKey: '2028-general' },
    races: [
      { office: 'senate', key: '1000', name: 'United States Senator', choices: [cand('X', 'REP'), cand('Y', 'DEM')],
        units: [{ level: 'state', name: 'IA', votes: [1, 9] }] },
      { office: 'measure', key: '1', name: 'Measure 2028', choices: [cand('Yes', 'OTHER'), cand('No', 'OTHER')],
        units: [{ level: 'state', name: 'IA', votes: [5, 5], yes: 5, no: 5 }] },
    ],
  });
  const iaAdapter = {
    id: 'fake', name: 'Fake Source', fetch: async () => ({ changed: false }),
    targets: () => [
      { key: 'IA/1', state: 'IA', scope: 'state', levels: ['state', 'county'], url: 'https://example.test/IA/1/' },
      { key: 'IA/2028', state: 'IA', scope: 'state', levels: ['state'], election: '2028-general' },
    ],
  };
  return { db, res: createResults(db, [iaAdapter], { elections: ELECTIONS }) };
}

test('national entry: precincts, ballotsCast, source fields', () => {
  const { res } = seed2();
  const ia = res.national('senate').states.find((s) => s.state === 'IA');
  assert.equal(ia.precinctsReporting, 10);
  assert.equal(ia.precinctsTotal, 20);
  assert.equal(ia.ballotsCast, 900);
  assert.equal(ia.sourceName, 'Fake Source');
  assert.equal(ia.sourceUrl, 'https://example.test/IA/1/');
  assert.equal(ia.sourceUpdatedAt, '2026-11-04T02:58:00Z');
  const ga = res.national('senate').states.find((s) => s.state === 'GA');
  assert.equal(ga.status, 'no-source');
  assert.equal(ga.ballotsCast, null);
  assert.equal(ga.precinctsTotal, null);
});

test('state view: statewide turnout + methods, per-county turnout + methods (null stays out of sums)', () => {
  const { res } = seed2();
  const ia = res.state('IA', 'senate');
  assert.equal(ia.election, '2026-general');
  assert.deepEqual(ia.statewide.turnout, { registered: 2000, ballotsCast: 900, turnoutPct: 45, ballotsOutstanding: null, precinctsReporting: 10, precinctsTotal: 20 });
  assert.deepEqual(ia.statewide.methods, [
    { label: 'Election Day', bucket: 'election_day', total: 400, parties: { DEM: 100, REP: 300, OTHER: 0 } },
    { label: 'Absentee', bucket: 'mail_early', total: 500, parties: { DEM: 300, REP: 200, OTHER: 0 } },
  ]);
  const adair = ia.counties.find((c) => c.fips === '19001');
  assert.equal(adair.precinctsReporting, 1);
  assert.equal(adair.precinctsTotal, 2);
  assert.equal(adair.turnout.ballotsCast, 60);
  assert.equal(adair.turnout.precinctsTotal, null);
  assert.deepEqual(adair.methods[0], { label: 'Election Day', bucket: 'election_day', total: 30, parties: { DEM: 0, REP: 30, OTHER: 0 } });
});

test('house methods: districts combined by party within each method; precincts summed', () => {
  const { res } = seed2();
  const ia = res.state('IA', 'house');
  assert.deepEqual(ia.statewide.parties, { DEM: 500, REP: 350, OTHER: 10 });
  assert.deepEqual(ia.statewide.methods, [
    { label: 'Election Day', bucket: 'election_day', total: 415, parties: { DEM: 150, REP: 260, OTHER: 5 } },
    { label: 'Absentee', bucket: 'mail_early', total: 445, parties: { DEM: 350, REP: 90, OTHER: 5 } },
  ]);
  assert.equal(ia.statewide.precinctsReporting, 8);
  assert.equal(ia.statewide.precinctsTotal, 20);
  assert.equal(ia.statewide.pctReporting, 40);
});

test('measures: title + source fields; election-scoped', () => {
  const { res } = seed2();
  const [m] = res.measures('IA').measures;
  assert.equal(m.title, 'Amendment 1: right to hunt');
  assert.equal(m.pctReporting, 25);
  assert.equal(m.sourceName, 'Fake Source');
  assert.equal(m.sourceUpdatedAt, '2026-11-04T02:58:00Z');
  const m28 = res.measures('IA', '2028-general');
  assert.equal(m28.election, '2028-general');
  assert.deepEqual(m28.measures.map((x) => x.name), ['Measure 2028']);
});

test('two elections in one DB: no leakage, election param, unknown key', () => {
  const { res } = seed2();
  const a = res.national('senate', '2026-general').states.find((s) => s.state === 'IA');
  const b = res.national('senate', '2028-general').states.find((s) => s.state === 'IA');
  assert.deepEqual(a.parties, { DEM: 400, REP: 500, OTHER: 0 });
  assert.deepEqual(b.parties, { DEM: 9, REP: 1, OTHER: 0 });
  assert.equal(b.ballotsCast, null);
  assert.equal(res.national('house', '2028-general').states.find((s) => s.state === 'IA').status, 'no-race');
  assert.equal(res.state('IA', 'senate', '2028-general').counties.length, 0);
  assert.equal(res.resolveElection(undefined), '2026-general');
  assert.equal(res.resolveElection('2028-general'), '2028-general');
  assert.equal(res.resolveElection('1999-general'), null);
  assert.deepEqual(res.elections().elections.map((e) => e.key), ['2026-general', '2028-general']);
  assert.deepEqual(res.coverage('2028-general').states.find((s) => s.state === 'IA').sources, ['fake']);
  assert.deepEqual(res.coverage('2028-general').states.find((s) => s.state === 'CO').sources, []);
});

test('a source key cannot move between elections', () => {
  const { db } = seed2();
  assert.throws(() => writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T04:00:00Z', version: '8',
    election: { sourceKey: 'IA/1', state: 'IA', scope: 'state', electionKey: '2028-general' }, races: [],
  }), /unique per election/);
});

test('county sites fill county detail for a statewide source without counties, never the statewide numbers', () => {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'TX/state', state: 'TX', scope: 'state', name: 'TX' },
    races: [{ office: 'senate', key: '1', name: 'US Senator', choices: [cand('P', 'REP'), cand('T', 'DEM')],
      units: [{ level: 'state', name: 'TX', votes: [1000, 900] }] }],
  });
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'TX/Denton/1', state: 'TX', scope: 'county', countyFips: '48121', name: 'Denton' },
    turnout: [{ level: 'county', countyFips: '48121', name: 'Denton', registered: 700, ballotsCast: 100 }],
    races: [{ office: 'senate', key: '1', name: 'US Senator', choices: [cand('P', 'REP'), cand('T', 'DEM')],
      units: [{ level: 'county', countyFips: '48121', name: 'Denton', votes: [60, 40], precinctsReporting: 3, precinctsTotal: 9,
        methods: [meth('Early', 'mail_early', [50, 30]), meth('Election', 'election_day', [10, 10])] }] }],
  });
  const res = createResults(db, [adapter], { elections: ELECTIONS });
  const tx = res.state('TX', 'senate');
  assert.equal(tx.status, 'reporting');
  assert.deepEqual(tx.statewide.parties, { DEM: 900, REP: 1000, OTHER: 0 });
  assert.equal(tx.countyData, 'partial');
  assert.match(tx.countyNote, /statewide totals come only from the statewide source/);
  assert.equal(tx.counties[0].turnout.ballotsCast, 100);
  assert.equal(tx.counties[0].methods[0].total, 80);
  assert.equal(tx.counties[0].precinctsTotal, 9);
  assert.deepEqual(res.national('senate').states.find((s) => s.state === 'TX').parties, { DEM: 900, REP: 1000, OTHER: 0 });
});

test('migration: a 0.1-shaped database upgrades in place and keeps its rows', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'em-mig-')), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE elections (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, state TEXT NOT NULL, county_fips TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('state','county')), name TEXT, date TEXT, url TEXT, first_seen TEXT NOT NULL, UNIQUE (source, source_key));
    CREATE TABLE races (id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES elections(id), state TEXT NOT NULL,
      office TEXT NOT NULL CHECK (office IN ('senate','governor','house','measure')), district TEXT, name TEXT NOT NULL, source_key TEXT NOT NULL,
      vote_for INTEGER, statewide INTEGER NOT NULL DEFAULT 1, UNIQUE (election_id, source_key));
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES elections(id), source TEXT NOT NULL,
      source_version TEXT, fetched_at TEXT NOT NULL);
    INSERT INTO elections VALUES (1, 'fake', 'CO/1', 'CO', NULL, 'state', 'CO', NULL, NULL, '2026-11-03T20:00:00Z');
    INSERT INTO snapshots VALUES (1, 1, 'fake', '1', '2026-11-03T20:00:00Z');
  `);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT election_key FROM elections WHERE id = 1').get().election_key, '2026-general');
  assert.equal(db.prepare('SELECT source_updated_at FROM snapshots WHERE id = 1').get().source_updated_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 1);
  assert.ok(db.prepare('PRAGMA table_info(races)').all().some((c) => c.name === 'title'));
  db.close();
  openDb(file).close(); // idempotent
});
