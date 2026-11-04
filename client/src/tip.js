// Map tooltip placement, pure (no DOM). Tested in client/test/tip.test.js.

/** Tooltip width bounds (px). The box is content-sized between them; never wider than the viewport minus margins. */
export const TIP_MIN = 320;
export const TIP_MAX = 420;
/** At or below this viewport width the hover details are a bottom sheet, not a floating box. */
export const SHEET_MAX_VW = 640;
const MARGIN = 8;
const GAP = 16;

export const isSheetWidth = (vw) => Number(vw) <= SHEET_MAX_VW;

/** Effective [min, max] width for a viewport: fits inside the margins on narrow screens. */
export function tipWidthBounds(vw) {
  const room = Math.max(0, Number(vw) - 2 * MARGIN);
  return [Math.min(TIP_MIN, room), Math.min(TIP_MAX, room)];
}

/**
 * Where to put a w×h box near the pointer (x, y) inside a vw×vh viewport: right/below the pointer, flipped left/up when
 * it would overflow, then clamped so it always stays fully on screen.
 */
export function tipPosition({ x, y, w, h, vw, vh }) {
  let left = x + GAP;
  if (left + w > vw - MARGIN) left = x - GAP - w;
  left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
  let top = y + GAP;
  if (top + h > vh - MARGIN) top = y - GAP - h;
  top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
  return { left, top };
}
