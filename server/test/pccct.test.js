import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePcc } from '../src/adapters/pccct.js';

// Trimmed from the live CT feed on election night (Governor, Congress 1-5, State Senator 1; all 169 towns), plus
// Attorney General, State Representative 1, Judge of Probate 54, Ansonia Registrar of Voters, Darien Board of Education.
const load = (f) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/pccct/${f}`, import.meta.url)), 'utf8'));
const data = load('Electiondata.json');
const lookup = load('Lookupdata.json');
const target = { key: 'CT/108', state: 'CT', races: ['senate', 'governor', 'house'], measures: true };

const run = (d = data, l = lookup, t = target) => {
  const unmatched = [];
  return { ...parsePcc(d, l, t, { unmatched: (...a) => unmatched.push(a) }), unmatched };
};

test('CT: every office in the feed is stored; headline offices keep their built-in identity', () => {
  const { races } = run();
  const top = races.filter((r) => ['governor', 'house'].includes(r.office));
  assert.deepEqual(top.map((r) => `${r.office}:${r.district ?? ''}`), ['governor:', 'house:1', 'house:2', 'house:3', 'house:4', 'house:5']);
  assert.ok(top[0].statewide);
  assert.ok(top.slice(1).every((r) => !r.statewide));
  assert.equal(races.filter((r) => r.office !== 'measure').length, 12);
  const byName = (n) => races.find((r) => r.name === n);
  // Legislature: the feed's own office type gives the identity.
  assert.deepEqual(['level', 'office', 'district', 'voteFor'].map((k) => byName('State Senator 1')[k]), ['legislative', 'state_senate', '1', 1]);
  assert.deepEqual(['level', 'office', 'district'].map((k) => byName('State Representative 1')[k]), ['legislative', 'state_house', '1']);
  // Statewide row offices and probate judges are left to the contest rules (office null here).
  const ag = byName('Attorney General');
  assert.equal(ag.office, null);
  assert.ok(ag.statewide);
  assert.equal(ag.units[0].precinctsTotal, 778);
  assert.equal(byName('Judge of Probate 54').district, '54');
  // Town offices: jurisdiction is the one town that reports them; vote-for unknown (the feed has none, can be multi-seat).
  const reg = byName('Registrar of Voters');
  assert.deepEqual([reg.jurisdiction, reg.voteFor, reg.statewide, reg.units[0].name], ['Ansonia', null, false, 'Ansonia']);
  assert.equal(reg.units[0].precinctsTotal, reg.units[1].precinctsTotal);
  assert.ok(reg.units[0].precinctsTotal > 0);
  assert.equal(byName('Board of Education').jurisdiction, 'Darien');
});

test('CT: after enrichRaces every fixture contest is classified (pccct.json rules for town offices)', async () => {
  const { enrichRaces, resetContestRules } = await import('../src/contests.js');
  resetContestRules();
  const { races } = run();
  const unclassified = enrichRaces({ races, election: { scope: 'state', state: 'CT' } }, 'pccct');
  assert.deepEqual(unclassified, []);
  const get = (n) => races.find((r) => r.name === n);
  assert.deepEqual([get('Attorney General').level, get('Attorney General').office], ['statewide', 'attorney_general']);
  assert.deepEqual([get('Judge of Probate 54').level, get('Judge of Probate 54').office], ['judicial', 'trial_court']);
  assert.deepEqual([get('Registrar of Voters').level, get('Registrar of Voters').office], ['local', 'registrar_of_voters']);
  assert.deepEqual([get('Board of Education').level, get('Board of Education').office], ['local', 'school_board']);
  assert.equal(get('Governor and Lieutenant Governor').office, 'governor');
  assert.ok(races.filter((r) => r.office === 'measure').every((r) => r.kind === 'yes_no' && r.level === 'measure'));
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

test('CT: town questions are stored as local measures, one per town; a question in every town becomes a statewide measure', () => {
  const local = run().races.filter((r) => r.office === 'measure');
  const nTownQs = Object.values(data.ballotQuestion).reduce((s, qs) => s + qs.length, 0);
  assert.equal(local.length, nTownQs);
  assert.ok(local.every((r) => r.statewide === false && r.jurisdiction && r.title));
  const a1 = local.find((r) => r.name === 'Ansonia Question 1');
  assert.match(a1.title, /City of Ansonia Charter/);
  assert.deepEqual(a1.units.map((u) => [u.level, u.name]), [['state', 'Ansonia'], ['county', 'New Haven']]);
  assert.equal(new Set(local.map((r) => r.key)).size, local.length);
  const d = structuredClone(data);
  d.ballotQuestion = Object.fromEntries(Object.values(lookup.townIds).map((n, i) => [n, [
    { QN: '1.  "Shall there be a constitutional convention?"', YES: String(i + 1), NO: '1', NTH: '-', NTL: '-' },
  ]]));
  const m = run(d).races.find((r) => r.office === 'measure');
  assert.equal(m.name, 'Question 1');
  assert.equal(m.statewide, true);
  assert.equal(run(d).races.filter((r) => r.office === 'measure').length, 1);
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
