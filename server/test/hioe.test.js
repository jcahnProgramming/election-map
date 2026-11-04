// Parser tests against Hawaii's real 2026 Primary summary.txt (same "#FormatVersion 1" file the general will use) and
// the "Placeholders" text the results page links before the first general release (captured 2026-11-03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseHiSummary } from '../src/adapters/hioe.js';
import { HttpError } from '../src/http.js';
import { enrichRaces } from '../src/contests.js';

const read = (f) => readFileSync(new URL(`./fixtures/hioe/${f}`, import.meta.url), 'utf8');
const t = { key: 'HI/2026 Primary', state: 'HI', label: 'Hawaii 2026 Primary', url: 'https://elections.hawaii.gov/election-results/', summary: 'https://example/summary.txt' };

test('config: the 2026 General folder is parked until its first release', () => {
  assert.deepEqual(adapter.targets(), []);
});

test('primary summary: every contest, party ballots kept apart, Roman-numeral House districts, methods', () => {
  const un = [];
  const r = parseHiSummary(read('hi-2026primary-summary.txt'), t, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.equal(r.races.length, 136);
  assert.deepEqual(r.turnout, [{ level: 'state', name: 'HI', registered: 846543, ballotsCast: null, turnoutPct: null, precinctsReporting: 494, precinctsTotal: 494 }]);
  const d1 = r.races.find((x) => x.name === 'U.S. Representative, Dist I (D)');
  assert.equal(d1.office, 'house');
  assert.equal(d1.district, '1');
  assert.deepEqual(d1.units[0].votes, [2433, 63784, 1025, 40848, 1025]);
  assert.ok(d1.choices.every((c) => c.party === 'DEM' && c.partyRaw === 'D'));
  assert.deepEqual(d1.units[0].methods.map((m) => [m.label, m.bucket]), [['Mail Votes', 'mail_early'], ['In-Person Votes', 'other']]);
  assert.equal(d1.units[0].methods[0].votes[1] + d1.units[0].methods[1].votes[1], 63784);
  assert.equal(r.races.find((x) => x.name === 'U.S. Representative, Dist II (R)').district, '2');
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.statewide, true);
  assert.deepEqual([gov.units[0].precinctsReporting, gov.units[0].precinctsTotal], [494, 494]);
  enrichRaces(r, 'hioe');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'));
});

test('a general-style row: the candidate party column decides', () => {
  const head = read('hi-2026primary-summary.txt').split(/\r?\n/).slice(0, 2).join('\n');
  const row = (cand, party, seq, mail, inp) => ['900', '"Governor"', '1', 'OF', '', '0', '0', '0', '0', '0', '0', '900000', '494', '10', String(seq), `"${cand}"`, String(seq), party, String(mail), String(inp), String(mail + inp)].join('\t');
  const r = parseHiSummary([head, row('GREEN, Josh', 'D', 1, 100, 20), row('AIONA, Duke', 'R', 2, 80, 30), row('SMITH, Ann', 'L', 3, 5, 1)].join('\n'), t);
  const gov = r.races[0];
  assert.equal(gov.name, 'Governor');
  assert.deepEqual(gov.choices.map((c) => c.party), ['DEM', 'REP', 'OTHER']);
  assert.deepEqual(gov.units[0].votes, [120, 110, 6]);
  assert.deepEqual([gov.units[0].precinctsReporting, gov.units[0].pctReporting], [10, 2]);
});

test('fetch: 404 and the placeholder text write nothing; the real file does', async () => {
  let reply = () => { throw new HttpError(t.summary, 404); };
  const http = { get: async () => reply() };
  const ctx = { http, unmatched: () => {} };
  assert.equal((await adapter.fetch(t, ctx)).changed, false);
  reply = () => ({ text: read('hi-placeholder-summary.txt'), headers: new Headers() });
  assert.equal((await adapter.fetch(t, ctx)).changed, false);
  reply = () => ({ text: read('hi-2026primary-summary.txt'), headers: new Headers({ etag: '"abc"', 'last-modified': 'Sun, 09 Aug 2026 08:00:00 GMT' }) });
  const res = await adapter.fetch(t, ctx);
  assert.equal(res.changed, true);
  assert.equal(res.result.sourceUpdatedAt, '2026-08-09T08:00:00.000Z');
  assert.equal((await adapter.fetch(t, ctx)).changed, false, 'same ETag: no new snapshot');
});

test('a file without the header fails loudly', () => {
  assert.throws(() => parseHiSummary('#FormatVersion 1\nfoo\tbar\n', t), /header/);
});
