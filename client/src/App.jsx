import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import { RACES, shortLabel, longLabel, registerOfficeLabels } from './format.js';
import { estReporting, newestTime, fmtMT } from './calc.js';
import { fmtReporting } from './format.js';
import { stateFeatures, FIPS_TO_ABBR } from './geo.js';
import NationalView from './components/NationalView.jsx';
import StateView from './components/StateView.jsx';
import Sidebar from './components/Sidebar.jsx';
import Legend from './components/Legend.jsx';
import Changelog from './components/Changelog.jsx';

const DEFAULT_OFFICE = 'senate';
const REFETCH_DEBOUNCE_MS = 600;
const LEVELS = [['federal', 'Federal'], ['state', 'State']];
const FEDERAL = new Set(['president', 'senate', 'house']);

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

  const debounce = useRef(null);
  const connected = useSocket(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setTick((t) => t + 1), REFETCH_DEBOUNCE_MS);
  });

  const officesBox = useLive('offices', tick, () => api.offices());
  const levels = officesBox.data?.levels || FALLBACK_OFFICES;
  registerOfficeLabels(levels);
  const officeList = levels[level]?.length ? levels[level] : FALLBACK_OFFICES[level];

  // National data always loads: it drives the header (est. reporting) and the national map.
  const national = useLive(race, tick, () => api.national(race));
  const stateBox = useLive(abbr ? `${abbr}/${race}` : null, tick, () => api.state(abbr, race));
  const contestsBox = useLive(abbr && tab === 'all' ? abbr : null, tick, () => api.contests(abbr));
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
      <header className="hdr">
        <div className="hdr-title">
          <span className={`live-dot${connected ? '' : ' off'}`} title={connected ? 'Live updates connected' : 'Reconnecting to live updates…'} aria-hidden="true" />
          <h1>Election Night 2026</h1>
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
