import React from 'react';
import { fmtVotes, fmtPct, fmtMargin, fmtTime, STATUS_TEXT } from '../format.js';
import { effectiveStatus } from '../shading.js';

export function CandidatesTable({ candidates, totalVotes }) {
  const rows = [...(candidates || [])].sort((a, b) => (b.votes || 0) - (a.votes || 0));
  if (!rows.length) return <div>No candidates listed.</div>;
  return (
    <table>
      <thead>
        <tr><th>Candidate</th><th>Party</th><th className="num">Votes</th><th className="num">Share</th></tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={`${c.name}-${i}`}>
            <td>{c.name}</td>
            <td>{c.partyRaw && c.partyRaw !== c.party ? `${c.party} (${c.partyRaw})` : c.party}</td>
            <td className="num">{fmtVotes(c.votes)}</td>
            <td className="num">{totalVotes > 0 ? fmtPct((100 * (c.votes || 0)) / totalVotes) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tooltip / summary body for a state or county entry. */
export function ResultSummary({ name, entry, showSource = true }) {
  const status = effectiveStatus(entry);
  return (
    <div>
      <strong>{name}</strong>
      {entry?.contests?.length > 0 && <div>{entry.contests.join('; ')}</div>}
      {status === 'awaiting' && <div>No votes counted yet.</div>}
      {status === 'reporting' || (status === 'awaiting' && entry?.candidates?.length > 0) ? (
        <>
          <CandidatesTable candidates={entry.candidates} totalVotes={entry.totalVotes} />
          <div>Total votes: {fmtVotes(entry.totalVotes)}</div>
          <div>Reporting: {fmtPct(entry.pctReporting, 0)}</div>
          <div>Leading: {fmtMargin(entry.leader, entry.marginPts)}</div>
        </>
      ) : status !== 'awaiting' ? (
        <div>{STATUS_TEXT[status] || status}</div>
      ) : null}
      {showSource && entry?.source && (
        <div>Source: {entry.source}{entry.fetchedAt ? `, fetched ${fmtTime(entry.fetchedAt)}` : ''}</div>
      )}
    </div>
  );
}
