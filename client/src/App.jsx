import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import { RACES, RACE_SHORT, RACE_LONG } from './format.js';
import { estReporting, newestTime, fmtMT } from './calc.js';
import { fmtReporting } from './format.js';
import { stateFeatures, FIPS_TO_ABBR } from './geo.js';
import NationalView from './components/NationalView.jsx';
import StateView from './components/StateView.jsx';
import Sidebar from './components/Sidebar.jsx';
import Legend from './components/Legend.jsx';
import Changelog from './components/Changelog.jsx';

const DEFAULT_RACE = 'senate';
const REFETCH_DEBOUNCE_MS = 600;

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

function useSocket(onUpdate) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  useEffect(() => {
    // Polling first, then upgrade: works behind Cloudflare even where websockets are blocked.
    const socket = io({ transports: ['polling', 'websocket'] });
    socket.on('connect', () => { setConnected(true); cb.current({ reconnect: true }); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('results:update', (msg) => cb.current(msg));
    return () => socket.close();
  }, []);
  return connected;
}

/** Fetch `fn()` whenever `key` or `tick` changes; keeps the previous value for the same key while refetching. */
function useLive(key, tick, fn) {
  const [box, setBox] = useState({ key: null, data: null, error: null });
  const req = useRef(0);
  useEffect(() => {
    if (key == null) return;
    const id = ++req.current;
    fn().then(
      (data) => id === req.current && setBox({ key, data, error: null }),
      (e) => id === req.current && setBox((b) => ({ key, data: b.key === key ? b.data : null, error: e.message || String(e) }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return box.key === key ? box : { key, data: null, error: null };
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

  const debounce = useRef(null);
  const connected = useSocket(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setTick((t) => t + 1), REFETCH_DEBOUNCE_MS);
  });

  // National data always loads: it drives the header (est. reporting) and the national map.
  const national = useLive(race, tick, () => api.national(race));
  const stateBox = useLive(abbr ? `${abbr}/${race}` : null, tick, () => api.state(abbr, race));
  const measuresBox = useLive(abbr || '*', tick, () => api.measures(abbr));
  const changelog = useLive('changelog', 0, () => api.changelog());
  const health = useLive('health', 0, () => api.health());

  const version = changelog.data?.currentVersion || health.data?.version || changelog.data?.releases?.[0]?.version || null;

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
      <header className="hdr">
        <div className="hdr-title">
          <span className={`live-dot${connected ? '' : ' off'}`} title={connected ? 'Live updates connected' : 'Reconnecting to live updates…'} aria-hidden="true" />
          <h1>Election Night 2026</h1>
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
            <span className="v">{fmtMT(lastUpdate) || '—'}</span>
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
