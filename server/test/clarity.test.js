// Parser test against real Clarity files captured on election night 2026-11-03 (trimmed to a few contests).
// Counts were still zero when captured (before polls closed); a couple of tests inject numbers into the XML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseClarity, parseClarityTime } from '../src/adapters/clarity.js';

const dir = new URL('./fixtures/clarity/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), 'utf8');
const TARGETS = {
  co: { key: 'CO/127407', path: 'CO', eid: '127407', state: 'CO', scope: 'state', countyFips: null, label: 'Colorado 2026 General', version: '383402' },
  ia: { key: 'IA/127077', path: 'IA', eid: '127077', state: 'IA', scope: 'state', countyFips: null, label: 'Iowa 2026 General Election', version: '383360' },
  sc: { key: 'SC/127300', path: 'SC', eid: '127300', state: 'SC', scope: 'state', countyFips: null, label: 'South Carolina 2026 General', version: '382659' },
  denton: { key: 'TX/Denton/127398', path: 'TX/Denton', eid: '127398', state: 'TX', scope: 'county', countyFips: '48121', label: 'Denton County, TX', version: '382120' },
};

function parse(s, { xml = (x) => x } = {}) {
  const t = { ...TARGETS[s], races: ['senate', 'governor', 'house'], measures: TARGETS[s].scope === 'state', url: `https://example/${s}/` };
  const unmatched = [];
  const r = parseClarity({
    target: t, version: t.version,
    summary: JSON.parse(read(`${s}-summary.json`)),
    details: JSON.parse(read(`${s}-details.json`)),
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
