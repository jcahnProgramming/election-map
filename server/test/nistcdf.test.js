import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cdfVersion, fixGeneratedDate, parseCdf } from '../src/adapters/_nist-cdf.js';
import { buildResult } from '../src/adapters/nistcdf.js';

// Trimmed from the live Ohio SOS feed on election night (state, 5 counties, Gov / Senate / House 1 + 13 / Issue 3, plus
// Attorney General, a Supreme Court seat, Court of Appeals District 1, State Senate 7 and State House 24).
const xml = readFileSync(fileURLToPath(new URL('./fixtures/nistcdf/oh-2026-general-trimmed.xml', import.meta.url)), 'utf8');
const target = { key: 'OH-2026-general', state: 'OH', label: 'Ohio 2026 General', races: ['senate', 'governor', 'house'], measures: true, url: 'https://liveresults.ohiosos.gov/', date: '2026-11-03', hour12: true };

function run() {
  const unmatched = [];
  const r = buildResult(xml, target, { unmatched: (...a) => unmatched.push(a), now: new Date('2026-11-04T03:00:00Z') });
  return { r, unmatched };
}

test('OH: offices, districts and statewide flags', () => {
  const { r } = run();
  const byOffice = (o) => r.races.filter((x) => x.office === o);
  assert.equal(byOffice('governor').length, 1);
  assert.equal(byOffice('senate').length, 1);
  assert.deepEqual(byOffice('house').map((h) => h.district), ['1', '13']);
  assert.equal(byOffice('measure').length, 1);
  assert.ok(byOffice('governor')[0].statewide);
  assert.ok(!byOffice('house')[0].statewide);
});

test('OH: candidates and parties (ticket = first candidate; raw label kept)', () => {
  const { r, unmatched } = run();
  const gov = r.races.find((x) => x.office === 'governor');
  const byName = Object.fromEntries(gov.choices.map((c) => [c.name, c]));
  assert.deepEqual(byName['Amy Acton'], { name: 'Amy Acton', party: 'DEM', partyRaw: 'DEM' });
  assert.deepEqual(byName['Vivek Ramaswamy'], { name: 'Vivek Ramaswamy', party: 'REP', partyRaw: 'REP' });
  assert.equal(byName['Don Kissick'].party, 'OTHER');
  // Ohio's own abbreviations we don't know yet are logged, never dropped.
  const sen = r.races.find((x) => x.office === 'senate');
  assert.equal(sen.choices.find((c) => c.name === 'Greg Levy').partyRaw, 'Other-part');
  assert.ok(!unmatched.some(([kind, v]) => kind === 'party' && v === 'Other-part'));
  assert.ok(!unmatched.some(([kind]) => kind === 'county'));
});

test('OH: units carry state + county FIPS, votes line up with choices', () => {
  const { r } = run();
  for (const race of r.races) {
    const st = race.units.filter((u) => u.level === 'state');
    assert.equal(st.length, 1, race.name);
    for (const u of race.units) {
      assert.equal(u.votes.length, race.choices.length, `${race.name} ${u.name}`);
      if (u.level === 'county') assert.match(u.countyFips, /^39\d{3}$/);
    }
  }
  const sen = r.races.find((x) => x.office === 'senate');
  const counties = sen.units.filter((u) => u.level === 'county').map((u) => u.name).sort();
  assert.deepEqual(counties, ['Adams', 'Franklin', 'Hamilton', 'Summit', 'Warren']);
  // Statewide contests: county precincts are the county's own; district slices get none (not published per district).
  assert.ok(sen.units.find((u) => u.name === 'Adams').precinctsTotal > 0);
  const h1 = r.races.find((x) => x.office === 'house' && x.district === '1');
  assert.equal(h1.units[0].precinctsTotal, null);
  assert.ok(h1.units.every((u) => u.precinctsReporting === null && u.pctReporting === null));
  assert.ok(h1.units.some((u) => u.name === 'Hamilton'));
  assert.ok(!r.races.some((x) => x.units.some((u) => u.methods)), 'Ohio only publishes Type=Total');
});

test('OH: statewide totals equal the sum of the published county rows in the trimmed fixture', () => {
  const { r } = run();
  for (const race of r.races.filter((x) => x.statewide)) {
    // The fixture keeps the real statewide row but only 5 counties, so state >= sum(counties).
    const st = race.units.find((u) => u.level === 'state');
    const cty = race.units.filter((u) => u.level === 'county');
    st.votes.forEach((v, i) => assert.ok(v >= cty.reduce((s, u) => s + u.votes[i], 0), race.name));
  }
});

test('OH: measure name, title, yes/no', () => {
  const { r } = run();
  const m = r.races.find((x) => x.office === 'measure');
  assert.equal(m.name, 'State Issue 3');
  assert.equal(m.title, 'State Issue 3 To require voters to present photo identification in order to vote');
  for (const u of m.units) {
    assert.equal(u.yes, u.votes[0]);
    assert.equal(u.no, u.votes[1]);
  }
});

test('OH: turnout (registered, ballots cast, outstanding absentee, precincts), state = county sum', () => {
  const { r } = run();
  const [st, ...cty] = r.turnout;
  assert.equal(st.level, 'state');
  assert.equal(cty.length, 5);
  const adams = cty.find((c) => c.name === 'Adams');
  assert.equal(adams.countyFips, '39001');
  assert.equal(adams.registered, 17079);
  assert.equal(adams.precinctsTotal, 21);
  assert.equal(adams.turnoutPct, null);
  for (const k of ['registered', 'ballotsOutstanding', 'precinctsReporting', 'precinctsTotal']) {
    assert.equal(st[k], cty.reduce((s, c) => s + c[k], 0), k);
  }
  // Ballots cast: the feed says 0 everywhere, but Franklin already has votes counted (Attorney General 162,804), so
  // its 0 is "not filled in yet" → null, and a statewide sum missing Franklin is no statewide number → null.
  assert.equal(cty.find((c) => c.name === 'Franklin').ballotsCast, null);
  assert.equal(adams.ballotsCast, 0); // nothing counted in Adams yet: the 0 stands
  assert.equal(st.ballotsCast, null);
});

test('OH: version ignores GeneratedDate; GeneratedDate 12-hour clock is corrected', () => {
  const a = cdfVersion(xml);
  assert.equal(cdfVersion(xml.replace(/GeneratedDate="[^"]*"/, 'GeneratedDate="2026-11-03T01:02:03Z"')), a);
  assert.notEqual(cdfVersion(xml.replace('Count="', 'Count="9')), a);
  const now = new Date('2026-11-03T23:53:04Z');
  assert.equal(fixGeneratedDate('2026-11-03T11:51:35Z', { hour12: true, now }), '2026-11-03T23:51:35.000Z');
  assert.equal(fixGeneratedDate('2026-11-03T09:10:00Z', { hour12: true, now: new Date('2026-11-03T09:12:00Z') }), '2026-11-03T09:10:00.000Z');
  // 00:15 UTC written as "12:15" on the new day
  assert.equal(fixGeneratedDate('2026-11-04T12:15:00Z', { hour12: true, now: new Date('2026-11-04T00:16:00Z') }), '2026-11-04T00:15:00.000Z');
  assert.equal(fixGeneratedDate('2026-11-03T11:51:35Z', { hour12: false, now }), '2026-11-03T11:51:35.000Z');
});

test('OH: every contest is emitted; target.races no longer filters what is stored', () => {
  const r = buildResult(xml, { ...target, races: ['senate'], measures: false }, { now: new Date('2026-11-04T03:00:00Z') });
  assert.equal(r.races.length, 5 + 5);
  assert.equal(r.election.sourceKey, 'OH-2026-general');
  assert.equal(r.election.date, '2026-11-03');
  const by = (re) => r.races.find((x) => re.test(x.name));

  const ag = by(/^Attorney General$/);
  assert.equal(ag.office, null, 'left for contests.js');
  assert.equal(ag.statewide, true);
  assert.equal(ag.voteFor, 1);
  assert.deepEqual(ag.units.map((u) => u.name), ['OH', 'Adams', 'Franklin', 'Hamilton', 'Summit', 'Warren']);
  assert.ok(ag.units.find((u) => u.name === 'Adams').precinctsTotal > 0);

  const sd7 = by(/^State Senator - District 07$/);
  assert.deepEqual([sd7.level, sd7.office, sd7.statewide], ['legislative', 'state_senate', false]); // from GpUnit Type="StateSenate"
  assert.equal(sd7.units[0].name, 'Senate District 7');
  assert.equal(sd7.units.filter((u) => u.level === 'county').length, 2);
  const hd24 = by(/^State Representative - District 24$/);
  assert.deepEqual([hd24.level, hd24.office], ['legislative', 'state_house']);

  const coa = by(/Court of Appeals - District 01/);
  assert.equal(coa.office, null);
  assert.equal(coa.statewide, false);
  assert.equal(coa.units[0].name, 'Appeals Court District 1');
  assert.ok(by(/Justice of the Supreme Court/).statewide);
});

// The V2 schema (itl.nist.gov/ns/voting/1500-100/v2): element-style fields, BallotCounts, per-type VoteCounts,
// FullText on measures, county FIPS codes, an ElectoralDistrictId. Minimal hand-written document.
const V2 = `<?xml version="1.0" encoding="UTF-8"?>
<ElectionReport xmlns="http://itl.nist.gov/ns/voting/1500-100/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Election>
    <BallotStyle/>
    <CandidateCollection>
      <Candidate ObjectId="c1"><BallotName><Text language="en">Jane Doe</Text></BallotName><PartyId>pD</PartyId></Candidate>
      <Candidate ObjectId="c2"><BallotName><Text language="en">John Roe</Text></BallotName><PartyId>pR</PartyId></Candidate>
    </CandidateCollection>
    <Contest ObjectId="k1" xsi:type="CandidateContest">
      <BallotSelection ObjectId="s1" xsi:type="CandidateSelection"><CandidateId>c1</CandidateId>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>150</Count></VoteCounts>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>early</Type><Count>60</Count></VoteCounts>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>election-day</Type><Count>40</Count></VoteCounts>
      </BallotSelection>
      <BallotSelection ObjectId="s2" xsi:type="CandidateSelection"><CandidateId>c2</CandidateId>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>120</Count></VoteCounts>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>early</Type><Count>20</Count></VoteCounts>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>election-day</Type><Count>30</Count></VoteCounts>
      </BallotSelection>
      <ElectoralDistrictId>st</ElectoralDistrictId>
      <Name>United States Senator</Name>
      <VotesAllowed>1</VotesAllowed>
    </Contest>
    <Contest ObjectId="m1" xsi:type="BallotMeasureContest">
      <BallotSelection ObjectId="y" xsi:type="BallotMeasureSelection"><Selection><Text language="en">Yes</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>7</Count></VoteCounts></BallotSelection>
      <BallotSelection ObjectId="n" xsi:type="BallotMeasureSelection"><Selection><Text language="en">No</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>3</Count></VoteCounts></BallotSelection>
      <ElectoralDistrictId>st</ElectoralDistrictId>
      <FullText><Text language="en">Shall the thing be done?</Text></FullText>
      <Name>Amendment 1</Name>
    </Contest>
    <Name><Text language="en">Test General</Text></Name>
    <StartDate>2026-11-03</StartDate>
  </Election>
  <GeneratedDate>2026-11-04T02:00:00Z</GeneratedDate>
  <GpUnit ObjectId="st" xsi:type="ReportingUnit"><Name>Ohio</Name><Type>state</Type></GpUnit>
  <GpUnit ObjectId="cy" xsi:type="ReportingUnit"><BallotCounts><Type>total</Type><BallotsCast>100</BallotsCast><BallotsOutstanding>12</BallotsOutstanding></BallotCounts>
    <ExternalIdentifiers><ExternalIdentifier><Type>fips</Type><Value>39035</Value></ExternalIdentifier></ExternalIdentifiers>
    <Name>Cuyahoga County</Name><Type>county</Type><VotersRegistered>900</VotersRegistered></GpUnit>
  <Party ObjectId="pD"><Abbreviation>DEM</Abbreviation><Name><Text language="en">Democratic</Text></Name></Party>
  <Party ObjectId="pR"><Abbreviation>REP</Abbreviation><Name><Text language="en">Republican</Text></Name></Party>
</ElectionReport>`;

test('generic CDF V2: element fields, methods per vote type, FullText title, FIPS codes, BallotCounts', () => {
  const p = parseCdf(V2, { state: 'OH' });
  assert.equal(p.generatedDate, '2026-11-04T02:00:00Z');
  assert.equal(p.electionDate, '2026-11-03');
  const sen = p.races.find((r) => r.office === 'senate');
  assert.deepEqual(sen.choices.map((c) => [c.name, c.party]), [['Jane Doe', 'DEM'], ['John Roe', 'REP']]);
  assert.ok(sen.statewide);
  assert.deepEqual(sen.units[0].votes, [150, 120]);
  const cy = sen.units.find((u) => u.level === 'county');
  assert.equal(cy.countyFips, '39035');
  assert.deepEqual(cy.votes, [100, 50]); // no Total row: sum of the per-type rows
  assert.deepEqual(cy.methods, [
    { label: 'early', bucket: 'mail_early', votes: [60, 20] },
    { label: 'election-day', bucket: 'election_day', votes: [40, 30] },
  ]);
  const m = p.races.find((r) => r.office === 'measure');
  assert.equal(m.name, 'Amendment 1');
  assert.equal(m.title, 'Shall the thing be done?');
  assert.equal(m.units[0].yes, 7);
  assert.equal(m.units[0].no, 3);
  const tc = p.turnout.find((t) => t.level === 'county');
  assert.equal(tc.registered, 900);
  assert.equal(tc.ballotsCast, 100);
  assert.equal(tc.ballotsOutstanding, 12);
  assert.equal(tc.precinctsTotal, null);
});

test('generic CDF: empty counts, missing attributes and collections do not throw', () => {
  const bare = `<?xml version="1.0"?><ElectionReport xmlns="http://itl.nist.gov/ns/voting/1500-100/v2"><Election><Name>x</Name></Election></ElectionReport>`;
  const p = parseCdf(bare, { state: 'OH' });
  assert.deepEqual(p.races, []);
  assert.deepEqual(p.turnout, []);
  const noCounts = xml.replace(/\s*<VoteCounts [^>]*>\s*<GpUnitId>[^<]*<\/GpUnitId>\s*<\/VoteCounts>/g, '').replace(/ VotersRegistered="\d+"/g, '');
  const r = buildResult(noCounts, target, { now: new Date('2026-11-04T03:00:00Z') });
  assert.ok(r.races.every((x) => x.units.length === 0));
  assert.equal(r.turnout[0].registered, null);
  assert.throws(() => parseCdf('<html></html>', { state: 'OH' }));
});

test('generic CDF: retention is a Yes/No candidate-style race, not a measure; local measures are kept', () => {
  const doc = V2
    .replace('<Name><Text language="en">Test General</Text></Name>', `
    <Contest ObjectId="r1" xsi:type="RetentionContest">
      <BallotSelection ObjectId="ry" xsi:type="BallotMeasureSelection"><Selection><Text language="en">Yes</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>60</Count></VoteCounts></BallotSelection>
      <BallotSelection ObjectId="rn" xsi:type="BallotMeasureSelection"><Selection><Text language="en">No</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>40</Count></VoteCounts></BallotSelection>
      <CandidateId>c1</CandidateId>
      <ElectoralDistrictId>st</ElectoralDistrictId>
      <Name>Supreme Court Justice Jane Doe</Name>
    </Contest>
    <Contest ObjectId="r2" xsi:type="BallotMeasureContest">
      <BallotSelection ObjectId="r2y" xsi:type="BallotMeasureSelection"><Selection><Text language="en">Yes</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>5</Count></VoteCounts></BallotSelection>
      <BallotSelection ObjectId="r2n" xsi:type="BallotMeasureSelection"><Selection><Text language="en">No</Text></Selection>
        <VoteCounts><GpUnitId>st</GpUnitId><Type>total</Type><Count>4</Count></VoteCounts></BallotSelection>
      <ElectoralDistrictId>st</ElectoralDistrictId>
      <Name>Shall Judge John Roe be retained in office?</Name>
    </Contest>
    <Contest ObjectId="lm" xsi:type="BallotMeasureContest">
      <BallotSelection ObjectId="ly" xsi:type="BallotMeasureSelection"><Selection><Text language="en">For the Levy</Text></Selection>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>total</Type><Count>9</Count></VoteCounts></BallotSelection>
      <BallotSelection ObjectId="ln" xsi:type="BallotMeasureSelection"><Selection><Text language="en">Against the Levy</Text></Selection>
        <VoteCounts><GpUnitId>cy</GpUnitId><Type>total</Type><Count>1</Count></VoteCounts></BallotSelection>
      <ElectoralDistrictId>sd</ElectoralDistrictId>
      <Name>Cuyahoga County Library Levy</Name>
    </Contest>
    <Contest ObjectId="sb" xsi:type="CandidateContest">
      <BallotSelection ObjectId="sb1" xsi:type="CandidateSelection"><CandidateId>c1</CandidateId>
        <VoteCounts><GpUnitId>sd</GpUnitId><Type>total</Type><Count>3</Count></VoteCounts></BallotSelection>
      <BallotSelection ObjectId="sb2" xsi:type="CandidateSelection"><CandidateId>c2</CandidateId>
        <VoteCounts><GpUnitId>sd</GpUnitId><Type>total</Type><Count>2</Count></VoteCounts></BallotSelection>
      <ElectoralDistrictId>sd</ElectoralDistrictId>
      <Name>Board Member, Euclid City Schools</Name>
      <NumberElected>3</NumberElected>
      <VotesAllowed>3</VotesAllowed>
    </Contest>
    <Name><Text language="en">Test General</Text></Name>`)
    .replace('<Party ObjectId="pD">', '<GpUnit ObjectId="sd" xsi:type="ReportingUnit"><Name>Euclid City School District</Name><Type>school</Type></GpUnit>\n  <Party ObjectId="pD">');
  const p = parseCdf(doc, { state: 'OH' });
  for (const key of ['r1', 'r2']) {
    const ret = p.races.find((r) => r.key === key);
    assert.equal(ret.office, null, `${key} is not a measure`);
    assert.equal(ret.kind, 'retention');
    assert.deepEqual(ret.choices.map((c) => c.name), ['Yes', 'No']);
    assert.equal(ret.units[0].yes, undefined);
  }
  assert.deepEqual(p.races.find((r) => r.key === 'r1').units[0].votes, [60, 40]);
  const levy = p.races.find((r) => r.key === 'lm');
  assert.deepEqual([levy.office, levy.statewide], ['measure', false]);
  assert.deepEqual([levy.units[0].yes, levy.units[0].no], [9, 1]);
  const board = p.races.find((r) => r.key === 'sb');
  assert.deepEqual([board.level, board.office, board.voteFor, board.statewide], ['local', 'school_board', 3, false]);
});

// Live Ohio feed at 01:06Z (GeneratedDate written as 12:48/01:06 on a 12-hour clock): 1.3M votes counted, but every
// county's <SummaryCounts Type="Total" BallotsCast="0"/> and VotersParticipated="0" are not filled in yet.
const live = readFileSync(fileURLToPath(new URL('./fixtures/nistcdf/oh-2026-general-live-0106z.xml', import.meta.url)), 'utf8');

test('OH live: a 0 "ballots cast" next to counted votes is not published yet (null), never 0', () => {
  const r = buildResult(live, target, { now: new Date('2026-11-04T01:10:00Z') });
  const sen = r.races.find((x) => x.office === 'senate');
  const st = sen.units.find((u) => u.level === 'state');
  assert.equal(st.votes.reduce((a, b) => a + b, 0), 1337268); // matches the feed's own statewide Senate total
  const stT = r.turnout.find((t) => t.level === 'state');
  assert.equal(stT.ballotsCast, null);
  assert.equal(stT.registered, 8018054);
  const votedCounties = new Set(sen.units.filter((u) => u.level === 'county' && u.votes.some((v) => v > 0)).map((u) => u.countyFips));
  assert.ok(votedCounties.size > 10);
  for (const t of r.turnout.filter((x) => x.level === 'county')) {
    if (votedCounties.has(t.countyFips)) assert.equal(t.ballotsCast, null, `${t.name}: votes counted, ballots cast not published`);
    else assert.ok(t.ballotsCast === 0 || t.ballotsCast === null, `${t.name}: ${t.ballotsCast}`);
  }
});

test('OH: a 0 "ballots cast" with no votes counted yet stays 0 (pre-results)', () => {
  const p = parseCdf(live.replace(/Count="\d+"/g, 'Count="0"'), { state: 'OH' });
  const tc = p.turnout.find((t) => t.level === 'county');
  assert.equal(tc.ballotsCast, 0);
});
