// Hawaii Office of Elections: results text files (https://elections.hawaii.gov/election-results/).
//
// Each election has a folder https://elections.hawaii.gov/wp-content/results/{folder}/ (2026 Primary verified on
// 2026-11-03; "2026 General" 404s until the first release, about 7:45 pm HST, and the page links a "Placeholders" folder
// whose summary.txt says "Information will be posted at a later date."). The adapter reads
//   summary.txt   tab-separated, "#FormatVersion 1", one row per contest × candidate: Contest ID, Contest Title, Contest
//                 Seq Nbr, Contest Type, Contest Party (primary only), blank / over / invalid votes by Mail and In-Person,
//                 Registered Voters, Total Precincts, Counted Precincts, Candidate ID, Candidate Name, Candidate Seq Nbr,
//                 Candidate Party, Mail Votes, In-Person Votes, Total Votes.
// Statewide only: the files have no county column (precincts are House district-precinct numbers). media.txt (precinct
// level, ~2 MB) and the PDFs are not used. Hawaii's U.S. House districts are Roman numerals ("Dist I", "Dist II").
// No winner flags. Until the folder exists (404) or while it holds the placeholder text, no snapshot is written.
import { readConfig } from '../config.js';
import { HttpError } from '../http.js';
import { classifyContest, normalizeParty, methodBucket, yesNoSide } from '../normalize.js';

const lastVersion = new Map();

function targets() {
  const c = readConfig('sources/hioe.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `HI/${e.folder}`,
      state: 'HI',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      summary: `${c.base}/${encodeURIComponent(e.folder)}/summary.txt`,
      url: e.url ?? 'https://elections.hawaii.gov/election-results/',
      levels: ['state'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      allContests: e.allContests ?? true,
    }));
}

async function fetchTarget(t, { http, unmatched }) {
  let res;
  try {
    res = await http.get(t.summary, { conditional: true, accept: 'text/plain' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return { changed: false, version: lastVersion.get(t.key) ?? null }; // not released yet
    throw err;
  }
  if (!/^#FormatVersion/m.test(res.text)) return { changed: false, version: lastVersion.get(t.key) ?? null }; // placeholder text
  if (res.notModified && lastVersion.has(t.key)) return { changed: false, version: lastVersion.get(t.key) };
  const lm = res.headers?.get?.('last-modified');
  const version = res.headers?.get?.('etag')?.replace(/"/g, '') || lm || String(res.text.length);
  if (lastVersion.get(t.key) === version) return { changed: false, version };
  const result = parseHiSummary(res.text, t, unmatched);
  // The file's own modification time is the only "last updated" the folder offers.
  result.sourceUpdatedAt = lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : null;
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const unq = (s) => String(s ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim();
const num = (v) => {
  const s = unq(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const round1 = (x) => Math.round(x * 10) / 10;

/** Pure parse of summary.txt into the adapter result (without `version` / `sourceUpdatedAt`). */
export function parseHiSummary(text, t, unmatched = () => {}) {
  const lines = String(text).split(/\r?\n/);
  const hIdx = lines.findIndex((l) => /^#?Contest ID\t/i.test(l.trim()));
  if (hIdx < 0) throw new Error('HI summary.txt: header line "#Contest ID ..." not found');
  const header = lines[hIdx].replace(/^#/, '').split('\t').map((h) => unq(h));
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['Contest ID', 'Contest Title', 'Candidate Name', 'Total Votes']) {
    if (!(need in col)) throw new Error(`HI summary.txt: column "${need}" missing`);
  }
  const get = (cells, k) => (k in col ? cells[col[k]] : undefined);

  const contests = new Map();
  for (const line of lines.slice(hIdx + 1)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const id = unq(get(cells, 'Contest ID'));
    if (!id) continue;
    if (!contests.has(id)) {
      const contestParty = unq(get(cells, 'Contest Party'));
      contests.set(id, {
        id,
        title: unq(get(cells, 'Contest Title')).replace(/\s+/g, ' '),
        contestParty: /^n$/i.test(contestParty) ? '' : contestParty, // "N" = nonpartisan contest
        seq: num(get(cells, 'Contest Seq Nbr')) ?? 0,
        registered: num(get(cells, 'Registered Voters')),
        pt: num(get(cells, 'Total Precincts')),
        pr: num(get(cells, 'Counted Precincts')),
        cands: [],
      });
    }
    contests.get(id).cands.push({
      name: unq(get(cells, 'Candidate Name')).replace(/\s+/g, ' '),
      partyRaw: unq(get(cells, 'Candidate Party')),
      seq: num(get(cells, 'Candidate Seq Nbr')) ?? 999,
      mail: num(get(cells, 'Mail Votes')) ?? 0,
      inPerson: num(get(cells, 'In-Person Votes')) ?? 0,
      total: num(get(cells, 'Total Votes')) ?? 0,
    });
  }

  const list = [...contests.values()].sort((a, b) => a.seq - b.seq);
  const statePrecincts = list.reduce((m, c) => Math.max(m, c.pt ?? 0), 0) || null;
  const races = [];
  for (const c of list) {
    // A primary lists one contest per party ballot under the same title: the party is part of its name.
    const name = c.contestParty ? `${c.title} (${c.contestParty})` : c.title;
    const cands = [...c.cands].sort((a, b) => a.seq - b.seq);
    const labels = cands.map((x) => x.name);
    const cls = classifyContest(c.title, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    let district = cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null;
    if (cls?.office === 'house') {
      const r = c.title.match(/\bDist\.?\s+([IVX]+)\s*$/i);
      if (r && ROMAN[r[1].toUpperCase()]) district = String(ROMAN[r[1].toUpperCase()]);
    }
    const choices = cands.map((x) => {
      const raw = x.partyRaw || c.contestParty;
      if (isMeasure) return { name: x.name, party: 'OTHER', partyRaw: raw };
      const { party, known } = normalizeParty(raw);
      if (!known) unmatched('party', raw, `HI ${name} / ${x.name}`);
      return { name: x.name, party, partyRaw: raw };
    });
    const votes = cands.map((x) => x.total);
    const methods = [['Mail Votes', 'mail'], ['In-Person Votes', 'inPerson']].map(([label, k]) => {
      const v = cands.map((x) => x[k]);
      return { label, bucket: methodBucket(label), votes: isMeasure ? [v[yesIdx] ?? 0, v[noIdx] ?? 0] : v };
    });
    const statewide = statePrecincts != null && c.pt === statePrecincts;
    const unit = {
      level: 'state', name: statewide ? 'HI' : name, votes,
      precinctsReporting: c.pr, precinctsTotal: c.pt, pctReporting: c.pt ? round1((100 * (c.pr ?? 0)) / c.pt) : null,
      methods,
    };
    if (isMeasure) {
      unit.yes = votes[yesIdx] ?? 0;
      unit.no = votes[noIdx] ?? 0;
    }
    races.push({
      office: cls?.office ?? null,
      district,
      name,
      key: c.id,
      voteFor: null, // not in summary.txt
      statewide,
      title: isMeasure ? name : null,
      choices,
      units: [unit],
    });
  }

  const sw = list.filter((c) => c.pt === statePrecincts);
  const registered = sw.reduce((m, c) => Math.max(m, c.registered ?? 0), 0) || null;
  const top = sw[0];
  return {
    election: { sourceKey: t.key, state: 'HI', scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: null,
    turnout: registered || top ? [{
      level: 'state', name: 'HI', registered, ballotsCast: null, turnoutPct: null,
      precinctsReporting: top?.pr ?? null, precinctsTotal: top?.pt ?? null,
    }] : [],
    races,
  };
}

export default {
  id: 'hioe',
  name: 'Hawaii Office of Elections',
  homepage: 'https://elections.hawaii.gov/election-results/',
  targets,
  fetch: fetchTarget,
};
