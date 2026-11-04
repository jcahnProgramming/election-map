import React from 'react';
import { effectiveStatus, PARTY_COLOR } from '../shading.js';
import { partyShares, leadText, fmtMT, candidateList, hasCandidates } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth, shortLabel, hostOf } from '../format.js';

/** Small party tag from the source's label (DEM / REP / LIB / IND / …); nothing for a nonpartisan candidate. */
export function PartyTag({ tag, party }) {
  if (!tag) return null;
  return <span className={`ptag ${party === 'DEM' ? 'dem' : party === 'REP' ? 'rep' : 'oth'}`}>{tag}</span>;
}

/**
 * Every candidate by name with party tag, votes and %, sorted by votes; write-ins on their own line.
 * `cap` limits the named rows (tooltips: 5) and adds "N more"; the state view shows them all.
 */
export function CandidateRows({ entry, cap = Infinity, bars = true }) {
  const { rows, writeIns, more } = candidateList(entry, cap);
  return (
    <>
      {rows.map((c, i) => (
        <div className="tip-row" key={`${c.name}-${i}`}>
          <div className="line">
            <span className="who"><span className="sw8" style={{ background: PARTY_COLOR[c.party] || PARTY_COLOR.OTHER }} />{c.name}<PartyTag tag={c.tag} party={c.party} /></span>
            <span className="val">{fmtVotes(c.votes)} · {fmtPct(c.pct)}</span>
          </div>
          {bars && <div className="bar thin"><div style={{ width: barWidth(c.pct), background: PARTY_COLOR[c.party] || PARTY_COLOR.OTHER }} /></div>}
        </div>
      ))}
      {more > 0 && <span className="foot">+ {more} more candidate{more === 1 ? '' : 's'} in the state view</span>}
      {writeIns.map((w, i) => (
        <div className="tip-row wi" key={`wi-${w.name}-${i}`}>
          <div className="line">
            <span className="who">{w.name}{w.named ? <span className="ptag oth">WRITE-IN</span> : null}</span>
            <span className="val">{fmtVotes(w.votes)} · {fmtPct(w.pct)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

/** Top-N candidates of a multi-seat contest (vote for 2+): names and votes, never a two-way margin. */
export function SeatRows({ entry, cap }) {
  return <CandidateRows entry={entry} cap={cap ?? Math.max(5, (entry.seats || 2) + 1)} bars={false} />;
}

const ROWS = [
  ['DEM', 'Democratic'],
  ['REP', 'Republican'],
  ['OTHER', 'Other'],
];

/** D / R / Other rows with bars, for a result entry that has votes. */
export function PartyRows({ entry }) {
  const sh = partyShares(entry);
  return ROWS.map(([p, label]) => (
    <div className="tip-row" key={p}>
      <div className="line">
        <span className="who"><span className="sw8" style={{ background: PARTY_COLOR[p] }} />{label}</span>
        <span className="val">{fmtVotes(entry.parties?.[p])} · {fmtPct(sh[p])}</span>
      </div>
      <div className="bar thin"><div style={{ width: barWidth(sh[p]), background: PARTY_COLOR[p] }} /></div>
    </div>
  ));
}

/**
 * Tooltip body for a state or a county.
 * kind: 'state' | 'county'. For counties, `entry` undefined = the source has no row for it.
 */
export default function EntryTip({ title, entry, race, kind = 'state', sourceName }) {
  const status = kind === 'county' && !entry ? 'no-data' : effectiveStatus(entry);
  const pct = entry?.pctReporting;
  const reporting = status === 'reporting' || status === 'awaiting'
    ? (pct != null ? `${fmtReporting(pct)} in` : '% in not published')
    : '';
  return (
    <>
      <div className="tip-head">
        <span className="t">{title}</span>
        {reporting && <span className="r">{reporting}</span>}
      </div>
      {status === 'reporting' && entry.multiSeat && (
        <>
          <SeatRows entry={entry} />
          <span className="foot">{leadText(entry)}</span>
        </>
      )}
      {status === 'reporting' && !entry.multiSeat && (
        <>
          {hasCandidates(entry) ? <CandidateRows entry={entry} cap={5} /> : <PartyRows entry={entry} />}
          <span className="foot">{leadText(entry)}</span>
          {entry.otherContests?.length > 0 && (
            <span className="foot">
              Also on the ballot: {entry.otherContests.map((c) => c.name).join('; ')}. Shown separately in the state view.
            </span>
          )}
        </>
      )}
      {status === 'awaiting' && (
        <span className="foot">No votes counted yet{sourceName || entry?.sourceName ? ` · source: ${sourceName || entry.sourceName}` : ''}.</span>
      )}
      {status === 'no-source' && (
        <span className="foot">{entry?.sourceNote || 'No data source yet — view official results ↗'}</span>
      )}
      {kind === 'state' && entry?.sourceName && (status === 'reporting' || status === 'awaiting') && (
        <span className="foot src">Source: {entry.sourceName}{fmtMT(entry.sourceUpdatedAt || entry.fetchedAt) ? ` · updated ${fmtMT(entry.sourceUpdatedAt || entry.fetchedAt)}` : ''}</span>
      )}
      {status === 'no-race' && <span className="foot">No {shortLabel(race)} race on the ballot here this year.</span>}
      {status === 'no-data' && <span className="foot">No results from this source for this county.</span>}
      {kind === 'state' && entry?.official && status !== 'no-source' && (
        <span className="foot src">Official results ↗ {hostOf(entry.official.url)}</span>
      )}
    </>
  );
}
