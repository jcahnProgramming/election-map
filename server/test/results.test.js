import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';

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
  const m = res.measures('CO').measures[0];
  assert.deepEqual([m.yes, m.no, m.pctYes], [300, 100, 75]);
});
