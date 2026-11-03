// Pure shading rule for states and counties. No React / DOM dependencies,
// so the final design can reuse (and re-palette) it.
//
// Input: any result entry with { status?, leader, marginPts, totalVotes }.
//   - National state entries carry `status`.
//   - County entries have no `status`; it is derived from totalVotes.
// Output: { key, fill, stroke, strokeDasharray, label }
//   `fill` for no-source is `url(#<NO_SOURCE_PATTERN_ID>)`; the SVG must
//   define that pattern (see NO_SOURCE_PATTERN below).

export const TOSSUP_MARGIN = 2; // < 2 points => toss-up purple

// Margin bands (points), narrowest first. Index into each party's palette.
export const MARGIN_BANDS = [
  { min: 2, max: 5, label: '2–5' },
  { min: 5, max: 10, label: '5–10' },
  { min: 10, max: 20, label: '10–20' },
  { min: 20, max: Infinity, label: '20+' },
];

export const PALETTE = {
  DEM: ['#c6dbef', '#9ecae1', '#4292c6', '#08519c'],
  REP: ['#fcbba1', '#fc9272', '#ef3b2c', '#a50f15'],
  OTHER: ['#c7e9c0', '#a1d99b', '#41ab5d', '#006d2c'],
  tossup: '#9e7bb5',
  noRace: '#d9d9d9',
  noSourceBg: '#bdbdbd',
  noSourceLine: '#6e6e6e',
  awaiting: '#fafafa',
  awaitingStroke: '#666',
  stroke: '#fff',
};

export const NO_SOURCE_PATTERN_ID = 'hatch-no-source';
export const NO_SOURCE_PATTERN = {
  id: NO_SOURCE_PATTERN_ID,
  size: 6,
  background: PALETTE.noSourceBg,
  line: PALETTE.noSourceLine,
};

/** Returns the band index (0..3) for a margin in points, or -1 for toss-up. */
export function marginBandIndex(marginPts) {
  if (marginPts == null || !isFinite(marginPts)) return 0; // unknown margin: lightest band
  const m = Math.abs(marginPts);
  if (m < TOSSUP_MARGIN) return -1;
  for (let i = MARGIN_BANDS.length - 1; i >= 0; i--) if (m >= MARGIN_BANDS[i].min) return i;
  return 0;
}

/** Effective status for an entry (derives one for county entries). */
export function effectiveStatus(entry) {
  if (!entry) return 'no-data';
  if (entry.status) return entry.status;
  return entry.totalVotes > 0 ? 'reporting' : 'awaiting';
}

export function shade(entry) {
  const status = effectiveStatus(entry);
  const base = { stroke: PALETTE.stroke, strokeDasharray: null };
  switch (status) {
    case 'no-race':
      return { ...base, key: 'no-race', fill: PALETTE.noRace, label: 'No race' };
    case 'no-source':
      return { ...base, key: 'no-source', fill: `url(#${NO_SOURCE_PATTERN_ID})`, label: 'No data source yet' };
    case 'awaiting':
      return { key: 'awaiting', fill: PALETTE.awaiting, stroke: PALETTE.awaitingStroke, strokeDasharray: '3 2', label: 'No votes counted yet' };
    case 'no-data':
      return { ...base, key: 'no-data', fill: PALETTE.noRace, label: 'No data' };
    case 'reporting':
    default: {
      const leader = entry.leader;
      const band = marginBandIndex(entry.marginPts);
      if (!leader || band === -1) return { ...base, key: 'tossup', fill: PALETTE.tossup, label: 'Toss-up (< 2 pts)' };
      const pal = PALETTE[leader] || PALETTE.OTHER;
      return { ...base, key: `${leader}-${band}`, fill: pal[band], label: `${leader} leading by ${MARGIN_BANDS[band].label} pts` };
    }
  }
}

export default shade;
