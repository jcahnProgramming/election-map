// Candidate avatars, pure (no React / DOM). Tested in client/test/avatar.test.js.
// Default: initials on a party tint (DEM / REP: our blue / red family at low saturation; every other party: neutral
// grey), at least 4.5:1 contrast. A photo is used only when the server attached one: it applies the review gate and the
// fairness rule (every major candidate in the contest has a reviewed photo, or none of them gets one).

const SUFFIX = /^(jr|sr|ii|iii|iv|v|md|phd|esq)$/i;

/**
 * "JH" for "John Hickenlooper"; the first person of a ticket ("Ned Lamont and Susan Bysiewicz", "A / B");
 * nicknames in quotes and suffixes (Jr., III) skipped; "ANGELA \"HELI\" RODRIGUEZ PRILLIMAN" → "AP". One letter for one word.
 */
export function initials(name) {
  let s = String(name ?? '').trim();
  s = s.split(/\s+(?:and|&)\s+|\s*\/\s*/i)[0]; // the top of the ticket
  s = s.replace(/["“”][^"“”]*["“”]/g, ' ').replace(/\([^)]*\)/g, ' ');
  const words = s.split(/[\s,]+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter((w) => w && !SUFFIX.test(w.replace(/\./g, '')));
  if (!words.length) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1].replace(/^['-]+/, '')[0] : '';
  return `${first}${last ?? ''}`.toUpperCase();
}

/** Avatar colours by normalized party: { bg, fg, ring }. */
export const AVATAR_TONE = {
  DEM: { bg: '#1F2D4D', fg: '#D6E2FD', ring: '#3A5590' },
  REP: { bg: '#45232A', fg: '#FAD6D6', ring: '#8A3F47' },
  OTHER: { bg: '#2A313C', fg: '#E6EDF3', ring: '#4B5563' },
};
export const avatarTone = (party) => AVATAR_TONE[party === 'DEM' || party === 'REP' ? party : 'OTHER'];

const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
/** WCAG contrast ratio between two #RRGGBB colours. */
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** "Wikimedia Commons · CC BY-SA 4.0 · Gage Skidmore" style credit line for a served photo. */
export function photoCredit(photo) {
  if (!photo) return '';
  const src = { official_portrait: 'Official portrait', wikimedia_commons: 'Wikimedia Commons', campaign_press_kit: 'Campaign press kit',
    candidate_submitted: 'Submitted by the candidate' }[photo.sourceType] || 'Photo';
  return [photo.credit ? `Photo: ${photo.credit}` : src, photo.license, photo.credit ? src : null].filter(Boolean).join(' · ');
}

/** Unique credit lines for a list of candidates (tooltips can't be hovered, so they list credits in the footer). */
export function photoCredits(candidates) {
  return [...new Set((candidates || []).filter((c) => c?.photo).map((c) => `${c.name}: ${photoCredit(c.photo)}`))];
}

/** The Creative Commons deed for a CC license string ("CC BY-SA 4.0" → its deed URL); null for public domain / unknown. */
export function licenseUrl(license) {
  const s = String(license ?? '').trim().toLowerCase().replace(/[\s_]+/g, ' ');
  if (/^cc0\b/.test(s)) return 'https://creativecommons.org/publicdomain/zero/1.0/';
  const m = s.match(/^cc[ -]by([ -]sa)?(?:[ -](\d\.\d))?$/);
  if (!m) return null;
  return `https://creativecommons.org/licenses/${m[1] ? 'by-sa' : 'by'}/${m[2] ?? '4.0'}/`;
}

/**
 * Every photo shown in a view, once each, for its "Photo credits" list: [{ name, credit, license, licenseUrl, sourcePage }].
 * CC BY / CC BY-SA require author, license and a link to the source; public-domain photos are listed too.
 */
export function creditList(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates || []) {
    const p = c?.photo;
    if (!p?.url || seen.has(p.url)) continue;
    seen.add(p.url);
    out.push({ name: c.name, credit: p.credit ?? null, license: p.license ?? null, licenseUrl: licenseUrl(p.license), sourcePage: p.sourcePage ?? null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
