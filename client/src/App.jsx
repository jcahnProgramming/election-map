import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import { RACES, RACE_SHORT, RACE_LONG } from './format.js';
import { estReporting, newestTime, fmtMT } from './calc.js';
import { fmtReporting } from './format.js';
import { stateFeatures, FIPS_TO_ABBR } from './geo.js';
import { newerDataVersion, isNewerAppVersion, safetyPollDue, updatedAgo } from './live.js';
import NationalView from './components/NationalView.jsx';
import StateView from './components/StateView.jsx';
import Sidebar from './components/Sidebar.jsx';
import Legend from './components/Legend.jsx';
import Changelog from './components/Changelog.jsx';

const DEFAULT_RACE = 'senate';
const REFETCH_DEBOUNCE_MS = 600;
// The version this bundle was built as (CHANGELOG.json, injected by vite.config.js).
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

// Hash routes: #/senate  |  #/CO/senate
function parseHash(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts.length && /^[A-Za-z]{2}$/.test(parts[0]) && !RACES.includes(parts[0].toLowerCase())) {
    const race = RACES.includes(parts[1]) ? parts[1] : DEFAULT_RACE;
    return { state: parts[0].toUpperCase(), race };
  }
  return { state: null, race: RACES.includes(parts[0]) ? parts[0] : DEFAULT_RACE };
}
const toHash = ({ state, race }) => (state ? `#/${state}/${race}` : `#/${race}`);

function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((next) => { window.location.hash = toHash(next); }, []);
  return [route, navigate];
}

/**
 * Socket.io connection. `handlers.onUpdate(msg)` on results:update, `handlers.onReconnect()` on every connect after
 * the first (server restart / network drop: we may have missed updates), `handlers.onHello({version})` on connect.
 * Listeners are registered once on the Socket object, which socket.io-client keeps across reconnects; there are no rooms.
 */
function useSocket(handlers) {
  const [state, setState] = useState({ connected: false, everConnected: false });
  const cb = useRef(handlers);
  cb.current = handlers;
  useEffect(() => {
    // Polling first, then upgrade: works behind Cloudflare even where websockets are blocked.
    const socket = io({ transports: ['polling', 'websocket'] });
    let connects = 0;
    socket.on('connect', () => {
      setState({ connected: true, everConnected: true });
      if (connects++ > 0) cb.current.onReconnect?.();
    });
    socket.on('disconnect', (reason) => {
      setState((s) => ({ ...s, connected: false }));
      // A server shutdown (redeploy) closes sockets with "io server disconnect", after which socket.io-client
      // does NOT reconnect by itself: ask for it explicitly.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', () => setState((s) => ({ ...s, connected: false })));
    socket.on('hello', (msg) => cb.current.onHello?.(msg));
    socket.on('results:update', (msg) => cb.current.onUpdate?.(msg));
    return () => socket.close();
  }, []);
  return state;
}

/**
 * Fetch `fn()` whenever `key` or `tick` changes; keeps the previous value for the same key while refetching.
 * `at` = when this key's data last arrived (drives "Updated Xs ago").
 */
function useLive(key, tick, fn) {
  const [box, setBox] = useState({ key: null, data: null, error: null, at: null });
  const req = useRef(0);
  useEffect(() => {
    if (key == null) return;
    const id = ++req.current;
    fn().then(
      (data) => id === req.current && setBox({ key, data, error: null, at: Date.now() }),
      (e) => id === req.current && setBox((b) => (b.key === key
        ? { ...b, error: e.message || String(e) }
        : { key, data: null, error: e.message || String(e), at: null }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return box.key === key ? box : { key, data: null, error: null, at: null };
}

/** "Updated Xs ago", counting up live. Its own 1 s timer so the maps don't re-render every second. */
function UpdatedAgo({ at }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const text = at ? updatedAgo(now - at) : null;
  return text ? <span className="ago">{text}</span> : null;
}

const STATE_OPTIONS = stateFeatures
  .map((f) => ({ a: FIPS_TO_ABBR[f.id], n: f.properties?.name }))
  .filter((o) => o.a && o.n)
  .sort((x, y) => x.n.localeCompare(y.n));

export default function App() {
  const [route, navigate] = useHashRoute();
  const { state: abbr, race } = route;
  const [tick, setTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [changelogOpen, setChangelogOpen] = useState(false);

  // Data version (newest snapshot's fetchedAt): refetches carry it as ?v= so neither the browser nor Cloudflare's
  // edge (max-age=15) can answer them with a pre-update copy. null until known: plain first loads stay cacheable.
  const dataVersion = useRef(null);
  const lastRefresh = useRef(Date.now()); // last time anything (event, catch-up) refreshed the view
  const [serverVersion, setServerVersion] = useState(null);
  const debounce = useRef(null);
  const refetch = useCallback(() => {
    lastRefresh.current = Date.now();
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setTick((t) => t + 1), REFETCH_DEBOUNCE_MS);
  }, []);
  // Catch-up (reconnect, tab visible again, safety net): ask the never-cached health endpoint for the current data
  // version and app version, then refetch the view under that version.
  const catchingUp = useRef(false);
  const catchUp = useCallback(() => {
    if (catchingUp.current) return;
    catchingUp.current = true;
    lastRefresh.current = Date.now();
    api.health()
      .then((h) => {
        dataVersion.current = newerDataVersion(dataVersion.current, h?.dataVersion);
        if (h?.version) setServerVersion(h.version);
      })
      .catch(() => {}) // still refetch: the view's own error handling reports an unreachable server
      .finally(() => { catchingUp.current = false; refetch(); });
  }, [refetch]);

  const { connected, everConnected } = useSocket({
    onUpdate: (msg) => {
      dataVersion.current = newerDataVersion(dataVersion.current, msg?.fetchedAt);
      refetch();
    },
    onReconnect: catchUp,
    onHello: (msg) => { if (msg?.version) setServerVersion(msg.version); },
  });

  // Safety net, independent of the socket: refetch if nothing refreshed the view for 60 s, and as soon as the tab
  // becomes visible again (timers are throttled in background tabs and events may have been missed).
  useEffect(() => {
    const visible = () => document.visibilityState !== 'hidden';
    const id = setInterval(() => {
      if (safetyPollDue(lastRefresh.current, Date.now(), { visible: visible() })) catchUp();
    }, 5000);
    const onVis = () => { if (visible()) catchUp(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [catchUp]);

  // National data always loads: it drives the header (est. reporting) and the national map.
  const national = useLive(race, tick, () => api.national(race, dataVersion.current));
  const stateBox = useLive(abbr ? `${abbr}/${race}` : null, tick, () => api.state(abbr, race, dataVersion.current));
  const measuresBox = useLive(abbr || '*', tick, () => api.measures(abbr, dataVersion.current));
  const changelog = useLive('changelog', 0, () => api.changelog());
  const health = useLive('health', 0, () => api.health());
  useEffect(() => {
    // Learn the data version from the first health read, without refetching (the first load is already under way).
    if (health.data) {
      dataVersion.current = newerDataVersion(dataVersion.current, health.data.dataVersion);
      if (health.data.version) setServerVersion((v) => v ?? health.data.version);
    }
  }, [health.data]);

  const version = changelog.data?.currentVersion || health.data?.version || changelog.data?.releases?.[0]?.version || null;
  // A deploy happened since this page loaded: the server runs a newer version than this bundle.
  const newVersion = isNewerAppVersion(APP_VERSION, serverVersion) ? serverVersion : null;
  const viewAt = abbr ? stateBox.at : national.at;

  const nStates = national.data?.states;
  const est = estReporting(nStates);
  const stateData = abbr ? stateBox.data : null;

  const lastUpdate = useMemo(() => {
    if (abbr) {
      const sw = stateData?.statewide;
      const t = newestTime([sw?.fetchedAt, sw?.sourceUpdatedAt, ...(sw?.otherContests || []).map((c) => c.fetchedAt)]);
      if (t) return t;
      // A state with no source of its own: show when the national picture last changed.
    }
    return newestTime((nStates || []).flatMap((s) => [s.fetchedAt, s.sourceUpdatedAt]));
  }, [abbr, stateData, nStates]);

  const stateName = abbr ? stateData?.name || STATE_OPTIONS.find((o) => o.a === abbr)?.n || abbr : null;
  const viewError = abbr ? stateBox.error : national.error;
  const closeChangelog = useCallback(() => setChangelogOpen(false), []);

  // A new view starts at the top (the hash change alone keeps the old scroll position).
  useEffect(() => { window.scrollTo(0, 0); }, [abbr]);

  useEffect(() => {
    document.title = `${stateName ? `${stateName} · ` : ''}${RACE_SHORT[race]} · Election Night 2026 (unofficial)`;
  }, [stateName, race]);

  return (
    <div className="app">
      {newVersion && (
        <div className="update-banner" role="status">
          <span>New version available (v{newVersion})</span>
          <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <header className="hdr">
        <div className="hdr-title">
          <span className={`live-dot${connected ? '' : ' off'}`} title={connected ? 'Live updates connected' : 'Reconnecting to live updates…'} aria-hidden="true" />
          <h1>Election Night 2026</h1>
          {!connected && <span className="conn-state" aria-hidden="true">{everConnected ? 'Reconnecting…' : 'Connecting…'}</span>}
          <span className="sr-only" role="status">{connected ? 'Live updates connected' : 'Live updates reconnecting'}</span>
        </div>

        <div className="race-group" role="group" aria-label="Race">
          {RACES.map((r) => (
            <button key={r} type="button" className="race-btn" aria-pressed={r === race} onClick={() => navigate({ state: abbr, race: r })}>
              {RACE_SHORT[r]}
            </button>
          ))}
        </div>

        <div className="hdr-meta">
          <div className="hdr-stat" title="Votes-weighted across states reporting a % of precincts or votes counted">
            <span className="k">Est. reporting</span>
            <span className="v">{est != null ? fmtReporting(est) : '—'}</span>
          </div>
          <div className="hdr-stat">
            <span className="k">Last update</span>
            <span className="v">{fmtMT(lastUpdate) || '—'} <UpdatedAgo at={viewAt} /></span>
          </div>
          <button type="button" className="btn-ghost" onClick={() => setChangelogOpen(true)} aria-haspopup="dialog" aria-label={`What's new${version ? `: version ${version}` : ''}`}>
            {version ? `v${version}` : 'v…'}
          </button>
          <button type="button" className="btn" onClick={() => setSidebarOpen((o) => !o)} aria-expanded={sidebarOpen} aria-controls="measures">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
            Ballot measures
          </button>
        </div>
      </header>

      <div className="body">
        <main className="main">
          <div className="toolbar">
            <nav aria-label="Breadcrumb" className="crumbs">
              {abbr ? (
                <>
                  <button type="button" className="link-btn" onClick={() => navigate({ state: null, race })}>← United States</button>
                  <span className="sep" aria-hidden="true">/</span>
                  <span className="here" aria-current="page">{stateName}</span>
                  <span className="sub">· {RACE_LONG[race]}</span>
                </>
              ) : (
                <>
                  <span className="here" aria-current="page">United States</span>
                  <span className="sub">· {RACE_LONG[race]}</span>
                </>
              )}
            </nav>
            <label className="jump">
              Jump to state
              <select value={abbr || ''} onChange={(e) => navigate({ state: e.target.value || null, race })}>
                <option value="">United States</option>
                {STATE_OPTIONS.map((o) => <option key={o.a} value={o.a}>{o.n}</option>)}
              </select>
            </label>
          </div>

          {viewError && (
            <div className="banner err" role="alert">
              {viewError}{(abbr ? stateData : national.data) ? ' Showing the last data we received.' : ''}
            </div>
          )}

          {abbr ? (
            <StateView abbr={abbr} race={race} data={stateData} error={stateBox.error} />
          ) : (
            <NationalView data={national.data} race={race} error={national.error} onSelectState={(s) => navigate({ state: s, race })} />
          )}

          <Legend showNoData={!!abbr && stateData?.countyData === 'partial'} />
          <p className="disclaimer">
            Unofficial results — counts change as ballots are reported. "Leading" means more votes counted so far; this site does not call races.
          </p>
        </main>

        {sidebarOpen && (
          <Sidebar
            measures={measuresBox.data?.measures || null}
            error={measuresBox.error}
            stateName={stateName}
            onClose={() => setSidebarOpen(false)}
          />
        )}
      </div>

      {changelogOpen && (
        <Changelog data={changelog.data} error={changelog.error} currentVersion={version} onClose={closeChangelog} />
      )}
    </div>
  );
}
