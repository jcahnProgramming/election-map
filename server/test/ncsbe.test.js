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
  assert.ok(!r.races.some((x) => /COURT/.test(x.name)), 'judicial contests are not tracked');
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
