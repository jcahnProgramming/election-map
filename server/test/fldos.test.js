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
