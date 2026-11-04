// A source that keeps failing (down or refusing us): state entries say so (sourceResponding:false) so the UI can show
// "Official source not responding — showing last update at <time>" next to the frozen numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';

function seed(status) {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'clarity', fetchedAt: '2026-11-04T02:52:05Z', version: '384372', sourceUpdatedAt: '2026-11-04T02:51:30Z',
    election: { sourceKey: 'CO/127407', state: 'CO', scope: 'state', name: 'CO' },
    races: [{ office: 'senate', key: '1', name: 'United States Senator',
      choices: [{ name: 'A', party: 'DEM', partyRaw: 'DEM' }, { name: 'B', party: 'REP', partyRaw: 'REP' }],
      units: [{ level: 'state', name: 'CO', votes: [642470, 342940] }] }],
  });
  const calls = [];
  const res = createResults(db, [{ id: 'clarity', name: 'Clarity', targets: () => [] }], {
    sourceStatus: (id, key) => { calls.push([id, key]); return status; },
  });
  return { res, calls };
}

test('source failing 2+ polls in a row: entries carry sourceResponding:false (and whether it is bot protection)', () => {
  const { res, calls } = seed({ failures: 2, blocked: true, lastError: 'HTTP 405 (bot protection: captcha)' });
  const st = res.state('CO', 'senate');
  assert.equal(st.statewide.sourceResponding, false);
  assert.equal(st.statewide.sourceBlocked, true);
  assert.deepEqual(calls[0], ['clarity', 'CO/127407']); // looked up by the election's own source key
  const n = res.national('senate').states.find((s) => s.state === 'CO');
  assert.equal(n.sourceResponding, false);
  assert.equal(n.totalVotes, 642470 + 342940); // the last stored numbers stay on screen
});

test('a single failure, or a healthy source: no sourceResponding field at all', () => {
  for (const status of [{ failures: 1 }, { failures: 0 }, null]) {
    const st = seed(status).res.state('CO', 'senate');
    assert.equal('sourceResponding' in st.statewide, false, JSON.stringify(status));
  }
});
