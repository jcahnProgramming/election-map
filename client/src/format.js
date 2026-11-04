const nf = new Intl.NumberFormat('en-US');
const isNum = (n) => n != null && n !== '' && Number.isFinite(Number(n));
export const fmtVotes = (n) => (isNum(n) ? nf.format(Number(n)) : '—');
export const fmtPct = (n, digits = 1) => (isNum(n) ? `${Number(n).toFixed(digits)}%` : '—');
/** Reporting % for display: whole numbers, except keep one decimal below 1 so "0.4%" isn't shown as "0%". */
export const fmtReporting = (n) => (isNum(n) ? `${Number(n) > 0 && Number(n) < 1 ? Number(n).toFixed(1) : Math.round(Number(n))}%` : '—');
/**
 * What a source says about how much is counted: its own % ("37% in"), or, for sources that publish counties complete
 * instead (Clarity statewide sites), "5 of 64 counties complete". Never a % we derived. null when neither is published.
 */
export function reportingText(e, word = 'in') {
  if (isNum(e?.pctReporting)) return `${fmtReporting(e.pctReporting)} ${word}`;
  if (isNum(e?.countiesTotal) && Number(e.countiesTotal) > 0) {
    const label = e.countiesLabel === 'reported' ? 'counties reported' : e.countiesLabel === 'precincts reported' ? 'precincts reported' : 'counties complete';
    return `${fmtVotes(e.countiesComplete ?? 0)} of ${fmtVotes(e.countiesTotal)} ${label}`;
  }
  return null;
}
export const barWidth = (pct) => `${isNum(pct) ? Math.max(0, Math.min(100, Number(pct))).toFixed(1) : 0}%`;

export const RACES = ['senate', 'governor', 'house'];
export const RACE_SHORT = { top: 'Top race', senate: 'Senate', governor: 'Governor', house: 'House' };
export const RACE_LONG = {
  top: 'Top race on the ballot',
  senate: 'U.S. Senate',
  governor: 'Governor',
  house: 'U.S. House · statewide popular vote',
};

// Labels for every other office come from the server (/api/offices); App registers them here once loaded.
const officeLabels = new Map();
export function registerOfficeLabels(levels) {
  for (const list of Object.values(levels || {})) for (const o of list || []) if (o?.office && o.label) officeLabels.set(o.office, o.label);
}
const titleize = (k) => String(k || '').split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
/** Short office name for buttons and sentences ("Senate", "Attorney General"). */
export const shortLabel = (office) => RACE_SHORT[office] ?? officeLabels.get(office) ?? titleize(office);
/** Long office name for headings ("U.S. Senate", "U.S. House · statewide popular vote"). */
export const longLabel = (office) => RACE_LONG[office] ?? officeLabels.get(office) ?? titleize(office);

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
