// Candidate photos (config/elections/<key>/candidates/<ST>.json, see docs/photos-data.md).
//
// Sourcing and review: only entries with an allowed source_type, a photo_url and `reviewed: true` are ever used. The
// server fetches each reviewed photo once (polite User-Agent), resizes it to a small square and caches it on disk under
// DATA_DIR/photos; visitors' browsers load it from our own domain (/photos/<id>.jpg), never from the third-party site.
//
// Fairness: within a contest, photos are shown only when EVERY major candidate has a reviewed, cached photo; otherwise
// every candidate in that contest gets initials. Major = a party nominee (any party label that isn't independent /
// unaffiliated / no party / write-in) or any candidate with at least 5% of the votes counted. Write-ins and minor
// candidates always get initials.
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CONFIG_DIR, config } from './config.js';
import { getBuffer } from './http.js';
import { logger } from './log.js';

const log = logger('photos');

export const PHOTO_SOURCE_TYPES = ['official_portrait', 'wikimedia_commons', 'campaign_press_kit', 'candidate_submitted'];
export const MAJOR_SHARE = 5; // % of counted votes that makes any candidate "major"
export const PHOTO_SIZE = 160; // px, square

const PHOTO_OFFICES = new Set(['senate', 'governor', 'house']);

/** Lowercase, no punctuation or quotes, single spaces: "Robert P. \"Family Man\" Murray, Jr." → "robert p family man murray jr". */
export const normName = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
/** "07" / "7" → "7"; null / "" / "AL" / "at large" → "". */
export const normDistrict = (d) => {
  const s = String(d ?? '').trim().toLowerCase();
  if (!s || s === 'al' || /^at[- ]?large$/.test(s)) return '';
  return /^\d+$/.test(s) ? String(Number(s)) : s;
};

export const photoId = (url) => createHash('sha256').update(String(url)).digest('hex').slice(0, 20);

const isWriteIn = (c) => /\bwrite[- ]?ins?\b/i.test(String(c?.name ?? '')) || /^(w|wi|write-in|write in)$/i.test(String(c?.partyRaw ?? '').trim());
// Labels that mean "no party": not a party nominee (they're major only at ≥ 5%).
const NO_PARTY = /^(|ind|i|indep|independent|una|uaf|unaffiliated|unc|np|npa|nonp|non|nonpartisan|non partisan|no party|no party preference|npp|non-partis|nonprtycan|none|oth|other|other-part|other party|pc|pet|petitioning candidate|w|wi|write-in|write in)$/;

/** A party nominee of a party (any label other than "no party" / independent / write-in). */
export const isPartyNominee = (c) => {
  if (!c || isWriteIn(c)) return false;
  if (c.party === 'DEM' || c.party === 'REP') return true;
  return !NO_PARTY.test(String(c.partyRaw ?? '').trim().toLowerCase().replace(/\s+/g, ' '));
};

/** Major candidates of one contest: party nominees plus anyone at ≥ MAJOR_SHARE% of the votes counted. */
export function majorCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const total = list.reduce((s, c) => s + (Number(c.votes) || 0), 0);
  return list.filter((c) => !isWriteIn(c) && (isPartyNominee(c) || (total > 0 && (100 * (Number(c.votes) || 0)) / total >= MAJOR_SHARE)));
}

/**
 * The fairness rule, pure. `photoOf(candidate)` returns the candidate's servable photo or null.
 * @returns {Map<string, object>|null} name → photo for every major candidate, or null (initials for everyone).
 */
export function decidePhotos(candidates, photoOf) {
  const majors = majorCandidates(candidates);
  if (!majors.length) return null;
  const out = new Map();
  for (const c of majors) {
    const p = photoOf(c);
    if (!p) return null;
    out.set(c.name, p);
  }
  return out;
}

/** Candidates with `photo` set from a decision (never mutates). No decision → the list unchanged. */
export function attachPhotos(candidates, decision) {
  if (!decision || !Array.isArray(candidates)) return candidates;
  return candidates.map((c) => (decision.has(c.name) ? { ...c, photo: decision.get(c.name) } : c));
}

/** True when an entry may be served: allowed source, a photo URL, and a human set reviewed: true. */
export const isServable = (e) => !!e && e.reviewed === true && typeof e.photo_url === 'string' && /^https:\/\//.test(e.photo_url)
  && PHOTO_SOURCE_TYPES.includes(e.source_type);

/** What a visitor's browser gets: our own URL plus credit / license / source page. */
export const publicPhoto = (e) => ({
  url: `/photos/${photoId(e.photo_url)}.jpg`,
  credit: e.credit ?? null,
  license: e.license ?? null,
  sourcePage: e.source_page_url ?? null,
  sourceType: e.source_type,
});

/**
 * @param {{ configDir?:string, dataDir?:string, fetchImage?:(url)=>Promise<Uint8Array>, resize?:(buf)=>Promise<Buffer> }} [opts]
 */
export function createPhotos(opts = {}) {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const dir = path.join(opts.dataDir ?? config.dataDir, 'photos');
  const cache = new Map(); // ek → Map(state → entries[])
  const byId = new Map(); // id → entry (reviewed only)
  const inflight = new Map();

  function load(ek) {
    if (cache.has(ek)) return cache.get(ek);
    const out = new Map();
    const d = path.join(configDir, 'elections', ek, 'candidates');
    if (existsSync(d)) {
      for (const f of readdirSync(d).filter((x) => /^[A-Z]{2}\.json$/.test(x)).sort()) {
        try {
          const doc = JSON.parse(readFileSync(path.join(d, f), 'utf8'));
          const st = String(doc.state ?? f.slice(0, 2)).toUpperCase();
          const list = (doc.candidates ?? []).filter((e) => e && Array.isArray(e.match)).map((e) => ({
            ...e, state: st, _names: new Set(e.match.map(normName)), _district: normDistrict(e.district),
          }));
          out.set(st, list);
          for (const e of list) if (isServable(e)) byId.set(photoId(e.photo_url), e);
        } catch (err) {
          log.error(`skipping ${ek}/${f}: ${err.message}`);
        }
      }
    }
    cache.set(ek, out);
    return out;
  }

  /** The reviewed entry for one candidate in one contest, or null. */
  function entryFor(ek, state, office, district, name) {
    if (!PHOTO_OFFICES.has(office)) return null;
    const n = normName(name);
    const d = office === 'house' ? normDistrict(district) : '';
    return (load(ek).get(state) ?? []).find((e) => e.office === office && (office !== 'house' || e._district === d) && e._names.has(n)) ?? null;
  }

  const file = (id) => path.join(dir, `${id}.jpg`);
  const isCached = (id) => existsSync(file(id));

  /** A servable photo for this candidate: reviewed AND already cached on disk (a missing image must not break fairness). */
  function photoFor(ek, state, office, district, c) {
    const e = entryFor(ek, state, office, district, c?.name);
    if (!isServable(e)) return null;
    return isCached(photoId(e.photo_url)) ? publicPhoto(e) : null;
  }

  /** Fairness decision for one contest's candidate list (statewide numbers). */
  function decide(ek, state, office, district, candidates) {
    if (!PHOTO_OFFICES.has(office)) return null;
    return decidePhotos(candidates, (c) => photoFor(ek, state, office, district, c));
  }

  const fetchImage = opts.fetchImage ?? (async (url) => (await getBuffer(url, { accept: 'image/*', timeoutMs: 30000 })).body);
  const resize = opts.resize ?? (async (buf) => {
    const sharp = (await import('sharp')).default;
    return sharp(buf).rotate().resize(PHOTO_SIZE, PHOTO_SIZE, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  });

  /** Fetch + resize + cache one reviewed photo (once; concurrent callers share the work). */
  function ensure(id) {
    const e = byId.get(id);
    if (!isServable(e)) return Promise.resolve(false);
    if (isCached(id)) return Promise.resolve(true);
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        const out = await resize(Buffer.from(await fetchImage(e.photo_url)));
        const tmp = `${file(id)}.tmp`;
        writeFileSync(tmp, out);
        renameSync(tmp, file(id));
        return true;
      } catch (err) {
        log.warn(`photo ${e.state} ${e.match[0]}: ${err.message}`);
        return false;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  }

  /** Cache every reviewed photo of an election, a couple at a time. Resolves to { cached, failed }. */
  async function prefetch(ek) {
    load(ek);
    const ids = [...byId.keys()].filter((id) => !isCached(id));
    let cached = 0, failed = 0;
    const work = [...ids];
    const worker = async () => {
      while (work.length) {
        if (await ensure(work.shift())) cached++; else failed++;
      }
    };
    await Promise.all([worker(), worker()]);
    if (ids.length) log.info(`photos: ${cached} cached, ${failed} failed`);
    return { cached, failed };
  }

  /** Express handler for GET /photos/:id.jpg — reviewed photos only, from our disk cache. */
  async function serve(req, res) {
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{20}$/.test(id) || !isServable(byId.get(id))) return res.status(404).type('text').send('not found');
    if (!(await ensure(id))) return res.status(404).type('text').send('not found');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg').sendFile(file(id));
  }

  return { load, entryFor, photoFor, decide, prefetch, ensure, serve, isCached, reset: () => { cache.clear(); byId.clear(); } };
}
