// scripts/photos-apply.js: approve / reject decisions from the review page, then the fairness check per contest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDecisions, formatSummary } from '../../scripts/photos-apply.js';
import { candidateId, contestFairness, reviewFlags, surnameOf, commonsFileTitle } from '../src/photo-rules.js';

const entry = (name, office, district, party, partyRaw, photo = true) => ({
  match: [name], office, district, party, party_raw: partyRaw,
  photo_url: photo ? `https://upload.wikimedia.org/x/${name.replace(/\W/g, '_')}.jpg` : null,
  source_type: photo ? 'wikimedia_commons' : null,
  source_page_url: photo ? `https://commons.wikimedia.org/wiki/File:${name.replace(/\W/g, '_')}.jpg` : null,
  license: photo ? 'CC BY-SA 4.0' : null, credit: photo ? 'Someone' : null, as_of: '2026-11-03', reviewed: false, note: null,
});
const docs = () => ({
  CO: { state: 'CO', candidates: [
    entry('Jane Dem', 'senate', null, 'DEM', 'DEM'),
    entry('Rob Rep', 'senate', null, 'REP', 'REP'),
    entry('Indie Person', 'senate', null, 'OTHER', 'UAF', false), // not a party nominee: never blocks photos
    entry('Hal House', 'house', '7', 'DEM', 'DEM'),
    entry('Lib Nominee', 'house', '7', 'OTHER', 'LBR', false), // a party nominee without a photo: initials for district 7
  ] },
});
const id = (name, office = 'senate', district = null) => candidateId({ match: [name], office, district });

test('approve sets reviewed: true; the contest shows photos once every major candidate is approved', () => {
  const r = applyDecisions(docs(), [
    { state: 'CO', candidateId: id('Jane Dem'), decision: 'approve' },
    { state: 'CO', candidateId: id('Rob Rep'), decision: 'approve' },
    { state: 'CO', candidateId: id('Hal House', 'house', '7'), decision: 'approve' },
  ], { date: '2026-11-04' });
  const co = r.docs.CO.candidates;
  assert.deepEqual(co.map((e) => e.reviewed), [true, true, false, true, false]);
  const s = r.summary.find((x) => x.state === 'CO');
  assert.deepEqual([s.approved, s.rejected, s.reviewedPhotos, s.pendingPhotos], [3, 0, 3, 0]);
  assert.deepEqual(s.photosShow, ['senate']); // House 7: the Libertarian nominee has no photo → initials only
  assert.equal(s.initialsOnly, 1);
  assert.deepEqual(r.changedStates, ['CO']);
  assert.match(formatSummary(r.summary), /CO: \+3 approved, -0 rejected · 3 reviewed, 0 still to review · photos will show in 1 of 2 contests \(senate\), initials only in 1/);
});

test('reject removes the photo (fields null, reviewed false, a dated note) and forces initials for that contest', () => {
  const r = applyDecisions(docs(), [
    { state: 'CO', candidateId: id('Jane Dem'), decision: 'approve' },
    { state: 'co', candidateId: id('Rob Rep'), decision: 'reject' },
  ], { date: '2026-11-04' });
  const rob = r.docs.CO.candidates[1];
  assert.deepEqual([rob.photo_url, rob.source_type, rob.source_page_url, rob.license, rob.credit, rob.reviewed],
    [null, null, null, null, null, false]);
  assert.equal(rob.note, 'Photo rejected in review 2026-11-04.');
  const s = r.summary[0];
  assert.deepEqual([s.approved, s.rejected], [1, 1]);
  assert.deepEqual(s.photosShow, []);
  // The input is never mutated.
  assert.ok(docs().CO.candidates[1].photo_url);
});

test('unknown ids and bad decisions are reported, not applied; re-applying is harmless', () => {
  const r = applyDecisions(docs(), [
    { state: 'CO', candidateId: 'senate:nobody', decision: 'approve' },
    { state: 'ZZ', candidateId: id('Jane Dem'), decision: 'approve' },
    { state: 'CO', candidateId: id('Jane Dem'), decision: 'maybe' },
  ]);
  assert.equal(r.unknown.length, 3);
  assert.deepEqual(r.changedStates, []);
  const once = applyDecisions(docs(), [{ state: 'CO', candidateId: id('Rob Rep'), decision: 'reject' }], { date: 'd' });
  const twice = applyDecisions(once.docs, [{ state: 'CO', candidateId: id('Rob Rep'), decision: 'reject' }], { date: 'd' });
  assert.deepEqual(twice.docs, once.docs);
  assert.equal(twice.summary[0].rejected, 0);
});

test('fairness per contest from the files: party nominees are major; independents and write-ins are not', () => {
  const f = contestFairness(docs().CO.candidates, () => true);
  assert.deepEqual(f.map((c) => [c.key, c.majors, c.show, c.missing]), [
    ['senate', 2, true, []],
    ['house:7', 2, false, ['Lib Nominee']],
  ]);
});

test('review flags: license, size, Commons title vs surname (flags only, never a decision)', () => {
  const e = entry('Mark Baisley', 'senate', null, 'REP', 'REP');
  assert.deepEqual(reviewFlags(e, { width: 500, height: 600 }), []);
  assert.deepEqual(reviewFlags({ ...e, license: null }), ['No license recorded']);
  assert.match(reviewFlags({ ...e, license: 'Copyrighted free use' })[0], /License not CC0/);
  for (const ok of ['Public domain (PD-USGov-Congress)', 'CC0 1.0', 'CC BY 2.0', 'CC BY-SA 4.0', 'cc-by-sa-3.0']) {
    assert.deepEqual(reviewFlags({ ...e, license: ok }), [], ok);
  }
  assert.deepEqual(reviewFlags(e, { width: 150, height: 300 }), ['Small image: 150×300px']);
  assert.deepEqual(reviewFlags({ ...e, source_page_url: 'https://commons.wikimedia.org/wiki/File:Senator_Van_Winkle.jpg' }),
    ['Commons file title doesn\'t contain "Baisley"']);
  assert.equal(surnameOf('Robert P. "Family Man" Murray, Jr.'), 'Murray');
  assert.equal(surnameOf('DEB HAALAND AND STEPHANIE GARCIA RICHARD'), 'HAALAND');
  assert.equal(surnameOf('Phil Weiser / Lesley Dahlkemper'), 'Weiser');
  assert.equal(commonsFileTitle('https://commons.wikimedia.org/wiki/File:Nanette_Barrag%C3%A1n.jpg'), 'Nanette_Barragán.jpg');
  // Accents don't trigger the title flag.
  assert.deepEqual(reviewFlags({ ...entry('Nanette Barragan', 'house', '44', 'DEM', 'DEM'), source_page_url: 'https://commons.wikimedia.org/wiki/File:Nanette_Barrag%C3%A1n.jpg' }), []);
});
