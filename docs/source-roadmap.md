# Official results source roadmap: 2026 general (Nov 3, 2026)

Probed on election night, 2026-11-03, about 16:00–17:30 MT (before most polls closed), using
`curl` with the User-Agent `election-map/0.1 (live results dashboard)`. Each state got a few
requests. No browser UA was spoofed, and nothing was done to get past bot protection: any
403, Cloudflare challenge, Imperva or Radware page is recorded as "blocked".
Colorado (Clarity EID 127407) and Iowa (Clarity EID 127077) are covered elsewhere and are left out
of the table except for the Colorado note at the end.

Legend for **Reachable**: `yes` means data came back to a plain request. `page only` means the HTML
loaded but no data endpoint was confirmed. `blocked (CF/Akamai/Imperva/Radware/CloudFront/WAF)` means
the server refused a non-browser client. `n/a` means the state has no election-night feed.

Important finding about Clarity: `/{ST}/elections.json` does **not** reliably show whether a state uses Clarity.
SC and WV return `[]` there but still serve live elections under specific EIDs. AR, AZ, KY and NC return
**403** (an unknown prefix such as `/ZZ/` returns 404). So those state folders still exist but are locked, and all
four states now publish elsewhere (see the table).

> **Update 0.2 (2026-11-03 evening):** adapters now exist for GA, VA, UT, WA, RI, ID (Enhanced Voting), TX, CA, VT, NC, AR, DE, OH, CT and FL (FL disabled pending real data). Their rows below say "Done (0.2)".

## Platforms identified (multi-state first)

| Platform | States | Machine-readable entry point (verified tonight) |
|---|---|---|
| **Enhanced Voting** (Angular SPA at `/results/public/{jurisdiction}`) | GA, VA, UT, WA, RI, ID | `GET {host}/results/public/api/jurisdictions/{slug}` returns the election list (`elections[].publicElectionId`) plus `childLocalities` (counties). `GET {host}/results/public/api/elections/{slug}/{publicElectionId}` returns metadata. **`GET {host}/results/public/api/elections/{slug}/{publicElectionId}/data`** returns every ballot item with `summaryResults` (0.3–1.5 MB). Also `/data/ballot-item/{id}`, `/localities`, `/turnout`, `/stats`, `/closeraces`. |
| **ASP.NET "ResultsAjax.svc" ENR family** (shared codebase; likely BPro/TotalVote heritage, now Civix, **unverified**) | NE, SD, ND, NM, OR | HTML pages plus `ResultsExport.aspx`, which offers CSV/Excel/RSS/XML through an ASP.NET postback. The `ResultsAjax.svc/GetCandidates?ElectionType=General&ElectionID=0` JSON is only autocomplete data. Service roots: NE `neresultswebservice.azurewebsites.us`, SD `sdresws.azurewebsites.us`, OR `orresultswebservices.azureedge.us`, NM `nmresultswebservice.azurewebsites.us/NMResultsAjax.svc`, ND `resultsws.sos.nd.gov`. |
| **Clarity / Civix ENR** (other than CO/IA) | SC (custom domain), WV | SC: `https://results.enr.clarityelections.com/SC/127300/` (the same EID also works on `www.enr-scvotes.org/SC/127300/`). `current_ver.txt` returned `382659`. WV: the May 2026 primary was `WV/126209`. The **general EID is not found yet**. |
| **Tally ENR / TotalResults** | AR (only state client found, out of 41 slugs checked) | `GET https://enr-results-api.totalresults.com/Election/GetElectionList?cid=arkansas`, then `Contest/GetContestSearchList?cid=arkansas&electionID={guid}`. Full precinct dump: `https://results.tally-enr.com/results/arkansas/{electionID}/FullDataFile.json` (**50 MB**). |
| **Civix IVIS ENR** (TX; bundle also references PCC `electionet.pcctg.net`) | TX | `https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/electionConstants` gives the election list as base64 JSON. `/s3/enr/election/{id}` has statewide/federal/district sections, each base64 JSON (1.6 MB). `/s3/enr/election/countyInfo/{id}` is county-level (4 MB). The 2026 general id is **53815**. |
| **PCC Technology** public reporting | CT | `https://ctemspublic.tgstg.net/ng-app/data/Elections.json` (2026 general ID **108**), then `.../election/108/Version.json`, then `.../election/108/{Version}/Electiondata.json` (plus `Lookupdata.json`, `ballotQuestion_Electiondata.json`, `candidateGrouping_Electiondata.json`). Town-level. |

## State-by-state

| State | Results URL | Platform | Best format | Levels | Reachable w/o browser? | Notes |
|---|---|---|---|---|---|---|
| AL | https://www2.alabamavotes.gov/electionNight/statewideResultsByContest.aspx?ecode=… | In-house ASP.NET (SOS) | HTML; "Export Data" postback (format unverified) | statewide, county | yes (page) | The SOS page currently links `ecode=1001305`. Confirm the 2026 general ecode tonight. |
| AK | https://www.elections.alaska.gov/election-results/e/?id=26genr | In-house (WordPress) | PDF summary reports (e.g. `wp-content/uploads/2026/11/…ComboReportRAll.pdf`) | statewide, district | yes (page) | No JSON or CSV found. Uses RCV, so the first-choice tally is what appears on election night. |
| AZ | https://results.arizona.vote/ (linked from azsos.gov "unofficial-enr") | AZ SOS custom app (moved off Clarity) | unknown (JSON believed behind the SPA) | statewide, county | **blocked (Cloudflare 403)**, azsos.gov also 403 | The Clarity `/AZ/` prefix is locked (403). Use county sites (Maricopa, Pima) as an alternative and check their bot rules. |
| AR | https://arkansas.tally-enr.com/ | **Tally ENR** | **JSON API** — adapter `tallyenr` (GetTurnout change check + GetSingleContestResults per contest) | statewide, county | yes | **Done (0.2)**. electionID `11b07106-031e-4d7c-911a-d01fb473d6dd`. Senate, Gov, 4 House, Issues 1–4; vote types; turnout per county. Never the 50 MB FullDataFile. |
| CA | https://electionresults.sos.ca.gov/ | In-house SOS API | **JSON** — adapter `casos`: api.sos.ca.gov/returns/maps/governor, us-rep/district/all, ballot-measures(+/county/{slug}), status | statewide, county (Gov, props); House per district only | API yes; front page behind Imperva | **Done (0.2)**. No Senate 2026. /status held Sep-2024 test data on election afternoon (ignored until current); no unprocessed-ballots or House-by-county endpoint. |
| CT | https://ctemspublic.tgstg.net/ | **PCC Technology** | **JSON** — adapter `pccct` | statewide, county (towns summed via the source's countyTowns) | yes | **Done (0.2)**. Gov + House 1–5; no Senate or statewide question 2026; fusion lines summed per candidate. |
| DE | https://elections.delaware.gov/results/enr/GE2026.html | In-house (DE Dept. of Elections) | **JSON** — adapter `deenr`: Election_{StatewideResults,ByCountyWithWilmington,VoterTurnout}_ID_GE2026.json | statewide, county | yes, but the firewall rejects back-to-back requests, so requests go 3 s apart and a reject page fails the poll (no retry around it) | **Done (0.2)**. Senate + House AL; methods statewide. Socrata copy (yg7x-kgjc) isn't live. |
| DC | https://electionresults.dcboe.org/ | Custom React + SignalR app | unverified (SPA; data API not found in main bundle) | citywide, ward, precinct | yes (page) | Needs a closer look at the other JS chunks or the SignalR hub. |
| FL | https://floridaelectionwatch.gov/ (2026 general; results.elections.myflorida.com never listed it) | Florida Election Watch (FL DOS) | **TSV** via the Downloads page's own link — adapter `fldos` | statewide (sum of counties), county | yes | **Live since 0.3.3**: verified against Election Watch's own county pages on election night. |
| GA | https://results.sos.ga.gov/results/public/Georgia | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide, county | yes | **Done (0.2)**. Senate, Gov, House 1–14, 3 amendments; methods Election Day / Advance Voting / Absentee by Mail / Provisional. |
| HI | https://elections.hawaii.gov/election-results/ | In-house (Hart tabulation exports) | **TSV** — adapter `hioe`: `wp-content/results/2026 General/summary.txt` (statewide by contest, Mail / In-Person split, precincts counted) | statewide (no county column; precincts are district-precinct numbers) | yes | **Built, disabled (0.4.6)** pending the first general release (~7:45 pm HST = 05:45 UTC): the folder 404s and the page links a "Placeholders" summary.txt ("Information will be posted at a later date"). Parser verified on the real 2026 Primary file (same `#FormatVersion 1`). House districts are Roman numerals (Dist I / II). media.txt (precinct, 2 MB) not used. |
| ID | https://results.voteidaho.gov/results/public/ID | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide, county | yes | **Done (0.2)**. Senate, Gov, House 1–2, 3 measures with titles. |
| IL | https://www.elections.il.gov/ | none statewide on election night | n/a (SBE posts certified results weeks later) | — | n/a | Live results come from county clerks and Chicago BOE. Low priority. |
| IN | https://enr.indianavoters.in.gov/site/index.html | In-house AngularJS + Azure blob JSON | **JSON**: `/site/data/version.json` → versioned files `/site/data/{name}_{version}.json` | statewide, county | yes | `version.json` and `settings.json` work. The exact versioned filename (e.g. `statewideElectionsR`) **still needs resolving** because the guessed suffixes 404'd. |
| KS | https://sos.ks.gov/elections/election-results.html | Power BI (GCC) embed `app.powerbigov.us` | Power BI dashboard; precinct XLSX after certification | statewide, county | page yes; no feed | Power BI internal query API is not a public feed. Low value for live use. |
| KY | https://vrsws.sos.ky.gov/liveresults/ | In-house (KY SOS) | unknown | statewide, county | **blocked (Akamai 403 "Acceptable Use Policy" page)** | The Clarity `/KY/` prefix is locked (403). KY moved to the SOS-hosted live results site. |
| LA | https://voterportal.sos.la.gov/graphical | In-house (LA SOS) | **JSON**: `/ElectionResults/ElectionResults/Data?blob=ElectionDates.htm` (returns JSON; 2026-11-03 = PKElectionID 344); XLSX at `s3-us-west-2.amazonaws.com/mediaresults.sos.la.gov/HumanReadableElectionResults/…` | statewide, parish, precinct | yes | The blob names for races and parishes still need mapping from the Angular app. |
| ME | https://www.maine.gov/sos/cec/elec/results/ | none on election night | XLSX posted days later | — | **blocked (CloudFront 403)** | No statewide ENR. Media/AP only on election night. |
| MD | https://elections.maryland.gov/elections/2026/general_results/index.html | In-house static HTML | HTML (`gen_qresults_2026_*.html`, `_by_county_*`) | statewide, county | yes | Static pages are easy to scrape. CSVs usually come after canvass. |
| MA | https://electionstats.state.ma.us/ | ElectionStats (historical) | none live | — | n/a | No statewide live ENR. Towns report and AP covers election night. |
| MI | https://mielections.us/election/results/ | In-house (MI SOS) | historically HTML + TXT downloads | statewide, county | **no (connection timed out)** | May be blocking or firewalled. Retry later and fall back to county sites. |
| MN | https://electionresults.sos.mn.gov/ | In-house (MN SOS) | historically TXT files at `electionresultsfiles.sos.mn.gov` | statewide, county, precinct | **blocked (Radware bot manager; files host also 403)** | The best feed in the Midwest if access is ever allowed. Ask MN SOS for API access. |
| MS | https://www.sos.ms.gov/elections-voting/election-results | none statewide on election night | n/a (SOS posts certified results only) | — | n/a | Counties report and AP covers election night. |
| MO | https://enr.sos.mo.gov/ | In-house (MO SOS) | unknown | statewide, county | **blocked (Cloudflare 403)** | |
| MT | https://electionresults.mt.gov/ (sosmt.gov) | In-house | unknown | statewide, county | **blocked (Cloudflare 403)** | |
| NE | https://electionresults.nebraska.gov/ | **ResultsAjax.svc family** | CSV/XML export (postback) | statewide, county | yes | |
| NV | https://silverstateelection.nv.gov/ | In-house (NV SOS) | unknown | statewide, county | **blocked (Imperva redirect loop)** | |
| NH | https://www.sos.nh.gov/elections/elections/election-results | none on election night | posted later | — | **blocked (403)** | Town results go through media/AP. |
| NJ | https://www.nj.gov/state/elections/election-information-results.shtml | none statewide live | PDFs after certification | — | n/a | County clerks run their own ENR (several on Clarity county folders). Senate race in 2026, so treat counties as a fallback. |
| NM | https://electionresults.sos.nm.gov/ | **ResultsAjax.svc family** (`NMResultsAjax.svc`) | CSV/XML export (postback) | statewide, county | yes | |
| NY | https://nyenr.elections.ny.gov/ | In-house (NYSBOE) | unknown | statewide, county | **blocked (Cloudflare 403, intermittent; one 200)** | |
| NC | https://er.ncsbe.gov/ | In-house (NCSBE) | **JSON as .txt** — adapter `ncsbe`: county.txt + results_0.txt + results_{1..100}.txt | statewide, county | yes | **Done (0.2)**. Senate + 14 House + 3 amendments; methods Election Day / Early Voting / Absentee by Mail / Provisional; registration/ballots/turnout per county. |
| ND | https://results.sos.nd.gov/ | **ResultsAjax.svc family** | CSV/Excel/RSS/XML export (postback) | statewide, county, precinct | yes | |
| OH | https://liveresults.ohiosos.gov/ | In-house (OH SOS) | **XML (NIST SP 1500-100 V1)** — adapter `nistcdf` | statewide, county | yes | **Done (0.2)**. Gov, Senate (special), House 1–15, Issue 3; turnout + absentee outstanding. GeneratedDate is on a 12-hour clock (config flag). |
| OK | https://results.okelections.us/OKER/?elecDate=20261103 | In-house (OK SEB) | unknown | statewide, county | **blocked (AWS WAF 403)** | Linked from oklahoma.gov 2026 results pages. Clarity OK list is stale. |
| OR | https://results.oregonvotes.gov/ | **ResultsAjax.svc family** | CSV/XML export (postback) | statewide, county | yes | |
| PA | https://www.electionreturns.pa.gov/ | In-house (PA DOS) | unknown (JSON API historically) | statewide, county | **blocked (Imperva challenge + reCAPTCHA)** | High-value state, but no clean access. |
| RI | https://electionresults.ri.gov/results/public/rhodeisland | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide (town data has no county map) | yes | **Done (0.2)**. Senate, Gov, House 1–2, 5 bonds; methods Election Day / Early Voting / Mail Ballots. |
| SC | https://www.enr-scvotes.org/SC/127300/ | **Clarity** (custom domain) | Clarity JSON/XML (`current_ver.txt`, then version files) | statewide, county, precinct | yes | The EID was found by its "Statewide General Election" link on scvotes.gov. `SC/elections.json` is `[]`. Governor + Senate 2026. |
| SD | https://electionresults.sd.gov/ | **ResultsAjax.svc family** | CSV/XML export (`/ResultsExport.aspx`) | statewide, county | yes | |
| TN | https://sos.tn.gov/elections/results (elections.tn.gov) | In-house | unknown | statewide, county | **blocked (CloudFront 403)** | |
| TX | https://goelect.txelections.civixapps.com/ivis-enr-ui/races | **Civix IVIS ENR** | **JSON (base64 sections)** — adapter `txivis`: /election/53815 + /election/countyInfo/53815 | statewide, county | yes | **Done (0.2)**. Senate, Gov, 38 House; county turnout/precincts; early vs election day (election day derived = total − early). No 2026 statewide props. |
| UT | https://electionresults.utah.gov/results/public/Utah | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide, county | yes | **Done (0.2)**. House 1–4, Amendments A/B. No Senate/Gov 2026. Registration published as 0 → null. |
| VT | https://electionresults.vermont.gov/ | Custom Angular + Azure static JSON | **JSON** — adapter `vtsos`: /elections/{guid}.json → timestamped f/s/turnout files | statewide, county (towns summed via the source's town→county list) | yes | **Done (0.2)**. House AL + Gov; no Senate or ballot questions 2026. |
| VA | https://enr.elections.virginia.gov/results/public/virginia | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide, county/city | yes | **Done (0.2)**. Senate, House 1–11, 3 amendments; methods incl. Post-Election. Independent cities matched by FIPS in the adapter. |
| WA | https://results.votewa.gov/results/public/washington | **Enhanced Voting** | **JSON** — adapter `enhancedvoting` (/data + /data/ballot-item/{id} for counties) | statewide, county | yes | **Done (0.2)**. House 1–10, 3 initiatives with titles; publishes Estimated Ballots Left to Count. |
| WV | https://results.enr.clarityelections.com/WV/{EID}/ | **Clarity** | Clarity JSON/XML | statewide, county, precinct | yes (primary EID 126209 works) | **The general EID was not found.** Get it from sos.wv.gov or govotewv.com tonight (it is likely around 1273xx). |
| WI | https://elections.wi.gov/elections/election-results | none statewide on election night | n/a | — | **blocked (Cloudflare 403)** | WEC doesn't publish election-night totals. Counties report and AP covers the night. |
| WY | https://sos.wyo.gov/Elections/ElectionResults.aspx | In-house | PDF/HTML | statewide, county | yes (page) | No live feed found. **Unverified**. |

### Colorado note
Every `coloradosos.gov` URL returned **403 (Cloudflare)** to our client, and no workaround was tried. Web search
found only a 2017 SOS press release pointing to `results.enr.clarityelections.com/CO/…` and a Mesa County 2025 page
that uses the statewide CO Clarity site with CSV downloads. Search also says the Colorado Sun shows SOS data
through AP. I could not confirm that the SOS links EID 127407 tonight, and I found no separate CO SOS
JSON/XML feed. Treat Clarity CO 127407 as the canonical machine source.

## Suggested next adapters (ordered by value)

1. **Enhanced Voting** (GA, VA, UT, WA, RI, ID): one adapter covers 6 states, including the GA Senate+Gov race and the VA Senate race. Clean JSON, no keys, and all endpoints were verified tonight. The county split is in `/data` (`ballotItemWithBreakdown`, `localityElections`) or per-locality jurisdictions.
2. **Clarity** (reuse the CO/IA adapter): add SC EID 127300 now and WV once its general EID is known. Make the adapter accept a configured EID instead of relying on `elections.json`.
3. **Civix IVIS (TX)**: one big state with base64-wrapped JSON sections and an easy decoder.
4. **NCSBE (NC)**: JSON-in-.txt plus a precinct ZIP. A swing-state Senate race.
5. **Ohio NIST 1500-100 XML**: a standards-based feed. If the parser is written generically for the NIST CDF, it can be reused if other states adopt the format.
6. **California SOS API**: per-race JSON with a county map endpoint (Governor, House).
7. **Tally ENR (AR)**: use the `Contest/*` API rather than the 50 MB FullDataFile.
8. **ResultsAjax.svc family** (NE, SD, ND, NM, OR): 5 states but only a postback CSV/XML export, so it needs an ASP.NET VIEWSTATE round-trip. Worth one shared adapter after the JSON sources.
9. **Single-state JSON/TSV sources**: CT (PCC JSON), VT (static JSON), FL (TSV extract), DE (Socrata SODA), HI (media.txt TSV, late night), LA (Data?blob= JSON, blob map TBD), IN (versioned JSON, filename TBD).
10. **HTML scrape only**: MD (static pages), AL (ASP.NET), AK (PDF), WY (PDF).
11. **No usable free official feed tonight**, so AP/media or county fallbacks are needed. Blocked: AZ, KY, MI, MN, MO, MT, NV, NY, OK, PA, TN, WI. No statewide ENR: IL, MA, ME, MS, NH, NJ. Low-yield: KS (Power BI). For the blocked states, the only polite route is asking the office for feed access or an allowlist.
