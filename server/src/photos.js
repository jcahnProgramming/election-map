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

import { PHOTO_SOURCE_TYPES, MAJOR_SHARE, normName, normDistrict, isWriteIn, isPartyNominee, isPermittedLicense } from './photo-rules.js';

export { PHOTO_SOURCE_TYPES, MAJOR_SHARE, normName, normDistrict, isPartyNominee };
export const PHOTO_SIZE = 160; // px, square

const PHOTO_OFFICES = new Set(['senate', 'governor', 'house']);

export const photoId = (url) => createHash('sha256').update(String(url)).digest('hex').slice(0, 20);

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

/**
 * True when an entry may be served: allowed source, an https photo URL, a permitted license (CC0 / CC BY / CC BY-SA /
 * public domain — checked here whatever the review said), and a human set reviewed: true.
 */
export const isServable = (e) => !!e && e.reviewed === true && typeof e.photo_url === 'string' && /^https:\/\//.test(e.photo_url)
  && PHOTO_SOURCE_TYPES.includes(e.source_type)
  && isPermittedLicense(e.license);

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

  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Image hosts (upload.wikimedia.org) answer bursts with 429: fetch one photo at a time with a gap, back off on 429 / 5xx.
  const GAP_MS = opts.gapMs ?? 1000;
  const BACKOFF_MS = opts.backoffMs ?? 30_000;
  const MAX_BACKOFF_MS = 5 * 60_000;
  const MAX_ATTEMPTS = opts.maxAttempts ?? 4;
  const retryable = (err) => {
    const s = Number(err?.status);
    return !s || s === 429 || s === 408 || s >= 500; // no status = network / timeout
  };

  /** One fetch + resize + cache attempt: 'ok' | 'retry' (rate-limited / transient) | 'fail' (not servable / permanent). */
  function attempt(id) {
    const e = byId.get(id);
    if (!isServable(e)) return Promise.resolve('fail');
    if (isCached(id)) return Promise.resolve('ok');
    if (inflight.has(id)) return inflight.get(id);
    const p = (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        const out = await resize(Buffer.from(await fetchImage(e.photo_url)));
        const tmp = `${file(id)}.tmp`;
        writeFileSync(tmp, out);
        renameSync(tmp, file(id));
        return 'ok';
      } catch (err) {
        log.warn(`photo ${e.state} ${e.match[0]}: ${err.message}`);
        return retryable(err) ? 'retry' : 'fail';
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  }

  /** Fetch + resize + cache one reviewed photo (one attempt; concurrent callers share the work). */
  const ensure = async (id) => (await attempt(id)) === 'ok';

  /**
   * Cache every reviewed photo of an election that isn't cached yet: one at a time, GAP_MS apart; on 429 / 5xx wait
   * (30 s, doubling, max 5 min) and retry that photo, up to MAX_ATTEMPTS. Resolves to { cached, failed }.
   */
  const running = new Map(); // ek → the pass in progress (never two at once for one election)
  function prefetch(ek) {
    if (running.has(ek)) return running.get(ek);
    const pass = (async () => {
      load(ek);
      const ids = [...byId.keys()].filter((id) => !isCached(id));
      let cached = 0, failed = 0, backoff = BACKOFF_MS;
      for (const [i, id] of ids.entries()) {
        if (i > 0) await sleep(GAP_MS);
        let r = await attempt(id);
        for (let n = 1; r === 'retry' && n < MAX_ATTEMPTS; n++) {
          await sleep(backoff);
          backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
          r = await attempt(id);
        }
        if (r === 'ok') { cached++; backoff = BACKOFF_MS; } else failed++;
      }
      if (ids.length) log.info(`photos: ${cached} cached, ${failed} failed (${ids.length} were missing)`);
      return { cached, failed };
    })().finally(() => running.delete(ek));
    running.set(ek, pass);
    return pass;
  }

  /** Startup + every `everyMs`: cache any reviewed photo that is still missing (a failed fetch gets another chance). */
  function keepCached(ek, everyMs = 15 * 60_000) {
    const run = () => prefetch(ek).catch((err) => log.warn(`photo prefetch: ${err.message}`));
    run();
    const t = setInterval(run, everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  /** Express handler for GET /photos/:id.jpg — reviewed photos only, from our disk cache. */
  async function serve(req, res) {
    const id = String(req.params.id ?? '');
    if (!/^[0-9a-f]{20}$/.test(id) || !isServable(byId.get(id))) return res.status(404).type('text').send('not found');
    if (!(await ensure(id))) return res.status(404).type('text').send('not found');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg').sendFile(file(id));
  }

  /** Health numbers: reviewed photos we may serve, and how many of them are cached on disk (visible in /api/health). */
  const stats = () => { const ids = [...byId.keys()]; return { servable: ids.length, cached: ids.filter(isCached).length }; };

  return { load, entryFor, photoFor, decide, prefetch, keepCached, ensure, serve, isCached, stats, reset: () => { cache.clear(); byId.clear(); } };
}
