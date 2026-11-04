import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { config, changelog } from './config.js';
import { openDb, latestDataVersion } from './db.js';
import { loadAdapters } from './adapters/index.js';
import { startPolling, health } from './poller.js';
import { createResults, OFFICE_RE, SELECT_LEVELS } from './results.js';
import { stateByAbbr } from './geo.js';
import { logger } from './log.js';
import { createApiCache } from './apicache.js';
import { createRateLimit } from './ratelimit.js';
import { currentElectionKey } from './elections.js';

const log = logger('server');
const db = openDb();
const adapters = await loadAdapters();
const results = createResults(db, adapters);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal'); // behind the Cloudflare tunnel

// Public traffic: a generous per-IP rate limit, short shared caching (Cloudflare + browsers), and an in-memory
// response cache that is dropped whenever a poll writes new numbers (or after 10 s).
const rateLimit = createRateLimit({ perMinute: Number(process.env.API_RATE_PER_MINUTE ?? 300) });
const cache = createApiCache({ ttlMs: 10_000 });

const api = express.Router();
api.use(rateLimit.middleware);
api.use((req, res, next) => {
  res.set('Cache-Control', req.path === '/health' ? 'no-cache, no-store' : 'public, max-age=15');
  next();
});

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: config.version,
    // Clients refetch with ?v=<dataVersion> on reconnect / tab focus / safety-net poll (health is never cached).
    dataVersion: latestDataVersion(db),
    sources: [...health.values()].map((h) => ({
      id: h.id, name: h.name, lastSuccess: h.lastSuccess, lastError: h.lastError, lastErrorAt: h.lastErrorAt,
      targets: h.targets,
    })),
  });
});

api.use(cache.middleware); // every read below is cached

/**
 * The office to show: ?office= (any normalized office key, see /api/offices), or the 0.2 alias ?race=. With only
 * ?level=federal|state, that level's first office. Default: U.S. Senate.
 */
const raceParam = (req, res, ek) => {
  const level = req.query.level == null ? null : String(req.query.level);
  if (level != null && !SELECT_LEVELS[level]) {
    res.status(400).json({ error: `level must be one of ${Object.keys(SELECT_LEVELS).join(', ')}` });
    return null;
  }
  let race = req.query.office ?? req.query.race;
  if (race == null && level) race = level === 'top' ? 'top' : results.offices(ek).levels[level][0]?.office;
  race = String(race ?? 'senate');
  if (!OFFICE_RE.test(race)) {
    res.status(400).json({ error: 'office must be an office key such as senate, house, governor, attorney_general (see /api/offices)' });
    return null;
  }
  return race;
};
/** ?election=<key> (default: config/elections.json `current`). Unknown → 404. */
const electionParam = (req, res) => {
  const asked = req.query.election == null ? null : String(req.query.election);
  const ek = results.resolveElection(asked);
  if (!ek) {
    res.status(404).json({ error: `unknown election ${JSON.stringify(asked)}; see /api/elections` });
    return null;
  }
  return ek;
};

api.get('/elections', (req, res) => res.json(results.elections()));
api.get('/changelog', (req, res) => res.json({ ...changelog, currentVersion: config.version }));
api.get('/offices', (req, res) => {
  const ek = electionParam(req, res);
  if (ek) res.json(results.offices(ek));
});
api.get('/national', (req, res) => {
  const ek = electionParam(req, res);
  const race = ek && raceParam(req, res, ek);
  if (race) res.json(results.national(race, ek));
});
api.get('/state/:abbr/contests', (req, res) => {
  const ek = electionParam(req, res);
  if (!ek) return;
  if (!stateByAbbr(req.params.abbr)) return res.status(404).json({ error: 'unknown state' });
  const qs = req.query.q == null ? '' : String(req.query.q).slice(0, 100);
  res.json(results.contests(req.params.abbr, ek, qs));
});
api.get('/state/:abbr', (req, res) => {
  const ek = electionParam(req, res);
  const race = ek && raceParam(req, res, ek);
  if (!race) return;
  if (!stateByAbbr(req.params.abbr)) return res.status(404).json({ error: 'unknown state' });
  res.json(results.state(req.params.abbr, race, ek));
});
api.get('/measures', (req, res) => {
  const ek = electionParam(req, res);
  if (!ek) return;
  const st = req.query.state ? String(req.query.state) : null;
  if (st && !stateByAbbr(st)) return res.status(404).json({ error: 'unknown state' });
  res.json(results.measures(st, ek));
});
api.get('/coverage', (req, res) => {
  const ek = electionParam(req, res);
  if (ek) res.json(results.coverage(ek));
});
api.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use('/api', api);

// The built frontend (production / docker). In dev, Vite serves it and proxies /api here.
if (existsSync(config.clientDist)) {
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('election-map API. Frontend not built: run `npm run dev` or `npm run build`.'));
}

const server = createServer(app);
// Behind Cloudflare: accept both websocket and long-polling, and ping well inside Cloudflare's 100 s idle timeout.
const io = new Server(server, {
  serveClient: false,
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});
io.on('connection', (socket) => socket.emit('hello', { version: config.version }));

const stop = startPolling({
  db,
  adapters,
  onUpdate: (u) => {
    // Every successful fetch: a cheap heartbeat. New numbers: drop the API cache, then results:update,
    // which clients refetch on.
    if (u.changed) cache.clear();
    io.emit('source:checked', u);
    if (u.changed) {
      io.emit('results:update', { sourceId: u.sourceId, election: u.election ?? currentElectionKey(), states: u.states, fetchedAt: u.fetchedAt });
    }
  },
});

server.listen(config.port, () => {
  log.info(`election-map ${config.version} on :${config.port} — ${adapters.length} adapter(s): ${adapters.map((a) => `${a.id} (${a.targets().length} targets)`).join(', ')}`);
});

const shutdown = () => {
  stop();
  rateLimit.stop();
  io.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
