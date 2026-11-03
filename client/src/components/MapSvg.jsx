import React, { useState } from 'react';
import { path } from '../geo.js';
import { shade, NO_SOURCE_PATTERN } from '../shading.js';

/**
 * Generic choropleth.
 * features: GeoJSON features (pre-projected)
 * entryFor(feature) -> result entry or undefined
 * renderTooltip(feature, entry) -> ReactNode
 * outline: optional feature drawn on top with no fill
 */
export default function MapSvg({ features, entryFor, renderTooltip, onSelect, viewBox, outline, label }) {
  const [hover, setHover] = useState(null); // { feature, x, y }
  const P = NO_SOURCE_PATTERN;
  return (
    <div>
      <svg className="map" viewBox={viewBox} role="img" aria-label={label}>
        <defs>
          <pattern id={P.id} width={P.size} height={P.size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={P.size} height={P.size} fill={P.background} />
            <line x1="0" y1="0" x2="0" y2={P.size} stroke={P.line} strokeWidth="2" />
          </pattern>
        </defs>
        {features.map((f) => {
          const s = shade(entryFor(f));
          return (
            <path
              key={f.id}
              className="area"
              d={path(f)}
              fill={s.fill}
              stroke={s.stroke}
              strokeDasharray={s.strokeDasharray || undefined}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              onMouseMove={(e) => setHover({ feature: f, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
              onClick={onSelect ? () => onSelect(f) : undefined}
            />
          );
        })}
        {outline && (
          <path d={path(outline)} fill="none" stroke="#333" strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        )}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 330), top: hover.y + 14 }}>
          {renderTooltip(hover.feature, entryFor(hover.feature))}
        </div>
      )}
    </div>
  );
}
