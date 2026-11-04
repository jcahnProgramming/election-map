// The review gate on the real researched measure files (config/elections/2026-general/measures), after the
// 2026-11-03 review round: what is served, what isn't, and how party positions are always listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureInfoList, publicInfo, statePartyNames, partyPositionsOf, campaignWebsitesOf } from '../src/measureinfo.js';

const EK = '2026-general';
const info = (st, id) => {
  const m = measureInfoList(EK, st).find((x) => x.measure_id === id);
  assert.ok(m, `${st} ${id} missing`);
  return publicInfo(m, statePartyNames(EK, st));
};
const pos = (i) => Object.fromEntries(i.partyPositions.map((p) => [p.major ?? p.party, p.position]));

test('CA: both parties reviewed on every prop; CAGOP neutral on 1 and 37', () => {
  for (const n of [1, 2, 3, 4, 5, 37, 38, 39, 40, 41, 42, 43, 44, 45]) {
    const i = info('CA', `Proposition ${n}`);
    assert.deepEqual(i.partyPositions.map((p) => p.major), ['DEM', 'REP'], `Prop ${n}`);
    assert.ok(i.partyPositions.every((p) => p.position), `Prop ${n}: every CA position is reviewed`);
    assert.ok(i.campaignWebsites.length > 0, `Prop ${n}: websites reviewed`);
  }
  assert.equal(pos(info('CA', 'Proposition 1')).REP, 'no_position');
  assert.equal(pos(info('CA', 'Proposition 37')).REP, 'no_position');
});

test('CA: printed domains kept; Props 41/42 opposition carries the Prop 40 note', () => {
  const url = (n, side) => info('CA', `Proposition ${n}`).campaignWebsites.find((w) => w.side === side)?.url;
  assert.match(url(4, 'support'), /CAFairElections\.org/);
  assert.match(url(39, 'oppose'), /CAforvotingrights\.org/);
  assert.match(url(43, 'support'), /YESon43\.com/);
  assert.match(url(44, 'support'), /yesonproposition44\.com/);
  for (const n of [41, 42]) {
    const w = info('CA', `Proposition ${n}`).campaignWebsites.find((x) => x.side === 'oppose');
    assert.match(w.url, /yeson40\.com/);
    assert.equal(w.note, 'Website of the committee that also supports Prop 40, as listed in the official voter guide.');
  }
  // Legislative referrals have no proponent name, but their reviewed website is still listed.
  assert.match(url(1, 'support'), /yesonprop1ca\.com/);
});

test('reviewed elsewhere: CO Democrats (12), FL, ID Prop 1, NC, OH Issue 3, VA Q1 opposition site', () => {
  const co = measureInfoList(EK, 'CO').map((m) => publicInfo(m, statePartyNames(EK, 'CO')));
  assert.equal(co.filter((i) => i.partyPositions.find((p) => p.major === 'DEM')?.position).length, 12);
  assert.equal(co[0].partyPositions.find((p) => p.major === 'DEM').party, 'Colorado Democratic Party');
  assert.equal(pos(info('FL', 'Amendment 3')).DEM, 'oppose');
  for (const n of [1, 2, 3]) assert.equal(pos(info('FL', `Amendment ${n}`)).REP, 'support');
  assert.deepEqual([pos(info('ID', 'Proposition 1')).DEM, pos(info('ID', 'Proposition 1')).REP], ['support', 'oppose']);
  for (const m of measureInfoList(EK, 'NC')) assert.equal(pos(publicInfo(m)).DEM, 'oppose');
  assert.equal(pos(info('OH', 'Issue 3')).REP, 'support');
  assert.match(info('VA', 'Question 1').opposition.website, /virginiansforsafereproductivepolicy\.com/);
});

test('still unreviewed: positions "Not yet verified" (no position, no link), websites omitted', () => {
  // UT Amendment B: the Utah Republican Party entry exists but is unreviewed → pending; Democrats have no entry at all.
  const ub = info('UT', 'Constitutional Amendment B');
  const rep = ub.partyPositions.find((p) => p.major === 'REP');
  assert.deepEqual([rep.party, rep.position, rep.pending, rep.sourceUrl], ['Utah Republican Party', null, true, null]);
  const dem = ub.partyPositions.find((p) => p.major === 'DEM');
  assert.deepEqual([dem.position, dem.pending], [null, false]);
  // Unreviewed websites are omitted, not placeholdered.
  for (const [st, id] of [['VA', 'Question 2'], ['VA', 'Question 3'], ['RI', 'Question 3']]) {
    assert.deepEqual(info(st, id).campaignWebsites, [], `${st} ${id}`);
  }
  const leaked = JSON.stringify([
    ub, info('VA', 'Question 2'), info('VA', 'Question 3'), info('RI', 'Question 3'),
    ...measureInfoList(EK, 'WA').map((m) => publicInfo(m)),
  ]);
  for (const s of ['vaformarriageequality', 'vvff.info', 'no645.com', 'NoHateInWAState', 'di-ag.org', 'voteyeson3ri']) {
    assert.ok(!leaked.includes(s), `${s} must not be served`);
  }
});

test('partyPositionsOf: majors always (unreviewed = pending, no position or source), others only when reviewed', () => {
  const m = {
    party_positions: [
      { party: 'Green Party', position: 'support', source_url: 'https://g', reviewed: true },
      { party: 'Libertarian Party', position: 'oppose', source_url: 'https://l', reviewed: false },
      { party: 'Example Republican Party', position: 'no_position', source_url: 'https://r', reviewed: true },
      { party: 'Example Democratic Party', position: 'oppose', source_url: 'https://d', reviewed: false },
    ],
  };
  assert.deepEqual(partyPositionsOf(m, ['Example Democratic Party']), [
    { party: 'Example Democratic Party', major: 'DEM', position: null, pending: true, sourceUrl: null }, // "Not yet verified"
    { party: 'Example Republican Party', major: 'REP', position: 'no_position', pending: false, sourceUrl: 'https://r' },
    { party: 'Green Party', major: null, position: 'support', pending: false, sourceUrl: 'https://g' },
  ]);
  assert.ok(!JSON.stringify(partyPositionsOf(m)).includes('https://d'), 'an unreviewed source never leaves the server');
  // No entry at all: "No published position" (pending false).
  assert.deepEqual(partyPositionsOf({}).map((p) => [p.party, p.position, p.pending]),
    [['Democratic Party', null, false], ['Republican Party', null, false]]);
});

test('campaignWebsitesOf: side "unclear" → plain campaign website, no side label; unreviewed never', () => {
  const m = {
    proponent_website: { value: 'https://a.example', source_url: 'https://s', reviewed: true, side: 'unclear' },
    opposition_website: { value: 'https://b.example', source_url: 'https://s', reviewed: false },
  };
  assert.deepEqual(campaignWebsitesOf(m), [{ side: null, url: 'https://a.example', sourceUrl: 'https://s', note: null }]);
  const p = publicInfo({ measure_id: 'X', ...m });
  assert.equal(p.proponentWebsite, null); // an unclear side is never presented as the proponent's site
});
