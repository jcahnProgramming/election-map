// Texas Secretary of State election night results: Civix IVIS ENR (goelect.txelections.civixapps.com).
//
// File layout (verified live on 2026-11-03 against election 53815, and the finished 2025 election 51031):
//   {base}/electionConstants              { upload: base64(JSON) } list of elections by year and type (GE = general)
//   {base}/election/{id}                  { Version:"enr/53815/5/", <Section>: base64(JSON), ... }  ~1.6 MB
//       Home        { LastUpdatedTime:"Nov 06, 2025 04:18:23" (Texas local time), CountiesReporting:{CR,CT}, ... }
//       Federal     { Races:[{ id, N:"U. S. SENATOR ", Candidates:[{ ID, N, P, V, EV, PE, O }], T }] }  US Senate + US House
//       StateWide   same shape: Governor and the other statewide offices
//       StateWideQ  same shape: statewide propositions (candidates "FOR" / "AGAINST", ID null)
//       Districted  same shape: "DISTRICT OFFICES" (~530 in 2026): State Senate / House, State Board of Education,
//                   courts of appeals, district judges, criminal district attorneys, multicounty courts
//       Lookups     { County:[{ ID, CN }] } (MID is NOT a FIPS code); also OfficeSummary, Race, ReportList (unused)
//   {base}/election/countyInfo/{id}       { upload: base64(JSON) }  ~4 MB decoded
//       { "<county ID>": { N:"TRAVIS", Summary:{ PRR, PRP, RV, VC, VT, ... },
//                          Races:{ "<race id>": { OID, N, PR, TP, C:{ "<cand id>": { id, N, P, V, EV } } } } } }
// Field meanings: V total votes, EV early votes (early in person + mail), PR/TP precincts reporting/total,
// RV registered voters, VC ballots cast, VT turnout %. Candidate names carry an incumbent marker "(I)", not a party.
// Version changes with every new publish, so the 4 MB county file is only fetched when it changes.
//
// Every race in every section is emitted (v0.3), with the county breakdown from the county file we already fetch (it
// carries every race, district ones included): no extra requests. U.S. Senate / House / Governor and propositions keep
// their built-in office; anything else goes out with office null and is classified by server/src/contests.js.
// The SOS file does NOT carry county or municipal offices (those are on each county's own site), so allContests is
// false: a Texas office missing here is "not in this feed", not "no race".
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide, methodBucket } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → Version
// Race sections of the election file, and the sections that are something else (never decoded).
const KNOWN_SECTIONS = ['Federal', 'StateWide', 'StateWideQ', 'Districted'];
const NOT_RACES = new Set(['Version', 'Home', 'Lookups', 'OfficeSummary', 'Race', 'ReportList', 'ElementControl']);
const STATEWIDE_SECTIONS = new Set(['Federal', 'StateWide', 'StateWideQ']); // Districted = a district's voters only

function targets() {
  const cfg = readConfig('sources/txivis.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `txivis/${e.electionId}`,
      base: cfg.base,
      electionId: String(e.electionId),
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: e.measures !== false,
      allContests: e.allContests ?? false,
      url: e.url,
      timeZone: e.timeZone ?? 'America/Chicago',
      countyAliases: e.countyAliases ?? {},
    }));
}

export const decodeSection = (b64) => (b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null);

/** "Nov 06, 2025 04:18:23" in a named time zone → ISO 8601 UTC, or null. */
export function localToIso(s, timeZone) {
  const m = String(s ?? '').match(/^([A-Za-z]{3})\w* (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  const wall = Date.UTC(+m[3], mon, +m[2], +m[4], +m[5], +m[6]);
  const off = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = wall - off(wall);
  t = wall - off(t); // second pass settles DST edges
  return new Date(t).toISOString();
}

const cleanName = (n) => String(n ?? '').replace(/\s*\(I\)\s*$/, '').replace(/\s+/g, ' ').trim();
const num = (x) => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (a != null && b ? round1((100 * a) / b) : null);

/**
 * Pure parse of the two IVIS files into the adapter result (docs/data-contract.md).
 * @param {object} election   the /election/{id} JSON (sections still base64)
 * @param {object|null} countyInfo  the /election/countyInfo/{id} JSON ({ upload }), or null
 * @param {object} t          target (state, races, measures, timeZone, countyAliases, key, label, url)
 * @param {(kind:string, value:string, context:string)=>void} unmatched
 */
export function parseIvis(election, countyInfo, t, unmatched = () => {}) {
  const home = decodeSection(election.Home) ?? {};
  const counties = countyInfo?.upload ? decodeSection(countyInfo.upload) : {};

  // County ID → { fips, name }, once.
  const countyById = new Map();
  for (const [id, co] of Object.entries(counties)) {
    const raw = co.N;
    const m = matchCounty(t.state, raw) ?? (t.countyAliases?.[raw] ? matchCounty(t.state, t.countyAliases[raw]) : null);
    if (!m) unmatched('county', raw, `${t.state} IVIS county ${id}`);
    countyById.set(id, m);
  }

  // Every section with a Races list: the known ones first, then any section IVIS adds later (the big lookup sections
  // are skipped without decoding).
  const sectionNames = [...KNOWN_SECTIONS, ...Object.keys(election).filter((k) => !KNOWN_SECTIONS.includes(k) && !NOT_RACES.has(k))];
  const sections = [];
  const seen = new Set();
  for (const s of sectionNames) {
    let dec = null;
    try {
      dec = decodeSection(election[s]);
    } catch {
      continue; // not a base64 JSON section
    }
    for (const r of Array.isArray(dec?.Races) ? dec.Races : []) {
      if (r?.id == null || seen.has(String(r.id))) continue;
      seen.add(String(r.id));
      sections.push({ ...r, section: s });
    }
  }

  const races = [];
  for (const r of sections) {
    const cands = [...(r.Candidates ?? [])].sort((a, b) => (a.O ?? 0) - (b.O ?? 0));
    const names = cands.map((c) => cleanName(c.N));
    const cls = classifyContest(r.N, names);
    const isMeasure = cls?.office === 'measure';
    const name = String(r.N ?? '').replace(/\s+/g, ' ').trim();

    const choices = cands.map((c, i) => {
      if (isMeasure) return { name: names[i], party: 'OTHER', partyRaw: '' };
      const { party, known } = normalizeParty(c.P);
      if (!known) unmatched('party', c.P ?? '', `${t.state} ${name} / ${names[i]}`);
      return { name: names[i], party, partyRaw: c.P ?? '' };
    });
    // County files key candidates by their own id; propositions have ID null there, so match measures by name.
    const idx = (c) => {
      if (!isMeasure && c.id != null) {
        const i = cands.findIndex((x) => String(x.ID) === String(c.id));
        if (i >= 0) return i;
      }
      return names.indexOf(cleanName(c.N));
    };

    const methodsOf = (votes, early) => (early.some((x) => x != null)
      ? [
        { label: 'Early Voting', bucket: methodBucket('Early Voting'), votes: early.map((x) => x ?? 0) },
        // IVIS publishes total and early; election day is the remainder (the SOS site shows the same split).
        { label: 'Election Day', bucket: methodBucket('Election Day'), votes: votes.map((v, i) => Math.max(0, v - (early[i] ?? 0))) },
      ]
      : undefined);

    const countyUnits = [];
    let pr = 0; let tp = 0; let anyPrecincts = false;
    for (const [cid, co] of Object.entries(counties)) {
      const cr = co.Races?.[String(r.id)];
      if (!cr) continue;
      if (num(cr.TP) != null) { anyPrecincts = true; pr += num(cr.PR) ?? 0; tp += num(cr.TP); }
      const m = countyById.get(cid);
      if (!m) continue; // already logged as unmatched
      const votes = new Array(cands.length).fill(0);
      const early = new Array(cands.length).fill(null);
      for (const c of Object.values(cr.C ?? {})) {
        const i = idx(c);
        if (i < 0) { unmatched('candidate', cleanName(c.N), `${t.state} ${name} / ${co.N}`); continue; }
        votes[i] = num(c.V) ?? 0;
        early[i] = num(c.EV);
      }
      countyUnits.push({
        level: 'county', countyFips: m.fips, name: m.name, votes,
        precinctsReporting: num(cr.PR), precinctsTotal: num(cr.TP), pctReporting: pct(num(cr.PR), num(cr.TP)),
        methods: methodsOf(votes, early),
      });
    }

    const votes = cands.map((c) => num(c.V) ?? 0);
    const early = cands.map((c) => num(c.EV));
    const units = [{
      level: 'state', name: t.state, votes,
      precinctsReporting: anyPrecincts ? pr : null, precinctsTotal: anyPrecincts ? tp : null,
      pctReporting: anyPrecincts ? pct(pr, tp) : null,
      methods: methodsOf(votes, early),
    }, ...countyUnits];

    if (isMeasure) {
      const yi = names.findIndex((n) => yesNoSide(n) === 'yes');
      const ni = names.findIndex((n) => yesNoSide(n) === 'no');
      for (const u of units) { u.yes = u.votes[yi] ?? 0; u.no = u.votes[ni] ?? 0; }
    }

    // IVIS publishes no vote-for count; Texas general-election offices are all single-seat.
    const race = {
      office: cls?.office ?? null, district: cls?.district ?? null, name, key: String(r.id), voteFor: 1,
      statewide: !!cls || STATEWIDE_SECTIONS.has(r.section),
      title: isMeasure ? name : null, choices, units,
    };
    races.push(race);
  }

  // Election-wide turnout per county (Summary), and the statewide sum of what the counties publish.
  const turnout = [];
  const tot = { registered: 0, ballotsCast: 0, pr: 0, pt: 0, n: 0 };
  for (const [cid, co] of Object.entries(counties)) {
    const s = co.Summary ?? {};
    tot.n += 1;
    tot.registered += num(s.RV) ?? 0; tot.ballotsCast += num(s.VC) ?? 0;
    tot.pr += num(s.PRR) ?? 0; tot.pt += num(s.PRP) ?? 0;
    const m = countyById.get(cid);
    if (!m) continue;
    turnout.push({
      level: 'county', countyFips: m.fips, name: m.name,
      registered: num(s.RV), ballotsCast: num(s.VC), turnoutPct: num(s.VT), ballotsOutstanding: null,
      precinctsReporting: num(s.PRR), precinctsTotal: num(s.PRP),
    });
  }
  if (tot.n) {
    turnout.unshift({
      level: 'state', name: t.state, registered: tot.registered, ballotsCast: tot.ballotsCast,
      turnoutPct: null, // the source states turnout % per county only
      ballotsOutstanding: null, precinctsReporting: tot.pr, precinctsTotal: tot.pt,
    });
  }

  const version = String(election.Version ?? '');
  return {
    election: { sourceKey: t.key, state: t.state, scope: 'state', countyFips: null, name: t.label, date: parseElecDate(home.ElecDate), url: t.url },
    version,
    sourceUpdatedAt: localToIso(home.LastUpdatedTime, t.timeZone),
    turnout,
    races,
  };
}

/** "11032026" → "2026-11-03" */
const parseElecDate = (s) => (/^\d{8}$/.test(String(s ?? '')) ? `${s.slice(4)}-${s.slice(0, 2)}-${s.slice(2, 4)}` : null);

async function fetchTarget(t, { http, unmatched }) {
  const election = (await http.getJson(`${t.base}/election/${t.electionId}`, { timeoutMs: 60000 })).json;
  const version = String(election.Version ?? '');
  if (!version) throw new Error('IVIS election file has no Version');
  if (lastVersion.get(t.key) === version) return { changed: false, version };
  const countyInfo = (await http.getJson(`${t.base}/election/countyInfo/${t.electionId}`, { timeoutMs: 90000 })).json;
  const result = parseIvis(election, countyInfo, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result };
}

export default {
  id: 'txivis',
  name: 'Texas SOS election night results (Civix IVIS)',
  homepage: 'https://goelect.txelections.civixapps.com/ivis-enr-ui/races',
  targets,
  fetch: fetchTarget,
};
