// Generic parser for the NIST SP 1500-100 Election Results Common Data Format (CDF), XML flavour.
// Not an adapter (leading "_": the registry skips it). Used by nistcdf.js; reusable by any state that
// publishes the CDF.
//
// Handles both schema generations:
//   V1 (IEEE 1622.2, xmlns ".../1622_2-election_results_reporting.xsd"; Ohio SOS uses this)
//     GpUnit attributes Name/Type/SubUnitsReported/TotalSubUnits/VotersRegistered/VotersParticipated,
//     <SummaryCounts Type BallotsCast BallotsOutstanding>, <VoteCounts Type Count><GpUnitId/>,
//     BallotMeasureSelection Selection="YES", Party Abbreviation as an attribute.
//   V2 (xmlns "http://itl.nist.gov/ns/voting/1500-100/v2")
//     <GpUnit><Name/><Type/>…, <BallotCounts><Type/><BallotsCast/>…, <VoteCounts><Type/><Count/><GpUnitId/>,
//     <Selection><Text><LanguageString/>, <Contest><ElectoralDistrictId/>, <FullText> on measures.
// Both are read through the same accessors (attribute first, then child element).
//
// What we deliberately ignore: anything that marks a winner (CountStatus, IsWinner, Status flags):
// we never call races.
//
// parseCdf(xml, { state, unmatched }) → { generatedDate, status, electionName, electionDate, turnout, races }
// races = every contest in the report (v0.3): U.S. Senate / House / Governor and ballot measures carry their built-in
// office; anything else has office null (State Senate / House / school districts get level + office from the type of
// the contest's electoral-district GpUnit) and is classified by server/src/contests.js when the snapshot is written.
// Retention contests (RetentionContest, or a yes/no "retain" question) are NOT measures: they come out as candidate-style
// races with choices Yes / No and kind 'retention'. Party / straight-ticket contests are not offices and are skipped.
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { classifyContest, methodBucket, normalizeParty, splitPartyPrefix, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const ARRAYS = new Set([
  'GpUnit', 'Party', 'Person', 'Candidate', 'Contest', 'BallotSelection', 'VoteCounts', 'CandidateId',
  'SummaryCounts', 'BallotCounts', 'LanguageString', 'Code', 'ExternalIdentifier', 'Office', 'ComposingGpUnitIds',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,       // xsi:type → @type, ns-prefixed elements → bare names
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

/** Attribute first (V1), then child element (V2). */
const field = (node, name) => {
  if (node == null) return undefined;
  const a = node[`@${name}`];
  if (a !== undefined) return a;
  const e = node[name];
  if (e === undefined) return undefined;
  return typeof e === 'object' && !Array.isArray(e) ? (e['#text'] ?? e) : e;
};

/** InternationalizedText (<LanguageString>) or a plain string → string (English preferred). */
function text(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v).replace(/\s+/g, ' ').trim() || null;
  if (Array.isArray(v)) return text(v[0]);
  if (v.Text !== undefined) return text(v.Text);
  const ls = v.LanguageString;
  if (ls) {
    const en = ls.find((s) => (s?.['@Language'] ?? 'en').startsWith('en')) ?? ls[0];
    return text(typeof en === 'object' ? en['#text'] : en);
  }
  if (v['#text'] !== undefined) return text(v['#text']);
  return null;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const xsiType = (node) => String(node?.['@type'] ?? '').replace(/^.*:/, '');
const countType = (node) => {
  const t = field(node, 'Type');
  return t === 'other' || t === 'Other' ? (field(node, 'OtherType') ?? 'Other') : (t ?? 'Total');
};
const isTotal = (label) => String(label).toLowerCase() === 'total';
const round1 = (x) => Math.round(x * 10) / 10;
const sumOrNull = (arr) => (arr.length && arr.every((x) => x == null) ? null : arr.reduce((s, x) => s + (x ?? 0), 0));

/** Content hash that ignores the report's own GeneratedDate (which changes on every export). */
export function cdfVersion(xml) {
  const stable = xml.replace(/\sGeneratedDate="[^"]*"/, '').replace(/<GeneratedDate>[^<]*<\/GeneratedDate>/, '');
  return createHash('sha1').update(stable).digest('hex').slice(0, 16);
}

/**
 * Some exporters write GeneratedDate with a 12-hour clock and no AM/PM (Ohio: "11:48:35Z" at 23:48 UTC).
 * With hour12 set, pick whichever of t-12h / t / t+12h is the latest moment not after `now` (+5 min clock
 * skew). t-12h covers "12:xx" written for 00:xx.
 */
export function fixGeneratedDate(iso, { hour12 = false, now = new Date() } = {}) {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  if (!hour12) return t.toISOString();
  const limit = now.getTime() + 5 * 60 * 1000;
  const H12 = 12 * 3600 * 1000;
  const pick = [t.getTime() + H12, t.getTime(), t.getTime() - H12].find((x) => x <= limit) ?? t.getTime();
  return new Date(pick).toISOString();
}

// ReportingUnitType of a contest's electoral district → level + office (V1 "StateSenate", V2 "state-senate").
const DISTRICT_HINT = {
  statesenate: { level: 'legislative', office: 'state_senate' },
  statehouse: { level: 'legislative', office: 'state_house' },
  school: { level: 'local', office: 'school_board' },
};
const COUNTY_TYPES = /^(county|parish|borough)$/i;
const SUBCOUNTY_TYPES = /^(precinct|split-?precinct|ward|town|township|city|municipality|village|polling-?place|vote-?center|drop-?box)$/i;

/**
 * @param {string} xml
 * @param {{ state:string, unmatched?:Function }} opts
 */
export function parseCdf(xml, { state, unmatched = () => {} } = {}) {
  const doc = parser.parse(xml);
  const report = doc.ElectionReport;
  if (!report) throw new Error('Not a NIST CDF ElectionReport');
  const election = Array.isArray(report.Election) ? report.Election[0] : report.Election;

  // ---- reporting units
  const units = new Map(); // ObjectId → unit
  for (const g of report.GpUnitCollection?.GpUnit ?? report.GpUnit ?? []) {
    const id = g['@ObjectId'];
    const type = countType(g);
    const fipsCode = [...(g.Code ?? []), ...(g.ExternalIdentifiers?.ExternalIdentifier ?? [])].find((c) => /^fips$/i.test(String(field(c, 'Type'))));
    const summary = [...(g.SummaryCounts ?? []), ...(g.BallotCounts ?? [])].map((s) => ({
      label: countType(s), ballotsCast: num(field(s, 'BallotsCast')), outstanding: num(field(s, 'BallotsOutstanding')),
    }));
    units.set(id, {
      id, type, name: text(field(g, 'Name')) ?? text(g.Name) ?? '',
      isElectoralDistrict: String(field(g, 'IsElectoralDistrict')) === 'true',
      fips: fipsCode ? String(field(fipsCode, 'Value')) : null,
      registered: num(field(g, 'VotersRegistered')),
      participated: num(field(g, 'VotersParticipated')),
      reported: num(field(g, 'SubUnitsReported')),
      total: num(field(g, 'TotalSubUnits')),
      summary,
      hasData: field(g, 'TotalSubUnits') !== undefined || summary.length > 0 || field(g, 'VotersRegistered') !== undefined,
    });
  }

  // County reporting units → FIPS (once, not per contest). Electoral-district "X County" units without
  // turnout data are a different GpUnit for county offices; only the reporting ones carry results for us.
  const countyOf = new Map(); // GpUnit id → { fips, name }
  for (const u of units.values()) {
    if (!COUNTY_TYPES.test(u.type)) continue;
    let m = null;
    if (u.fips && /^\d{5}$/.test(u.fips)) m = { fips: u.fips, name: u.name.replace(/\s+county$/i, '') };
    m ??= matchCounty(state, u.name);
    if (m) countyOf.set(u.id, m);
    else if (u.hasData) unmatched('county', u.name, `${state} NIST CDF GpUnit ${u.id}`);
  }

  const stateUnit = [...units.values()].find((u) => /^state$/i.test(u.type));
  const reportingCounties = [...units.values()].filter((u) => countyOf.has(u.id) && u.hasData);

  // Units with any vote counted, in any contest. Ohio's exporter writes <SummaryCounts Type="Total" BallotsCast="0"/>
  // (and VotersParticipated="0") until the count is complete, while votes are already flowing: a 0 there next to
  // counted votes is "not filled in yet", so it becomes null, never "0 ballots cast".
  const voted = new Set();
  for (const c of election?.ContestCollection?.Contest ?? election?.Contest ?? []) {
    for (const s of c.BallotSelection ?? []) {
      for (const vc of s.VoteCountsCollection?.VoteCounts ?? s.VoteCounts ?? []) {
        if ((num(field(vc, 'Count')) ?? 0) > 0) voted.add(text(vc.GpUnitId));
      }
    }
  }
  const castOf = (u, tot) => {
    const cast = tot?.ballotsCast ?? u.participated ?? null;
    // The state unit covers everything (its vote counts may sit on a separate statewide district unit).
    const anyVotes = /^state$/i.test(u.type) ? voted.size > 0 : voted.has(u.id);
    return cast === 0 && anyVotes ? null : cast;
  };

  // ---- turnout (election-wide, per county; state = the state unit's own numbers, else the county sum)
  const turnoutOf = (u) => {
    const tot = u.summary.find((s) => isTotal(s.label));
    const outs = u.summary.filter((s) => !isTotal(s.label) && s.outstanding != null).map((s) => s.outstanding);
    return {
      registered: u.registered,
      ballotsCast: castOf(u, tot),
      turnoutPct: null, // not published as a percentage
      ballotsOutstanding: tot?.outstanding ?? (outs.length ? outs.reduce((a, b) => a + b, 0) : null),
      precinctsReporting: u.reported,
      precinctsTotal: u.total,
    };
  };
  const turnout = [];
  const countyTurnout = reportingCounties.map((u) => ({ level: 'county', countyFips: countyOf.get(u.id).fips, name: countyOf.get(u.id).name, ...turnoutOf(u) }));
  if (stateUnit || countyTurnout.length) {
    const own = stateUnit?.hasData ? turnoutOf(stateUnit) : null;
    const agg = (k) => own?.[k] ?? (countyTurnout.length ? sumOrNull(countyTurnout.map((c) => c[k])) : null);
    // Ballots cast: a sum over only the counties that published one is not a statewide number.
    const aggCast = () => (own?.ballotsCast != null ? own.ballotsCast
      : countyTurnout.length && countyTurnout.every((c) => c.ballotsCast != null) ? agg('ballotsCast') : null);
    turnout.push({
      level: 'state', name: state,
      registered: agg('registered'), ballotsCast: aggCast(), turnoutPct: null,
      ballotsOutstanding: agg('ballotsOutstanding'), precinctsReporting: agg('precinctsReporting'), precinctsTotal: agg('precinctsTotal'),
    });
    turnout.push(...countyTurnout);
  }
  const turnoutByFips = new Map(countyTurnout.map((t) => [t.countyFips, t]));
  const stateTurnout = turnout[0] ?? null;

  // ---- parties and candidates
  const parties = new Map();
  for (const p of report.PartyCollection?.Party ?? report.Party ?? []) {
    parties.set(p['@ObjectId'], { abbr: text(field(p, 'Abbreviation')), name: text(p.Name) });
  }
  const persons = new Map();
  for (const p of report.PersonCollection?.Person ?? report.Person ?? []) persons.set(p['@ObjectId'], p);
  const candidates = new Map();
  for (const c of election?.CandidateCollection?.Candidate ?? election?.Candidate ?? []) {
    const person = persons.get(text(c.PersonId));
    candidates.set(c['@ObjectId'], { name: text(c.BallotName), partyId: text(c.PartyId) ?? text(person?.PartyId) });
  }

  const partyFor = (partyId, context) => {
    const p = parties.get(partyId);
    const raw = p?.abbr ?? p?.name ?? '';
    let r = normalizeParty(raw);
    if (!r.known && p?.name) r = normalizeParty(p.name).known ? normalizeParty(p.name) : r;
    if (!r.known && raw) unmatched('party', raw, context);
    return { party: r.party, partyRaw: raw };
  };

  // ---- contests
  const races = [];
  for (const c of election?.ContestCollection?.Contest ?? election?.Contest ?? []) {
    const kind = xsiType(c);
    if (/Party|Straight/i.test(kind)) continue;
    const name = text(field(c, 'Name')) ?? text(c.Name) ?? '';
    const abbr = text(field(c, 'Abbreviation'));
    const isRetention = /Retention/i.test(kind) || (/BallotMeasure/i.test(kind) && /\bretain(ed)?\b|\bretention\b/i.test(name));
    const isMeasure = /BallotMeasure/i.test(kind) && !isRetention;

    const sels = (c.BallotSelection ?? []).map((s) => {
      if (isMeasure || isRetention) {
        const label = text(field(s, 'Selection')) ?? text(s.Selection) ?? '';
        return { s, label, side: yesNoSide(label) };
      }
      const ids = (s.CandidateId ?? []).map(text);
      const cand = candidates.get(ids[0]) ?? {};
      const writeIn = String(field(s, 'IsWriteIn')) === 'true';
      const label = cand.name ?? (writeIn ? 'Write-in' : '');
      return { s, label, partyId: cand.partyId, writeIn };
    });
    const cls = isMeasure ? { office: 'measure', district: null } : isRetention ? null : classifyContest(name, sels.map((x) => x.label));

    // Top unit: the contest's electoral district (V2), else the state unit, else the first non-county/precinct unit counted.
    const counted = new Set();
    for (const x of sels) for (const vc of x.s.VoteCountsCollection?.VoteCounts ?? x.s.VoteCounts ?? []) counted.add(text(vc.GpUnitId));
    const ed = text(c.ElectoralDistrictId);
    let topId = ed && counted.has(ed) ? ed : null;
    topId ??= stateUnit && counted.has(stateUnit.id) ? stateUnit.id : null;
    topId ??= [...counted].find((id) => {
      const u = units.get(id);
      return u && !countyOf.has(id) && !SUBCOUNTY_TYPES.test(u.type);
    }) ?? null;
    const statewide = topId != null && topId === stateUnit?.id;

    const choices = sels.map((x) => {
      if (isMeasure || isRetention) return { name: x.label, party: 'OTHER', partyRaw: '' };
      if (x.partyId) {
        const { party, partyRaw } = partyFor(x.partyId, `${state} ${name} / ${x.label}`);
        return { name: x.label, party, partyRaw };
      }
      const sp = splitPartyPrefix(x.label);
      const { party, known } = normalizeParty(sp.partyRaw ?? '');
      if (sp.partyRaw && !known) unmatched('party', sp.partyRaw, `${state} ${name} / ${x.label}`);
      return { name: sp.name, party, partyRaw: sp.partyRaw ?? '' };
    });

    // votes[unitId][label] = [n per choice]
    const byUnit = new Map();
    sels.forEach((x, i) => {
      for (const vc of x.s.VoteCountsCollection?.VoteCounts ?? x.s.VoteCounts ?? []) {
        const uid = text(vc.GpUnitId);
        const label = countType(vc);
        if (!byUnit.has(uid)) byUnit.set(uid, new Map());
        const m = byUnit.get(uid);
        if (!m.has(label)) m.set(label, new Array(sels.length).fill(0));
        m.get(label)[i] += num(field(vc, 'Count')) ?? 0;
      }
    });

    const buildUnit = (uid, base) => {
      const m = byUnit.get(uid);
      const labels = [...m.keys()];
      const parts = labels.filter((l) => !isTotal(l));
      const votes = m.get(labels.find(isTotal)) ?? sels.map((_, i) => parts.reduce((s, l) => s + m.get(l)[i], 0));
      const unit = { ...base, votes };
      // CDF CountItemType values are hyphenated enums ("election-day", "absentee-mail"): bucket on the spaced form.
      if (parts.length) unit.methods = parts.map((l) => ({ label: l, bucket: methodBucket(l.replace(/-/g, ' ')), votes: m.get(l) }));
      return unit;
    };

    const out = [];
    if (topId && byUnit.has(topId)) {
      let prec = { precinctsReporting: null, precinctsTotal: null };
      const top = units.get(topId);
      if (top?.total != null) prec = { precinctsReporting: top.reported, precinctsTotal: top.total };
      else if (statewide && stateTurnout) prec = { precinctsReporting: stateTurnout.precinctsReporting, precinctsTotal: stateTurnout.precinctsTotal };
      out.push(buildUnit(topId, { level: 'state', name: statewide ? state : (top?.name ?? state), ...withPct(prec) }));
    }
    for (const uid of byUnit.keys()) {
      const county = countyOf.get(uid);
      if (!county) continue; // the top unit, a district, a precinct, or a county already logged as unmatched above
      // County precinct counts are county-wide; they describe a statewide contest's county, not a district's slice.
      const t = statewide ? turnoutByFips.get(county.fips) : null;
      const prec = { precinctsReporting: t?.precinctsReporting ?? null, precinctsTotal: t?.precinctsTotal ?? null };
      out.push(buildUnit(uid, { level: 'county', countyFips: county.fips, name: county.name, ...withPct(prec) }));
    }

    if (isMeasure) {
      const yi = sels.findIndex((x) => x.side === 'yes');
      const ni = sels.findIndex((x) => x.side === 'no');
      for (const u of out) {
        u.yes = yi >= 0 ? u.votes[yi] : null;
        u.no = ni >= 0 ? u.votes[ni] : null;
        if (u.methods) for (const mth of u.methods) mth.votes = [mth.votes[yi] ?? 0, mth.votes[ni] ?? 0];
      }
    }

    const fullText = text(c.FullText) ?? text(c.SummaryText) ?? text(c.BallotTitle);
    const race = {
      office: cls?.office ?? null,
      district: cls?.district ?? null,
      name: isMeasure ? (abbr || name) : name,
      key: c['@ObjectId'],
      voteFor: num(field(c, 'VotesAllowed')) ?? num(field(c, 'NumberElected')),
      statewide,
      title: isMeasure ? (fullText ?? (abbr && name !== abbr ? name : null)) : null,
      choices,
      units: out,
    };
    if (isRetention) race.kind = 'retention';
    // The electoral district's own type pins the legislature down better than the contest name does.
    const hint = !cls && topId ? DISTRICT_HINT[String(units.get(topId)?.type ?? '').toLowerCase().replace(/[^a-z]/g, '')] : null;
    if (hint) Object.assign(race, hint);
    races.push(race);
  }

  return {
    generatedDate: field(report, 'GeneratedDate') ?? null,
    status: field(report, 'Status') ?? null,
    electionName: text(election?.Name),
    electionDate: field(election, 'StartDate') ?? field(election, 'Date') ?? null,
    turnout,
    races,
  };
}

function withPct({ precinctsReporting, precinctsTotal }) {
  return {
    precinctsReporting, precinctsTotal,
    pctReporting: precinctsTotal ? round1((100 * (precinctsReporting ?? 0)) / precinctsTotal) : null,
  };
}
