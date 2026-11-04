// Party labels and contest names from many sources → our small normalized vocabulary.
// Everything that isn't clearly DEM or REP is OTHER; the raw label is always kept alongside.

const DEM = new Set(['dem', 'd', 'democrat', 'democratic', 'democratic party', 'dfl', 'democratic farmer labor', 'democratic-farmer-labor', 'democratic farmer-labor']);
const REP = new Set(['rep', 'r', 'gop', 'republican', 'republican party']);
// Labels we have seen and know are third parties / unaffiliated, so we don't log them as unknown.
const KNOWN_OTHER = new Set([
  '', 'lbr', 'lib', 'libertarian', 'grn', 'green', 'uni', 'unity', 'uaf', 'unaffiliated', 'apv', 'approval voting',
  'fwd', 'forward', 'acn', 'american constitution', 'con', 'constitution', 'ind', 'independent', 'np', 'nonpartisan',
  'npa', 'no party', 'no party affiliation', 'wi', 'write-in', 'write in', 'oth', 'other', 'nom', 'nominated by petition',
  'ccp', 'n', 'y', 'unc', 'gre', 'una', 'cst', 'independent party of delaware', 'w', 'l', 'npp', 'peace and justice', 'freedom and unity', 'progressive', 'epic', 'wrk', 'lbt', 'nol', 'pnd', 'amc', 'non', 'ust', 'nlp', 'wcp', 'lmn', 'nwp', 'afp', 'byp', 'soc',
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

// Party-prefixed candidate labels: "REP Darline Graham", "(DEM) Jane Doe", "Jane Doe (R)", "Libertarian - Joe Smith".
// Only strips a prefix/suffix we recognise as a party label; anything else is returned untouched.
const PARTY_TOKEN = /^(dem|rep|gop|lib|lbt|grn|green|ind|npa|np|con|cst|dfl|uni|uaf|wri|wi|oth|nom|soc|ust|unc|wrk|d|r|l|g|i|democratic|democrat|republican|libertarian|independent|nonpartisan|constitution)$/i;

/**
 * Split a party-prefixed candidate name into a clean name and the raw party label.
 * @returns {{ name:string, partyRaw:string|null }} partyRaw null when no party token was found
 */
export function splitPartyPrefix(label) {
  const s = String(label ?? '').trim().replace(/\s+/g, ' ');
  let m = s.match(/^\(([^)]{1,20})\)\s*(.+)$/); // "(DEM) Jane Doe"
  if (m && PARTY_TOKEN.test(m[1].trim())) return { name: m[2].trim(), partyRaw: m[1].trim() };
  m = s.match(/^(.+?)\s*\(([^)]{1,20})\)$/); // "Jane Doe (R)"
  if (m && PARTY_TOKEN.test(m[2].trim())) return { name: m[1].trim(), partyRaw: m[2].trim() };
  m = s.match(/^([A-Za-z]{1,13})\s*[-–:]\s+(.+)$/); // "Libertarian - Joe Smith"
  if (m && PARTY_TOKEN.test(m[1])) return { name: m[2].trim(), partyRaw: m[1] };
  m = s.match(/^([A-Za-z]{1,13})\s+(.+)$/); // "REP Darline Graham" (prefix must be a party token AND upper-case or a full party word)
  if (m && PARTY_TOKEN.test(m[1]) && (m[1] === m[1].toUpperCase() || m[1].length > 3) && m[1].length > 1) {
    return { name: m[2].trim(), partyRaw: m[1] };
  }
  return { name: s, partyRaw: null };
}

/**
 * Normalized bucket for a source's vote-type / vote-method label. The raw label is always stored too.
 * @returns {'mail_early'|'election_day'|'provisional'|'other'}
 */
export function methodBucket(label) {
  const k = String(label ?? '').toLowerCase();
  if (/provision|provionsal/.test(k)) return 'provisional';
  if (/election ?day|in[- ]person on|polling place|precinct|e-?day|vote center.*election|machine|^election$/.test(k)) return 'election_day';
  if (/mail|absentee|early|advance|by ?mail|one[- ]stop|pre[- ]?election|in[- ]person absentee|ballot drop|drop ?box/.test(k)) return 'mail_early';
  return 'other';
}
