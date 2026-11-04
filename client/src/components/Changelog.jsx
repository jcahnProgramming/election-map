import React, { useEffect, useRef } from 'react';
import { fmtDate } from '../format.js';

/** Modal "What's new" panel, from GET /api/changelog (CHANGELOG.json). Esc closes; focus is trapped and restored. */
export default function Changelog({ data, error, currentVersion, onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  useEffect(() => {
    const prev = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const els = dialogRef.current.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev && prev.focus) prev.focus();
    };
  }, [onClose]);

  const releases = data?.releases || [];
  const next = data?.next;
  const current = currentVersion || data?.currentVersion || releases[0]?.version;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="changelog-title" ref={dialogRef} tabIndex={-1}>
        <div className="dialog-head">
          <div>
            <h2 id="changelog-title">What's new</h2>
            <span className="sub">From CHANGELOG.json</span>
          </div>
          <button type="button" className="icon-btn" ref={closeRef} onClick={onClose} aria-label="Close changelog">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
        {error && !data && <div className="banner err">{error}</div>}
        {!data && !error && <div className="na-text">Loading…</div>}
        {next && (
          <article className="release">
            <div className="release-top">
              <span className="v">{next.version}</span>
              <span className="pill next">NEXT</span>
              {next.title && <span className="ttl">{next.title}</span>}
            </div>
            {next.items?.length > 0 && <ul>{next.items.map((i) => <li key={i}>{i}</li>)}</ul>}
          </article>
        )}
        {releases.map((r) => (
          <article className="release" key={r.version}>
            <div className="release-top">
              <span className="v">{r.version}</span>
              {r.version === current && <span className="pill current">CURRENT</span>}
              {r.title && <span className="ttl">{r.title}</span>}
              <span className="d">{fmtDate(r.date)}</span>
            </div>
            {Object.entries(r.sections || {}).map(([sec, items]) => (
              <React.Fragment key={sec}>
                <h3>{sec}</h3>
                <ul>{(items || []).map((i) => <li key={i}>{i}</li>)}</ul>
              </React.Fragment>
            ))}
            {Array.isArray(r.items) && <ul>{r.items.map((i) => <li key={i}>{i}</li>)}</ul>}
          </article>
        ))}
      </section>
    </div>
  );
}
