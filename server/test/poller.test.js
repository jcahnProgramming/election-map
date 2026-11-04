// Sources go from empty to populated on election night. The poller and writer must survive every step:
// a thrown fetch, a malformed result, nulls / missing fields / string counts, and changing versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { startPolling } from '../src/poller.js';

const election = { sourceKey: 'XX/1', state: 'CO', scope: 'state', name: 'test' };
const cand = (name, party) => ({ name, party, partyRaw: party });
const steps = [
  () => { throw new Error('HTTP 503'); },                                                     // source down
  () => ({ changed: true, result: { election, version: 'v1', races: [] } }),                   // empty, pre-results
  () => ({ changed: true, result: { election, version: 'v2', races: [                          // malformed / null-heavy
    { office: 'senate', key: '1', name: 'US Senate', choices: [cand('A', 'DEM'), cand('B', 'REP')],
      units: [{ level: 'state', name: 'CO', votes: null }, { level: 'state', name: 'CO' }] },
    { office: 'senate', name: 'no key' },                                                      // skipped, not fatal
    { office: 'measure', key: '9', name: 'Amendment 1', choices: [cand('Yes', 'OTHER'), cand('No', 'OTHER')],
      units: [{ level: 'state', name: 'CO', yes: null, no: undefined }] },
  ] } }),
  () => ({ changed: true, result: { election, version: 'v3', sourceUpdatedAt: null, turnout: [{ level: 'state', name: 'CO' }], races: [
    { office: 'senate', key: '1', name: 'US Senate', choices: [cand('A', 'DEM'), cand('B', 'REP')],
      units: [{ level: 'state', name: 'CO', votes: ['120', 80, 7], precinctsReporting: null,
        methods: [{ label: 'Election Day', votes: [null, '5'] }, { votes: [1, 2] }] }] },   // extra vote, unlabeled method
  ] } }),
  () => ({ changed: false }),
];

test('poller survives a source going from down → empty → malformed → populated', async () => {
  const db = openDb(':memory:');
  let i = 0;
  const adapter = { id: 'flaky', name: 'Flaky', targets: () => [{ key: 'XX/1', state: 'CO', scope: 'state' }],
    fetch: async () => steps[Math.min(i++, steps.length - 1)]() };
  const updates = [];
  const stop = startPolling({ db, adapters: [adapter], intervalMs: 10, onUpdate: (u) => updates.push(u) });
  const deadline = Date.now() + 5000;
  while (i < steps.length + 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  stop();
  assert.ok(i >= steps.length, `poller kept polling (${i} fetches)`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 3);
  const votes = db.prepare(`SELECT v.votes FROM vote_counts v JOIN latest_snapshot l ON l.snapshot_id = v.snapshot_id
    ORDER BY v.candidate_id`).all().map((r) => r.votes);
  assert.deepEqual(votes, [120, 80]);
  assert.ok(updates.some((u) => u.changed));
});
