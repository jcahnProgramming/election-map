import React, { useMemo, useState } from 'react';
import MapSvg from './MapSvg.jsx';
import EntryTip from './EntryTip.jsx';
import { stateFeatures, path, FIPS_TO_ABBR } from '../geo.js';
import { tallyStates, fmtMT } from '../calc.js';
import { TOSSUP_MARGIN } from '../shading.js';
import { longLabel } from '../format.js';

/**
 * Where a state's numbers come from, with a real link to its official results page. Under the map it follows the
 * last state hovered (a tooltip can't hold a clickable link), so every state's government source is one click away.
 */
export function SourceBar({ entry, name }) {
  if (!entry) {
    return <p className="source-bar muted">Hover or tap a state to see where its numbers come from, with a link to its official results page.</p>;
  }
  const covered = entry.status === 'reporting' || entry.status === 'awaiting';
  const updated = fmtMT(entry.sourceUpdatedAt || entry.fetchedAt);
  return (
    <p className="source-bar">
      <b>{name || entry.name}</b>
      {covered && entry.sourceName ? (
        <span>
          Source: {entry.sourceUrl ? <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer">{entry.sourceName}</a> : entry.sourceName}
          {updated ? ` · updated ${updated}` : ''}
        </span>
      ) : (
        <span>{entry.status === 'no-race' ? 'No race for this office in our sources' : 'No data source yet'}</span>
      )}
      {entry.official?.url ? (
        <a href={entry.official.url} target="_blank" rel="noopener noreferrer" className="official">
          Official results ↗{entry.official.office ? <span className="who"> {entry.official.office}</span> : null}
        </a>
      ) : null}
    </p>
  );
}

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

  const [lastFips, setLastFips] = useState(null);
  const reporting = (data?.states || []).filter((s) => s.status === 'reporting').length;
  const otherLeading = tallyStates(data?.states).other;

  return (
    <>
      <Tally states={data?.states} />
      {data && (
        <p className="contest-line">
          {reporting} state{reporting === 1 ? '' : 's'} with {longLabel(race)} votes counted so far
          {otherLeading > 0 ? ` · ${otherLeading} led by a candidate outside the two major parties` : ''}.
        </p>
      )}
      <div className="map-panel">
        {data ? (
          <MapSvg
            label={`US map: ${longLabel(race)}, each state shaded by who is leading in votes counted so far`}
            features={stateFeatures}
            pathFn={path}
            entryFor={(f) => byFips[f.id]}
            onHover={(f) => setLastFips(f.id)}
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
      {data && (
        <SourceBar entry={lastFips ? byFips[lastFips] : null}
          name={lastFips ? stateFeatures.find((f) => f.id === lastFips)?.properties?.name : null} />
      )}
    </>
  );
}
