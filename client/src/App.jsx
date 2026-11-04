import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import { RACES, shortLabel, longLabel, registerOfficeLabels } from './format.js';
import { estReporting, newestTime, fmtMT } from './calc.js';
import { fmtReporting } from './format.js';
import { stateFeatures, FIPS_TO_ABBR } from './geo.js';
import { newerDataVersion, isNewerAppVersion, safetyPollDue, updatedAgo } from './live.js';
import NationalView from './components/NationalView.jsx';
import StateView from './components/StateView.jsx';
import Sidebar from './components/Sidebar.jsx';
import Legend from './components/Legend.jsx';
import Changelog from './components/Changelog.jsx';

const DEFAULT_OFFICE = 'senate';
const REFETCH_DEBOUNCE_MS = 600;
const LEVELS = [['federal', 'Federal'], ['state', 'State']];
const FEDERAL = new Set(['president', 'senate', 'house']);
// The version this bundle was built as (CHANGELOG.json, injected by vite.config.js).
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

// Short, shareable office names in the URL (?office=ag). Anything else is the server's office key as-is.
const ALIASES = { ag: 'attorney_general', sos: 'secretary_of_state', lg: 'lieutenant_governor', ltgov: 'lieutenant_governor', gov: 'governor' };
const ALIAS_OF = Object.fromEntries(Object.entries(ALIASES).filter(([k]) => !['ltgov', 'gov'].includes(k)).map(([k, v]) => [v, k]));
const OFFICE_RE = /^[a-z][a-z_]{1,48}$/;

/**
 * Routes are query strings so views can be shared: ?level=state&office=ag&state=CO&tab=all.
 * 0.2 hash links (#/CO/senate, #/house) still work and are rewritten once.
 */
function parseLocation(loc) {
  const p = new URLSearchParams(loc.search);
  const hash = loc.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (hash.length && !p.has('office') && !p.has('state')) {
    if (/^[A-Za-z]{2}$/.test(hash[0]) && !RACES.includes(hash[0].toLowerCase())) {
      p.set('state', hash[0]);
      if (hash[1]) p.set('office', hash[1]);
    } else if (hash[0]) p.set('office', hash[0]);
  }
  let office = String(p.get('office') || '').toLowerCase();
  office = ALIASES[office] ?? office;
  const levelAsked = p.get('level') === 'state' ? 'state' : p.get('level') === 'federal' ? 'federal' : null;
  if (!OFFICE_RE.test(office)) office = levelAsked === 'state' ? 'governor' : DEFAULT_OFFICE;
  const level = levelAsked ?? (FEDERAL.has(office) ? 'federal' : 'state');
  const st = String(p.get('state') || '').toUpperCase();
  return { state: /^[A-Z]{2}$/.test(st) ? st : null, office, level, tab: p.get('tab') === 'all' ? 'all' : 'overview' };
}
function toSearch({ state, office, level, tab }) {
  const p = new URLSearchParams();
  p.set('level', level);
  p.set('office', ALIAS_OF[office] ?? office);
  if (state) p.set('state', state);
  if (state && tab === 'all') p.set('tab', 'all');
  return `?${p.toString()}`;
}

function useRoute() {
  const [route, setRoute] = useState(() => parseLocation(window.location));
  useEffect(() => {
    // Rewrite a 0.2 hash link (or a bare URL) to the canonical query form without adding a history entry.
    const canonical = toSearch(parseLocation(window.location));
    if (window.location.hash || window.location.search !== canonical) {
      window.history.replaceState(null, '', `${window.location.pathname}${canonical}`);
    }
    const onPop = () => setRoute(parseLocation(window.location));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next) => {
    setRoute((cur) => {
      const r = { ...cur, ...next };
      if (next.state !== undefined && next.state !== cur.state && next.tab === undefined) r.tab = 'overview';
      const search = toSearch(r);
      if (search !== window.location.search) window.history.pushState(null, '', `${window.location.pathname}${search}`);
      return parseLocation({ search, hash: '' });
    });
  }, []);
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

// Until /api/offices answers (or if it fails), the headline offices.
const FALLBACK_OFFICES = {
  federal: [{ office: 'senate', label: 'U.S. Senate' }, { office: 'house', label: 'U.S. House' }],
  state: [{ office: 'governor', label: 'Governor' }],
};

export default function App() {
  const [route, navigate] = useRoute();
  const { state: abbr, office: race, level, tab } = route;
  const [tick, setTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [focusMeasure, setFocusMeasure] = useState(null);

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

  const officesBox = useLive('offices', tick, () => api.offices(dataVersion.current));
  const levels = officesBox.data?.levels || FALLBACK_OFFICES;
  registerOfficeLabels(levels);
  const officeList = levels[level]?.length ? levels[level] : FALLBACK_OFFICES[level];

  // National data always loads: it drives the header (est. reporting) and the national map.
  const national = useLive(race, tick, () => api.national(race, dataVersion.current));
  const stateBox = useLive(abbr ? `${abbr}/${race}` : null, tick, () => api.state(abbr, race, dataVersion.current));
  const contestsBox = useLive(abbr && tab === 'all' ? abbr : null, tick, () => api.contests(abbr, dataVersion.current));
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
  const viewAt = abbr ? (tab === 'all' ? contestsBox.at : stateBox.at) : national.at;

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
  const viewError = abbr ? (tab === 'all' ? contestsBox.error : stateBox.error) : national.error;
  const closeChangelog = useCallback(() => setChangelogOpen(false), []);

  // A new view starts at the top.
  useEffect(() => { window.scrollTo(0, 0); }, [abbr]);

  useEffect(() => {
    document.title = `${stateName ? `${stateName} · ` : ''}${shortLabel(race)} · Election Night 2026 (unofficial)`;
  }, [stateName, race, officesBox.data]);

  const pickLevel = (lv) => {
    if (lv === level) return;
    const first = (levels[lv]?.length ? levels[lv] : FALLBACK_OFFICES[lv])[0]?.office;
    navigate({ level: lv, office: first });
  };
  const openMeasure = (id) => {
    setSidebarOpen(true);
    setFocusMeasure({ id, at: Date.now() });
  };

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

        <div className="race-picker">
          <div className="level-group" role="group" aria-label="Election level">
            {LEVELS.map(([k, label]) => (
              <button key={k} type="button" className="level-btn" aria-pressed={k === level} onClick={() => pickLevel(k)}>{label}</button>
            ))}
          </div>
          <div className="race-group" role="group" aria-label="Race">
            {officeList.map((o) => (
              <button key={o.office} type="button" className="race-btn" aria-pressed={o.office === race}
                onClick={() => navigate({ office: o.office, level })}>
                {shortLabel(o.office)}
              </button>
            ))}
          </div>
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
                  <button type="button" className="link-btn" onClick={() => navigate({ state: null })}>← United States</button>
                  <span className="sep" aria-hidden="true">/</span>
                  <span className="here" aria-current="page">{stateName}</span>
                  {tab === 'overview' && <span className="sub">· {longLabel(race)}</span>}
                </>
              ) : (
                <>
                  <span className="here" aria-current="page">United States</span>
                  <span className="sub">· {longLabel(race)}</span>
                </>
              )}
            </nav>
            <label className="jump">
              Jump to state
              <select value={abbr || ''} onChange={(e) => navigate({ state: e.target.value || null })}>
                <option value="">United States</option>
                {STATE_OPTIONS.map((o) => <option key={o.a} value={o.a}>{o.n}</option>)}
              </select>
            </label>
          </div>

          {abbr && (
            <div className="tabs" role="tablist" aria-label="State view">
              {[['overview', 'Overview'], ['all', 'All races']].map(([k, label]) => (
                <button key={k} type="button" role="tab" className="tab" aria-selected={tab === k} onClick={() => navigate({ tab: k })}>{label}</button>
              ))}
            </div>
          )}

          {viewError && (
            <div className="banner err" role="alert">
              {viewError}{(abbr ? stateData : national.data) ? ' Showing the last data we received.' : ''}
            </div>
          )}

          {abbr ? (
            <StateView abbr={abbr} race={race} tab={tab} data={stateData} error={stateBox.error}
              contests={contestsBox.data} contestsError={contestsBox.error} onOpenMeasure={openMeasure} />
          ) : (
            <NationalView data={national.data} race={race} error={national.error} onSelectState={(s) => navigate({ state: s })} />
          )}

          {(!abbr || tab === 'overview') && (
            <Legend
              showNoData={!!abbr && stateData?.countyData === 'partial'}
              multiSeat={abbr ? !!stateData?.statewide?.multiSeat : (nStates || []).some((s) => s.multiSeat)}
            />
          )}
          <p className="disclaimer">
            Unofficial results — counts change as ballots are reported. "Leading" means more votes counted so far; this site does not call races.
          </p>
        </main>

        {sidebarOpen && (
          <Sidebar
            measures={measuresBox.data?.measures || null}
            error={measuresBox.error}
            stateName={stateName}
            focus={focusMeasure}
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
