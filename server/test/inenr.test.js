// Parser tests against real Indiana ENR files captured on election night 2026-11-03 at 01:42 UTC (1,579 of 5,067
// precincts in), trimmed: all 9 U.S. House races, Secretary of State with 3 counties, 3 sheriffs, 2 school boards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseInEnr, categoryIds, parseWriteTime } from '../src/adapters/inenr.js';
import { enrichRaces } from '../src/contests.js';

const raw = (f) => readFileSync(new URL(`./fixtures/inenr/${f}`, import.meta.url), 'utf8');
const rd = (f) => JSON.parse(raw(f));
const t = adapter.targets()[0];
const data = () => ({
  settings: rd('settings.json').Root,
  categories: rd('statewideElectionsC_A.json'),
  turnout: rd('statewideTurnout_A.json'),
  files: ['OffCatC_1005_A.json', 'OffCatC_1041_A.json', 'OffCatC_1046_A.json', 'OffCatC_1017_A.json'].map(rd),
});

test('targets / categories / WriteTime', () => {
  assert.equal(t.key, 'IN/2026G');
  assert.equal(t.currentElection, '11/03/2026');
  const ids = categoryIds(rd('statewideElectionsC_A.json'));
  assert.equal(ids.length, 32);
  assert.deepEqual(ids.slice(0, 3), ['1005', '1041', '1047']);
  assert.equal(parseWriteTime('2026-11-03T20:42:38.767'), '2026-11-04T01:42:38.000Z');
});

test('live numbers: House by district, Secretary of State by county (sums match), party names from settings', () => {
  const un = [];
  const r = parseInEnr(data(), t, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.equal(r.sourceUpdatedAt, '2026-11-04T01:42:38.000Z');
  assert.deepEqual(r.turnout[0], { level: 'state', name: 'IN', registered: null, ballotsCast: 64585, turnoutPct: null, precinctsReporting: 1579, precinctsTotal: 5067 });
  assert.deepEqual(r.turnout.find((u) => u.name === 'Adams'), { level: 'county', countyFips: '18001', name: 'Adams', registered: 19761, ballotsCast: 8708, turnoutPct: 44.1 });
  assert.equal(r.turnout.find((u) => u.name === 'Allen').registered, null, '0 until the county reports');
  const house = r.races.filter((x) => x.office === 'house');
  assert.deepEqual(house.map((x) => x.district), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const h1 = house[0];
  assert.deepEqual(h1.choices.map((c) => [c.name, c.party, c.partyRaw]).slice(0, 2), [['Frank J. Mrvan', 'DEM', 'Democratic'], ['Barb Regnitz', 'REP', 'Republican']]);
  assert.deepEqual(h1.units[0].votes, [47443, 21959, 0, 0]);
  const sos = r.races.find((x) => x.name === 'Secretary Of State');
  assert.equal(sos.statewide, true);
  assert.equal(sos.choices.find((c) => c.name === 'Greg Ballard').partyRaw, 'Lincoln Party');
  assert.deepEqual(sos.units[0].votes, [198293, 191970, 13197, 8297, 2]);
  assert.equal(sos.units.filter((u) => u.level === 'county').length, 3);
  const sheriff = r.races.find((x) => x.name === 'Adams County Sheriff');
  assert.equal(sheriff.statewide, false);
  assert.deepEqual(sheriff.units.map((u) => [u.level, u.name, u.votes[0]]), [['state', 'Adams County Sheriff', 6594], ['county', 'Adams', 6594]]);
});

test('levels: category hints place school boards; nothing unclassified', () => {
  const r = parseInEnr(data(), t);
  enrichRaces(r, 'inenr');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'));
  assert.equal(r.races.find((x) => /School Board/.test(x.name)).office, 'school_board');
  assert.equal(r.races.find((x) => x.name === 'Secretary Of State').office, 'secretary_of_state');
  assert.equal(r.races.find((x) => /Sheriff/.test(x.name)).level, 'county');
});

test('polling: settings is the change check; the buffer letter picks the files; another election stores nothing', async () => {
  const calls = [];
  let settings = raw('settings.json');
  const http = {
    get: async (url) => {
      calls.push(url.replace(/^.*\/data\//, ''));
      const f = url.replace(/^.*\/data\//, '');
      if (f === 'settings.json') return { text: settings };
      if (/^OffCatC_\d+_A\.json$/.test(f)) {
        try { return { text: raw(f) }; } catch { return { text: JSON.stringify({ Root: { StatewideSummary: {}, OfficeCategory: {} } }) }; }
      }
      return { text: raw(f) };
    },
  };
  const tt = { ...t, key: 'IN/test', requestGapMs: 0, sweepBatch: 40 };
  const ctx = { http, log: {}, unmatched: () => {} };
  const first = await adapter.fetch(tt, ctx);
  assert.equal(first.changed, true);
  assert.deepEqual(calls.slice(0, 3), ['settings.json', 'statewideElectionsC_A.json', 'statewideTurnout_A.json']);
  assert.equal(calls.filter((c) => c.startsWith('OffCatC_')).length, 32);
  calls.length = 0;
  assert.equal((await adapter.fetch(tt, ctx)).changed, false);
  assert.deepEqual(calls, ['settings.json']);
  settings = settings.replace('"CurrentElection":"11/03/2026"', '"CurrentElection":"05/05/2026"');
  calls.length = 0;
  const warn = [];
  assert.equal((await adapter.fetch(tt, { ...ctx, log: { warn: (m) => warn.push(m) } })).changed, false);
  assert.match(warn[0], /05\/05\/2026/);
});

test('IN publishes precincts N of M (1579 of 5067): statewide offices and the House sum show it as "precincts reported", districts don\'t, never a %', async () => {
  const r = parseInEnr(data(), t);
  const sos = r.races.find((x) => /Secretary Of State/i.test(x.name));
  assert.deepEqual([sos.units[0].countiesComplete, sos.units[0].countiesTotal, sos.units[0].pctReporting], [1579, 5067, null]);
  const d1 = r.races.find((x) => x.office === 'house' && x.district === '1');
  assert.equal(d1.units[0].countiesTotal, undefined); // a statewide count is not a district's count

  const { openDb, writeSnapshot } = await import('../src/db.js');
  const { createResults } = await import('../src/results.js');
  const db = openDb(':memory:');
  writeSnapshot(db, { ...r, version: '1', source: 'inenr', fetchedAt: '2026-11-04T01:46:00Z' });
  const res = createResults(db, [{ id: 'inenr', name: 'Indiana ENR', targets: () => [] }]);
  const house = res.state('IN', 'house').statewide;
  assert.deepEqual([house.countiesComplete, house.countiesTotal, house.countiesLabel, house.pctReporting], [1579, 5067, 'precincts reported', null]);
  const seat = res.contests('IN').groups.flatMap((g) => g.contests ?? g.rows ?? []).find((c) => c.district === '1' && c.office === 'house');
  assert.ok(seat, "district 1 row present");
  assert.equal(seat.countiesTotal, undefined);
});
