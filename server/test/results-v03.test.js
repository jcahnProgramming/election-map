// 0.3: offices from data, any statewide office on the map, multi-seat contests, the All-races list, measure info merge.
// Runs against a private CONFIG_DIR so the researched measure files can change without breaking these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realConfig = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config');
const dir = mkdtempSync(path.join(tmpdir(), 'em-cfg-'));
copyFileSync(path.join(realConfig, 'contest-rules.json'), path.join(dir, 'contest-rules.json'));
copyFileSync(path.join(realConfig, 'races-2026.json'), path.join(dir, 'races-2026.json'));
writeFileSync(path.join(dir, 'elections.json'), JSON.stringify({
  current: '2026-general', elections: [{ key: '2026-general', name: 'G', date: '2026-11-03', races: 'races-2026.json' }],
}));
writeFileSync(path.join(dir, 'official-results.json'), JSON.stringify({
  election: '2026-general', states: { CO: { url: 'https://example.gov/co', office: 'Colorado Secretary of State' } },
}));
mkdirSync(path.join(dir, 'elections', '2026-general', 'measures'), { recursive: true });
const site = (value) => ({ value, source_url: 'https://example.gov/filing', as_of: '2026-11-03' });
writeFileSync(path.join(dir, 'elections', '2026-general', 'measures', 'CO.json'), JSON.stringify({
  state: 'CO', measures: [
    {
      measure_id: 'Amendment 81', match: ['Amendment 81'],
      official_title: { value: 'An amendment about things', source_url: 'https://example.gov/t', as_of: '2026-11-03' },
      official_summary: { value: null, source_url: null, as_of: '2026-11-03' },
      placed_by: { type: 'initiative', proponent_name: 'Jane Q. Public', source_url: 'https://example.gov/p', as_of: '2026-11-03' },
      proponent_website: { ...site('https://yes.example'), reviewed: false },
      opposition_committee_name: site('No on 81'),
      opposition_website: { ...site('https://no.example'), reviewed: true },
      party_positions: [
        { party: 'Zeta Party', position: 'oppose', source_url: 'https://z.example', as_of: '2026-11-03', reviewed: true },
        { party: 'Alpha Party', position: 'support', source_url: 'https://a.example', as_of: '2026-11-03', reviewed: true },
        { party: 'Unreviewed Party', position: 'support', source_url: 'https://u.example', as_of: '2026-11-03', reviewed: false },
      ],
    },
    { measure_id: 'Amendment 8', match: ['Amendment 8'], official_title: { value: 'Not in any feed', source_url: 'https://example.gov/8', as_of: '2026-11-03' } },
  ],
}));
process.env.CONFIG_DIR = dir;

const { openDb, writeSnapshot } = await import('../src/db.js');
const { createResults } = await import('../src/results.js');

const adapter = {
  id: 'fake', name: 'Fake ENR', fetch: async () => ({ changed: false }),
  targets: () => [
    { key: 'CO/1', state: 'CO', scope: 'state', levels: ['state', 'county'] },
    { key: 'CA/1', state: 'CA', scope: 'state', levels: ['state'], allContests: false },
  ],
};
const cand = (name, party, partyRaw = party) => ({ name, party, partyRaw });
const st = (votes) => ({ level: 'state', votes, precinctsReporting: 50, precinctsTotal: 100 });
const cty = (fips, name, votes) => ({ level: 'county', countyFips: fips, name, votes });

function seed() {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'CO/1', state: 'CO', scope: 'state', name: 'CO' },
    races: [
      { office: 'senate', key: '1', name: 'United States Senator', choices: [cand('R', 'REP'), cand('D', 'DEM')],
        units: [st([400, 500]), cty('08031', 'Denver', [100, 300]), cty('08041', 'El Paso', [300, 200])] },
      { key: '2', name: 'Attorney General', choices: [cand('A', 'DEM'), cand('B', 'REP')],
        units: [st([510, 490]), cty('08031', 'Denver', [300, 100]), cty('08041', 'El Paso', [210, 390])] },
      // A county's own treasurer in the statewide feed: must never be the state map's Treasurer.
      { key: '3', name: 'Treasurer', choices: [cand('T1', 'DEM'), cand('T2', 'REP')], units: [st([5, 9]), cty('08031', 'Denver', [5, 9])] },
      { key: '4', name: 'Regent of the University of Colorado - At Large', voteFor: 2,
        choices: [cand('U1', 'DEM'), cand('U2', 'REP'), cand('U3', 'DEM')], units: [st([300, 200, 250])] },
      { key: '5', name: 'State Senator - District 12', choices: [cand('S1', 'DEM'), cand('S2', 'REP')], units: [st([60, 40])] },
      { key: '6', name: 'Shall Justice Pat Doe of the Colorado Supreme Court be retained in office?',
        choices: [cand('Yes', 'OTHER', ''), cand('No', 'OTHER', '')], units: [st([700, 300])] },
      { key: '7', name: 'Mayor - City of Boulder', choices: [cand('Ann Lee', 'OTHER', 'NP'), cand('Bo Kim', 'OTHER', 'NP')], units: [st([12, 10])] },
      { key: '8', name: 'Keeper of the Royal Swans', choices: [cand('Q', 'OTHER', '')], units: [st([1])] },
      { office: 'measure', key: '9', name: 'Amendment 81 (Constitutional)', choices: [cand('Yes/For', 'OTHER'), cand('No/Against', 'OTHER')],
        units: [{ ...st([300, 100]), yes: 300, no: 100 }] },
    ],
  });
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: 'CA/1', state: 'CA', scope: 'state', name: 'CA' },
    races: [{ office: 'governor', key: 'g', name: 'Governor', choices: [cand('G1', 'DEM'), cand('G2', 'REP')], units: [st([10, 5])] }],
  });
  return createResults(db, [adapter]);
}

test('offices: built from the data; districted, county and multi-seat-only offices handled', () => {
  const o = seed().offices();
  assert.deepEqual(o.levels.federal.map((x) => x.office), ['senate', 'house']);
  const state = o.levels.state.map((x) => x.office);
  assert.equal(state[0], 'governor');
  assert.ok(state.includes('attorney_general'));
  assert.ok(state.includes('university_regent'));
  assert.ok(!state.includes('treasurer'), 'a single county\'s treasurer is not a statewide office');
  assert.ok(!state.includes('state_senate'));
  assert.deepEqual(o.levels.state.find((x) => x.office === 'attorney_general').states, ['CO']);
  assert.equal(o.levels.state.find((x) => x.office === 'university_regent').multiSeat, true);
});

test('national map for a statewide office: honest statuses and the official link', () => {
  const r = seed();
  const n = r.national('attorney_general');
  const co = n.states.find((s) => s.state === 'CO');
  assert.equal(co.status, 'reporting');
  assert.equal(co.leader, 'DEM');
  assert.equal(co.marginPts, 2);
  assert.deepEqual(co.official, { url: 'https://example.gov/co', office: 'Colorado Secretary of State' });
  assert.equal(n.officeLabel, 'Attorney General');
  // CA's feed is only part of its ballot: not finding an AG contest there is not "no race".
  assert.equal(n.states.find((s) => s.state === 'CA').status, 'no-source');
  // A state with no source: unknown, never "no race".
  assert.equal(n.states.find((s) => s.state === 'TX').status, 'no-source');
  // County breakdown for the state view.
  const sv = r.state('CO', 'attorney_general');
  assert.equal(sv.countyData, 'available');
  assert.equal(sv.counties.find((c) => c.fips === '08041').leader, 'REP');
});

test('top race: Senate, else Governor, else House popular vote; specials after the regular race; others listed, never summed', () => {
  const db = openDb(':memory:');
  const adapterTop = { ...adapter, targets: () => ['CO', 'CA', 'UT'].map((s) => ({ key: `${s}/1`, state: s, scope: 'state', levels: ['state'] })) };
  const w = (state, races) => writeSnapshot(db, { source: 'fake', fetchedAt: '2026-11-04T02:00:00Z', version: '1',
    election: { sourceKey: `${state}/1`, state, scope: 'state', name: state }, races });
  w('CO', [
    // A special election listed first in the feed must not become the headline.
    { office: 'senate', key: '1', name: 'United States Senator - Special Election (Unexpired Term)', choices: [cand('X', 'REP'), cand('Y', 'DEM')], units: [st([90, 10])] },
    { office: 'senate', key: '2', name: 'United States Senator', choices: [cand('Jane', 'DEM'), cand('Joe', 'REP')], units: [st([600, 400])] },
    { office: 'governor', key: '3', name: 'Governor', choices: [cand('G1', 'DEM'), cand('G2', 'REP')], units: [st([505, 495])] },
    { office: 'house', key: '4', district: '1', name: 'Rep District 1', choices: [cand('H1', 'DEM'), cand('H2', 'REP')], units: [st([70, 30])] },
  ]);
  w('CA', [{ office: 'governor', key: 'g', name: 'Governor', choices: [cand('G1', 'DEM'), cand('G2', 'REP')], units: [st([10, 5])] }]);
  w('UT', [
    { office: 'house', key: 'h1', district: '1', name: 'Rep District 1', choices: [cand('A', 'REP'), cand('B', 'DEM')], units: [st([60, 40])] },
    { office: 'house', key: 'h2', district: '2', name: 'Rep District 2', choices: [cand('C', 'REP'), cand('D', 'DEM')], units: [st([55, 45])] },
  ]);
  const r = createResults(db, [adapterTop]);
  const n = r.national('top');
  const by = Object.fromEntries(n.states.map((s) => [s.state, s]));
  assert.equal(by.CO.topOffice, 'senate');
  assert.deepEqual(by.CO.candidates.map((c) => c.name), ['Jane', 'Joe']); // the regular race colors the map
  assert.equal(by.CO.totalVotes, 1000); // one contest's votes, nothing added from the others
  assert.deepEqual(by.CO.otherRaces.map((x) => [x.office, x.name, x.leadName]), [
    ['senate', 'United States Senator - Special Election (Unexpired Term)', 'X'],
    ['governor', 'Governor', 'G1'],
    ['house', 'Rep District 1', null], // the House line is the popular vote by party
  ]);
  assert.equal(by.CA.topOffice, 'governor');
  assert.equal(by.UT.topOffice, 'house');
  assert.equal(by.UT.topLabel, 'U.S. House · statewide popular vote');
  assert.equal(by.UT.partySum, true);
  assert.equal(by.TX.status, 'no-source');
  // The state view in Top race mode resolves to that state's top office.
  const sv = r.state('CA', 'top');
  assert.equal(sv.topOffice, 'governor');
  assert.equal(sv.race, 'governor');
  assert.equal(sv.statewide.topLabel, 'Governor');
});

test('multi-seat contests: no leader, no margin, top-N seats', () => {
  const co = seed().national('university_regent').states.find((s) => s.state === 'CO');
  assert.equal(co.multiSeat, true);
  assert.equal(co.seats, 2);
  assert.equal(co.leader, null);
  assert.equal(co.marginPts, null);
  assert.deepEqual(co.candidates.map((c) => c.name), ['U1', 'U3', 'U2']);
});

test('contests: every contest, grouped, with leads in each contest\'s own terms', () => {
  const c = seed().contests('CO');
  assert.equal(c.total, 9);
  assert.deepEqual(c.groups.map((g) => g.title),
    ['Federal', 'Statewide', 'State legislature', 'County', 'Local', 'Judicial', 'Ballot measures', 'Other contests']);
  const by = Object.fromEntries(c.groups.flatMap((g) => g.contests).map((x) => [x.name, x]));
  assert.equal(by['Attorney General'].lead, 'DEM');
  assert.equal(by['Attorney General'].marginPts, 2);
  assert.equal(by['Treasurer'].level, 'county');
  assert.equal(by['Mayor - City of Boulder'].lead, 'Ann Lee');
  assert.equal(by['Mayor - City of Boulder'].jurisdiction, 'Boulder');
  const ret = by['Shall Justice Pat Doe of the Colorado Supreme Court be retained in office?'];
  assert.equal(ret.kind, 'retention');
  assert.equal(ret.lead, 'YES');
  assert.equal(by['Regent of the University of Colorado - At Large'].multiSeat, true);
  assert.equal(by['Regent of the University of Colorado - At Large'].lead, null);
  assert.equal(by['Amendment 81 (Constitutional)'].lead, 'YES');
  assert.equal(by['Amendment 81 (Constitutional)'].measureId, 'fake:CO:9');
  assert.equal(by['Keeper of the Royal Swans'].level, 'unclassified');
  assert.equal(by['State Senator - District 12'].candidates[0].pct, 60);
  assert.equal(c.note, null);
});

test('contests: search across office, district, county and city names', () => {
  const r = seed();
  assert.deepEqual(r.contests('CO', undefined, 'boulder').groups.flatMap((g) => g.contests).map((x) => x.name), ['Mayor - City of Boulder']);
  assert.deepEqual(r.contests('CO', undefined, 'district 12').groups.flatMap((g) => g.contests).map((x) => x.name), ['State Senator - District 12']);
  assert.equal(r.contests('CO', undefined, 'judicial').matched, 1);
  assert.equal(r.contests('CO', undefined, 'nothing like this').groups.length, 0);
});

test('contests: honest notes for top-races-only and uncovered states', () => {
  const r = seed();
  assert.match(r.contests('CA').note, /only the top races/);
  assert.match(r.contests('TX').note, /don't have a results source/);
});

test('measures: official info merged; unreviewed websites and party positions never served', () => {
  const m = seed().measures('CO').measures;
  const a81 = m.find((x) => x.name === 'Amendment 81 (Constitutional)');
  assert.equal(a81.info.officialTitle.value, 'An amendment about things');
  assert.equal(a81.info.officialSummary, null);
  assert.equal(a81.info.placedBy.proponentName, 'Jane Q. Public');
  assert.equal(a81.info.proponentWebsite, null); // reviewed: false
  assert.deepEqual(a81.info.opposition, { name: 'No on 81', sourceUrl: 'https://example.gov/filing', website: 'https://no.example' });
  // Both major parties always listed (no position published), then other parties with a reviewed position, alphabetical.
  assert.deepEqual(a81.info.partyPositions.map((p) => [p.party, p.position]),
    [['Democratic Party', null], ['Republican Party', null], ['Alpha Party', 'support'], ['Zeta Party', 'oppose']]);
  assert.deepEqual(a81.info.campaignWebsites, [{ side: 'oppose', url: 'https://no.example', sourceUrl: 'https://example.gov/filing', note: null }]);
  assert.ok(!JSON.stringify(m).includes('yes.example'));
  assert.ok(!JSON.stringify(m).includes('Unreviewed Party'));
  // "Amendment 8" must not match "Amendment 81"; it shows as researched-but-not-in-a-feed.
  const a8 = m.find((x) => x.name === 'Amendment 8');
  assert.equal(a8.live, false);
  assert.equal(a8.yes, null);
});
