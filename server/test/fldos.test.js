import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFl, parseTsv } from '../src/adapters/fldos.js';

// The live extract as it was on election night before the first counts: a header row only.
const headerOnly = readFileSync(fileURLToPath(new URL('./fixtures/fldos/header-only-2026-11-03.tsv', import.meta.url)), 'utf8');
const target = { key: 'FL-2026-general', state: 'FL', races: ['senate', 'governor', 'house'], measures: true };

test('FL: header-only extract parses to no rows and no races', () => {
  assert.equal(parseTsv(headerOnly).length, 0);
  const r = parseFl(headerOnly, target);
  assert.equal(r.rowCount, 0);
  assert.deepEqual(r.races, []);
});

test('FL: empty or blank input does not throw', () => {
  for (const s of ['', '\r\n', '﻿']) assert.deepEqual(parseFl(s, target).races, []);
});

// Rows built on the live header (column names verified tonight); values are illustrative, not real counts.
const head = headerOnly.replace(/\r?\n$/, '');
const row = (o) => head.split('\t').map((h) => o[h.trim()] ?? '').join('\t');
const base = { ElectionDate: '11/3/2026', Precincts: '10', PrecinctsReporting: '0', CanVotes: '0' };
const tsv = [head,
  row({ ...base, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Alachua', CanNameLast: 'Roe', CanNameFirst: 'Ann' }),
  row({ ...base, PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Alachua', CanNameLast: 'Doe', CanNameFirst: 'Bo' }),
  row({ ...base, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Miami-Dade', CanNameLast: 'Roe', CanNameFirst: 'Ann', Precincts: '', PrecinctsReporting: '' }),
  row({ ...base, PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'USR', OfficeDesc: 'United States Representative', Juris1num: '07', CountyName: 'Seminole', CanNameLast: 'Lee', CanNameFirst: 'Cy' }),
  row({ ...base, PartyCode: 'XYZ', PartyName: 'Mystery Party', RaceCode: 'USR', OfficeDesc: 'United States Representative', Juris1num: '07', CountyName: 'Atlantis', CanNameLast: 'Fox', CanNameFirst: 'Di' }),
].join('\r\n');

test('FL: zero-count rows, missing precincts, unknown county/party are handled and logged', () => {
  const unmatched = [];
  const { races } = parseFl(tsv, target, { unmatched: (...a) => unmatched.push(a) });
  const gov = races.find((r) => r.office === 'governor');
  assert.ok(gov.statewide);
  assert.deepEqual(gov.choices.map((c) => [c.name, c.party, c.partyRaw]), [['Ann Roe', 'REP', 'REP'], ['Bo Doe', 'DEM', 'DEM']]);
  assert.deepEqual(gov.units[0].votes, [0, 0]);
  assert.equal(gov.units.find((u) => u.name === 'Miami-Dade').precinctsTotal, null);
  assert.equal(gov.units[0].precinctsTotal, 10);
  const h = races.find((r) => r.office === 'house');
  assert.equal(h.district, '7');
  assert.ok(!h.statewide);
  assert.ok(unmatched.some(([k, v]) => k === 'county' && v === 'Atlantis'));
  assert.ok(unmatched.some(([k, v]) => k === 'party' && v === 'XYZ'));
});

test('FL: every contest is stored; retention is a Yes/No candidate race, not a measure; amendments stay measures', async () => {
  const { enrichRaces, resetContestRules } = await import('../src/contests.js');
  const counties = ['Alachua', 'Seminole'];
  const rows = [head];
  const add = (o) => rows.push(row({ ...base, ...o }));
  for (const CountyName of counties) {
    add({ CountyName, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CanNameLast: 'Roe', CanNameFirst: 'Ann' });
    add({ CountyName, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'ATG', OfficeDesc: 'Attorney General', CanNameLast: 'Uth', CanNameFirst: 'Al', CanVotes: '5' });
    add({ CountyName, PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'ATG', OfficeDesc: 'Attorney General', CanNameLast: 'Ott', CanNameFirst: 'Jo', CanVotes: '3' });
    add({ CountyName, RaceCode: 'CFO', OfficeDesc: 'Chief Financial Officer', PartyCode: 'REP', PartyName: 'Republican Party', CanNameLast: 'Ink', CanNameFirst: 'Lu' });
    add({ CountyName, RaceCode: 'SC1', OfficeDesc: 'Supreme Court Justice - Retain Jane Smith', CanNameLast: 'Yes', CanVotes: '7' });
    add({ CountyName, RaceCode: 'SC1', OfficeDesc: 'Supreme Court Justice - Retain Jane Smith', CanNameLast: 'No', CanVotes: '2' });
    add({ CountyName, RaceCode: 'A01', OfficeDesc: 'Amendment 1: Some Question', CanNameLast: 'Yes', CanVotes: '4' });
    add({ CountyName, RaceCode: 'A01', OfficeDesc: 'Amendment 1: Some Question', CanNameLast: 'No', CanVotes: '1' });
    add({ CountyName, RaceCode: 'DCA', OfficeDesc: 'First District Court of Appeal - Retain Bob Lee', CanNameLast: 'Yes' });
    add({ CountyName, RaceCode: 'DCA', OfficeDesc: 'First District Court of Appeal - Retain Bob Lee', CanNameLast: 'No' });
  }
  add({ CountyName: 'Alachua', PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'STS', OfficeDesc: 'State Senator', Juris1num: '09', CanNameLast: 'Kay', CanNameFirst: 'Em' });
  add({ CountyName: 'Alachua', PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'STR', OfficeDesc: 'State Representative', Juris1num: '21', CanNameLast: 'Vee', CanNameFirst: 'Di' });
  const unmatched = [];
  const r = { races: parseFl(rows.join('\r\n'), target, { unmatched: (...a) => unmatched.push(a) }).races, election: { scope: 'state', state: 'FL' } };
  const by = (n) => r.races.find((x) => x.name === n);

  const ag = by('Attorney General');
  assert.deepEqual([ag.office, ag.statewide, ag.voteFor, ag.units[0].name, ag.units[0].votes], [null, true, null, 'FL', [10, 6]]);
  const ss = by('State Senator, District 9');
  assert.deepEqual([ss.district, ss.statewide, ss.units[0].name, ss.units.length], ['9', false, 'State Senator, District 9', 2]);
  assert.ok(by('State Representative, District 21'));

  const ret = by('Supreme Court Justice - Retain Jane Smith');
  assert.notEqual(ret.office, 'measure');
  assert.deepEqual(ret.choices.map((c) => [c.name, c.party]), [['Yes', 'OTHER'], ['No', 'OTHER']]);
  assert.equal(ret.kind, 'retention');
  assert.equal(ret.units[0].yes, undefined);
  const am = by('Amendment 1');
  assert.deepEqual([am.office, am.title, am.statewide, am.units[0].yes, am.units[0].no], ['measure', 'Amendment 1: Some Question', true, 8, 2]);
  assert.ok(!unmatched.some(([k]) => k === 'party'));

  resetContestRules();
  assert.deepEqual(enrichRaces(r, 'fldos'), []);
  assert.deepEqual([ag.level, ag.office], ['statewide', 'attorney_general']);
  assert.deepEqual([ret.level, ret.office, ret.kind], ['judicial', 'supreme_court', 'retention']);
  const dca = by('First District Court of Appeal - Retain Bob Lee');
  assert.deepEqual([dca.level, dca.office, dca.kind], ['judicial', 'appeals_court', 'retention']);
  assert.deepEqual([by('Chief Financial Officer').level, by('Chief Financial Officer').office], ['statewide', 'chief_financial_officer']);
  assert.deepEqual([ss.level, ss.office], ['legislative', 'state_senate']);
  assert.deepEqual([am.level, am.kind], ['measure', 'yes_no']);
  assert.equal(by('Governor and Lieutenant Governor').office, 'governor');
});
