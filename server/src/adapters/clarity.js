// Clarity / Civix Election Night Reporting (results.enr.clarityelections.com).
//
// File layout (verified live on 2026-11-03 against CO/127407, IA/127077, SC/127300 and TX/Denton/127398):
//   /{ST}/elections.json                         list of a state's elections  [{ EID, ElectionName, Date, County }]
//   /{ST}/{County}/elections.json                same, for a county-run site
//   /{path}/{EID}/current_ver.txt                current version number (plain text; ETag'd, max-age=60)
//   /{path}/{EID}/{ver}/json/en/summary.json     array of contests: C name, K key, CH choices, P parties, V votes,
//                                                CAT category; at state level TP/PR count COUNTIES, not precincts
//   /{path}/{EID}/{ver}/json/details.json        { Contests:[{ K, P:[county names], V:[[votes per choice] per county],
//                                                  PX:[precincts reported], PY:[precincts participating], T:[totals] }] }
//   /{path}/{EID}/{ver}/json/en/electionsettings.json
//                                                websiteupdatedat "11/3/2026 10:46:50 AM MST" (the site's own
//                                                "last updated"), stateprecinctsreporting / stateprecinctsparticipating
//   /{path}/{EID}/{ver}/reports/detailxml.zip    detail.xml: <ElectionResult><Timestamp/><ElectionDate>11/3/2026</>
//       statewide:  <ElectionVoterTurnout totalVoters ballotsCast voterTurnout><Counties><County name totalVoters
//                     ballotsCast voterTurnout precinctsParticipating precinctsReported/></Counties>
//       county site: <VoterTurnout totalVoters ballotsCast voterTurnout><Precincts><Precinct .../></Precincts>
//       <Contest key text isQuestion ...><Choice key text party totalVotes><VoteType name="Election Day" votes>
//         <County name votes/> (statewide) | <Precinct name votes/> (county site)
//       VoteType names are free text per state: CO only "Total Votes" (no split); IA "Absentee", "Election Day";
//       SC "Absentee By Mail", "Early Voting", "Election Day", "Failsafe", "Failsafe Provisional", "Provisional"
//       (one county spells it "Provionsal"); TX/Denton "Absentee", "Early", "Election".
//   /{path}/{EID}/{ver}/json/vt.json             vote-type breakdown; empty ({Types:[],Contests:[]}) on all sites probed
// No measure has a title beyond its contest name in any Clarity file, so measure `title` stays null.
// A {ver} folder never changes once published, so everything is re-downloaded only when current_ver.txt changes.
//
// Which elections to poll is config, not code: config/sources/clarity.json.
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide, splitPartyPrefix, methodBucket } from '../normalize.js';
import { matchCounty } from '../geo.js';

const BASE = 'https://results.enr.clarityelections.com';
const lastVersion = new Map(); // target key → version

function targets() {
  const cfg = readConfig('sources/clarity.json', { elections: [] });
  return cfg.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `${e.path}/${e.eid}`,
      path: e.path,
      eid: String(e.eid),
      state: e.state,
      scope: e.scope ?? (e.path.includes('/') ? 'county' : 'state'),
      countyFips: e.countyFips ?? null,
      label: e.name,
      levels: e.scope === 'county' ? ['county'] : ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      // `races` / `measures` say what this site is expected to carry (coverage); they no longer filter what is stored.
      measures: e.scope !== 'county',
      // A statewide site lists every contest on its ballot; a county-run site only that county's, so it can't speak
      // for the whole state's ballot.
      allContests: e.allContests ?? (e.scope ?? (e.path.includes('/') ? 'county' : 'state')) === 'state',
      url: `${BASE}/${e.path}/${e.eid}/`,
      ...(e.election ? { election: e.election } : {}),
    }));
}

async function fetchTarget(t, { http, log, unmatched }) {
  const root = `${BASE}/${t.path}/${t.eid}`;
  const verRes = await http.get(`${root}/current_ver.txt`, { conditional: true });
  const version = verRes.text.trim();
  if (!/^\d+$/.test(version)) throw new Error(`Unexpected current_ver.txt: ${JSON.stringify(version.slice(0, 60))}`);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const optional = (what, p) => p.catch((err) => {
    log?.warn?.(`${what} unavailable for version ${version}: ${err.message}`);
    return null;
  });
  const [summary, details, settings, zip] = await Promise.all([
    http.getJson(`${root}/${version}/json/en/summary.json`).then((r) => r.json),
    optional('details.json', http.getJson(`${root}/${version}/json/details.json`).then((r) => r.json)),
    optional('electionsettings.json', http.getJson(`${root}/${version}/json/en/electionsettings.json`).then((r) => r.json)),
    optional('detailxml.zip', http.getBuffer(`${root}/${version}/reports/detailxml.zip`).then((r) => r.body)),
  ]);
  let detailXml = null;
  if (zip) {
    try {
      const files = unzipSync(zip);
      const name = Object.keys(files).find((f) => f.toLowerCase().endsWith('.xml'));
      detailXml = name ? strFromU8(files[name]) : null;
    } catch (err) {
      log?.warn?.(`detailxml.zip unreadable for version ${version}: ${err.message}`);
    }
  }

  const result = parseClarity({ target: t, version, summary, details, settings, detailXml }, { unmatched, log });
  lastVersion.set(t.key, version);
  return { changed: true, version, result };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ['Contest', 'Choice', 'VoteType', 'County', 'Precinct'].includes(name),
});

/** Parse detail.xml into the bits summary/details JSON lack: turnout, vote-type splits, timestamp, date. */
export function parseDetailXml(xml) {
  const root = xmlParser.parse(xml)?.ElectionResult;
  if (!root) return null;
  const turnout = root.ElectionVoterTurnout ?? root.VoterTurnout ?? null;
  const contests = new Map();
  for (const c of root.Contest ?? []) {
    const choices = (c.Choice ?? []).map((ch) => ({
      key: ch.key,
      text: String(ch.text ?? '').trim(),
      voteTypes: (ch.VoteType ?? []).map((vt) => ({
        name: String(vt.name ?? '').trim(),
        votes: num(vt.votes),
        // statewide sites split by county; county sites by precinct (we only need the county-site total)
        byCounty: new Map((vt.County ?? []).map((x) => [String(x.name).trim(), num(x.votes)])),
      })),
    }));
    contests.set(String(c.key), { key: String(c.key), text: c.text, choices });
  }
  return {
    timestamp: root.Timestamp ?? null,
    electionDate: root.ElectionDate ?? null,
    turnout: turnout && {
      registered: num(turnout.totalVoters),
      ballotsCast: num(turnout.ballotsCast),
      turnoutPct: num(turnout.voterTurnout),
      counties: (turnout.Counties?.County ?? []).map((x) => ({
        name: String(x.name).trim(),
        registered: num(x.totalVoters),
        ballotsCast: num(x.ballotsCast),
        turnoutPct: num(x.voterTurnout),
        precinctsTotal: num(x.precinctsParticipating),
        precinctsReporting: num(x.precinctsReported),
      })),
    },
    contests,
  };
}

/**
 * Turn one Clarity version's files into the adapter result (docs/data-contract.md section 1). Pure: no I/O.
 * @param {{ target:object, version:string, summary:object[]|{Contests:object[]}, details?:object|null,
 *           settings?:object|null, detailXml?:string|null }} input
 * @param {{ unmatched?:Function, log?:object }} [ctx]
 */
export function parseClarity({ target: t, version, summary, details = null, settings = null, detailXml = null }, ctx = {}) {
  const unmatched = ctx.unmatched ?? (() => {});
  const contestsIn = Array.isArray(summary) ? summary : summary?.Contests ?? [];
  const detailByKey = new Map((details?.Contests ?? []).map((c) => [String(c.K), c]));
  const allCounties = new Set((details?.Contests ?? []).flatMap((c) => c.P ?? []));
  let xml = null;
  try {
    xml = detailXml ? parseDetailXml(detailXml) : null;
  } catch (err) {
    ctx.log?.warn?.(`detail.xml unparseable: ${err.message}`);
  }
  const countyOf = new Map(); // Clarity county name → geo match (memo; unmatched logged once per name)
  const county = (name, context) => {
    if (!countyOf.has(name)) {
      const m = matchCounty(t.state, name);
      if (!m) unmatched('county', name, context);
      countyOf.set(name, m);
    }
    return countyOf.get(name);
  };

  // The election's own top unit: the whole state, or the one county a county site covers.
  const top = t.scope === 'state'
    ? { level: 'state', name: t.state }
    : { level: 'county', countyFips: t.countyFips, name: t.label };

  const races = [];
  const seenKeys = new Set();
  for (const c of contestsIn) {
    // Every contest is stored. The built-in classifier names the headline offices and yes/no measures; anything else
    // (legislature, judges, retention, county and local offices) goes out with office null and is classified by
    // contests.enrichRaces from config rules when the snapshot is written.
    if (c?.C == null || c.K == null) continue; // not a contest (no name / key): nothing to store it under
    if (seenKeys.has(String(c.K))) continue; // a repeated contest key would overwrite the first in the snapshot
    seenKeys.add(String(c.K));
    const choices = c.CH ?? [];
    let cls = classifyContest(c.C, choices);
    if (!cls && isYesNoQuestion(c.C, choices)) cls = { office: 'measure', district: null };

    const parties = choices.map((label, i) => {
      const raw = c.P?.[i] ?? '';
      // SC prefixes the party to the name ("REP Darline Graham"): keep the name clean, the label in partyRaw.
      // The prefix is stripped only when it is exactly this choice's party label (or a known party word when P is empty).
      const text = String(label ?? '').trim();
      let name = text;
      if (raw && text.toLowerCase().startsWith(`${String(raw).toLowerCase()} `)) name = text.slice(String(raw).length).trim();
      else if (!raw) {
        const sp = splitPartyPrefix(text);
        if (sp.partyRaw) name = sp.name;
      }
      const partyRaw = raw || (name !== text ? splitPartyPrefix(text).partyRaw ?? '' : '');
      const { party, known } = normalizeParty(partyRaw);
      if (!known) unmatched('party', partyRaw, `${t.state} ${c.C} / ${label}`);
      return { name: name || text, party, partyRaw };
    });
    const det = detailByKey.get(String(c.K));
    // Precincts: per-county PX/PY on statewide sites. County sites have no PX/PY, but there the summary's
    // PR/TP count precincts (at state level they count counties, so they are never used there).
    let sumPx = det ? sum(det.PX) : null;
    let sumPy = det ? sum(det.PY) : null;
    if (t.scope === 'county' && sumPy == null && num(c.TP)) {
      sumPx = num(c.PR);
      sumPy = num(c.TP);
    }

    const units = [{
      ...top,
      votes: (c.V ?? []).map(Number),
      precinctsReporting: sumPx,
      precinctsTotal: sumPy,
      pctReporting: sumPy ? round1((100 * sumPx) / sumPy) : null,
    }];

    // County breakdown, when this is a statewide site that publishes it.
    if (t.scope === 'state' && det) {
      (det.P ?? []).forEach((countyName, i) => {
        const m = county(countyName, `${t.state} ${c.C}`);
        if (!m) return;
        units.push({
          level: 'county', countyFips: m.fips, name: m.name, clarityName: countyName,
          votes: (det.V?.[i] ?? []).map(Number),
          precinctsReporting: det.PX?.[i] ?? null,
          precinctsTotal: det.PY?.[i] ?? null,
          pctReporting: det.PY?.[i] ? round1((100 * (det.PX?.[i] ?? 0)) / det.PY[i]) : null,
        });
      });
    }

    // Vote-method splits from detail.xml, when the site splits by more than "Total Votes".
    const xc = xml?.contests.get(String(c.K));
    if (xc) attachMethods(units, choices, xc);

    const isMeasure = cls?.office === 'measure';
    if (isMeasure) {
      const yesIdx = choices.findIndex((ch) => choiceSide(ch) === 'yes');
      const noIdx = choices.findIndex((ch) => choiceSide(ch) === 'no');
      for (const u of units) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
        if (u.methods) u.methods = u.methods.map((m) => ({ ...m, votes: [m.votes[yesIdx] ?? null, m.votes[noIdx] ?? null] }));
      }
    }
    for (const u of units) delete u.clarityName;

    // A measure on a statewide feed that only some counties vote on is local (a city question, say); every measure on
    // a county-run site is local.
    const statewide = !isMeasure || (t.scope === 'state' && (!det || (det.P ?? []).length >= allCounties.size));
    races.push({
      office: cls?.office ?? null, district: cls?.district ?? null, name: c.C, key: String(c.K), voteFor: num(c.VF),
      title: null, // Clarity publishes nothing beyond the contest name
      statewide, choices: parties, units,
    });
  }

  const turnout = buildTurnout(t, xml, settings, top, county, races);
  const sourceUpdatedAt = parseClarityTime(settings?.websiteupdatedat) ?? parseClarityTime(xml?.timestamp);
  return {
    election: {
      sourceKey: t.key, state: t.state, scope: t.scope, countyFips: t.countyFips, name: t.label,
      date: parseUsDate(xml?.electionDate), url: t.url,
      ...(t.election ? { electionKey: t.election } : {}),
    },
    version,
    sourceUpdatedAt,
    turnout,
    races,
  };
}

/**
 * Measure choice → 'yes' | 'no' | null. Besides Yes/No/For/Against (shared yesNoSide), AZ county sites word bond and
 * budget-override questions "BOND APPROVAL, YES / APROBACIÓN DE BONO, SÍ" (English before the slash).
 */
export function choiceSide(label) {
  const s = String(label ?? '').trim();
  const yn = yesNoSide(s);
  if (yn) return yn;
  const m = s.split('/')[0].match(/,\s*(yes|no)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// A yes/no about keeping a judge is a retention contest, not a measure (same test as normalize.classifyContest).
const JUDICIAL = /\b(retain|retention|justice|judge|court)\b/i;
function isYesNoQuestion(name, choices) {
  if (choices.length !== 2 || JUDICIAL.test(String(name))) return false;
  const sides = choices.map(choiceSide);
  return sides.includes('yes') && sides.includes('no');
}

// Labels some Clarity sites use that the shared methodBucket() doesn't recognise on its own.
const CLARITY_BUCKETS = { election: 'election_day', provionsal: 'provisional', failsafe: 'other' };
const bucketOf = (label) => CLARITY_BUCKETS[label.toLowerCase()] ?? methodBucket(label);

/** Add `methods` to each unit from the matching detail.xml contest. Units without a split get none. */
function attachMethods(units, choices, xc) {
  // Match XML choices to summary choices by text; fall back to position.
  const byText = new Map(xc.choices.map((ch) => [ch.text.toLowerCase(), ch]));
  const xmlChoices = choices.map((label, i) => byText.get(String(label).trim().toLowerCase()) ?? xc.choices[i] ?? null);
  const labels = [];
  for (const ch of xmlChoices) for (const vt of ch?.voteTypes ?? []) if (!labels.includes(vt.name)) labels.push(vt.name);
  // "Total Votes" alone is not a split (CO): no methods rather than one method equal to the total.
  const split = labels.filter((l) => !/^total votes$/i.test(l));
  if (!split.length) return;
  const vtOf = (ch, label) => ch?.voteTypes.find((v) => v.name === label) ?? null;
  for (const u of units) {
    u.methods = split.map((label) => ({
      label,
      bucket: bucketOf(label),
      votes: xmlChoices.map((ch) => {
        const vt = vtOf(ch, label);
        if (!vt) return null;
        if (u.level === 'state' || !u.clarityName) return vt.votes;
        return vt.byCounty.get(u.clarityName) ?? null;
      }),
    }));
  }
}

/** Election-wide turnout units from detail.xml + electionsettings.json. */
function buildTurnout(t, xml, settings, top, county, races) {
  const out = [];
  const reg = (n) => (n ? n : null); // 0 registered voters means "not published", not zero voters
  const precincts = settings && num(settings.stateprecinctsparticipating)
    ? { precinctsReporting: num(settings.stateprecinctsreporting), precinctsTotal: num(settings.stateprecinctsparticipating) }
    : { precinctsReporting: null, precinctsTotal: null };
  const x = xml?.turnout;
  if (x) {
    out.push({
      ...top, registered: reg(x.registered), ballotsCast: x.ballotsCast, turnoutPct: x.turnoutPct, ballotsOutstanding: null,
      ...(t.scope === 'state' ? precincts : { precinctsReporting: null, precinctsTotal: null }),
    });
    if (t.scope === 'state') {
      for (const c of x.counties) {
        const m = county(c.name, `${t.state} turnout`);
        if (!m) continue;
        out.push({
          level: 'county', countyFips: m.fips, name: m.name, registered: reg(c.registered), ballotsCast: c.ballotsCast,
          turnoutPct: c.turnoutPct, ballotsOutstanding: null, precinctsReporting: c.precinctsReporting, precinctsTotal: c.precinctsTotal,
        });
      }
    }
  } else if (t.scope === 'state' && precincts.precinctsTotal) {
    out.push({ ...top, registered: null, ballotsCast: null, turnoutPct: null, ballotsOutstanding: null, ...precincts });
  }
  // Some sites never fill ballotsCast (it stays 0 while votes come in): that is "not published", not zero.
  const votesIn = new Map();
  for (const r of races) {
    for (const u of r.units) {
      const k = u.level === 'state' ? 'state' : u.countyFips;
      const n = r.office === 'measure' ? (u.yes ?? 0) + (u.no ?? 0) : u.votes.reduce((s, v) => s + (v || 0), 0);
      votesIn.set(k, (votesIn.get(k) ?? 0) + n);
    }
  }
  for (const u of out) {
    const k = u.level === 'state' ? 'state' : u.countyFips;
    if (u.ballotsCast === 0 && (votesIn.get(k) ?? 0) > 0) {
      u.ballotsCast = null;
      u.turnoutPct = null;
    }
  }
  return out;
}

// Clarity stamps local time with a US zone abbreviation: "11/3/2026 10:46:50 AM MST".
const ZONES = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10, HDT: -9 };
export function parseClarityTime(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)? ?([A-Z]{2,4})?$/i);
  if (!m) return null;
  const [, mo, d, y, hh, mi, ss = '0', ap, zone] = m;
  const off = zone ? ZONES[zone.toUpperCase()] : undefined;
  if (off === undefined) return null; // a time without a known zone can't be placed honestly
  let h = Number(hh) % 12;
  if (ap ? ap.toUpperCase() === 'PM' : Number(hh) >= 12) h += 12;
  if (!ap) h = Number(hh);
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), h - off, Number(mi), Number(ss));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseUsDate(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : null);
const round1 = (x) => Math.round(x * 10) / 10;

export default {
  id: 'clarity',
  name: 'Clarity / Civix Election Night Reporting',
  homepage: BASE,
  targets,
  fetch: fetchTarget,
};
