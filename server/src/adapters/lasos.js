// Louisiana Secretary of State election results (https://voterportal.sos.la.gov/graphical).
//
// Verified live on 2026-11-03 (before polls closed: all 0). The page's own Angular bundle reads JSON "blobs" from
//   https://voterportal.sos.la.gov/ElectionResults/ElectionResults/Data?blob={name}
// with dated files under {yyyyMMdd}/:
//   CurrentVersion.htm                       { Current: { VersionDateTime } }: moves with every publish (57 bytes; the
//                                            change check, read every poll).
//   ElectionMode.htm                         { ElectionMode: { PKElectionID } } (2026-11-03 = 344).
//   {d}/RacesCandidates_Multiparish.htm      every multi-parish race: ID, SpecificTitle, NumberToBeElected, Choice[{ ID,
//                                            Desc: "Julia Letlow (REP)" }].
//   {d}/Votes_Multiparish.htm                per race: PrecinctsReporting / PrecinctsExpected, VoterCountQualified /
//                                            VoterCountVoted, Choice[{ ID, VoteTotal }].
//   {d}/RacesCandidates/ByParish_{pp}.htm    the same metadata for one parish's ballot (its local races too).
//   {d}/VotesParish/Votes_{pp}.htm           every race on one parish's ballot, counted in that parish.
// Parish codes 01..64 are alphabetical, like the FIPS codes: FIPS = 22 + (2 × code − 1). Multi-parish races get parish
// units from the parish files; single-parish (local) races are stored from them too. VotesEarly (early votes) is not used.
// Requests: CurrentVersion every poll; on a new version the two Multiparish files, then the parish files, `sweepBatch`
// parishes per poll (a new sweep at most every `sweepSeconds`). Parish race metadata is cached for `metaSeconds`.
import { createHash } from 'node:crypto';
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, yesNoSide } from '../normalize.js';
import { countiesOf } from '../geo.js';

const state = new Map();

function targets() {
  const c = readConfig('sources/lasos.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `LA/${e.electionId}`,
      state: 'LA',
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date,
      folder: e.date.replace(/-/g, ''),
      electionId: String(e.electionId),
      data: c.data,
      url: e.url ?? 'https://voterportal.sos.la.gov/graphical',
      parishes: e.parishes ?? 64,
      knownParties: new Set((c.knownOtherParties ?? []).map((p) => p.toLowerCase())),
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      allContests: e.allContests ?? true,
      requestGapMs: e.requestGapMs ?? c.requestGapMs ?? 400,
      sweepBatch: e.sweepBatch ?? c.sweepBatch ?? 16,
      sweepSeconds: e.sweepSeconds ?? c.sweepSeconds ?? 300,
      metaSeconds: e.metaSeconds ?? c.metaSeconds ?? 1800,
      utcOffset: e.utcOffset ?? '-06:00',
    }));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms ?? 0));
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const pad2 = (n) => String(n).padStart(2, '0');
export const parishFips = (code) => `22${String(2 * Number(code) - 1).padStart(3, '0')}`;

async function fetchTarget(t, { http, log, unmatched }) {
  const s = state.get(t.key) ?? { ver: null, multiMeta: null, multiVotes: null, parishMeta: new Map(), parishVotes: new Map(), queue: [], sweepVer: null, sweepAt: 0, version: null };
  state.set(t.key, s);
  const now = Date.now();
  const blob = async (name) => {
    await pause(t.requestGapMs);
    const text = (await http.get(`${t.data}?blob=${encodeURIComponent(name).replace(/%2F/g, '/')}`, { accept: 'application/json' })).text;
    return JSON.parse(text);
  };

  const cur = await blob('CurrentVersion.htm');
  const ver = cur?.Current?.VersionDateTime ?? null;
  if (ver !== s.ver || !s.multiVotes) {
    const mode = await blob('ElectionMode.htm');
    if (String(mode?.ElectionMode?.PKElectionID) !== t.electionId) {
      log?.warn?.(`LA: the site is in election ${mode?.ElectionMode?.PKElectionID}, not ${t.electionId}; nothing stored`);
      return { changed: false, version: s.version };
    }
    if (!s.multiMeta || now - (s.multiMetaAt ?? 0) > t.metaSeconds * 1000) {
      s.multiMeta = await blob(`${t.folder}/RacesCandidates_Multiparish.htm`);
      s.multiMetaAt = now;
    }
    s.multiVotes = await blob(`${t.folder}/Votes_Multiparish.htm`);
    s.ver = ver;
  }
  const all = Array.from({ length: t.parishes }, (_, i) => pad2(i + 1));
  const due = s.sweepVer !== ver && now - s.sweepAt >= t.sweepSeconds * 1000;
  if (!s.queue.length && (due || all.some((p) => !s.parishVotes.has(p)))) {
    s.queue = all.filter((p) => due || !s.parishVotes.has(p));
    s.sweepVer = ver;
    s.sweepAt = now;
  }
  for (const p of s.queue.splice(0, t.sweepBatch)) {
    try {
      const m = s.parishMeta.get(p);
      if (!m || now - m.at > t.metaSeconds * 1000) s.parishMeta.set(p, { at: now, json: await blob(`${t.folder}/RacesCandidates/ByParish_${p}.htm`) });
      s.parishVotes.set(p, await blob(`${t.folder}/VotesParish/Votes_${p}.htm`));
    } catch (err) {
      s.queue.unshift(p);
      throw err;
    }
  }

  const result = parseLa({
    multiMeta: s.multiMeta, multiVotes: s.multiVotes,
    parishes: [...s.parishVotes.entries()].map(([code, votes]) => ({ code, meta: s.parishMeta.get(code)?.json, votes })),
  }, t, unmatched);
  result.sourceUpdatedAt = parseLaTime(ver, t.utcOffset);
  const version = createHash('sha1').update(JSON.stringify(result)).digest('hex').slice(0, 16);
  if (version === s.version) return { changed: false, version };
  s.version = version;
  if (s.queue.length) log?.info?.(`LA: ${s.queue.length} parishes left in this sweep`);
  return { changed: true, version, result: { ...result, version } };
}

/** "2026-11-03T17:50:23.030" (Louisiana local time; the bundle's louisianaUtcOffset is -6 in November) → ISO. */
export function parseLaTime(s, offset = '-06:00') {
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return null;
  const d = new Date(`${s.slice(0, 19)}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round1 = (x) => Math.round(x * 10) / 10;

/** Pure parse into the adapter result (without `version` / `sourceUpdatedAt`). */
export function parseLa({ multiMeta, multiVotes, parishes = [] }, t, unmatched = () => {}) {
  const st = 'LA';
  const names = new Map(countiesOf(st).map((c) => [c.fips, c.name]));
  const meta = new Map(); // race ID → { race, multi }
  for (const r of arr(multiMeta?.Races?.Race)) meta.set(String(r.ID), { race: r, multi: true });
  for (const p of parishes) {
    for (const r of arr(p.meta?.Races?.Race)) if (!meta.has(String(r.ID))) meta.set(String(r.ID), { race: r, multi: false, parish: p.code });
  }
  const parishUnits = new Map(); // race ID → [{ fips, name, row }]
  for (const p of parishes) {
    const fips = parishFips(p.code);
    if (!names.has(fips)) {
      unmatched('county', p.code, 'LA parish code');
      continue;
    }
    for (const row of arr(p.votes?.Races?.Race)) {
      const k = String(row.ID);
      if (!parishUnits.has(k)) parishUnits.set(k, []);
      parishUnits.get(k).push({ fips, name: names.get(fips), row });
    }
  }
  const multiRows = new Map(arr(multiVotes?.Races?.Race).map((r) => [String(r.ID), r]));
  const statePrecincts = [...multiRows.values()].reduce((m, r) => Math.max(m, num(r.PrecinctsExpected) ?? 0), 0) || null;

  const unitOf = (row, choiceIds, base) => {
    const by = new Map(arr(row?.Choice).map((c) => [String(c.ID), num(c.VoteTotal) ?? 0]));
    const pr = num(row?.PrecinctsReporting);
    const pt = num(row?.PrecinctsExpected);
    return { ...base, votes: choiceIds.map((id) => by.get(id) ?? 0), precinctsReporting: pr, precinctsTotal: pt, pctReporting: pt ? round1((100 * (pr ?? 0)) / pt) : null };
  };

  const races = [];
  let senateRow = null;
  for (const [id, { race, multi }] of meta) {
    const name = String(race.SpecificTitle ?? race.GeneralTitle ?? '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const ch = arr(race.Choice);
    const choiceIds = ch.map((c) => String(c.ID));
    // "Julia Letlow (REP)", "E. \"Liddy\" Glass (NOPTY)": the party code is the trailing parenthesis.
    const split = ch.map((c) => {
      const d = String(c.Desc ?? '').trim();
      const m = d.match(/^(.*\S)\s+\(([A-Z]{2,6})\)$/);
      return m ? { name: m[1], partyRaw: m[2] } : splitPartyPrefix(d);
    });
    const labels = split.map((x) => x.name);
    const cls = classifyContest(name, labels);
    const isMeasure = cls?.office === 'measure';
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;
    const choices = split.map((x) => {
      const raw = x.partyRaw ?? '';
      if (isMeasure) return { name: x.name, party: 'OTHER', partyRaw: raw };
      const { party, known } = normalizeParty(raw);
      if (!known && !t.knownParties?.has(raw.toLowerCase())) unmatched('party', raw, `LA ${name} / ${x.name}`);
      return { name: x.name, party, partyRaw: raw };
    });
    const pUnits = parishUnits.get(id) ?? [];
    // Multi-parish races: totals from Votes_Multiparish. A local race appears in one parish's file only.
    const topRow = multi ? multiRows.get(id) : pUnits[0]?.row;
    if (!topRow) continue; // listed but no votes file yet
    // Statewide = expects every precinct in the state (known from the first poll, before the parish files arrive).
    const statewide = multi && statePrecincts != null && num(topRow.PrecinctsExpected) === statePrecincts;
    if (cls?.office === 'senate' && !senateRow) senateRow = topRow;
    const yn = (u) => {
      if (isMeasure) {
        u.yes = u.votes[yesIdx] ?? 0;
        u.no = u.votes[noIdx] ?? 0;
      }
      return u;
    };
    const units = [yn(unitOf(topRow, choiceIds, { level: 'state', name: statewide ? st : name }))];
    for (const u of pUnits) units.push(yn(unitOf(u.row, choiceIds, { level: 'county', countyFips: u.fips, name: u.name })));
    races.push({
      office: cls?.office ?? null,
      district: cls ? cls.district ?? (cls.office === 'house' ? 'AL' : null) : null,
      name,
      key: id,
      voteFor: num(race.NumberToBeElected),
      statewide,
      title: isMeasure ? [name, race.SummaryText].filter(Boolean).join(' — ') : null,
      choices,
      units,
    });
  }

  // Election-wide turnout: the U.S. Senate race is on every ballot statewide (qualified voters / voters who voted).
  const turnout = [];
  if (senateRow) {
    const registered = num(senateRow.VoterCountQualified) || null;
    const voted = num(senateRow.VoterCountVoted);
    turnout.push({
      level: 'state', name: st, registered, ballotsCast: voted,
      turnoutPct: registered && voted != null ? round1((100 * voted) / registered) : null,
      precinctsReporting: num(senateRow.PrecinctsReporting), precinctsTotal: num(senateRow.PrecinctsExpected),
    });
  }

  return {
    election: { sourceKey: t.key, state: st, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: null,
    turnout,
    races,
  };
}

export default {
  id: 'lasos',
  name: 'Louisiana Secretary of State',
  homepage: 'https://voterportal.sos.la.gov/graphical',
  targets,
  fetch: fetchTarget,
};
