import React, { useLayoutEffect, useRef, useState } from 'react';
import { shade, NO_SOURCE_PATTERN } from '../shading.js';

/**
 * Choropleth in a fixed 975x610 frame (no layout jump while data loads or refreshes).
 * features: pre-projected GeoJSON; pathFn: d3 geoPath; entryFor(f) -> result entry | undefined
 * renderTip(f, entry) -> ReactNode; onPick(f) optional; selectedId: feature drawn with a highlight.
 */
export default function MapSvg({ features, pathFn, entryFor, renderTip, onPick, selectedId, label, strokeWidth = 0.8 }) {
  const [hover, setHover] = useState(null); // { f, x, y }
  const P = NO_SOURCE_PATTERN;
  const hoverF = hover?.f;
  const sel = selectedId != null ? features.find((f) => f.id === selectedId) : null;

  return (
    <div className="map-box" onMouseLeave={() => setHover(null)}>
      <svg viewBox="0 0 975 610" role="img" aria-label={label}>
        <defs>
          <pattern id={P.id} width={P.size} height={P.size} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={P.size} height={P.size} fill={P.background} />
            <line x1="0" y1="0" x2="0" y2={P.size} stroke={P.line} strokeWidth="2.5" />
          </pattern>
        </defs>
        <g>
          {features.map((f) => {
            const s = shade(entryFor(f));
            return (
              <path
                key={f.id}
                className="area"
                d={pathFn(f)}
                fill={s.fill}
                stroke={s.stroke}
                strokeWidth={s.dash ? strokeWidth * 1.2 : strokeWidth}
                strokeDasharray={s.dash || undefined}
                strokeLinejoin="round"
                onMouseMove={(e) => setHover({ f, x: e.clientX, y: e.clientY })}
                onClick={onPick ? () => { setHover(null); onPick(f); } : undefined}
              />
            );
          })}
        </g>
        {sel && <path d={pathFn(sel)} fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinejoin="round" pointerEvents="none" />}
        {hoverF && hoverF !== sel && (
          <path d={pathFn(hoverF)} fill="none" stroke="#FFFFFF" strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
        )}
      </svg>
      {hover && <Tip x={hover.x} y={hover.y}>{renderTip(hover.f, entryFor(hover.f))}</Tip>}
    </div>
  );
}

/** Fixed-position tooltip, measured and clamped so it never leaves the viewport. */
function Tip({ x, y, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const M = 8, G = 16;
    let left = x + G;
    if (left + w > vw - M) left = x - G - w;
    left = Math.max(M, Math.min(left, vw - w - M));
    let top = y + G;
    if (top + h > vh - M) top = y - G - h;
    top = Math.max(M, Math.min(top, vh - h - M));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });
  return (
    <div ref={ref} className="tip" style={pos} role="tooltip">
      {children}
    </div>
  );
}
