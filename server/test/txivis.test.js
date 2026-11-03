import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseIvis, localToIso } from '../src/adapters/txivis.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'txivis');
const load = (sub) => [
  JSON.parse(readFileSync(path.join(dir, sub, 'election.json'), 'utf8')),
  JSON.parse(readFileSync(path.join(dir, sub, 'countyInfo.json'), 'utf8')),
];
const target = {
  key: 'txivis/53815', state: 'TX', label: 'Texas 2026 November General Election', url: 'https://example.test/',
  races: ['senate', 'governor', 'house'], measures: true, timeZone: 'America/Chicago', countyAliases: { LASALLE: 'La Salle' },
};
const parse = (sub, t = target) => {
  const seen = [];
  const r = parseIvis(...load(sub), t, (...a) => seen.push(a));
  return { r, seen };
};

test('TX 2026 general (election night, before first votes): races, levels, version, timestamp', () => {
  const { r, seen } = parse('');
  assert.equal(r.version, 'enr/53815/5/');
  assert.equal(r.sourceUpdatedAt, '2026-10-30T03:13:17.000Z'); // "Oct 29, 2026 22:13:17" CDT
  assert.equal(r.election.date, '2026-11-03');
  const offices = r.races.map((x) => `${x.office}:${x.district ?? ''}`).sort();
  assert.deepEqual(offices, ['governor:', 'house:10', 'house:28', 'house:35', 'senate:']);
  assert.ok(!r.races.some((x) => /LIEUTENANT/.test(x.name)), 'Lt. Governor is not tracked');

  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.choices.slice(0, 3).map((c) => [c.name, c.party, c.partyRaw]),
    [['KEN PAXTON', 'REP', 'REP'], ['JAMES TALARICO', 'DEM', 'DEM'], ['TED BROWN', 'OTHER', 'LIB']]);
  const st = sen.units[0];
  assert.equal(st.level, 'state');
  assert.deepEqual(st.votes, [0, 0, 0, 0, 0, 0, 0]); // no votes counted yet: real zeros from the source
  assert.equal(st.precinctsTotal, 309 + 807 + 7); // summed over the counties in the fixture
  assert.deepEqual(st.methods.map((m) => [m.label, m.bucket]), [['Early Voting', 'mail_early'], ['Election Day', 'election_day']]);
  assert.deepEqual(sen.units.slice(1).map((u) => u.countyFips).sort(), ['48029', '48283', '48453']);

  // The incumbent marker "(I)" is not a party.
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.choices[0].name, 'GREG ABBOTT');
  assert.equal(gov.choices[0].partyRaw, 'REP');

  // A House district only gets the counties it covers.
  assert.deepEqual(r.races.find((x) => x.district === '10').units.map((u) => u.name), ['TX', 'Travis']);

  // Unknown party labels are reported, not dropped; candidates stay in the race.
  assert.ok(!seen.some(([k, v]) => k === 'party' && v === 'W'));
  assert.ok(!seen.some(([k, v]) => k === 'party' && v === 'GRE'), 'GRE is a known third-party label');
  assert.ok(!seen.some(([k]) => k === 'county'), 'LASALLE resolves through the config alias');
});

test('TX turnout: county summaries plus a statewide sum; turnout % only where the source states it', () => {
  const { r } = parse('2025');
  const [st, ...cos] = r.turnout;
  assert.equal(st.level, 'state');
  assert.equal(st.turnoutPct, null);
  assert.equal(st.ballotsOutstanding, null);
  assert.equal(st.registered, cos.reduce((s, c) => s + c.registered, 0));
  const travis = cos.find((c) => c.name === 'Travis');
  assert.deepEqual(
    [travis.countyFips, travis.registered, travis.ballotsCast, travis.turnoutPct, travis.precinctsReporting, travis.precinctsTotal],
    ['48453', 907355, 222224, 24.49, 288, 288],
  );
});

test('TX propositions (finished 2025 election): yes/no, early vs election day, title', () => {
  const { r } = parse('2025');
  assert.equal(r.sourceUpdatedAt, '2025-11-06T10:18:23.000Z'); // CST
  const p1 = r.races.find((x) => x.name === 'PROPOSITION 1 (SJR 59)');
  assert.equal(p1.office, 'measure');
  assert.equal(p1.title, 'PROPOSITION 1 (SJR 59)');
  const st = p1.units[0];
  assert.deepEqual([st.yes, st.no], [2041859, 916217]);
  assert.deepEqual(st.methods[0].votes, [1008391, 456537]);
  assert.deepEqual(st.methods[1].votes, [2041859 - 1008391, 916217 - 456537]);
  const travis = p1.units.find((u) => u.countyFips === '48453');
  assert.deepEqual([travis.yes, travis.no, travis.pctReporting], [126731, 95493, 100]);
  assert.deepEqual(travis.methods[0].votes, [64680, 50622]);
});

test('TX: measures off and an unknown county are handled honestly', () => {
  const { r } = parse('2025', { ...target, measures: false });
  assert.equal(r.races.length, 0);
  const { seen } = parse('', { ...target, countyAliases: {} });
  assert.ok(seen.some(([k, v]) => k === 'county' && v === 'LASALLE'));
});

test('localToIso handles both sides of the DST change', () => {
  assert.equal(localToIso('Nov 03, 2026 19:00:00', 'America/Chicago'), '2026-11-04T01:00:00.000Z');
  assert.equal(localToIso('Oct 29, 2026 22:13:17', 'America/Chicago'), '2026-10-30T03:13:17.000Z');
  assert.equal(localToIso('garbage', 'America/Chicago'), null);
});
