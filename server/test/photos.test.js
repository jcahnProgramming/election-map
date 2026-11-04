// Candidate photos: the review gate (unreviewed photos are never served) and the fairness rule (photos for every
// major candidate in a contest, or initials for all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPhotos, decidePhotos, majorCandidates, isPartyNominee, isServable, photoId, attachPhotos, normName, PHOTO_SOURCE_TYPES,
} from '../src/photos.js';

const EK = '2026-general';
const cand = (name, party, partyRaw = party, votes = 0) => ({ name, party, partyRaw, votes });
const entry = (match, office, district, extra = {}) => ({
  match, office, district, party: 'DEM', photo_url: `https://upload.wikimedia.org/x/${encodeURIComponent(match[0])}.jpg`,
  source_type: 'wikimedia_commons', source_page_url: 'https://commons.wikimedia.org/wiki/File:x.jpg',
  license: 'CC BY-SA 4.0', credit: 'Someone', as_of: '2026-11-03', reviewed: true, ...extra,
});

function setup(entries) {
  const cfg = mkdtempSync(path.join(tmpdir(), 'em-ph-cfg-'));
  const data = mkdtempSync(path.join(tmpdir(), 'em-ph-data-'));
  mkdirSync(path.join(cfg, 'elections', EK, 'candidates'), { recursive: true });
  writeFileSync(path.join(cfg, 'elections', EK, 'candidates', 'CO.json'), JSON.stringify({ state: 'CO', election: EK, candidates: entries }));
  const fetched = [];
  const photos = createPhotos({
    configDir: cfg, dataDir: data,
    fetchImage: async (url) => { fetched.push(url); return new Uint8Array([1, 2, 3]); },
    resize: async () => Buffer.from('jpeg'),
  });
  return { photos, fetched, data };
}

test('major candidates: party nominees + anyone ≥ 5%; write-ins and independents below 5% are minor', () => {
  const list = [
    cand('D', 'DEM', 'DEM', 400), cand('R', 'REP', 'REP', 400), cand('L', 'OTHER', 'LBR', 10),
    cand('Indie Big', 'OTHER', 'UAF', 100), cand('Indie Small', 'OTHER', 'UAF', 20), cand('Write-in', 'OTHER', 'W', 70),
  ];
  assert.deepEqual(majorCandidates(list).map((c) => c.name), ['D', 'R', 'L', 'Indie Big']);
  assert.equal(isPartyNominee(cand('X', 'OTHER', 'Unaffiliated')), false);
  assert.equal(isPartyNominee(cand('X', 'OTHER', 'Green')), true);
  assert.equal(isPartyNominee(cand('X', 'OTHER', '')), false);
});

test('fairness: photos only when every major candidate has one; minor candidates never get one', () => {
  const list = [cand('D', 'DEM'), cand('R', 'REP'), cand('Indie', 'OTHER', 'UAF')];
  const have = (names) => (c) => (names.includes(c.name) ? { url: `/photos/${c.name}.jpg` } : null);
  assert.equal(decidePhotos(list, have(['D'])), null); // R missing → initials for everyone
  const d = decidePhotos(list, have(['D', 'R', 'Indie']));
  assert.deepEqual([...d.keys()], ['D', 'R']); // the independent (no votes yet, no party) is minor: initials
  const out = attachPhotos(list, d);
  assert.ok(out[0].photo && out[1].photo && !out[2].photo);
  assert.equal(attachPhotos(list, null), list);
  assert.equal(decidePhotos([cand('Write-in', 'OTHER', 'W')], have([])), null);
});

test('review gate: unreviewed, disallowed source types and non-https URLs are never servable', () => {
  assert.equal(isServable(entry(['A'], 'senate', null)), true);
  assert.equal(isServable(entry(['A'], 'senate', null, { reviewed: false })), false);
  assert.equal(isServable(entry(['A'], 'senate', null, { reviewed: 'true' })), false);
  assert.equal(isServable(entry(['A'], 'senate', null, { source_type: 'news_photo' })), false);
  assert.equal(isServable(entry(['A'], 'senate', null, { photo_url: 'http://x/y.jpg' })), false);
  assert.equal(isServable(entry(['A'], 'senate', null, { photo_url: null })), false);
  assert.deepEqual(PHOTO_SOURCE_TYPES, ['official_portrait', 'wikimedia_commons', 'campaign_press_kit', 'candidate_submitted']);
});

test('createPhotos: only reviewed photos are fetched, cached and served; a missing one means initials for the contest', async () => {
  const { photos, fetched, data } = setup([
    entry(['Jane Dem'], 'senate', null),
    entry(['Rob Rep'], 'senate', null, { reviewed: false }),
    entry(['Hal House'], 'house', '07'),
  ]);
  const r = await photos.prefetch(EK);
  assert.deepEqual(r, { cached: 2, failed: 0 });
  assert.equal(fetched.length, 2);
  assert.ok(!fetched.some((u) => u.includes('Rob')), 'unreviewed photo must never be fetched');
  assert.deepEqual(readdirSync(path.join(data, 'photos')).sort(), [photoId(entry(['Hal House']).photo_url), photoId(entry(['Jane Dem']).photo_url)].map((x) => `${x}.jpg`).sort());

  const senate = [cand('Jane Dem', 'DEM'), cand('Rob Rep', 'REP')];
  assert.equal(photos.decide(EK, 'CO', 'senate', null, senate), null); // Rob's photo isn't reviewed → initials for both
  const solo = photos.decide(EK, 'CO', 'house', '7', [cand('Hal House', 'DEM'), cand('Write-in', 'OTHER', 'W')]);
  assert.equal(solo.get('Hal House').url, `/photos/${photoId(entry(['Hal House']).photo_url)}.jpg`);
  assert.equal(solo.get('Hal House').license, 'CC BY-SA 4.0');
  assert.equal(photos.decide(EK, 'CO', 'house', '8', [cand('Hal House', 'DEM')]), null); // other district: no match
  assert.equal(photos.decide(EK, 'CO', 'attorney_general', null, [cand('Hal House', 'DEM')]), null);

  // Serving: the unreviewed photo's id answers 404 even if a file with that name existed on disk.
  const unrevId = photoId(entry(['Rob Rep']).photo_url);
  writeFileSync(path.join(data, 'photos', `${unrevId}.jpg`), 'leak');
  const res = () => {
    const r = { code: 200, headers: {}, sent: null };
    r.status = (c) => { r.code = c; return r; };
    r.type = () => r; r.set = (k, v) => { r.headers[k] = v; return r; };
    r.send = (b) => { r.sent = b; return r; };
    r.sendFile = (f) => { r.sent = readFileSync(f, 'utf8'); return r; };
    return r;
  };
  const a = res(); await photos.serve({ params: { id: unrevId } }, a);
  assert.equal(a.code, 404);
  const b = res(); await photos.serve({ params: { id: photoId(entry(['Jane Dem']).photo_url) } }, b);
  assert.equal(b.code, 200);
  assert.equal(b.sent, 'jpeg');
  const c = res(); await photos.serve({ params: { id: '../../etc/passwd' } }, c);
  assert.equal(c.code, 404);
});

test('name matching ignores case, punctuation and quotes', () => {
  assert.equal(normName('Robert P. "Family Man" Murray, Jr.'), 'robert p family man murray jr');
  assert.equal(normName('ANGELA "HELI" RODRIGUEZ'), normName('Angela Heli Rodriguez'));
});

test('candidate photo files: valid shape, allowed source types only, nothing reviewed without full attribution', () => {
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'elections');
  const d = path.join(base, EK, 'candidates');
  if (!existsSync(d)) return;
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
    assert.match(f, /^[A-Z]{2}\.json$/);
    const doc = JSON.parse(readFileSync(path.join(d, f), 'utf8'));
    assert.ok(Array.isArray(doc.candidates), f);
    for (const e of doc.candidates) {
      const at = `${f} ${e.match?.[0]}`;
      assert.ok(Array.isArray(e.match) && e.match.length, `${at}: match`);
      assert.ok(['senate', 'governor', 'house'].includes(e.office), `${at}: office`);
      assert.equal(typeof e.reviewed, 'boolean', `${at}: reviewed flag`);
      if (e.photo_url == null) continue;
      assert.match(e.photo_url, /^https:\/\//, `${at}: photo_url`);
      assert.ok(PHOTO_SOURCE_TYPES.includes(e.source_type), `${at}: source_type ${e.source_type}`);
      assert.match(e.source_page_url ?? '', /^https:\/\//, `${at}: source_page_url`);
      assert.ok(e.license, `${at}: license`);
      assert.ok(e.credit, `${at}: credit`);
      assert.ok(!/\.(google|bing)\.|facebook\.com|twitter\.com|x\.com\/|instagram\.com/i.test(`${e.photo_url} ${e.source_page_url}`), `${at}: disallowed host`);
    }
  }
});
