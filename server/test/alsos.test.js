// Parser tests against real Alabama SOS election-night pages captured on 2026-11-03 around 8:03 pm CST (7 of 67
// counties in), plus the "Results Coming Soon" page the same URL showed before polls closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseAlPage, buildAl, parseAlTime } from '../src/adapters/alsos.js';
import { enrichRaces } from '../src/contests.js';

const read = (f) => readFileSync(new URL(`./fixtures/alsos/${f}`, import.meta.url), 'utf8');
const t = adapter.targets()[0];

test('targets / times', () => {
  assert.equal(t.key, 'AL/1001305');
  assert.equal(t.allContests, false, 'only page 1 is read');
  assert.equal(parseAlTime('11/03/2026 08:03:08 PM'), '2026-11-04T02:03:08.000Z');
});

test('statewide page 1: header figures and contests', () => {
  const p = parseAlPage(read('statewide.html'));
  assert.equal(p.title, '2026 GENERAL ELECTION');
  assert.deepEqual([p.ballotsCast, p.registered, p.countiesReported, p.countiesTotal, p.lastUpdated], [20734, 3852947, 7, 67, '11/03/2026 08:03:08 PM']);
  assert.deepEqual(p.contests.map((c) => c.name).slice(0, 3), ['GOVERNOR', 'LIEUTENANT GOVERNOR', 'UNITED STATES SENATOR']);
  assert.equal(p.contests.length, 10);
  assert.deepEqual(p.contests[0].rows, [{ label: 'Doug Jones (DEM)', votes: 10752 }, { label: 'Tommy Tuberville (REP)', votes: 9815 }, { label: 'Write-In', votes: 62 }]);
  assert.equal(parseAlPage(read('coming-soon.html')).contests.length, 0);
});

test('county pages: name, boxes reported, contests', () => {
  const b = parseAlPage(read('county-05.html'));
  assert.deepEqual([b.county, b.boxesPct, b.ballotsCast, b.registered], ['Baldwin', 3.13, 977, 214658]);
  const m = parseAlPage(read('county-47.html'));
  assert.equal(m.county, 'Madison');
  assert.deepEqual(m.contests[0].rows.map((r) => r.votes), [7454, 3866, 30]);
});

test('result: statewide from the statewide page, county units from county pages, parties, levels', () => {
  const un = [];
  const r = buildAl(parseAlPage(read('statewide.html')), [parseAlPage(read('county-05.html')), parseAlPage(read('county-47.html'))], t, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.equal(r.sourceUpdatedAt, '2026-11-04T02:03:08.000Z');
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.statewide, true);
  assert.deepEqual(gov.choices.map((c) => [c.name, c.party]), [['Doug Jones', 'DEM'], ['Tommy Tuberville', 'REP'], ['Write-In', 'OTHER']]);
  assert.deepEqual(gov.units.map((u) => [u.name, u.votes[0]]), [['AL', 10752], ['Baldwin', 435], ['Madison', 7454]]);
  assert.equal(gov.units.find((u) => u.name === 'Madison').pctReporting, 5);
  const h1 = r.races.find((x) => x.office === 'house' && x.district === '1');
  assert.equal(h1.statewide, false);
  assert.deepEqual(h1.units.map((u) => u.name), ['UNITED STATES REPRESENTATIVE, 1ST CONGRESSIONAL DISTRICT', 'Baldwin']);
  assert.deepEqual(r.turnout[0], { level: 'state', name: 'AL', registered: 3852947, ballotsCast: 20734, turnoutPct: 0.5, precinctsReporting: null, precinctsTotal: null });
  enrichRaces(r, 'alsos');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'));
});

test('polling: statewide page each poll, county list + county pages on a new "Last Updated"', async () => {
  const calls = [];
  let sw = read('coming-soon.html');
  const http = {
    get: async (url) => {
      const p = url.replace(/^.*electionNight\//, '');
      calls.push(p);
      if (p.startsWith('statewide')) return { text: sw };
      if (p.startsWith('chooseCounty')) return { text: read('chooseCounty.html') };
      const cid = p.match(/cid=(\d+)/)[1];
      return { text: read(cid === '47' ? 'county-47.html' : 'county-05.html') };
    },
  };
  const tt = { ...t, key: 'AL/test', requestGapMs: 0, sweepBatch: 4 };
  const ctx = { http, log: {}, unmatched: () => {} };
  await adapter.fetch(tt, ctx);
  assert.deepEqual(calls, ['statewideResultsByContest.aspx?ecode=1001305'], 'no results yet: nothing else fetched');
  sw = read('statewide.html');
  calls.length = 0;
  assert.equal((await adapter.fetch(tt, ctx)).changed, true);
  assert.equal(calls[1], 'chooseCounty.aspx?ecode=1001305');
  assert.equal(calls.filter((c) => c.startsWith('county')).length, 4);
  calls.length = 0;
  await adapter.fetch(tt, ctx);
  assert.equal(calls.filter((c) => c.startsWith('county')).length, 4, 'next batch of the 9 linked counties');
  calls.length = 0;
  await adapter.fetch(tt, ctx);
  assert.equal(calls.filter((c) => c.startsWith('county')).length, 1);
  calls.length = 0;
  assert.equal((await adapter.fetch(tt, ctx)).changed, false);
  assert.deepEqual(calls, ['statewideResultsByContest.aspx?ecode=1001305']);
});

test('AL: the page\'s "Counties Reported: 7 of 67" goes on statewide offices (labelled "reported"); district contests get none', async () => {
  const r = buildAl(parseAlPage(read('statewide.html')), [], t);
  const gov = r.races.find((x) => x.office === 'governor');
  assert.deepEqual([gov.units[0].countiesComplete, gov.units[0].countiesTotal], [7, 67]);
  const h1 = r.races.find((x) => x.office === 'house' && x.district === '1');
  assert.equal(h1.units[0].countiesTotal, undefined);

  const { openDb, writeSnapshot } = await import('../src/db.js');
  const { createResults } = await import('../src/results.js');
  const db = openDb(':memory:');
  writeSnapshot(db, { ...r, version: '1', source: 'alsos', fetchedAt: '2026-11-04T02:04:00Z' });
  const st = createResults(db, [{ id: 'alsos', name: 'Alabama SOS', targets: () => [] }]).state('AL', 'governor').statewide;
  assert.deepEqual([st.countiesComplete, st.countiesTotal, st.countiesLabel], [7, 67, 'reported']);
});
