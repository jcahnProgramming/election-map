import React, { useMemo, useState } from 'react';
import { TOSSUP_MARGIN, PARTY_COLOR } from '../shading.js';
import { fmtVotes, fmtPct, fmtReporting, barWidth } from '../format.js';
import { candidateList, partyTag } from '../calc.js';
import { PartyTag } from './EntryTip.jsx';

/**
 * Every contest in a state's feeds (GET /api/state/:abbr/contests), grouped and searchable. Each row stands alone:
 * leading party (partisan), leading name (nonpartisan), YES/NO (questions, retention), never "winner".
 */
export default function AllRaces({ data, error, stateName, onOpenMeasure }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());

  const groups = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.groups || []).map((g) => ({
      ...g,
      contests: terms.length ? g.contests.filter((c) => { const h = hay(c, g.title); return terms.every((t) => h.includes(t)); }) : g.contests,
    })).filter((g) => g.contests.length);
  }, [data, query]);
  const matched = groups.reduce((n, g) => n + g.contests.length, 0);

  if (!data) {
    return <div className="map-box"><div className="map-msg">{error ? 'Unavailable until the results server answers.' : 'Loading every contest…'}</div></div>;
  }
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="all-races" aria-label="All races">
      <div className="all-head">
        <label className="search">
          Search races
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Office, district, county or city"
            aria-describedby="all-count" />
        </label>
        <span id="all-count" className="count">
          {query.trim() ? `${matched} of ${data.total}` : data.total} contest{data.total === 1 ? '' : 's'} on the {stateName} ballot in our sources
        </span>
      </div>
      {data.note && <p className="map-note">{data.note}</p>}
      {groups.map((g) => (
        <div className="race-group-card" key={g.level}>
          <div className="rg-head">
            <h3>{g.title}</h3>
            <span>{g.contests.length} contest{g.contests.length === 1 ? '' : 's'}</span>
          </div>
          {g.level === 'measure' && <p className="rg-note">Statewide measures link to their details in the Ballot measures panel.</p>}
          <ul className="rg-rows">
            {g.contests.map((c) => <Row key={c.id} c={c} open={open.has(c.id)} onToggle={() => toggle(c.id)} onOpenMeasure={onOpenMeasure} />)}
          </ul>
        </div>
      ))}
      {data.total > 0 && matched === 0 && (
        <div className="aside-empty">No contests match “{query.trim()}”.</div>
      )}
    </section>
  );
}

function hay(c, groupTitle) {
  return [c.name, c.title, c.officeLabel, c.district && `district ${c.district}`, c.jurisdiction, groupTitle,
    ...(c.candidates || []).map((x) => x.name)].filter(Boolean).join(' ').toLowerCase();
}

const CHIP = {
  DEM: ['#16264A', '#93B4FA'], REP: ['#3A1818', '#F7A1A1'], OTHER: ['#12301F', '#8FE3B0'], TOSS: ['#2B2346', '#C4B5FD'],
  YES: ['#123B36', '#5EEAD4'], NO: ['#3B2A10', '#FCD34D'], NAME: ['#232A35', '#E6EDF3'], NONE: ['#1B212B', '#9AA4B2'],
};

/** The lead chip: party / TOSS-UP / YES / NO / a name / "VOTE FOR n" / no votes yet. */
function leadChip(c) {
  if (c.multiSeat) return { text: `VOTE FOR ${c.seats}`, colors: CHIP.NAME, title: 'Several candidates win: no two-way margin' };
  if (!c.totalVotes) return { text: 'NO VOTES YET', colors: CHIP.NONE };
  if (c.tied || c.lead == null) return { text: 'TIED', colors: CHIP.TOSS };
  if (c.lead === 'YES' || c.lead === 'NO') return { text: c.lead, colors: CHIP[c.lead] };
  if (c.kind === 'partisan') {
    if (c.marginPts != null && Math.abs(c.marginPts) < TOSSUP_MARGIN) return { text: 'TOSS-UP', colors: CHIP.TOSS };
    if (c.lead === 'DEM' || c.lead === 'REP') return { text: c.lead, colors: CHIP[c.lead] };
    return { text: partyTag({ party: 'OTHER', partyRaw: c.leadPartyRaw }) || 'OTHER PARTY', colors: CHIP.OTHER };
  }
  return { text: c.lead, colors: CHIP.NAME };
}

function Row({ c, open, onToggle, onOpenMeasure }) {
  const chip = leadChip(c);
  const detailsId = `cands-${c.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const showMargin = !c.multiSeat && c.totalVotes > 0 && c.marginPts != null;
  const isQuestion = c.office === 'measure' || c.kind === 'yes_no' || c.kind === 'retention';
  const list = candidateList(c, open ? Infinity : 3);
  return (
    <li className="rg-row">
      <button type="button" className="rg-main" aria-expanded={open} aria-controls={detailsId} onClick={onToggle}>
        <span className="rg-name">
          {c.name}
          {c.scope === 'county' && c.jurisdiction ? <span className="rg-sub"> · {c.jurisdiction} county site</span> : null}
          {!isQuestion && !open && list.rows.length > 0 && (
            <span className="rg-who">
              {list.rows.map((x, i) => (
                <span key={`${x.name}-${i}`} className="rg-cand">{x.name}<PartyTag tag={x.tag} party={x.party} />{c.totalVotes > 0 ? ` ${fmtPct(x.pct)}` : ''}</span>
              ))}
              {list.more > 0 && <span className="rg-cand more">+{list.more} more</span>}
            </span>
          )}
        </span>
        <span className="rg-lead">
          <span className="chip" style={{ background: chip.colors[0], color: chip.colors[1] }} title={chip.title}>{chip.text}</span>
          <span className="rg-margin">{showMargin ? `${Math.abs(c.marginPts).toFixed(1)} pts` : ''}</span>
        </span>
        <span className="rg-rep">{c.pctReporting != null ? `${fmtReporting(c.pctReporting)} in` : '% in n/a'}</span>
      </button>
      {open && (
        <div className="rg-cands" id={detailsId}>
          {c.multiSeat && <p className="rg-note">Vote for {c.seats}: the top {c.seats} in votes counted so far are listed first. This site does not call races.</p>}
          <ul>
            {isQuestion
              ? (c.candidates || []).map((x, i) => (
                <li key={`${x.name}-${i}`}>
                  <span className="who">{x.name}</span>
                  <span className="num">{fmtVotes(x.votes)} · {fmtPct(x.pct)}</span>
                  <span className="bar thin"><span style={{ width: barWidth(x.pct), background: /^(no|against)\b/i.test(x.name) ? 'var(--no)' : 'var(--yes)' }} /></span>
                </li>
              ))
              : [...list.rows, ...list.writeIns.map((w) => ({ ...w, wi: true, tag: w.named ? 'WRITE-IN' : '' }))].map((x, i) => (
                <li key={`${x.name}-${i}`} className={`${c.multiSeat && i < c.seats ? 'top' : ''}${x.wi ? ' wi' : ''}`}>
                  <span className="who">
                    {x.party && <span className="sw8" style={{ background: PARTY_COLOR[x.party] || PARTY_COLOR.OTHER }} />}
                    {x.name}<PartyTag tag={x.tag} party={x.party} />
                  </span>
                  <span className="num">{fmtVotes(x.votes)} · {fmtPct(x.pct)}</span>
                  <span className="bar thin"><span style={{ width: barWidth(x.pct), background: x.wi ? 'var(--muted-2)' : PARTY_COLOR[x.party] || PARTY_COLOR.OTHER }} /></span>
                </li>
              ))}
          </ul>
          <p className="rg-meta">
            {c.precinctsTotal != null ? `${fmtVotes(c.precinctsReporting)} of ${fmtVotes(c.precinctsTotal)} precincts · ` : ''}
            {fmtVotes(c.totalVotes)} votes counted{c.voteFor > 1 ? ` · vote for ${c.voteFor}` : ''}
          </p>
          {c.measureId && onOpenMeasure && (
            <button type="button" className="link-btn sm" onClick={() => onOpenMeasure(c.measureId)}>Measure details in the Ballot measures panel →</button>
          )}
        </div>
      )}
    </li>
  );
}
