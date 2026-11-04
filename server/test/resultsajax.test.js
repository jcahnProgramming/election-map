// Parser tests against real ResultsAjax.svc responses captured on election night 2026-11-03 (OR, NM, NE, SD), before
// any county had reported (all counts 0, NM "*"). One test injects numbers to check the sums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseResultsAjax, parseCategoryPage, rowsOf, contestName, fusionParty, turnoutHash } from '../src/adapters/resultsajax.js';
import adapter from '../src/adapters/resultsajax.js';
import { enrichRaces } from '../src/contests.js';

const dir = new URL('./fixtures/resultsajax/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const json = (f) => rowsOf(JSON.parse(read(f)));
const target = (st) => adapter.targets().find((t) => t.state === st);

function parse(st, files, edit = (c) => c) {
  const unmatched = [];
  const contests = files.map((f) => {
    const [, type, raceId] = f.match(/^\w+-(\w+)-(\d+)\.json$/);
    return { type, raceId, rows: json(f) };
  });
  const r = parseResultsAjax({ contests: edit(contests), turnout: json(`${st.toLowerCase()}-turnout.json`) }, target(st), (...a) => unmatched.push(a));
  return { r, unmatched };
}

test('targets(): OR, NM, NE, SD from config, OR zeroes the osn', () => {
  const ts = adapter.targets();
  assert.deepEqual(ts.map((t) => t.state).sort(), ['NE', 'NM', 'OR', 'SD']);
  assert.equal(target('OR').zeroOsn, true);
  assert.equal(target('NM').service, 'https://nmresultswebservice.azurewebsites.us/NMResultsAjax.svc');
  assert.ok(ts.every((t) => t.allContests && t.categories.length && t.detailTypes.length));
});

test('parseCategoryPage: the contests behind the "County Results" buttons', () => {
  const or = parseCategoryPage(read('or-page-FED.html'));
  assert.equal(or.length, 7);
  assert.deepEqual(or[0], { type: 'FED', raceId: '300038695', osn: '0', party: '' });
  const ne = parseCategoryPage(read('ne-page-CG.html'));
  assert.deepEqual(ne.map((r) => [r.type, r.raceId, r.osn]), [['CG', '13165', '103'], ['CG', '13166', '103'], ['CG', '13167', '103']]);
});

test('rowsOf: { d: [...] } (OR, NE, SD) and a bare array (NM)', () => {
  assert.equal(rowsOf({ d: [1] }).length, 1);
  assert.equal(rowsOf([1, 2]).length, 2);
  assert.throws(() => rowsOf({ Message: 'error' }));
});

test('contestName: NE districts come from AreaNum; never doubled', () => {
  assert.equal(contestName({ RaceName: 'For Representative in Congress - 2  Year Term', AreaNum: 'District 1' }), 'For Representative in Congress - 2 Year Term - District 1');
  assert.equal(contestName({ RaceName: 'United States Representative DISTRICT 1', AreaNum: '' }), 'United States Representative DISTRICT 1');
  assert.equal(contestName({ RaceName: 'US Senator', AreaNum: 'Federal' }), 'US Senator');
  assert.equal(contestName({ RaceName: 'State Senator District 08', AreaNum: 'District 8' }), 'State Senator District 08');
});

test('fusionParty: one major party on a fusion line decides; unknown parts are logged', () => {
  const un = [];
  assert.equal(fusionParty('Democrat, Working Families', (...a) => un.push(a)), 'DEM');
  assert.equal(fusionParty('Republican, Libertarian'), 'REP');
  assert.equal(fusionParty('Progressive, Pacific Green'), 'OTHER');
  assert.equal(fusionParty('Republican, Democrat'), 'OTHER');
  assert.equal(fusionParty('Nonpartisan'), 'OTHER');
  assert.deepEqual(un, []);
  fusionParty('Democrat, Space Party', (...a) => un.push(a), 'ctx');
  assert.deepEqual(un, [['party', 'Space Party', 'ctx']]);
});

test('turnoutHash ignores CurrentDateTime (the server clock), not the counts', () => {
  const rows = json('ne-turnout.json');
  const later = rows.map((r) => ({ ...r, CurrentDateTime: '11/3/2026 9:00:00 PM' }));
  assert.equal(turnoutHash(rows), turnoutHash(later));
  const moved = rows.map((r, i) => (i ? r : { ...r, PrecinctsReporting: 1 }));
  assert.notEqual(turnoutHash(rows), turnoutHash(moved));
});

test('OR: Senate and Governor statewide by county, fusion lines, ballots counted, House precincts unknown', () => {
  const { r, unmatched } = parse('OR', ['or-FED-300038695.json', 'or-FED-300038696.json', 'or-SWPAR-300038702.json']);
  assert.deepEqual(unmatched, []);
  assert.equal(r.sourceUpdatedAt, null);
  assert.deepEqual(r.turnout[0], { level: 'state', name: 'OR', registered: 3109554, ballotsCast: 0, turnoutPct: 0, precinctsReporting: 0, precinctsTotal: 1318 });
  assert.equal(r.turnout.length, 37);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.statewide, true);
  assert.equal(sen.key, 'FED/300038695');
  assert.deepEqual(sen.choices.map((c) => [c.name, c.party]), [
    ['David Brock Smith', 'REP'], ['Jeff Merkley', 'DEM'], ['Gary Lyndon Dye', 'OTHER'], ['Chris Henry', 'OTHER'], ['Write-in', 'OTHER'],
  ]);
  assert.equal(sen.choices[1].partyRaw, 'Democrat, Working Families');
  assert.equal(sen.units.filter((u) => u.level === 'county').length, 36);
  assert.deepEqual([sen.units[0].precinctsReporting, sen.units[0].precinctsTotal], [0, 1318]);
  const h1 = r.races.find((x) => x.office === 'house');
  assert.equal(h1.district, '1');
  assert.equal(h1.statewide, false);
  assert.equal(h1.units[0].precinctsTotal, null, 'county-wide precinct counts are not the district\'s');
  assert.ok(h1.units.filter((u) => u.level === 'county').every((u) => u.precinctsTotal === null));
  assert.equal(r.races.find((x) => x.office === 'governor').voteFor, 1);
});

test('NE: House districts named from AreaNum, statewide For/Against amendment, no ballots-counted figure', () => {
  const { r, unmatched } = parse('NE', ['ne-SW-13224.json', 'ne-CG-13165.json', 'ne-PA-2624.json', 'ne-SE-13213.json']);
  assert.deepEqual(unmatched, []);
  assert.equal(r.turnout[0].ballotsCast, null, 'NE publishes no ballots-counted number');
  assert.equal(r.turnout[0].registered, 1265162);
  const h = r.races.find((x) => x.office === 'house');
  assert.equal(h.name, 'For Representative in Congress - 2 Year Term - District 1');
  assert.equal(h.district, '1');
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.units.filter((u) => u.level === 'county').length, 93);
  assert.equal(sen.choices.find((c) => c.name === 'Dan Osborn').partyRaw, 'By Petition');
  const m = r.races.find((x) => x.office === 'measure');
  assert.equal(m.statewide, true);
  assert.equal(m.title, 'Proposed Amendment No. 1');
  assert.deepEqual([m.units[0].yes, m.units[0].no], [0, 0]);
  enrichRaces(r, 'resultsajax');
  assert.equal(r.races.find((x) => /State Board of Education/.test(x.name)).office, 'state_board_of_education');
});

test('SD: "(Vote Center)" counties match; Senate, at-large House, amendment, legislature', () => {
  const { r, unmatched } = parse('SD', ['sd-SWR-14412.json', 'sd-SWR-14869.json', 'sd-BQ-226.json', 'sd-LEG-14430.json']);
  assert.deepEqual(unmatched, []);
  assert.equal(r.turnout.length, 67);
  assert.ok(r.turnout.some((u) => u.name === 'Brookings'));
  const h = r.races.find((x) => x.office === 'house');
  assert.equal(h.district, 'AL');
  assert.equal(h.statewide, true);
  assert.equal(r.races.find((x) => x.office === 'senate').units.length, 67);
  assert.equal(r.races.find((x) => x.office === 'measure').statewide, true);
  enrichRaces(r, 'resultsajax');
  assert.equal(r.races.find((x) => /State Senator/.test(x.name)).level, 'legislative');
});

test('NM: bare arrays, "*" before a county reports, governor ticket, local contest', () => {
  const { r, unmatched } = parse('NM', ['nm-FED-11185.json', 'nm-FED-11186.json', 'nm-SW-11530.json', 'nm-SW-1375.json', 'nm-LGX-11199.json']);
  assert.deepEqual(unmatched, []);
  assert.equal(r.turnout.length, 34);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.units[0].votes, [0, 0]);
  assert.equal(sen.units.length, 34);
  assert.equal(r.races.find((x) => x.office === 'governor').choices[1].name, 'DEB HAALAND AND STEPHANIE GARCIA RICHARD');
  const m = r.races.find((x) => x.office === 'measure');
  assert.equal(m.statewide, true);
  const local = r.races.find((x) => /State Representative/.test(x.name));
  assert.equal(local.statewide, false);
  assert.equal(local.units[0].name, local.name);
});

test('sums: county votes add up to the state; two rows for one county are merged', () => {
  const { r } = parse('NM', ['nm-FED-11185.json'], (cs) => cs.map((c) => ({
    ...c,
    rows: [
      ...c.rows.map((row) => (row.CountyName === 'Santa Fe'
        ? { ...row, calcCandidateVotes: row.BallotOrder === 1 ? '1,200' : '300', PrecinctsReporting: 50 }
        : row.CountyName === 'Bernalillo' ? { ...row, calcCandidateVotes: row.BallotOrder === 1 ? 900 : 700, PrecinctsReporting: 100 } : row)),
      // a second block for Santa Fe under a suffixed name (as SD's vote centers): merged into the one county unit
      ...c.rows.filter((row) => row.CountyName === 'Santa Fe').map((row) => ({ ...row, CountyName: 'Santa Fe (Vote Center)', calcCandidateVotes: 10, PrecinctsReporting: 1, TotalPrecincts: 2 })),
    ],
  })));
  const sen = r.races[0];
  assert.deepEqual(sen.units[0].votes, [2110, 1010]);
  assert.equal(sen.units[0].precinctsReporting, 151);
  assert.equal(sen.units[0].precinctsTotal, 2206);
  const sf = sen.units.filter((u) => u.name === 'Santa Fe');
  assert.equal(sf.length, 1);
  assert.deepEqual(sf[0].votes, [1210, 310]);
  assert.deepEqual([sf[0].precinctsReporting, sf[0].precinctsTotal], [51, 187]);
});

test('polling: turnout is the change check; headline contests every change; others swept in bounded batches', async () => {
  const page = read('ne-page-CG.html') + "BuildCounty('SW', '13224', '102', '')";
  const files = { 13224: 'ne-SW-13224.json', 13165: 'ne-CG-13165.json', 13166: 'ne-CG-13165.json', 13167: 'ne-CG-13165.json' };
  let turnout = read('ne-turnout.json');
  const calls = [];
  const http = {
    get: async (url) => {
      calls.push(url);
      if (url.includes('GetVoterTurnoutData')) return { text: turnout };
      if (url.includes('resultsSW.aspx')) return { text: page };
      const id = url.match(/raceID=(\d+)/)[1];
      return { text: read(files[id]) };
    },
  };
  const t = { ...target('NE'), key: 'NE/test', categories: ['CG'], detailTypes: ['SW'], requestGapMs: 0, sweepBatch: 2, sweepSeconds: 3600, discoverSeconds: 3600 };
  const ctx = { http, log: {}, unmatched: () => {} };
  const poll = async () => {
    calls.length = 0;
    const res = await adapter.fetch(t, ctx);
    return { res, n: calls.length, maps: calls.filter((u) => u.includes('GetMapData')).length };
  };
  let p = await poll(); // turnout + 1 page + 1 headline + 2 of the 3 swept
  assert.equal(p.res.changed, true);
  assert.deepEqual([p.n, p.maps], [5, 3]);
  assert.equal(p.res.result.races.length, 3);
  p = await poll(); // the last swept contest
  assert.deepEqual([p.n, p.maps], [2, 1]);
  assert.equal(p.res.result.races.length, 4);
  p = await poll(); // nothing moved: one request, no new snapshot
  assert.deepEqual([p.n, p.res.changed], [1, false]);
  turnout = JSON.stringify({ d: JSON.parse(turnout).d.map((r) => ({ ...r, CurrentDateTime: 'later' })) });
  p = await poll(); // only the server clock moved: still one request
  assert.deepEqual([p.n, p.res.changed], [1, false]);
  turnout = JSON.stringify({ d: JSON.parse(turnout).d.map((r, i) => (i ? r : { ...r, PrecinctsReporting: 1 })) });
  p = await poll(); // counts moved: headline re-read; the sweep waits for sweepSeconds
  assert.deepEqual([p.n, p.maps], [2, 1]);
  assert.equal(p.res.changed, true);
});
