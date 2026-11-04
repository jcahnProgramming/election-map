import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePcc } from '../src/adapters/pccct.js';

// Trimmed from the live CT feed on election night (Governor, Congress 1-5, State Senator 1; all 169 towns).
const load = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/pccct/${f}`, import.meta.url)), 'utf8'));
const data = load('Electiondata.json');
const lookup = load('Lookupdata.json');
const target = { key: 'CT/108', state: 'CT', races: ['senate', 'governor', 'house'], measures: true };

const run = (d = data, l = lookup, t = target) => {
  const unmatched = [];
  return { ...parsePcc(d, l, t, { unmatched: (...a) => unmatched.push(a) }), unmatched };
};

test('CT: governor + five House districts; state legislature skipped', () => {
  const { races } = run();
  assert.deepEqual(races.map((r) => `${r.office}:${r.district ?? ''}`), ['governor:', 'house:1', 'house:2', 'house:3', 'house:4', 'house:5']);
  assert.ok(races[0].statewide);
  assert.ok(races.slice(1).every((r) => !r.statewide));
});

test('CT: fusion lines are one choice per person, party from the major line, every code kept', () => {
  const { races, unmatched } = run();
  const gov = races.find((r) => r.office === 'governor');
  const lamont = gov.choices.find((c) => /Lamont/.test(c.name));
  const fazio = gov.choices.find((c) => /Fazio/.test(c.name));
  assert.deepEqual(lamont, { name: 'Ned Lamont and Susan Bysiewicz', party: 'DEM', partyRaw: 'D/WF' });
  assert.deepEqual(fazio, { name: 'Ryan Fazio and Matt Corey', party: 'REP', partyRaw: 'R/IND' });
  assert.equal(new Set(gov.choices.map((c) => c.name)).size, gov.choices.length);
  // Our person totals equal the source's own candidateGrouping totals.
  for (const g of data.candidateGrouping['19663']) {
    const [lineId, v] = Object.entries(g)[0];
    const name = lookup.candidateIds[lineId].NM;
    const i = gov.choices.findIndex((c) => c.name === name);
    assert.equal(gov.units[0].votes[i], Number(v.V), name);
  }
  // "WF" is not in normalize.js yet: logged, not dropped.
  assert.ok(!unmatched.some(([k, v]) => k === 'party' && v === 'WF'));
  assert.ok(!unmatched.some(([k]) => k === 'county'));
});

test('CT: county units are sums of their towns and add up to the state (statewide contest)', () => {
  const { races } = run();
  const gov = races.find((r) => r.office === 'governor');
  const [st, ...cty] = gov.units;
  assert.equal(st.level, 'state');
  assert.equal(cty.length, 8);
  assert.ok(cty.every((u) => /^09\d{3}$/.test(u.countyFips)));
  st.votes.forEach((v, i) => assert.equal(cty.reduce((s, u) => s + u.votes[i], 0), v));
  assert.equal(st.precinctsTotal, 778);
  assert.equal(cty.reduce((s, u) => s + u.precinctsTotal, 0), 778);
  // District contests: towns' precinct counts are town-wide, so none per district slice.
  const h1 = races.find((r) => r.office === 'house' && r.district === '1');
  assert.ok(h1.units.every((u) => u.precinctsTotal === null));
  assert.ok(h1.units.some((u) => u.name === 'Hartford'));
});

test('CT: turnout from the source; zero registered is "not published", not zero', () => {
  const { turnout } = run();
  assert.equal(turnout[0].level, 'state');
  assert.equal(turnout[0].precinctsTotal, 778);
  assert.equal(turnout[0].ballotsOutstanding, null);
  assert.equal(turnout.length, 9);
  const d = structuredClone(data);
  d.election.RV = '0';
  assert.equal(run(d).turnout[0].registered, null);
  d.election.RV = '2,345,678';
  d.election.TO = '12.50';
  assert.equal(run(d).turnout[0].registered, 2345678);
  assert.equal(run(d).turnout[0].turnoutPct, 12.5);
});

test('CT: town questions are local; a question in every town becomes a statewide measure', () => {
  assert.equal(run().races.filter((r) => r.office === 'measure').length, 0);
  const d = structuredClone(data);
  d.ballotQuestion = Object.fromEntries(Object.values(lookup.townIds).map((n, i) => [n, [
    { QN: '1.  "Shall there be a constitutional convention?"', YES: String(i + 1), NO: '1', NTH: '-', NTL: '-' },
  ]]));
  const m = run(d).races.find((r) => r.office === 'measure');
  assert.equal(m.name, 'Question 1');
  assert.equal(m.title, '"Shall there be a constitutional convention?"');
  const n = Object.keys(lookup.townIds).length;
  assert.equal(m.units[0].yes, (n * (n + 1)) / 2);
  assert.equal(m.units[0].no, n);
  assert.equal(m.units.filter((u) => u.level === 'county').reduce((s, u) => s + u.no, 0), n);
  // Before any count the source writes "-": that is 0 counted, and the question still parses.
  d.ballotQuestion = Object.fromEntries(Object.values(lookup.townIds).map((nm) => [nm, [{ QN: '1. "Q?"', YES: '-', NO: '-' }]]));
  assert.equal(run(d).races.find((r) => r.office === 'measure').units[0].yes, 0);
});

test('CT: missing sections and unknown line ids do not throw', () => {
  assert.deepEqual(run({}, {}).races, []);
  const d = structuredClone(data);
  delete d.townVotes;
  d.stateVotes['19663'].push({ 99999: { V: '-' } });
  const gov = run(d).races.find((r) => r.office === 'governor');
  assert.equal(gov.units.length, 1);
  assert.ok(gov.choices.some((c) => c.name === 'Candidate 99999'));
});
