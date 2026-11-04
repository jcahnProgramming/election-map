// Alabama Secretary of State election night results (https://www2.alabamavotes.gov/electionNight/).
//
// Verified live on 2026-11-03 (7 of 67 counties in at 8:01 pm CST). Server-rendered ASP.NET pages:
//   statewideResultsByContest.aspx?ecode={ecode}       page 1 of the statewide results: Total Ballots Cast, Total
//                                                     Registered Voters, Counties Reported "x of 67", Last Updated, then
//                                                     contests (td.enrContestHeader) with candidate rows (name
//                                                     "Doug Jones (DEM)", votes). Page 1 holds Governor, Lt. Governor,
//                                                     U.S. Senator, the contested U.S. House districts and AG.
//   chooseCounty.aspx?ecode={ecode}                    links countyResultsByContest.aspx?cid={code}&ecode= for each county
//                                                     that has reported ({code} is Alabama's own county number).
//   countyResultsByContest.aspx?cid=&ecode=            page 1 of one county: the same layout plus "Boxes Reported: 3.13 %".
// Later pages ("Next >>") and "Export Data" are ASP.NET postbacks (a form submission per request): deliberately NOT used,
// so only the contests on page 1 are stored (allContests:false; the rest of the ballot is missing, not absent).
// Requests: the statewide page every poll (its "Last Updated" is the change check); on a change the county list, then
// county pages `sweepBatch` per poll. No winner marks are read.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const state = new Map();

function targets() {
  const c = readConfig('sources/alsos.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `AL/${e.ecode}`,
      state: 'AL',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      ecode: String(e.ecode),
      base: c.base.replace(/\/$/, ''),
      url: `${c.base.replace(/\/$/, '')}/statewideResultsByContest.aspx?ecode=${e.ecode}`,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: false,
      allContests: false,
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 500,
      sweepBatch: e.sweepBatch ?? c.sweepBatch ?? 10,
      utcOffset: e.utcOffset ?? '-06:00',
      electionTitle: e.electionTitle ?? null,
    }));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
const strip = (h) => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|’/g, "'").replace(/\s+/g, ' ').trim();
const num = (v) => {
  const s = strip(v).replace(/[,%]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function fetchTarget(t, { http, log, unmatched }) {
  const s = state.get(t.key) ?? { updated: undefined, statewide: null, counties: new Map(), queue: [], version: null };
  state.set(t.key, s);
  const get = async (path) => {
    await pause(t.requestGapMs);
    return (await http.get(`${t.base}/${path}`, { accept: 'text/html' })).text;
  };
  const sw = await get(`statewideResultsByContest.aspx?ecode=${t.ecode}`);
  const page = parseAlPage(sw);
  if (t.electionTitle && page.title && page.title !== t.electionTitle) {
    log?.warn?.(`AL: ecode ${t.ecode} shows "${page.title}", not "${t.electionTitle}"; nothing stored`);
    return { changed: false, version: s.version };
  }
  if (page.lastUpdated !== s.updated) {
    s.statewide = page;
    s.updated = page.lastUpdated;
    if (page.contests.length) {
      const list = await get(`chooseCounty.aspx?ecode=${t.ecode}`);
      const cids = [...new Set([...list.matchAll(/countyResultsByContest\.aspx\?cid=(\d+)/gi)].map((m) => m[1]))];
      s.queue = [...new Set([...s.queue, ...cids])];
    }
  }
  for (const cid of s.queue.splice(0, t.sweepBatch)) {
    try {
      s.counties.set(cid, parseAlPage(await get(`countyResultsByContest.aspx?cid=${cid}&ecode=${t.ecode}`)));
    } catch (err) {
      s.queue.unshift(cid);
      throw err;
    }
  }
  const result = buildAl(s.statewide, [...s.counties.values()], t, unmatched);
  const version = createHash('sha1').update(JSON.stringify(result)).digest('hex').slice(0, 16);
  if (version === s.version) return { changed: false, version };
  s.version = version;
  if (s.queue.length) log?.info?.(`AL: ${s.queue.length} county pages left`);
  return { changed: true, version, result: { ...result, version } };
}

/** "11/03/2026 08:01:56 PM" (Central) → ISO. */
export function parseAlTime(s, offset = '-06:00') {
  const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (/pm/i.test(m[7])) h += 12;
  const p2 = (x) => String(x).padStart(2, '0');
  const d = new Date(`${m[3]}-${p2(m[1])}-${p2(m[2])}T${p2(h)}:${m[5]}:${m[6]}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One results page (statewide or county) → header figures + contests [{ name, rows: [{ label, votes }] }]. */
export function parseAlPage(html) {
  const text = strip(html);
  const pick = (re) => text.match(re)?.[1] ?? null;
  const contests = [];
  const parts = String(html).split(/class="enrContestHeader"[^>]*>/i).slice(1);
  for (const part of parts) {
    const name = strip(part.slice(0, part.indexOf('<')));
    const rows = [];
    for (const m of part.matchAll(/enrCandNameCol"[^>]*>([\s\S]*?)<\/td>[\s\S]*?enrCandVoteNumCol"[^>]*>([\s\S]*?)<\/td>/gi)) {
      const label = strip(m[1]);
      if (!label) continue; // the totals row has no name
      rows.push({ label, votes: num(m[2]) ?? 0 });
      if (/class="enrContestHeader"/i.test(m[0])) break;
    }
    if (name) contests.push({ name, rows });
  }
  return {
    title: strip(String(html).match(/(\d{4} [A-Z ]*ELECTION)\s/)?.[1] ?? '') || null,
    // "2026 GENERAL ELECTION Baldwin County Results": title-case words right before "County Results" (St. Clair, DeKalb).
    county: pick(/ELECTION\s+((?:[A-Z][a-z.'][A-Za-z.']*\s)*[A-Z][a-z.'][A-Za-z.']*) County Results/),
    ballotsCast: num(pick(/Total Ballots Cast:\s*([\d,]+)/i)),
    registered: num(pick(/Total Registered Voters:\s*([\d,]+)/i)),
    countiesReported: num(pick(/Counties Reported:\s*(\d+) of \d+/i)),
    countiesTotal: num(pick(/Counties Reported:\s*\d+ of (\d+)/i)),
    boxesPct: num(pick(/Boxes Reported:\s*([\d.]+)\s*%/i)),
    lastUpdated: pick(/Last Updated:\s*(\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M)/i),
    contests,
  };
}

/** Pure build of the adapter result from the parsed statewide page and county pages (without `version`). */
export function buildAl(statewide, countyPages, t, unmatched = () => {}) {
  const st = 'AL';
  const races = [];
  const counties = [];
  for (const p of countyPages) {
    const m = p.county ? matchCounty(st, p.county) : null;
    if (!m) {
      unmatched('county', p.county ?? '(none)', 'AL county page');
      continue;
    }
    counties.push({ m, p });
  }
  for (const c of statewide?.contests ?? []) {
    const split = c.rows.map((r) => {
      const mm = r.label.match(/^(.*\S)\s+\(([A-Z]{2,6})\)$/);
      return mm ? { name: mm[1], partyRaw: mm[2] } : { ...splitPartyPrefix(r.label), partyRaw: '' };
    });
    const labels = split.map((x) => x.name);
    const cls = classifyContest(c.name, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    const choices = split.map((x) => {
      if (isMeasure || !x.partyRaw) return { name: x.name, party: 'OTHER', partyRaw: x.partyRaw ?? '' };
      const { party, known } = normalizeParty(x.partyRaw);
      if (!known) unmatched('party', x.partyRaw, `AL ${c.name} / ${x.name}`);
      return { name: x.name, party, partyRaw: x.partyRaw };
    });
    const yn = (u) => {
      if (isMeasure) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      return u;
    };
    const statewideOffice = !/\b(district|circuit|county|place no)\b/i.test(c.name) || cls?.office === 'senate' || cls?.office === 'governor';
    const units = [yn({
      level: 'state', name: statewideOffice ? st : c.name, votes: c.rows.map((r) => r.votes),
      // The page's own "Counties Reported: 56 of 67" (election-wide): shown as counties reported for statewide
      // offices, the only contests every county votes on. District contests get no figure (it isn't per contest).
      ...(statewideOffice && statewide?.countiesTotal
        ? { countiesComplete: statewide.countiesReported ?? 0, countiesTotal: statewide.countiesTotal } : {}),
      precinctsReporting: null, precinctsTotal: null, pctReporting: null,
    })];
    for (const { m, p } of counties) {
      const cc = p.contests.find((x) => x.name === c.name);
      if (!cc) continue;
      const by = new Map(cc.rows.map((r) => [r.label, r.votes]));
      units.push(yn({
        level: 'county', countyFips: m.fips, name: m.name, votes: c.rows.map((r) => by.get(r.label) ?? 0),
        precinctsReporting: null, precinctsTotal: null, pctReporting: p.boxesPct,
      }));
    }
    races.push({
      office: cls?.office ?? null,
      district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
      name: c.name,
      key: c.name,
      voteFor: null,
      statewide: statewideOffice,
      title: isMeasure ? c.name : null,
      choices,
      units,
    });
  }
  const turnout = [];
  if (statewide) {
    turnout.push({
      level: 'state', name: st, registered: statewide.registered, ballotsCast: statewide.ballotsCast,
      turnoutPct: statewide.registered ? Math.round((1000 * (statewide.ballotsCast ?? 0)) / statewide.registered) / 10 : null,
      precinctsReporting: null, precinctsTotal: null,
    });
    for (const { m, p } of counties) {
      turnout.push({ level: 'county', countyFips: m.fips, name: m.name, registered: p.registered, ballotsCast: p.ballotsCast, turnoutPct: p.registered ? Math.round((1000 * (p.ballotsCast ?? 0)) / p.registered) / 10 : null });
    }
  }
  return {
    election: { sourceKey: t.key, state: st, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: parseAlTime(statewide?.lastUpdated, t.utcOffset),
    turnout,
    races,
  };
}

export default {
  id: 'alsos',
  name: 'Alabama Secretary of State',
  homepage: 'https://www2.alabamavotes.gov/electionNight/',
  targets,
  fetch: fetchTarget,
};
