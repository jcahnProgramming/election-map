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
  row({ ...base, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Alachua', CanNameLast: 'Mate', CanNameFirst: 'Roe' }),
  row({ ...base, PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Alachua', CanNameLast: 'Pal', CanNameFirst: 'Doe' }),
  row({ ...base, PartyCode: 'REP', PartyName: 'Republican Party', RaceCode: 'GOV', OfficeDesc: 'Governor and Lieutenant Governor', CountyName: 'Miami-Dade', CanNameLast: 'Mate', CanNameFirst: 'Roe', Precincts: '', PrecinctsReporting: '' }),
  row({ ...base, PartyCode: 'DEM', PartyName: 'Democratic Party', RaceCode: 'USR', OfficeDesc: 'United States Representative', Juris1num: '07', CountyName: 'Seminole', CanNameLast: 'Lee', CanNameFirst: 'Cy' }),
  row({ ...base, PartyCode: 'XYZ', PartyName: 'Mystery Party', RaceCode: 'USR', OfficeDesc: 'United States Representative', Juris1num: '07', CountyName: 'Atlantis', CanNameLast: 'Fox', CanNameFirst: 'Di' }),
].join('\r\n');

test('FL: zero-count rows, missing precincts, unknown county/party are handled and logged', () => {
  const unmatched = [];
  const { races } = parseFl(tsv, target, { unmatched: (...a) => unmatched.push(a) });
  const gov = races.find((r) => r.office === 'governor');
  assert.ok(gov.statewide);
  assert.deepEqual(gov.choices.map((c) => [c.name, c.runningMate, c.party, c.partyRaw]), [['Roe', 'Mate', 'REP', 'REP'], ['Doe', 'Pal', 'DEM', 'DEM']]);
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

// ---- Florida Election Watch (2026 general), real file: 20261103_ElecResultsFL.txt, Last-Modified 01:30:03Z.
// Verified against Election Watch's own "Contest Results by County" pages: Amendments 1-3 statewide identical;
// Senate / Governor identical in 66 of 67 counties (the page already showed a newer Columbia upload than the file).
const live = readFileSync(fileURLToPath(new URL('./fixtures/fldos/electionwatch-2026-11-04T0130Z.txt', import.meta.url)), 'utf8');
const flCfg = JSON.parse(readFileSync(new URL('../../config/sources/fldos.json', import.meta.url), 'utf8')).elections.find((e) => e.state === 'FL');
const liveTarget = { key: 'FL-2026-general', state: 'FL', ticketNames: flCfg.ticketNames.names };
const parseLive = (t = liveTarget) => { const un = []; const r = parseFl(live, t, { unmatched: (...a) => un.push(a) }); return { ...r, un }; };
const sw = (race) => race.units[0].votes;
const county = (race, name) => race.units.find((u) => u.name === name).votes;

test('FL live: Governor tickets show the top-of-ticket candidate, never the running mate', () => {
  const { races } = parseLive();
  const gov = races.find((r) => r.office === 'governor');
  const by = Object.fromEntries(gov.choices.map((c) => [c.partyRaw + ':' + c.name, c]));
  assert.equal(by['REP:Byron Donalds'].runningMate, 'Bryan Avila');
  assert.equal(by['DEM:David Jolly'].runningMate, 'Gwen Graham');
  const mates = new Set(gov.choices.map((c) => c.runningMate));
  for (const c of gov.choices) {
    assert.ok(!mates.has(c.name), `${c.name} is a running mate, not a candidate`);
    assert.ok(!c.name.includes('/'), `no ticket separator in "${c.name}"`);
  }
  assert.equal(gov.choices.length, 10);
  // Without the official full-name list: the file's own surnames, top of ticket first; nothing invented.
  const bare = parseLive({ key: 'x', state: 'FL' }).races.find((r) => r.office === 'governor');
  assert.deepEqual([bare.choices[0].name, bare.choices[0].runningMate], ['Donalds', 'Avila']);
  // Single-candidate races are untouched (first + middle + last).
  const sen = races.find((r) => r.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => c.name), ['Ashley Moody', 'Angie Nixon', 'Neil J. Gillespie']);
  assert.equal(sen.choices[0].runningMate, undefined);
});

test('FL live: RaceName column, party codes bucketed with raw labels kept, nothing unmatched', () => {
  const { races, un, rowCount } = parseLive();
  assert.equal(rowCount, 3063);
  assert.deepEqual(un, []);
  const sen = races.find((r) => r.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => [c.party, c.partyRaw]), [['REP', 'REP'], ['DEM', 'DEM'], ['OTHER', 'NPA']]);
  const gov = races.find((r) => r.office === 'governor');
  assert.equal(gov.choices.find((c) => c.partyRaw === 'LPF').party, 'OTHER');
  assert.ok(gov.choices.filter((c) => c.partyRaw === 'WRI').every((c) => c.party === 'OTHER'));
});

test('FL live: statewide and large-county totals equal the official file / Election Watch pages', () => {
  const { races } = parseLive();
  const sen = races.find((r) => r.office === 'senate');
  const gov = races.find((r) => r.office === 'governor');
  assert.equal(sen.units.length - 1, 67);
  assert.deepEqual(sw(sen), [3948914, 3782566, 88316]);
  assert.deepEqual(sw(gov).slice(0, 2), [3875246, 3838531]);
  assert.deepEqual(county(sen, 'Miami-Dade'), [344413, 398077, 8342]);
  assert.deepEqual(county(sen, 'Broward'), [204624, 408033, 6113]);
  assert.deepEqual(county(sen, 'Hillsborough'), [226707, 270892, 6015]);
  assert.deepEqual(county(gov, 'Miami-Dade').slice(0, 2), [344354, 397736]);
  const amd = (re) => races.find((r) => r.office === 'measure' && re.test(r.name));
  const a1 = amd(/Budget Stabilization/); const a2 = amd(/Tangible Personal Property/); const a3 = amd(/Increased Homestead/);
  assert.deepEqual([a1.units[0].yes, a1.units[0].no], [2986346, 4341242]);
  assert.deepEqual([a2.units[0].yes, a2.units[0].no], [4265830, 3110127]);
  assert.deepEqual([a3.units[0].yes, a3.units[0].no], [4626443, 2872292]);
  const bro = a1.units.find((u) => u.name === 'Broward');
  assert.deepEqual([bro.yes, bro.no], [217267, 358964]);
});

test('FL live: Amendments 1-3 attach to the measures config (config/elections/2026-general/measures/FL.json)', async () => {
  const { findMeasureInfo, resetMeasureInfo } = await import('../src/measureinfo.js');
  resetMeasureInfo();
  const { races } = parseLive();
  const ids = races.filter((r) => r.office === 'measure').map((r) => findMeasureInfo('2026-general', 'FL', r.name, r.title)?.measure_id ?? null);
  assert.deepEqual(ids.sort(), ['Amendment 1', 'Amendment 2', 'Amendment 3']);
});

test('FL Election Watch: the Downloads page own versioned link is used; other hosts are refused', async () => {
  const { findFileLink } = await import('../src/adapters/fldos.js');
  const page = 'https://floridaelectionwatch.gov/Downloads';
  const html = '<a href="https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt?v=202351267" title="Tab">x</a>';
  assert.equal(findFileLink(html, '20261103_ElecResultsFL.txt', page), 'https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt?v=202351267');
  assert.equal(findFileLink('<a href="https://evil.example/20261103_ElecResultsFL.txt?v=1">', '20261103_ElecResultsFL.txt', page), null);
  assert.equal(findFileLink('<p>no link</p>', '20261103_ElecResultsFL.txt', page), null);
});

test('FL Election Watch fetch: download only when the ETag moves; a stale all-zero copy never replaces counts', async () => {
  const adapter = (await import('../src/adapters/fldos.js')).default;
  const t = { key: 'FL-test-fetch', state: 'FL', label: 'FL', url: 'u', date: '2026-11-03', downloadsUrl: 'https://floridaelectionwatch.gov/Downloads',
    fileName: '20261103_ElecResultsFL.txt', ticketNames: flCfg.ticketNames.names };
  let etag = '"a"'; let body = live; const calls = [];
  const fileLink = 'https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt?v=1';
  const http = {
    get: async (url) => {
      if (url.includes('Downloads')) { calls.push('page'); return { text: `<a href="${fileLink}">` }; }
      calls.push('file');
      return { text: body, headers: new Headers({ etag, 'last-modified': 'Wed, 04 Nov 2026 01:30:03 GMT' }) };
    },
    head: async () => { calls.push('head'); return { headers: new Headers({ etag }) }; },
  };
  const ctx = { http, unmatched: () => {}, log: { info() {}, warn() {} } };
  const r1 = await adapter.fetch(t, ctx);
  assert.equal(r1.changed, true);
  assert.equal(r1.result.sourceUpdatedAt, '2026-11-04T01:30:03.000Z');
  assert.deepEqual(calls, ['page', 'head', 'file']);
  calls.length = 0;
  const r2 = await adapter.fetch(t, ctx);
  assert.equal(r2.changed, false);
  assert.deepEqual(calls, ['page', 'head']); // unchanged ETag: no download
  etag = '"b"'; body = live.replace(/\t\d+(\r?)$/gm, '\t0$1'); // a stale all-zero copy under a new ETag
  const r3 = await adapter.fetch(t, ctx);
  assert.equal(r3.changed, false);
});
