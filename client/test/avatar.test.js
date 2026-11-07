import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, avatarTone, AVATAR_TONE, contrast, photoCredit, photoCredits } from '../src/avatar.js';
import { candidateList } from '../src/calc.js';

test('initials: first + last, tickets, nicknames, suffixes', () => {
  assert.equal(initials('John Hickenlooper'), 'JH');
  assert.equal(initials('Ned Lamont and Susan Bysiewicz'), 'NL');
  assert.equal(initials('Victor Marx / George Washington Markert'), 'VM');
  assert.equal(initials('Robert P. "Family Man" Murray, Jr.'), 'RM');
  assert.equal(initials('ANGELA "HELI" RODRIGUEZ PRILLIMAN'), 'AP');
  assert.equal(initials('Mariannette Miller-Meeks'), 'MM');
  assert.equal(initials("Beto O'Rourke"), 'BO');
  assert.equal(initials('José Álvarez III'), 'JÁ');
  assert.equal(initials('Cher'), 'C');
  assert.equal(initials(''), '?');
});

test('avatar tones: DEM / REP tints, everyone else neutral grey; every one at least 4.5:1', () => {
  assert.equal(avatarTone('DEM'), AVATAR_TONE.DEM);
  assert.equal(avatarTone('REP'), AVATAR_TONE.REP);
  assert.equal(avatarTone('OTHER'), AVATAR_TONE.OTHER);
  assert.equal(avatarTone(undefined), AVATAR_TONE.OTHER);
  for (const [k, t] of Object.entries(AVATAR_TONE)) assert.ok(contrast(t.fg, t.bg) >= 4.5, `${k}: ${contrast(t.fg, t.bg).toFixed(2)}`);
  assert.ok(Math.abs(contrast('#000000', '#FFFFFF') - 21) < 0.01);
});

test('photos pass through candidateList only when the server attached them', () => {
  const photo = { url: '/photos/abc.jpg', credit: 'U.S. Senate', license: 'Public domain', sourceType: 'official_portrait' };
  const { rows } = candidateList({ candidates: [{ name: 'A', party: 'DEM', votes: 2, photo }, { name: 'B', party: 'REP', votes: 1 }] });
  assert.deepEqual(rows.map((r) => r.photo), [photo, null]);
  // Florida marks write-ins "WRI": they go on the write-in line, never as a candidate row.
  const fl = candidateList({ candidates: [{ name: 'A', party: 'DEM', votes: 2 }, { name: 'Pat Doe', party: 'OTHER', partyRaw: 'WRI', votes: 1 }] });
  assert.deepEqual([fl.rows.map((r) => r.name), fl.writeIns.map((w) => w.name)], [['A'], ['Pat Doe']]);
  assert.equal(photoCredit(photo), 'Photo: U.S. Senate · Public domain · Official portrait');
  assert.equal(photoCredit({ sourceType: 'wikimedia_commons', license: 'CC BY-SA 4.0' }), 'Wikimedia Commons · CC BY-SA 4.0');
  assert.deepEqual(photoCredits(rows), ['A: Photo: U.S. Senate · Public domain · Official portrait']);
  assert.equal(photoCredit(null), '');
});

test('photo credits: author, license linked to its deed, source page; each photo once', async () => {
  const { licenseUrl, creditList } = await import('../src/avatar.js');
  assert.equal(licenseUrl('CC BY-SA 4.0'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  assert.equal(licenseUrl('CC BY 2.0'), 'https://creativecommons.org/licenses/by/2.0/');
  assert.equal(licenseUrl('CC0 1.0'), 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.equal(licenseUrl('Public domain (PD-USGov-Congress)'), null);
  const p = { url: '/photos/a.jpg', credit: 'Gage Skidmore', license: 'CC BY-SA 2.0', sourcePage: 'https://commons.wikimedia.org/wiki/File:X.jpg' };
  assert.deepEqual(creditList([{ name: 'Steve Hilton', photo: p }, { name: 'Steve Hilton', photo: p }, { name: 'No Photo' }]), [
    { name: 'Steve Hilton', credit: 'Gage Skidmore', license: 'CC BY-SA 2.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0/', sourcePage: 'https://commons.wikimedia.org/wiki/File:X.jpg' },
  ]);
});
