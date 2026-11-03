import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTally, trackedContests } from '../src/adapters/tallyenr.js';

// Real responses from enr-results-api.totalresults.com for arkansas / 2026 general, captured 2026-11-03 before polls
// closed (info: precinct lists dropped; contest list: federal, statewide and one county issue; results: Senate, AR-2,
// Governor, Issue 1).
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/tallyenr/${f}`, import.meta.url), 'utf8'));
const target = {
  key: 'arkansas/11b07106-031e-4d7c-911a-d01fb473d6dd', state: 'AR', label: 'Arkansas 2026 General', date: '2026-11-03',
  url: 'https://arkansas.tally-enr.com/', races: ['senate', 'governor', 'house'], measures: true,
  contestTypes: ['Federal', 'Statewide'], statewideTypes: ['Federal', 'Statewide'],
};
const load = () => ({ turnout: fx('turnout.json'), info: fx('info.json'), contestList: fx('contestlist.json'), contestResults: fx('contests.json') });

test('AR: tracked contests come from config types and classification', () => {
  const names = trackedContests(fx('contestlist.json'), target).map((c) => c.contestName);
  assert.deepEqual(names, ['U.S. Senate', 'U.S. Congress District 01', 'U.S. Congress District 02', 'U.S. Congress District 03',
    'U.S. Congress District 04', 'Governor', 'ISSUE NO. 1', 'ISSUE NO. 2', 'ISSUE NO. 3', 'ISSUE NO. 4']);
});

test('AR: races, party prefixes, counties, methods, turnout', () => {
  const un = [];
  const r = parseTally(load(), target, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.deepEqual(r.races.map((x) => [x.office, x.district]), [['senate', null], ['house', '2'], ['governor', null], ['measure', null]]);
  const senate = r.races[0];
  assert.deepEqual(senate.choices[0], { name: 'Tom Cotton', party: 'REP', partyRaw: 'REP' });
  assert.equal(senate.choices[2].party, 'DEM');
  assert.equal(senate.units.length, 76); // state + 75 counties
  const pulaski = senate.units.find((u) => u.countyFips === '05119');
  assert.equal(pulaski.name, 'Pulaski');
  assert.ok(pulaski.precinctsTotal > 0);
  assert.deepEqual(senate.units[0].methods.map((m) => [m.label, m.bucket]),
    [['Absentee', 'mail_early'], ['Early Voting', 'mail_early'], ['Election Day', 'election_day']]);
  const ar2 = r.races[1];
  assert.ok(ar2.units.length > 2 && ar2.units.length < 76, 'a district only has the counties that vote in it');
  const issue = r.races[3];
  assert.equal(issue.title, 'ISSUE NO. 1');
  assert.equal(issue.statewide, true);
  assert.deepEqual(issue.choices.map((c) => c.partyRaw), ['', '']);
  const st = r.turnout[0];
  assert.deepEqual(st, { level: 'state', name: 'AR', registered: 1843928, ballotsCast: 0, turnoutPct: 0, precinctsReporting: 0, precinctsTotal: 2768 });
  assert.equal(r.turnout.length, 76);
  assert.equal(r.sourceUpdatedAt, '2026-11-02T22:43:53.972Z');
});

test('AR: vote arithmetic, methods and measure yes/no', () => {
  const d = load();
  for (const env of d.contestResults) {
    for (const ch of env.response.choices) {
      ch.votes.forEach((v, i) => (v.votes = (i + 1) * 10));
      ch.totalVotes = 60;
    }
    env.response.choices[0].totalVotes = 61;
    env.response.precinctsReporting = env.response.totalPrecincts / 2;
  }
  const r = parseTally(d, target);
  const s = r.races[0].units[0];
  assert.deepEqual(s.votes, [61, 60, 60]);
  assert.deepEqual(s.methods[2].votes, [30, 30, 30]);
  assert.equal(s.pctReporting, 50);
  const issue = r.races[3].units[0];
  assert.equal(issue.yes, 61);
  assert.equal(issue.no, 60);
  assert.deepEqual(issue.methods[0].votes, [10, 10]);
});

test('AR: an unknown party label is reported, not dropped', () => {
  const d = load();
  const c = Object.values(d.contestList.response.contests).find((x) => x.contestName === 'U.S. Senate');
  Object.values(c.choices)[1].name = 'Jeff Wadlin';
  const pid = Object.values(c.choices)[1].partyID;
  d.info.response.parties[pid].partyName = 'Moose';
  const un = [];
  const r = parseTally(d, target, (...a) => un.push(a));
  assert.deepEqual(un.map((x) => x.slice(0, 2)), [['party', 'Moose']]);
  assert.equal(r.races[0].choices[1].party, 'OTHER');
});
