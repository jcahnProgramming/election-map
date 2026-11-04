import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseTally, trackedContests } from '../src/adapters/tallyenr.js';
import { enrichRaces } from '../src/contests.js';

// Real responses from enr-results-api.totalresults.com for arkansas / 2026 general, captured 2026-11-03 before polls
// closed (info: precinct lists dropped; contest list: federal, statewide, one county issue and the 13 contests in
// types.json, which is GetContestResults per contest type trimmed to those 13 + Governor; results: Senate, AR-2,
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

// Every other contest comes from GetContestResults, one call per contest type (real responses, trimmed to 13 contests
// plus the Governor, which is also read on its own and must not be duplicated).


const full = () => ({ ...load(), typeResults: fx('types.json') });
const target2 = { ...target, detailTypes: ['Federal', 'Statewide'], typeHints: {
  'State Senate': { level: 'legislative', office: 'state_senate' },
  'State Representative': { level: 'legislative', office: 'state_house' },
} };

test('AR: every contest type is emitted; headline contests keep their vote-type split', () => {
  const un = [];
  const r = parseTally(full(), target2, (...a) => un.push(a));
  assert.equal(r.races.length, 4 + 13);
  assert.equal(new Set(r.races.map((x) => x.key)).size, r.races.length, 'Governor is not duplicated by the sweep');
  assert.ok(r.races.find((x) => x.office === 'governor').units[0].methods, 'the detailed call wins over the sweep');

  const lg = r.races.find((x) => x.name === 'Lieutenant Governor');
  assert.equal(lg.office, null);
  assert.equal(lg.statewide, true, 'covers every precinct');
  assert.equal(lg.voteFor, 1);
  assert.equal(lg.units.length, 76);
  assert.equal(lg.units[0].methods, undefined, 'the per-type call has no vote-type split');
  assert.deepEqual(lg.choices.map((c) => c.partyRaw), ['REP', 'LIB']);

  const sd1 = r.races.find((x) => x.name === 'State Senate District 01');
  assert.deepEqual([sd1.level, sd1.office, sd1.statewide], ['legislative', 'state_senate', false]);
  assert.ok(sd1.units.length > 1 && sd1.units.length < 76);
  for (const u of sd1.units) assert.equal(u.votes.length, sd1.choices.length);

  const judge = r.races.find((x) => /^Circuit Judge, District 04/.test(x.name));
  assert.equal(judge.office, null);
  assert.equal(judge.statewide, false);
  assert.ok(judge.units[0].precinctsTotal > 0);

  const tax = r.races.find((x) => x.name === '1% Road Sales & Use Tax');
  assert.deepEqual([tax.office, tax.statewide], ['measure', false]);
  assert.equal(tax.units.length, 2); // contest total + its one county
  assert.deepEqual([tax.units[0].yes, tax.units[0].no], [0, 0]);
  assert.ok(!un.some(([k, v]) => k === 'party' && v === ''), 'no party is not an unknown party');
});

test('AR: classification of the swept contests (config rules: County Judge is the county executive)', () => {
  const r = parseTally(full(), target2);
  const un = enrichRaces(r, 'tallyenr');
  const by = (re) => r.races.find((x) => re.test(x.name));
  assert.deepEqual([by(/Lincoln County Judge/).level, by(/Lincoln County Judge/).office], ['county', 'county_executive']);
  assert.deepEqual([by(/Justice of the Peace/).level, by(/Justice of the Peace/).office], ['county', 'county_commission']);
  assert.equal(by(/Circuit Judge/).level, 'judicial');
  assert.equal(by(/State Representative District 08/).office, 'state_house');
  assert.equal(by(/Lieutenant Governor/).office, 'lieutenant_governor');
  assert.deepEqual(un, []);
});

test('AR: request volume: per-type sweep at most every sweepSeconds, never one request per contest', async () => {
  let version = 'v1';
  const calls = [];
  const http = {
    async getJson(url) {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith('/GetTurnout')) return { json: { ...fx('turnout.json'), versionID: version } };
      if (path.endsWith('/GetElectionInfo')) return { json: fx('info.json') };
      if (path.endsWith('/GetContestSearchList')) return { json: fx('contestlist.json') };
      if (path.endsWith('/GetSingleContestResults')) {
        const id = new URL(url).searchParams.get('contestID');
        return { json: fx('contests.json').find((e) => e.response.contestID === id) ?? { response: null } };
      }
      if (path.endsWith('/GetContestResults')) {
        const type = new URL(url).searchParams.get('contestType');
        return { json: fx('types.json').find((e) => e.response.contestType === type) ?? { response: { contests: {} } } };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  const t = { ...target2, key: `test/${Math.random()}`, base: 'https://example.test', cid: 'arkansas', electionId: 'x', sweepSeconds: 300, contestTypes: null };
  const count = (re) => calls.filter((p) => re.test(p)).length;
  const types = Object.keys(fx('info.json').response.contestTypes).length;

  let r = await adapter.fetch(t, { http, unmatched: () => {}, now: 0 });
  assert.equal(r.changed, true);
  assert.equal(count(/GetSingleContestResults/), 10);
  assert.equal(count(/GetContestResults$/), types, 'one call per contest type');
  assert.equal(r.result.races.length, 4 + 13);

  calls.length = 0;
  r = await adapter.fetch(t, { http, unmatched: () => {}, now: 60_000 });
  assert.equal(r.changed, false);
  assert.deepEqual(calls, ['/Turnout/GetTurnout']);

  // New numbers within the cooldown: headline contests re-read, the sweep is reused.
  calls.length = 0;
  version = 'v2';
  r = await adapter.fetch(t, { http, unmatched: () => {}, now: 120_000 });
  assert.equal(r.changed, true);
  assert.equal(count(/GetSingleContestResults/), 10);
  assert.equal(count(/GetContestResults$/), 0);
  assert.equal(r.result.races.length, 4 + 13, 'the other contests are carried from the last sweep');

  // Quiet feed after the cooldown: one catch-up sweep, then nothing.
  calls.length = 0;
  r = await adapter.fetch(t, { http, unmatched: () => {}, now: 400_000 });
  assert.equal(r.changed, true);
  assert.equal(count(/GetSingleContestResults/), 0);
  assert.equal(count(/GetContestResults$/), types);
  calls.length = 0;
  r = await adapter.fetch(t, { http, unmatched: () => {}, now: 800_000 });
  assert.equal(r.changed, false);
  assert.equal(calls.length, 1);
});
