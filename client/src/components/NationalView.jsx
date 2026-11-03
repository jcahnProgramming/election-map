import React, { useMemo } from 'react';
import MapSvg from './MapSvg.jsx';
import { ResultSummary } from './ResultSummary.jsx';
import { stateFeatures, NATIONAL_VIEWBOX, FIPS_TO_ABBR } from '../geo.js';
import { fmtMargin, fmtPct, fmtVotes } from '../format.js';

const STATUS_SHORT = {
  reporting: 'Reporting',
  awaiting: 'No votes counted yet',
  'no-source': 'No data source yet',
  'no-race': 'No race',
};

export default function NationalView({ data, onSelectState }) {
  const byFips = useMemo(() => {
    const m = {};
    for (const s of data?.states || []) m[s.fips] = s;
    return m;
  }, [data]);

  const rows = useMemo(
    () =>
      [...(data?.states || [])]
        .filter((s) => s.status !== 'no-race')
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [data]
  );

  return (
    <div>
      <MapSvg
        label="Map of U.S. states shaded by current leader"
        features={stateFeatures}
        viewBox={NATIONAL_VIEWBOX}
        entryFor={(f) => byFips[f.id]}
        onSelect={(f) => {
          const abbr = byFips[f.id]?.state || FIPS_TO_ABBR[f.id];
          if (abbr) onSelectState(abbr);
        }}
        renderTooltip={(f, e) => <ResultSummary name={e?.name || f.properties?.name} entry={e} />}
      />
      <details>
        <summary>All states with this race ({rows.length}) — table view</summary>
        <table>
          <thead>
            <tr>
              <th>State</th><th>Status</th><th>Leading</th>
              <th className="num">Total votes</th><th className="num">Reporting</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.state}>
                <td><a href={`#/${s.state}/${data.race}`}>{s.name}</a></td>
                <td>{STATUS_SHORT[s.status] || s.status}</td>
                <td>{s.status === 'reporting' ? fmtMargin(s.leader, s.marginPts) : '—'}</td>
                <td className="num">{fmtVotes(s.totalVotes)}</td>
                <td className="num">{fmtPct(s.pctReporting, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
