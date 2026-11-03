import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import { config } from './config.js';
import { openDb } from './db.js';
import { loadAdapters } from './adapters/index.js';
import { startPolling, health } from './poller.js';
import { createResults, RACES } from './results.js';
import { stateByAbbr } from './geo.js';
import { logger } from './log.js';

const log = logger('server');
const db = openDb();
const adapters = await loadAdapters();
const results = createResults(db, adapters);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal'); // behind the Cloudflare tunnel

const api = express.Router();
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store'); // live numbers; the browser should always ask
  next();
});
const raceParam = (req, res) => {
  const race = String(req.query.race ?? 'senate');
  if (!RACES.includes(race)) {
    res.status(400).json({ error: `race must be one of ${RACES.join(', ')}` });
    return null;
  }
  return race;
};

api.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: config.version,
    sources: [...health.values()].map((h) => ({
      id: h.id, name: h.name, lastSuccess: h.lastSuccess, lastError: h.lastError, lastErrorAt: h.lastErrorAt,
      targets: h.targets,
    })),
  });
});
api.get('/national', (req, res) => {
  const race = raceParam(req, res);
  if (race) res.json(results.national(race));
});
api.get('/state/:abbr', (req, res) => {
  const race = raceParam(req, res);
  if (!race) return;
  if (!stateByAbbr(req.params.abbr)) return res.status(404).json({ error: 'unknown state' });
  res.json(results.state(req.params.abbr, race));
});
api.get('/measures', (req, res) => {
  if (req.query.state && !stateByAbbr(req.query.state)) return res.status(404).json({ error: 'unknown state' });
  res.json(results.measures(req.query.state || null));
});
api.get('/coverage', (req, res) => res.json(results.coverage()));
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
const io = new Server(server, { serveClient: false });
io.on('connection', (socket) => socket.emit('hello', { version: config.version }));

const stop = startPolling({
  db,
  adapters,
  onUpdate: (u) => {
    // Every successful fetch: a cheap heartbeat. New numbers: results:update, which clients refetch on.
    io.emit('source:checked', u);
    if (u.changed) io.emit('results:update', { sourceId: u.sourceId, states: u.states, fetchedAt: u.fetchedAt });
  },
});

server.listen(config.port, () => {
  log.info(`election-map ${config.version} on :${config.port} — ${adapters.length} adapter(s): ${adapters.map((a) => `${a.id} (${a.targets().length} targets)`).join(', ')}`);
});

const shutdown = () => {
  stop();
  io.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
