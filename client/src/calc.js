// Pure display calculations (no React / DOM). Tested in client/test/.
// Rule: `null` means "this source doesn't publish it". Never turn missing data into 0.
import { TOSSUP_MARGIN, leadCategory } from './shading.js';

/** Measures with % reporting below this (or unknown) show TOO EARLY. */
export const MEASURE_TOO_EARLY_PCT = 10;

const isNum = (n) => n != null && n !== '' && Number.isFinite(Number(n));

/** Counts strip: only states with status 'reporting'; ties and |margin| < TOSSUP_MARGIN are toss-ups. */
export function tallyStates(states, tossup = TOSSUP_MARGIN) {
  const t = { dem: 0, rep: 0, toss: 0, other: 0 };
  for (const s of states || []) {
    const c = leadCategory(s, tossup);
    if (c === 'DEM') t.dem++;
    else if (c === 'REP') t.rep++;
    else if (c === 'tossup') t.toss++;
    else if (c === 'OTHER') t.other++;
  }
  return t;
}

/** Est. reporting = Σ(pct × votes) / Σ votes over states with pctReporting known. null when nothing to weigh. */
export function estReporting(states) {
  let num = 0, den = 0;
  for (const s of states || []) {
    if (!isNum(s?.pctReporting) || !isNum(s?.totalVotes) || Number(s.totalVotes) <= 0) continue;
    num += Number(s.pctReporting) * Number(s.totalVotes);
    den += Number(s.totalVotes);
  }
  return den > 0 ? num / den : null;
}

/** Turnout %: the source's own figure if it states one, else ballotsCast / registered. null if neither. */
export function turnoutPct(t) {
  if (!t) return null;
  if (isNum(t.turnoutPct)) return Number(t.turnoutPct);
  if (isNum(t.ballotsCast) && isNum(t.registered) && Number(t.registered) > 0) {
    return (100 * Number(t.ballotsCast)) / Number(t.registered);
  }
  return null;
}

/** Precinct share 0–100, or null when either number is unknown / total is 0. */
export function precinctPct(reporting, total) {
  if (!isNum(reporting) || !isNum(total) || Number(total) <= 0) return null;
  return Math.max(0, Math.min(100, (100 * Number(reporting)) / Number(total)));
}

/**
 * Vote method rows: [{ label, bucket, total, parties }] → share of counted + D/R/Other share within each method.
 * Returns [] for null/empty input. Shares are null when a method has no votes yet.
 */
export function methodShares(methods) {
  if (!Array.isArray(methods) || !methods.length) return [];
  const rows = methods.map((m) => {
    const p = m.parties || {};
    const d = Number(p.DEM) || 0, r = Number(p.REP) || 0, o = Number(p.OTHER) || 0;
    const total = isNum(m.total) ? Number(m.total) : d + r + o;
    return { label: m.label, bucket: m.bucket, total, d, r, o };
  });
  const all = rows.reduce((a, m) => a + m.total, 0);
  return rows.map((m) => ({
    label: m.label,
    bucket: m.bucket,
    total: m.total,
    share: all > 0 ? (100 * m.total) / all : null,
    dPct: m.total > 0 ? (100 * m.d) / m.total : null,
    rPct: m.total > 0 ? (100 * m.r) / m.total : null,
    oPct: m.total > 0 ? (100 * m.o) / m.total : null,
  }));
}

/** 'too-early' | 'yes' | 'no' | 'tied'. Never passed/failed. */
export function measureStatus(m, minPct = MEASURE_TOO_EARLY_PCT) {
  if (!m || !isNum(m.pctReporting) || Number(m.pctReporting) < minPct) return 'too-early';
  const yes = Number(m.yes) || 0, no = Number(m.no) || 0;
  if (yes + no === 0) return 'too-early';
  if (yes === no) return 'tied';
  return yes > no ? 'yes' : 'no';
}

export const MEASURE_STATUS_LABEL = { 'too-early': 'TOO EARLY', yes: 'YES LEADS', no: 'NO LEADS', tied: 'TIED' };

/** Yes / no share of the votes counted on a measure, or nulls. */
export function measureShares(m) {
  const yes = Number(m?.yes) || 0, no = Number(m?.no) || 0;
  const t = yes + no;
  if (t <= 0) return { yesPct: null, noPct: null };
  return { yesPct: (100 * yes) / t, noPct: (100 * no) / t };
}

/** Party shares of an entry's total, as { DEM, REP, OTHER } in percent (null when nothing counted). */
export function partyShares(entry) {
  const t = Number(entry?.totalVotes) || 0;
  const p = entry?.parties || {};
  const f = (v) => (t > 0 ? (100 * (Number(v) || 0)) / t : null);
  return { DEM: f(p.DEM), REP: f(p.REP), OTHER: f(p.OTHER) };
}

const PARTY_WORD = { DEM: 'Democrat', REP: 'Republican', OTHER: 'Other party' };

// Short party tags from the source's own label. DEM/REP from the normalized party; everything else from partyRaw,
// so a Libertarian is LIB, not "Other". Unknown labels are shown as the source wrote them (shortened).
const TAGS = [
  [/^(lib|lbr|lbt|l|libertarian)$/, 'LIB'], [/^(grn|gre|g|green|green party)$/, 'GRN'],
  [/^(ind|i|indep|independent)$/, 'IND'], [/^(una|uaf|unaffiliated|unc)$/, 'UNA'], [/^(np|npa|nonp|non|nonpartisan|non partisan|no party|no party preference|npp|non-partis|nonprtycan|none)$/, 'NP'],
  [/^(con|cst|constitution)$/, 'CON'], [/^(wf|wfp|working families)$/, 'WF'], [/^(fwd|forward)$/, 'FWD'], [/^(p&f|peace and freedom)$/, 'P&F'],
  [/^(pc|petitioning candidate)$/, 'PET'], [/^(apv|approval voting)$/, 'APV'], [/^(soc|socialist)$/, 'SOC'],
  [/^other[- ]?part(y)?$/, 'OTHER'],
];
/** "DEM" / "REP" / "LIB" / "IND" / … from a candidate's party; '' when the source gives no label (nonpartisan). */
export function partyTag(c) {
  if (!c) return '';
  if (c.party === 'DEM') return 'DEM';
  if (c.party === 'REP') return 'REP';
  const raw = String(c.partyRaw ?? '').trim();
  const k = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!k || /^(oth|other|w|wi|write-in|write in)$/.test(k)) return '';
  for (const [re, tag] of TAGS) if (re.test(k)) return tag;
  return raw.length <= 5 ? raw.toUpperCase() : raw.slice(0, 4).toUpperCase();
}

export const isWriteIn = (c) => /\bwrite[- ]?ins?\b/i.test(String(c?.name ?? '')) || /^(w|wi|wri|write-in|write in)$/i.test(String(c?.partyRaw ?? '').trim());

/**
 * Every candidate the source lists, sorted by votes, with a party tag and % of the votes counted. Write-ins come last on
 * their own line. Never collapses candidates into "Other"; two candidates of one party stay two rows.
 * @param {number} [cap] show at most this many named candidates (`more` = how many were left out)
 * Named write-in candidates (OH lists them) each keep their own row, marked as write-ins, never merged.
 * @returns {{ rows:{name,tag,party,votes,pct}[], writeIns:{name,votes,pct,named:boolean}[], more:number, total:number }}
 */
export function candidateList(entry, cap = Infinity) {
  const all = Array.isArray(entry?.candidates) ? entry.candidates : [];
  const total = all.reduce((s, c) => s + (Number(c.votes) || 0), 0);
  const pct = (v) => (total > 0 ? (100 * (Number(v) || 0)) / total : null);
  const byVotes = (a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0);
  const named = all.filter((c) => !isWriteIn(c)).sort(byVotes);
  const rows = named.slice(0, cap).map((c) => ({
    name: c.name, tag: partyTag(c), party: c.party, votes: Number(c.votes) || 0, pct: pct(c.votes), photo: c.photo ?? null,
  }));
  // Write-ins: the generic "Write-in" line as is; named write-in candidates each on their own line. When capped (tooltips),
  // they count toward "N more" except the generic line.
  const wiAll = all.filter(isWriteIn).sort(byVotes).map((c) => ({
    name: c.name, votes: Number(c.votes) || 0, pct: pct(c.votes), named: !/^\s*write[- ]?ins?\s*$/i.test(c.name),
  }));
  const writeIns = Number.isFinite(cap) ? wiAll.filter((w) => !w.named) : wiAll;
  return {
    rows,
    writeIns,
    more: Math.max(0, named.length - rows.length) + (wiAll.length - writeIns.length),
    total,
  };
}

/** True when the entry lists real candidates (not the U.S. House statewide sum by party). */
export const hasCandidates = (entry) => !entry?.partySum && Array.isArray(entry?.candidates) && entry.candidates.length > 0;

const nameWithTag = (c) => (c ? `${c.name}${partyTag(c) ? ` (${partyTag(c)})` : ''}` : '');

/**
 * "Jane Doe (DEM) leading by 3.2 pts" / "Toss-up · Jane Doe (DEM) ahead by 1.1 pts" / "Tied · toss-up" / null when not
 * reporting. The U.S. House statewide sum names the party ("Democrats leading the House popular vote by …").
 */
export function leadText(entry, tossup = TOSSUP_MARGIN) {
  const c = leadCategory(entry, tossup);
  if (!c) return null;
  if (c === 'multi') {
    const top = (entry.candidates || []).filter((x) => !isWriteIn(x)).slice(0, entry.seats || 2).map(nameWithTag).filter(Boolean);
    return `Vote for ${entry.seats || 2} · most votes so far: ${top.join(', ') || '—'}`;
  }
  const m = isNum(entry.marginPts) ? Math.abs(Number(entry.marginPts)).toFixed(1) : null;
  const first = hasCandidates(entry) ? [...entry.candidates].sort((a, b) => (Number(b.votes) || 0) - (Number(a.votes) || 0))[0] : null;
  if (c === 'tossup') {
    if (entry.tied || !entry.leader) return 'Tied · toss-up';
    return first ? `Toss-up · ${nameWithTag(first)} ahead by ${m ?? '—'} pts` : `Toss-up · margin ${m ?? '—'} pts`;
  }
  return first ? `${nameWithTag(first)} leading by ${m} pts` : `${PARTY_WORD[c]} leading by ${m} pts`;
}

/** Newest ISO timestamp among the given values (ignores null / invalid). */
export function newestTime(values) {
  let best = null, bestT = -Infinity;
  for (const v of values || []) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > bestT) { bestT = t; best = v; }
  }
  return best;
}

const mtFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "HH:MM MT" in America/Denver, or null. */
export function fmtMT(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${mtFmt.format(d)} MT`;
}

// ---------- Measure cards (0.4) ----------
// Party positions use neutral position colours, never party colours. A reviewed "no_position" is the party's own
// published neutrality ("Neutral"); no reviewed position at all is "No published position".
export const POSITION_DISPLAY = {
  support: { label: 'Support', color: '#5EEAD4' },
  oppose: { label: 'Oppose', color: '#FCD34D' },
  no_position: { label: 'Neutral', color: '#C9D1DB' },
  none: { label: 'No published position', color: '#9AA4B2' },
};
export const positionDisplay = (position) => POSITION_DISPLAY[position] ?? POSITION_DISPLAY.none;

/** The label in front of a reviewed campaign website: by side, or a plain "Campaign website" when the side isn't clear. */
export const websiteLabel = (w) => (w?.side === 'support' ? 'Yes campaign' : w?.side === 'oppose' ? 'No campaign' : 'Campaign website');

/** The domain as printed in the official guide: scheme and trailing slash dropped, case kept ("www.CAFairElections.org"). */
export const displayDomain = (url) => String(url ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

// ---------- Why a state has no live results (0.4) ----------
// From config/coverage-status.json via the API. Never implies the state is at fault; the official link stays prominent.
const COVERAGE_COPY = {
  blocked: { title: "Live results aren't available here.", detail: "This state's results site doesn't allow automated access." },
  no_feed: { title: "Live results aren't available here.", detail: "This state doesn't publish statewide results in a form we can read live." },
  planned: { title: 'Live results coming soon.', detail: "We haven't connected this state's official results yet." },
};
/** { title, detail } for a state with no live results (unknown / "live" without this office → the "coming soon" copy). */
export const coverageCopy = (status) => COVERAGE_COPY[status] ?? COVERAGE_COPY.planned;
export const OFFICIAL_LINK_TEXT = 'View official results ↗';
