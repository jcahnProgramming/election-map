import React, { useMemo } from 'react';
import { chamberTotals, hemicycle, closestSeats, seatStatus, partyTag } from '../calc.js';
import { fmtReporting, reportingText } from '../format.js';
import { fmtMargin } from '../shading.js';
import Avatar from './Avatar.jsx';
import { RunningMate } from './EntryTip.jsx';

// Seat chart geometry per chamber (from the design): arcs, inner / outer radius, dot radius.
const CHART = { senate: { rows: 5, r0: 105, r1: 205, dot: 8.5 }, house: { rows: 11, r0: 70, r1: 208, dot: 4.1 } };

const CHIP = {
  dLead: ['#16264A', '#93B4FA', 'DEM'], rLead: ['#3A1818', '#F7A1A1', 'REP'], oLead: ['#12301F', '#8FE3B0', null],
  toss: ['#2B2346', '#C4B5FD', 'TOSS-UP'], none: ['#1B212B', '#9AA4B2', 'NO VOTES YET'],
};

function Chamber({ id, title, ch, note }) {
  const t = useMemo(() => chamberTotals(ch), [ch]);
  const g = CHART[id];
  const pts = useMemo(() => hemicycle(ch.seats, g.rows, g.r0, g.r1), [ch.seats, g]);
  const dots = [];
  let i = 0;
  for (const seg of t.segments) for (let k = 0; k < seg.n && i < pts.length; k++, i++) dots.push({ ...pts[i], fill: seg.color, stroke: seg.stroke || seg.color });
  const label = `${title}: Democrats ${t.dem}, undecided ${t.undecided}${t.other ? `, other parties ${t.other}` : ''}, Republicans ${t.rep}`;
  return (
    <section className="chamber" aria-labelledby={`ch-${id}`}>
      <div className="chamber-head">
        <h3 id={`ch-${id}`}>{title}</h3>
        <span>{ch.seats} seats · {ch.majority} for majority</span>
      </div>
      <div className="chamber-cards">
        <div className="ccard"><span className="k dem">Democrats</span><span className="big">{t.dem}</span><span className="small">{t.demDetail}</span></div>
        <div className="ccard"><span className="k">Undecided</span><span className="big">{t.undecided}</span><span className="small">{t.undecidedDetail}</span></div>
        <div className="ccard"><span className="k rep">Republicans</span><span className="big">{t.rep}</span><span className="small">{t.repDetail}</span></div>
      </div>
      <div className="seat-bar" role="img" aria-label={label}>
        {t.segments.map((s) => <div key={s.key} style={{ width: `${((100 * s.n) / ch.seats).toFixed(2)}%`, background: s.color }} />)}
        <div className="majority-line" aria-hidden="true" />
      </div>
      <svg className="hemicycle" viewBox="0 0 460 250" role="img" aria-label={`${title} seat chart, ${ch.seats} seats. ${label}.`}>
        {dots.map((d, k) => <circle key={k} cx={d.x} cy={d.y} r={g.dot} fill={d.fill} stroke={d.stroke} strokeWidth="1" />)}
        <line x1="230" y1="18" x2="230" y2="44" stroke="#E6EDF3" strokeWidth="2" />
        <text x="230" y="12" textAnchor="middle" fill="#9AA4B2" fontSize="11">{ch.majority} for majority</text>
        <text x="230" y="238" textAnchor="middle" fill="#E6EDF3" fontSize="26" fontWeight="700" fontFamily="IBM Plex Mono, monospace">{t.dem}–{t.rep}</text>
      </svg>
      <ul className="seat-legend">
        {t.segments.map((s) => (
          <li key={s.key}><span className="dot" style={{ background: s.color, borderColor: s.stroke || s.color }} />{s.label} <b>{s.n}</b></li>
        ))}
      </ul>
      <p className="chamber-note">{note}</p>
    </section>
  );
}

export function Closest({ up, onOpen }) {
  const list = closestSeats(up);
  return (
    <section className="closest" aria-labelledby="closest-h">
      <div className="closest-head">
        <h3 id="closest-h">Closest Senate races</h3>
        <span>Sorted by current margin · click a race to open its state</span>
      </div>
      {list.length === 0 && <p className="aside-empty">No Senate votes counted yet in our sources.</p>}
      <ul>
        {list.map((s) => {
          const st = seatStatus(s);
          const [bg, fg, text] = CHIP[st];
          const href = `?level=federal&office=senate&state=${s.state}`;
          return (
            <li key={`${s.state}-${s.seat}`}>
              <a className="closest-row" href={href} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(s.state);
              }}>
                <span className="cs">{s.name}{s.seat === 'special' ? <span className="sub"> (special)</span> : null}</span>
                <span className="cl">
                  <Avatar name={s.lead?.name} party={s.lead?.party} photo={s.lead?.photo} size={24} interactive={false} />
                  <span className="nm">{s.lead?.name}<RunningMate name={s.lead?.runningMate} /></span>
                </span>
                <span className="chip" style={{ background: bg, color: fg }}>{text ?? (partyTag(s.lead) || 'OTHER')}</span>
                <span className="cm">{fmtMargin(s.marginPts)} pts · {reportingText(s) ?? '% in n/a'}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Congress / balance of power (?view=congress). Seats held (not up) + seats each party currently leads. Never a call. */
export default function CongressView({ data, error, onOpenState }) {
  if (!data) {
    return <div className="map-box"><div className="map-msg">{error ? 'Unavailable until the results server answers.' : 'Loading…'}</div></div>;
  }
  if (!data.available) return <div className="banner note">Congress totals aren't available for this election yet.</div>;
  const senateNote = `Independents are shown with the party they caucus with, per the official Senate roster. ${data.senate.tieBreak ?? ''}`.trim();
  return (
    <div className="congress">
      <div className="congress-intro">
        <h2>Balance of power</h2>
        <p>Seats held by each party plus seats where they currently have more votes counted. "Leading" is not a call; this site does not call races.</p>
      </div>
      <div className="chambers">
        <Chamber id="senate" title="U.S. Senate" ch={data.senate} note={senateNote} />
        <Chamber id="house" title="U.S. House" ch={{ ...data.house, holdovers: [] }}
          note="All 435 seats are up every two years. Districts in states without live data stay grey until counts arrive." />
      </div>
      <Closest up={data.senate.up} onOpen={onOpenState} />
      <p className="disclaimer">
        Seats not up this year come from the official chamber rosters
        {data.senate.source?.roster_page ? <> (<a href={data.senate.source.roster_page} target="_blank" rel="noopener noreferrer">senate.gov</a>{data.house.source?.url ? <>, <a href={data.house.source.url} target="_blank" rel="noopener noreferrer">clerk.house.gov</a></> : null}, as of {data.asOf})</> : null}.
      </p>
    </div>
  );
}
