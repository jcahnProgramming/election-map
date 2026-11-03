# Data contract (v0.2)

The shared shape between adapters → DB → API → UI. Agreed before the v0.2 work started so the UI, the data
layer and the adapters could be built in parallel. **`null` always means "this source doesn't publish it"**:
never write or show `0` for data we don't have.

## 1. Adapter result (what `fetch()` returns as `result`)

Everything marked *optional* may be omitted or `null`.

```js
{
  election: {
    sourceKey, state, scope: 'state'|'county', countyFips?, name, date?, url,
    electionKey?,          // optional; defaults to config/elections.json `current` (e.g. "2026-general")
  },
  version,                 // string; the source's own version id, or a content hash when it has none
  sourceUpdatedAt?,        // ISO 8601 string: the source's own "last updated" stamp, or null
  turnout?: [              // election-wide (not per race) per reporting unit
    { level: 'state'|'county', countyFips?, name,
      registered?, ballotsCast?, turnoutPct?,          // turnoutPct 0–100 as the source states it
      ballotsOutstanding?,                              // only when the source publishes remaining/outstanding ballots
      precinctsReporting?, precinctsTotal? }
  ],
  races: [{
    office: 'senate'|'governor'|'house'|'measure', district?, name, key, voteFor?, statewide?,
    title?,                // measures: the source's full title / short description ("Amendment 81: ..."), else null
    choices: [{ name, party: 'DEM'|'REP'|'OTHER', partyRaw }],   // name is CLEAN (no "REP " prefix); partyRaw keeps the label
    units: [{
      level: 'state'|'county', countyFips?, name,
      votes: [n per choice],              // candidates
      yes?, no?,                          // measures
      precinctsReporting?, precinctsTotal?, pctReporting?,
      methods?: [                         // per vote type, when the source splits it
        { label,                          // the source's label, verbatim ("Absentee by Mail", "Election Day", ...)
          bucket,                         // methodBucket(label): 'mail_early'|'election_day'|'provisional'|'other'
          votes: [n per choice] }         // measures: votes = [yes, no]
      ],
    }],
  }],
}
```

Helpers in `server/src/normalize.js`: `normalizeParty(raw)`, `splitPartyPrefix(label)` (→ `{ name, partyRaw }`
for "REP Darline Graham"), `methodBucket(label)`, `classifyContest(name, choices)`, `yesNoSide(choice)`.
`server/src/geo.js`: `matchCounty(state, name)` → `{ fips, name }` or null (log null via `ctx.unmatched('county', …)`).
`server/src/http.js` (via `ctx.http`): `get`, `getJson`, `getBuffer` (binary), `post`. Polite UA is built in.

Sources that report by **town** (CT, VT, RI, …): emit county units only if the source itself says which county each
town is in (sum towns within the same race); otherwise statewide only, and say so in the adapter's notes.

## 2. Storage (append-only, `server/src/db.js`)

New since 0.1: `elections.election_key`, `snapshots.source_updated_at`, `races.title`,
`unit_turnout` (per snapshot × unit), `method_counts` (per snapshot × race × unit × candidate × method).
Migrations are additive (`ALTER TABLE … ADD COLUMN` when missing); existing rows are never rewritten.

## 3. API

Every endpoint takes `?election=<key>` (default: `current` from `config/elections.json`; unknown key → 404).

- `GET /api/elections` → `{ current, elections: [{ key, name, date }] }`
- `GET /api/changelog` → contents of `CHANGELOG.json` plus `{ currentVersion }`
- `GET /api/national?race=&election=` → `{ election, race, generatedAt, states: [entry] }` where entry =
  ```js
  { state, fips, name,
    status: 'reporting'|'awaiting'|'no-source'|'no-race',
    hasCountyData, contests, candidates, parties: {DEM,REP,OTHER}, totalVotes, leader, tied, marginPts, pctReporting,
    otherContests?,                 // a 2nd contest for the same office, never summed into the headline
    precinctsReporting, precinctsTotal,          // null when unknown
    ballotsCast,                                 // election-wide, null when unknown
    source, sourceName, sourceUrl, sourceUpdatedAt, fetchedAt, checkedAt }
  ```
- `GET /api/state/:abbr?race=&election=` →
  ```js
  { election, state, fips, name, race, status, countyData: 'available'|'partial'|'unavailable'|'no-source',
    countyNote,
    statewide: entry & {
      turnout: { registered, ballotsCast, turnoutPct, ballotsOutstanding, precinctsReporting, precinctsTotal } | null,
      methods: [{ label, bucket, total, parties: {DEM,REP,OTHER} }] | null   // the headline contest (House: all districts)
    },
    counties: [{ fips, name, ...summary, precinctsReporting, precinctsTotal, turnout | null, methods | null }] }
  ```
- `GET /api/measures?state=&election=` → `{ election, measures: [{ id, state, name, title, yes, no, pctYes,
  pctReporting, source, sourceName, sourceUrl, sourceUpdatedAt, fetchedAt }] }`
- `GET /api/coverage?election=`, `GET /api/health` (unchanged shape; health is `no-cache`).

Socket.io events unchanged: `results:update` `{ sourceId, election, states, fetchedAt }`, `source:checked`.

## 4. Display rules the UI enforces
- Toss-up = |margin| < `TOSSUP_MARGIN` (one constant in `client/src/shading.js`, default 2).
- Measures status: `TOO EARLY` when pctReporting is null or < `MEASURE_TOO_EARLY_PCT` (config constant), else
  `YES LEADS` / `NO LEADS`. Never "passed" / "failed".
- Est. reporting (header) = Σ(pctReporting × totalVotes) / Σ(totalVotes) over states with pctReporting != null.
