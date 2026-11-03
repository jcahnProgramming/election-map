const nf = new Intl.NumberFormat('en-US');
export const fmtVotes = (n) => (n == null ? '—' : nf.format(n));
export const fmtPct = (n, digits = 1) => (n == null || !isFinite(n) ? '—' : `${Number(n).toFixed(digits)}%`);
export const PARTY_LETTER = { DEM: 'D', REP: 'R', OTHER: 'Oth' };
export function fmtMargin(leader, marginPts) {
  if (!leader || marginPts == null) return '—';
  return `${PARTY_LETTER[leader] || leader} +${Number(marginPts).toFixed(1)} pts`;
}
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
export const STATUS_TEXT = {
  'no-race': 'No race for this office in this state.',
  'no-source': 'This state has this race, but we have no data source for it yet.',
  awaiting: 'No votes counted yet.',
  'no-data': 'No data.',
};
export const RACE_LABEL = {
  senate: 'U.S. Senate',
  governor: 'Governor',
  house: 'U.S. House (statewide popular vote)',
};
