import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCaSos, parseReporting, parseReportingTime } from '../src/adapters/casos.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'casos');
const load = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
const target = {
  key: 'casos/ca-2026-general', state: 'CA', label: 'California 2026 General Election', date: '2026-11-03',
  url: 'https://electionresults.sos.ca.gov/', timeZone: 'America/Los_Angeles',
};
const files = () => ({
  version: 'abc',
  candidate: [{ office: 'governor', map: load('maps_governor.json') }],
  house: load('us-rep_district_all.json'),
  measures: load('ballot-measures.json'),
  measuresByCounty: { alameda: load('ballot-measures_county_alameda.json') },
  status: load('status.json'),
});
const parse = (f = files()) => {
  const seen = [];
  return { r: parseCaSos(f, target, (...a) => seen.push(a)), seen };
};

test('CA 2026 general (live, before first report): governor with counties, House per district, measures', () => {
  const { r, seen } = parse();
  assert.equal(r.version, 'abc');
  assert.equal(r.sourceUpdatedAt, '2026-11-03T02:28:00.000Z'); // "November 2, 2026, 6:28 p.m." PST
  assert.ok(!r.races.some((x) => x.office === 'senate'), 'no U.S. Senate race in CA in 2026');

  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.name, 'Governor');
  assert.deepEqual(gov.choices.map((c) => [c.name, c.party, c.partyRaw]), [['Xavier Becerra', 'DEM', 'Dem'], ['Steve Hilton', 'REP', 'Rep']]);
  assert.deepEqual(gov.units[0], { level: 'state', name: 'CA', votes: [0, 0], precinctsReporting: 0, precinctsTotal: 23860, pctReporting: 0 });
  assert.deepEqual(gov.units.slice(1).map((u) => [u.level, u.countyFips, u.name]),
    [['county', '06001', 'Alameda'], ['county', '06013', 'Contra Costa'], ['county', '06037', 'Los Angeles']]);
  assert.equal(gov.units[1].precinctsTotal, 627);

  const house = r.races.filter((x) => x.office === 'house');
  assert.deepEqual(house.map((x) => x.district), ['1', '13', '6']);
  assert.equal(house[0].name, 'U.S. House of Representatives District 1');
  assert.ok(house.every((x) => x.units.length === 1 && x.units[0].level === 'state'));
  // Top-two: "NPP" is no party preference; a known label (not reported), kept as OTHER.
  const d6 = house.find((x) => x.district === '6');
  assert.ok(d6.choices.some((c) => c.partyRaw === 'NPP' && c.party === 'OTHER'));
  assert.ok(!seen.some(([k, v]) => k === 'party' && v === 'NPP'));

  const measures = r.races.filter((x) => x.office === 'measure');
  assert.equal(measures.length, 14);
  const p1 = measures[0];
  assert.equal(p1.name, 'Proposition 1');
  assert.equal(p1.key, 'prop-01');
  assert.equal(p1.title, 'Authorizes Bonds For Housing Affordability Programs. Legislative Statute.');
  assert.deepEqual(p1.units.map((u) => [u.level, u.countyFips ?? null, u.yes, u.no, u.precinctsTotal]),
    [['state', null, 0, 0, 23860], ['county', '06001', 0, 0, 627]]);
  assert.ok(!seen.some(([k]) => k === 'county'));
});

test('CA /status is ignored while it holds data older than the election (Sep 2024 test data tonight)', () => {
  const { r } = parse();
  assert.deepEqual(r.turnout, []);
});

test('CA /status turnout is used once it is for this election', () => {
  const f = files();
  for (const s of Object.values(f.status)) s.lastReportTimestamp = '202611032015';
  const { r } = parse(f);
  const st = r.turnout.find((u) => u.level === 'state');
  assert.deepEqual(st, { level: 'state', name: 'CA', registered: 22171899, ballotsCast: 5543329, turnoutPct: 25, ballotsOutstanding: null,
    precinctsReporting: 10492, precinctsTotal: 30238 });
  const la = r.turnout.find((u) => u.countyFips === '06037');
  assert.equal(la.registered, 5668603);
  assert.equal(r.turnout.filter((u) => u.level === 'county').length, 58);
});

test('CA numbers with thousands separators, and unknown counties are reported', () => {
  const f = files();
  f.candidate[0].map.statewide.candidates[0].Votes = '1,234,567';
  f.candidate[0].map.statewide.Reporting = '12.5% (2,983 of 23,860) precincts reporting';
  f.candidate[0].map['not-a-county'] = f.candidate[0].map.alameda;
  const { r, seen } = parse(f);
  const st = r.races.find((x) => x.office === 'governor').units[0];
  assert.deepEqual([st.votes[0], st.precinctsReporting, st.pctReporting], [1234567, 2983, 12.5]);
  assert.ok(seen.some(([k, v]) => k === 'county' && v === 'not-a-county'));
});

test('parseReporting / parseReportingTime', () => {
  assert.deepEqual(parseReporting('% (0 of 0) precincts reporting'), { reporting: 0, total: 0, pct: null });
  assert.deepEqual(parseReporting(null), { reporting: null, total: null, pct: null });
  assert.equal(parseReportingTime('November 3, 2026, 11:05 p.m.'), '2026-11-04T07:05:00.000Z');
  assert.equal(parseReportingTime('November 3, 2026, 12:10 a.m.'), '2026-11-03T08:10:00.000Z');
  assert.equal(parseReportingTime(null), null);
});

test('CA down-ballot endpoints: statewide offices (with counties), legislature and BOE districts are all emitted', async () => {
  const { enrichRaces } = await import('../src/contests.js');
  const f = files();
  f.candidate.push(
    { office: 'attorney_general', level: 'statewide', key: 'attorney-general', map: load('maps_attorney-general.json') },
    { office: 'superintendent_of_public_instruction', level: 'statewide', key: 'superintendent-of-public-instruction',
      statewide: load('superintendent-of-public-instruction.json') },
  );
  f.districts = [
    { spec: { slug: 'state-senate/district/all', level: 'legislative', office: 'state_senate', keyPrefix: 'state-senate' },
      list: load('state-senate_district_all.json') },
    { spec: { slug: 'state-assembly/district/all', level: 'legislative', office: 'state_house', keyPrefix: 'state-assembly' },
      list: load('state-assembly_district_all.json') },
    { spec: { slug: 'board-of-equalization/district/all', level: 'statewide', office: 'board_of_equalization', keyPrefix: 'board-of-equalization' },
      list: load('board-of-equalization_district_all.json') },
  ];
  const { r, seen } = parse(f);
  const ag = r.races.find((x) => x.key === 'attorney-general');
  assert.equal(ag.name, 'Attorney General');
  assert.deepEqual([ag.level, ag.office], ['statewide', 'attorney_general']);
  assert.deepEqual(ag.units.map((u) => [u.level, u.countyFips ?? null]), [['state', null], ['county', '06001']]);
  const spi = r.races.find((x) => x.key === 'superintendent-of-public-instruction');
  assert.deepEqual(spi.choices.map((c) => c.party), ['OTHER', 'OTHER']);

  const sd = r.races.filter((x) => x.office === 'state_senate');
  assert.deepEqual(sd.map((x) => [x.key, x.name, x.district]), [
    ['state-senate-2', 'State Senate District 2', '2'], ['state-senate-4', 'State Senate District 4', '4']]);
  assert.equal(r.races.filter((x) => x.office === 'state_house').length, 2);
  assert.equal(r.races.filter((x) => x.office === 'board_of_equalization').length, 4);
  // Peace & Freedom is a known third party (OTHER): not logged as unknown.
  assert.ok(!seen.some(([k, v]) => k === 'party' && v === 'P&F'));

  const unclassified = enrichRaces(r, 'casos');
  assert.deepEqual(unclassified, []);
  // Top races unchanged.
  assert.deepEqual([r.races.find((x) => x.key === 'governor').level, r.races.find((x) => x.key === 'governor').office], ['statewide', 'governor']);
  assert.ok(r.races.filter((x) => x.office === 'house').every((x) => x.level === 'federal'));
  assert.ok(r.races.filter((x) => x.office === 'measure').every((x) => x.kind === 'yes_no'));
});

test('CA targets: headline races only for coverage, allContests false (per-race endpoints)', async () => {
  const { default: casos } = await import('../src/adapters/casos.js');
  const [t] = casos.targets();
  assert.deepEqual(t.races.sort(), ['governor', 'house']);
  assert.equal(t.allContests, false);
  assert.ok(t.districtRaces.length >= 3);
  assert.ok(t.candidateRaces.length <= 10, 'a handful of requests per poll, not hundreds');
});
