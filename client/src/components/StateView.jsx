import React, { useEffect, useMemo, useState } from 'react';
import MapSvg from './MapSvg.jsx';
import EntryTip from './EntryTip.jsx';
import Details from './Details.jsx';
import { loadCounties, fitPath, ABBR_TO_FIPS } from '../geo.js';
import { effectiveStatus } from '../shading.js';
import { partyShares, leadText, candidateList, hasCandidates } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, shortLabel, longLabel, hostOf, reportingText } from '../format.js';
import { fmtMT, coverageCopy, OFFICIAL_LINK_TEXT, staleSourceText } from '../calc.js';
import AllRaces from './AllRaces.jsx';
import { SeatRows, PartyTag, RunningMate, DistrictRows } from './EntryTip.jsx';
import Avatar from './Avatar.jsx';
import PhotoCredits from './PhotoCredits.jsx';

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
      ? `No ${shortLabel(race)} race on the ballot in ${stateName} this year`
      : entry.coverageStatus === 'live' && entry.sourceNote
        ? entry.sourceNote
        : `${coverageCopy(entry.coverageStatus).title} ${coverageCopy(entry.coverageStatus).detail}`;
    return (
      <div className="grid grid-4 stat-cards">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <span className="k">{longLabel(race)}</span>
          <span className="big na">{msg}</span>
        </div>
      </div>
    );
  }
  const pct = entry.pctReporting;
  if (entry.multiSeat) {
    return (
      <div className="grid grid-4 stat-cards">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <span className="k">{longLabel(race)} · vote for {entry.seats}</span>
          <span className="small">Several candidates win this contest, so there is no two-way margin. Most votes counted so far
            {reportingText(entry, 'reporting') ? ` · ${reportingText(entry, 'reporting')}` : ''}:</span>
          <div className="seat-rows"><SeatRows entry={entry} /></div>
        </div>
      </div>
    );
  }
  // A source that publishes counties complete instead of a % (Clarity statewide sites) gets that, never a derived %.
  const counties = pct == null && entry.countiesTotal > 0;
  const reportingCard = card('', counties ? (entry.countiesLabel === 'reported' ? 'Counties reported' : entry.countiesLabel === 'precincts reported' ? 'Precincts reported' : 'Counties complete') : 'Reporting',
    pct != null ? fmtReporting(pct) : counties ? `${fmtVotes(entry.countiesComplete ?? 0)} of ${fmtVotes(entry.countiesTotal)}` : '—',
    status === 'reporting' ? leadText(entry) : pct == null ? 'Not published by this source' : 'No votes counted yet');
  if (hasCandidates(entry)) {
    // The top three candidates by name (every candidate is listed in Details below), then reporting.
    const { rows } = candidateList(entry, 3);
    const cls = (p) => (p === 'DEM' ? 'dem' : p === 'REP' ? 'rep' : 'oth');
    return (
      <div className="grid grid-4 stat-cards">
        {rows.map((c, i) => (
          <div className="card cand-card" key={`${c.name}-${i}`}>
            <span className="cand-head">
              <Avatar name={c.name} party={c.party} photo={c.photo} size={40} />
              <span className={`k cand ${cls(c.party)}`}>{c.name}<PartyTag tag={c.tag} party={c.party} /><RunningMate name={c.runningMate} /></span>
            </span>
            <span className="big">{fmtVotes(c.votes)}</span>
            <span className="small">{fmtPct(c.pct)}</span>
          </div>
        ))}
        {reportingCard}
      </div>
    );
  }
  // U.S. House: the statewide popular vote is a sum by party across districts (each district's candidates are in All races).
  return (
    <div className="grid grid-4 stat-cards">
      {card('dem', 'Democratic', fmtVotes(entry.parties?.DEM), fmtPct(sh.DEM))}
      {card('rep', 'Republican', fmtVotes(entry.parties?.REP), fmtPct(sh.REP))}
      {card('oth', 'Other', fmtVotes(entry.parties?.OTHER), fmtPct(sh.OTHER))}
      {reportingCard}
    </div>
  );
}

function SourceLine({ entry }) {
  const name = entry?.sourceName || entry?.source;
  if (!name) return null;
  const url = entry?.sourceUrl;
  const updated = fmtMT(entry?.sourceUpdatedAt || entry?.fetchedAt);
  const stale = staleSourceText(entry);
  return (
    <span className="s">
      Source: {url ? <a href={url} target="_blank" rel="noopener noreferrer">{name}{entry?.sourceName ? '' : ` (${hostOf(url)})`}</a> : name}
      {stale ? <> · <strong className="stale">{stale}</strong></> : updated ? ` · updated ${updated}` : ''}
    </span>
  );
}

/** Every number one click from its government source: the state's official results page, always shown. */
export function SourceStrip({ entry, official, name }) {
  const covered = entry && (entry.status === 'reporting' || entry.status === 'awaiting');
  return (
    <p className="source-bar">
      {covered && entry.sourceName ? <SourceLine entry={entry} />
        : <span>{entry?.sourceNote || (entry?.status === 'no-race' ? 'No race for this office in our sources' : coverageCopy(entry?.coverageStatus).title)}</span>}
      {official?.url
        ? <a className="official" href={official.url} target="_blank" rel="noopener noreferrer">{covered ? 'Official results ↗' : OFFICIAL_LINK_TEXT}{official.office ? <span className="who"> {official.office}</span> : null}</a>
        : <span className="muted">Official results page not on file yet</span>}
    </p>
  );
}

export default function StateView({ abbr, race, tab = 'overview', data, error, contests, contestsError, onOpenMeasure, query = '' }) {
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
            pickLabel={(f) => (pinned === f.id ? "Back to statewide" : "Show county details")}
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
        <span className="t">No {shortLabel(race)} race in {name} this year</span>
        <span className="d">{data.countyNote || `There is no ${longLabel(race)} contest on ${name}'s ballot in our sources.`}</span>
      </div>
    );
  } else if (status === 'no-source') {
    panel = (
      <div className="empty">
        <MapIcon />
        {data.statewide?.coverageStatus === 'live' && data.statewide?.sourceNote ? (
          <span className="d">{data.statewide.sourceNote}</span>
        ) : (
          <>
            <span className="t">{coverageCopy(data.statewide?.coverageStatus).title}</span>
            <span className="d">{coverageCopy(data.statewide?.coverageStatus).detail}</span>
          </>
        )}
        {(data.official?.url || data.statewide?.official?.url) && (
          <a className="btn official-btn" href={data.official?.url || data.statewide.official.url} target="_blank" rel="noopener noreferrer">{OFFICIAL_LINK_TEXT}</a>
        )}
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

  const official = data?.official || sw?.official || contests?.official || null;
  if (tab === 'all') {
    return (
      <>
        <SourceStrip entry={sw} official={official} name={contests?.name || name} />
        <AllRaces data={contests} error={contestsError} stateName={contests?.name || name} onOpenMeasure={onOpenMeasure} initialQuery={query} />
        <PhotoCredits candidates={(contests?.groups || []).flatMap((g) => g.contests.flatMap((c) => c.candidates || []))} />
      </>
    );
  }

  return (
    <>
      <SourceStrip entry={sw} official={official} name={name} />
      <TotalsStrip entry={sw} race={race} stateName={name} />
      {sw?.contests?.length > 0 && (
        <p className="contest-line">
          {sw.partySum ? `${sw.contests.length} district contest${sw.contests.length === 1 ? '' : 's'}, summed into the statewide House popular vote` : <b>{sw.contests.join('; ')}</b>}
        </p>
      )}
      {sw?.partySum && sw.districts?.length > 0 && (
        <section className="card districts-card" aria-label="U.S. House districts">
          <div className="methods-head">
            <span className="k">Districts · U.S. House</span>
            <span className="note">Each district is its own contest: who has the most votes counted so far</span>
          </div>
          <DistrictRows districts={sw.districts} state={sw.state} />
        </section>
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
      <PhotoCredits candidates={[
        ...(sw?.candidates || []),
        ...(sw?.otherContests || []).flatMap((c) => c.candidates || []),
        ...(sw?.districts || []).map((d) => d.lead).filter(Boolean),
      ]} />
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
