# Candidate photos — data format and rules

Files: `config/elections/<election>/candidates/<ST>.json` (one per state). Loaded by `server/src/photos.js`.
Review checklist: `docs/photos-review.md` (regenerate with `node scripts/photos-review.js`).

```json
{
  "state": "CO",
  "election": "2026-general",
  "candidates": [
    {
      "match": ["John Hickenlooper"],          // names exactly as our feeds spell them (case / punctuation ignored)
      "office": "senate",                       // senate | governor | house
      "district": null,                         // house district as in the feed ("7"); null otherwise
      "party": "DEM",
      "photo_url": "https://upload.wikimedia.org/…",   // https only; null when no allowed source exists
      "source_type": "wikimedia_commons",
      "source_page_url": "https://commons.wikimedia.org/wiki/File:…",
      "license": "Public domain (PD-USGov-Congress)",
      "credit": "United States Senate",
      "as_of": "2026-11-03",
      "reviewed": false,
      "note": null
    }
  ]
}
```

## Allowed sources (`source_type`)

- `official_portrait` — a government official photo (Congress bioguide, house.gov / senate.gov, a state's official page).
- `wikimedia_commons` — a Commons file; `license` and `credit` exactly as its File: page states them.
- `campaign_press_kit` — a campaign's own press / media page that offers the headshot for media use (`source_page_url` =
  that page).
- `candidate_submitted` — reserved for photos a candidate sends us.

Not allowed: search-engine image results, news photos, social media, Ballotpedia, images from a campaign homepage without
an explicit media-use offer. If nothing allowed exists, `photo_url` stays null and the candidate gets initials.

## Serving

- Only entries with an allowed `source_type`, an https `photo_url` and `"reviewed": true` are used. Unreviewed photos are
  never fetched or served.
- The server fetches each reviewed photo once at startup (polite User-Agent), resizes it to a 160 px square and caches
  it under `DATA_DIR/photos/`. Browsers load `/photos/<id>.jpg` from our domain; we never hotlink third-party sites.
- Image files are never committed to the repo: only URLs and attribution.
- Every avatar with a photo shows its credit and license on hover / focus; map tooltips list them in their footer.

## Fairness rule

Within one contest, photos are shown only when **every major candidate** has a reviewed, cached photo; otherwise every
candidate in that contest shows initials. Major = a party nominee (any party label other than independent / unaffiliated
/ no party / write-in) or any candidate with at least 5% of the votes counted. Write-ins and minor candidates always get
initials. The decision is made on the statewide numbers and reused for that contest's county rows.
