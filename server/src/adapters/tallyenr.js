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
// Contest/GetContestResults?contestType= has every contest of a type but no vote types; FullDataFile.json (50 MB,
// precinct level) is deliberately never used. isWinner flags are ignored: we never call races.
//
// Requests per change: GetTurnout, plus one GetSingleContestResults per tracked contest (AR: 10). The two metadata
// calls are cached and only re-read when a result names a contest/choice/party/vote type we haven't seen.
import { readConfig } from '../config.js';
import { classifyContest, normalizeParty, splitPartyPrefix, methodBucket, yesNoSide } from '../normalize.js';
import { matchCounty } from '../geo.js';

const lastVersion = new Map(); // target key → version
const metaCache = new Map(); // target key → { info, contestList }

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
      contestTypes: e.contestTypes ?? ['Federal', 'Statewide'],
      statewideTypes: e.statewideTypes ?? ['Federal', 'Statewide'],
      url: e.url ?? `https://${e.cid}.tally-enr.com/`,
    }));
}

const q = (t) => `cId=${encodeURIComponent(t.cid)}&electionID=${encodeURIComponent(t.electionId)}`;

async function fetchTarget(t, { http, unmatched }) {
  const turnout = (await http.getJson(`${t.base}/Turnout/GetTurnout?${q(t)}`)).json;
  if (!turnout?.versionID) throw new Error(`Tally GetTurnout: no versionID (${JSON.stringify(turnout).slice(0, 80)})`);
  const version = `${turnout.versionID}@${turnout.lastUpdated ?? ''}`;
  if (lastVersion.get(t.key) === version) return { changed: false, version };

  let meta = metaCache.get(t.key) ?? (await loadMeta(t, http));
  const tracked = trackedContests(meta.contestList, t);
  const contestResults = [];
  for (const c of tracked) {
    const url = `${t.base}/Contest/GetSingleContestResults?${q(t)}&contestType=${encodeURIComponent(c.contestTypeCode)}&contestID=${encodeURIComponent(c.contestId)}`;
    contestResults.push((await http.getJson(url)).json);
  }
  // A new party / choice / vote type we don't know: the metadata moved, re-read it once.
  if (!metaCovers(meta, contestResults)) meta = await loadMeta(t, http);

  const result = parseTally({ turnout, info: meta.info, contestList: meta.contestList, contestResults }, t, unmatched);
  lastVersion.set(t.key, version);
  return { changed: true, version, result: { ...result, version } };
}

async function loadMeta(t, http) {
  const [info, contestList] = await Promise.all([
    http.getJson(`${t.base}/Election/GetElectionInfo?${q(t)}`).then((r) => r.json),
    http.getJson(`${t.base}/Contest/GetContestSearchList?cid=${encodeURIComponent(t.cid)}&electionID=${encodeURIComponent(t.electionId)}`).then((r) => r.json),
  ]);
  const meta = { info, contestList };
  metaCache.set(t.key, meta);
  return meta;
}

function metaCovers(meta, contestResults) {
  const contests = meta.contestList?.response?.contests ?? {};
  const parties = meta.info?.response?.parties ?? {};
  const voteTypes = meta.info?.response?.voteTypes ?? {};
  for (const r of contestResults) {
    const c = contests[r?.response?.contestID];
    if (!c) return false;
    for (const ch of r.response.choices ?? []) {
      if (!c.choices?.[ch.choiceID]) return false;
      if (ch.partyID && !parties[ch.partyID]) return false;
      for (const v of ch.votes ?? []) if (!voteTypes[v.voteTypeID]) return false;
    }
  }
  return true;
}

/** Contests this target polls: of the configured types, and a race or measure we track. */
export function trackedContests(contestList, t) {
  const out = [];
  for (const c of Object.values(contestList?.response?.contests ?? {})) {
    if (!t.contestTypes.includes(c.contestTypeCode)) continue;
    const names = Object.values(c.choices ?? {}).map((ch) => ch.name);
    const cls = classifyContest(c.contestName, names);
    if (!cls) continue;
    if (cls.office === 'measure' ? !t.measures : !t.races.includes(cls.office)) continue;
    out.push({ ...c, cls });
  }
  return out.sort((a, b) => (a.contestOrder ?? 0) - (b.contestOrder ?? 0));
}

/**
 * Pure parse of Tally responses into the adapter result (without `version`).
 * @param {{ turnout:object, info:object, contestList:object, contestResults:object[] }} data  raw API envelopes
 */
export function parseTally({ turnout, info, contestList, contestResults }, t, unmatched = () => {}) {
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

  const races = [];
  for (const env of contestResults) {
    stamp(env);
    const res = env?.response;
    const c = res && contests[res.contestID];
    if (!c) continue;
    const metaChoices = Object.values(c.choices ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const labels = metaChoices.map((ch) => ch.name);
    const cls = classifyContest(c.contestName, labels);
    if (!cls) continue;
    const isMeasure = cls.office === 'measure';

    const choices = metaChoices.map((ch) => {
      const split = splitPartyPrefix(ch.name);
      const partyName = parties[ch.partyID]?.partyName ?? null;
      if (isMeasure) return { name: split.name, party: 'OTHER', partyRaw: split.partyRaw ?? '' };
      // The prefix ("REP") is what the voter sees; the party table ("Republican") is the fallback.
      let raw = split.partyRaw ?? partyName ?? '';
      let { party, known } = normalizeParty(raw);
      if (!known && partyName && raw !== partyName) ({ party, known } = normalizeParty((raw = partyName)));
      if (!known) unmatched('party', raw, `${state} ${c.contestName} / ${ch.name}`);
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

    races.push({
      office: cls.office,
      district: cls.district,
      name: c.contestName,
      key: c.contestId,
      voteFor: num(c.voteFor),
      statewide: !isMeasure || t.statewideTypes.includes(c.contestTypeCode),
      title: isMeasure ? c.contestName : null,
      choices,
      units,
    });
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
