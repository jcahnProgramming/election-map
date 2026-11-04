import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, withVersion } from '../src/api.js';

test('withVersion leaves plain page-load URLs unchanged', () => {
  assert.equal(withVersion('/api/national?office=senate'), '/api/national?office=senate');
  assert.equal(withVersion('/api/measures', null), '/api/measures');
  assert.equal(withVersion('/api/measures', ''), '/api/measures');
});

test('withVersion appends the update stamp as ?v= / &v=, encoded', () => {
  const at = '2026-11-04T00:41:12.345Z';
  assert.equal(withVersion('/api/national?race=house', at), '/api/national?race=house&v=2026-11-04T00%3A41%3A12.345Z');
  assert.equal(withVersion('/api/measures', at), '/api/measures?v=2026-11-04T00%3A41%3A12.345Z');
});

test('refetches after an update use a distinct URL per update; first loads do not carry v', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(url); return { ok: true, json: async () => ({}) }; };
  try {
    await api.national('senate');
    await api.national('senate', '2026-11-04T00:41:00.000Z');
    await api.national('senate', '2026-11-04T00:42:00.000Z');
    await api.state('GA', 'governor', '2026-11-04T00:42:00.000Z');
    await api.measures('GA', '2026-11-04T00:42:00.000Z');
    await api.measures(undefined, '2026-11-04T00:42:00.000Z');
  } finally {
    globalThis.fetch = orig;
  }
  assert.deepEqual(seen, [
    '/api/national?office=senate',
    '/api/national?office=senate&v=2026-11-04T00%3A41%3A00.000Z',
    '/api/national?office=senate&v=2026-11-04T00%3A42%3A00.000Z',
    '/api/state/GA?office=governor&v=2026-11-04T00%3A42%3A00.000Z',
    '/api/measures?state=GA&v=2026-11-04T00%3A42%3A00.000Z',
    '/api/measures?v=2026-11-04T00%3A42%3A00.000Z',
  ]);
});
