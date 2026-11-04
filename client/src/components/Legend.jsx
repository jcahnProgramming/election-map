import React from 'react';
import { legendItems } from '../shading.js';

export default function Legend({ showNoData = false }) {
  const items = legendItems();
  return (
    <ul className="legend" aria-label="Map legend">
      {items.map((l) => (
        <li key={l.label}>
          <span
            className={`swatch ${l.kind === 'awaiting' ? 'awaiting' : l.kind === 'hatch' ? 'hatch' : l.kind === 'other' ? 'other' : ''}`}
            style={l.kind === 'fill' || l.kind === 'awaiting' ? { background: l.color } : undefined}
            aria-hidden="true"
          />
          {l.label}
        </li>
      ))}
      {showNoData && (
        <li>
          <span className="swatch nodata" aria-hidden="true" />
          County not in this source
        </li>
      )}
    </ul>
  );
}
