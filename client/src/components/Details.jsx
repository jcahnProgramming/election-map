import React from 'react';
import { turnoutPct, precinctPct, methodShares, hasCandidates } from '../calc.js';
import { CandidateRows } from './EntryTip.jsx';
import { fmtVotes, fmtPct, barWidth, shortLabel } from '../format.js';
import { PARTY_COLOR, PARTY_TEXT } from '../shading.js';

const has = (n) => n != null && Number.isFinite(Number(n));

function NA({ title = 'Not available', hint = 'Not available from this source' }) {
  return (
    <>
      <span className="big na">{title}</span>
      <span className="hint">{hint}</span>
    </>
  );
}

/**
 * Turnout / precincts / ballots left / vote-method cards for the statewide entry or a pinned county.
 * entry: statewide entry (with turnout, methods) or a county entry; null = nothing known.
 */
export default function Details({ race, scope, entry, county, countyMissing, raceStatus, showHint, onUnpin }) {
  const t = entry?.turnout || null;
  const tp = turnoutPct(t);
  const precR = has(t?.precinctsReporting) ? t.precinctsReporting : entry?.precinctsReporting;
  const precT = has(t?.precinctsTotal) ? t.precinctsTotal : entry?.precinctsTotal;
  const pp = precinctPct(precR, precT);
  const left = t?.ballotsOutstanding;
  const methods = methodShares(entry?.methods);
  const noRace = raceStatus === 'no-race';

  return (
    <section className="details" aria-label="Details">
      <div className="details-head">
        <h2>Details · {scope}</h2>
        {county && <button type="button" className="link-btn sm" onClick={onUnpin}>← Back to statewide</button>}
        {showHint && <span className="hint">Click a county to see its details</span>}
      </div>
      {countyMissing && <div className="banner note">This source publishes no results for this county.</div>}
      {hasCandidates(entry) && (
        <div className="card cands">
          <div className="methods-head">
            <span className="k">Candidates · {shortLabel(race)}{entry.multiSeat ? ` · vote for ${entry.seats}` : ''}</span>
            <span className="note">Every candidate the source lists, by votes counted so far</span>
          </div>
          <CandidateRows entry={entry} />
        </div>
      )}
      <div className="grid grid-3">
        <div className="card">
          <span className="k">Turnout so far</span>
          {tp != null || has(t?.ballotsCast) ? (
            <>
              <span className="big">{tp != null ? fmtPct(tp) : fmtVotes(t.ballotsCast)}</span>
              <span className="small">
                {tp != null
                  ? `${fmtVotes(t?.ballotsCast)} counted / ${fmtVotes(t?.registered)} registered`
                  : 'ballots cast · registered voters not published'}
              </span>
            </>
          ) : (
            <NA />
          )}
        </div>
        <div className="card">
          <span className="k">Precincts reporting</span>
          {pp != null ? (
            <>
              <span className="big">{fmtVotes(precR)} / {fmtVotes(precT)}</span>
              <div className="bar" role="img" aria-label={`${fmtPct(pp)} of precincts reporting`}>
                <div style={{ width: barWidth(pp) }} />
              </div>
            </>
          ) : (
            <NA />
          )}
        </div>
        <div className="card">
          <span className="k">Ballots left to count</span>
          {has(left) ? (
            <>
              <span className="big">~{fmtVotes(left)}</span>
              <span className="hint">Estimate published by the election office</span>
            </>
          ) : (
            <NA title="Not published" hint="This source doesn't report outstanding ballots" />
          )}
        </div>
      </div>
      <div className="card methods">
        <div className="methods-head">
          <span className="k">Vote method · {shortLabel(race)}</span>
          <span className="note">Method names come from each source</span>
        </div>
        {noRace && !county ? (
          <span className="na-text">No {shortLabel(race)} race on the ballot here this year.</span>
        ) : methods.length ? (
          methods.map((m) => (
            <div className="method" key={m.label}>
              <div className="lbl">
                <b>{m.label}</b>
                <span>{fmtVotes(m.total)} votes · {m.share != null ? fmtPct(m.share, 0) : '—'} of counted</span>
              </div>
              <div className="split" role="img" aria-label={`${m.label}: Democratic ${fmtPct(m.dPct)}, Republican ${fmtPct(m.rPct)}`}>
                <div style={{ width: barWidth(m.dPct), background: PARTY_COLOR.DEM }} />
                <div style={{ width: barWidth(m.oPct), background: '#6B7686' }} />
                <div style={{ width: barWidth(m.rPct), background: PARTY_COLOR.REP }} />
              </div>
              <div className="dr">
                <span style={{ color: PARTY_TEXT.DEM }}>D {fmtPct(m.dPct)}</span>
                <span style={{ color: PARTY_TEXT.REP }}>R {fmtPct(m.rPct)}</span>
              </div>
            </div>
          ))
        ) : (
          <span className="na-text">Not available from this source: it doesn't split this race by vote method.</span>
        )}
      </div>
    </section>
  );
}
