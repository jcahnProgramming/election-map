// Parser tests against real Maryland SBE county pages captured on election night 2026-11-03 (before results: every
// number "NR"): Allegany, Baltimore City, Montgomery. One test injects numbers to check sums and the method split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import adapter, { parseMdCountyPages, parseCountyPage, parseRefreshed } from '../src/adapters/mdsbe.js';
import { enrichRaces } from '../src/contests.js';

const read = (f) => readFileSync(new URL(`./fixtures/mdsbe/${f}`, import.meta.url), 'utf8');
const pages = () => [read('md-county-1.html'), read('md-county-3.html'), read('md-county-16.html')];
const t = adapter.targets()[0];

/** Fill one candidate's row (first occurrence after `after`) with numbers: methods..., total. */
function fill(html, after, name, values, precincts) {
  const a = html.indexOf(after);
  const i = html.indexOf(name, a);
  const end = html.indexOf('</tr>', i);
  let k = 0;
  const row = html.slice(i, end).replace(/> ?NR<\/td>/g, () => `> ${values[k++] ?? '0'}</td>`);
  let out = html.slice(0, i) + row + html.slice(end);
  if (precincts) {
    const p = out.indexOf('election day precincts reported)', a);
    const s = out.lastIndexOf('(', p);
    out = out.slice(0, s) + out.slice(s, p).replace(/^\(\d+ of/, `(${precincts} of`) + out.slice(p);
  }
  return out;
}

test('targets(): config, Baltimore City by FIPS', () => {
  assert.equal(t.key, 'MD/2026GG');
  assert.deepEqual(t.countyFips['Baltimore City'], { fips: '24510', name: 'Baltimore City' });
  assert.ok(t.multiCounty.test('Representative in Congress') && !t.multiCounty.test('Sheriff') && !t.multiCounty.test('Question A: Bond Issue'));
});

test('parseRefreshed: "Last refreshed" in Eastern time', () => {
  assert.equal(parseRefreshed(read('md-governor.html')), '2026-11-03T21:24:46.000Z');
  assert.equal(parseRefreshed('nothing'), null);
});

test('parseCountyPage: office, district / judge headings, vote for, precincts, columns', () => {
  const p = parseCountyPage(read('md-county-3.html'));
  assert.equal(p.county, 'Baltimore City');
  assert.equal(p.contests.length, 35);
  assert.deepEqual(p.contests[0].headers, ['Name', 'Party', 'Early Voting', 'Election Day', 'Mail-In Ballot', 'Provisional', 'Total', 'Percentage']);
  const d43a = p.contests.find((c) => c.office === 'House of Delegates' && c.sub === 'District 43A');
  assert.equal(d43a.voteFor, 2);
  assert.deepEqual([d43a.pr, d43a.pt], [0, 42]);
  assert.equal(p.contests.find((c) => /Appellate/.test(c.office)).sub, 'Dan Friedman');
});

test('contests: statewide sums, districts across counties, local contests kept per county, no unmatched', () => {
  const un = [];
  const r = parseMdCountyPages(pages(), t, (...a) => un.push(a));
  assert.deepEqual(un, []);
  assert.equal(r.races.length, 87);
  const gov = r.races.find((x) => x.office === 'governor');
  assert.equal(gov.statewide, true);
  assert.equal(gov.units.length, 4);
  assert.ok(gov.units.some((u) => u.countyFips === '24510' && u.name === 'Baltimore City'));
  assert.deepEqual(gov.choices.map((c) => c.party), ['DEM', 'REP', 'OTHER', 'OTHER', 'OTHER']);
  assert.deepEqual(gov.units[0].methods.map((m) => m.bucket), ['mail_early', 'election_day', 'mail_early', 'provisional']);
  const h6 = r.races.find((x) => x.name === 'Representative in Congress District 6');
  assert.equal(h6.office, 'house');
  assert.equal(h6.district, '6');
  assert.equal(h6.units.length, 3, 'Allegany + Montgomery');
  // Local contests with the same name in two counties are two contests, never summed.
  const sheriffs = r.races.filter((x) => /: Sheriff$/.test(x.name));
  assert.ok(sheriffs.length >= 2);
  assert.ok(sheriffs.every((x) => x.units.length === 2 && !x.statewide));
  const q1 = r.races.find((x) => x.name === 'Question 1: Constitutional Amendment');
  assert.equal(q1.office, 'measure');
  assert.match(q1.title, /Arbitration Reform for State Employees Act of 2026/);
  enrichRaces(r, 'mdsbe');
  assert.ok(!r.races.some((x) => x.level === 'unclassified'), r.races.filter((x) => x.level === 'unclassified').map((x) => x.name).join(', '));
  assert.equal(r.races.find((x) => /Appellate/.test(x.name)).level, 'judicial');
});

test('sums: county numbers add up, methods per county and statewide, precincts', () => {
  const [a, b, c] = pages();
  const a2 = fill(fill(a, '<h2>Governor', 'Wes Moore', ['10', '20', '30', '1', '61', '55.0%'], 5), '<h2>Governor', 'Dan Cox', ['5', '40', '4', '1', '50', '45.0%']);
  const b2 = fill(b, '<h2>Governor', 'Wes Moore', ['1,000', '2,000', '3,000', '10', '6,010', '90%'], 100);
  const r = parseMdCountyPages([a2, b2, c], t);
  const gov = r.races.find((x) => x.office === 'governor');
  assert.deepEqual(gov.units[0].votes.slice(0, 2), [6071, 50]);
  const base = parseMdCountyPages(pages(), t).races.find((x) => x.office === 'governor');
  assert.deepEqual([gov.units[0].precinctsReporting, gov.units[0].precinctsTotal], [105, base.units[0].precinctsTotal]);
  assert.equal(base.units[0].precinctsTotal, 30 + 295 + 257); // Allegany + Baltimore City + Montgomery
  assert.deepEqual(gov.units[0].methods[1].votes.slice(0, 2), [2020, 40]);
  const alle = gov.units.find((u) => u.name === 'Allegany');
  assert.deepEqual(alle.votes.slice(0, 2), [61, 50]);
  assert.equal(alle.pctReporting, 16.7);
});
