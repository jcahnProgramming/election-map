// Toss-up is decided on the margin as displayed (one decimal), everywhere: a race shown as "2.0 pts" is never a
// toss-up, one shown as "1.9 pts" always is (map shading, tooltips, lead text, Congress seats, district rows, chips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shade, leadCategory, isTossupMargin, fmtMargin, displayMargin, TOSSUP_MARGIN } from '../src/shading.js';
import { leadText, seatStatus, districtLine, chamberTotals, tallyStates } from '../src/calc.js';

const entry = (m) => ({ status: 'reporting', leader: 'DEM', tied: false, marginPts: m, totalVotes: 1000,
  candidates: [{ name: 'Ann Lee', party: 'DEM', votes: 510 }, { name: 'Bo Kim', party: 'REP', votes: 490 }] });
const seat = (m) => ({ live: true, totalVotes: 1000, leader: 'DEM', tied: false, marginPts: m, lead: { name: 'Ann Lee', party: 'DEM' }, runnerUpParty: 'REP' });

test('1.94 → toss-up, shown "1.9 pts"; 1.96 → not a toss-up, shown "2.0 pts" — on every surface', () => {
  assert.equal(TOSSUP_MARGIN, 2);
  assert.deepEqual([fmtMargin(1.94), isTossupMargin(1.94)], ['1.9', true]);
  assert.deepEqual([fmtMargin(1.96), isTossupMargin(1.96)], ['2.0', false]);
  assert.deepEqual([fmtMargin(-1.96), isTossupMargin(-1.96)], ['2.0', false]); // a negative (Rep-signed) margin too
  // Map shading + category
  assert.equal(shade(entry(1.94)).key, 'tossup');
  assert.notEqual(shade(entry(1.96)).key, 'tossup');
  assert.equal(leadCategory(entry(1.94)), 'tossup');
  assert.equal(leadCategory(entry(1.96)), 'DEM');
  assert.deepEqual(tallyStates([entry(1.94), entry(1.96)]), { dem: 1, rep: 0, toss: 1, other: 0 });
  // Tooltip / totals lead text
  assert.equal(leadText(entry(1.94)), 'Toss-up · Ann Lee (DEM) ahead by 1.9 pts');
  assert.equal(leadText(entry(1.96)), 'Ann Lee (DEM) leading by 2.0 pts');
  // Congress seats, district rows, closest-races chip (seatStatus)
  assert.equal(seatStatus(seat(1.94)), 'toss');
  assert.equal(seatStatus(seat(1.96)), 'dLead');
  assert.deepEqual(districtLine(seat(1.94)), { status: 'toss', text: 'Toss-up' });
  assert.deepEqual(districtLine(seat(1.96)), { status: 'dLead', text: '+2.0' });
  const t = chamberTotals({ seats: 2, holdovers: [], up: [seat(1.94), seat(1.96)] });
  assert.deepEqual([t.counts.toss, t.counts.dLead], [1, 1]);
});

test('displayed margin is the one rounding used for both text and decision (no toFixed half-way drift)', () => {
  for (const m of [0.05, 0.95, 1.05, 1.95, 1.949, 2.05, 4.95, 11.95, 12.05]) {
    assert.equal(fmtMargin(m), displayMargin(m).toFixed(1), String(m));
    assert.equal(isTossupMargin(m), Number(fmtMargin(m)) < TOSSUP_MARGIN, String(m));
  }
});
