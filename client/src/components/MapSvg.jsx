import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shade, NO_SOURCE_PATTERN } from '../shading.js';
import { tipPosition, tipWidthBounds, SHEET_MAX_VW } from '../tip.js';

const SHEET_QUERY = `(max-width: ${SHEET_MAX_VW}px)`;
function useSheetMode() {
  const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(SHEET_QUERY).matches : false);
  const [sheet, setSheet] = useState(mq);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const m = window.matchMedia(SHEET_QUERY);
    const on = () => setSheet(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return sheet;
}

/**
 * Choropleth in a fixed 975x610 frame (no layout jump while data loads or refreshes).
 * features: pre-projected GeoJSON; pathFn: d3 geoPath; entryFor(f) -> result entry | undefined
 * renderTip(f, entry) -> ReactNode; onPick(f) optional; selectedId: feature drawn with a highlight.
 * pickLabel(f): the bottom-sheet button text (phone width), e.g. "Open Colorado".
 *
 * Desktop: hover shows a floating tooltip near the pointer. Phone width: a tap shows the same details in a bottom
 * sheet; tapping the same area again (or the sheet's button) picks it.
 */
export default function MapSvg({ features, pathFn, entryFor, renderTip, onPick, onHover, selectedId, label, strokeWidth = 0.8, pickLabel }) {
  const sheet = useSheetMode();
  const [hover, setHoverState] = useState(null); // { f, x, y }
  const setHover = (h) => {
    setHoverState(h);
    if (h && onHover) onHover(h.f); // the caller keeps the last one (e.g. for a clickable source bar)
  };
  useEffect(() => setHoverState(null), [sheet]);
  const P = NO_SOURCE_PATTERN;
  const hoverF = hover?.f;
  const sel = selectedId != null ? features.find((f) => f.id === selectedId) : null;
  const pick = (f) => { setHover(null); onPick?.(f); };
  const click = (f, e) => {
    if (!sheet) { if (onPick) pick(f); return; }
    if (hover?.f === f && onPick) pick(f);
    else setHover({ f, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="map-box" onMouseLeave={sheet ? undefined : () => setHover(null)}>
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
                onMouseMove={sheet ? undefined : (e) => setHover({ f, x: e.clientX, y: e.clientY })}
                onClick={onPick || sheet ? (e) => click(f, e) : undefined}
              />
            );
          })}
        </g>
        {sel && <path d={pathFn(sel)} fill="none" stroke="#FFFFFF" strokeWidth={2.5} strokeLinejoin="round" pointerEvents="none" />}
        {hoverF && hoverF !== sel && (
          <path d={pathFn(hoverF)} fill="none" stroke="#FFFFFF" strokeWidth={2} strokeLinejoin="round" pointerEvents="none" />
        )}
      </svg>
      {hover && !sheet && <Tip x={hover.x} y={hover.y}>{renderTip(hover.f, entryFor(hover.f))}</Tip>}
      {hover && sheet && (
        <div className="tip sheet" role="region" aria-label="Details" aria-live="polite">
          <div className="sheet-bar">
            {onPick && (
              <button type="button" className="btn sheet-open" onClick={() => pick(hover.f)}>
                {pickLabel ? pickLabel(hover.f) : 'Open'} →
              </button>
            )}
            <button type="button" className="icon-btn sheet-close" onClick={() => setHoverState(null)} aria-label="Close details">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="sheet-body">{renderTip(hover.f, entryFor(hover.f))}</div>
        </div>
      )}
    </div>
  );
}

/** Fixed-position tooltip: content-sized between TIP_MIN and TIP_MAX, measured and clamped inside the viewport. */
function Tip({ x, y, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const next = tipPosition({ x, y, w, h, vw: document.documentElement.clientWidth, vh: window.innerHeight });
    setPos((p) => (p.left === next.left && p.top === next.top ? p : next));
  });
  const vw = typeof document !== 'undefined' ? document.documentElement.clientWidth : 1024;
  const [minW, maxW] = tipWidthBounds(vw);
  return (
    <div ref={ref} className="tip" style={{ ...pos, minWidth: minW, maxWidth: maxW }} role="tooltip">
      {children}
    </div>
  );
}
