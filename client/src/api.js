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

export const api = {
  offices: () => getJson('/api/offices'),
  national: (office) => getJson(`/api/national?office=${encodeURIComponent(office)}`),
  state: (abbr, office) => getJson(`/api/state/${encodeURIComponent(abbr)}?office=${encodeURIComponent(office)}`),
  contests: (abbr) => getJson(`/api/state/${encodeURIComponent(abbr)}/contests`),
  changelog: () => getJson('/api/changelog'),
  measures: (abbr) => getJson(abbr ? `/api/measures?state=${encodeURIComponent(abbr)}` : '/api/measures'),
  coverage: () => getJson('/api/coverage'),
  health: () => getJson('/api/health'),
};
