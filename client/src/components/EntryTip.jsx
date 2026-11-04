import React from 'react';
import { effectiveStatus, PARTY_COLOR } from '../shading.js';
import { partyShares, leadText, fmtMT, candidateList, hasCandidates, partyTag, coverageCopy, OFFICIAL_LINK_TEXT, districtLine, districtLabel, staleSourceText, otherRaceLine } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth, shortLabel, hostOf } from '../format.js';
import { photoCredits } from '../avatar.js';
import Avatar from './Avatar.jsx';

/** A ticket's running mate (e.g. a governor's lieutenant governor): after the name, smaller and muted. */
export function RunningMate({ name }) {
  if (!name) return null;
  return <span className="rm">with {name}</span>;
}

/**
 * U.S. House: one row per district, in district order — leading candidate (avatar, name, party tag) and margin, or
 * Toss-up / No votes yet. `cap` rows then "+ N more districts" linking to the state's All races tab, filtered to the House.
 */
export function DistrictRows({ districts, cap = Infinity, state, interactive = true }) {
  const list = districts || [];
  if (!list.length) return null;
  const shown = list.slice(0, cap);
  const more = list.length - shown.length;
  return (
    <div className="district-rows">
      {shown.map((d) => {
        const line = districtLine(d);
        const lead = line.status !== 'none' ? d.lead : null;
        return (
          <div className={`district-row st-${line.status}`} key={`${d.district}-${d.contest}`}>
            <span className="dn">{districtLabel(d.district)}</span>
            <span className="dl">
              {lead ? (
                <>
                  <Avatar name={lead.name} party={lead.party} photo={lead.photo} size={24} interactive={interactive} />
                  <span className="nm">{lead.name}<PartyTag tag={partyTag(lead)} party={lead.party} /><RunningMate name={lead.runningMate} /></span>
                </>
              ) : <span className="muted">—</span>}
            </span>
            <span className="dm">{line.text}</span>
          </div>
        );
      })}
      {more > 0 && (
        <a className="foot more-link" href={`?level=federal&office=house&state=${encodeURIComponent(state)}&tab=all&q=${encodeURIComponent('U.S. House')}`}>
          + {more} more district{more === 1 ? '' : 's'}
        </a>
      )}
    </div>
  );
}

/** Small party tag from the source's label (DEM / REP / LIB / IND / …); nothing for a nonpartisan candidate. */
export function PartyTag({ tag, party }) {
  if (!tag) return null;
  return <span className={`ptag ${party === 'DEM' ? 'dem' : party === 'REP' ? 'rep' : 'oth'}`}>{tag}</span>;
}

/**
 * Every candidate by name with party tag, votes and %, sorted by votes; write-ins on their own line.
 * `cap` limits the named rows (tooltips: 5) and adds "N more"; the state view shows them all.
 */
export function CandidateRows({ entry, cap = Infinity, bars = true, interactive = true }) {
  const { rows, writeIns, more } = candidateList(entry, cap);
  return (
    <>
      {rows.map((c, i) => (
        <div className="tip-row cand-row" key={`${c.name}-${i}`}>
          <Avatar name={c.name} party={c.party} photo={c.photo} interactive={interactive} />
          <div className="cand-body">
            <div className="line">
              <span className="who"><span className="nm">{c.name}<PartyTag tag={c.tag} party={c.party} /><RunningMate name={c.runningMate} /></span></span>
              <span className="val">{fmtVotes(c.votes)} · {fmtPct(c.pct)}</span>
            </div>
            {bars && <div className="bar thin"><div style={{ width: barWidth(c.pct), background: PARTY_COLOR[c.party] || PARTY_COLOR.OTHER }} /></div>}
          </div>
        </div>
      ))}
      {more > 0 && <span className="foot">+ {more} more candidate{more === 1 ? '' : 's'} in the state view</span>}
      {writeIns.map((w, i) => (
        <div className="tip-row cand-row wi" key={`wi-${w.name}-${i}`}>
          <Avatar name={w.name} party="OTHER" interactive={interactive} />
          <div className="cand-body">
            <div className="line">
              <span className="who"><span className="nm">{w.name}{w.named ? <span className="ptag oth">WRITE-IN</span> : null}</span></span>
              <span className="val">{fmtVotes(w.votes)} · {fmtPct(w.pct)}</span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * "Other races in this state" (Top race view): one line per other major contest, its leading candidate and margin, or
 * Toss-up. Each line is its own contest; nothing here is added to the contest that colors the map.
 */
export function OtherRaces({ races }) {
  if (!races?.length) return null;
  return (
    <div className="other-races">
      <span className="k">Other races in this state</span>
      {races.map((r, i) => {
        // Left (wraps): race + who leads, exactly as the source names them. Right (one line): the margin.
        const { label, who, margin } = otherRaceLine(r);
        return (
          <div className="or-line" key={`${r.office}-${i}`}>
            <span className="or-who"><span className="or-label">{label}</span>{who ? <span className="or-name">{who}</span> : null}</span>
            <span className="or-margin">{margin}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Top-N candidates of a multi-seat contest (vote for 2+): names and votes, never a two-way margin. */
export function SeatRows({ entry, cap, interactive = true }) {
  return <CandidateRows entry={entry} cap={cap ?? Math.max(5, (entry.seats || 2) + 1)} bars={false} interactive={interactive} />;
}

/** Map tooltips can't be hovered, so the credit + license of every photo shown is listed at the bottom. */
function PhotoCredits({ entry, cap }) {
  const shown = new Set(candidateList(entry, cap).rows.map((c) => c.name));
  const lines = photoCredits((entry?.candidates || []).filter((c) => shown.has(c.name)));
  if (!lines.length) return null;
  return <span className="foot src">{lines.join(' · ')}</span>;
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
      {kind === 'state' && entry?.topLabel && (
        <span className="tip-contest">{entry.topLabel}{entry.partySum && entry.contests?.length > 1 ? ` (${entry.contests.length} districts)` : ''}</span>
      )}
      {status === 'reporting' && entry.multiSeat && (
        <>
          <SeatRows entry={entry} interactive={false} />
          <span className="foot">{leadText(entry)}</span>
          <PhotoCredits entry={entry} cap={Math.max(5, (entry.seats || 2) + 1)} />
        </>
      )}
      {status === 'reporting' && !entry.multiSeat && (
        <>
          {hasCandidates(entry) ? <CandidateRows entry={entry} cap={5} interactive={false} /> : <PartyRows entry={entry} />}
          <span className="foot">{leadText(entry)}</span>
          {kind === 'state' && entry.partySum && entry.districts?.length > 0 && (
            <DistrictRows districts={entry.districts} cap={8} state={entry.state} interactive={false} />
          )}
          {hasCandidates(entry) && <PhotoCredits entry={entry} cap={5} />}
          {entry.otherContests?.length > 0 && !entry.otherRaces && (
            <span className="foot">
              Also on the ballot: {entry.otherContests.map((c) => c.name).join('; ')}. Shown separately in the state view.
            </span>
          )}
        </>
      )}
      {status === 'awaiting' && (
        <span className="foot">No votes counted yet{sourceName || entry?.sourceName ? ` · source: ${sourceName || entry.sourceName}` : ''}.</span>
      )}
      {status === 'awaiting' && kind === 'state' && entry?.partySum && entry.districts?.length > 0 && (
        <DistrictRows districts={entry.districts} cap={8} state={entry.state} interactive={false} />
      )}
      {status === 'no-source' && (entry?.coverageStatus === 'live' && entry?.sourceNote
        ? <span className="foot">{entry.sourceNote}</span>
        : (
          <div className="no-live">
            <span className="t">{coverageCopy(entry?.coverageStatus).title}</span>
            <span className="foot">{coverageCopy(entry?.coverageStatus).detail}</span>
          </div>
        ))}
      {status === 'no-source' && (entry?.official?.url
        // A real link: clickable in the phone bottom sheet (the desktop tooltip follows the pointer; the bar under the map links too).
        ? <a className="official-link" href={entry.official.url} target="_blank" rel="noopener noreferrer">{OFFICIAL_LINK_TEXT} <span className="host">{hostOf(entry.official.url)}</span></a>
        : <span className="foot">Official results page not on file yet.</span>)}
      {kind === 'state' && entry?.sourceName && (status === 'reporting' || status === 'awaiting') && (
        <span className="foot src">Source: {entry.sourceName}{staleSourceText(entry) ? ` · ${staleSourceText(entry)}` : fmtMT(entry.sourceUpdatedAt || entry.fetchedAt) ? ` · updated ${fmtMT(entry.sourceUpdatedAt || entry.fetchedAt)}` : ''}</span>
      )}
      {status === 'no-race' && <span className="foot">No {shortLabel(race)} race on the ballot here this year.</span>}
      {status === 'no-data' && <span className="foot">No results from this source for this county.</span>}
      {kind === 'state' && entry?.otherRaces?.length > 0 && <OtherRaces races={entry.otherRaces} />}
      {kind === 'state' && entry?.official && status !== 'no-source' && (
        <span className="foot src">Official results ↗ {hostOf(entry.official.url)}</span>
      )}
    </>
  );
}
