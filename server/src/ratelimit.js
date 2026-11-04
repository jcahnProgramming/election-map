// Per-client token bucket for the public API. Generous (default 300 requests/minute, bursts up to that),
// answers 429 + Retry-After when a client runs dry. In memory: one process serves the site.
import net from 'node:net';

/**
 * The client's IP. Behind the Cloudflare tunnel every request reaches us from a private address, so the real
 * client is the CF-Connecting-IP header; that header is only believed when the direct peer is a trusted proxy
 * (Express's `trust proxy` setting), so nobody on the internet can pick their own bucket.
 */
export function clientIp(req) {
  const peer = req.socket?.remoteAddress ?? '';
  const trust = req.app?.get('trust proxy fn');
  const cf = req.get?.('cf-connecting-ip');
  if (cf && trust && trust(peer, 0) && net.isIP(cf.trim())) return cf.trim();
  return req.ip ?? peer;
}

export function createRateLimit({ perMinute = 300, burst = perMinute, keyOf = clientIp, now = () => Date.now() } = {}) {
  const ratePerMs = perMinute / 60_000;
  const buckets = new Map(); // ip → { tokens, at }

  // Forget idle clients (a full bucket carries no information).
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (b.tokens + (t - b.at) * ratePerMs >= burst) buckets.delete(k);
  }, 60_000);
  sweep.unref?.();

  function middleware(req, res, next) {
    const key = keyOf(req);
    const t = now();
    const b = buckets.get(key) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * ratePerMs);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return next();
    }
    const retry = Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000));
    res.set('Retry-After', String(retry)).set('Cache-Control', 'no-store');
    res.status(429).json({ error: 'Too many requests. Please slow down.', retryAfterSeconds: retry });
  }

  return { middleware, stop: () => clearInterval(sweep) };
}
