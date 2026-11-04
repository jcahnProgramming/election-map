// Florida Division of Elections results extract (https://results.elections.myflorida.com/).
//
// One tab-separated file per election date (verified live 2026-11-03; header-only until the first counts):
//   ElectionDate  PartyCode  PartyName  RaceCode  OfficeDesc  CountyCode  CountyName  Juris1num  Juris2num
//   Precincts  PrecinctsReporting  CanNameLast  CanNameFirst  CanNameMiddle  CanVotes
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
      extractUrl: e.extractUrl,
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
    if (!r.OfficeDesc) continue;
    const key = [r.RaceCode, r.Juris1num, r.Juris2num, r.OfficeDesc].join('|');
    if (!contests.has(key)) contests.set(key, { key, code: r.RaceCode, desc: r.OfficeDesc, juris1: r.Juris1num, rows: [] });
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
    const candName = (r) => [r.CanNameFirst, r.CanNameMiddle, r.CanNameLast].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
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
      return { name: names[i], party, partyRaw: r.PartyCode ?? '' };
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
  for (const cand of [r.PartyCode, r.PartyName, String(r.PartyName ?? '').replace(/\s+(party)?(\s+of\s+florida)?$/i, '')]) {
    if (!cand) continue;
    const p = normalizeParty(cand);
    if (p.known) return p.party;
  }
  if (r.PartyCode || r.PartyName) unmatched('party', r.PartyCode || r.PartyName, `${context} (${r.PartyName ?? ''})`);
  return 'OTHER';
}

async function fetchTarget(t, { http, unmatched, log }) {
  const res = await http.get(t.extractUrl, { conditional: true, timeoutMs: 60000, accept: 'text/tab-separated-values,text/plain,*/*' });
  const text = res.text;
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
  lastVersion.set(t.key, version);
  return {
    changed: true,
    version,
    result: {
      election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: t.date, url: t.url },
      version,
      sourceUpdatedAt: null, // the extract carries no timestamp and the server sends no Last-Modified
      turnout: null,         // not in the extract
      races,
    },
  };
}

export default {
  id: 'fldos',
  name: 'Florida Division of Elections results extract',
  targets,
  fetch: fetchTarget,
};
