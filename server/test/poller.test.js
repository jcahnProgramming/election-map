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

test('retry delay: HTTP 5xx keeps the 60 s interval for 2 failures, then backs off to at most 2 min', async () => {
  const { retryDelayMs } = await import('../src/poller.js');
  const { HttpError } = await import('../src/http.js');
  const i = 60_000;
  const e502 = new HttpError('https://results.enr.clarityelections.com/CO/127407/current_ver.txt', 502);
  assert.deepEqual([1, 2, 3, 4, 5, 10].map((f) => retryDelayMs(f, e502, i)), [60_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
  assert.equal(retryDelayMs(1, new HttpError('u', 503), i), 60_000);
  assert.equal(retryDelayMs(3, new HttpError('u', 504), 15_000), 30_000); // short intervals still back off, capped at 2 min
});

test('retry delay: 429 / 4xx and non-HTTP errors keep the long exponential backoff (up to 10 min)', async () => {
  const { retryDelayMs } = await import('../src/poller.js');
  const { HttpError } = await import('../src/http.js');
  const i = 60_000;
  for (const s of [429, 403, 404]) {
    assert.deepEqual([1, 2, 3, 4].map((f) => retryDelayMs(f, new HttpError('u', s), i, 600_000)), [120_000, 240_000, 480_000, 600_000], `HTTP ${s}`);
  }
  assert.equal(retryDelayMs(1, new Error('Unexpected payload'), i, 600_000), 120_000);
  assert.equal(retryDelayMs(6, new Error('timeout'), i, 600_000), 600_000);
});

test('retry delay: a bot-protection refusal (WAF captcha) goes straight to the slow poll, whatever the status', async () => {
  const { retryDelayMs } = await import('../src/poller.js');
  const { HttpError } = await import('../src/http.js');
  const captcha = new HttpError('https://results.enr.clarityelections.com/CO/127407/current_ver.txt', 405, 'captcha');
  assert.equal(captcha.blocked, true);
  assert.match(captcha.message, /HTTP 405 .*\(bot protection: captcha\)/);
  assert.deepEqual([1, 2, 5].map((f) => retryDelayMs(f, captcha, 60_000, 600_000)), [600_000, 600_000, 600_000]);
  assert.equal(new HttpError('u', 405).blocked, false); // a plain 405 keeps the ordinary 4xx backoff
  assert.equal(retryDelayMs(1, new HttpError('u', 405), 60_000, 600_000), 120_000);
});
