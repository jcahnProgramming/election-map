// "Other races in this state" rows: label + leader on the left (wraps), margin alone on the right (one line).
// Ticket names stay exactly as each official source writes them (casing, "AND" vs "/").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherRaceLine } from '../src/calc.js';

const gov = (leadName, marginPts) => ({ office: 'governor', label: 'Governor', status: 'reporting', totalVotes: 1000, leader: 'DEM', marginPts, leadName, leadParty: 'DEM', leadPartyRaw: 'DEM' });

test('long tickets (NM, CO): the name is on the left, verbatim; the right column is only the margin', () => {
  assert.deepEqual(otherRaceLine(gov('DEB HAALAND AND STEPHANIE GARCIA RICHARD', 12.5)),
    { label: 'Governor', who: 'DEB HAALAND AND STEPHANIE GARCIA RICHARD (DEM)', margin: '+12.5' });
  assert.deepEqual(otherRaceLine(gov('Phil Weiser / Lesley Dahlkemper', 29.2)),
    { label: 'Governor', who: 'Phil Weiser / Lesley Dahlkemper (DEM)', margin: '+29.2' });
  for (const r of [gov('DEB HAALAND AND STEPHANIE GARCIA RICHARD', 12.5), gov('Phil Weiser / Lesley Dahlkemper', 29.2)]) {
    assert.ok(otherRaceLine(r).margin.length <= 8, 'the one-line column holds only the margin');
  }
});

test('House popular vote, toss-up, no votes, multi-seat, special', () => {
  assert.deepEqual(otherRaceLine({ office: 'house', label: 'U.S. House', status: 'reporting', totalVotes: 9, leader: 'DEM', marginPts: 18.94, partySum: true }),
    { label: 'U.S. House (popular vote)', who: null, margin: 'Democrats lead +18.9' });
  assert.equal(otherRaceLine(gov('A', 1.94)).margin, 'Toss-up');
  assert.equal(otherRaceLine(gov('A', 1.96)).margin, '+2.0');
  assert.equal(otherRaceLine({ ...gov('A', 5), status: 'awaiting', totalVotes: 0 }).margin, 'No votes counted yet');
  assert.equal(otherRaceLine({ ...gov('A', 5), multiSeat: true, seats: 2 }).margin, 'Vote for 2');
  assert.equal(otherRaceLine({ ...gov('X', 5), office: 'senate', label: 'U.S. Senate', name: 'U.S. Senator (Unexpired Term)' }).label, 'U.S. Senate (special)');
});
