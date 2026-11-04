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
  // No U.S. Senate race in VT in 2026. Lt. Governor is stored too (office left to the contest rules).
  assert.deepEqual(r.races.map((x) => [x.office, x.name]), [['house', 'REPRESENTATIVE TO CONGRESS'], ['governor', 'GOVERNOR'], [null, 'LIEUTENANT GOVERNOR']]);
  const gov = r.races.find((x) => x.office === 'governor');
  // Fusion label: the raw label is kept, the party resolves to its first recognised part.
  const janoo = gov.choices.find((c) => c.name === 'AMANDA JANOO');
  assert.deepEqual([janoo.party, janoo.partyRaw], ['DEM', 'DEM/PROG']);
  assert.equal(gov.choices.at(-1).name, 'Write-ins');
  assert.deepEqual(gov.units.map((u) => [u.level, u.countyFips ?? null]),
    [['state', null], ['county', '50001'], ['county', '50007'], ['county', '50013']]);
  assert.ok(gov.units.every((u) => u.votes.every((v) => v === 0)));
  assert.ok(!seen.some(([k, v]) => k === 'party' && v === 'FREEDOM AND UNITY'));
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

test('VT 2026 down-ballot sections (live samples): State Senate / House districts, county offices, town offices', async () => {
  const { enrichRaces, resetContestRules } = await import('../src/contests.js');
  const seen = [];
  const sections = ['federal', 'stateWide', 'senate', 'house', 'county', 'town'].map((s) => rd('', `${s}.json`));
  const r = parseVt(rd('', 'index.json'), sections, rd('', 'turnout.json'), target, (...a) => seen.push(a));
  const by = (n) => r.races.find((x) => x.name === n);

  const sen = by('STATE SENATOR - ADDISON');
  assert.deepEqual([sen.level, sen.office, sen.district, sen.voteFor], ['legislative', 'state_senate', 'ADDISON', 2]);
  assert.equal(sen.units[0].name, 'ADDISON'); // the source's "District Wide" row
  assert.equal(sen.units[0].votes[sen.choices.findIndex((c) => c.name === 'RUTH HARDY')], 503);
  const ben4 = by('STATE REPRESENTATIVE - BENNINGTON-4');
  assert.deepEqual([ben4.office, ben4.voteFor], ['state_house', 2]);
  assert.equal(by('STATE REPRESENTATIVE - ADDISON-2').voteFor, 1);
  // The oid is shared by every district: keys are per district.
  assert.equal(new Set(r.races.map((x) => x.key)).size, r.races.length);

  const asj = by('ASSISTANT JUDGE - ADDISON COUNTY');
  assert.equal(asj.voteFor, 2); // 1 on the office, 2 on its rows: two are elected
  assert.equal(asj.jurisdiction, 'Addison');
  assert.equal(asj.units[0].name, 'Addison County');
  for (const n of ['PROBATE JUDGE', "STATE'S ATTORNEY", 'SHERIFF', 'HIGH BAILIFF']) assert.ok(by(`${n} - ADDISON COUNTY`), n);
  // Town offices with no result rows yet (Justice of the Peace before the town reports) have nothing to store yet.
  assert.ok(!r.races.some((x) => /JUSTICE OF THE PEACE/.test(x.name)));
  assert.ok(r.races.every((x) => x.choices.length > 0));

  resetContestRules();
  const unclassified = enrichRaces(r, 'vtsos');
  assert.deepEqual(unclassified, []);
  assert.deepEqual([by('SHERIFF - ADDISON COUNTY').level, by('SHERIFF - ADDISON COUNTY').office], ['county', 'sheriff']);
  assert.deepEqual([by("STATE'S ATTORNEY - ADDISON COUNTY").office], ['district_attorney']);
  assert.deepEqual([by('HIGH BAILIFF - ADDISON COUNTY').level], ['county']);
  assert.deepEqual([by('PROBATE JUDGE - ADDISON COUNTY').level], ['judicial']);
  assert.deepEqual([by('LIEUTENANT GOVERNOR').level, by('LIEUTENANT GOVERNOR').office], ['statewide', 'lieutenant_governor']);
  assert.equal(by('GOVERNOR').office, 'governor');
});

test('VT town contests and local questions: one race per town, a local question is a measure but not statewide', async () => {
  const { enrichRaces } = await import('../src/contests.js');
  const town = rd('', 'town.json');
  const row = (tid, tn, rc) => ({ tid, tn, distReported: '1/1', rc, wc: [] });
  // Justice of the Peace once Cornwall reports (shape of the live town file, rows filled in).
  town.d[0].o[0].cs = [row(66, 'CORNWALL', [{ cid: 1, cn: 'A SMITH', vc: 10, pn: 'DEMOCRATIC' }, { cid: 2, cn: 'B JONES', vc: 7, pn: 'REPUBLICAN' }])];
  town.d[0].o.push({ tid: 66, tn: 'CORNWALL', ldid: 0, ld: null, oid: 900, on: 'ARTICLE 1', vf: 1, otc: 'L', bq: 'Shall the town buy a fire truck?',
    cs: [row(66, 'CORNWALL', [{ cid: 3, cn: 'YES', vc: 30, pn: null }, { cid: 4, cn: 'NO', vc: 12, pn: null }])] });
  const seen = [];
  const r = parseVt(rd('', 'index.json'), [town], null, target, (...a) => seen.push(a));
  const jp = r.races.find((x) => /JUSTICE OF THE PEACE/.test(x.name));
  assert.equal(jp.name, 'JUSTICE OF THE PEACE - 2 YEARS - CORNWALL');
  assert.deepEqual([jp.jurisdiction, jp.voteFor, jp.key], ['Cornwall', 7, 't:17:66:0']);
  const q = r.races.find((x) => x.office === 'measure');
  assert.deepEqual([q.name, q.title, q.statewide, q.jurisdiction], ['ARTICLE 1 - CORNWALL', 'Shall the town buy a fire truck?', false, 'Cornwall']);
  assert.deepEqual([q.units[0].yes, q.units[0].no], [30, 12]);
  assert.ok(seen.some(([k, v]) => k === 'town' && v === 'CORNWALL')); // not in this fixture's townDistricts: logged
  assert.deepEqual(enrichRaces(r, 'vtsos'), []);
  assert.deepEqual([jp.level, jp.office], ['local', 'local_office']);
});

test('VT 2026 live, 7 of 247 towns in: reporting counts every town (7 of 282 districts), not just towns with rows', () => {
  const { r } = parse('2026-partial');
  const gov = r.races.find((x) => x.office === 'governor');
  const st = gov.units[0];
  // The section file has rows only for the 7 reported towns ("1/1" ×6, "1/2" ×1); the turnout file lists all 247.
  assert.deepEqual([st.precinctsReporting, st.precinctsTotal, st.pctReporting], [7, 282, 2.5]);
  assert.equal(st.votes[gov.choices.findIndex((c) => c.name === 'PHIL SCOTT')], 5080);
  assert.equal(st.votes[gov.choices.findIndex((c) => c.name === 'AMANDA JANOO')], 4431);
  const house = r.races.find((x) => x.office === 'house');
  assert.deepEqual([house.units[0].precinctsReporting, house.units[0].precinctsTotal], [7, 282]);
  for (const u of gov.units.slice(1)) {
    assert.ok(u.pctReporting < 100, `${u.name} county is not fully in: ${u.precinctsReporting}/${u.precinctsTotal}`);
  }
  assert.deepEqual([r.turnout[0].precinctsReporting, r.turnout[0].precinctsTotal], [7, 282]);
});

test('VT without a turnout file: a partial results file gives no precinct numbers rather than a false 100%', () => {
  const { r } = parse('2026-partial', (f) => ({ ...f, turnout: null }));
  const st = r.races.find((x) => x.office === 'governor').units[0];
  assert.deepEqual([st.precinctsReporting, st.precinctsTotal, st.pctReporting], [null, null, null]);
});
