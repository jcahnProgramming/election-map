import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api.js';
import { RACE_LABEL, fmtTime } from './format.js';
import NationalView from './components/NationalView.jsx';
import StateView from './components/StateView.jsx';
import Sidebar from './components/Sidebar.jsx';
import Legend from './components/Legend.jsx';

const RACES = ['senate', 'governor', 'house'];
const DEFAULT_RACE = 'senate';

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
  const navigate = useCallback((next) => {
    window.location.hash = toHash(next);
  }, []);
  return [route, navigate];
}

function useSocket(onUpdate) {
  const [status, setStatus] = useState('connecting');
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setStatus('connected');
      // On (re)connect we may have missed updates or the server may have just come up: refetch.
      cb.current({ reconnect: true });
    });
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on('connect_error', () => setStatus('reconnecting'));
    socket.on('results:update', (msg) => cb.current(msg));
    return () => socket.close();
  }, []);
  return status;
}

export default function App() {
  const [route, navigate] = useHashRoute();
  const { state: abbr, race } = route;

  const [national, setNational] = useState(null);
  const [stateData, setStateData] = useState(null);
  const [measures, setMeasures] = useState(null);
  const [error, setError] = useState(null);
  const [measuresError, setMeasuresError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [lastPush, setLastPush] = useState(null);
  const [tick, setTick] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const reqId = useRef(0);

  // Debounced refetch on socket push.
  const debounce = useRef(null);
  const socketStatus = useSocket((msg) => {
    if (msg?.fetchedAt) setLastPush(msg.fetchedAt);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setTick((t) => t + 1), 300);
  });

  // Main view data.
  useEffect(() => {
    const id = ++reqId.current;
    const p = abbr ? api.state(abbr, race) : api.national(race);
    p.then((d) => {
      if (id !== reqId.current) return;
      if (abbr) setStateData({ key: `${abbr}/${race}`, d });
      else setNational({ key: race, d });
      setError(null);
      setLastUpdate(new Date().toISOString());
    }).catch((e) => {
      if (id !== reqId.current) return;
      setError(e.message || String(e));
    });
  }, [abbr, race, tick]);

  // Ballot measures.
  useEffect(() => {
    let alive = true;
    api
      .measures(abbr)
      .then((d) => {
        if (!alive) return;
        setMeasures({ key: abbr || '', list: d.measures || [] });
        setMeasuresError(null);
      })
      .catch((e) => alive && setMeasuresError(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, [abbr, tick]);

  const nationalData = national?.key === race ? national.d : null;
  const currentState = stateData?.key === `${abbr}/${race}` ? stateData.d : null;
  const currentMeasures = measures?.key === (abbr || '') ? measures.list : null;
  const viewData = abbr ? currentState : nationalData;

  return (
    <div style={{ paddingRight: sidebarOpen ? 380 : 0 }}>
      <h1 style={{ marginBottom: 4 }}>2026 Midterm Elections — Live Results</h1>
      <div className="notice">
        <strong>Unofficial results — counts change as ballots are reported.</strong>{' '}
        Leading = most votes counted so far. We do not call races.
      </div>

      <div className="row">
        <label>
          Race:{' '}
          <select value={race} onChange={(e) => navigate({ state: abbr, race: e.target.value })}>
            {RACES.map((r) => (
              <option key={r} value={r}>{RACE_LABEL[r]}</option>
            ))}
          </select>
        </label>
        <span>
          Last update: {lastUpdate ? fmtTime(lastUpdate) : '—'}
          {viewData?.generatedAt ? ` (server data as of ${fmtTime(viewData.generatedAt)})` : ''}
          {lastPush ? ` · last push ${fmtTime(lastPush)}` : ''}
        </span>
        <span>
          Live updates:{' '}
          <strong style={{ color: socketStatus === 'connected' ? 'green' : '#b60' }}>{socketStatus}</strong>
        </span>
      </div>

      {error && (
        <div className="error">
          {error}
          {viewData ? ' Showing the last data we received.' : ''}
        </div>
      )}
      {!viewData && !error && <div>Loading…</div>}

      <Legend />

      {abbr ? (
        <StateView abbr={abbr} race={race} data={currentState} onBack={() => navigate({ state: null, race })} />
      ) : (
        (nationalData || error) && (
          <NationalView
            data={nationalData || { race, states: [] }}
            onSelectState={(s) => navigate({ state: s, race })}
          />
        )
      )}

      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        measures={currentMeasures}
        error={measuresError}
        stateAbbr={abbr}
      />
    </div>
  );
}
