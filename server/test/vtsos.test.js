import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseVt, parseUpdated, pathStamp } from '../src/adapters/vtsos.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vtsos');
const rd = (sub, f) => JSON.parse(readFileSync(path.join(dir, sub, f), 'utf8'));
const target = {
  key: 'vtsos/68d61e96-1d28-4210-8c1d-8e90512ae105', state: 'VT', label: 'Vermont 2026 General Election', date: '2026-11-03',
  url: 'https://electionresults.vermont.gov/', races: ['senate', 'governor', 'house'], measures: true,
  sections: ['federal', 'stateWide'], timeZone: 'America/New_York',
};
const parse = (sub, mutate = (x) => x) => {
  const seen = [];
  const files = mutate({ index: rd(sub, 'index.json'), sections: [rd(sub, 'federal.json'), rd(sub, 'stateWide.json')], turnout: rd(sub, 'turnout.json') });
  return { r: parseVt(files.index, files.sections, files.turnout, target, (...a) => seen.push(a)), seen };
};

test('VT 2026 general (live, before first town reports): races, version, timestamp', () => {
  const { r, seen } = parse('');
  assert.equal(r.version, '20261103185112/20261103185112/20261103185112');
  assert.equal(r.sourceUpdatedAt, '2026-11-03T23:51:00.000Z'); // "11/03/2026 06:51 PM" EST
  assert.deepEqual(r.races.map((x) => x.office), ['house', 'governor']); // no U.S. Senate race in VT in 2026; Lt. Gov not tracked
  const gov = r.races.find((x) => x.office === 'governor');
  // Fusion label: the raw label is kept, the party resolves to its first recognised part.
  const janoo = gov.choices.find((c) => c.name === 'AMANDA JANOO');
  assert.deepEqual([janoo.party, janoo.partyRaw], ['DEM', 'DEM/PROG']);
  assert.equal(gov.choices.at(-1).name, 'Write-ins');
  assert.deepEqual(gov.units.map((u) => [u.level, u.countyFips ?? null]),
    [['state', null], ['county', '50001'], ['county', '50007'], ['county', '50013']]);
  assert.ok(gov.units.every((u) => u.votes.every((v) => v === 0)));
  assert.ok(seen.some(([k, v]) => k === 'party' && v === 'FREEDOM AND UNITY'));
  assert.ok(!seen.some(([k]) => k === 'county' || k === 'town'));
});

test('VT turnout: registered stays null until every town in the unit has reported', () => {
  const { r } = parse('');
  assert.deepEqual(r.turnout[0], { level: 'state', name: 'VT', registered: null, ballotsCast: 0, turnoutPct: null,
    ballotsOutstanding: null, precinctsReporting: 0, precinctsTotal: 12 });
});

test('VT finished 2024 general: state from the STATE WIDE row, counties summed from town × district rows', () => {
  const { r } = parse('2024');
  const sen = r.races.find((x) => x.office === 'senate');
  const st = sen.units[0];
  assert.equal(st.votes[sen.choices.findIndex((c) => c.name === 'BERNIE SANDERS')], 229429);
  const burlingtonCounty = sen.units.find((u) => u.countyFips === '50007'); // only Burlington's six rows are in the fixture
  assert.deepEqual([burlingtonCounty.precinctsReporting, burlingtonCounty.precinctsTotal, burlingtonCounty.pctReporting], [6, 6, 100]);
  assert.equal(burlingtonCounty.votes[sen.choices.findIndex((c) => c.name === 'BERNIE SANDERS')], 17206);

  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.units[0].votes[gov.choices.findIndex((c) => c.name === 'PHIL SCOTT')], 266439);
  const rep = r.races.find((x) => x.office === 'house');
  assert.deepEqual(rep.choices.find((c) => c.name === 'MARK COESTER'), { name: 'MARK COESTER', party: 'REP', partyRaw: 'REP/LBRT' });

  const chit = r.turnout.find((u) => u.countyFips === '50007');
  assert.deepEqual([chit.registered, chit.ballotsCast, chit.precinctsReporting, chit.precinctsTotal], [34345, 20836, 6, 6]);
});

test('VT: a town missing from townDistricts is reported and kept out of counties, never dropped from the state', () => {
  const { r, seen } = parse('2024', (f) => {
    f.index.townDistricts = f.index.townDistricts.filter((t) => t.townName !== 'BURLINGTON');
    return f;
  });
  assert.ok(seen.some(([k, v]) => k === 'town' && v === 'BURLINGTON'));
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.units.find((u) => u.countyFips === '50007'), undefined);
  assert.equal(sen.units[0].votes[sen.choices.findIndex((c) => c.name === 'BERNIE SANDERS')], 229429);
});

test('VT helpers', () => {
  assert.equal(pathStamp('elections\\abc-f-20261103185112.json'), '20261103185112');
  assert.equal(pathStamp(null), null);
  assert.equal(parseUpdated('11/03/2026 11:05 PM'), '2026-11-04T04:05:00.000Z');
  assert.equal(parseUpdated('06/11/2026 03:31 PM'), '2026-06-11T19:31:00.000Z'); // EDT
  assert.equal(parseUpdated('nope'), null);
});
