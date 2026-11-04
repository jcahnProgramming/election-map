import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shade, marginBandIndex, leadCategory, TOSSUP_MARGIN, PALETTE } from '../src/shading.js';
import {
  tallyStates, estReporting, turnoutPct, precinctPct, methodShares, measureStatus, measureShares,
  leadText, newestTime, fmtMT, MEASURE_TOO_EARLY_PCT, partyTag, candidateList, hasCandidates,
} from '../src/calc.js';

const rep = (leader, marginPts, extra = {}) => ({ status: 'reporting', leader, marginPts, totalVotes: 100, ...extra });

test('TOSSUP_MARGIN defaults to 2', () => assert.equal(TOSSUP_MARGIN, 2));

test('margin bands: <5, 5–12, 12+, toss-up below threshold', () => {
  // Bands use the displayed (one-decimal) margin: 1.99 shows as "2.0 pts" so it isn't a toss-up; 4.99 shows as "5.0".
  assert.equal(marginBandIndex(1.94), -1);
  assert.equal(marginBandIndex(1.99), 0);
  assert.equal(marginBandIndex(2), 0);
  assert.equal(marginBandIndex(4.94), 0);
  assert.equal(marginBandIndex(4.99), 1);
  assert.equal(marginBandIndex(5), 1);
  assert.equal(marginBandIndex(11.9), 1);
  assert.equal(marginBandIndex(12), 2);
  assert.equal(marginBandIndex(-30), 2);
  assert.equal(marginBandIndex(null), -1);
  assert.equal(marginBandIndex(3, 4), -1); // configurable threshold
});

test('shade: palette per party and band', () => {
  assert.equal(shade(rep('DEM', 13)).fill, '#2457D6');
  assert.equal(shade(rep('DEM', 6)).fill, '#4F86F7');
  assert.equal(shade(rep('DEM', 3)).fill, '#93B4FA');
  assert.equal(shade(rep('REP', 3)).fill, '#F7A1A1');
  assert.equal(shade(rep('REP', 6)).fill, '#EF5B5B');
  assert.equal(shade(rep('REP', 20)).fill, '#C42323');
  assert.equal(shade(rep('DEM', 1.5)).fill, '#8B6FD6');
  assert.equal(shade(rep(null, 0, { tied: true })).fill, '#8B6FD6');
  assert.equal(shade(rep('OTHER', 20)).fill, PALETTE.OTHER[2]);
});

test('shade: empty states are distinct', () => {
  const keys = ['no-race', 'no-source', 'awaiting'].map((status) => shade({ status }).key);
  assert.deepEqual(keys, ['no-race', 'no-source', 'awaiting']);
  assert.equal(shade({ status: 'no-race' }).fill, '#2A313C');
  assert.match(shade({ status: 'no-source' }).fill, /^url\(#/);
  assert.equal(shade(undefined).key, 'no-data');
  // county entries: derived status
  assert.equal(shade({ totalVotes: 0, leader: null }).key, 'awaiting');
  assert.equal(shade({ totalVotes: 10, leader: 'REP', marginPts: 40 }).key, 'REP-2');
});

test('leadCategory: only reporting states count', () => {
  assert.equal(leadCategory({ status: 'awaiting' }), null);
  assert.equal(leadCategory(rep('DEM', 2.5)), 'DEM');
});

test('tallyStates counts only reporting; ties are toss-ups', () => {
  const t = tallyStates([
    rep('DEM', 10), rep('DEM', 2), rep('REP', 30), rep('REP', 1), rep(null, 0, { tied: true }),
    { status: 'awaiting' }, { status: 'no-source' }, { status: 'no-race' },
  ]);
  assert.deepEqual(t, { dem: 2, rep: 1, toss: 2, other: 0 });
});

test('estReporting is vote-weighted and skips unknown pct', () => {
  assert.equal(estReporting([]), null);
  assert.equal(estReporting([{ pctReporting: 50, totalVotes: 100 }, { pctReporting: 100, totalVotes: 300 }]), 87.5);
  assert.equal(estReporting([{ pctReporting: null, totalVotes: 1000 }, { pctReporting: 20, totalVotes: 10 }]), 20);
  assert.equal(estReporting([{ pctReporting: 0, totalVotes: 0 }]), null);
});

test('turnoutPct prefers the source figure, never invents 0', () => {
  assert.equal(turnoutPct(null), null);
  assert.equal(turnoutPct({ turnoutPct: 61.2, ballotsCast: 1, registered: 1000 }), 61.2);
  assert.equal(turnoutPct({ ballotsCast: 250, registered: 1000 }), 25);
  assert.equal(turnoutPct({ ballotsCast: 250, registered: null }), null);
  assert.equal(turnoutPct({ ballotsCast: 250, registered: 0 }), null);
});

test('precinctPct', () => {
  assert.equal(precinctPct(5, 10), 50);
  assert.equal(precinctPct(null, 10), null);
  assert.equal(precinctPct(0, 0), null);
});

test('methodShares: share of counted and D/R share within each method', () => {
  const rows = methodShares([
    { label: 'Mail Ballots', bucket: 'mail_early', total: 300, parties: { DEM: 180, REP: 90, OTHER: 30 } },
    { label: 'Election Day', bucket: 'election_day', total: 100, parties: { DEM: 40, REP: 60, OTHER: 0 } },
    { label: 'Provisional', bucket: 'provisional', total: 0, parties: { DEM: 0, REP: 0, OTHER: 0 } },
  ]);
  assert.equal(rows[0].label, 'Mail Ballots');
  assert.equal(rows[0].share, 75);
  assert.equal(rows[0].dPct, 60);
  assert.equal(rows[0].rPct, 30);
  assert.equal(rows[1].rPct, 60);
  assert.equal(rows[2].dPct, null);
  assert.deepEqual(methodShares(null), []);
});

test('measureStatus: TOO EARLY below threshold or unknown, never passed/failed', () => {
  assert.equal(MEASURE_TOO_EARLY_PCT, 10);
  assert.equal(measureStatus({ yes: 10, no: 5, pctReporting: null }), 'too-early');
  assert.equal(measureStatus({ yes: 10, no: 5, pctReporting: 9.9 }), 'too-early');
  assert.equal(measureStatus({ yes: 10, no: 5, pctReporting: 10 }), 'yes');
  assert.equal(measureStatus({ yes: 4, no: 5, pctReporting: 50 }), 'no');
  assert.equal(measureStatus({ yes: 0, no: 0, pctReporting: 50 }), 'too-early');
  assert.deepEqual(measureShares({ yes: 3, no: 1 }), { yesPct: 75, noPct: 25 });
  assert.deepEqual(measureShares({ yes: 0, no: 0 }), { yesPct: null, noPct: null });
});

test('leadText', () => {
  assert.equal(leadText(rep('DEM', 3.21)), 'Democrat leading by 3.2 pts');
  assert.equal(leadText(rep('REP', 1.04)), 'Toss-up · margin 1.0 pts');
  assert.equal(leadText({ status: 'awaiting' }), null);
  // With candidates: the leading candidate by name, with the source's party tag.
  const cands = [
    { name: 'Ann Lee', party: 'DEM', partyRaw: 'DEM', votes: 520 },
    { name: 'Bo Kim', party: 'REP', partyRaw: 'REP', votes: 480 },
  ];
  assert.equal(leadText(rep('DEM', 4, { candidates: cands })), 'Ann Lee (DEM) leading by 4.0 pts');
  assert.equal(leadText(rep('DEM', 1.5, { candidates: cands })), 'Toss-up · Ann Lee (DEM) ahead by 1.5 pts');
  // The House statewide sum names the party, not a fake person.
  assert.equal(leadText(rep('DEM', 4, { partySum: true, candidates: [{ name: 'DEM candidates, all districts', party: 'DEM', votes: 1 }] })),
    'Democrat leading by 4.0 pts');
});

test('partyTag: from the source label; never "Other" for a named third party', () => {
  assert.equal(partyTag({ party: 'DEM', partyRaw: 'Democratic' }), 'DEM');
  assert.equal(partyTag({ party: 'REP', partyRaw: 'R' }), 'REP');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'Libertarian' }), 'LIB');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'IND' }), 'IND');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'Green' }), 'GRN');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: '' }), '');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'Unity' }), 'UNITY');
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'American Constitution' }), 'AMER');
});

test('candidateList: every candidate by votes, same-party candidates separate, write-ins last, cap + more', () => {
  const entry = { candidates: [
    { name: 'Write-in', party: 'OTHER', partyRaw: '', votes: 5 },
    { name: 'C', party: 'REP', partyRaw: 'REP', votes: 300 },
    { name: 'A', party: 'DEM', partyRaw: 'DEM', votes: 400 },
    { name: 'B', party: 'DEM', partyRaw: 'DEM', votes: 250 },
    { name: 'D', party: 'OTHER', partyRaw: 'LIB', votes: 45 },
  ] };
  const all = candidateList(entry);
  assert.deepEqual(all.rows.map((r) => `${r.name}:${r.tag}`), ['A:DEM', 'C:REP', 'B:DEM', 'D:LIB']);
  assert.deepEqual(all.writeIns.map((w) => [w.name, w.votes, w.named]), [['Write-in', 5, false]]);
  assert.equal(all.rows[0].pct, 40);
  const capped = candidateList(entry, 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.more, 2);
  // Named write-in candidates (OH) each keep their own row; tooltips count them in "N more".
  const oh = { candidates: [{ name: 'Brown', party: 'DEM', votes: 9 }, { name: 'Faris', party: 'OTHER', partyRaw: 'Write-in', votes: 1 },
    { name: 'Holliman', party: 'OTHER', partyRaw: 'Write-in', votes: 0 }] };
  assert.deepEqual(candidateList(oh).writeIns.map((w) => w.name), ['Faris', 'Holliman']);
  assert.equal(candidateList(oh, 5).more, 2);
  assert.equal(partyTag({ party: 'OTHER', partyRaw: 'Other-part' }), 'OTHER');
  assert.equal(hasCandidates({ partySum: true, candidates: entry.candidates }), false);
  assert.equal(hasCandidates(entry), true);
});

test('newestTime and fmtMT', () => {
  assert.equal(newestTime([null, '2026-11-04T01:00:00Z', 'bad', '2026-11-04T02:30:00Z']), '2026-11-04T02:30:00Z');
  assert.equal(newestTime([]), null);
  assert.equal(fmtMT('2026-11-04T02:30:00Z'), '19:30 MT'); // MST = UTC-7 on Nov 4
  assert.equal(fmtMT(null), null);
});

test('staleSourceText: only when the source stopped responding; names the time of the last update', async () => {
  const { staleSourceText, fmtMT } = await import('../src/calc.js');
  const e = { sourceResponding: false, sourceUpdatedAt: '2026-11-04T02:51:30Z', fetchedAt: '2026-11-04T02:52:05Z' };
  assert.equal(staleSourceText(e), `Official source not responding — showing last update at ${fmtMT('2026-11-04T02:51:30Z')}`);
  assert.equal(staleSourceText({ ...e, sourceResponding: undefined }), null);
  assert.equal(staleSourceText(null), null);
  assert.equal(staleSourceText({ sourceResponding: false }), 'Official source not responding — showing last update');
});

test('reportingText: the source\'s own % when published; else "X of Y counties complete"; never a derived %', async () => {
  const { reportingText } = await import('../src/format.js');
  // Colorado (Clarity statewide): no % published, only counties complete.
  const co = { pctReporting: null, precinctsReporting: null, precinctsTotal: null, countiesComplete: 5, countiesTotal: 64, totalVotes: 1927294 };
  assert.equal(reportingText(co), '5 of 64 counties complete');
  assert.equal(reportingText(co, 'reporting'), '5 of 64 counties complete');
  assert.doesNotMatch(reportingText(co), /%/);
  assert.equal(reportingText({ pctReporting: 45.9 }), '46% in');
  assert.equal(reportingText({ pctReporting: 0.4 }, 'reporting'), '0.4% reporting');
  assert.equal(reportingText({ pctReporting: null }), null);
  assert.equal(reportingText({ countiesComplete: 0, countiesTotal: 64 }), '0 of 64 counties complete');
});

test('Est. reporting leaves out states that publish counties complete instead of a %', () => {
  const states = [
    { state: 'CO', pctReporting: null, countiesComplete: 5, countiesTotal: 64, totalVotes: 1_900_000 },
    { state: 'LA', pctReporting: 50, totalVotes: 100_000 },
  ];
  assert.equal(estReporting(states), 50);
});

test('measureStatus: a counties-only source shows its counted lead instead of "too early" all night', () => {
  assert.equal(measureStatus({ pctReporting: null, countiesComplete: 5, countiesTotal: 64, yes: 600, no: 400 }), 'yes');
  assert.equal(measureStatus({ pctReporting: null, yes: 600, no: 400 }), 'too-early'); // nothing published at all
  assert.equal(measureStatus({ pctReporting: 5, yes: 600, no: 400 }), 'too-early'); // a real % below the gate
});

test('reportingText words county counts the way the source does ("reported" for Alabama, "complete" for Clarity)', async () => {
  const { reportingText } = await import('../src/format.js');
  assert.equal(reportingText({ countiesComplete: 56, countiesTotal: 67, countiesLabel: 'reported' }), '56 of 67 counties reported');
  assert.equal(reportingText({ countiesComplete: 5, countiesTotal: 64, countiesLabel: 'complete' }), '5 of 64 counties complete');
  assert.equal(reportingText({ countiesComplete: 5, countiesTotal: 64 }), '5 of 64 counties complete');
});
