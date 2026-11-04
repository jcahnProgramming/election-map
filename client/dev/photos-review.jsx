// Candidate photo review (dev only). Approve / reject each researched photo in config/elections/<key>/candidates/*.json,
// see the fairness rule per contest live, then export the decisions and apply them with `npm run photos:apply -- <file>`.
// Decisions are kept in this browser's localStorage until exported; nothing here writes to the repo.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { candidateId, contestKey, contestFairness, reviewFlags, isMajorEntry } from '../../server/src/photo-rules.js';
import { initials, avatarTone } from '../src/avatar.js';
import electionsCfg from '../../config/elections.json';
import '../src/tokens.css';
import './photos-review.css';

const FILES = import.meta.glob('../../config/elections/*/candidates/*.json', { eager: true, import: 'default' });
const EK = electionsCfg.current;
const STORE = `photo-review-decisions:${EK}`;
const OFFICE = { senate: 'U.S. Senate', governor: 'Governor', house: 'U.S. House' };

// { ST: entries[] } for the current election, file order kept.
const STATES = Object.fromEntries(Object.entries(FILES)
  .filter(([p]) => p.includes(`/elections/${EK}/candidates/`))
  .map(([p, doc]) => [(doc.state ?? p.match(/([A-Z]{2})\.json$/)[1]).toUpperCase(), doc.candidates ?? []])
  .sort(([a], [b]) => a.localeCompare(b)));

const keyOf = (st, e) => `${st}|${candidateId(e)}`;
const contestTitle = (e) => (e.office === 'house' ? `U.S. House · ${e.district && !/^al$/i.test(String(e.district)) ? `District ${Number(e.district) || e.district}` : 'At large'}` : OFFICE[e.office] ?? e.office);

function loadDecisions() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}

/** The avatar at a size it renders on the site (28 px rows, 40 px totals strip); initials if the image can't load. */
function Avatar({ e, size, onSize }) {
  const t = avatarTone(e.party);
  const [failed, setFailed] = useState(false);
  return (
    <span className="av" style={{ width: size, height: size, background: t.bg, color: t.fg, borderColor: t.ring, fontSize: Math.round(size * 0.4) }}>
      {failed ? initials(e.match[0])
        : <img src={e.photo_url} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}
          onLoad={onSize ? (ev) => onSize({ width: ev.currentTarget.naturalWidth, height: ev.currentTarget.naturalHeight }) : undefined} />}
    </span>
  );
}

function Card({ st, e, decision, onDecide, onFocusCard, focused, cardRef }) {
  const [size, setSize] = useState(null);
  const flags = reviewFlags(e, size);
  const state = decision ?? (e.reviewed === true ? 'approve' : null);
  return (
    <article ref={cardRef} tabIndex={focused ? 0 : -1} className={`card ${state ?? 'pending'}${focused ? ' focused' : ''}`}
      aria-label={`${e.match[0]}, ${contestTitle(e)}. ${state === 'approve' ? 'Approved' : state === 'reject' ? 'Rejected' : 'Not decided'}`}
      onFocus={onFocusCard} onClick={onFocusCard}>
      <div className="pics">
        <span className="sizes"><Avatar e={e} size={28} /><Avatar e={e} size={40} onSize={setSize} /></span>
        <span className="preview" aria-hidden="true"><img src={e.photo_url} alt="" loading="lazy" referrerPolicy="no-referrer" /></span>
      </div>
      <div className="meta">
        <b className="name">{e.match[0]}</b>
        <span className="party">{e.party}{e.party_raw && e.party_raw !== e.party ? ` · ${e.party_raw}` : ''}{isMajorEntry(e) ? '' : ' · not a party nominee'}</span>
        {e.match.length > 1 && <span className="muted">also matches: {e.match.slice(1).join(' · ')}</span>}
        <span className="muted">{st} · {contestTitle(e)}</span>
        <span>{e.source_page_url ? <a href={e.source_page_url} target="_blank" rel="noopener noreferrer">{e.source_type === 'wikimedia_commons' ? 'Commons file page' : 'Source page'} ↗</a> : <span className="flag">No source page</span>}</span>
        <span><span className="k">Author</span> {e.credit || '—'}</span>
        <span><span className="k">License</span> {e.license || '—'}</span>
        {size && <span className="muted">{size.width}×{size.height}px</span>}
        {e.note && <span className="note">{e.note}</span>}
        {flags.length > 0 && <ul className="flags">{flags.map((f) => <li key={f}>⚑ {f}</li>)}</ul>}
      </div>
      <div className="actions">
        <button type="button" className={`ok${state === 'approve' ? ' on' : ''}`} aria-pressed={state === 'approve'} onClick={() => onDecide('approve')}>Approve <kbd>A</kbd></button>
        <button type="button" className={`no${state === 'reject' ? ' on' : ''}`} aria-pressed={state === 'reject'} onClick={() => onDecide('reject')}>Reject <kbd>R</kbd></button>
        {decision && <button type="button" className="undo" onClick={() => onDecide(null)}>Undo <kbd>U</kbd></button>}
      </div>
    </article>
  );
}

function App() {
  const [decisions, setDecisions] = useState(loadDecisions);
  const [remainingOnly, setRemainingOnly] = useState(false);
  const [stateFilter, setStateFilter] = useState('');
  const [focusKey, setFocusKey] = useState(null);
  const refs = useRef(new Map());

  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(decisions)); } catch { /* private mode: decisions stay in memory */ } }, [decisions]);

  const decisionOf = useCallback((st, e) => decisions[keyOf(st, e)] ?? null, [decisions]);
  const approvedNow = useCallback((st) => (e) => {
    const d = decisions[keyOf(st, e)];
    return d ? d === 'approve' : e.reviewed === true;
  }, [decisions]);

  // All photo entries, in display order: state → contest (file order) → candidate.
  const all = useMemo(() => Object.entries(STATES).flatMap(([st, list]) => list.filter((e) => e.photo_url).map((e) => ({ st, e, key: keyOf(st, e) }))), []);
  const done = (x) => decisions[x.key] != null || x.e.reviewed === true;
  const counts = useMemo(() => ({
    approved: all.filter((x) => (decisions[x.key] ?? (x.e.reviewed === true ? 'approve' : null)) === 'approve').length,
    rejected: all.filter((x) => decisions[x.key] === 'reject').length,
    remaining: all.filter((x) => !done(x)).length,
  }), [all, decisions]);
  const visible = all.filter((x) => (!stateFilter || x.st === stateFilter) && (!remainingOnly || !done(x)));
  const visibleKeys = visible.map((x) => x.key);
  const current = focusKey && visibleKeys.includes(focusKey) ? focusKey : visibleKeys[0] ?? null;

  const decide = useCallback((key, d) => setDecisions((m) => {
    const n = { ...m };
    if (d) n[key] = d; else delete n[key];
    return n;
  }), []);
  const move = useCallback((delta) => {
    const i = Math.max(0, visibleKeys.indexOf(current));
    const next = visibleKeys[Math.min(visibleKeys.length - 1, Math.max(0, i + delta))];
    if (next) { setFocusKey(next); refs.current.get(next)?.focus(); refs.current.get(next)?.scrollIntoView({ block: 'nearest' }); }
  }, [visibleKeys, current]);

  useEffect(() => {
    const onKey = (ev) => {
      if (ev.target?.closest?.('input, select, textarea') || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (!current) return;
      if (k === 'a' || k === 'r') {
        ev.preventDefault();
        decide(current, k === 'a' ? 'approve' : 'reject');
        if (!remainingOnly) move(1); // with "remaining only" the decided card leaves the list and the next one takes its place
      } else if (k === 'u') { ev.preventDefault(); decide(current, null); }
      else if (k === 'arrowright' || k === 'arrowdown' || k === 'j') { ev.preventDefault(); move(1); }
      else if (k === 'arrowleft' || k === 'arrowup' || k === 'k') { ev.preventDefault(); move(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, decide, move, remainingOnly]);
  useEffect(() => { if (current && document.activeElement?.closest?.('.card') == null) refs.current.get(current)?.focus({ preventScroll: true }); }, [current]);

  const exportDecisions = () => {
    const list = Object.entries(decisions).map(([k, decision]) => { const [state, id] = k.split('|'); return { state, candidateId: id, decision }; })
      .sort((a, b) => a.state.localeCompare(b.state) || a.candidateId.localeCompare(b.candidateId));
    const blob = new Blob([`${JSON.stringify(list, null, 2)}\n`], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `photo-decisions-${EK}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Group the visible cards by state → contest, with the live fairness result for each contest.
  const groups = [];
  for (const x of visible) {
    let g = groups.find((y) => y.st === x.st);
    if (!g) { g = { st: x.st, contests: [] }; groups.push(g); }
    const ck = contestKey(x.e);
    let c = g.contests.find((y) => y.key === ck);
    if (!c) {
      const fair = contestFairness(STATES[x.st].filter((e) => contestKey(e) === ck), approvedNow(x.st))[0];
      c = { key: ck, title: contestTitle(x.e), fair, cards: [] };
      g.contests.push(c);
    }
    c.cards.push(x);
  }

  return (
    <div className="page">
      <header className="top">
        <h1>Candidate photo review · {EK}</h1>
        <p className="progress" role="status">
          <b className="ok">{counts.approved}</b> approved · <b className="no">{counts.rejected}</b> rejected · <b>{counts.remaining}</b> remaining of {all.length}
        </p>
        <div className="controls">
          <label><input type="checkbox" checked={remainingOnly} onChange={(e) => setRemainingOnly(e.target.checked)} /> Remaining only</label>
          <label>State <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">All</option>{Object.keys(STATES).map((s) => <option key={s}>{s}</option>)}
          </select></label>
          <button type="button" className="export" onClick={exportDecisions} disabled={!Object.keys(decisions).length}>Export decisions ({Object.keys(decisions).length})</button>
        </div>
        <p className="help">
          Keys: <kbd>A</kbd> approve · <kbd>R</kbd> reject · <kbd>U</kbd> undo · <kbd>←</kbd><kbd>→</kbd> move. Hover a card for a large preview.
          Flags (⚑) are prompts to look closer, never decisions. Decisions are saved in this browser as you go; export, then run
          <code> npm run photos:apply -- photo-decisions-{EK}.json</code>.
        </p>
      </header>
      {groups.length === 0 && <p className="empty">Nothing left to review here.</p>}
      {groups.map((g) => (
        <section key={g.st} className="state" aria-label={g.st}>
          <h2>{g.st}</h2>
          {g.contests.map((c) => (
            <div key={c.key} className="contest">
              <div className="contest-head">
                <h3>{c.title}</h3>
                <span className={`fair ${c.fair.show ? 'show' : 'init'}`}>
                  {c.fair.show ? 'Photos will show' : `Initials only${c.fair.missing.length ? ` — needs an approved photo: ${c.fair.missing.join(', ')}` : ''}`}
                </span>
              </div>
              <div className="grid">
                {c.cards.map((x) => (
                  <Card key={x.key} st={x.st} e={x.e} decision={decisionOf(x.st, x.e)} focused={x.key === current}
                    cardRef={(el) => { if (el) refs.current.set(x.key, el); else refs.current.delete(x.key); }}
                    onFocusCard={() => setFocusKey(x.key)} onDecide={(d) => decide(x.key, d)} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
