// Parser tests against real Louisiana SOS blobs captured on election night 2026-11-03 (before results: all 0):
// the multi-parish races and votes, and three parishes (Acadia 01, Jefferson 26, Orleans 36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseLa, parishFips, parseLaTime } from '../src/adapters/lasos.js';
import { enrichRaces } from '../src/contests.js';

const raw = (f) => readFileSync(new URL(`./fixtures/lasos/${f}`, import.meta.url), 'utf8');
const rd = (f) => JSON.parse(raw(f));
const t = adapter.targets()[0];
const input = (edit = (x) => x) => edit({
  multiMeta: rd('RacesCandidates_Multiparish.json'),
  multiVotes: rd('Votes_Multiparish.json'),
  parishes: ['01', '26', '36'].map((p) => ({ code: p, meta: rd(`ByParish_${p}.json`), votes: rd(`VotesParish_${p}.json`) })),
});

test('parish codes are alphabetical like FIPS; times are Louisiana local', () => {
  assert.equal(parishFips('01'), '22001');
  assert.equal(parishFips('36'), '22071');
  assert.equal(parishFips('64'), '22127');
  assert.equal(parseLaTime('2026-11-03T17:50:23.030'), '2026-11-03T23:50:23.000Z');
  assert.equal(t.key, 'LA/344');
  assert.equal(t.folder, '20261103');
});

test('contests: Senate, House 1-6, amendments statewide; parish units; local races; NOPTY; nothing unmatched', () => {
  const un = [];
  const r = parseLa(input(), t, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.equal(r.races.length, 143);
  assert.deepEqual(r.turnout, [{ level: 'state', name: 'LA', registered: 2975616, ballotsCast: 0, turnoutPct: 0, precinctsReporting: 0, precinctsTotal: 3722 }]);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.statewide, true);
  assert.deepEqual(sen.choices.map((c) => [c.name, c.party]), [['"Jamie" Davis', 'DEM'], ['Julia Letlow', 'REP']]);
  assert.deepEqual(sen.units.map((u) => [u.name, u.precinctsTotal]), [['LA', 3722], ['Acadia', 47], ['Jefferson', 268], ['Orleans', 349]]);
  const house = r.races.filter((x) => x.office === 'house');
  assert.deepEqual(house.map((x) => x.district), ['1', '2', '3', '4', '5', '6']);
  assert.ok(house.every((x) => !x.statewide));
  const glass = house[0].choices.find((c) => c.name === 'E. "Liddy" Glass');
  assert.deepEqual([glass.partyRaw, glass.party], ['NOPTY', 'OTHER']);
  const cas = r.races.filter((x) => x.office === 'measure' && x.statewide);
  assert.equal(cas.length, 10);
  assert.match(cas[0].name, /^CA No\. 1 /);
  const civil = r.races.find((x) => x.name === 'Judge -- Civil District Court, Division L');
  assert.deepEqual(civil.units.map((u) => u.name), ['Judge -- Civil District Court, Division L', 'Orleans']);
  enrichRaces(r, 'lasos');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'), r.races.filter((x) => x.level === 'unclassified').map((x) => x.name).join(', '));
});

test('numbers: statewide from the multi-parish file, parishes from their own files', () => {
  const r = parseLa(input((d) => {
    const sen = d.multiVotes.Races.Race.find((x) => x.ID === '67997');
    sen.PrecinctsReporting = '1000';
    sen.VoterCountVoted = '500000';
    sen.Choice[0].VoteTotal = '210000';
    sen.Choice[1].VoteTotal = '280000';
    const orl = d.parishes[2].votes.Races.Race.find((x) => x.ID === '67997');
    orl.PrecinctsReporting = '100';
    orl.Choice[0].VoteTotal = '60000';
    orl.Choice[1].VoteTotal = '15000';
    return d;
  }), t);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual([sen.units[0].votes, sen.units[0].precinctsReporting, sen.units[0].pctReporting], [[210000, 280000], 1000, 26.9]);
  assert.deepEqual(sen.units.find((u) => u.name === 'Orleans').votes, [60000, 15000]);
  assert.equal(r.turnout[0].ballotsCast, 500000);
  assert.equal(r.turnout[0].turnoutPct, 16.8);
});

test('polling: CurrentVersion is the change check; parishes swept in batches; another election stores nothing', async () => {
  const calls = [];
  let mode = raw('ElectionMode.json');
  const http = {
    get: async (url) => {
      const b = decodeURIComponent(url.split('?blob=')[1]);
      calls.push(b);
      if (b === 'CurrentVersion.htm') return { text: raw('CurrentVersion.json') };
      if (b === 'ElectionMode.htm') return { text: mode };
      if (b.endsWith('RacesCandidates_Multiparish.htm')) return { text: raw('RacesCandidates_Multiparish.json') };
      if (b.endsWith('/Votes_Multiparish.htm')) return { text: raw('Votes_Multiparish.json') };
      const p = b.match(/_(\d\d)\.htm$/)[1];
      const have = ['01', '26', '36'].includes(p);
      if (b.includes('ByParish_')) return { text: have ? raw(`ByParish_${p}.json`) : '{"Races":{"Race":[]}}' };
      return { text: have ? raw(`VotesParish_${p}.json`) : '{"Races":{"Race":[]}}' };
    },
  };
  const tt = { ...t, key: 'LA/test', requestGapMs: 0, sweepBatch: 32 };
  const ctx = { http, log: {}, unmatched: () => {} };
  assert.equal((await adapter.fetch(tt, ctx)).changed, true);
  assert.equal(calls.filter((c) => c.includes('VotesParish/')).length, 32);
  calls.length = 0;
  assert.equal((await adapter.fetch(tt, ctx)).changed, true, 'the second half of the parishes');
  assert.equal(calls.filter((c) => c.includes('VotesParish/')).length, 32);
  calls.length = 0;
  assert.equal((await adapter.fetch(tt, ctx)).changed, false);
  assert.deepEqual(calls, ['CurrentVersion.htm']);
  mode = '{"ElectionMode":{"PKElectionID":"345"}}';
  const t2 = { ...tt, key: 'LA/test2' };
  const warn = [];
  assert.equal((await adapter.fetch(t2, { ...ctx, log: { warn: (m) => warn.push(m) } })).changed, false);
  assert.match(warn[0], /345/);
});
