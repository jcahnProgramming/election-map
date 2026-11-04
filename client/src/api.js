export class ApiError extends Error {}

export async function getJson(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new ApiError('Cannot reach the results server. This page will refresh when it reconnects.');
  }
  if (!res.ok) {
    let detail = null;
    try { const b = await res.json(); if (b && b.error) detail = b.error; } catch {}
    // The Vite dev proxy answers 500/502/504 with no JSON body when the backend is down.
    if (!detail && res.status >= 500) {
      throw new ApiError(`Cannot reach the results server (${res.status}). It may be restarting; this page will refresh when it reconnects.`);
    }
    throw new ApiError(`Results server error: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  try { return await res.json(); } catch { throw new ApiError('Results server returned invalid data.'); }
}

/**
 * Append the data version from the last `results:update` (`v`) so a refetch after an update is a new cache key
 * at Cloudflare's edge and in the browser (both honour max-age=15). No `v` (plain page load) = URL unchanged.
 */
export function withVersion(path, v) {
  if (v == null || v === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}`;
}

export const api = {
  offices: (v) => getJson(withVersion('/api/offices', v)),
  national: (office, v) => getJson(withVersion(`/api/national?office=${encodeURIComponent(office)}`, v)),
  state: (abbr, office, v) => getJson(withVersion(`/api/state/${encodeURIComponent(abbr)}?office=${encodeURIComponent(office)}`, v)),
  contests: (abbr, v) => getJson(withVersion(`/api/state/${encodeURIComponent(abbr)}/contests`, v)),
  changelog: () => getJson('/api/changelog'),
  measures: (abbr, v) => getJson(withVersion(abbr ? `/api/measures?state=${encodeURIComponent(abbr)}` : '/api/measures', v)),
  coverage: () => getJson('/api/coverage'),
  health: () => getJson('/api/health'),
};
