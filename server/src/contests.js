// Contest classification: every contest a feed publishes gets a level, a normalized office key, a district /
// jurisdiction and a kind. Config-driven: an adapter's own `contestRules` (config/sources/<id>.json) first, then the
// built-in U.S. Senate / U.S. House / Governor / measure rules (normalize.classifyContest), then the shared rules in
// config/contest-rules.json. Nothing is dropped: a contest no rule matches is 'unclassified' and gets logged.
import { readConfig } from './config.js';
import { classifyContest, parseDistrict, yesNoSide } from './normalize.js';

export const LEVELS = ['federal', 'statewide', 'legislative', 'county', 'local', 'judicial', 'measure', 'unclassified'];
export const KINDS = ['partisan', 'nonpartisan', 'yes_no', 'retention'];

/** Same folding as normalize.classifyContest: lower-case, "U.S."/"United States" → "us", tidy punctuation. */
export function foldName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^for\s+/, '')
    .replace(/^(u\.?\s?s\.?|united states)(?=\s)/, 'us')
    .replace(/[,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let shared = null;
const perAdapter = new Map();

function compile(rules, where) {
  const out = [];
  for (const r of rules ?? []) {
    try {
      if (!r?.match || !LEVELS.includes(r.level) || !r.office) throw new Error('needs match, a known level and office');
      out.push({ ...r, re: new RegExp(r.match, 'i') });
    } catch (err) {
      console.error(`[contests] ignoring rule in ${where} ${JSON.stringify(r)}: ${err.message}`);
    }
  }
  return out;
}

function sharedRules() {
  if (!shared) {
    const cfg = readConfig('contest-rules.json', { labels: {}, rules: [] });
    shared = { labels: cfg.labels ?? {}, rules: compile(cfg.rules, 'contest-rules.json') };
  }
  return shared;
}

function adapterRules(adapterId) {
  if (!adapterId) return [];
  if (!perAdapter.has(adapterId)) {
    let cfg = null;
    try {
      cfg = readConfig(`sources/${adapterId}.json`, null);
    } catch {
      cfg = null;
    }
    perAdapter.set(adapterId, compile(cfg?.contestRules, `sources/${adapterId}.json`));
  }
  return perAdapter.get(adapterId);
}

/** Test hook: forget cached config. */
export function resetContestRules() {
  shared = null;
  perAdapter.clear();
}

/** Human label for an office key ("attorney_general" → "Attorney General"). */
export function officeLabel(office) {
  const l = sharedRules().labels[office];
  if (l) return l;
  return String(office ?? '').split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

const JURIS_COUNTY = /^(.+?) (county|parish|borough)\b/;
const JURIS_CITY = /\b(?:city|town|village|township|borough) of ([a-z][a-z .'-]+?)(?=\s(?:-|ward|council|mayor|district|seat|position|at large|question|measure|proposition|$)|$)/;

function jurisdictionOf(n, original) {
  const c = n.match(JURIS_COUNTY);
  if (c && !/^(state|us|board|district)\b/.test(c[1])) return titleCase(original, c[1]);
  const t = n.match(JURIS_CITY);
  if (t) return titleCase(original, t[1]);
  return null;
}
/** Keep the source's capitalization for a substring we found in the folded name. */
function titleCase(original, folded) {
  const i = String(original).toLowerCase().indexOf(folded);
  return i >= 0 ? String(original).slice(i, i + folded.length).trim() : folded;
}

function isYesNo(choices) {
  if (choices.length !== 2) return false;
  const sides = choices.map((c) => yesNoSide(c?.name ?? c));
  return sides.includes('yes') && sides.includes('no');
}

/**
 * Classify one contest.
 * @param {string} name  contest name as the source gives it
 * @param {Array<string|{name:string,party?:string}>} choices
 * @param {{ adapterId?:string, hint?:{level?:string, office?:string, district?:string, kind?:string}, voteFor?:number,
 *           isMeasure?:boolean, scopeCounty?:string|null }} [opts]
 * @returns {{ level:string, office:string, district:string|null, jurisdiction:string|null,
 *            kind:'partisan'|'nonpartisan'|'yes_no'|'retention', classified:boolean }}
 */
export function classifyFull(name, choices = [], opts = {}) {
  const n = foldName(name);
  const labels = choices.map((c) => (typeof c === 'string' ? c : c?.name ?? ''));
  const yesNo = opts.isMeasure || isYesNo(labels);
  let level = null;
  let office = null;
  let district = null;
  let kind = opts.hint?.kind ?? null;

  if (opts.hint?.level && opts.hint?.office) {
    ({ level, office } = opts.hint);
    district = opts.hint.district ?? null;
  }
  if (!level) {
    for (const r of adapterRules(opts.adapterId)) {
      if (r.re.test(n)) {
        ({ level, office } = r);
        kind = r.kind ?? kind;
        break;
      }
    }
  }
  if (!level) {
    const legacy = opts.isMeasure ? { office: 'measure', district: null } : classifyContest(name, labels);
    if (legacy) {
      office = legacy.office;
      level = office === 'measure' ? 'measure' : office === 'governor' ? 'statewide' : 'federal';
      district = legacy.district;
    }
  }
  if (!level) {
    for (const r of sharedRules().rules) {
      if (r.re.test(n)) {
        ({ level, office } = r);
        kind = r.kind ?? kind;
        break;
      }
    }
  }
  const classified = !!level;
  if (!level) {
    level = 'unclassified';
    office = 'unclassified';
  }
  if (district == null && level !== 'measure' && office !== 'governor' && office !== 'senate') district = parseDistrict(n);

  if (!kind) {
    if (level === 'measure') kind = 'yes_no';
    else if (yesNo) kind = level === 'judicial' || /\bretain|retention\b/.test(n) ? 'retention' : 'yes_no';
    else {
      const parties = choices.map((c) => (typeof c === 'string' ? null : c?.party)).filter(Boolean);
      kind = parties.some((p) => p === 'DEM' || p === 'REP') ? 'partisan' : 'nonpartisan';
    }
  }
  return { level, office, district: district ?? null, jurisdiction: opts.scopeCounty ?? jurisdictionOf(n, name), kind, classified };
}

/**
 * Fill level / office / kind / district / jurisdiction on every race of an adapter result that doesn't carry them yet.
 * An adapter may set any of these itself (from a feed's own office codes); what it sets wins.
 * Also demotes a "statewide" office that only one county votes on (a county's own Treasurer in a statewide feed).
 * @returns {Array<{name:string, key:string}>} the contests left unclassified
 */
export function enrichRaces(result, adapterId) {
  const unclassified = [];
  const races = result?.races ?? [];
  const scopeCounty = result?.election?.scope === 'county' ? result.election.name ?? null : null;
  const feedCounties = new Set();
  for (const r of races) for (const u of r?.units ?? []) if (u?.level === 'county' && u.countyFips) feedCounties.add(u.countyFips);

  for (const r of races) {
    if (!r || r.name == null) continue;
    const isMeasure = r.office === 'measure';
    const preset = r.level && r.office && r.office !== 'other';
    const cls = classifyFull(r.name, r.choices ?? [], {
      adapterId,
      isMeasure,
      hint: preset ? { level: r.level, office: r.office, district: r.district, kind: r.kind } : r.hint,
      scopeCounty,
    });
    // Built-in top races the adapter already identified keep its office/district.
    if (!preset && r.office && ['senate', 'house', 'governor', 'measure'].includes(r.office)) {
      cls.office = r.office;
      cls.level = r.office === 'measure' ? 'measure' : r.office === 'governor' ? 'statewide' : 'federal';
      cls.classified = true;
    }
    r.level = cls.level;
    r.office = cls.office;
    r.kind = r.kind ?? cls.kind;
    if (r.district == null) r.district = cls.district;
    r.jurisdiction = r.jurisdiction ?? cls.jurisdiction;
    if (r.level === 'statewide' && feedCounties.size > 1) {
      const counties = new Set((r.units ?? []).filter((u) => u?.level === 'county').map((u) => u.countyFips));
      if (counties.size === 1) {
        r.level = 'county';
        r.jurisdiction ??= (r.units.find((u) => u?.level === 'county')?.name ?? null);
      }
    }
    if (!cls.classified) unclassified.push({ name: r.name, key: r.key });
    delete r.hint;
  }
  return unclassified;
}
