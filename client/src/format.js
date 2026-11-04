const nf = new Intl.NumberFormat('en-US');
const isNum = (n) => n != null && n !== '' && Number.isFinite(Number(n));
export const fmtVotes = (n) => (isNum(n) ? nf.format(Number(n)) : '—');
export const fmtPct = (n, digits = 1) => (isNum(n) ? `${Number(n).toFixed(digits)}%` : '—');
/** Reporting % for display: whole numbers, except keep one decimal below 1 so "0.4%" isn't shown as "0%". */
export const fmtReporting = (n) => (isNum(n) ? `${Number(n) > 0 && Number(n) < 1 ? Number(n).toFixed(1) : Math.round(Number(n))}%` : '—');
export const barWidth = (pct) => `${isNum(pct) ? Math.max(0, Math.min(100, Number(pct))).toFixed(1) : 0}%`;

export const RACES = ['senate', 'governor', 'house'];
export const RACE_SHORT = { senate: 'Senate', governor: 'Governor', house: 'House' };
export const RACE_LONG = {
  senate: 'U.S. Senate',
  governor: 'Governor',
  house: 'U.S. House · statewide popular vote',
};

/** "Nov 3, 2026" from "2026-11-03" without timezone drift. */
export function fmtDate(ymd) {
  if (!ymd) return '';
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ymd);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Host name of a URL, for compact "Source: …" lines. */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}
