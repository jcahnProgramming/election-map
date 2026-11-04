import React, { useMemo } from 'react';
import MapSvg from './MapSvg.jsx';
import EntryTip from './EntryTip.jsx';
import { stateFeatures, path, FIPS_TO_ABBR } from '../geo.js';
import { tallyStates } from '../calc.js';
import { TOSSUP_MARGIN } from '../shading.js';
import { RACE_LONG } from '../format.js';

export function Tally({ states }) {
  const t = tallyStates(states);
  const v = (n) => (states ? n : '—');
  return (
    <div className="grid grid-3 tally stat-cards">
      <div className="card">
        <span className="k dem">Democrat leading</span>
        <span className="big xl">{v(t.dem)}</span>
      </div>
      <div className="card">
        <span className="k toss">Toss-up (&lt;{TOSSUP_MARGIN} pts)</span>
        <span className="big xl">{v(t.toss)}</span>
      </div>
      <div className="card">
        <span className="k rep">Republican leading</span>
        <span className="big xl">{v(t.rep)}</span>
      </div>
    </div>
  );
}

export default function NationalView({ data, race, error, onSelectState }) {
  const byFips = useMemo(() => {
    const m = {};
    for (const s of data?.states || []) m[s.fips] = s;
    return m;
  }, [data]);

  const reporting = (data?.states || []).filter((s) => s.status === 'reporting').length;
  const otherLeading = tallyStates(data?.states).other;

  return (
    <>
      <Tally states={data?.states} />
      {data && (
        <p className="contest-line">
          {reporting} state{reporting === 1 ? '' : 's'} with {RACE_LONG[race]} votes counted so far
          {otherLeading > 0 ? ` · ${otherLeading} led by a candidate outside the two major parties` : ''}.
        </p>
      )}
      <div className="map-panel">
        {data ? (
          <MapSvg
            label={`US map: ${RACE_LONG[race]}, each state shaded by who is leading in votes counted so far`}
            features={stateFeatures}
            pathFn={path}
            entryFor={(f) => byFips[f.id]}
            onPick={(f) => {
              const abbr = byFips[f.id]?.state || FIPS_TO_ABBR[f.id];
              if (abbr) onSelectState(abbr);
            }}
            renderTip={(f, e) => <EntryTip title={e?.name || f.properties?.name} entry={e} race={race} />}
          />
        ) : (
          <div className="map-box">
            <div className="map-msg">{error ? 'Map unavailable until the results server answers.' : 'Loading map…'}</div>
          </div>
        )}
      </div>
    </>
  );
}
