// Party labels and contest names from many sources → our small normalized vocabulary.
// Everything that isn't clearly DEM or REP is OTHER; the raw label is always kept alongside.

const DEM = new Set(['dem', 'd', 'democrat', 'democratic', 'democratic party', 'dfl', 'democratic farmer labor', 'democratic-farmer-labor', 'democratic farmer-labor']);
const REP = new Set(['rep', 'r', 'gop', 'republican', 'republican party']);
// Labels we have seen and know are third parties / unaffiliated, so we don't log them as unknown.
const KNOWN_OTHER = new Set([
  '', 'lbr', 'lib', 'libertarian', 'grn', 'green', 'uni', 'unity', 'uaf', 'unaffiliated', 'apv', 'approval voting',
  'fwd', 'forward', 'acn', 'american constitution', 'con', 'constitution', 'ind', 'independent', 'np', 'nonpartisan',
  'npa', 'no party', 'no party affiliation', 'wi', 'write-in', 'write in', 'oth', 'other', 'nom', 'nominated by petition',
  'ccp', 'n', 'y', 'lbt', 'nol', 'pnd', 'amc', 'non', 'ust', 'nlp', 'wcp', 'lmn', 'nwp', 'afp', 'byp', 'soc',
]);

/** @returns {{party:'DEM'|'REP'|'OTHER', known:boolean}} */
export function normalizeParty(raw) {
  const k = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (DEM.has(k)) return { party: 'DEM', known: true };
  if (REP.has(k)) return { party: 'REP', known: true };
  return { party: 'OTHER', known: KNOWN_OTHER.has(k) };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
  'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth'];
const JUDICIAL = /\b(retain|retention|justice|judge|court)\b/i;

/** Lowercase, drop a leading "For", fold "U. S." / "U.S." / "United States" to "us", tidy punctuation. */
function normName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^for\s+/, '')
    .replace(/^(u\.?\s?s\.?|united states)(?=\s)/, 'us')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "District 4", "Dist. 2", "D13", "1st District", "THIRD CONGRESSIONAL DISTRICT", "US Representative 16", "7th". */
export function parseDistrict(n) {
  const m = n.match(/\b(?:district|dist\.?)\s*(?:no\.?\s*)?(\d+)/) ?? n.match(/\bd(\d+)\b/) ?? n.match(/\b(\d+)(?:st|nd|rd|th)\b/) ?? n.match(/\b(\d+)\s*$/);
  if (m) return String(Number(m[1]));
  const w = ORDINALS.findIndex((o) => new RegExp(`\\b${o}\\b`).test(n));
  if (w >= 0) return String(w + 1);
  return /at[- ]large/.test(n) ? 'AL' : null;
}

/**
 * Classify a contest by its name (and choices, for measures). Names vary a lot between offices:
 * "U. S. SENATOR", "FOR UNITED STATES SENATOR", "US Senator 6 YR", "GOV. AND LT. GOV",
 * "REP. IN CONGRESS D13", "Congress Dist. 1", "Representative to the 120th United States Congress - District 1".
 * @returns {{office:'senate'|'governor'|'house'|'measure', district:string|null}|null} null = not a race we track
 */
export function classifyContest(name, choices = []) {
  const n = normName(name);
  const stateLevel = /\b(state|general assembly|legislative|board|regent|education)\b/.test(n);
  if (!stateLevel) {
    if (/^us senat/.test(n)) return { office: 'senate', district: null };
    const house = /^us (representative|house|rep\b|congress)/.test(n)
      || /^(representative|rep\.?) (in|to) (the )?(\d+\w* )?(us |united states )?congress/.test(n)
      || /^congress(ional)?\b/.test(n);
    if (house) return { office: 'house', district: parseDistrict(n.replace(/\b\d+(st|nd|rd|th) (us |united states )?congress\b/, '')) };
  }
  // "Governor of Wayne State University" is a board seat, not a governorship.
  if (/^(governor|gov\.?)(\s|\/|$)/.test(n) && !/^governor of\b/.test(n)) return { office: 'governor', district: null };
  if (isYesNo(choices) && !JUDICIAL.test(n)) return { office: 'measure', district: null };
  return null;
}

export const yesNoSide = (choice) => {
  const c = String(choice).trim().toLowerCase();
  if (/^(yes|for)\b/.test(c)) return 'yes';
  if (/^(no|against)\b/.test(c)) return 'no';
  return null;
};

function isYesNo(choices) {
  if (choices.length !== 2) return false;
  const sides = choices.map(yesNoSide);
  return sides.includes('yes') && sides.includes('no');
}
