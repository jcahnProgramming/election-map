// Clarity / Civix Election Night Reporting (results.enr.clarityelections.com).
//
// File layout (verified live on 2026-11-03 against CO/127407 and IA/127077):
//   /{ST}/elections.json                         list of a state's elections  [{ EID, ElectionName, Date, County }]
//   /{ST}/{County}/elections.json                same, for a county-run site
//   /{path}/{EID}/current_ver.txt                current version number (plain text; ETag'd, max-age=60)
//   /{path}/{EID}/{ver}/json/en/summary.json     array of contests: C name, K key, CH choices, P parties, V votes,
//                                                CAT category; at state level TP/PR count COUNTIES, not precincts
//   /{path}/{EID}/{ver}/json/details.json        { Contests:[{ K, P:[county names], V:[[votes per choice] per county],
//                                                  PX:[precincts reported], PY:[precincts participating], T:[totals] }] }
//   /{path}/{EID}/{ver}/reports/detailxml.zip    the same data as XML (not needed: the JSON has all we use)
// A {ver} folder never changes once published, so we only re-download when current_ver.txt changes.
//
// Which elections to poll is config, not code: config/sources/clarity.json.
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, yesNoSide } from '../normalize.js';
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
      measures: e.scope !== 'county',
      url: `${BASE}/${e.path}/${e.eid}/`,
    }));
}

async function fetchTarget(t, { http, unmatched }) {
  const root = `${BASE}/${t.path}/${t.eid}`;
  const verRes = await http.get(`${root}/current_ver.txt`, { conditional: true });
  const version = verRes.text.trim();
  if (!/^\d+$/.test(version)) throw new Error(`Unexpected current_ver.txt: ${JSON.stringify(version.slice(0, 60))}`);
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  const [summary, details] = await Promise.all([
    http.getJson(`${root}/${version}/json/en/summary.json`).then((r) => r.json),
    http.getJson(`${root}/${version}/json/details.json`).then((r) => r.json).catch(() => null),
  ]);
  const detailByKey = new Map((details?.Contests ?? []).map((c) => [String(c.K), c]));
  const allCounties = new Set((details?.Contests ?? []).flatMap((c) => c.P ?? []));

  const races = [];
  for (const c of summary) {
    const choices = c.CH ?? [];
    const cls = classifyContest(c.C, choices);
    if (!cls) continue;
    if (cls.office !== 'measure' && !t.races.includes(cls.office)) continue;
    if (cls.office === 'measure' && !t.measures) continue;

    const parties = (c.P ?? []).map((raw, i) => {
      const { party, known } = normalizeParty(raw);
      if (!known) unmatched('party', raw, `${t.state} ${c.C} / ${choices[i]}`);
      return { name: choices[i], party, partyRaw: raw ?? '' };
    });
    const det = detailByKey.get(String(c.K));
    const sumPx = det ? sum(det.PX) : null;
    const sumPy = det ? sum(det.PY) : null;

    // The election's own top unit: the whole state, or the one county a county site covers.
    const top = t.scope === 'state'
      ? { level: 'state', name: t.state }
      : { level: 'county', countyFips: t.countyFips, name: t.label };
    const units = [{
      ...top,
      votes: (c.V ?? []).map(Number),
      precinctsReporting: sumPx,
      precinctsTotal: sumPy,
      pctReporting: sumPy ? round1((100 * sumPx) / sumPy) : null,
    }];

    // County breakdown, when this is a statewide site that publishes it.
    if (t.scope === 'state' && det) {
      det.P.forEach((countyName, i) => {
        const m = matchCounty(t.state, countyName);
        if (!m) {
          unmatched('county', countyName, `${t.state} ${c.C}`);
          return;
        }
        units.push({
          level: 'county', countyFips: m.fips, name: m.name,
          votes: (det.V?.[i] ?? []).map(Number),
          precinctsReporting: det.PX?.[i] ?? null,
          precinctsTotal: det.PY?.[i] ?? null,
          pctReporting: det.PY?.[i] ? round1((100 * (det.PX?.[i] ?? 0)) / det.PY[i]) : null,
        });
      });
    }

    if (cls.office === 'measure') {
      const yesIdx = choices.findIndex((ch) => yesNoSide(ch) === 'yes');
      const noIdx = choices.findIndex((ch) => yesNoSide(ch) === 'no');
      for (const u of units) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
    }

    // A measure on a statewide feed that only some counties vote on is local (a city question, say).
    const statewide = cls.office !== 'measure' || !det || det.P.length >= allCounties.size;
    races.push({
      office: cls.office, district: cls.district, name: c.C, key: String(c.K), voteFor: c.VF ?? null,
      statewide, choices: parties, units,
    });
  }

  lastVersion.set(t.key, version);
  return {
    changed: true,
    version,
    result: {
      election: { sourceKey: t.key, state: t.state, scope: t.scope, countyFips: t.countyFips, name: t.label, date: null, url: t.url },
      version,
      races,
    },
  };
}

const sum = (a) => (Array.isArray(a) ? a.reduce((s, x) => s + (Number(x) || 0), 0) : null);
const round1 = (x) => Math.round(x * 10) / 10;

export default {
  id: 'clarity',
  name: 'Clarity / Civix Election Night Reporting',
  homepage: BASE,
  targets,
  fetch: fetchTarget,
};
