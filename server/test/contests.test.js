import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { classifyFull, enrichRaces, officeLabel } from '../src/contests.js';
import { openDb, writeSnapshot } from '../src/db.js';

const C = (name, choices = [{ name: 'A', party: 'DEM' }, { name: 'B', party: 'REP' }]) => classifyFull(name, choices);

test('top races keep their built-in classification', () => {
  assert.deepEqual(pick(C('United States Senator')), { level: 'federal', office: 'senate' });
  assert.deepEqual(pick(C('U.S. Representative - District 4')), { level: 'federal', office: 'house' });
  assert.equal(C('U.S. Representative - District 4').district, '4');
  assert.deepEqual(pick(C('Governor and Lieutenant Governor')), { level: 'statewide', office: 'governor' });
  assert.deepEqual(pick(classifyFull('Amendment 1', ['Yes', 'No'])), { level: 'measure', office: 'measure' });
});

test('statewide offices', () => {
  for (const [name, office] of [
    ['Attorney General', 'attorney_general'], ['Secretary of State', 'secretary_of_state'], ['SECRETARY OF THE STATE', 'secretary_of_state'],
    ['State Treasurer', 'treasurer'], ['Lieutenant Governor', 'lieutenant_governor'], ['Lt. Governor', 'lieutenant_governor'],
    ['State Auditor', 'auditor'], ['Commissioner of Agriculture', 'agriculture_commissioner'], ['Comptroller of Public Accounts', 'controller'],
    ['Commissioner of Labor', 'labor_commissioner'], ['Railroad Commissioner', 'railroad_commissioner'],
    ['State Superintendent of Public Instruction', 'superintendent_of_public_instruction'], ['Insurance Commissioner', 'insurance_commissioner'],
  ]) assert.deepEqual(pick(C(name)), { level: 'statewide', office }, name);
});

test('legislature, county, local, judicial', () => {
  assert.deepEqual(pick(C('State Senator - District 12')), { level: 'legislative', office: 'state_senate' });
  assert.equal(C('State Senator - District 12').district, '12');
  assert.deepEqual(pick(C('NC STATE SENATE DISTRICT 01')), { level: 'legislative', office: 'state_senate' });
  assert.deepEqual(pick(C('State Representative - District 45')), { level: 'legislative', office: 'state_house' });
  assert.deepEqual(pick(C('Member of the House of Delegates')), { level: 'legislative', office: 'state_house' });
  assert.deepEqual(pick(C('Adams County Commissioner - District 3')), { level: 'county', office: 'county_commission' });
  assert.equal(C('Adams County Commissioner - District 3').jurisdiction, 'Adams');
  assert.deepEqual(pick(C('County Treasurer')), { level: 'county', office: 'county_treasurer' });
  assert.deepEqual(pick(C('Sheriff')), { level: 'county', office: 'sheriff' });
  assert.deepEqual(pick(C('Clerk of Superior Court')), { level: 'county', office: 'county_clerk' });
  assert.deepEqual(pick(C('Mayor - City of Boise')), { level: 'local', office: 'mayor' });
  assert.equal(C('Mayor - City of Boise').jurisdiction, 'Boise');
  assert.deepEqual(pick(C('City Council Ward 2')), { level: 'local', office: 'city_council' });
  assert.deepEqual(pick(C('Board of Education Director District 4', [{ name: 'X' }])), { level: 'local', office: 'school_board' });
  assert.deepEqual(pick(C('State Board of Education - Congressional District 3')), { level: 'statewide', office: 'state_board_of_education' });
  assert.deepEqual(pick(C('Justice of the Supreme Court')), { level: 'judicial', office: 'supreme_court' });
  // Real feed spellings found in the live RI / GA / UT / SC / TX feeds.
  for (const [name, level, office] of [
    ['Senator in General Assembly District 12', 'legislative', 'state_senate'],
    ['Rep. in the G.A. District 4', 'legislative', 'state_house'],
    ['District Attorney - Atlanta Judicial Circuit', 'county', 'district_attorney'],
    ['Solicitor 10th Circuit', 'county', 'district_attorney'],
    ['State School Board District 4', 'statewide', 'state_board_of_education'],
    ['Anderson County Board of Education', 'local', 'school_board'],
    ['Anderson County School Trustee', 'local', 'school_board'],
    ['Sec. of State', 'statewide', 'secretary_of_state'],
    ['PSC District 2', 'statewide', 'public_service_commission'],
  ]) assert.deepEqual(pick(C(name)), { level, office }, name);
});

test('kinds: partisan / nonpartisan / retention / yes_no', () => {
  assert.equal(C('Attorney General').kind, 'partisan');
  assert.equal(classifyFull('School Board', [{ name: 'A', party: 'OTHER' }, { name: 'B', party: 'OTHER' }]).kind, 'nonpartisan');
  const ret = classifyFull('Shall Justice Maria Berkenkotter of the Colorado Supreme Court be retained in office?', ['Yes', 'No']);
  assert.equal(ret.level, 'judicial');
  assert.equal(ret.kind, 'retention');
  assert.equal(classifyFull('Amendment 1', ['Yes', 'No']).kind, 'yes_no');
});

test('unknown contests are unclassified, never dropped', () => {
  const r = C('Keeper of the Royal Swans');
  assert.equal(r.level, 'unclassified');
  assert.equal(r.office, 'unclassified');
  assert.equal(r.classified, false);
  assert.equal(officeLabel('attorney_general'), 'Attorney General');
  assert.equal(officeLabel('some_new_office'), 'Some New Office');
});

test('enrichRaces: adapter presets win; a "statewide" office only one county votes on becomes county', () => {
  const result = {
    election: { scope: 'state', state: 'XX' },
    races: [
      { name: 'U.S. Senate', office: 'senate', key: '1', choices: [], units: [{ level: 'county', countyFips: '01001' }, { level: 'county', countyFips: '01003' }] },
      { name: 'Treasurer', key: '2', choices: [], units: [{ level: 'state' }, { level: 'county', countyFips: '01001', name: 'Autauga' }] },
      { name: 'Treasurer', key: '3', choices: [], units: [{ level: 'county', countyFips: '01001' }, { level: 'county', countyFips: '01003' }] },
      { name: 'Odd thing', key: '4', level: 'local', office: 'school_board', choices: [], units: [] },
      { name: 'Keeper of the Royal Swans', key: '5', choices: [], units: [] },
    ],
  };
  const un = enrichRaces(result, 'none');
  const [a, b, c, d] = result.races;
  assert.deepEqual([a.level, a.office], ['federal', 'senate']);
  assert.deepEqual([b.level, b.office, b.jurisdiction], ['county', 'treasurer', 'Autauga']);
  assert.deepEqual([c.level, c.office], ['statewide', 'treasurer']);
  assert.deepEqual([d.level, d.office], ['local', 'school_board']);
  assert.deepEqual(un.map((x) => x.key), ['5']);
});

test('migration: a 0.2 database (office CHECK) is rebuilt with every row and id intact, then accepts any office', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'em-mig-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Database(file);
    old.exec(`
      CREATE TABLE elections (id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, state TEXT NOT NULL,
        county_fips TEXT, scope TEXT NOT NULL CHECK (scope IN ('state','county')), name TEXT, date TEXT, url TEXT,
        first_seen TEXT NOT NULL, election_key TEXT, UNIQUE (source, source_key));
      CREATE TABLE races (id INTEGER PRIMARY KEY, election_id INTEGER NOT NULL REFERENCES elections(id), state TEXT NOT NULL,
        office TEXT NOT NULL CHECK (office IN ('senate','governor','house','measure')), district TEXT, name TEXT NOT NULL,
        source_key TEXT NOT NULL, vote_for INTEGER, statewide INTEGER NOT NULL DEFAULT 1, title TEXT, UNIQUE (election_id, source_key));
      CREATE TABLE candidates (id INTEGER PRIMARY KEY, race_id INTEGER NOT NULL REFERENCES races(id), name TEXT NOT NULL,
        party TEXT NOT NULL CHECK (party IN ('DEM','REP','OTHER')), party_raw TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
        UNIQUE (race_id, position));
      INSERT INTO elections VALUES (1, 'clarity', 'CO/1', 'CO', NULL, 'state', 'CO', NULL, NULL, '2026-11-03T00:00:00Z', '2026-general');
      INSERT INTO races VALUES (7, 1, 'CO', 'senate', NULL, 'U.S. Senator', '10', 1, 1, NULL);
      INSERT INTO races VALUES (9, 1, 'CO', 'measure', NULL, 'Amendment 1', '11', 1, 1, 'A title');
      INSERT INTO candidates VALUES (3, 7, 'Jane', 'DEM', 'DEM', 0);
    `);
    old.close();

    const db = openDb(file);
    const races = db.prepare('SELECT id, office, level, kind, title FROM races ORDER BY id').all();
    assert.deepEqual(races, [
      { id: 7, office: 'senate', level: 'federal', kind: 'partisan', title: null },
      { id: 9, office: 'measure', level: 'measure', kind: 'yes_no', title: 'A title' },
    ]);
    assert.equal(db.prepare('SELECT race_id FROM candidates WHERE id = 3').get().race_id, 7);
    assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'races'").get().sql, /CHECK/);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

    writeSnapshot(db, {
      source: 'clarity', fetchedAt: '2026-11-03T03:00:00Z', version: '2',
      election: { sourceKey: 'CO/1', state: 'CO', scope: 'state', electionKey: '2026-general' },
      races: [{ name: 'Attorney General', key: '12', choices: [{ name: 'A', party: 'DEM' }, { name: 'B', party: 'REP' }],
        units: [{ level: 'state', votes: [10, 20] }] }],
    });
    assert.deepEqual(db.prepare("SELECT office, level, kind FROM races WHERE source_key = '12'").get(),
      { office: 'attorney_general', level: 'statewide', kind: 'partisan' });
    db.close();
    // Opening again is a no-op.
    openDb(file).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSnapshot records unclassified contests in `unmatched`', () => {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 't', fetchedAt: '2026-11-03T03:00:00Z', version: '1',
    election: { sourceKey: 'k', state: 'CO', scope: 'state', electionKey: '2026-general' },
    races: [{ name: 'Keeper of the Royal Swans', key: '1', choices: [{ name: 'A', party: 'OTHER' }], units: [{ level: 'state', votes: [3] }] }],
  });
  assert.deepEqual(db.prepare('SELECT kind, value, context FROM unmatched').all(), [{ kind: 'contest', value: 'Keeper of the Royal Swans', context: 'CO' }]);
  assert.equal(db.prepare('SELECT office FROM races').get().office, 'unclassified');
});

function pick(r) {
  return { level: r.level, office: r.office };
}
