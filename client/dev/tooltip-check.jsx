// Dev-only visual check for tooltip overflow (0.5.3). Renders the real EntryTip / DistrictRows / Congress closest-races
// rows inside a real `.tip` box with deliberately long names (the live NM and CO governor tickets, a long hostname, a
// long candidate), at desktop and phone widths, then measures: no descendant may extend past its box. The verdict is
// written to <body data-overflow="0|N"> and listed on the page.
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import EntryTip, { DistrictRows } from '../src/components/EntryTip.jsx';
import { Closest } from '../src/components/CongressView.jsx';
import '../src/tokens.css';
import '../src/app.css';

const NM_TICKET = 'DEB HAALAND AND STEPHANIE GARCIA RICHARD';
const CO_TICKET = 'Phil Weiser / Lesley Dahlkemper';
const LONG = 'Maximiliana Konstantinopoulou-Vanderschootenbergh';

const entry = {
  name: 'New Mexico', state: 'NM', status: 'reporting', pctReporting: 87, topLabel: 'U.S. Senate', leader: 'DEM', marginPts: 12.48,
  totalVotes: 1000000, sourceName: 'New Mexico Secretary of State election results (ResultsAjax.svc ENR) with a long name',
  sourceUpdatedAt: '2026-11-04T03:00:00Z', fetchedAt: '2026-11-04T03:00:00Z',
  official: { url: 'https://electionresults.sos.nm.gov/resultsSW.aspx?type=FED&map=CTY&eid=supercalifragilisticexpialidocious-0123456789' },
  candidates: [
    { name: `${LONG} Jr.`, party: 'DEM', partyRaw: 'DEM', votes: 562400, runningMate: 'Someone With A Very Long Running-Mate Name' },
    { name: 'Ann Lee', party: 'REP', partyRaw: 'REP', votes: 437600 },
  ],
  otherRaces: [
    { office: 'governor', label: 'Governor', status: 'reporting', totalVotes: 900000, leader: 'DEM', marginPts: 12.5, leadName: NM_TICKET, leadParty: 'DEM', leadPartyRaw: 'DEM' },
    { office: 'governor', label: 'Governor', status: 'reporting', totalVotes: 900000, leader: 'DEM', marginPts: 29.2, leadName: CO_TICKET, leadParty: 'DEM', leadPartyRaw: 'DEM' },
    { office: 'house', label: 'U.S. House', status: 'reporting', totalVotes: 800000, leader: 'DEM', marginPts: 18.9, partySum: true },
    { office: 'senate', label: 'U.S. Senate', name: 'U.S. Senator (Unexpired Term)', status: 'reporting', totalVotes: 1, leader: 'REP', marginPts: 0.4, leadName: 'X', leadParty: 'REP' },
  ],
};
const houseEntry = {
  name: 'Texas', state: 'TX', status: 'reporting', partySum: true, leader: 'REP', marginPts: 12.5, totalVotes: 1000,
  parties: { DEM: 400, REP: 590, OTHER: 10 }, contests: ['a', 'b'],
  districts: [
    { district: '1', totalVotes: 100, leader: 'REP', marginPts: 33.1, lead: { name: `ROBERT P. "FAMILY MAN" ${LONG.toUpperCase()}, JR.`, party: 'REP', partyRaw: 'REP', runningMate: null } },
    { district: '22', totalVotes: 100, leader: 'DEM', marginPts: 1.2, lead: { name: 'Short', party: 'DEM', partyRaw: 'DEM' } },
    { district: '35', totalVotes: 0, leader: null, marginPts: null, lead: null },
  ],
};

const closest = [
  { state: 'NM', name: 'New Mexico', seat: 'regular', live: true, totalVotes: 10, leader: 'DEM', marginPts: 0.6, pctReporting: 40, lead: { name: NM_TICKET, party: 'DEM', partyRaw: 'DEM' } },
  { state: 'CO', name: 'Colorado', seat: 'special', live: true, totalVotes: 10, leader: 'DEM', marginPts: 3.4, pctReporting: 51, lead: { name: `${LONG} ${LONG}`, party: 'DEM', partyRaw: 'DEM', runningMate: CO_TICKET } },
];

function Box({ width, children }) {
  // The real .tip class, laid out statically (not fixed) so several can be measured side by side.
  return (
    <div className="tip" data-check style={{ position: 'relative', left: 0, top: 0, minWidth: Math.min(320, width), maxWidth: Math.min(420, width), margin: 12 }}>
      {children}
    </div>
  );
}

function overflowing(root) {
  const bad = [];
  for (const box of root.querySelectorAll('[data-check]')) {
    const b = box.getBoundingClientRect();
    if (box.scrollWidth > box.clientWidth + 1) bad.push(`box scrollWidth ${box.scrollWidth} > ${box.clientWidth}`);
    for (const el of box.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > b.right + 0.5 || r.left < b.left - 0.5) bad.push(`${el.className || el.tagName}: "${el.textContent.slice(0, 40)}" ${Math.round(r.right - b.right)}px past`);
    }
  }
  return bad;
}

function Check() {
  const [bad, setBad] = useState(null);
  useLayoutEffect(() => {
    const b = overflowing(document.getElementById('boxes'));
    document.body.dataset.overflow = String(b.length);
    setBad(b);
  }, []);
  return (
    <div style={{ padding: 12, fontFamily: 'Inter, system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 16 }}>Tooltip overflow check: {bad == null ? '…' : bad.length ? `${bad.length} OVERFLOW(S)` : 'OK, nothing overflows'}</h1>
      <ul>{(bad || []).map((x, i) => <li key={i}>{x}</li>)}</ul>
      <div id="boxes" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {[1440, 390].map((w) => (
          <React.Fragment key={w}>
            <Box width={w - 16}><EntryTip title="New Mexico" entry={entry} race="senate" /></Box>
            <Box width={w - 16}><EntryTip title="Texas" entry={houseEntry} race="house" /></Box>
            <Box width={w - 16}><DistrictRows districts={houseEntry.districts} state="TX" interactive={false} /></Box>
            <div data-check style={{ width: Math.min(w - 32, 900), margin: 12 }}><Closest up={closest} onOpen={() => {}} /></div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Check />);
