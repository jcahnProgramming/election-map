// Florida Division of Elections election-night results.
//
// 2026 general: published on Florida Election Watch (https://floridaelectionwatch.gov, named in the Secretary of
// State's readiness release); results.elections.myflorida.com never listed the general. Its /Downloads page links
// https://flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt?v=<page render time>. The ?v=
// changes on every page load and the plain URL (no ?v=) serves a stale cached copy, so we always use the page's own
// current link, HEAD it, and download (~360 KB) only when the blob's ETag / Last-Modified changes.
// Older elections: the ResultsExtract.Asp download (extractUrl) with the same layout.
//
// One tab-separated file per election date:
//   ElectionDate  PartyCode  PartyName  RaceCode  OfficeDesc|RaceName  CountyCode  CountyName  Juris1num  Juris2num
//   Precincts  PrecinctsReporting  CanNameLast  CanNameFirst  CanNameMiddle  CanVotes
// Joint tickets (Governor and Lieutenant Governor): one row per ticket with surnames only, CanNameFirst = the
// top-of-ticket candidate ("Donalds"), CanNameLast = the running mate ("Avila"). Stored as name "Donalds",
// runningMate "Avila"; the file has no first names for tickets, so none are invented.
// One row per county x candidate (amendments: one row per county x Yes/No). Juris1num is the district for
// district races. There is no statewide row, no turnout, no vote-type split and no "last updated" stamp in
// the file, so: state unit = sum of the county rows of one race; turnout / methods / sourceUpdatedAt = null.
// Every contest in the extract is stored (federal, statewide, legislative, multi-county, judicial retention, amendments).
// The state extract is the Division's own contests: county and municipal contests are on the 67 county Supervisor of
// Elections sites, so targets say allContests:false. Judicial retention ("Retain ...? Yes/No") is a candidate-style
// race with Yes / No choices, never a measure.
// Change detection: content hash. A header-only file writes nothing (no snapshot), because an empty snapshot
// would read as "no race for this office".
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide } from '../normalize.js';

const JUDICIAL = /\b(retain|retention|justice|judge|court)\b/i;
import { matchCounty } from '../geo.js';

const lastVersion = new Map();
const sawVotes = new Map(); // target key → true once a file with votes was stored

function targets() {
  const cfg = readConfig('sources/fldos.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: e.id,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      levels: ['state', 'county'],
      // Headline races expected (coverage). Every contest in the extract is stored whatever this says.
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      allContests: e.allContests ?? false,
      extractUrl: e.extractUrl ?? null,
      downloadsUrl: e.downloadsUrl ?? null,
      fileName: e.fileName ?? null,
      ticketNames: e.ticketNames?.names ?? null,
      url: e.url,
      date: e.date ?? null,
    }));
}

const int = (v) => {
  const s = String(v ?? '').replace(/[,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (r, t) => (t ? round1((100 * (r ?? 0)) / t) : null);

/** TSV text → array of row objects keyed by the header. Tolerates CRLF, a BOM and trailing blank lines. */
export function parseTsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

/** Joint-ticket contests: the top of the ticket is in CanNameFirst, the running mate in CanNameLast. */
const TICKET = /\band\s+(lieutenant|lt\.?|vice)\b/i;

/** Florida party codes we know (minor parties / no party / nonpartisan / write-in → OTHER). REP and DEM as usual. */
const FL_OTHER = new Set(['NPA', 'LPF', 'WRI', 'NOP', 'ASP', 'CPF', 'FFP', 'MGT', 'IND', 'GRE', 'ECO', 'PSL', 'REF']);

/** "Amendment 1: Some title" / "Amendment No. 2 - Title" → short name; full text kept as the title. */
function measureNames(desc) {
  const m = desc.match(/^((?:constitutional\s+)?amendment\s*(?:no\.?\s*)?\d+[a-z]?|question\s*\d+|referendum\s*\d*)\s*[-:–]\s*(.+)$/i);
  return m ? { name: m[1].trim(), title: desc } : { name: desc, title: null };
}

/** Pure: TSV text → { races } (empty when the file has no data rows). */
export function parseFl(text, t, { unmatched = () => {} } = {}) {
  const rows = parseTsv(text);
  const contests = new Map(); // key → { code, desc, district, rows: [] }
  for (const r of rows) {
    // ResultsExtract.Asp calls it OfficeDesc, the Election Watch file RaceName (which can carry a leading space).
    const desc = (r.OfficeDesc || r.RaceName || '').replace(/\s+/g, ' ').trim();
    if (!desc) continue;
    const key = [r.RaceCode, r.Juris1num, r.Juris2num, desc].join('|');
    if (!contests.has(key)) contests.set(key, { key, code: r.RaceCode, desc, juris1: r.Juris1num, rows: [] });
    contests.get(key).rows.push(r);
  }
  const allCounties = new Set(rows.map((r) => r.CountyName).filter(Boolean));

  const races = [];
  for (const c of contests.values()) {
    // Candidates in first-seen order; a candidate is (name, party).
    const candKey = (r) => [r.CanNameFirst, r.CanNameMiddle, r.CanNameLast, r.PartyCode].join('|');
    const cands = [];
    const idxOf = new Map();
    for (const r of c.rows) {
      const k = candKey(r);
      if (idxOf.has(k)) continue;
      idxOf.set(k, cands.length);
      cands.push(r);
    }
    const ticket = TICKET.test(c.desc) || c.rows.some((r) => r.CanNameMiddle === '/');
    // "/" in CanNameMiddle is the file's ticket separator, never part of a name.
    const join = (...xs) => xs.filter((x) => x && x !== '/').join(' ').replace(/\s+/g, ' ').trim();
    // Tickets: the headline name is the top of the ticket (CanNameFirst), never the running mate (CanNameLast). The file
    // has surnames only; full names come from config ticketNames (copied from Election Watch's own page) when listed.
    const top = (r) => join(r.CanNameFirst, r.CanNameMiddle);
    const full = (r) => (ticket ? t.ticketNames?.[top(r)] ?? null : null);
    const candName = (r) => (ticket ? full(r)?.name ?? (top(r) || join(r.CanNameLast)) : join(r.CanNameFirst, r.CanNameMiddle, r.CanNameLast));
    const runningMate = (r) => (ticket && top(r) ? full(r)?.runningMate ?? (join(r.CanNameLast) || null) : null);
    const names = cands.map(candName);
    let cls = classifyContest(c.desc, names);
    // FL's own codes, when the description alone doesn't classify (e.g. "United States Representative").
    if (!cls && /^USS$/i.test(c.code)) cls = { office: 'senate', district: null };
    if (!cls && /^USR$/i.test(c.code)) cls = { office: 'house', district: null };
    if (!cls && /^GOV$/i.test(c.code)) cls = { office: 'governor', district: null };
    // Anything else (statewide row offices, legislature, judges, multi-county seats) is stored with office null and
    // classified downstream (contests.js + fldos.json contestRules).
    const isMeasure = cls?.office === 'measure';
    const yesNo = names.length === 2 && names.some((n) => yesNoSide(n) === 'yes') && names.some((n) => yesNoSide(n) === 'no');
    const retention = !isMeasure && yesNo && JUDICIAL.test(c.desc);
    const juris = int(c.juris1) != null && int(c.juris1) > 0 ? String(int(c.juris1)) : null;
    const district = cls?.office === 'house' ? juris ?? cls.district : cls ? null : juris;

    const choices = cands.map((r, i) => {
      if (isMeasure || retention) return { name: names[i], party: 'OTHER', partyRaw: '' };
      const party = partyOf(r, `${t.state} ${c.desc} / ${names[i]}`, unmatched);
      const mate = runningMate(r);
      return { name: names[i], party, partyRaw: r.PartyCode ?? '', ...(mate ? { runningMate: mate } : {}) };
    });

    // County units
    const byCounty = new Map();
    for (const r of c.rows) {
      if (!byCounty.has(r.CountyName)) {
        byCounty.set(r.CountyName, { votes: new Array(cands.length).fill(0), total: int(r.Precincts), reporting: int(r.PrecinctsReporting) });
      }
      byCounty.get(r.CountyName).votes[idxOf.get(candKey(r))] += int(r.CanVotes) ?? 0;
    }
    const countyUnits = [];
    for (const [cname, v] of byCounty) {
      const m = matchCounty(t.state, cname);
      if (!m) {
        unmatched('county', cname, `${t.state} ${c.desc}`);
        continue;
      }
      countyUnits.push({
        level: 'county', countyFips: m.fips, name: m.name, votes: v.votes,
        precinctsReporting: v.reporting, precinctsTotal: v.total, pctReporting: pct(v.reporting, v.total),
      });
    }
    // State unit = the sum of every county row of this one race (including any county we couldn't place on the map).
    const stVotes = new Array(cands.length).fill(0);
    let pr = 0;
    let pt = 0;
    let precKnown = false;
    for (const v of byCounty.values()) {
      v.votes.forEach((n, i) => { stVotes[i] += n; });
      if (v.total != null) { precKnown = true; pt += v.total; pr += v.reporting ?? 0; }
    }
    const statewide = cls?.office === 'senate' || cls?.office === 'governor'
      || (cls?.office !== 'house' && byCounty.size >= allCounties.size && allCounties.size > 1);
    // Contest names repeat per district ("State Senator"): add the extract's district number when the name lacks it.
    const fullName = !cls && district && !new RegExp(`\\b0*${district}\\b`).test(c.desc) ? `${c.desc}, District ${district}` : c.desc;
    const stateName = statewide ? t.state
      : cls?.office === 'house' ? (district ? `Congressional District ${district}` : c.desc) : fullName;
    const units = [{
      level: 'state', name: stateName, votes: stVotes,
      precinctsReporting: precKnown ? pr : null, precinctsTotal: precKnown ? pt : null, pctReporting: precKnown ? pct(pr, pt) : null,
    }, ...countyUnits];

    let name = cls ? c.desc : fullName;
    let title = null;
    if (isMeasure) {
      ({ name, title } = measureNames(c.desc));
      const yi = names.findIndex((n) => yesNoSide(n) === 'yes');
      const ni = names.findIndex((n) => yesNoSide(n) === 'no');
      for (const u of units) {
        u.yes = u.votes[yi] ?? 0;
        u.no = u.votes[ni] ?? 0;
      }
    }
    races.push({
      office: cls?.office ?? null, district, name, key: c.key,
      // The extract has no vote-for column: the headline offices are single-seat; anything else is left unknown.
      voteFor: cls ? 1 : null,
      statewide, title, choices, units,
      ...(retention ? { kind: 'retention' } : {}),
    });
  }
  return { races, rowCount: rows.length };
}

function partyOf(r, context, unmatched) {
  const code = String(r.PartyCode ?? '').trim().toUpperCase();
  if (code === 'REP' || code === 'DEM') return code;
  if (FL_OTHER.has(code)) return 'OTHER';
  for (const cand of [r.PartyCode, r.PartyName, String(r.PartyName ?? '').replace(/\s+(party)?(\s+of\s+florida)?$/i, '')]) {
    if (!cand) continue;
    const p = normalizeParty(cand);
    if (p.known) return p.party;
  }
  if (r.PartyCode || r.PartyName) unmatched('party', r.PartyCode || r.PartyName, `${context} (${r.PartyName ?? ''})`);
  return 'OTHER';
}

/**
 * The Downloads page's own current link to `fileName` (with its ?v=), resolved against the page URL. Only links on an
 * official Florida host are accepted. Returns null when the page doesn't link the file.
 */
export function findFileLink(html, fileName, pageUrl) {
  const esc = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(html ?? '').match(new RegExp(`href\\s*=\\s*["']([^"']*${esc}(?:\\?[^"']*)?)["']`, 'i'));
  if (!m) return null;
  let u;
  try { u = new URL(m[1].replace(/&amp;/g, '&'), pageUrl); } catch { return null; }
  if (u.protocol !== 'https:' || !/(^|\.)(floridados\.gov|floridaelectionwatch\.gov|myflorida\.com)$/i.test(u.hostname)) return null;
  return u.href;
}

const memo = new Map(); // target key → { stamp, version }

async function fetchTarget(t, ctx) {
  if (!t.downloadsUrl) return fetchExtract(t, ctx);
  const { http, unmatched, log } = ctx;
  // 1. The site's own current link (never the bare file URL: that one is a stale cached copy).
  const page = await http.get(t.downloadsUrl, { timeoutMs: 30000, accept: 'text/html' });
  const link = findFileLink(page.text, t.fileName, t.downloadsUrl);
  if (!link) throw new Error(`FL Downloads page has no link to ${t.fileName}`);
  // 2. HEAD: download the file only when the blob changed.
  const h = await http.head(link, { timeoutMs: 30000 });
  const stamp = h.headers.get('etag') || h.headers.get('last-modified');
  const m = memo.get(t.key);
  if (stamp && m?.stamp === stamp) return { changed: false, version: m.version };
  const res = await http.get(link, { timeoutMs: 60000, accept: 'text/tab-separated-values,text/plain,*/*' });
  const lastModified = res.headers.get('last-modified');
  const sourceUpdatedAt = lastModified && !Number.isNaN(Date.parse(lastModified)) ? new Date(lastModified).toISOString() : null;
  const out = buildFromText(res.text, t, { unmatched, log, sourceUpdatedAt });
  memo.set(t.key, { stamp: res.headers.get('etag') || lastModified || stamp, version: out.version });
  return out;
}

async function fetchExtract(t, { http, unmatched, log }) {
  const res = await http.get(t.extractUrl, { conditional: true, timeoutMs: 60000, accept: 'text/tab-separated-values,text/plain,*/*' });
  return buildFromText(res.text, t, { unmatched, log, sourceUpdatedAt: null });
}

function buildFromText(text, t, { unmatched, log, sourceUpdatedAt }) {
  if (/<html/i.test(text.slice(0, 500))) throw new Error('FL extract returned HTML instead of TSV');
  const version = createHash('sha1').update(text).digest('hex').slice(0, 16);
  if (lastVersion.get(t.key) === version) return { changed: false, version };
  const { races, rowCount } = parseFl(text, t, { unmatched });
  if (rowCount === 0) {
    // Header only: polls not closed / nothing uploaded yet. Writing an empty snapshot would say "no race".
    log?.info?.(`[fldos] ${t.key}: extract has no data rows yet`);
    lastVersion.set(t.key, version);
    return { changed: false, version };
  }
  // A stale cached copy of the file is all zeros (seen live on the bare URL). Once counts have arrived, a zero file
  // never replaces them: skip it and say so.
  const total = races.reduce((s, r) => s + (r.units?.[0]?.votes ?? []).reduce((a, b) => a + b, 0), 0);
  if (total === 0 && sawVotes.get(t.key)) {
    log?.warn?.(`[fldos] ${t.key}: file has no votes after counts were published; ignoring it as a stale copy`);
    return { changed: false, version: lastVersion.get(t.key) ?? version };
  }
  if (total > 0) sawVotes.set(t.key, true);
  lastVersion.set(t.key, version);
  return {
    changed: true,
    version,
    result: {
      election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: t.date, url: t.url },
      version,
      sourceUpdatedAt, // Election Watch file: the blob's Last-Modified; the old extract had none
      turnout: null,         // not in the extract
      races,
    },
  };
}

export default {
  id: 'fldos',
  name: 'Florida Division of Elections (Florida Election Watch)',
  targets,
  fetch: fetchTarget,
};
