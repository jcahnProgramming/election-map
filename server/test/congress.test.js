// Congress / balance of power: the static chambers file (official rosters) and the live seats built from stored contests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';
import { STATES } from '../src/geo.js';

const cfg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'elections', '2026-general', 'chambers.json'), 'utf8'));

test('chambers.json: holdovers + seats up = 100; House 435; thresholds; sourced', () => {
  const { senate, house } = cfg;
  assert.equal(senate.seats, 100);
  assert.equal(senate.majority, 51);
  assert.equal(senate.holdovers.length + senate.up.length, 100);
  assert.equal(senate.holdovers.length, 65);
  assert.equal(senate.up.length, 35);
  assert.match(senate.tieBreak, /Vice President/);
  assert.match(senate.source.roster, /^https:\/\/www\.senate\.gov\//);
  // Specials are seats up, never holdovers.
  for (const st of ['FL', 'OH']) {
    assert.ok(senate.up.some((u) => u.state === st && u.seat === 'special'), `${st} special is up`);
    assert.equal(senate.holdovers.filter((h) => h.state === st).length, 1, `${st}: only the Class I senator is a holdover`);
  }
  // No state has more than 2 senators in total; every state has exactly 2.
  for (const s of STATES.filter((x) => x.abbr !== 'DC')) {
    const n = senate.holdovers.filter((h) => h.state === s.abbr).length + senate.up.filter((u) => u.state === s.abbr).length;
    assert.equal(n, 2, s.abbr);
  }
  // Caucus: independents labelled as such, counted with the party they caucus with.
  const ind = senate.holdovers.filter((h) => h.party === 'I');
  assert.deepEqual(ind.map((h) => [h.state, h.caucus]), [['ME', 'DEM'], ['VT', 'DEM']]);
  for (const h of senate.holdovers) assert.equal(h.caucus, h.party === 'R' ? 'REP' : 'DEM', h.name);
  assert.deepEqual([senate.holdovers.filter((h) => h.party === 'D').length, ind.length, senate.holdovers.filter((h) => h.party === 'R').length], [32, 2, 31]);
  assert.equal(house.seats, 435);
  assert.equal(house.majority, 218);
  assert.equal(Object.values(house.districts).reduce((a, b) => a + b, 0), 435);
  assert.equal(Object.keys(house.districts).length, 50);
});

const cand = (name, party, partyRaw = party) => ({ name, party, partyRaw });
const st = (votes) => ({ level: 'state', votes, precinctsReporting: 50, precinctsTotal: 100 });

function seed() {
  const db = openDb(':memory:');
  const w = (state, races) => writeSnapshot(db, { source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: `${state}/1`, state, scope: 'state', name: state }, races });
  w('OH', [
    { office: 'senate', key: '1', name: 'U.S. Senator (Unexpired Term)', choices: [cand('Sherrod Brown', 'DEM'), cand('Jon Husted', 'REP')], units: [st([510, 490])] },
    { office: 'house', key: '2', district: '1', name: 'Rep District 1', choices: [cand('A', 'DEM'), cand('B', 'REP')], units: [st([70, 30])] },
    { office: 'house', key: '3', district: '2', name: 'Rep District 2', choices: [cand('C', 'DEM'), cand('D', 'REP')], units: [st([0, 0])] },
  ]);
  w('CA', [
    // Top-two: two Democrats, 0.5 pts apart — still a Democratic seat.
    { office: 'house', key: 'h7', district: '7', name: 'U.S. House District 7', choices: [cand('Dem One', 'DEM'), cand('Dem Two', 'DEM')], units: [st([5025, 4975])] },
  ]);
  w('VT', [{ office: 'house', key: 'al', district: null, name: 'U.S. House At Large', choices: [cand('V1', 'DEM'), cand('V2', 'REP')], units: [st([60, 40])] }]);
  const adapter = { id: 'fake', name: 'Fake', fetch: async () => ({ changed: false }),
    targets: () => ['OH', 'CA', 'VT'].map((s) => ({ key: `${s}/1`, state: s, scope: 'state', levels: ['state'] })) };
  return createResults(db, [adapter]);
}

test('congress: one entry per seat up, matched to stored contests; no data → live:false; never a call', () => {
  const c = seed().congress('2026-general');
  assert.equal(c.available, true);
  assert.equal(c.senate.up.length, 35);
  assert.equal(c.senate.holdovers.length, 65);
  assert.equal(c.house.up.length, 435);
  const oh = c.senate.up.filter((u) => u.state === 'OH');
  assert.equal(oh.length, 1);
  assert.deepEqual([oh[0].seat, oh[0].live, oh[0].leader, oh[0].marginPts, oh[0].lead.name], ['special', true, 'DEM', 2, 'Sherrod Brown']);
  const ga = c.senate.up.find((u) => u.state === 'GA');
  assert.deepEqual([ga.live, ga.totalVotes, ga.leader], [false, 0, null]);
  const ohH = c.house.up.filter((u) => u.state === 'OH');
  assert.equal(ohH.length, 15);
  assert.deepEqual(ohH.slice(0, 3).map((u) => [u.district, u.live, u.totalVotes, u.leader]), [['1', true, 100, 'DEM'], ['2', true, 0, null], ['3', false, 0, null]]);
  const ca7 = c.house.up.find((u) => u.state === 'CA' && u.district === '7');
  assert.deepEqual([ca7.leader, ca7.runnerUpParty], ['DEM', 'DEM']);
  const vt = c.house.up.filter((u) => u.state === 'VT');
  assert.deepEqual(vt.map((u) => [u.district, u.leader]), [['AL', 'DEM']]);
  assert.ok(!/\b(won|wins|winner|called|projected)\b/i.test(JSON.stringify(c)), 'no call language in the API');
});

test('House state view: party totals plus one row per district; at-large states by candidate', () => {
  const r = seed();
  const oh = r.state('OH', 'house').statewide;
  assert.equal(oh.partySum, true);
  assert.deepEqual(oh.districts.map((d) => [d.district, d.leader, d.lead?.name ?? null]), [['1', 'DEM', 'A'], ['2', null, null]]);
  const vt = r.state('VT', 'house').statewide;
  assert.equal(vt.partySum, undefined);
  assert.equal(vt.atLarge, true);
  assert.deepEqual(vt.candidates.map((x) => x.name), ['V1', 'V2']);
  const top = r.national('top').states.find((s) => s.state === 'VT');
  assert.equal(top.topLabel, 'U.S. House · at large');
});
