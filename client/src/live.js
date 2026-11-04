// Pure helpers for keeping the live view fresh (socket events, reconnect catch-up, safety-net polling, freshness,
// new-deploy detection). No DOM / React here so they can be unit-tested with node --test.

/** Safety net: refetch when nothing has refreshed the view for this long (socket events may be lost). */
export const SAFETY_POLL_MS = 60_000;

/**
 * The newer of two data versions (ISO timestamps from `results:update.fetchedAt` / `/api/health.dataVersion`).
 * Never goes backwards, so a late or cached response can't send the client back to an older cache key.
 */
export function newerDataVersion(current, next) {
  if (!next) return current ?? null;
  if (!current) return next;
  return String(next) > String(current) ? next : current;
}

/** True when `served` (from /api/health or the socket hello) is a newer semver than the loaded bundle's. */
export function isNewerAppVersion(loaded, served) {
  const p = (v) => String(v ?? '').trim().split('.').map((x) => Number.parseInt(x, 10));
  const a = p(loaded);
  const b = p(served);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i];
  return false;
}

/** Whether the safety-net poll should fire: page visible and no refresh for SAFETY_POLL_MS. */
export function safetyPollDue(lastRefreshAt, now, { visible = true, intervalMs = SAFETY_POLL_MS } = {}) {
  if (!visible) return false;
  if (lastRefreshAt == null) return true;
  return now - lastRefreshAt >= intervalMs;
}

/** "Updated 8s ago" / "Updated 2m 5s ago" / "Updated 1h 3m ago", from milliseconds since the last refresh. */
export function updatedAgo(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m}m ${s % 60}s ago`;
  return `Updated ${Math.floor(m / 60)}h ${m % 60}m ago`;
}
