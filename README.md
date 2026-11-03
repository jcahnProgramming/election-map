# election-map

Live, public election-night results map for the 2026 US midterms: national map by race (Senate / Governor /
House popular vote), county view per state where the source has it, and a ballot-measure sidebar. Updates push
to the browser over Socket.io. Unofficial results; we never call races.

## Run locally

Requires Node 22+.

```sh
npm install        # installs server/ and client/ too (postinstall)
npm run dev        # API on :3710 (watch mode) + Vite on :5173 — open http://localhost:5173
```

- The server starts polling every configured source immediately (default every 60 s; `POLL_INTERVAL_SECONDS`).
- The SQLite DB is created at `./data/election-map.db` (`DATA_DIR` to move it).
- Production-style: `npm run build && npm start`, then open http://localhost:3710.
- Tests: `npm --prefix server test`.

## How the deploy works

Push to `main` on Gitea → `.gitea/workflows/deploy.yml` runs on <HOST>'s act_runner (`ubuntu-latest` label):

1. checks the host deploy dir `<DEPLOY_DIR>` (a git clone on `main`, with `.env` and `data/`),
2. fast-forwards it from Gitea's internal address `<GITEA_INTERNAL_URL>`,
3. `docker compose up -d --build`,
4. probes `http://<LAN_IP>:<ELECTION_MAP_PORT>/api/health` and fails unless it answers `"ok": true`,
   then checks the container isn't restart-looping.

The app is published on `<LAN_IP>:${ELECTION_MAP_PORT:-3710}` only; the Cloudflare tunnel maps
`election.postnerfclarity.com` → `http://<LAN_IP>:<port>`.

### One-time setup on <HOST>

```sh
cd <APPDATA_DIR>
git clone <GITEA_INTERNAL_URL>/path/election-map.git   # or your usual Gitea URL
cd election-map
cp .env.example .env          # check ELECTION_MAP_PORT is free
mkdir -p data && chown 99:100 data
docker compose up -d --build  # first run by hand; pushes take over after this
```

## Add a state

**If the state (or a county) uses Clarity / Civix ENR:** no code. Find the election id at
`https://results.enr.clarityelections.com/{ST}/elections.json` (or `/{ST}/{County}/elections.json`) and add an
entry to `config/sources/clarity.json`:

```json
{ "state": "XX", "path": "XX", "eid": "123456", "scope": "state", "name": "Xxx 2026 General" }
```

**Otherwise:** add one file, `server/src/adapters/<id>.js`, exporting
`{ id, name, targets(), fetch(target, ctx) }`. The contract is at the top of `server/src/adapters/index.js`:
`targets()` reads `config/sources/<id>.json`; `fetch()` returns normalized races (office, district, choices with
party, per-unit votes or yes/no, precinct reporting). Use `ctx.http` (polite UA, conditional requests) and
`ctx.unmatched()` for anything you can't map. Use `classifyContest`/`normalizeParty` from `server/src/normalize.js`
and `matchCounty` from `server/src/geo.js`. No other file needs to change: the registry picks it up, and the API,
coverage and map follow.

`docs/source-roadmap.md` lists what each uncovered state publishes.
