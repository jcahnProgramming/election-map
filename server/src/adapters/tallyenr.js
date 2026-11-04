// Tally ENR / TotalResults (https://{cid}.tally-enr.com, API at enr-results-api.totalresults.com). Arkansas so far.
//
// API (verified live on 2026-11-03 against arkansas / 11b07106-031e-4d7c-911a-d01fb473d6dd; endpoint names from
// the public site's own bundle). Every response is wrapped as
//   { versionID:"v97", lastUpdated:"2026-11-02T22:43:53.97Z", isOfficial, turnout:{...}, response:{...} }
// and versionID moves with every results upload (the May primary ended at v3318).
//   Turnout/GetTurnout?cId=&electionID=            2.8 KB. registeredVoters, totalBallotsCast, votePercent (= turnout %,
//                                                  0-100), precinctsReporting/totalPrecincts, and the same per county
//                                                  under locations{ "05001": ... } (keys are county FIPS).  ← change check
//   Election/GetElectionInfo?cId=&electionID=      parties{id:{partyName}}, voteTypes{id:{description}}, locations
//                                                  {fips:{locationName, locations:{precincts}}}
//   Contest/GetContestSearchList?cid=&electionID=  contests{id:{contestName, contestTypeCode, voteFor,
//                                                  choices{id:{name:"REP Tom Cotton", partyID, order, isWriteIn}}}}
//   Contest/GetSingleContestResults?cId=&electionID=&contestType=&contestID=
//                                                  one contest: choices[{choiceID, totalVotes, votes:[{voteTypeID, votes}]}],
//                                                  precinctsReporting/totalPrecincts, and locations{fips: same per county}
//                                                  (15 KB; this is the only call that carries vote-type splits)
// Contest/GetContestResults?cId=&electionID=&contestType=
//                                                  every contest of one type: contests{id: { contestID, choices[{choiceID,
//                                                  totalVotes}], precinctsReporting/totalPrecincts, locations{fips: same}}}
//                                                  - totals and counties, but NO vote-type split. AR 2026: 11 types,
//                                                  1,315 contests, ~330 KB compressed for all 11 together.
// FullDataFile.json (50 MB, precinct level) is deliberately never used. isWinner flags are ignored: we never call races.
//
// Requests (v0.3 "every contest"):
//   - every poll: GetTurnout (the change check).
//   - on a change: one GetSingleContestResults per headline contest (U.S. Senate / House / Governor / yes-no measure of
//     the `detailTypes`, AR: 10), because only that call has the Absentee / Early / Election Day split.
//   - the "sweep": one GetContestResults per contest type (AR: 11 requests, sequential) for everything else, at most
//     once every `sweepSeconds` (default 300) and only when the turnout version moved since the last sweep. Between
//     sweeps the other contests are re-emitted from the last sweep; a feed that goes quiet still gets one final sweep
//     on the first poll after the cooldown. Never one request per contest for the ~1,300 others.
//   - metadata (GetElectionInfo + GetContestSearchList, ~2 MB) cached; re-read when a result names a contest / choice /
//     party / vote type we haven't seen, at most once per sweep cooldown.
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → version
const metaCache = new Map(); // target key → { info, contestList, at }
const sweepCache = new Map(); // target key → { at, turnoutVersion, byType: Map(type → envelope) }
const detailCache = new Map(); // target key → { turnoutVersion, contestResults }

function targets() {
  const c = readConfig('sources/tallyenr.json', { elections: [] });
  return c.elections
    .filter((e) => e.enabled !== false)
    .map((e) => ({
      key: `${e.cid}/${e.electionId}`,
      cid: e.cid,
      electionId: e.electionId,
      base: e.base ?? c.base,
      state: e.state,
      scope: 'state',
      countyFips: null,
      label: e.name,
      date: e.date ?? null,
      levels: ['state', 'county'],
      races: e.races ?? ['senate', 'governor', 'house'],
      measures: true,
      // Every contest type the election lists is swept, so the whole ballot is here unless contestTypes narrows it.
      allContests: e.allContests ?? !e.contestTypes,
      contestTypes: e.contestTypes ?? null,
      detailTypes: e.detailTypes ?? ['Federal', 'Statewide'],
      statewideTypes: e.statewideTypes ?? ['Federal', 'Statewide'],
      typeHints: e.typeHints ?? c.typeHints ?? {},
      sweepSeconds: e.sweepSeconds ?? c.sweepSeconds ?? 300,
      url: e.url ?? `https://${e.cid}.tally-enr.com/`,
    }));
}

const q = (t) => `cId=${encodeURIComponent(t.cid)}&electionID=${encodeURIComponent(t.electionId)}`;

async function fetchTarget(t, { http, log, unmatched, now = Date.now() }) {
  const turnout = (await http.getJson(`${t.base}/Turnout/GetTurnout?${q(t)}`)).json;
  if (!turnout?.versionID) throw new Error(`Tally GetTurnout: no versionID (${JSON.stringify(turnout).slice(0, 80)})`);
  const tv = `${turnout.versionID}@${turnout.lastUpdated ?? ''}`;
  const cooldown = (t.sweepSeconds ?? 300) * 1000;
  const prevSweep = sweepCache.get(t.key);
  const sweepDue = !prevSweep || (prevSweep.turnoutVersion !== tv && now - prevSweep.at >= cooldown);
  const prev = lastVersion.get(t.key);
  if (prev && prev.startsWith(`${tv}|`) && !sweepDue) return { changed: false, version: prev };

  let meta = metaCache.get(t.key) ?? (await loadMeta(t, http, now));

  // Headline contests, with vote-type splits: re-read only when the turnout version moved.
  let detail = detailCache.get(t.key);
  if (!detail || detail.turnoutVersion !== tv) {
    const contestResults = [];
    for (const c of trackedContests(meta.contestList, t)) {
      const url = `${t.base}/Contest/GetSingleContestResults?${q(t)}&contestType=${encodeURIComponent(c.contestTypeCode)}&contestID=${encodeURIComponent(c.contestId)}`;
      contestResults.push((await http.getJson(url)).json);
    }
    detail = { turnoutVersion: tv, contestResults };
    detailCache.set(t.key, detail);
  }

  // Everything else: one request per contest type, sequential, at most once per cooldown.
  let sweep = prevSweep;
  if (sweepDue) {
    const byType = new Map(prevSweep?.byType ?? []);
    for (const type of sweepTypes(meta, t)) {
      try {
        const url = `${t.base}/Contest/GetContestResults?${q(t)}&contestType=${encodeURIComponent(type)}`;
        byType.set(type, (await http.getJson(url, { timeoutMs: 60000 })).json);
      } catch (err) {
        log?.warn?.(`Tally ${t.key} contest type ${type} failed, keeping its previous sweep: ${err.message}`);
      }
    }
    sweep = { at: now, turnoutVersion: tv, byType };
    sweepCache.set(t.key, sweep);
  }
  const typeResults = [...sweep.byType.values()];

  // A new party / choice / vote type / contest we don't know: the metadata moved, re-read it (rate-limited).
  if (!metaCovers(meta, detail.contestResults, typeResults) && now - (meta.at ?? 0) >= cooldown) meta = await loadMeta(t, http, now);

  const version = `${tv}|${sweep.turnoutVersion}`;
  const result = parseTally({ turnout, info: meta.info, contestList: meta.contestList, contestResults: detail.contestResults, typeResults }, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

/** Contest types to sweep: the config's list, else every type the election lists or its contests use. */
export function sweepTypes(meta, t) {
  if (Array.isArray(t.contestTypes) && t.contestTypes.length) return t.contestTypes;
  const listed = Object.keys(meta.info?.response?.contestTypes ?? {});
  const used = Object.values(meta.contestList?.response?.contests ?? {}).map((c) => c.contestTypeCode).filter(Boolean);
  return [...new Set([...listed, ...used])];
}

async function loadMeta(t, http, now = Date.now()) {
  const [info, contestList] = await Promise.all([
    http.getJson(`${t.base}/Election/GetElectionInfo?${q(t)}`).then((r) => r.json),
    http.getJson(`${t.base}/Contest/GetContestSearchList?cid=${encodeURIComponent(t.cid)}&electionID=${encodeURIComponent(t.electionId)}`).then((r) => r.json),
  ]);
  const meta = { info, contestList, at: now };
  metaCache.set(t.key, meta);
  return meta;
}

function metaCovers(meta, contestResults, typeResults = []) {
  const contests = meta.contestList?.response?.contests ?? {};
  const parties = meta.info?.response?.parties ?? {};
  const voteTypes = meta.info?.response?.voteTypes ?? {};
  const all = [...contestResults.map((r) => r?.response), ...typeResults.flatMap((e) => Object.values(e?.response?.contests ?? {}))];
  for (const r of all) {
    if (!r) continue;
    const c = contests[r.contestID];
    if (!c) return false;
    for (const ch of r.choices ?? []) {
      if (!c.choices?.[ch.choiceID]) return false;
      if (ch.partyID && !parties[ch.partyID]) return false;
      for (const v of ch.votes ?? []) if (!voteTypes[v.voteTypeID]) return false;
    }
  }
  return true;
}

/** Headline contests read one by one for their vote-type split: Senate / House / Governor / measures of detailTypes. */
export function trackedContests(contestList, t) {
  const out = [];
  for (const c of Object.values(contestList?.response?.contests ?? {})) {
    if (!(t.detailTypes ?? ['Federal', 'Statewide']).includes(c.contestTypeCode)) continue;
    const names = Object.values(c.choices ?? {}).map((ch) => ch.name);
    const cls = classifyContest(c.contestName, names);
    if (!cls) continue;
    out.push({ ...c, cls });
  }
  return out.sort((a, b) => (a.contestOrder ?? 0) - (b.contestOrder ?? 0));
}

/**
 * Pure parse of Tally responses into the adapter result (without `version`).
 * @param {{ turnout:object, info:object, contestList:object, contestResults:object[], typeResults?:object[] }} data
 *   raw API envelopes: contestResults = GetSingleContestResults (headline contests, with vote types), typeResults =
 *   GetContestResults per contest type (every contest, totals only). A contest in both is taken from contestResults.
 */
export function parseTally({ turnout, info, contestList, contestResults = [], typeResults = [] }, t, unmatched = () => {}) {
  const state = t.state;
  const parties = info?.response?.parties ?? {};
  const voteTypes = info?.response?.voteTypes ?? {};
  const locations = info?.response?.locations ?? {};
  const contests = contestList?.response?.contests ?? {};

  // County FIPS (Tally's location keys) → atlas county, checked by name so a mismatch is logged, not guessed.
  const countyCache = new Map();
  const county = (fips) => {
    if (countyCache.has(fips)) return countyCache.get(fips);
    const name = locations[fips]?.locationName ?? fips;
    const m = matchCounty(state, name);
    const ok = m && m.fips === fips ? m : null;
    if (!ok) unmatched('county', name, `${state} Tally location ${fips}`);
    countyCache.set(fips, ok);
    return ok;
  };

  let updated = null;
  const stamp = (env) => {
    const d = env?.lastUpdated ? new Date(env.lastUpdated) : null;
    if (d && !Number.isNaN(d.getTime()) && (!updated || d.toISOString() > updated)) updated = d.toISOString();
  };
  stamp(turnout);

  const turnoutUnits = [];
  const to = turnout?.response ?? turnout?.turnout;
  if (to) {
    turnoutUnits.push({ level: 'state', name: state, ...turnoutOf(to) });
    for (const [fips, l] of Object.entries(to.locations ?? {})) {
      const m = county(fips);
      if (m) turnoutUnits.push({ level: 'county', countyFips: m.fips, name: m.name, ...turnoutOf(l) });
    }
  }

  const statePrecincts = num(to?.totalPrecincts);

  // Headline contests first (they carry vote types), then every other contest from the per-type sweep.
  const items = [];
  const seen = new Set();
  for (const env of contestResults) {
    stamp(env);
    const res = env?.response;
    if (res?.contestID && contests[res.contestID] && !seen.has(res.contestID)) {
      seen.add(res.contestID);
      items.push(res);
    }
  }
  const swept = [];
  for (const env of typeResults) {
    stamp(env);
    for (const res of Object.values(env?.response?.contests ?? {})) {
      if (!res?.contestID || seen.has(res.contestID)) continue;
      if (!contests[res.contestID]) continue; // not in the contest list yet: the metadata is re-read, then it shows up
      seen.add(res.contestID);
      swept.push(res);
    }
  }
  const order = (r) => contests[r.contestID]?.contestOrder ?? 0;
  items.push(...swept.sort((a, b) => order(a) - order(b)));

  const races = [];
  for (const res of items) {
    const c = contests[res.contestID];
    const metaChoices = Object.values(c.choices ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const labels = metaChoices.map((ch) => ch.name);
    const cls = classifyContest(c.contestName, labels);
    const isMeasure = cls?.office === 'measure';

    const choices = metaChoices.map((ch) => {
      const split = splitPartyPrefix(ch.name);
      const partyName = parties[ch.partyID]?.partyName ?? null;
      if (isMeasure) return { name: split.name, party: 'OTHER', partyRaw: split.partyRaw ?? '' };
      // The prefix ("REP") is what the voter sees; the party table ("Republican") is the fallback.
      let raw = split.partyRaw ?? partyName ?? '';
      let { party, known } = normalizeParty(raw);
      if (!known && partyName && raw !== partyName) ({ party, known } = normalizeParty((raw = partyName)));
      // No label at all is "no party" (nonpartisan contests), not an unknown party.
      if (!known && raw) unmatched('party', raw, `${state} ${c.contestName} / ${ch.name}`);
      return { name: split.name, party, partyRaw: raw };
    });
    const yesIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'yes') : -1;
    const noIdx = isMeasure ? labels.findIndex((l) => yesNoSide(l) === 'no') : -1;

    const makeUnit = (base, r) => {
      const byId = new Map((r.choices ?? []).map((ch) => [ch.choiceID, ch]));
      const ordered = metaChoices.map((m) => byId.get(m.id) ?? null);
      const votes = ordered.map((ch) => num(ch?.totalVotes) ?? 0);
      // Vote types in the order they first appear; "TV - Total Votes" is a total, not a method.
      const typeIds = [];
      for (const ch of ordered) for (const v of ch?.votes ?? []) if (!typeIds.includes(v.voteTypeID)) typeIds.push(v.voteTypeID);
      const methods = typeIds
        .map((id) => ({ id, label: voteTypes[id]?.description ?? null }))
        .filter((m) => m.label && !/^TV\b|total votes/i.test(m.label))
        .map(({ id, label }) => {
          const v = ordered.map((ch) => num(ch?.votes?.find((x) => x.voteTypeID === id)?.votes) ?? 0);
          return { label, bucket: methodBucket(label), votes: isMeasure ? [v[yesIdx] ?? 0, v[noIdx] ?? 0] : v };
        });
      const pr = num(r.precinctsReporting);
      const pt = num(r.totalPrecincts);
      const u = { ...base, votes, precinctsReporting: pr, precinctsTotal: pt, pctReporting: pt ? round1((100 * (pr ?? 0)) / pt) : null };
      if (methods.length) u.methods = methods;
      if (isMeasure) {
        u.yes = votes[yesIdx] ?? 0;
        u.no = votes[noIdx] ?? 0;
      }
      return u;
    };

    const units = [makeUnit({ level: 'state', name: state }, res)];
    for (const [fips, l] of Object.entries(res.locations ?? {})) {
      const m = county(fips);
      if (m) units.push(makeUnit({ level: 'county', countyFips: m.fips, name: m.name }, l));
    }

    // Headline races keep their meaning; measures are statewide by contest type (as before); any other contest is
    // statewide when it covers every precinct in the state (Lt. Governor yes, a circuit judge or a city no).
    const statewideTypes = t.statewideTypes ?? ['Federal', 'Statewide'];
    const statewide = isMeasure
      ? statewideTypes.includes(c.contestTypeCode)
      : !!cls || (statePrecincts != null && num(res.totalPrecincts) != null
        ? num(res.totalPrecincts) === statePrecincts
        : statewideTypes.includes(c.contestTypeCode));
    const race = {
      office: cls?.office ?? null,
      district: cls?.district ?? null,
      name: c.contestName,
      key: c.contestId,
      voteFor: num(c.voteFor),
      statewide,
      title: isMeasure ? c.contestName : null,
      choices,
      units,
    };
    // Tally's own contest type, when config maps it to an office (State Senate → state_senate, ...).
    const hint = t.typeHints?.[c.contestTypeCode];
    if (!cls && hint?.level && hint?.office) Object.assign(race, { level: hint.level, office: hint.office });
    races.push(race);
  }

  return {
    election: { sourceKey: t.key, state, scope: 'state', name: t.label, date: t.date ?? null, url: t.url },
    sourceUpdatedAt: updated,
    turnout: turnoutUnits,
    races,
  };
}

function turnoutOf(x) {
  return {
    registered: num(x.registeredVoters),
    ballotsCast: num(x.totalBallotsCast),
    turnoutPct: num(x.votePercent),
    precinctsReporting: num(x.precinctsReporting),
    precinctsTotal: num(x.totalPrecincts),
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const round1 = (x) => Math.round(x * 10) / 10;

export default {
  id: 'tallyenr',
  name: 'Tally ENR / TotalResults',
  homepage: 'https://enr-results-api.totalresults.com',
  targets,
  fetch: fetchTarget,
};
