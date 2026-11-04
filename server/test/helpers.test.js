import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPartyPrefix, methodBucket } from '../src/normalize.js';

test('splits party-prefixed candidate names', () => {
  assert.deepEqual(splitPartyPrefix('REP Darline Graham'), { name: 'Darline Graham', partyRaw: 'REP' });
  assert.deepEqual(splitPartyPrefix('DEM  Jane Q. Doe'), { name: 'Jane Q. Doe', partyRaw: 'DEM' });
  assert.deepEqual(splitPartyPrefix('(LIB) Joe Smith'), { name: 'Joe Smith', partyRaw: 'LIB' });
  assert.deepEqual(splitPartyPrefix('Joe Smith (R)'), { name: 'Joe Smith', partyRaw: 'R' });
  assert.deepEqual(splitPartyPrefix('Libertarian - Joe Smith'), { name: 'Joe Smith', partyRaw: 'Libertarian' });
});
test('leaves ordinary names alone', () => {
  for (const n of ['Ted Cruz', 'Dem Smith', 'Rep Jones', 'Al Green', 'D. J. Trump', 'Write-in', 'Ed Case']) {
    assert.equal(splitPartyPrefix(n).partyRaw, null, n);
  }
});
test('buckets vote methods', () => {
  assert.equal(methodBucket('Election Day'), 'election_day');
  assert.equal(methodBucket('Absentee by Mail'), 'mail_early');
  assert.equal(methodBucket('Early Voting'), 'mail_early');
  assert.equal(methodBucket('One Stop'), 'mail_early');
  assert.equal(methodBucket('Advance in Person'), 'mail_early');
  assert.equal(methodBucket('Provisional'), 'provisional');
  assert.equal(methodBucket('Absentee Provisional'), 'provisional');
  assert.equal(methodBucket('Machine Votes'), 'election_day');
  assert.equal(methodBucket('Election'), 'election_day');
  assert.equal(methodBucket('Provionsal'), 'provisional');
  assert.equal(methodBucket('Failsafe'), 'other');
  assert.equal(methodBucket('Overseas'), 'other');
});
