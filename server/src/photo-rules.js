// Candidate-photo rules with no Node / DOM dependencies, shared by the server (photos.js), the photo review page
// (client/dev/photos-review.html) and scripts/photos-apply.js. One fairness rule, one place.

export const PHOTO_SOURCE_TYPES = ['official_portrait', 'wikimedia_commons', 'campaign_press_kit', 'candidate_submitted'];
export const MAJOR_SHARE = 5; // % of counted votes that makes any candidate "major"
export const MIN_PHOTO_PX = 200; // review flag: smaller images look poor even as a 40 px avatar on a high-DPI screen

/** Lowercase, no punctuation or quotes, single spaces: "Robert P. \"Family Man\" Murray, Jr." → "robert p family man murray jr". */
export const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
/** "07" / "7" → "7"; null / "" / "AL" / "at large" → "". */
export const normDistrict = (d) => {
  const s = String(d ?? '').trim().toLowerCase();
  if (!s || s === 'al' || /^at[- ]?large$/.test(s)) return '';
  return /^\d+$/.test(s) ? String(Number(s)) : s;
};

export const isWriteIn = (c) => /\bwrite[- ]?ins?\b/i.test(String(c?.name ?? '')) || /^(w|wi|wri|write-in|write in)$/i.test(String(c?.partyRaw ?? '').trim());
// Labels that mean "no party": not a party nominee (they're major only at ≥ 5%).
const NO_PARTY = /^(|ind|i|indep|independent|una|uaf|unaffiliated|unc|np|npa|nonp|non|nonpartisan|non partisan|no party|no party preference|npp|non-partis|nonprtycan|none|oth|other|other-part|other party|pc|pet|petitioning candidate|w|wi|wri|write-in|write in)$/;

/** A party nominee of a party (any label other than "no party" / independent / write-in). */
export const isPartyNominee = (c) => {
  if (!c || isWriteIn(c)) return false;
  if (c.party === 'DEM' || c.party === 'REP') return true;
  return !NO_PARTY.test(String(c.partyRaw ?? '').trim().toLowerCase().replace(/\s+/g, ' '));
};

// ---- Candidate photo files (config/elections/<key>/candidates/<ST>.json) ----

/** The contest an entry belongs to: "senate", "governor", "house:7". */
export const contestKey = (e) => (e.office === 'house' ? `house:${normDistrict(e.district) || 'AL'}` : e.office);
/** Stable id of one entry within its state file: "<contest>:<normalized feed name>". */
export const candidateId = (e) => `${contestKey(e)}:${normName(e.match?.[0])}`;
/** An entry as the shared rules see a candidate (name / party / partyRaw). */
export const asCandidate = (e) => ({ name: e.match?.[0] ?? '', party: e.party ?? null, partyRaw: e.party_raw ?? e.party ?? null });
/** Major in a photo file = a party nominee (the file has no vote counts; at runtime anyone at ≥ 5% is major too). */
export const isMajorEntry = (e) => isPartyNominee(asCandidate(e));

/**
 * Fairness per contest over a state's photo entries. `approved(e)` says whether an entry's photo is (or will be)
 * reviewed and kept. Photos show only when every major candidate in the contest has one.
 * @returns {{ key, office, district, majors:number, withPhoto:number, show:boolean, missing:string[] }[]}
 */
export function contestFairness(entries, approved = (e) => e.reviewed === true && !!e.photo_url) {
  const byContest = new Map();
  for (const e of entries || []) {
    const k = contestKey(e);
    if (!byContest.has(k)) byContest.set(k, []);
    byContest.get(k).push(e);
  }
  return [...byContest].map(([key, list]) => {
    const majors = list.filter(isMajorEntry);
    const missing = majors.filter((e) => !(e.photo_url && approved(e))).map((e) => e.match[0]);
    return {
      key, office: list[0].office, district: list[0].district ?? null,
      majors: majors.length, withPhoto: majors.length - missing.length,
      show: majors.length > 0 && missing.length === 0, missing,
    };
  });
}

// ---- Review flags (shown on the review page; they never decide anything) ----

const LICENSE_OK = /^(cc0|cc[ -]?by(?:[ -]sa)?(?:[ -]\d(?:\.\d)?)?|public domain|pd\b|pd-)/i;

/** Surname used for the Commons file-title check: the top of a ticket, without suffixes or quoted nicknames. */
export function surnameOf(name) {
  const first = String(name ?? '').split(/\s+(?:and|&)\s+|\s*\/\s*/i)[0].replace(/["“”][^"“”]*["“”]/g, ' ');
  const words = first.split(/[\s,]+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean)
    .filter((w) => !/^(jr|sr|ii|iii|iv|md|phd)\.?$/i.test(w));
  return words.length ? words[words.length - 1] : '';
}

/** "Mark_Baisley_in_2024_(cropped).jpg" from a commons.wikimedia.org File: page URL (null otherwise). */
export function commonsFileTitle(url) {
  const m = String(url ?? '').match(/commons\.wikimedia\.org\/wiki\/File:(.+)$/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * Things a reviewer should look at twice. `size` = the image's natural { width, height } once loaded (optional).
 * @returns {string[]} human-readable flags
 */
export function reviewFlags(e, size = null) {
  const flags = [];
  if (!e.license) flags.push('No license recorded');
  else if (!LICENSE_OK.test(String(e.license).trim())) flags.push(`License not CC0 / CC BY / CC BY-SA / public domain: ${e.license}`);
  if (size && (size.width < MIN_PHOTO_PX || size.height < MIN_PHOTO_PX)) flags.push(`Small image: ${size.width}×${size.height}px`);
  const title = commonsFileTitle(e.source_page_url);
  const sur = surnameOf(e.match?.[0]);
  if (e.source_type === 'wikimedia_commons' && sur && !(title && normName(title).includes(normName(sur)))) {
    flags.push(`Commons file title doesn't contain "${sur}"`);
  }
  return flags;
}
