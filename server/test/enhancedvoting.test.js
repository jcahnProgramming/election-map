// Enhanced Voting adapter (GA, VA, UT, WA, RI, ID). Fixtures are real payloads saved on 2026-11-03 shortly before
// polls closed, trimmed to the federal contests, the statewide measures, a few local/negative cases and a few localities.
// Nothing was counted yet, so tests that need numbers write counts into a copy of the real structure (withCounts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseElection, selectItems, resolveLocality, measureSide, parseVoteFor } from '../src/adapters/enhancedvoting.js';
import { enrichRaces } from '../src/contests.js';

const load = (st) => JSON.parse(readFileSync(new URL(`./fixtures/enhancedvoting/${st}.json`, import.meta.url), 'utf8'));
const bdMap = (fx) => new Map(fx._breakdown ? [[fx._breakdown.id, fx._breakdown]] : []);
const parse = (st, opts = {}) => {
  const fx = load(st);
  const unmatched = [];
  const r = parseElection(fx, bdMap(fx), {
    state: st.toUpperCase(), counties: true, unmatched: (...a) => unmatched.push(a), ...opts,
  });
  return { ...r, unmatched, fx };
};
const byOffice = (races, office) => races.filter((r) => r.office === office);

/** Put deterministic counts into a copy: option i gets (i+1)*base, split over its count groups; breakdown rows too. */
function withCounts(fx, base = 100) {
  const c = structuredClone(fx);
  const fill = (options, scale) => options.forEach((o, i) => {
    o.voteCount = (i + 1) * base * scale;
    (o.groupResults ?? []).forEach((g, k, all) => { g.voteCount = k === 0 ? o.voteCount - (all.length - 1) * scale : scale; });
  });
  for (const b of c.ballotItems) {
    fill(b.summaryResults.ballotOptions, 10);
    b.voteTotal = b.summaryResults.ballotOptions.reduce((s, o) => s + o.voteCount, 0);
  }
  for (const r of c._breakdown?.breakdownResults ?? []) {
    fill(r.ballotOptions, 1);
    r.precinctReportingStatus.reportingUnits = Math.floor(r.precinctReportingStatus.totalUnits / 2);
  }
  c.election.ballotsCast = 4321;
  for (const s of c.statistics ?? []) for (const g of s.groups ?? []) {
    g.value = 999;
    (g.children ?? []).forEach((ch, i) => { ch.value = 10 + i; });
  }
  return c;
}

test('GA: Senate, Governor, 14 House districts, 3 amendments, and every other contest (Lt. Gov) too', () => {
  const { races, unmatched, fx } = parse('ga');
  assert.equal(races.length, fx.ballotItems.length, 'every ballot item is emitted');
  assert.equal(byOffice(races, 'senate').length, 1);
  assert.equal(byOffice(races, 'governor').length, 1);
  const house = byOffice(races, 'house');
  assert.deepEqual(house.map((r) => r.district), Array.from({ length: 14 }, (_, i) => String(i + 1)));
  assert.equal(byOffice(races, 'measure').length, 3);
  const lg = races.find((r) => r.name === 'Lieutenant Governor');
  assert.equal(lg.office, null, 'not a headline office: left for enrichRaces');
  assert.equal(lg.voteFor, 1);
  assert.deepEqual(lg.choices.map((c) => c.party).sort(), ['DEM', 'REP']);
  assert.deepEqual(unmatched, []);
  enrichRaces({ election: { scope: 'state' }, races }, 'enhancedvoting');
  assert.deepEqual([lg.level, lg.office, lg.kind], ['statewide', 'lieutenant_governor', 'partisan']);
});

test('GA with counts: a non-headline contest keeps its statewide votes and methods, no county breakdown', () => {
  const fx = withCounts(load('ga'));
  const { races } = parseElection(fx, bdMap(fx), { state: 'GA', counties: true, unmatched: () => {} });
  const lg = races.find((r) => r.name === 'Lieutenant Governor');
  assert.deepEqual(lg.units.map((u) => u.level), ['state']);
  assert.deepEqual(lg.units[0].votes, [1000, 2000]);
  assert.equal(lg.units[0].methods.length, 4);
});

test('GA: party from the party object, clean names (no "(Rep)" suffix, no incumbent "(I)")', () => {
  const { races } = parse('ga');
  const senate = byOffice(races, 'senate')[0];
  assert.deepEqual(senate.choices, [
    { name: 'Mike Collins', party: 'REP', partyRaw: 'Rep' },
    { name: 'Jon Ossoff', party: 'DEM', partyRaw: 'Dem' },
  ]);
  assert.equal(senate.voteFor, 1);
  assert.equal(senate.statewide, true);
});

test('GA: county units come from the breakdown, with FIPS and precinct counts; statewide precincts are their sum', () => {
  const { races } = parse('ga');
  const senate = byOffice(races, 'senate')[0];
  const counties = senate.units.filter((u) => u.level === 'county');
  assert.equal(counties.length, 5);
  const fulton = counties.find((u) => u.name === 'Fulton');
  assert.equal(fulton.countyFips, '13121');
  assert.equal(fulton.precinctsTotal, 437);
  assert.equal(fulton.precinctsReporting, 0);
  assert.equal(fulton.pctReporting, 0);
  const st = senate.units[0];
  assert.equal(st.level, 'state');
  assert.equal(st.precinctsTotal, 9 + 86 + 148 + 191 + 437);
  // contests without a breakdown: precincts unknown → null, not 0
  const gov = byOffice(races, 'governor')[0];
  assert.equal(gov.units.length, 1);
  assert.equal(gov.units[0].precinctsReporting, null);
  assert.equal(gov.units[0].pctReporting, null);
});

test('GA: vote methods keep the source labels, in countGroups order, and bucket them', () => {
  const { races } = parse('ga');
  const m = byOffice(races, 'senate')[0].units[0].methods;
  assert.deepEqual(m.map((x) => [x.label, x.bucket]), [
    ['Election Day', 'election_day'], ['Advance Voting', 'mail_early'], ['Absentee by Mail', 'mail_early'], ['Provisional', 'provisional'],
  ]);
});

test('GA with counts: statewide + county votes, method splits (keyed by group id), yes/no, ballotsCast', () => {
  const fx = withCounts(load('ga'));
  const { races, turnout } = parseElection(fx, bdMap(fx), { state: 'GA', counties: true, unmatched: () => {} });
  const senate = byOffice(races, 'senate')[0];
  assert.deepEqual(senate.units[0].votes, [1000, 2000]);
  const m = senate.units[0].methods;
  assert.deepEqual(m.map((x) => x.votes.reduce((a, b) => a + b, 0)), [3000 - 60, 20, 20, 20]);
  const fulton = senate.units.find((u) => u.name === 'Fulton');
  assert.deepEqual(fulton.votes, [100, 200]);
  assert.equal(fulton.precinctsReporting, 218);
  assert.equal(fulton.pctReporting, 49.9);
  // breakdown rows list groups in a different order than the summary (and per option); they're matched by group id
  assert.deepEqual(fulton.methods.map((x) => x.label), ['Election Day', 'Advance Voting', 'Absentee by Mail', 'Provisional']);
  for (let i = 0; i < 2; i++) assert.equal(fulton.methods.reduce((s, x) => s + x.votes[i], 0), fulton.votes[i]);
  const firstGroupOf0 = load('ga')._breakdown.breakdownResults.find((r) => r.locality.name[0].text === 'Fulton County').ballotOptions[0].groupResults[0].groupName[0].text;
  assert.equal(fulton.methods.find((x) => x.label === firstGroupOf0).votes[0], 97);
  const am1 = byOffice(races, 'measure')[0];
  assert.equal(am1.units[0].yes, 1000);
  assert.equal(am1.units[0].no, 2000);
  assert.deepEqual(am1.units[0].methods[1].votes, [10, 10]); // measures: methods votes = [yes, no]
  assert.equal(turnout[0].ballotsCast, 4321);
});

test('GA turnout: registered from voter registration, nothing invented', () => {
  const { turnout, sourceUpdatedAt, fx } = parse('ga');
  const st = turnout.find((t) => t.level === 'state');
  // election.totalVoters is 0 tonight, so the statewide figure is the sum of the per-locality registration rows
  assert.equal(st.registered, fx.voterRegistration.reduce((s, v) => s + v.total, 0));
  assert.ok(st.registered > 1_000_000);
  assert.equal(st.ballotsCast, null);
  assert.equal(st.turnoutPct, null);
  assert.equal(st.ballotsOutstanding, null);
  const appling = turnout.find((t) => t.name === 'Appling');
  assert.equal(appling.countyFips, '13001');
  assert.equal(appling.registered, 12026);
  assert.equal(sourceUpdatedAt, '2026-11-03T17:03:41.263Z');
});

test('county turnoutPercent is a 0-1 share at the source: served as 0-100 like every other source', () => {
  // Live 2026-11-04: Brunswick, VA turnoutPercent 0.5227451 = 6,010 ballots cast / 11,497 registered (set on a fixture county).
  const fx = withCounts(load('va'));
  const loc = fx.jurisdiction.childLocalities.find((l) => /accomack/i.test(l.name?.[0]?.text ?? ''));
  assert.ok(loc, 'fixture has Accomack');
  loc.turnoutPercent = 0.5227451;
  const { turnout } = parseElection(fx, bdMap(fx), { state: 'VA', counties: true, unmatched: () => {} });
  const row = turnout.find((t) => t.name === 'Accomack');
  assert.equal(row.turnoutPct, 52.27);
  // Nothing counted yet: no turnout figure even if the source sends one.
  const quiet = load('va');
  quiet.jurisdiction.childLocalities.find((l) => /accomack/i.test(l.name?.[0]?.text ?? '')).turnoutPercent = 0.5;
  const q = parseElection(quiet, bdMap(quiet), { state: 'VA', counties: true, unmatched: () => {} });
  assert.equal(q.turnout.find((t) => t.name === 'Accomack')?.turnoutPct ?? null, null);
});

test('VA: "Member, United States Senate" / "Member, House of Representatives (1st District)" classify', () => {
  const { races } = parse('va');
  assert.equal(byOffice(races, 'senate').length, 1);
  assert.deepEqual(byOffice(races, 'house').map((r) => r.district), Array.from({ length: 11 }, (_, i) => String(i + 1)));
  assert.equal(byOffice(races, 'measure').length, 3);
  const h7 = byOffice(races, 'house').find((r) => r.district === '7');
  assert.deepEqual(h7.choices.map((c) => `${c.party}/${c.partyRaw}`), ['DEM/D', 'REP/R', 'OTHER/L', 'OTHER/I', 'OTHER/I', 'OTHER/I', 'OTHER/']);
});

test('VA: independent cities map to their own FIPS, never to the same-named county', () => {
  const { races, unmatched } = parse('va');
  const fips = Object.fromEntries(byOffice(races, 'senate')[0].units.filter((u) => u.level === 'county').map((u) => [u.name, u.countyFips]));
  assert.deepEqual(fips, {
    Accomack: '51001', 'Fairfax city': '51600', Fairfax: '51059', 'James City': '51095',
    'Richmond city': '51760', Richmond: '51159', 'Roanoke city': '51770',
  });
  assert.deepEqual(unmatched, []);
  assert.equal(resolveLocality('VA', 'FRANKLIN CITY').fips, '51620');
  assert.equal(resolveLocality('VA', 'FRANKLIN COUNTY').fips, '51067');
  assert.equal(resolveLocality('VA', 'CHARLES CITY COUNTY').fips, '51036');
});

test('VA: five vote methods incl. Post-Election (bucket other)', () => {
  const { races } = parse('va');
  const m = byOffice(races, 'senate')[0].units[0].methods;
  assert.deepEqual(m.map((x) => `${x.label}:${x.bucket}`),
    ['Early Voting:mail_early', 'Election Day:election_day', 'Mailed Absentee:mail_early', 'Provisional:provisional', 'Post-Election:other']);
});

test('UT: 4 House districts, FOR/AGAINST amendments, state senate and judicial retention as contests, no methods', () => {
  const { races, unmatched, turnout } = parse('ut');
  assert.deepEqual(byOffice(races, 'house').map((r) => `${r.office}${r.district}`), ['house1', 'house2', 'house3', 'house4']);
  const measures = byOffice(races, 'measure');
  assert.deepEqual(measures.map((r) => r.name), ['Constitutional Amendment A', 'Constitutional Amendment B']);
  assert.equal(races.length, 14, '15 items, one listed twice under the same id');
  assert.equal(new Set(races.map((r) => r.key)).size, races.length);
  assert.equal(races[0].units[0].methods, undefined);
  // unknown third-party label is reported, not dropped
  assert.ok(!unmatched.some(([kind, v]) => kind === 'party' && v === 'Independent American'));
  const bowen = byOffice(races, 'house')[1].choices.find((c) => c.name === 'CARLTON E. BOWEN');
  assert.deepEqual(bowen, { name: 'CARLTON E. BOWEN', party: 'OTHER', partyRaw: 'Independent American' });
  // UT publishes zero registration: null, not 0
  assert.equal(turnout[0].registered, null);
});

test('WA: 10 House districts, statewide initiatives with titles, local measures marked statewide:false', () => {
  const { races } = parse('wa');
  assert.equal(byOffice(races, 'house').length, 10);
  const measures = byOffice(races, 'measure');
  const statewide = measures.filter((r) => r.statewide);
  assert.deepEqual(statewide.map((r) => r.name), ['Initiative Measure No. IP26-645', 'Initiative Measure No. IL26-001', 'Initiative Measure No. IL26-638']);
  assert.match(statewide[0].title, /^Initiative Measure No\. IP26-645 concerns state and local taxes\./);
  assert.ok(!statewide[0].title.includes('<'));
  assert.ok(measures.some((r) => !r.statewide));
  assert.ok(measures.filter((r) => !r.statewide).every((r) => r.units.length === 1));
});

test('WA: ballots left to count is null before counting, then statewide and per county', () => {
  const { turnout } = parse('wa');
  assert.ok(turnout.every((t) => t.ballotsOutstanding === null));
  const fx = withCounts(load('wa'));
  const t2 = parseElection(fx, new Map(), { state: 'WA', counties: true, unmatched: () => {} }).turnout;
  assert.equal(t2[0].ballotsOutstanding, 999);
  assert.ok(t2.filter((t) => t.level === 'county').every((t) => typeof t.ballotsOutstanding === 'number'));
});

test('RI: statewide only (towns have no county), Approve/Reject bonds, town questions local', () => {
  const { races, turnout, fx } = parse('ri', { counties: false });
  assert.deepEqual(races.filter((r) => r.office !== 'measure').map((r) => r.office + (r.district ?? '')), ['senate', 'house1', 'house2', 'governor', 'null']);
  assert.ok(races.every((r) => r.units.every((u) => u.level === 'state')));
  assert.ok(turnout.every((t) => t.level === 'state'));
  const reed = byOffice(races, 'senate')[0].choices.find((c) => c.party === 'DEM');
  assert.deepEqual(reed, { name: 'John F. Reed', party: 'DEM', partyRaw: 'DEM' });
  const bonds = byOffice(races, 'measure').filter((r) => r.statewide);
  assert.equal(bonds.length, 5);
  const local = byOffice(races, 'measure').filter((r) => !r.statewide);
  assert.ok(local.length >= 1 && local.every((r) => /:/.test(r.name)));
  const counted = withCounts(fx);
  const b1 = byOffice(parseElection(counted, new Map(), { state: 'RI', counties: false }).races, 'measure')[0];
  assert.deepEqual([b1.units[0].yes, b1.units[0].no], [1000, 2000]);
});

test('ID: Senate, Governor, 2 House, 3 statewide measures; multiple-choice advisory question kept as a contest', () => {
  const { races } = parse('id');
  assert.deepEqual(races.filter((r) => r.office !== 'measure').map((r) => r.office + (r.district ?? '')), ['senate', 'house1', 'house2', 'governor', 'null', 'null']);
  const sw = byOffice(races, 'measure').filter((r) => r.statewide);
  assert.equal(sw.length, 3);
  assert.ok(sw.every((r) => r.title && r.title.length > 20));
  assert.ok(sw.every((r) => r.voteFor === null), '"Requires 50% + 1 vote to pass" is not a vote-for count');
  const adv = races.filter((r) => /Advisory/.test(r.name));
  assert.equal(adv.length, 1, 'listed twice in the feed under one id, stored once');
  assert.equal(adv[0].office, null);
  assert.equal(adv[0].choices.length, 6);
  // the levy questions' choices are long "IN FAVOR OF ..." / "AGAINST ..." sentences
  const levy = byOffice(races, 'measure').find((r) => !r.statewide);
  assert.ok(levy);
});

test('measureSide understands every label seen tonight', () => {
  for (const y of ['Yes', 'YES', 'FOR', 'Approve', 'Approved', 'Levy Yes', 'Levy  Yes', 'IN FAVOR OF authorizing a levy', 'YES, I AM IN FAVOR OF ...']) assert.equal(measureSide(y), 'yes', y);
  for (const n of ['No', 'NO', 'AGAINST', 'Reject', 'Rejected', 'Levy No', 'AGAINST authorizing a levy', 'NO, I AM AGAINST ...']) assert.equal(measureSide(n), 'no', n);
  assert.equal(measureSide('Winchester Model 1894 (.30-30)'), null);
});

test('selectItems keeps every item; the target race list only picks the headline (county-breakdown) contests', () => {
  const fx = load('ga');
  const onlySenate = selectItems(fx, { races: ['senate'], measures: false });
  assert.equal(onlySenate.length, fx.ballotItems.length);
  assert.deepEqual(onlySenate.filter((x) => x.headline).map((x) => x.office), ['senate']);
  const all = selectItems(fx, adapter.targets().find((t) => t.state === 'GA'));
  assert.equal(all.filter((x) => x.headline).length, 1 + 1 + 14 + 3);
  assert.ok(!all.find((x) => x.item.name[0].text === 'Lieutenant Governor').headline);
});

test('UT: judicial retention is a Yes/No contest, not a measure; enrichRaces makes it judicial / retention', () => {
  const fx = withCounts(load('ut'));
  const { races } = parseElection(fx, new Map(), { state: 'UT', counties: true, unmatched: () => {} });
  const ret = races.filter((r) => /retained/.test(r.name));
  assert.equal(ret.length, 7);
  for (const r of ret) {
    assert.equal(r.office, null);
    assert.deepEqual(r.choices.map((c) => c.name).sort(), ['NO', 'YES']);
    assert.ok(r.choices.every((c) => c.party === 'OTHER' && c.partyRaw === ''));
    assert.equal(r.units[0].yes, undefined, 'per-choice votes, no yes/no fields');
    assert.deepEqual(r.units[0].votes, [1000, 2000]); // in the feed's own choice order
  }
  const senate = races.find((r) => /^State Senate/.test(r.name));
  assert.equal(senate.office, null);
  assert.equal(senate.units[0].votes.length, senate.choices.length);
  const unclassified = enrichRaces({ election: { scope: 'state' }, races }, 'enhancedvoting');
  assert.deepEqual(unclassified, []);
  for (const r of ret) assert.deepEqual([r.level, r.kind], ['judicial', 'retention']);
  assert.ok(ret.some((r) => r.office === 'supreme_court') && ret.some((r) => r.office === 'appeals_court'));
  assert.deepEqual([senate.level, senate.office, senate.district], ['legislative', 'state_senate', '1']);
});

test('WA: state legislative position kept; voteFor text that is not a count is null', () => {
  const { races } = parse('wa');
  const leg = races.find((r) => /^Legislative District 1/.test(r.name));
  assert.equal(leg.office, null);
  assert.equal(leg.voteFor, null, 'WA puts the contest group ("LEGISLATIVE") in voteFor');
  enrichRaces({ election: { scope: 'state' }, races }, 'enhancedvoting');
  assert.deepEqual([leg.level, leg.office], ['legislative', 'state_house']);
});

test('parseVoteFor: counts in words or digits, nothing from unrelated text', () => {
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Vote for 1' }]), 1);
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Vote for only one' }]), 1);
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Vote for up to 3' }]), 3);
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Vote for no more than two' }]), 2);
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Requires 50% + 1 vote to pass' }]), null);
  assert.equal(parseVoteFor([{ languageId: 'en', text: 'Congressional' }]), null);
  assert.equal(parseVoteFor([]), null);
});

test('fetch(): cheap metadata check, change detection by content, breakdowns only once votes exist', async () => {
  const fx = load('ga');
  const calls = [];
  let data = fx;
  const http = {
    async getJson(url) {
      calls.push(url.replace(/^https:\/\/[^/]+\/results\/public\/api\/elections\/Georgia\/[^/]+/, ''));
      if (url.endsWith('/data')) return { json: data };
      if (url.includes('/data/ballot-item/')) return { json: { ballotItemWithBreakdown: data._breakdown } };
      return { json: data.election };
    },
  };
  const target = { ...adapter.targets().find((t) => t.state === 'GA'), key: 'test/ga-fetch' };
  const ctx = { http, log: { warn() {} }, unmatched() {} };

  const r1 = await adapter.fetch(target, ctx);
  assert.equal(r1.changed, true);
  assert.equal(r1.result.election.state, 'GA');
  assert.equal(r1.result.election.url, target.url);
  assert.equal(r1.result.sourceUpdatedAt, '2026-11-03T17:03:41.263Z');
  assert.deepEqual(calls, ['', '/data']); // no breakdowns while nothing is counted

  calls.length = 0;
  const r2 = await adapter.fetch(target, ctx);
  assert.equal(r2.changed, false);
  assert.deepEqual(calls, ['']); // metadata unchanged → /data not re-read

  // new results published: metadata changes, counts appear, breakdowns are fetched for the contests with votes
  data = withCounts(fx);
  data.election = { ...data.election, publishVersionId: 'v2', asOf: '2026-11-04T00:30:00Z' };
  calls.length = 0;
  const r3 = await adapter.fetch(target, ctx);
  assert.equal(r3.changed, true);
  assert.notEqual(r3.version, r1.version);
  assert.equal(r3.result.sourceUpdatedAt, '2026-11-04T00:30:00.000Z');
  assert.ok(calls.filter((c) => c.includes('/ballot-item/')).length >= 1);
  const senate = r3.result.races.find((r) => r.office === 'senate');
  assert.ok(senate.units.some((u) => u.level === 'county'));
  for (const r of r3.result.races) for (const c of r.choices) assert.ok(!('winner' in c) && !('isWinner' in c));
});

test('targets(): one per enabled config entry, each with the human results URL', () => {
  const ts = adapter.targets();
  assert.deepEqual(ts.map((t) => t.state).sort(), ['GA', 'ID', 'RI', 'UT', 'VA', 'WA']);
  for (const t of ts) assert.match(t.url, /^https:\/\/[^/]+\/results\/public\/[^/]+\/elections\//);
  assert.equal(ts.find((t) => t.state === 'RI').counties, false);
  assert.ok(ts.every((t) => t.allContests === true));
});
