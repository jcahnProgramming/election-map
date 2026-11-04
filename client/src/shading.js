// Pure shading rule for states and counties. No React / DOM dependencies.
// CLAUDE.md: the design must reuse this one function, not fork it.
//
// Input: any result entry with { status?, leader, marginPts, totalVotes, tied? }.
//   - National state entries carry `status`.
//   - County entries have no `status`; it is derived from totalVotes.
//   - `null`/`undefined` (e.g. a county the source has no row for) => 'no-data'.
// Output: { key, fill, stroke, dash, label, band }
//   `fill` for no-source is `url(#<NO_SOURCE_PATTERN_ID>)`; the SVG must define that pattern
//   (see NO_SOURCE_PATTERN below).

/** |margin| below this many points is a toss-up (purple). The single config constant for it. */
export const TOSSUP_MARGIN = 2;

// Margin bands (points) above the toss-up threshold, narrowest first. Index into each party's palette.
export const MARGIN_BANDS = [
  { min: 0, max: 5, label: '<5' },
  { min: 5, max: 12, label: '5–12' },
  { min: 12, max: Infinity, label: '12+' },
];

export const PALETTE = {
  DEM: ['#93B4FA', '#4F86F7', '#2457D6'],
  REP: ['#F7A1A1', '#EF5B5B', '#C42323'],
  OTHER: ['#8FE3B0', '#34B36B', '#17804A'],
  tossup: '#8B6FD6',
  noRace: '#2A313C',
  noSourceBg: '#1B212B',
  noSourceLine: '#3D4756',
  awaiting: '#11161D',
  awaitingStroke: '#9AA4B2',
  noData: '#171C23',
  multiSeat: '#5B6472',
  stroke: '#0E1116',
};

export const PARTY_COLOR = { DEM: '#4F86F7', REP: '#EF5B5B', OTHER: '#9AA4B2' };
export const PARTY_TEXT = { DEM: '#93B4FA', REP: '#F7A1A1', OTHER: '#9AA4B2' };

export const NO_SOURCE_PATTERN_ID = 'hatch-no-source';
export const NO_SOURCE_PATTERN = {
  id: NO_SOURCE_PATTERN_ID,
  size: 7,
  background: PALETTE.noSourceBg,
  line: PALETTE.noSourceLine,
};

/** Band index (0..2) for a margin in points, or -1 for toss-up (also for an unknown margin). */
export function marginBandIndex(marginPts, tossup = TOSSUP_MARGIN) {
  if (marginPts == null || !Number.isFinite(Number(marginPts))) return -1;
  const m = Math.abs(Number(marginPts));
  if (m < tossup) return -1;
  for (let i = MARGIN_BANDS.length - 1; i >= 0; i--) if (m >= MARGIN_BANDS[i].min) return i;
  return 0;
}

/** Effective status for an entry (derives one for county entries). */
export function effectiveStatus(entry) {
  if (!entry) return 'no-data';
  if (entry.status) return entry.status;
  return entry.totalVotes > 0 ? 'reporting' : 'awaiting';
}

/** 'DEM' | 'REP' | 'OTHER' | 'tossup' | null (null = not reporting). Ties are toss-ups. */
export function leadCategory(entry, tossup = TOSSUP_MARGIN) {
  if (effectiveStatus(entry) !== 'reporting') return null;
  if (entry.multiSeat) return 'multi'; // several winners: no two-way margin to shade
  if (!entry.leader || entry.tied) return 'tossup';
  if (marginBandIndex(entry.marginPts, tossup) === -1) return 'tossup';
  return PALETTE[entry.leader] ? entry.leader : 'OTHER';
}

export function shade(entry, tossup = TOSSUP_MARGIN) {
  const status = effectiveStatus(entry);
  const base = { stroke: PALETTE.stroke, dash: null, band: null };
  switch (status) {
    case 'no-race':
      return { ...base, key: 'no-race', fill: PALETTE.noRace, label: 'No race' };
    case 'no-source':
      return { ...base, key: 'no-source', fill: `url(#${NO_SOURCE_PATTERN_ID})`, label: 'Race, no data source yet' };
    case 'awaiting':
      return { ...base, key: 'awaiting', fill: PALETTE.awaiting, stroke: PALETTE.awaitingStroke, dash: '3 2', label: 'No votes counted yet' };
    case 'no-data':
      return { ...base, key: 'no-data', fill: PALETTE.noData, label: 'No data from this source' };
    case 'reporting':
    default: {
      const cat = leadCategory(entry, tossup);
      if (cat === 'multi') return { ...base, key: 'multi-seat', fill: PALETTE.multiSeat, label: 'Multi-seat contest (see candidates)' };
      if (cat === 'tossup' || !cat) return { ...base, key: 'tossup', fill: PALETTE.tossup, label: `Toss-up <${tossup} pts` };
      const band = marginBandIndex(entry.marginPts, tossup);
      return { ...base, key: `${cat}-${band}`, band, fill: PALETTE[cat][band], label: `${cat} leading ${MARGIN_BANDS[band].label}` };
    }
  }
}

/** Legend entries, in display order. `kind` tells the UI how to draw the swatch. */
export function legendItems(tossup = TOSSUP_MARGIN, { multiSeat = false } = {}) {
  return [
    { kind: 'fill', color: PALETTE.DEM[2], label: 'Dem 12+' },
    { kind: 'fill', color: PALETTE.DEM[1], label: 'Dem 5–12' },
    { kind: 'fill', color: PALETTE.DEM[0], label: 'Dem <5' },
    { kind: 'fill', color: PALETTE.tossup, label: `Toss-up <${tossup} pts` },
    { kind: 'fill', color: PALETTE.REP[0], label: 'Rep <5' },
    { kind: 'fill', color: PALETTE.REP[1], label: 'Rep 5–12' },
    { kind: 'fill', color: PALETTE.REP[2], label: 'Rep 12+' },
    { kind: 'other', colors: PALETTE.OTHER, label: 'Other party leading' },
    { kind: 'awaiting', color: PALETTE.awaiting, stroke: PALETTE.awaitingStroke, label: 'No votes counted yet' },
    { kind: 'hatch', color: PALETTE.noSourceBg, line: PALETTE.noSourceLine, label: 'Race, no data source yet' },
    { kind: 'fill', color: PALETTE.noRace, label: 'No race' },
    ...(multiSeat ? [{ kind: 'fill', color: PALETTE.multiSeat, label: 'Multi-seat contest: votes counted, no margin' }] : []),
  ];
}

export default shade;
