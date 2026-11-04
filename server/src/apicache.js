// In-memory cache of API JSON responses, keyed by the full request URL. Entries live until a poll writes a
// new snapshot (clear()) or for ttlMs, whichever comes first. Bounded so random query strings can't grow it.
export function createApiCache({ ttlMs = 10_000, maxEntries = 1000 } = {}) {
  const entries = new Map(); // url → { at, status, body }

  function middleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const key = req.originalUrl;
    const hit = entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).type('application/json').send(hit.body);
    }
    const json = res.json.bind(res);
    res.json = (obj) => {
      if (res.statusCode === 200) {
        const body = JSON.stringify(obj);
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value); // oldest first
        entries.set(key, { at: Date.now(), status: 200, body });
        res.set('X-Cache', 'MISS');
        return res.type('application/json').send(body);
      }
      return json(obj);
    };
    next();
  }

  return { middleware, clear: () => entries.clear(), size: () => entries.size };
}
