// Parser test against real Clarity files captured on election night 2026-11-03 (trimmed to a few contests).
// Counts were still zero when captured (before polls closed); a couple of tests inject numbers into the XML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseClarity, parseClarityTime } from '../src/adapters/clarity.js';
import { enrichRaces } from '../src/contests.js';

const dir = new URL('./fixtures/clarity/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const TARGETS = {
  co: { key: 'CO/127407', path: 'CO', eid: '127407', state: 'CO', scope: 'state', countyFips: null, label: 'Colorado 2026 General', version: '383402' },
  ia: { key: 'IA/127077', path: 'IA', eid: '127077', state: 'IA', scope: 'state', countyFips: null, label: 'Iowa 2026 General Election', version: '383360' },
  sc: { key: 'SC/127300', path: 'SC', eid: '127300', state: 'SC', scope: 'state', countyFips: null, label: 'South Carolina 2026 General', version: '382659' },
  wv: { key: 'WV/127496', path: 'WV', eid: '127496', state: 'WV', scope: 'state', countyFips: null, label: 'West Virginia 2026 General Election', version: '383572' },
  denton: { key: 'TX/Denton/127398', path: 'TX/Denton', eid: '127398', state: 'TX', scope: 'county', countyFips: '48121', label: 'Denton County, TX', version: '382120' },
};

function parse(s, { xml = (x) => x, summary = (x) => x, details = (x) => x } = {}) {
  const t = { ...TARGETS[s], races: ['senate', 'governor', 'house'], measures: TARGETS[s].scope === 'state', url: `https://example/${s}/` };
  const unmatched = [];
  const r = parseClarity({
    target: t, version: t.version,
    summary: summary(JSON.parse(read(`${s}-summary.json`))),
    details: details(JSON.parse(read(`${s}-details.json`))),
    settings: JSON.parse(read(`${s}-electionsettings.json`)),
    detailXml: xml(read(`${s}-detail.xml`)),
  }, { unmatched: (...a) => unmatched.push(a) });
  return { r, unmatched };
}

test('parseClarityTime: US zone abbreviations to ISO', () => {
  assert.equal(parseClarityTime('11/3/2026 10:46:50 AM MST'), '2026-11-03T17:46:50.000Z');
  assert.equal(parseClarityTime('10/30/2026 10:04:18 AM EDT'), '2026-10-30T14:04:18.000Z');
  assert.equal(parseClarityTime('11/3/2026 12:05:00 AM CST'), '2026-11-03T06:05:00.000Z');
  assert.equal(parseClarityTime('11/3/2026 12:05:00 PM CST'), '2026-11-03T18:05:00.000Z');
  assert.equal(parseClarityTime('11/3/2026 10:46:50 AM XYZ'), null);
  assert.equal(parseClarityTime(null), null);
});

test('CO: turnout per county, precincts, no vote-type split, measures', () => {
  const { r, unmatched } = parse('co');
  assert.deepEqual(unmatched, []);
  assert.equal(r.version, '383402');
  assert.equal(r.sourceUpdatedAt, '2026-11-03T17:46:50.000Z');
  assert.equal(r.election.date, '2026-11-03');
  const st = r.turnout.find((u) => u.level === 'state');
  assert.deepEqual(st, { level: 'state', name: 'CO', registered: 4086478, ballotsCast: 0, turnoutPct: 0, ballotsOutstanding: null, precinctsReporting: 0, precinctsTotal: 4297 });
  assert.equal(r.turnout.filter((u) => u.level === 'county').length, 64);
  assert.equal(r.turnout.find((u) => u.countyFips === '08001').registered, 330215);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.units[0].precinctsTotal, 4230);
  assert.equal(sen.units.length, 65);
  assert.equal(sen.units[0].methods, undefined, 'CO publishes only "Total Votes": no method split');
  const m = r.races.find((x) => x.office === 'measure');
  assert.equal(m.title, null);
  assert.equal(m.statewide, true);
  assert.deepEqual([m.units[0].yes, m.units[0].no], [0, 0]);
});

test('IA: Election Day / Absentee split at state and county level', () => {
  // Inject 7 Election Day votes in Adair for the first Senate choice (Ashley Hinson, REP).
  const { r } = parse('ia', {
    xml: (x) => x.replace(/(<VoteType name="Election Day" votes=")0(">\s*<County name="Adair" votes=")0/, '$17$27'),
  });
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.choices[0].name, 'Ashley Hinson');
  const st = sen.units[0];
  assert.deepEqual(st.methods.map((m) => [m.label, m.bucket]), [['Election Day', 'election_day'], ['Absentee', 'mail_early']]);
  assert.equal(st.methods[0].votes[0], 7);
  assert.equal(st.methods[0].votes.length, sen.choices.length);
  const adair = sen.units.find((u) => u.countyFips === '19001');
  assert.equal(adair.methods[0].votes[0], 7);
  assert.equal(adair.methods[1].votes[0], 0);
  const amend = r.races.find((x) => x.office === 'measure');
  assert.equal(amend.units[0].methods[0].votes.length, 2, 'measures: [yes, no] per method');
  assert.equal(r.turnout.find((u) => u.level === 'state').registered, 2178374);
});

test('SC: party prefixes stripped from names, six vote types, precincts from settings', () => {
  const { r, unmatched } = parse('sc');
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => [c.name, c.party, c.partyRaw]).slice(0, 3),
    [['Darline Graham', 'REP', 'REP'], ['Kasie Whitener', 'OTHER', 'LIB'], ['Annie Andrews', 'DEM', 'DEM']]);
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.choices[0].name, 'Michael Addison / Candace Brewer'); // "UNC Michael Addison / ..." in the source
  const labels = sen.units[0].methods.map((m) => m.label);
  assert.ok(labels.includes('Absentee By Mail') && labels.includes('Early Voting') && labels.includes('Election Day'));
  assert.equal(sen.units[0].methods.find((m) => m.label === 'Provisional').bucket, 'provisional');
  assert.equal(r.turnout[0].precinctsTotal, 2312);
  assert.equal(r.sourceUpdatedAt, '2026-10-30T14:04:18.000Z');
  assert.deepEqual(unmatched.filter((u) => u[0] === 'county'), []);
});

test('county site (Denton, TX): one county unit, precincts from summary TP/PR, county-level turnout', () => {
  const { r } = parse('denton');
  assert.equal(r.election.scope, 'county');
  assert.deepEqual(r.turnout.map((u) => [u.level, u.countyFips, u.registered]), [['county', '48121', 695512]]);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.units.length, 1);
  assert.equal(sen.units[0].precinctsTotal, 252);
  assert.deepEqual(sen.units[0].methods.map((m) => [m.label, m.bucket]),
    [['Absentee', 'mail_early'], ['Early', 'mail_early'], ['Election', 'election_day']]);
  assert.equal(r.races.some((x) => x.office === 'measure'), false);
});

test('ballotsCast stuck at 0 while votes are counted is "not published" (null), not zero', () => {
  const { r } = parse('ia', { xml: (x) => x.replace(/(<Choice key="[^"]+" text="Ashley Hinson"[^>]*>\s*<VoteType name="Election Day" votes=")0/, '$15') });
  // summary.json still says 0 votes here, so ballotsCast 0 stays as published:
  assert.equal(r.turnout[0].ballotsCast, 0);
  const summary = JSON.parse(read('ia-summary.json'));
  summary[0].V = summary[0].V.map(() => 10);
  const t = { ...TARGETS.ia, races: ['senate'], measures: false, url: 'u' };
  const r2 = parseClarity({ target: t, version: '1', summary, details: null, settings: null, detailXml: read('ia-detail.xml') });
  assert.equal(r2.turnout.find((u) => u.level === 'state').ballotsCast, null);
});

test('detail.xml survives a zip round trip (what fetch() does)', () => {
  const xml = read('sc-detail.xml');
  const files = unzipSync(zipSync({ 'detail.xml': strToU8(xml) }));
  assert.equal(strFromU8(files['detail.xml']), xml);
});

// The trimmed fixtures carry only headline contests, so these add real-shaped non-headline contests (copied from the
// structure of the CO Senate contest) to check that every contest a feed publishes is emitted.
function addContests(list) {
  return {
    summary: (s) => [...s, ...list.map((x) => ({ ...s[0], C: x.C, K: x.K, VF: x.VF, CH: x.CH, P: x.P, V: x.CH.map((_, i) => (i + 1) * 100), W: x.CH.map(() => 1) }))],
    details: (d) => ({
      Contests: [...d.Contests, ...list.filter((x) => !x.noDetail).map((x) => ({
        ...d.Contests[0], K: x.K, V: d.Contests[0].P.map((_, ci) => x.CH.map((__, i) => (ci === 0 ? (i + 1) * 10 : 0))),
      }))],
    }),
  };
}
const EXTRA = [
  { C: 'State Representative - District 5', K: '9001', VF: 1, CH: ['Jane Doe', 'John Roe'], P: ['DEM', 'REP'] },
  { C: 'Shall Justice Maria E. Berkenkotter of the Colorado Supreme Court be retained in office?', K: '9002', VF: 1, CH: ['Yes', 'No'], P: ['', ''] },
  { C: 'Board of Education Director District 3', K: '9003', VF: 3, CH: ['Ann A', 'Bob B', 'Cy C', 'Di D'], P: ['', '', '', ''] },
  { C: 'Zebra Mussel Inspection Warden', K: '9004', VF: 1, CH: ['Pat P', 'Lee L'], P: ['', ''] },
];

test('CO: every contest is emitted with units, votes and voteFor; non-headline ones carry office null', () => {
  const { r, unmatched } = parse('co', addContests(EXTRA));
  assert.deepEqual(unmatched, []);
  assert.equal(r.races.length, 6 + EXTRA.length);
  const [rep, ret, board, odd] = EXTRA.map((x) => r.races.find((race) => race.key === x.K));
  for (const race of [rep, ret, board, odd]) {
    assert.equal(race.office, null);
    assert.equal(race.units.length, 65, 'state + 64 counties');
    assert.deepEqual(race.units[0].votes, race.choices.map((_, i) => (i + 1) * 100));
    assert.deepEqual(race.units.find((u) => u.countyFips === '08001').votes, race.choices.map((_, i) => (i + 1) * 10));
    assert.ok(!('W' in race) && race.choices.every((c) => !('winner' in c)));
  }
  assert.equal(board.voteFor, 3);
  assert.equal(rep.voteFor, 1);
  assert.deepEqual(rep.choices.map((c) => c.party), ['DEM', 'REP']);
  // retention: a Yes/No contest with per-choice votes, never a measure
  assert.deepEqual(ret.choices.map((c) => c.name), ['Yes', 'No']);
  assert.equal(ret.units[0].yes, undefined);
  assert.equal(r.races.filter((x) => x.office === 'measure').length, 2);
});

test('CO: enrichRaces classifies the extra contests; an unknown office is unclassified, not dropped', () => {
  const { r } = parse('co', addContests(EXTRA));
  const unclassified = enrichRaces(r, 'clarity');
  assert.deepEqual(unclassified.map((u) => u.key), ['9004']);
  const by = (k) => r.races.find((x) => x.key === k);
  assert.deepEqual([by('9001').level, by('9001').office, by('9001').district], ['legislative', 'state_house', '5']);
  assert.deepEqual([by('9002').level, by('9002').office, by('9002').kind], ['judicial', 'supreme_court', 'retention']);
  assert.deepEqual([by('9003').level, by('9003').office], ['local', 'school_board']);
  assert.deepEqual([by('9004').level, by('9004').office], ['unclassified', 'unclassified']);
  // headline contests keep the office the adapter gave them
  assert.deepEqual(r.races.filter((x) => x.level === 'federal').map((x) => x.office), ['senate', 'house', 'house']);
});

test('county site (Denton, TX): local questions and local offices are stored, measures never statewide', () => {
  const { r } = parse('denton', addContests([
    { C: 'City of Denton Proposition A', K: '9101', VF: 1, CH: ['For', 'Against'], P: ['', ''] },
    { C: 'Justice of the Peace, Precinct 1', K: '9102', VF: 1, CH: ['Al A', 'Bo B'], P: ['REP', 'DEM'] },
  ]));
  assert.equal(r.races.length, 4);
  const prop = r.races.find((x) => x.key === '9101');
  assert.equal(prop.office, 'measure');
  assert.equal(prop.statewide, false);
  assert.deepEqual([prop.units[0].level, prop.units[0].yes, prop.units[0].no], ['county', 100, 200]);
  const jp = r.races.find((x) => x.key === '9102');
  assert.equal(jp.office, null);
  assert.deepEqual(jp.units.map((u) => u.level), ['county']);
  enrichRaces(r, 'clarity');
  assert.deepEqual([jp.level, jp.office, jp.jurisdiction], ['judicial', 'trial_court', 'Denton County, TX']);
});

test('a contest key listed twice is stored once', () => {
  const { r } = parse('co', { summary: (s) => [...s, s[0]] });
  assert.equal(r.races.length, 6);
});

test('targets(): allContests true for statewide sites, false for county-run sites', async () => {
  const { default: adapter } = await import('../src/adapters/clarity.js');
  const ts = adapter.targets();
  assert.ok(ts.filter((t) => t.scope === 'state').every((t) => t.allContests === true));
  assert.ok(ts.filter((t) => t.scope === 'county').every((t) => t.allContests === false));
});

test('AZ-style "BOND APPROVAL, YES / ..." choices make a measure, with yes/no in the right order', () => {
  const { r } = parse('denton', addContests([
    { C: 'PROPOSITION 427 - PIMA JTED', K: '9201', VF: 1, CH: ['BOND APPROVAL, YES / APROBACIÓN DE BONO, SÍ', 'BOND APPROVAL, NO / APROBACIÓN DE BONO, NO'], P: ['', ''] },
  ]));
  const prop = r.races.find((x) => x.key === '9201');
  assert.equal(prop.office, 'measure');
  assert.deepEqual([prop.units[0].yes, prop.units[0].no], [100, 200]);
});

test('per-adapter contestRules (config/sources/clarity.json) cover Clarity abbreviations', () => {
  const names = { 'JOP Pct 1': 'trial_court', 'REP. IN THE G.A. D112': 'state_house', 'Mem of Leg Dist 14': 'state_senate',
    'Solicitor, Circuit  3': 'district_attorney', 'CO. BD. MEMBER D3': 'county_commission', 'Anderson County Board of Education District 5': 'school_board' };
  const races = Object.keys(names).map((name, i) => ({ office: null, name, key: String(i), choices: [{ name: 'A', party: 'OTHER' }, { name: 'B', party: 'OTHER' }], units: [] }));
  assert.deepEqual(enrichRaces({ election: { scope: 'state' }, races }, 'clarity'), []);
  assert.deepEqual(Object.fromEntries(races.map((r) => [r.name, r.office])), names);
});

test('WV (live, early count 2026-11-04 01:00Z): Senate, House 2, amendment, legislature; LBN / MTN known', () => {
  const { r, unmatched } = parse('wv');
  assert.deepEqual(unmatched, []);
  assert.equal(r.sourceUpdatedAt, '2026-11-04T01:00:26.000Z');
  assert.deepEqual(r.turnout.find((u) => u.level === 'state'), { level: 'state', name: 'WV', registered: 1210307, ballotsCast: 37091, turnoutPct: 3.06, ballotsOutstanding: null, precinctsReporting: 124, precinctsTotal: 1642 });
  assert.equal(r.turnout.filter((u) => u.level === 'county').length, 55);
  const sen = r.races.find((x) => x.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => c.party), ['DEM', 'REP', 'OTHER']);
  assert.deepEqual(sen.units[0].votes, [19690, 16105, 898]);
  assert.equal(sen.units.filter((u) => u.level === 'county').length, 55);
  const h2 = r.races.find((x) => x.office === 'house');
  assert.equal(h2.district, '2');
  assert.deepEqual([h2.units[0].precinctsReporting, h2.units[0].precinctsTotal], [67, 760]);
  const m = r.races.find((x) => x.office === 'measure');
  assert.deepEqual([m.units[0].yes, m.units[0].no], [23137, 10858]);
  enrichRaces(r, 'clarity');
  assert.equal(r.races.find((x) => /13th Senatorial/.test(x.name)).level, 'legislative');
  assert.equal(r.races.find((x) => /79th District/.test(x.name)).level, 'legislative');
});
