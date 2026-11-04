import React from 'react';
import { measureStatus, measureShares, MEASURE_STATUS_LABEL } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth } from '../format.js';

function Measure({ m }) {
  const st = measureStatus(m);
  const { yesPct, noPct } = measureShares(m);
  const title = m.title && m.title !== m.name ? m.title : null;
  return (
    <article className="measure">
      <div className="measure-top">
        <span className="tag">{m.state}</span>
        <div className="measure-name">
          <b>{m.name || m.id}</b>
        </div>
        <span className={`pill ${st === 'yes' ? 'yes' : st === 'no' ? 'no' : ''}`}>{MEASURE_STATUS_LABEL[st]}</span>
      </div>
      {title && <p className="measure-title">{title}</p>}
      <div className="split" role="img" aria-label={`Yes ${fmtPct(yesPct)}, No ${fmtPct(noPct)}`}>
        <div style={{ width: barWidth(yesPct), background: 'var(--yes)' }} />
        <div style={{ width: barWidth(noPct), background: 'var(--no)' }} />
      </div>
      <div className="measure-nums">
        <span style={{ color: 'var(--yes-text)' }}>Yes {fmtPct(yesPct)} · {fmtVotes(m.yes)}</span>
        <span style={{ color: 'var(--no-text)' }}>No {fmtPct(noPct)} · {fmtVotes(m.no)}</span>
      </div>
      <span className="measure-foot">
        {m.pctReporting != null ? `${fmtReporting(m.pctReporting)} reporting` : '% reporting not published'}
        {m.sourceName ? (
          <> · {m.sourceUrl ? <a href={m.sourceUrl} target="_blank" rel="noopener noreferrer">{m.sourceName}</a> : m.sourceName}</>
        ) : null}
      </span>
    </article>
  );
}

export default function Sidebar({ measures, error, stateName, onClose }) {
  return (
    <aside className="aside" aria-label="Ballot measures" id="measures">
      <div className="aside-head">
        <div>
          <h2>Ballot measures</h2>
          <span className="sub">{stateName || 'All states'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close ballot measures">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="yn-key">
        <span><span className="sw8" style={{ width: 10, height: 10, background: 'var(--yes)' }} />Yes</span>
        <span><span className="sw8" style={{ width: 10, height: 10, background: 'var(--no)' }} />No</span>
      </div>
      {error && <div className="banner err">{error}{measures ? ' Showing the last data we received.' : ''}</div>}
      <div className="measure-list">
        {!measures && !error && <div className="aside-empty">Loading…</div>}
        {measures?.map((m) => <Measure key={m.id} m={m} />)}
        {measures && measures.length === 0 && (
          <div className="aside-empty">No statewide ballot measures {stateName ? `for ${stateName} ` : ''}in our sources.</div>
        )}
      </div>
    </aside>
  );
}
