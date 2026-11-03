import React from 'react';
import { PALETTE, MARGIN_BANDS, NO_SOURCE_PATTERN as P } from '../shading.js';

const Sw = ({ fill, dashed, hatch }) => (
  <svg width="14" height="14" style={{ verticalAlign: 'middle', margin: '0 2px 0 8px' }}>
    {hatch && (
      <defs>
        <pattern id="legend-hatch" width={P.size} height={P.size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={P.size} height={P.size} fill={P.background} />
          <line x1="0" y1="0" x2="0" y2={P.size} stroke={P.line} strokeWidth="2" />
        </pattern>
      </defs>
    )}
    <rect x="0.5" y="0.5" width="13" height="13" fill={hatch ? 'url(#legend-hatch)' : fill}
      stroke={dashed ? PALETTE.awaitingStroke : '#888'} strokeDasharray={dashed ? '3 2' : undefined} />
  </svg>
);

export default function Legend() {
  return (
    <div className="legend">
      <div>
        Margin bands (pts): {MARGIN_BANDS.map((b) => b.label).join(', ')} — darker = wider lead.
      </div>
      <div>
        {['DEM', 'REP', 'OTHER'].map((p) => (
          <span key={p}>
            {p} leading:{PALETTE[p].map((c) => <Sw key={c} fill={c} />)}{' '}
          </span>
        ))}
      </div>
      <div>
        <Sw fill={PALETTE.tossup} />Toss-up (&lt; 2 pts)
        <Sw dashed fill={PALETTE.awaiting} />No votes counted yet
        <Sw hatch />No data source yet
        <Sw fill={PALETTE.noRace} />No race
      </div>
    </div>
  );
}
