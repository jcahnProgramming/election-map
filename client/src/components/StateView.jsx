import React, { useEffect, useMemo, useState } from 'react';
import MapSvg from './MapSvg.jsx';
import EntryTip from './EntryTip.jsx';
import Details from './Details.jsx';
import { loadCounties, fitPath, ABBR_TO_FIPS } from '../geo.js';
import { effectiveStatus } from '../shading.js';
import { partyShares, leadText } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, RACE_SHORT, RACE_LONG, hostOf } from '../format.js';

/** Statewide strip: Dem / Rep / Other / Reporting (or an honest status in place of numbers). */
export function TotalsStrip({ entry, race, stateName, compact = false }) {
  const status = effectiveStatus(entry);
  const sh = partyShares(entry);
  const hasNums = status === 'reporting' || status === 'awaiting';
  const card = (cls, label, big, small) => (
    <div className="card" key={label}>
      <span className={`k ${cls}`}>{label}</span>
      <span className="big">{big}</span>
      <span className="small">{small}</span>
    </div>
  );
  if (!entry) {
    return (
      <div className="grid grid-4 stat-cards">
        {['Democratic', 'Republican', 'Other', 'Reporting'].map((l) => card('', l, '—', ' '))}
      </div>
    );
  }
  if (!hasNums) {
    const msg = status === 'no-race'
      ? `No ${RACE_SHORT[race]} race on the ballot in ${stateName} this year`
      : `${stateName} has a ${RACE_SHORT[race]} race, but we don't have a results source for it yet`;
    return (
      <div className="grid grid-4 stat-cards">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <span className="k">{RACE_LONG[race]}</span>
          <span className="big na">{msg}</span>
        </div>
      </div>
    );
  }
  const pct = entry.pctReporting;
  return (
    <div className="grid grid-4 stat-cards">
      {card('dem', 'Democratic', fmtVotes(entry.parties?.DEM), fmtPct(sh.DEM))}
      {card('rep', 'Republican', fmtVotes(entry.parties?.REP), fmtPct(sh.REP))}
      {card('oth', 'Other', fmtVotes(entry.parties?.OTHER), fmtPct(sh.OTHER))}
      {card('', compact ? 'Reporting' : 'Reporting',
        pct != null ? fmtReporting(pct) : '—',
        status === 'reporting' ? leadText(entry) : pct == null ? 'Not published by this source' : 'No votes counted yet')}
    </div>
  );
}

function SourceLine({ entry }) {
  const name = entry?.sourceName || entry?.source;
  if (!name) return null;
  const url = entry?.sourceUrl;
  return (
    <span className="s">
      Source: {url ? <a href={url} target="_blank" rel="noopener noreferrer">{name}{entry?.sourceName ? '' : ` (${hostOf(url)})`}</a> : name}
    </span>
  );
}

export default function StateView({ abbr, race, data, error }) {
  const [geo, setGeo] = useState(null);
  const [geoError, setGeoError] = useState(null);
  const [pinned, setPinned] = useState(null); // county FIPS

  useEffect(() => setPinned(null), [abbr]);

  const showCounties = data?.countyData === 'available' || data?.countyData === 'partial';

  useEffect(() => {
    if (!showCounties || geo) return;
    let alive = true;
    loadCounties()
      .then((g) => alive && setGeo(g))
      .catch(() => alive && setGeoError('Could not load the county map shapes.'));
    return () => { alive = false; };
  }, [showCounties, geo]);

  const fips = data?.fips || ABBR_TO_FIPS[abbr];
  const counties = useMemo(
    () => (geo ? geo.counties.filter((f) => String(f.id).slice(0, 2) === fips) : []),
    [geo, fips]
  );
  const pathFn = useMemo(() => (counties.length ? fitPath(counties) : null), [counties]);
  const byFips = useMemo(() => {
    const m = {};
    for (const c of data?.counties || []) m[c.fips] = c;
    return m;
  }, [data]);

  const sw = data?.statewide || null;
  const name = data?.name || abbr;
  const status = data?.status || sw?.status;
  const pinnedCounty = pinned ? byFips[pinned] || { fips: pinned, name: counties.find((f) => f.id === pinned)?.properties?.name, missing: true } : null;
  const countyLabel = (c) => (c?.name ? (/county|parish|borough|city|census area|municipality/i.test(c.name) ? c.name : `${c.name} County`) : 'County');

  let panel;
  if (!data) {
    panel = (
      <div className="map-box"><div className="map-msg">{error ? 'Unavailable until the results server answers.' : 'Loading…'}</div></div>
    );
  } else if (showCounties) {
    panel = (
      <>
        {data.countyNote && <p className="map-note">{data.countyNote}</p>}
        {pathFn ? (
          <MapSvg
            label={`${name} counties shaded by who is leading in votes counted so far`}
            features={counties}
            pathFn={pathFn}
            strokeWidth={1}
            entryFor={(f) => byFips[f.id]}
            selectedId={pinned}
            onPick={(f) => setPinned((p) => (p === f.id ? null : f.id))}
            renderTip={(f, e) => (
              <EntryTip kind="county" title={countyLabel(e || { name: f.properties?.name })} entry={e} race={race} sourceName={sw?.sourceName} />
            )}
          />
        ) : (
          <div className="map-box"><div className="map-msg">{geoError || 'Loading county map…'}</div></div>
        )}
      </>
    );
  } else if (status === 'no-race') {
    panel = (
      <div className="empty">
        <MapIcon />
        <span className="t">No {RACE_SHORT[race]} race in {name} this year</span>
        <span className="d">{data.countyNote || `There is no ${RACE_LONG[race]} contest on ${name}'s ballot in our sources.`}</span>
      </div>
    );
  } else if (status === 'no-source') {
    panel = (
      <div className="empty">
        <MapIcon />
        <span className="t">No results source for {name} yet</span>
        <span className="d">
          {data.countyNote || `${name} has a ${RACE_SHORT[race]} race, but we don't read its official results yet. It's on our list.`}
        </span>
      </div>
    );
  } else {
    panel = (
      <div className="empty">
        <MapIcon />
        <span className="t">No county breakdown for {name} yet</span>
        <span className="d">
          {data.countyNote || "This state's source only publishes statewide totals so far."} The numbers above are the full statewide count.
        </span>
        <SourceLine entry={sw} />
      </div>
    );
  }

  return (
    <>
      <TotalsStrip entry={sw} race={race} stateName={name} />
      {sw?.contests?.length > 0 && (
        <p className="contest-line">
          {race === 'house' ? `${sw.contests.length} district contest${sw.contests.length === 1 ? '' : 's'}, summed into the statewide House popular vote` : <b>{sw.contests.join('; ')}</b>}
          {showCounties && sw?.sourceName ? <> · <SourceLine entry={sw} /></> : null}
        </p>
      )}
      <div className="map-panel">{panel}</div>

      {sw?.otherContests?.length > 0 && sw.otherContests.map((c) => (
        <section className="other-contest" key={c.name} aria-label={c.name}>
          <h3>Also on the ballot: {c.name}</h3>
          <p className="contest-line">A separate contest. Its votes are never added to the race above.</p>
          <TotalsStrip entry={{ ...c, status: c.totalVotes > 0 ? 'reporting' : 'awaiting' }} race={race} stateName={name} />
        </section>
      ))}

      {data && (
        <Details
          race={race}
          scope={pinnedCounty ? countyLabel(pinnedCounty) : name}
          entry={pinnedCounty ? (pinnedCounty.missing ? null : pinnedCounty) : sw}
          county={!!pinnedCounty}
          countyMissing={!!pinnedCounty?.missing}
          raceStatus={status}
          showHint={showCounties && !pinnedCounty && !!pathFn}
          onUnpin={() => setPinned(null)}
        />
      )}
    </>
  );
}

function MapIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#6B7686" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
      <path d="M9 3v15" />
      <path d="M15 6v15" />
    </svg>
  );
}
