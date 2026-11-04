// /api/health's dataVersion: the newest latest_snapshot fetched_at, which clients use as the ?v= cache key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot, latestDataVersion } from '../src/db.js';

const snap = (sourceKey, version, fetchedAt) => ({
  source: 'test', fetchedAt, version,
  election: { sourceKey, state: 'CO', scope: 'state', name: sourceKey },
  races: [],
});

test('latestDataVersion: null before any data, then the newest snapshot across sources, read from the DB', () => {
  const db = openDb(':memory:');
  assert.equal(latestDataVersion(db), null);
  writeSnapshot(db, snap('A', 'v1', '2026-11-04T00:31:06.595Z'));
  assert.equal(latestDataVersion(db), '2026-11-04T00:31:06.595Z');
  writeSnapshot(db, snap('B', 'v1', '2026-11-04T00:32:07.192Z'));
  assert.equal(latestDataVersion(db), '2026-11-04T00:32:07.192Z');
  writeSnapshot(db, snap('A', 'v2', '2026-11-04T00:33:00.000Z'));
  assert.equal(latestDataVersion(db), '2026-11-04T00:33:00.000Z');
});
