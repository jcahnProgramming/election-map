// Polls every adapter target on its own timer. One failing source never blocks another: each target
// has its own loop, its own backoff, and its own error state.
import { writeSnapshot, markChecked, recordUnmatched } from './db.js';
import * as http from './http.js';
import { config } from './config.js';
import { logger } from './log.js';
import { currentElectionKey } from './elections.js';

const log = logger('poller');

/** A source's own server error (HTTP 5xx: overloaded / bad gateway), as opposed to a refusal (429 / 4xx). */
const SERVER_ERROR_MAX_MS = 2 * 60 * 1000;

/**
 * Delay before the next try after `failures` consecutive failures.
 * HTTP 5xx (election-night overload, e.g. Clarity's CloudFront 502s): keep the normal interval for the first 2
 * failures, then back off, never beyond 2 minutes. Anything else (429, other 4xx, i.e. anything that may mean
 * "slow down" or blocking, plus non-HTTP errors) keeps the long exponential backoff up to config.maxBackoffMs.
 */
export function retryDelayMs(failures, err, intervalMs, maxBackoffMs = config.maxBackoffMs) {
  const status = Number(err?.status);
  if (status >= 500 && status <= 599) {
    if (failures <= 2) return intervalMs;
    return Math.min(SERVER_ERROR_MAX_MS, intervalMs * 2 ** Math.min(failures - 2, 6));
  }
  return Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 6));
}

/** Per-source health for /api/health: id → { id, lastSuccess, lastError, lastErrorAt, targets } */
export const health = new Map();

export function startPolling({ db, adapters, onUpdate, intervalMs = config.pollIntervalMs }) {
  const timers = [];
  const latestVersion = db.prepare(`SELECT s.source_version v FROM latest_snapshot l
    JOIN snapshots s ON s.id = l.snapshot_id JOIN elections e ON e.id = l.election_id
    WHERE e.source = ? AND e.source_key = ?`);

  for (const adapter of adapters) {
    const targets = adapter.targets();
    const h = { id: adapter.id, name: adapter.name, lastSuccess: null, lastError: null, lastErrorAt: null, targets: {} };
    health.set(adapter.id, h);
    if (!targets.length) log.warn(`${adapter.id}: no targets configured`);

    targets.forEach((t, i) => {
      const th = (h.targets[t.key] = { lastSuccess: null, lastError: null, failures: 0, version: null });
      const ctx = {
        http,
        log: logger(`${adapter.id}:${t.key}`),
        unmatched: (kind, value, context) => {
          ctx.log.warn(`unmatched ${kind}: ${JSON.stringify(value)} (${context})`);
          recordUnmatched(db, { source: adapter.id, kind, value, context });
        },
      };

      const tick = async () => {
        const started = new Date().toISOString();
        try {
          const r = await adapter.fetch(t, ctx);
          const at = new Date().toISOString();
          if (r.changed && r.result.version != null && latestVersion.get(adapter.id, t.key)?.v === String(r.result.version)) {
            r.changed = false; // same version we already stored before a restart
          }
          if (r.changed) {
            const result = t.election && !r.result.election.electionKey
              ? { ...r.result, election: { ...r.result.election, electionKey: t.election } } : r.result;
            const id = writeSnapshot(db, { ...result, source: adapter.id, fetchedAt: at });
            ctx.log.info(`snapshot ${id} (version ${r.result.version ?? '-'}, ${r.result.races.length} races)`);
          } else {
            markChecked(db, adapter.id, t.key, at);
          }
          th.lastSuccess = h.lastSuccess = at;
          th.version = r.version ?? r.result?.version ?? th.version;
          th.failures = 0;
          th.lastError = null;
          const election = r.result?.election?.electionKey ?? t.election ?? currentElectionKey();
          onUpdate?.({ sourceId: adapter.id, target: t.key, election, states: [t.state], fetchedAt: at, changed: r.changed });
          schedule(intervalMs);
        } catch (err) {
          th.failures += 1;
          th.lastError = h.lastError = `${err.message}`;
          h.lastErrorAt = started;
          const backoff = retryDelayMs(th.failures, err, intervalMs);
          ctx.log.error(`fetch failed (${th.failures} in a row), retrying in ${Math.round(backoff / 1000)}s: ${err.message}`);
          schedule(backoff);
        }
      };
      const slot = timers.push(null) - 1; // one live timer per target
      const schedule = (ms) => {
        timers[slot] = setTimeout(tick, ms);
      };
      // Stagger first fetches so targets don't all hit at once.
      schedule(500 + i * 750);
    });
  }
  return () => timers.forEach(clearTimeout);
}
