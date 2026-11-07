// 0.5.9 photo release: license guard (never served unless CC0 / CC BY / CC BY-SA / public domain, whatever the review
// said) and polite fetching (one at a time, backing off on 429 so a burst can't leave contests without photos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhotos, isServable, photoId } from '../src/photos.js';
import { isPermittedLicense } from '../src/photo-rules.js';

const EK = '2026-general';
const entry = (name, office, extra = {}) => ({
  match: [name], office, district: null, party: 'DEM', party_raw: 'DEM',
  photo_url: `https://upload.wikimedia.org/x/${encodeURIComponent(name)}.jpg`, source_type: 'wikimedia_commons',
  source_page_url: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}.jpg`,
  license: 'CC BY-SA 4.0', credit: 'Someone', as_of: '2026-11-03', reviewed: true, ...extra,
});

function setup(entries, fetchImage, extra = {}) {
  const cfg = mkdtempSync(path.join(tmpdir(), 'em-lic-cfg-'));
  const data = mkdtempSync(path.join(tmpdir(), 'em-lic-data-'));
  mkdirSync(path.join(cfg, 'elections', EK, 'candidates'), { recursive: true });
  writeFileSync(path.join(cfg, 'elections', EK, 'candidates', 'GA.json'), JSON.stringify({ state: 'GA', candidates: entries }));
  const slept = [];
  const photos = createPhotos({ configDir: cfg, dataDir: data, fetchImage, resize: async () => Buffer.from('jpeg'),
    sleep: async (ms) => { slept.push(ms); }, gapMs: 1000, backoffMs: 30_000, ...extra });
  return { photos, slept, data };
}

test('permitted licenses: CC0, CC BY, CC BY-SA, public domain — whole string only', () => {
  for (const ok of ['Public domain (PD-USGov-Congress)', 'Public domain (PD-CAGov)', 'CC0', 'CC0 1.0', 'CC BY 2.0', 'CC BY 4.0',
    'CC BY-SA 2.0', 'CC BY-SA 4.0', 'cc-by-sa-3.0', 'Public domain (PD-USGov-Military-Air National Guard)']) assert.ok(isPermittedLicense(ok), ok);
  for (const no of ['Copyrighted free use (Copyrighted free use)', 'Copyrighted free use', 'CC BY-NC 4.0', 'CC BY-ND 2.0',
    'CC BY-NC-SA 4.0', 'CC BY-SA 4.0 or later, see page', 'All rights reserved', 'Fair use', '', null, undefined]) assert.ok(!isPermittedLicense(no), String(no));
});

test('server guard: reviewed:true with a non-permitted license is never servable, fetched or attached', async () => {
  for (const license of ['Copyrighted free use (Copyrighted free use)', 'CC BY-NC 4.0', null]) {
    assert.equal(isServable(entry('X', 'senate', { license })), false, String(license));
  }
  const fetched = [];
  const { photos } = setup([entry('Jon Ossoff', 'senate'), entry('Mike Collins', 'senate', { party: 'REP', party_raw: 'REP', license: 'Copyrighted free use (Copyrighted free use)' })],
    async (url) => { fetched.push(url); return new Uint8Array([1]); });
  await photos.prefetch(EK);
  assert.equal(fetched.length, 1);
  assert.ok(!fetched.some((u) => u.includes('Collins')));
  // Collins is a major candidate without a servable photo → initials for both (fairness).
  assert.equal(photos.decide(EK, 'GA', 'senate', null, [{ name: 'Jon Ossoff', party: 'DEM', partyRaw: 'DEM' }, { name: 'Mike Collins', party: 'REP', partyRaw: 'REP' }]), null);
  const res = { code: 200, status(c) { this.code = c; return this; }, type() { return this; }, set() { return this; }, send() { return this; }, sendFile() { return this; } };
  await photos.serve({ params: { id: photoId(entry('Mike Collins', 'senate').photo_url) } }, res);
  assert.equal(res.code, 404);
});

test('polite prefetch: one at a time with a gap; 429 → back off and retry; 404 → no retry; GA Senate ends up with photos', async () => {
  let active = 0, maxActive = 0;
  const calls = new Map();
  const fetchImage = async (url) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    if (url.includes('Ossoff') && n < 3) throw Object.assign(new Error('HTTP 429'), { status: 429 });
    if (url.includes('Gone')) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return new Uint8Array([1]);
  };
  const { photos, slept } = setup([
    entry('Jon Ossoff', 'senate'), entry('Mike Collins', 'senate', { party: 'REP', party_raw: 'REP' }), entry('Gone Person', 'governor'),
  ], fetchImage);
  const r = await photos.prefetch(EK);
  assert.deepEqual(r, { cached: 2, failed: 1 });
  assert.equal(maxActive, 1, 'never two image requests at once');
  assert.equal(calls.get(entry('Jon Ossoff', 'senate').photo_url), 3, '429 retried until it succeeds');
  assert.equal(calls.get(entry('Gone Person', 'governor').photo_url), 1, '404 is not retried');
  assert.deepEqual(slept, [30_000, 60_000, 1000, 1000], 'backoff doubles on 429; 1 s gap between photos');
  const d = photos.decide(EK, 'GA', 'senate', null, [{ name: 'Jon Ossoff', party: 'DEM', partyRaw: 'DEM' }, { name: 'Mike Collins', party: 'REP', partyRaw: 'REP' }]);
  assert.deepEqual([...d.keys()], ['Jon Ossoff', 'Mike Collins']);
  // A second pass only fetches what is still missing (here: nothing that can succeed).
  const again = await photos.prefetch(EK);
  assert.deepEqual(again, { cached: 0, failed: 1 });
});

test('candidate files: no reviewed photo with a license we may not display', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'elections', EK, 'candidates');
  for (const f of readdirSync(dir)) {
    for (const e of JSON.parse(readFileSync(path.join(dir, f), 'utf8')).candidates) {
      if (e.photo_url && e.reviewed === true) assert.ok(isPermittedLicense(e.license), `${f} ${e.match[0]}: ${e.license}`);
    }
  }
});
