# election-map — project constitution

A **public**, no-login, live election-night results map for the 2026 US midterms, served at
https://election.jamiecahn.com through a Cloudflare tunnel to <HOST> (<HOST_OS>). Nothing in it is
confidential and nothing in it ever needs a secret.

## What the app is
- A US map, state by state, for one race at a time: **U.S. Senate / Governor / U.S. House** (House = the
  statewide popular vote across a state's districts). Hover → votes counted per party; click → the state
  with counties shaded, where the source has counties.
- Shading: leader's colour (DEM blue / REP red / OTHER green), lighter for narrower margins; margin under
  2 points → purple. No race for the office → neutral grey. A race we have no source for → hatched grey.
  The shading rule lives in `client/src/shading.js` (pure function; the design must reuse it, not fork it).
- A right-hand sidebar of statewide ballot measures (yes / no / % yes / % reporting).
- Always visible: "Unofficial results — counts change as ballots are reported".

## Rules (non-negotiable)
1. **We never call races.** "Leading" = most votes counted right now. Never show or store "winner",
   "projected", "called". Clarity's own winner flags (`W`) are deliberately ignored.
2. **Never sum party totals across different races.** Two Senate contests in one state (regular + special)
   are listed separately. The only cross-contest sum is House districts → statewide House popular vote.
3. **Honest empty states.** Every state says which of these is true: reporting / no votes counted yet /
   no data source yet / no race for this office. When a source has no counties, say so in words (`countyNote`);
   never draw a blank map. County-run sites in a state without a statewide feed are `countyData: "partial"`
   and never become a statewide number.
4. **Adapter registry, no hardcoded source lists.** Each source is one file in `server/src/adapters/`
   that declares itself (id, name, `targets()`, `fetch()`); the registry loads every file there. Which elections
   / states an adapter polls comes from `config/sources/<id>.json`, not code. Adding a state = one adapter
   file, or one config entry for a platform we already speak.
5. **Free official sources only.** No paid APIs, no API keys. Polite User-Agent naming the project
   (never an email). Never spoof a browser User-Agent or work around bot protection: a source that blocks us
   goes on the roadmap (`docs/source-roadmap.md`) instead.
6. **Append-only results.** Every new source version is a new `snapshots` row with its own vote rows;
   `latest_snapshot` points at what the API serves. Never UPDATE or DELETE result rows.
7. Unmatched county names / unknown party labels are logged and recorded in the `unmatched` table, never
   silently dropped.

## Stack
- Node 22 (Node 20 is EOL since April 2026) + Express, SQLite via better-sqlite3, Socket.io.
- React + Vite frontend (`client/`), d3-geo + `us-atlas` (states/counties-albers-10m, pre-projected, FIPS ids).
  No Leaflet.
- Separate `server/` and `client/` packages (each with its own lockfile), not npm workspaces.
- One Docker image (multi-stage), docker compose on <HOST>.

## Layout
- `server/src/index.js` Express + Socket.io + poller wiring. `results.js` builds API responses from the latest
  snapshots. `db.js` schema + snapshot writer. `poller.js` per-target loops with backoff. `http.js` shared
  client (UA, timeouts, ETag/Last-Modified). `normalize.js` party + contest classification. `geo.js` FIPS.
- `server/src/adapters/clarity.js` Clarity/Civix ENR (file layout documented at the top of the file).
- `config/sources/clarity.json` the Clarity elections polled. `config/races-2026.json` which states hold which
  races (only used for states with no source). `config/clarity-county-candidates.json` research output.
- `client/` the temporary shell UI. **The real UI design will live in `design/` once exported from Claude
  Design**; build it against the same API and `shading.js`.
- `docs/source-roadmap.md` what every uncovered state publishes: the to-do list for new adapters.

## API
`GET /api/health`, `/api/national?race=`, `/api/state/:abbr?race=`, `/api/measures[?state=]`, `/api/coverage`.
Socket.io: `results:update` {sourceId, states, fetchedAt} when new numbers land (clients refetch);
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
