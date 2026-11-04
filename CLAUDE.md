# election-map — project constitution

A **public**, no-login, live election-night results map for the 2026 US midterms, served at
https://election.jamiecahn.com through a Cloudflare tunnel to <HOST> (<HOST_OS>). Nothing in it is
confidential and nothing in it ever needs a secret.

## What the app is
- A US map, state by state. Default view **Top race** (no params in the URL): each state colored by its highest-office
  contest (Senate, else Governor, else the House statewide popular vote; a special Senate race never outranks the
  regular one), with its other major races listed beside it, never added to it. Or one office at a time, picked with a
  **Federal / State** toggle: Federal =
  U.S. Senate / U.S. House (House = the statewide popular vote across a state's districts); State = Governor plus
  every statewide office the feeds carry (Attorney General, Secretary of State, …; built from `/api/offices`, never
  hardcoded). Hover → votes counted per party; click → the state with counties shaded, where the source has counties.
- State view tabs: **Overview** (the selected office) and **All races** (every contest in the state's feeds,
  grouped Federal / Statewide / State legislature / County / Local / Judicial / Ballot measures, searchable).
  House (Federal > House, and the Top race House fallback): the statewide popular vote by party, plus one row per
  district (leading candidate and margin, Toss-up or No votes yet); an at-large state is its one contest, by candidate.
- **Congress** view (`?view=congress`, Map | Congress switch in the header): balance of power per chamber = seats not
  up this election (`config/elections/<key>/chambers.json`, from the official Senate roster / House Clerk data, each
  sourced; independents counted with their caucus and labelled) + seats each party currently leads, from the stored
  contests (toss-up = the map's `TOSSUP_MARGIN`; no contest or no votes = "no votes / no live data"). Top-two same-party
  contests count for that party. Never "won" / "called". The seat math lives in `client/src/calc.js` (`seatStatus`,
  `chamberTotals`, `hemicycle`). Specials (e.g. OH, FL in 2026) are seats up, never holdovers.
- Multi-seat contests (vote for 2+) are never shaded or summarized as a two-way margin: top-N candidates instead.
- Every state links to its official results page (`config/official-results.json`); every number names its source
  and that source's last update.
- Shading: leader's colour (DEM blue / REP red / OTHER green), lighter for narrower margins; margin under
  2 points → purple. No race for the office → neutral grey. A race we have no source for → hatched grey
  ("No live results here"), with reason-based copy from `config/coverage-status.json` (live / planned / blocked /
  no_feed; source of truth `docs/source-roadmap.md`) next to the official results link. Never imply the state is at fault.
  The shading rule lives in `client/src/shading.js` (pure function; the design must reuse it, not fork it).
- A right-hand sidebar of statewide ballot measures (yes / no / % yes / % reporting), with official measure
  information from static per-election files (`config/elections/<key>/measures/<ST>.json`, `docs/measures-data.md`).
- Candidate avatars: initials on a party tint by default. Photos only from `config/elections/<key>/candidates/<ST>.json`
  (allowed sources only, `reviewed: true`, fetched once and served from our own domain; `docs/photos-data.md`), and in
  a contest only when every major candidate has one (fairness rule in `server/src/photos.js`). Review checklist:
  `docs/photos-review.md` (regenerate with `node scripts/photos-review.js`). Never commit image files.
- Always visible: "Unofficial results — counts change as ballots are reported".

## Rules (non-negotiable)
1. **We never call races.** "Leading" = most votes counted right now. Never show or store "winner",
   "projected", "called". Clarity's own winner flags (`W`) are deliberately ignored.
2. **Never sum party totals across different races.** Two Senate contests in one state (regular + special)
   are listed separately. The only cross-contest sum is House districts → statewide House popular vote.
3. **Honest empty states.** Every state says which of these is true: reporting / no votes counted yet /
   no live results here (and why: coverageStatus) / no race for this office. When a source has no counties, say so in words (`countyNote`);
   never draw a blank map. County-run sites in a state without a statewide feed are `countyData: "partial"`
   and never become a statewide number.
4. **Adapter registry, no hardcoded source lists.** Each source is one file in `server/src/adapters/`
   that declares itself (id, name, `targets()`, `fetch()`); the registry loads every file there. Which elections
   / states an adapter polls comes from `config/sources/<id>.json`, not code. Adding a state = one adapter
   file, or one config entry for a platform we already speak — **and, in the same change, set that state to
   `"live"` in `config/coverage-status.json`** (`server/test/coverage-status.test.js` fails otherwise; parking a target
   with `enabled:false` means setting it back to `"planned"`).
5. **Free official sources only.** No paid APIs, no API keys. Polite User-Agent naming the project
   (never an email). Never spoof a browser User-Agent or work around bot protection: a source that blocks us
   goes on the roadmap (`docs/source-roadmap.md`) instead.
6. **Append-only results.** Every new source version is a new `snapshots` row with its own vote rows;
   `latest_snapshot` points at what the API serves. Never UPDATE or DELETE result rows.
7. Unmatched county names / unknown party labels / unclassified contests are logged and recorded in the
   `unmatched` table, never silently dropped. Adapters store every contest their feed publishes.
8. **Measure information is official or absent.** Titles, summaries and ballot text are verbatim from official
   sources, each with its source URL; never write or AI-generate a summary. Campaign websites and party positions are
   served only once a human sets `reviewed: true` (`docs/measures-review.md`, regenerate with
   `node scripts/measures-review.js`). Both sides of a measure get the same treatment; party positions use neutral
   position colours, never party colours.

## Stack
- Node 22 (Node 20 is EOL since April 2026) + Express, SQLite via better-sqlite3, Socket.io.
- React + Vite frontend (`client/`), d3-geo + `us-atlas` (states/counties-albers-10m, pre-projected, FIPS ids).
  No Leaflet.
- Separate `server/` and `client/` packages (each with its own lockfile), not npm workspaces.
- One Docker image (multi-stage), docker compose on <HOST>.

## Layout
- `server/src/index.js` Express + Socket.io + poller wiring. `results.js` builds API responses from the latest
  snapshots. `db.js` schema + snapshot writer. `poller.js` per-target loops with backoff. `http.js` shared
  client (UA, timeouts, ETag/Last-Modified; get/getJson/getBuffer/post). `normalize.js` party + contest
  classification, `splitPartyPrefix`, `methodBucket`. `contests.js` classifies every contest (level / office key /
  kind) from `config/contest-rules.json` + per-adapter `contestRules`. `measureinfo.js` loads the static measure files
  and enforces the review gate. `geo.js` FIPS. `elections.js` election keys (current from
  `config/elections.json`). `apicache.js` / `ratelimit.js` public-traffic hardening. `photos.js` candidate photos
  (review gate, fairness rule, disk cache under `DATA_DIR/photos`, served at `GET /photos/:id.jpg`).
- `server/src/adapters/*.js` one file per source: clarity (CO/IA/SC + county sites), enhancedvoting (GA/VA/UT/WA/RI/ID),
  txivis, casos, vtsos, ncsbe, tallyenr (AR), deenr, nistcdf (OH; generic parser in `_nist-cdf.js`), pccct, fldos.
  Files starting with `_` are helpers the registry skips. An adapter's `sourceKey` must be unique per election.
- `config/sources/<id>.json` what each adapter polls (`enabled:false` parks a target). `config/races-2026.json` which states hold which
  races (only used for states with no source). `config/clarity-county-candidates.json` research output.
  `config/official-results.json` every state's official results page. `config/elections/<key>/measures/<ST>.json`
  researched measure information (not under `data/`: that's the SQLite bind mount). `config/elections/<key>/chambers.json`
  seats not up / up this election and House districts per state (Congress view).
- `design/election-map-design-v3-map.dc.html` + `design/election-map-design-v3-congress.dc.html` the current Claude Design
  exports: the spec (v1, v2 kept for history). `client/` is its React port
  (tokens in `client/src/tokens.css`, pure calculations in `client/src/calc.js`, shading in `shading.js`).
- `docs/data-contract.md` adapter result → DB → API shape. `null` = not published; never show 0 for missing data.
- `docs/source-roadmap.md` what every uncovered state publishes: the to-do list for new adapters.

## API
`GET /api/health`, `/api/offices`, `/api/national?office=&level=` (`race=` still accepted), `/api/state/:abbr?office=`,
`/api/state/:abbr/contests?q=`, `/api/congress`, `/api/measures[?state=]`, `/api/coverage` (incl. each state's `coverageStatus`), `/api/elections`,
`/api/changelog`; `GET /photos/:id.jpg` reviewed candidate photos (not under /api, rate-limited).
Client routes are query strings: `?level=state&office=ag&state=CO&tab=all[&q=…]`, `?view=congress` (0.2 `#/CO/senate` links are rewritten). Every read takes `?election=` (default: current); nothing may assume one election.
Reads are cached in memory between polls and sent with `Cache-Control: public, max-age=15`; health is no-store;
/api/* is rate-limited per IP. Socket.io: `results:update` {sourceId, election, states, fetchedAt} when new numbers land (clients refetch);
`source:checked` after every successful poll (heartbeat).

## Versioning
`CHANGELOG.json` is the single source of the version (newest release = app version; `/api/health` reads it).
`npm run build` runs `scripts/check-changelog.js` first, so a bad entry fails the build and the deploy.
Versions go upward from 0.1.0; **1.0.0 is reserved for an agreed 1.0**.

## Deployment (<HOST>, via Gitea Actions)
- Every push to `main` runs `.gitea/workflows/deploy.yml` (label `ubuntu-latest`, served by the `<RUNNER>`
  act_runner, same as Overwatch). It fast-forwards the host clone at `<DEPLOY_DIR>` from
  Gitea's internal address `<GITEA_INTERNAL_URL>` (tailnet MagicDNS names don't resolve from <HOST>/containers),
  runs `docker compose up -d --build`, then fails the run unless `/api/health` answers 200 with `"ok": true`.
- The port is published on **<LAN_IP> only** (`ELECTION_MAP_BIND_IP`), never 0.0.0.0; host port
  `ELECTION_MAP_PORT` (default 3710). The Cloudflare tunnel points at `http://<LAN_IP>:<port>`.
- SQLite lives in `./data` under the deploy dir (bind mount). Never delete, reset or chown it. The workflow
  never creates or edits the host `.env`, and checks that it didn't.
- Commit/push: the owner pushes. Don't push.
