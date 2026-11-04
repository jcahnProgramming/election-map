import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerDataVersion, isNewerAppVersion, safetyPollDue, updatedAgo, SAFETY_POLL_MS } from '../src/live.js';

test('data version only moves forward (a late/cached message never restores an older cache key)', () => {
  assert.equal(newerDataVersion(null, '2026-11-04T00:31:06.595Z'), '2026-11-04T00:31:06.595Z');
  assert.equal(newerDataVersion('2026-11-04T00:31:06.595Z', '2026-11-04T00:32:07.192Z'), '2026-11-04T00:32:07.192Z');
  assert.equal(newerDataVersion('2026-11-04T00:32:07.192Z', '2026-11-04T00:31:06.595Z'), '2026-11-04T00:32:07.192Z');
  assert.equal(newerDataVersion('2026-11-04T00:32:07.192Z', null), '2026-11-04T00:32:07.192Z');
  assert.equal(newerDataVersion(null, undefined), null);
});

test('new-version banner: only for a strictly newer semver from the server', () => {
  assert.equal(isNewerAppVersion('0.2.1', '0.2.2'), true);
  assert.equal(isNewerAppVersion('0.2.9', '0.3.0'), true);
  assert.equal(isNewerAppVersion('0.2.10', '0.2.9'), false); // numeric, not string, comparison
  assert.equal(isNewerAppVersion('0.2.2', '0.2.2'), false);
  assert.equal(isNewerAppVersion('0.2.2', '0.2.1'), false); // rollback: no nag
  assert.equal(isNewerAppVersion(null, '0.2.2'), false); // bundle version unknown (tests / dev)
  assert.equal(isNewerAppVersion('0.2.2', null), false);
  assert.equal(isNewerAppVersion('0.2.2', 'garbage'), false);
});

test('safety-net poll: due after 60 s without a refresh, only while the tab is visible', () => {
  const t = 1_000_000;
  assert.equal(SAFETY_POLL_MS, 60_000);
  assert.equal(safetyPollDue(t, t + 59_999), false);
  assert.equal(safetyPollDue(t, t + 60_000), true);
  assert.equal(safetyPollDue(t, t + 120_000, { visible: false }), false);
  assert.equal(safetyPollDue(null, t), true);
});

test('"Updated Xs ago" text', () => {
  assert.equal(updatedAgo(0), 'Updated 0s ago');
  assert.equal(updatedAgo(8_400), 'Updated 8s ago');
  assert.equal(updatedAgo(125_000), 'Updated 2m 5s ago');
  assert.equal(updatedAgo(3_780_000), 'Updated 1h 3m ago');
  assert.equal(updatedAgo(-500), 'Updated 0s ago'); // clock skew never shows a negative age
  assert.equal(updatedAgo(null), null);
});
