// Static, researched ballot-measure information (docs/measures-data.md): config/elections/<key>/measures/<ST>.json.
// Not polled: it's read once per election and merged with the live yes/no counts in results.measures().
// Review gate: proponent/opposition websites and party positions are only ever served once a human has set
// `reviewed: true` on them. Unreviewed values never leave the server.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const cache = new Map(); // electionKey → Map(state → measures[])

function load(ek) {
  if (cache.has(ek)) return cache.get(ek);
  const out = new Map();
  const dir = path.join(CONFIG_DIR, 'elections', ek, 'measures');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => /^[A-Z]{2}\.json$/.test(x)).sort()) {
      try {
        const doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        const st = String(doc.state ?? f.slice(0, 2)).toUpperCase();
        out.set(st, (doc.measures ?? []).filter((m) => m && m.measure_id).map((m) => ({ ...m, state: st, _match: matchers(m) })));
      } catch (err) {
        console.error(`[measureinfo] skipping ${ek}/${f}: ${err.message}`);
      }
    }
  }
  cache.set(ek, out);
  return out;
}

/** Test hook. */
export function resetMeasureInfo() {
  cache.clear();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchers(m) {
  const terms = [...new Set([m.measure_id, ...(m.match ?? [])].filter(Boolean).map((x) => String(x).trim()))];
  // Whole words, flexible whitespace/hyphens: "Amendment 1" never matches "Amendment 10".
  return terms.map((t) => new RegExp(`(^|[^a-z0-9])${esc(t.toLowerCase()).replace(/\\?[\s-]+/g, '[\\s\\-.]*')}(?![a-z0-9])`, 'i'));
}

/** The static entry for a live measure (by its contest name / title), or null. */
export function findMeasureInfo(ek, state, name, title) {
  const list = load(ek).get(state) ?? [];
  const hay = `${name ?? ''} ${title ?? ''}`.toLowerCase();
  return list.find((m) => m._match.some((re) => re.test(hay))) ?? null;
}

/** Every party named in a state's measure file (names only, reviewed or not: a party's name is not a position). */
export function statePartyNames(ek, state) {
  return [...new Set((load(ek).get(state) ?? []).flatMap((m) => (m.party_positions ?? []).map((p) => p?.party).filter(Boolean)))];
}

/** All static entries for one state (or every state when null). */
export function measureInfoList(ek, state = null) {
  const all = load(ek);
  if (state) return all.get(state) ?? [];
  return [...all.values()].flat();
}

const reviewed = (x) => (x && x.reviewed === true ? x : null);
const val = (x) => (x && x.value != null ? x : null);
/** A website whose side (for / against) the official source doesn't make clear: `"side": "unclear"` in the file. */
const sideUnclear = (x) => x?.side === 'unclear';

export const POSITIONS = ['support', 'oppose', 'no_position'];
const MAJOR = [
  { key: 'DEM', re: /\bdemocrat(ic)?\b/i, fallback: 'Democratic Party' },
  { key: 'REP', re: /\brepublican\b|\bgop\b/i, fallback: 'Republican Party' },
];
const majorOf = (party) => MAJOR.find((p) => p.re.test(String(party ?? '')))?.key ?? null;

/**
 * Party positions as shown on a measure card: always both major parties (Democratic, then Republican) with their
 * reviewed position or `position: null` ("No published position"), then any other party that has a reviewed position.
 * The parties' names come from the state's own file (any measure), so the card says "Colorado Democratic Party".
 * Unreviewed positions never leave the server: an unreviewed entry shows exactly like no entry.
 */
export function partyPositionsOf(m, stateParties = []) {
  const ok = (m?.party_positions ?? []).filter((p) => p && p.reviewed === true && p.party && POSITIONS.includes(p.position));
  const out = [];
  for (const maj of MAJOR) {
    const p = ok.find((x) => majorOf(x.party) === maj.key);
    const name = p?.party ?? stateParties.find((x) => majorOf(x) === maj.key) ?? maj.fallback;
    out.push({ party: name, major: maj.key, position: p?.position ?? null, sourceUrl: p?.source_url ?? null });
  }
  const others = ok.filter((x) => !majorOf(x.party)).sort((a, b) => a.party.localeCompare(b.party))
    .map((p) => ({ party: p.party, major: null, position: p.position, sourceUrl: p.source_url ?? null }));
  return [...out, ...others];
}

/** Reviewed campaign websites: [{ side: 'support'|'oppose'|null, url, sourceUrl, note }] (null = side not clear). */
export function campaignWebsitesOf(m) {
  const out = [];
  for (const [k, side] of [['proponent_website', 'support'], ['opposition_website', 'oppose']]) {
    const w = reviewed(val(m?.[k]));
    if (w) out.push({ side: sideUnclear(w) ? null : side, url: w.value, sourceUrl: w.source_url ?? null, note: w.note ?? null });
  }
  return out;
}

/** The public shape of one static entry: only sourced values, and gated values only once reviewed. */
export function publicInfo(m, stateParties = []) {
  if (!m) return null;
  const pb = m.placed_by ?? null;
  const lv = m.legislative_vote ?? null;
  return {
    measureId: m.measure_id,
    officialSourceUrl: m.official_source_url ?? null,
    officialTitle: val(m.official_title) && { value: m.official_title.value, sourceUrl: m.official_title.source_url ?? null, asOf: m.official_title.as_of ?? null },
    officialSummary: val(m.official_summary)
      ? { value: m.official_summary.value, by: m.official_summary.by ?? null, sourceUrl: m.official_summary.source_url ?? null, asOf: m.official_summary.as_of ?? null }
      : null,
    fullText: m.full_text && (m.full_text.value || m.full_text.url)
      ? { value: m.full_text.value ?? null, url: m.full_text.url ?? null, sourceUrl: m.full_text.source_url ?? null, asOf: m.full_text.as_of ?? null }
      : null,
    placedBy: pb && pb.type
      ? { type: pb.type, proponentName: pb.proponent_name ?? null, billNumber: pb.bill_number ?? null, detail: pb.detail ?? null,
        sourceUrl: pb.source_url ?? null, asOf: pb.as_of ?? null }
      : null,
    proponentWebsite: reviewed(val(m.proponent_website)) && !sideUnclear(m.proponent_website)
      ? { url: m.proponent_website.value, sourceUrl: m.proponent_website.source_url ?? null, note: m.proponent_website.note ?? null } : null,
    opposition: val(m.opposition_committee_name)
      ? {
        name: m.opposition_committee_name.value,
        sourceUrl: m.opposition_committee_name.source_url ?? null,
        website: reviewed(val(m.opposition_website)) && !sideUnclear(m.opposition_website) ? m.opposition_website.value : null,
      }
      : null,
    campaignWebsites: campaignWebsitesOf(m),
    partyPositions: partyPositionsOf(m, stateParties),
    legislativeVote: lv && Array.isArray(lv.chambers) && lv.chambers.length
      ? { chambers: lv.chambers, rollCallUrl: lv.roll_call_url ?? null, sourceUrl: lv.source_url ?? null, asOf: lv.as_of ?? null }
      : null,
  };
}
