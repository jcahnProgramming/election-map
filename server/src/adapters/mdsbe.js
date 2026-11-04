// Maryland State Board of Elections: static results pages (https://elections.maryland.gov/elections/2026/general_results/).
//
// Verified live on 2026-11-03 (before results: every number "NR", not reported). Plain server-written HTML:
//   gen_results_2026_by_county_{1..24}.html   one page per county (23 counties + Baltimore City) with EVERY contest on
//                                             that county's ballot, in order: <h1>…Results for {County}</h1>, then per
//                                             contest <h2>office</h2>, optional <h3>District 7 | Circuit 8 | judge name
//                                             (retention)</h3>, <h3>/<h4>Vote for (up to) N</h4>, "(x of y election day
//                                             precincts reported)" (that contest's precincts in that county), and a table:
//                                             Name | Party | Early Voting | Election Day | Mail-In Ballot | Provisional |
//                                             Total | Percentage (questions: the choice in a <th>, no Party column).
//   gen_results_2026_1.html                   the Governor page: its "Last refreshed: 11/03/2026 04:24:46 PM" (Eastern)
//                                             is the change check, read every poll (18 KB).
// Statewide and district totals are the sums of the county pages. Only offices that really span counties are summed
// across them (`multiCounty` in config: statewide offices, Congress, State Senate / House of Delegates districts, circuit
// and appellate judges, numbered statewide questions); every other contest ("Sheriff", "Question A: Bond Issue", …)
// belongs to its county and is stored once per county, never added to another county's contest of the same name.
// "Winner" checkmarks are ignored (we never call races).
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const state = new Map(); // target key → { refreshed, version }

function targets() {
  const c = readConfig('sources/mdsbe.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `MD/${e.id}`,
      state: 'MD',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      base: e.base.replace(/\/$/, ''),
      year: e.year,
      countyPages: e.countyPages ?? 24,
      utcOffset: e.utcOffset ?? '-05:00',
      multiCounty: new RegExp(e.multiCounty ?? c.multiCounty, 'i'),
      countyFips: { ...(c.countyFips ?? {}), ...(e.countyFips ?? {}) },
      url: `${e.base.replace(/\/$/, '')}/index.html`,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      allContests: e.allContests ?? true,
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 500,
    }));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));

/** "Last refreshed: 11/03/2026 04:24:46 PM" → ISO, read with the configured UTC offset (EST on election day). */
export function parseRefreshed(html, utcOffset = '-05:00') {
  const m = String(html).match(/Last refreshed:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (/pm/i.test(m[7])) h += 12;
  const p2 = (x) => String(x).padStart(2, '0');
  const d = new Date(`${m[3]}-${p2(m[1])}-${p2(m[2])}T${p2(h)}:${m[5]}:${m[6]}${utcOffset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchTarget(t, { http, unmatched }) {
  const s = state.get(t.key) ?? { refreshed: undefined, version: null };
  state.set(t.key, s);
  const head = await http.get(`${t.base}/gen_results_${t.year}_1.html`, { accept: 'text/html' });
  const refreshed = parseRefreshed(head.text, t.utcOffset);
  if (refreshed && refreshed === s.refreshed && s.version) return { changed: false, version: s.version };

  const pages = [];
  for (let i = 1; i <= t.countyPages; i++) {
    await pause(t.requestGapMs);
    pages.push((await http.get(`${t.base}/gen_results_${t.year}_by_county_${i}.html`, { accept: 'text/html' })).text);
  }
  const result = parseMdCountyPages(pages, t, unmatched);
  result.sourceUpdatedAt = refreshed;
  const version = refreshed ?? String(Date.now());
  s.refreshed = refreshed;
  s.version = version;
  return { changed: true, version, result: { ...result, version } };
}

const strip = (h) => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ').trim();
const num = (v) => {
  const s = strip(v).replace(/,/g, '');
  if (s === '' || /^nr$/i.test(s)) return null; // NR = not reported yet
  const n = Number(s.replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
};
const voteForOf = (s) => {
  const m = String(s).match(/vote for (?:up to )?(\d+)/i);
  return m ? Number(m[1]) : null;
};

/** One county page → { county, contests: [{ office, sub, voteFor, title, pr, pt, headers, rows: [{ name, party, cells }] }] }. */
export function parseCountyPage(html) {
  const county = strip(String(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/^.*Results for\s+/i, '').trim();
  const contests = [];
  let cur = null;
  const re = /<h2>([\s\S]*?)<\/h2>|<h3>([\s\S]*?)<\/h3>|<h4>([\s\S]*?)<\/h4>|<div class="bold">([\s\S]*?)<\/div>|\((\d+) of (\d+) election day precincts reported\)|<table[\s\S]*?<\/table>/gi;
  let ctx = { office: null, sub: null, voteFor: null, title: null, pr: null, pt: null };
  for (const m of String(html).matchAll(re)) {
    if (m[1] != null) ctx = { office: strip(m[1]), sub: null, voteFor: null, title: null, pr: null, pt: null };
    else if (m[2] != null || m[3] != null) {
      const text = strip(m[2] ?? m[3]);
      if (voteForOf(text)) ctx.voteFor = voteForOf(text);
      else ctx = { ...ctx, sub: text.replace(/\s*Vote Yes or No\b.*$/i, '').trim(), voteFor: null, pr: null, pt: null };
    } else if (m[4] != null) ctx.title = strip(m[4]) || null;
    else if (m[5] != null) {
      ctx.pr = Number(m[5]);
      ctx.pt = Number(m[6]);
    } else if (ctx.office) {
      const table = m[0];
      const headers = [...(table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] ?? '').matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => strip(x[1]));
      const rows = [];
      for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
        if (/<thead/i.test(tr[0]) || /scope="col"/i.test(tr[1])) continue;
        const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => x[1]);
        if (!cells.length) continue;
        const name = strip(cells[0]);
        if (!name || /^totals?$/i.test(name)) continue;
        rows.push({ name, cells });
      }
      cur = { ...ctx, headers, rows };
      contests.push(cur);
    }
  }
  return { county, contests };
}

const METHOD_HEADERS = ['Early Voting', 'Election Day', 'Mail-In Ballot', 'Provisional'];

/** Pure parse of the county pages into the adapter result (without `version` / `sourceUpdatedAt`). */
export function parseMdCountyPages(pages, t, unmatched = () => {}) {
  const st = 'MD';
  const contests = new Map(); // key → contest accumulator
  const counties = [];
  for (const html of pages) {
    const page = parseCountyPage(html);
    const cm = t.countyFips?.[page.county] ?? matchCounty(st, page.county);
    if (!cm) {
      unmatched('county', page.county, 'MD SBE county page');
      continue;
    }
    counties.push(cm.fips);
    for (const c of page.contests) {
      const base = c.sub ? `${c.office} ${c.sub}` : c.office;
      const multi = t.multiCounty.test(c.office);
      const key = multi ? base : `${base} (${cm.name})`;
      const name = multi ? base : `${cm.name}: ${base}`;
      const iName = c.headers.findIndex((h) => /^name$/i.test(h));
      const iParty = c.headers.findIndex((h) => /^party$/i.test(h));
      const iTotal = c.headers.findIndex((h) => /^total$/i.test(h));
      const methodIdx = METHOD_HEADERS.map((h) => [h, c.headers.indexOf(h)]).filter(([, i]) => i >= 0);
      if (!contests.has(key)) {
        contests.set(key, { key, name, office: c.office, sub: c.sub, voteFor: c.voteFor, title: c.title, choices: [], index: new Map(), units: [], methods: methodIdx.map(([h]) => h) });
      }
      const acc = contests.get(key);
      const votes = acc.choices.map(() => 0);
      const mv = acc.methods.map(() => acc.choices.map(() => 0));
      for (const r of c.rows) {
        const party = iParty >= 0 ? strip(r.cells[iParty]) : '';
        const ck = `${r.name}|${party}`;
        if (!acc.index.has(ck)) {
          acc.index.set(ck, acc.choices.length);
          acc.choices.push({ name: r.name, partyRaw: party });
          votes.push(0);
          mv.forEach((a) => a.push(0));
          for (const u of acc.units) {
            u.votes.push(0);
            u.mv.forEach((a) => a.push(0));
          }
        }
        const i = acc.index.get(ck);
        votes[i] = num(r.cells[iTotal >= 0 ? iTotal : r.cells.length - 2]) ?? 0;
        methodIdx.forEach(([h, ci]) => { mv[acc.methods.indexOf(h)][i] = num(r.cells[ci]) ?? 0; });
      }
      void iName;
      acc.units.push({ fips: cm.fips, name: cm.name, votes, mv, pr: c.pr, pt: c.pt });
    }
  }

  const races = [];
  for (const acc of contests.values()) {
    const labels = acc.choices.map((c) => c.name);
    const cls = classifyContest(acc.name, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    const choices = acc.choices.map((c) => {
      if (isMeasure || !c.partyRaw) return { name: c.name, party: 'OTHER', partyRaw: c.partyRaw };
      const { party, known } = normalizeParty(c.partyRaw);
      if (!known) unmatched('party', c.partyRaw, `MD ${acc.name} / ${c.name}`);
      return { name: c.name, party, partyRaw: c.partyRaw };
    });
    const yn = (u) => {
      if (isMeasure) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      return u;
    };
    const methodsOf = (mv) => acc.methods.map((label, k) => ({
      label, bucket: methodBucket(label), votes: isMeasure ? [mv[k][yesIdx] ?? 0, mv[k][noIdx] ?? 0] : mv[k],
    }));
    const statewide = counties.length > 0 && counties.every((f) => acc.units.some((u) => u.fips === f));
    const total = labels.map((_, i) => acc.units.reduce((a, u) => a + (u.votes[i] ?? 0), 0));
    const tmv = acc.methods.map((_, k) => labels.map((__, i) => acc.units.reduce((a, u) => a + (u.mv[k][i] ?? 0), 0)));
    const pKnown = acc.units.every((u) => u.pt != null);
    const pr = pKnown ? acc.units.reduce((a, u) => a + u.pr, 0) : null;
    const pt = pKnown ? acc.units.reduce((a, u) => a + u.pt, 0) : null;
    const units = [yn({
      level: 'state', name: statewide ? st : acc.name, votes: total, precinctsReporting: pr, precinctsTotal: pt,
      pctReporting: pt ? Math.round((1000 * pr) / pt) / 10 : null,
      ...(acc.methods.length ? { methods: methodsOf(tmv) } : {}),
    })];
    for (const u of acc.units) {
      units.push(yn({
        level: 'county', countyFips: u.fips, name: u.name, votes: u.votes, precinctsReporting: u.pr, precinctsTotal: u.pt,
        pctReporting: u.pt ? Math.round((1000 * u.pr) / u.pt) / 10 : null,
        ...(acc.methods.length ? { methods: methodsOf(u.mv) } : {}),
      }));
    }
    races.push({
      office: cls?.office ?? null,
      district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
      name: acc.name,
      key: acc.key,
      voteFor: acc.voteFor,
      statewide,
      title: isMeasure ? [acc.name, acc.title].filter(Boolean).join(' — ') : null,
      choices,
      units,
    });
  }

  return {
    election: { sourceKey: t.key, state: st, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: null,
    turnout: [],
    races,
  };
}

export default {
  id: 'mdsbe',
  name: 'Maryland State Board of Elections',
  homepage: 'https://elections.maryland.gov/',
  targets,
  fetch: fetchTarget,
};
