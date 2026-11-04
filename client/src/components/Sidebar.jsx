import React, { useEffect, useRef, useState } from 'react';
import { measureStatus, measureShares, MEASURE_STATUS_LABEL, positionDisplay, websiteLabel, displayDomain } from '../calc.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth } from '../format.js';

const ext = { target: '_blank', rel: 'noopener noreferrer' };

function PlacedBy({ p }) {
  let who;
  if (!p) who = <span className="plain">Not in our official sources yet</span>;
  else if (p.type === 'legislative_referral') {
    who = <span className="plain">Referred by the Legislature{p.billNumber ? ` (${p.billNumber})` : ''}</span>;
  } else if (p.type === 'initiative') {
    who = <span className="plain">{p.proponentName || 'Citizen initiative (proponent not named in the official filing)'}</span>;
  } else who = <span className="plain">{p.detail || 'Placed on the ballot by law'}</span>;
  return (
    <div className="m-row">
      <span className="m-k">Placed on ballot by</span>
      {who}
      {p?.sourceUrl && <a className="m-src" href={p.sourceUrl} {...ext} aria-label="Source for who placed this measure on the ballot">source</a>}
    </div>
  );
}

function LegVote({ v }) {
  const fmtParty = (bp) => (bp ? Object.entries(bp).map(([party, x]) => `${party} ${x.yes ?? 0}–${x.no ?? 0}`).join(' · ') : 'Party breakdown not published');
  return (
    <div className="m-block">
      <span className="m-k">Legislature's vote to refer</span>
      {v.chambers.map((c) => (
        <div className="m-vote" key={c.chamber}>
          <span>{c.chamber} {c.yes}–{c.no}{c.other ? ` (${c.other} not voting)` : ''}</span>
          <span className="muted">{fmtParty(c.by_party)}</span>
        </div>
      ))}
      {(v.rollCallUrl || v.sourceUrl) && <a href={v.rollCallUrl || v.sourceUrl} {...ext} className="m-link">Roll call record ↗</a>}
    </div>
  );
}

function Measure({ m, highlight }) {
  const [open, setOpen] = useState(false);
  const st = measureStatus(m);
  const { yesPct, noPct } = measureShares(m);
  const info = m.info;
  const officialTitle = info?.officialTitle?.value || (m.title && m.title !== m.name ? m.title : null);
  const sourceLink = info?.officialSourceUrl || m.official?.url || m.sourceUrl;
  return (
    <article className={`measure${highlight ? ' hl' : ''}`} id={`measure-${m.id}`} tabIndex={-1}>
      <div className="measure-top">
        <span className="tag">{m.state}</span>
        <div className="measure-name">
          <b>{info?.measureId || m.name || m.id}</b>
          {officialTitle && <span className="measure-title">{officialTitle}</span>}
        </div>
        <span className={`pill ${st === 'yes' ? 'yes' : st === 'no' ? 'no' : ''}`}>{m.live ? MEASURE_STATUS_LABEL[st] : 'NO FEED'}</span>
      </div>

      {info && (
        info.officialSummary
          ? <p className="m-summary">{info.officialSummary.value}{info.officialSummary.by ? <span className="muted"> — official summary, {info.officialSummary.by}</span> : null}</p>
          : <p className="m-summary muted">No official summary published</p>
      )}

      {info && (
        <div className="m-rows">
          <PlacedBy p={info.placedBy} />
          {info.opposition && (
            <div className="m-row">
              <span className="m-k">Registered opposition</span>
              <span className="plain">{info.opposition.name}</span>
              {info.opposition.sourceUrl && <a className="m-src" href={info.opposition.sourceUrl} {...ext} aria-label="Campaign-finance filing">filing</a>}
            </div>
          )}
          {info.campaignWebsites?.length > 0 && (
            <div className="m-block m-sites">
              {info.campaignWebsites.map((w) => (
                <div className="m-row" key={`${w.side}-${w.url}`}>
                  <span className="m-k">{websiteLabel(w)}</span>
                  <a href={w.url} {...ext}>{displayDomain(w.url)} ↗</a>
                  {w.sourceUrl && <a className="m-src" href={w.sourceUrl} {...ext} aria-label="Where this website is listed officially">listed in</a>}
                  {w.note && <span className="m-note">{w.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {info?.partyPositions?.length > 0 && (
        <div className="m-block">
          <span className="m-k">Party positions</span>
          <ul className="m-parties">
            {info.partyPositions.map((p) => {
              const d = positionDisplay(p.position);
              return (
                <li key={p.party}>
                  <span className="pp-party">{p.party}</span>
                  {p.position && p.sourceUrl
                    ? <a href={p.sourceUrl} {...ext} style={{ color: d.color }} className="pp-pos">{d.label} ↗</a>
                    : <span style={{ color: d.color }} className={`pp-pos${p.position ? '' : ' none'}`}>{d.label}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {info?.placedBy?.type === 'legislative_referral' && info.legislativeVote && <LegVote v={info.legislativeVote} />}

      {open && info?.fullText && (
        <div className="m-text" id={`text-${m.id}`}>
          <span className="m-k">Ballot text as it appears on the ballot</span>
          {info.fullText.value
            ? <p>{info.fullText.value}</p>
            : <p className="muted">Too long to show here.</p>}
          {info.fullText.url && <a href={info.fullText.url} {...ext} className="m-link">Full text (official) ↗</a>}
        </div>
      )}
      <div className="m-actions">
        {info?.fullText
          ? <button type="button" className="link-btn sm" aria-expanded={open} aria-controls={`text-${m.id}`} onClick={() => setOpen((o) => !o)}>{open ? 'Hide ballot text' : 'Full ballot text'}</button>
          : <span />}
        {sourceLink && <a href={sourceLink} {...ext} className="m-link">Official source ↗</a>}
      </div>

      {m.live ? (
        <>
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
              <> · {m.sourceUrl ? <a href={m.sourceUrl} {...ext}>{m.sourceName}</a> : m.sourceName}</>
            ) : null}
          </span>
        </>
      ) : (
        <span className="measure-foot">No counts from our sources for this measure{m.official?.url ? <> — <a href={m.official.url} {...ext}>official results ↗</a></> : '.'}</span>
      )}
    </article>
  );
}

export default function Sidebar({ measures, error, stateName, onClose, focus }) {
  const listRef = useRef(null);
  const [hl, setHl] = useState(null);
  useEffect(() => {
    if (!focus?.id || !measures) return;
    const el = document.getElementById(`measure-${focus.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
      setHl(focus.id);
      const t = setTimeout(() => setHl(null), 2500);
      return () => clearTimeout(t);
    }
  }, [focus, measures]);

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
      <div className="measure-list" ref={listRef}>
        {!measures && !error && <div className="aside-empty">Loading…</div>}
        {measures?.map((m) => <Measure key={m.id} m={m} highlight={hl === m.id} />)}
        {measures && measures.length === 0 && (
          <div className="aside-empty">No statewide ballot measures {stateName ? `for ${stateName} ` : ''}in our sources.</div>
        )}
      </div>
    </aside>
  );
}
