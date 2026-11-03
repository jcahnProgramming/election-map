import React from 'react';
import { fmtVotes, fmtPct, fmtTime } from '../format.js';

export default function Sidebar({ open, onToggle, measures, error, stateAbbr }) {
  return (
    <>
      <button className="sidebar-toggle" onClick={onToggle} aria-expanded={open}>
        {open ? 'Close ballot measures ×' : 'Ballot measures ›'}
      </button>
      {open && (
        <aside className="sidebar" aria-label="Ballot measures">
          <h2 style={{ marginTop: 32 }}>Ballot measures {stateAbbr ? `— ${stateAbbr}` : '— all states'}</h2>
          <div className="notice">Unofficial results — counts change as ballots are reported.</div>
          {error && <div className="error">{error}</div>}
          {!error && !measures && <div>Loading…</div>}
          {measures && measures.length === 0 && (
            <div>No ballot measures with data{stateAbbr ? ` for ${stateAbbr}` : ''}.</div>
          )}
          {measures &&
            measures.map((m) => (
              <div key={m.id} style={{ borderBottom: '1px solid #ccc', padding: '6px 0' }}>
                <div>
                  <strong>{m.name}</strong> ({m.state})
                </div>
                <table>
                  <tbody>
                    <tr><td>Yes</td><td className="num">{fmtVotes(m.yes)}</td></tr>
                    <tr><td>No</td><td className="num">{fmtVotes(m.no)}</td></tr>
                    <tr><td>% Yes</td><td className="num">{fmtPct(m.pctYes)}</td></tr>
                    <tr><td>% Reporting</td><td className="num">{fmtPct(m.pctReporting, 0)}</td></tr>
                  </tbody>
                </table>
                <div style={{ fontSize: 12 }}>
                  Source: {m.source || '—'}
                  {m.fetchedAt ? `, fetched ${fmtTime(m.fetchedAt)}` : ''}
                </div>
              </div>
            ))}
        </aside>
      )}
    </>
  );
}
