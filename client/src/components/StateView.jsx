import React, { useEffect, useMemo, useState } from 'react';
import MapSvg from './MapSvg.jsx';
import { ResultSummary, CandidatesTable } from './ResultSummary.jsx';
import { loadCounties, viewBoxFor, stateFeatures, ABBR_TO_FIPS } from '../geo.js';
import { fmtVotes, fmtPct, fmtMargin, fmtTime, STATUS_TEXT, RACE_LABEL } from '../format.js';

const DEFAULT_COUNTY_NOTE = {
  unavailable: "County results aren't available from this state's source; showing statewide totals.",
  'no-source': "We don't have a data source for this state yet.",
};

export default function StateView({ abbr, race, data, onBack }) {
  const [geo, setGeo] = useState(null);
  const [geoError, setGeoError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadCounties()
      .then((g) => alive && setGeo(g))
      .catch(() => alive && setGeoError('Could not load county map shapes.'));
    return () => {
      alive = false;
    };
  }, []);

  const fips = data?.fips || ABBR_TO_FIPS[abbr];
  const stateFeature = useMemo(() => (geo?.states || stateFeatures).find((f) => f.id === fips), [geo, fips]);
  const counties = useMemo(
    () => (geo ? geo.counties.filter((f) => String(f.id).startsWith(fips)) : []),
    [geo, fips]
  );
  const byFips = useMemo(() => {
    const m = {};
    for (const c of data?.counties || []) m[c.fips] = c;
    return m;
  }, [data]);

  const sw = data?.statewide || null;
  const status = sw?.status || data?.status;
  // 'partial': only some counties publish (county-run sites, no statewide feed). countyNote says so.
  const showCounties = data?.countyData === 'available' || data?.countyData === 'partial';
  const statewideEntry = sw || (data ? { status: data.status } : null);
  const missing = showCounties ? counties.filter((f) => !byFips[f.id]).length : 0;

  return (
    <div>
      <button onClick={onBack}>‹ Back to national map</button>
      <h2>
        {data?.name || abbr} — {RACE_LABEL[data?.race || race] || race}
      </h2>

      {data && !showCounties && (
        <div className="notice">{data.countyNote || DEFAULT_COUNTY_NOTE[data.countyData] || DEFAULT_COUNTY_NOTE.unavailable}</div>
      )}
      {data && showCounties && data.countyNote && <div className="notice">{data.countyNote}</div>}
      {geoError && <div className="error">{geoError}</div>}
      {!stateFeature && <div>No map shape for {abbr}.</div>}

      {stateFeature && (
        <MapSvg
          label={`Map of ${data?.name || abbr}${showCounties ? ' by county' : ''}`}
          viewBox={viewBoxFor(stateFeature)}
          features={showCounties ? counties : [stateFeature]}
          outline={stateFeature}
          entryFor={(f) => (showCounties ? byFips[f.id] : statewideEntry)}
          renderTooltip={(f, e) => (
            <ResultSummary
              name={showCounties ? e?.name || f.properties?.name : data?.name || abbr}
              entry={e}
              showSource={!showCounties}
            />
          )}
        />
      )}
      {showCounties && geo && missing > 0 && (
        <div style={{ fontSize: 12 }}>
          {missing} of {counties.length} counties have no entry in the data (shown grey).
        </div>
      )}

      <h3>Statewide totals</h3>
      {!sw ? (
        <div>{STATUS_TEXT[status] || 'No statewide data.'}</div>
      ) : (
        <div>
          {sw.contests?.length > 0 && <div>Contest: {sw.contests.join('; ')}</div>}
          {status !== 'reporting' && <div>{STATUS_TEXT[status] || status}</div>}
          {sw.candidates?.length > 0 && <CandidatesTable candidates={sw.candidates} totalVotes={sw.totalVotes} />}
          <div>Total votes: {fmtVotes(sw.totalVotes)}</div>
          <div>Reporting: {fmtPct(sw.pctReporting, 0)}</div>
          <div>Leading: {status === 'reporting' ? fmtMargin(sw.leader, sw.marginPts) : '—'}</div>
          <div>
            Source: {sw.source || '—'}
            {sw.fetchedAt ? `, fetched ${fmtTime(sw.fetchedAt)}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}
