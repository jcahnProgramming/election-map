import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNcsbe, zonedToIso } from '../src/adapters/ncsbe.js';

// Real files from er.ncsbe.gov/enr/20261103/data/ captured 2026-11-03 before polls closed (trimmed to federal
// contests, referenda and one judicial contest). Counties: 1 Alamance, 13 Cabarrus, 92 Wake.
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/ncsbe/${f}`, import.meta.url), 'utf8'));
const target = { key: 'NC/20261103', state: 'NC', label: 'North Carolina 2026 General Election', date: '2026-11-03', url: 'https://er.ncsbe.gov/?election_dt=11/03/2026' };
const load = () => ({
  statewide: fx('results_0.txt'),
  counties: fx('county.txt'),
  countyResults: new Map(['1', '13', '92'].map((c) => [c, fx(`results_${c}.txt`)])),
});

test('NC: races, districts, measures and skipped offices', () => {
  const un = [];
  const r = parseNcsbe(load(), target, (...a) => un.push(a));
  const senate = r.races.filter((x) => x.office === 'senate');
  assert.equal(senate.length, 1);
  assert.equal(senate[0].name, 'US SENATE');
  const house = r.races.filter((x) => x.office === 'house');
  assert.deepEqual(house.map((h) => h.district), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']);
  const measures = r.races.filter((x) => x.office === 'measure');
  assert.equal(measures.filter((m) => m.statewide).length, 3);
  assert.ok(measures.find((m) => m.name === 'CITY OF RALEIGH HOUSING BONDS REFERENDUM').statewide === false);
  assert.equal(measures[0].title, measures[0].name);
  // Unknown party labels are reported, not dropped.
  assert.ok(!un.some(([k, v]) => k === 'party' && v === 'GRE')); // GRE is a known label now
  assert.ok(!un.some(([k]) => k === 'county'));
});

test('NC: units, precincts, methods, turnout and timestamp', () => {
  const r = parseNcsbe(load(), target);
  const senate = r.races.find((x) => x.office === 'senate');
  const st = senate.units[0];
  assert.equal(st.level, 'state');
  assert.equal(st.precinctsTotal, 2626);
  assert.deepEqual(senate.choices.find((c) => c.name === 'Roy Cooper'), { name: 'Roy Cooper', party: 'DEM', partyRaw: 'DEM' });
  assert.deepEqual(st.methods.map((m) => [m.label, m.bucket]), [
    ['Election Day', 'election_day'], ['Early Voting', 'mail_early'], ['Absentee by Mail', 'mail_early'], ['Provisional', 'provisional'],
  ]);
  const wake = senate.units.find((u) => u.countyFips === '37183');
  assert.equal(wake.name, 'Wake');
  assert.equal(senate.units.length, 4); // state + 3 county files in the fixture
  // A House district only gets units for counties that vote in it: NC-8 covers Cabarrus, not Alamance or Wake.
  const nc8 = r.races.find((x) => x.office === 'house' && x.district === '8');
  assert.deepEqual(nc8.units.map((u) => u.name), ['NC', 'Cabarrus']);

  const tState = r.turnout.find((t) => t.level === 'state');
  assert.equal(tState.registered, 7885046);
  assert.equal(tState.precinctsTotal, 2626);
  assert.equal(r.turnout.filter((t) => t.level === 'county').length, 100);
  assert.equal(r.sourceUpdatedAt, '2026-11-03T20:31:00.000Z'); // Alamance etc. 3:31 pm EST is the latest stamp
});

test('NC: vote values, method splits and measure yes/no', () => {
  const d = load();
  // Inject counts into the real rows so the arithmetic is exercised.
  for (const row of d.statewide) {
    if (row.gid === '1383' || row.gid === '1384') {
      const n = row.bnm.length * 100;
      Object.assign(row, { evc: String(n), ovc: String(n * 2), avc: '7', pvc: '1', vct: String(n * 3 + 8), prt: '1313' });
    }
  }
  const r = parseNcsbe(d, target);
  const senate = r.races.find((x) => x.office === 'senate');
  const st = senate.units[0];
  const i = senate.choices.findIndex((c) => c.name === 'Roy Cooper');
  assert.equal(st.votes[i], 1000 * 3 + 8);
  assert.equal(st.methods[0].votes[i], 1000);
  assert.equal(st.pctReporting, 50);
  const amend = r.races.find((x) => x.key === '1384');
  const s = amend.units[0];
  assert.equal(s.yes, 3 * 300 + 8); // "For"
  assert.equal(s.no, 7 * 300 + 8); // "Against"
  assert.deepEqual(s.methods[1].votes, [600, 1400]);
});

test('NC: Eastern timestamps to ISO', () => {
  assert.equal(zonedToIso('November 3, 2026 9:31 am'), '2026-11-03T14:31:00.000Z');
  assert.equal(zonedToIso('October 15, 2026 12:05 pm'), '2026-10-15T16:05:00.000Z');
  assert.equal(zonedToIso('November 4, 2026 12:10 am'), '2026-11-04T05:10:00.000Z');
  assert.equal(zonedToIso(''), null);
});

test('NC: every contest is emitted, not only the headline races', () => {
  const r = parseNcsbe(load(), target);
  // Statewide file: 1 Senate + 14 House + 1 judicial + 3 amendments + 4 local referenda; county-only contests from the
  // three county files: Cabarrus 2 bonds, Wake 3 (Knightdale, school, community college).
  assert.equal(r.races.length, 23 + 2 + 3);
  const court = r.races.find((x) => x.key === '1368');
  assert.equal(court.name, 'NC SUPREME COURT ASSOCIATE JUSTICE SEAT 01');
  assert.equal(court.office, null, 'left for contests.js to classify');
  assert.equal(court.voteFor, 1);
  assert.equal(court.statewide, true);
  assert.deepEqual(court.choices.map((c) => [c.name, c.party]), [['Anita Earls', 'DEM'], ['Sarah Stevens', 'REP']]);
  assert.deepEqual(court.units.map((u) => u.name), ['NC', 'Alamance', 'Cabarrus', 'Wake']);
  assert.ok(court.units.every((u) => u.methods?.length === 4));

  // A county-only referendum: only in Wake's file, keyed per county, total = the county, never statewide.
  const school = r.races.find((x) => x.name === 'WAKE COUNTY SCHOOL BONDS REFERENDUM');
  assert.equal(school.key, '92-23');
  assert.equal(school.office, 'measure');
  assert.equal(school.statewide, false);
  assert.deepEqual(school.units.map((u) => [u.level, u.name]), [['state', 'NC'], ['county', 'Wake']]);
  assert.equal(school.units[0].precinctsTotal, school.units[1].precinctsTotal);
  // Same small id in two counties stays two contests.
  assert.ok(r.races.find((x) => x.key === '13-9' && /CABARRUS COUNTY SCHOOL/.test(x.name)));
  // A local referendum that IS in the statewide file is not duplicated by its county copy.
  assert.equal(r.races.filter((x) => x.key === '800012').length, 1);
  assert.deepEqual(r.races.find((x) => x.key === '800012').units.map((u) => u.name), ['NC', 'Cabarrus']);
  assert.equal(new Set(r.races.map((x) => x.key)).size, r.races.length, 'keys are unique');
});

test('NC: legislature from the office group, multi-seat voteFor, retention-style yes/no is not a measure', () => {
  const d = load();
  const row = (gid, cnm, bnm, ogl, extra = {}) => ({
    cid: '0', cnm, vfr: '', gid, lid: gid, bnm, dtx: '', pty: '', vct: '5', pct: '0', prt: '1', ptl: '40',
    evc: '1', ovc: '2', avc: '1', pvc: '1', col: '', ogl, ref: '0', ...extra,
  });
  d.statewide.push(
    row('1500', 'NC HOUSE OF REPRESENTATIVES DISTRICT 040 (VOTE FOR 1)', 'Joe John', 'NCH', { pty: 'DEM', vfr: '1' }),
    row('1500', 'NC HOUSE OF REPRESENTATIVES DISTRICT 040 (VOTE FOR 1)', 'Jane Roe', 'NCH', { pty: 'REP', vfr: '1' }),
    row('1600', 'WAKE COUNTY BOARD OF EDUCATION AT-LARGE (VOTE FOR 3)', 'A', 'LOC'),
    row('1600', 'WAKE COUNTY BOARD OF EDUCATION AT-LARGE (VOTE FOR 3)', 'B', 'LOC'),
    row('1600', 'WAKE COUNTY BOARD OF EDUCATION AT-LARGE (VOTE FOR 3)', 'C', 'LOC'),
    row('1600', 'WAKE COUNTY BOARD OF EDUCATION AT-LARGE (VOTE FOR 3)', 'D', 'LOC'),
    row('1700', 'SHALL JUSTICE X OF THE SUPREME COURT BE RETAINED', 'Yes', 'JUD'),
    row('1700', 'SHALL JUSTICE X OF THE SUPREME COURT BE RETAINED', 'No', 'JUD'),
  );
  const un = [];
  const r = parseNcsbe(d, target, (...a) => un.push(a));
  const h = r.races.find((x) => x.key === '1500');
  assert.deepEqual([h.level, h.office, h.statewide, h.voteFor], ['legislative', 'state_house', false, 1]);
  assert.deepEqual(h.units[0].votes, [5, 5]);
  const board = r.races.find((x) => x.key === '1600');
  assert.equal(board.voteFor, 3, 'from the "(VOTE FOR 3)" suffix when vfr is empty');
  assert.equal(board.choices.length, 4);
  const ret = r.races.find((x) => x.key === '1700');
  assert.equal(ret.office, null, 'a judicial yes/no is not a ballot measure');
  assert.deepEqual(ret.choices.map((c) => c.name), ['Yes', 'No']);
  assert.deepEqual(ret.units[0].votes, [5, 5]);
  assert.equal(ret.units[0].yes, undefined);
  assert.ok(!un.some(([k, v]) => k === 'party' && v === ''), 'an empty party label is not an unknown party');
});
