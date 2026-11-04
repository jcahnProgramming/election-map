// Parser tests against the real Alaska precinct CSV captured on election night 2026-11-03 (before any results: all 0),
// trimmed to House districts 1-2 (their precincts plus the district-wide Absentee / Early Voting rows). One test
// injects numbers to check the sums, the method split and precincts reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseAkCsv, parseCsv } from '../src/adapters/akdoe.js';
import { enrichRaces } from '../src/contests.js';

const csv = readFileSync(new URL('./fixtures/akdoe/ak-26genr.csv', import.meta.url), 'utf8');
const t = adapter.targets()[0];
const toCsv = (rows) => rows.map((r) => r.map((f) => (/[",\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')).join('\n');

test('targets(): 26GENR from config, CSV path built from the election id', () => {
  assert.equal(t.key, 'AK/26GENR');
  assert.equal(t.csv, 'https://www.elections.alaska.gov/enr/26GENR/results/GA_ENR_Precinct_State_of_Alaska.csv');
  assert.deepEqual(t.levels, ['state']);
});

test('parseCsv: quoted fields with commas and doubled quotes; trailing comma', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e""",\n1,2,3,\n'), [['a', 'b, c', 'd "e"', ''], ['1', '2', '3', '']]);
});

test('every contest, parties (incl. a DEM/NON ticket), statewide vs district, retention, measures', () => {
  const un = [];
  const r = parseAkCsv(csv, t, (...a) => un.push(a), '2026-11-03T22:45:15.000Z');
  assert.deepEqual(un, []);
  assert.equal(r.sourceUpdatedAt, '2026-11-03T22:45:15.000Z');
  assert.deepEqual(r.turnout, [{ level: 'state', name: 'AK', registered: 31289, ballotsCast: 0, turnoutPct: 0, precinctsReporting: 0, precinctsTotal: 25 }]);
  assert.equal(r.races.length, 12);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => [c.name, c.party]), [['Heikes, Gerald L.', 'REP'], ['Peltola, Mary', 'DEM'], ['Sullivan, Daniel J. Jr.', 'OTHER'], ['Sullivan, Dan S.', 'REP']]);
  assert.equal(sen.statewide, true);
  assert.deepEqual(sen.units[0].methods.map((m) => [m.label, m.bucket]), [
    ['Election Day', 'election_day'], ['Absentee', 'mail_early'], ['Early Voting', 'mail_early'], ['Question', 'other'], ['Remote', 'other'],
  ]);
  assert.equal(r.races.find((x) => x.office === 'house').district, 'AL');
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.choices.find((c) => c.partyRaw === 'DEM/NON').party, 'DEM');
  const hd1 = r.races.find((x) => x.name === 'House District 1');
  assert.equal(hd1.statewide, false);
  assert.equal(hd1.units[0].name, 'House District 1');
  assert.equal(hd1.units[0].precinctsTotal, 10);
  const m = r.races.find((x) => x.office === 'measure');
  assert.deepEqual([m.units[0].yes, m.units[0].no], [0, 0]);
  enrichRaces(r, 'akdoe');
  assert.equal(r.races.find((x) => x.name === 'Senate District A').office, 'state_senate');
  assert.equal(r.races.find((x) => x.name === 'House District 1').office, 'state_house');
  assert.equal(r.races.find((x) => /Supreme Court/.test(x.name)).level, 'judicial');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'));
});

test('sums: precinct and district-wide absentee rows add up; methods; precincts reporting', () => {
  const rows = parseCsv(csv);
  const h = rows[0];
  const c = (k) => h.indexOf(k);
  for (const r of rows.slice(1)) {
    if (r[c('Contest_title')] !== 'U.S. Senator') continue;
    const peltola = r[c('candidate_name')] === 'Peltola, Mary';
    if (r[c('Pct_Id')] === '01-600') {
      r[c('Reporting_flag')] = '1';
      r[c('total_votes')] = peltola ? '300' : '100';
      r[c('Election Day_votes')] = r[c('total_votes')];
      r[c('total_ballots')] = '700';
    }
    if (r[c('Precinct_name')] === 'District 1 - Absentee') {
      r[c('total_votes')] = peltola ? '50' : '20';
      r[c('Absentee_votes')] = r[c('total_votes')];
      r[c('total_ballots')] = '130';
    }
  }
  const r = parseAkCsv(toCsv(rows), t);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.units[0].votes, [120, 350, 120, 120]);
  assert.deepEqual([sen.units[0].precinctsReporting, sen.units[0].precinctsTotal, sen.units[0].pctReporting], [1, 25, 4]);
  assert.deepEqual(sen.units[0].methods[0].votes, [100, 300, 100, 100]);
  assert.deepEqual(sen.units[0].methods[1].votes, [20, 50, 20, 20]);
  assert.equal(r.turnout[0].ballotsCast, 830);
  assert.equal(r.turnout[0].precinctsReporting, 1);
});

test('a changed header fails loudly instead of storing garbage', () => {
  assert.throws(() => parseAkCsv('Precinct,Votes\nx,1\n', t), /unexpected header/);
});

test('config/ca: the GlobalSign intermediate www.elections.alaska.gov leaves out is loaded into the trust store', async () => {
  const tls = await import('node:tls');
  const { loadExtraCAs } = await import('../src/http.js');
  if (typeof tls.setDefaultCACertificates !== 'function') return; // older Node: loader warns and skips
  assert.equal(loadExtraCAs(), 1);
  assert.ok(tls.getCACertificates('default').some((pem) => pem.includes(readFileSync(new URL('../../config/ca/globalsign-gcc-r46-ov-tls-ca-2025.pem', import.meta.url), 'utf8').split('-----BEGIN CERTIFICATE-----')[1].trim().slice(0, 64))));
});
