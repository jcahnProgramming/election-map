import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seatStatus, chamberTotals, hemicycle, closestSeats, districtLine, districtLabel, candidateList, countWord, SEAT_CATEGORIES,
} from '../src/calc.js';
import { TOSSUP_MARGIN } from '../src/shading.js';

const seat = (o) => ({ live: true, totalVotes: 100, leader: 'DEM', tied: false, marginPts: 10, lead: { name: 'A', party: 'DEM' }, runnerUpParty: 'REP', ...o });

test('seatStatus: leading party, toss-up under the map threshold, no votes / no live data', () => {
  assert.equal(seatStatus(seat()), 'dLead');
  assert.equal(seatStatus(seat({ leader: 'REP', lead: { party: 'REP' }, runnerUpParty: 'DEM' })), 'rLead');
  assert.equal(seatStatus(seat({ marginPts: TOSSUP_MARGIN - 0.01 })), 'toss');
  assert.equal(seatStatus(seat({ marginPts: TOSSUP_MARGIN })), 'dLead');
  assert.equal(seatStatus(seat({ tied: true, leader: null, marginPts: 0 })), 'toss');
  assert.equal(seatStatus(seat({ totalVotes: 0 })), 'none');
  assert.equal(seatStatus(seat({ live: false })), 'none');
  assert.equal(seatStatus(null), 'none');
  // Top-two, both Democrats, 0.5 pts apart: a Democratic seat, not a toss-up.
  assert.equal(seatStatus(seat({ marginPts: 0.5, runnerUpParty: 'DEM' })), 'dLead');
  // An independent / third party ahead.
  assert.equal(seatStatus(seat({ leader: 'OTHER', lead: { party: 'OTHER' }, runnerUpParty: 'REP' })), 'oLead');
});

const SENATE_HOLD = [
  ...Array(32).fill({ party: 'D', caucus: 'DEM' }), { party: 'I', caucus: 'DEM' }, { party: 'I', caucus: 'DEM' },
  ...Array(31).fill({ party: 'R', caucus: 'REP' }),
];

test('Senate totals: holdovers + seats up always sum to 100; independents counted with their caucus', () => {
  const variants = [
    Array(35).fill(seat({ live: false })),
    Array(35).fill(seat()),
    [...Array(10).fill(seat()), ...Array(10).fill(seat({ leader: 'REP', lead: { party: 'REP' } })), ...Array(5).fill(seat({ marginPts: 1 })),
      ...Array(9).fill(seat({ totalVotes: 0 })), seat({ leader: 'OTHER', lead: { party: 'OTHER' } })],
  ];
  for (const up of variants) {
    const t = chamberTotals({ seats: 100, majority: 51, holdovers: SENATE_HOLD, up });
    assert.equal(t.total, 100);
    assert.equal(t.segments.reduce((a, s) => a + s.n, 0), 100);
  }
  const none = chamberTotals({ seats: 100, holdovers: SENATE_HOLD, up: Array(35).fill(seat({ live: false })) });
  assert.deepEqual([none.dem, none.rep, none.undecided], [34, 31, 35]);
  assert.equal(none.counts.iDem, 2);
  assert.equal(none.demDetail, '34 held + 0 leading');
  assert.equal(none.undecidedDetail, '0 toss-up · 35 no votes/data');
  const mix = chamberTotals({ seats: 100, holdovers: SENATE_HOLD, up: variants[2] });
  assert.deepEqual([mix.dem, mix.rep, mix.undecided, mix.other], [44, 41, 14, 1]);
  assert.match(mix.undecidedDetail, /1 other party leading/);
  // An independent caucusing with Republicans sits beside the Republicans.
  const iR = chamberTotals({ seats: 2, holdovers: [{ party: 'I', caucus: 'REP' }, { party: 'R', caucus: 'REP' }], up: [] });
  assert.deepEqual([iR.rep, iR.counts.iRep], [2, 1]);
});

test('House totals: 435 seats, no holdovers', () => {
  const up = Array.from({ length: 435 }, (_, i) => (i % 3 === 0 ? seat() : i % 3 === 1 ? seat({ totalVotes: 0 }) : seat({ leader: 'REP', lead: { party: 'REP' } })));
  const t = chamberTotals({ seats: 435, majority: 218, holdovers: [], up });
  assert.equal(t.total, 435);
  assert.equal(t.demDetail, '145 leading');
});

test('seat order: Dem held, independents (Dem), Dem leading, toss-up, no data, other, Rep leading, independents (Rep), Rep held', () => {
  assert.deepEqual(SEAT_CATEGORIES.map((c) => c.key), ['dHeld', 'iDem', 'dLead', 'toss', 'none', 'oLead', 'rLead', 'iRep', 'rHeld']);
  const t = chamberTotals({ seats: 100, holdovers: SENATE_HOLD, up: Array(35).fill(seat({ live: false })) });
  assert.deepEqual(t.segments.map((s) => s.key), ['dHeld', 'iDem', 'none', 'rHeld']);
});

test('hemicycle: exactly n seats, deterministic, left to right', () => {
  for (const [n, rows, r0, r1] of [[100, 5, 105, 205], [435, 11, 70, 208]]) {
    const a = hemicycle(n, rows, r0, r1);
    assert.equal(a.length, n);
    assert.deepEqual(a, hemicycle(n, rows, r0, r1));
    assert.ok(a[0].x < a[n - 1].x);
    for (const p of a) assert.ok(p.x >= 0 && p.x <= 460 && p.y >= 0 && p.y <= 250, JSON.stringify(p));
  }
});

test('closest Senate races: votes counted only, by absolute margin', () => {
  const up = [
    { ...seat({ marginPts: 5 }), state: 'GA' }, { ...seat({ marginPts: -0.4 }), state: 'NC' }, { ...seat({ totalVotes: 0, marginPts: null }), state: 'ME' },
    { ...seat({ live: false }), state: 'MI' }, { ...seat({ marginPts: 1.2 }), state: 'OH' },
  ];
  assert.deepEqual(closestSeats(up).map((s) => s.state), ['NC', 'OH', 'GA']);
});

test('district rows: label, margin / Toss-up / No votes yet', () => {
  assert.equal(districtLabel('7'), 'District 7');
  assert.equal(districtLabel('07'), 'District 7');
  assert.equal(districtLabel('AL'), 'At large');
  assert.equal(districtLabel(null), 'At large');
  assert.deepEqual(districtLine(seat({ marginPts: 4.25 })), { status: 'dLead', text: '+4.3' });
  assert.deepEqual(districtLine(seat({ marginPts: 0.3 })), { status: 'toss', text: 'Toss-up' });
  assert.deepEqual(districtLine(seat({ totalVotes: 0 })), { status: 'none', text: 'No votes yet' });
});

test('running mates pass through candidate rows', () => {
  const { rows } = candidateList({ candidates: [{ name: 'Byron Donalds', party: 'REP', votes: 5, runningMate: 'Jay Collins' }, { name: 'David Jolly', party: 'DEM', votes: 4 }] });
  assert.deepEqual(rows.map((r) => r.runningMate), ['Jay Collins', null]);
});

test('singular / plural copy', () => {
  assert.equal(countWord(1, 'county publishes its', 'counties publish their'), '1 county publishes its');
  assert.equal(countWord(3, 'county publishes its', 'counties publish their'), '3 counties publish their');
});

test('no call language anywhere in the UI source', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(jsx?|css)$/.test(f.name)) files.push(p); } };
  walk(dir);
  for (const f of files) {
    // Strings and JSX text only (code comments may explain the rule).
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const bad = src.match(/\b(won|wins|winner|winners|called|projected|declared)\b/gi)?.filter((w) => !/^called$/i.test(w) || !/\bnot (be )?called\b/i.test(src));
    assert.deepEqual(bad ?? [], [], path.basename(f));
  }
});
