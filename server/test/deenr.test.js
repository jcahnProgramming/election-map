import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDeEnr } from '../src/adapters/deenr.js';

// Real files from elections.delaware.gov/results/enr/ (GE2026) captured 2026-11-03 before polls closed, trimmed to
// the federal contests, one statewide office and one county office.
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/deenr/${f}`, import.meta.url), 'utf8'));
const target = {
  key: 'DE/GE2026', state: 'DE', label: 'Delaware 2026 General Election', date: '2026-11-03',
  url: 'https://elections.delaware.gov/results/enr/GE2026.html', races: ['senate', 'governor', 'house'], measures: true,
  countyColumns: ['New Castle', 'Kent', 'Sussex'],
};
const load = () => ({ statewide: fx('statewide.json'), byCounty: fx('bycounty.json'), turnout: fx('turnout.json') });

test('DE: senate + at-large house, counties, methods, timestamp', () => {
  const un = [];
  const r = parseDeEnr(load(), target, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.deepEqual(r.races.map((x) => [x.office, x.district]), [['senate', null], ['house', 'AL'], [null, null], [null, null]]);
  const s = r.races[0];
  assert.deepEqual(s.choices[0], { name: 'CHRIS COONS', party: 'DEM', partyRaw: 'Democratic Party' });
  assert.deepEqual(s.units.map((u) => [u.level, u.countyFips ?? null]), [['state', null], ['county', '10003'], ['county', '10001'], ['county', '10005']]);
  assert.equal(s.units[0].precinctsTotal, 530);
  assert.deepEqual(s.units[0].methods.map((m) => m.label), ['Machine Votes', 'Absentee Votes', 'Early Voting Votes']);
  assert.equal(s.units[1].precinctsTotal, null, 'the by-county file has no precinct counts');
  assert.equal(r.sourceUpdatedAt, '2026-09-29T13:35:45.646Z');
  // "Reg Voters" is "0" in the feed (the page hard-codes registration), so it is unpublished, not zero.
  assert.deepEqual(r.turnout, [{ level: 'state', name: 'DE', registered: null, ballotsCast: 0, turnoutPct: null, precinctsReporting: 0, precinctsTotal: 530 }]);
});

test('DE: vote arithmetic and county columns', () => {
  const d = load();
  for (const row of d.statewide) Object.assign(row, { 'Machine Votes': '1,000', 'Absentee Votes': '20', 'Early Voting Votes': '300', 'Total Votes': '1,320', 'Precincts Reported': 265 });
  for (const row of d.byCounty) Object.assign(row, { 'New Castle': 700, Kent: 300, Sussex: 320, State: 1320 });
  d.turnout.find((x) => x['Representative District'] === 'ALL')['Reg Voters'] = '810,407';
  d.turnout.find((x) => x['Representative District'] === 'ALL')['Ballots Cast'] = '2,640';
  d.turnout.find((x) => x['Representative District'] === 'ALL').Percentage = 0.33;
  const r = parseDeEnr(d, target);
  const st = r.races[0].units[0];
  assert.deepEqual(st.votes, [1320, 1320]);
  assert.equal(st.pctReporting, 50);
  assert.deepEqual(st.methods[0].votes, [1000, 1000]);
  assert.deepEqual(r.races[0].units.slice(1).map((u) => u.votes[0]), [700, 300, 320]);
  assert.equal(r.turnout[0].registered, 810407);
  assert.equal(r.turnout[0].ballotsCast, 2640);
  assert.equal(r.turnout[0].turnoutPct, 0.33);
});

test('DE: unknown party labels are reported', () => {
  const d = load();
  d.statewide[1]['Party Name'] = 'Zebra Party';
  const un = [];
  parseDeEnr(d, target, (...a) => un.push(a));
  assert.deepEqual(un.map((x) => x.slice(0, 2)), [['party', 'Zebra Party']]);
});

test('DE: every contest in the statewide file is stored; a county office gets only its own county', async () => {
  const { enrichRaces } = await import('../src/contests.js');
  const un = [];
  const d = load();
  const r = parseDeEnr(d, target, (...a) => un.push(a));
  const ag = r.races.find((x) => x.name === 'Attorney General');
  // 527 precincts vs. the state's 530: still statewide, every county column.
  assert.equal(ag.statewide, true);
  assert.deepEqual(ag.units.map((u) => [u.level, u.name]), [['state', 'DE'], ['county', 'New Castle'], ['county', 'Kent'], ['county', 'Sussex']]);
  const sheriff = r.races.find((x) => x.name === 'Kent County Sheriff');
  assert.equal(sheriff.statewide, false);
  assert.deepEqual([sheriff.units[0].name, sheriff.units[0].precinctsTotal, sheriff.voteFor], ['Kent County Sheriff', 97, null]);
  // Before any count every county column is 0: none can be told apart, so no county units yet.
  assert.equal(sheriff.units.length, 1);
  // Once Kent reports, only Kent's column carries votes.
  d.byCounty.find((x) => x['Contest Title'] === 'Kent County Sheriff').Kent = 1234;
  const s2 = parseDeEnr(d, target).races.find((x) => x.name === 'Kent County Sheriff');
  assert.deepEqual(s2.units.slice(1).map((u) => [u.countyFips, u.votes[0]]), [['10001', 1234]]);

  assert.deepEqual(enrichRaces(r, 'deenr'), []);
  assert.deepEqual([ag.level, ag.office], ['statewide', 'attorney_general']);
  assert.deepEqual([sheriff.level, sheriff.office, sheriff.jurisdiction], ['county', 'sheriff', 'Kent']);
  assert.deepEqual([r.races[0].level, r.races[0].office], ['federal', 'senate']);
});
