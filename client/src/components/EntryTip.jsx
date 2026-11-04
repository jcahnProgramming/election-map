import React from 'react';
import { effectiveStatus, PARTY_COLOR } from '../shading.js';
import { partyShares, leadText } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth, RACE_SHORT } from '../format.js';

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
      {status === 'reporting' && (
        <>
          <PartyRows entry={entry} />
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
        <span className="foot">This state has a {RACE_SHORT[race]} race, but we don't have a results source for it yet.</span>
      )}
      {status === 'no-race' && <span className="foot">No {RACE_SHORT[race]} race on the ballot here this year.</span>}
      {status === 'no-data' && <span className="foot">No results from this source for this county.</span>}
    </>
  );
}
