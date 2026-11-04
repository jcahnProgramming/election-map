# Ballot measure information: static data files

Ballot measures are fixed weeks before an election, so what we say *about* a measure (title, summary, who put it
on the ballot, …) is a static, versioned file per election and state. It is **not polled**. The API merges it with
the live yes/no counts from the adapters (`GET /api/measures`).

**Location:** `config/elections/<electionKey>/measures/<ST>.json` (e.g. `config/elections/2026-general/measures/CO.json`).
Not under `data/`: that folder is the SQLite bind mount on the server and is git-ignored.

## Rules

1. **Official sources only.** Secretary of State / election office measure pages, official voter guides (Colorado
   Blue Book, California Official Voter Information Guide / Legislative Analyst, …), legislature websites for referral
   bills and roll calls, campaign-finance filings for committees, and each party's own website for its positions.
   No news sites, Ballotpedia, Wikipedia or advocacy summaries as the *source* of a value (they may help you *find*
   the official page).
2. **Never write or paraphrase.** `official_title`, `official_summary` and `full_text` are copied verbatim. If no
   official neutral summary exists, `official_summary.value` is `null` and the UI says "No official summary published".
3. **A missing field is fine; an unsourced one is not.** Every non-null value carries its own `source_url` and
   `as_of` (the date you read it, YYYY-MM-DD). If a field can't be sourced officially, set it to `null` and add a line
   to `unsourced` saying why.
4. **Review gate.** `proponent_website`, `opposition_website` and every `party_positions` entry carry
   `"reviewed": false`. The UI shows them only once a human flips that to `true` (see `docs/measures-review.md`).
5. **Neutral, symmetric.** Opposition is listed only if a committee is officially registered as opposing the measure
   in a campaign-finance filing — exactly the same standard as the proponent side. Party positions only for parties
   that published one (platform, resolution, official endorsement page); never inferred.

## Shape

```jsonc
{
  "state": "CO",
  "election": "2026-general",
  "as_of": "2026-11-03",                       // when this file was last researched
  "measures": [
    {
      "measure_id": "Amendment 79",            // the official designation, as the state numbers it
      "match": ["Amendment 79"],               // strings that identify it in the live feed's contest name / title
                                               // (case-insensitive, whole words; e.g. "Amendment 79", "Proposition 1",
                                               // "Issue 2", "Question 1"). Several are fine.
      "official_source_url": "https://…",      // the measure's own page on the official election site
      "official_title":   { "value": "…", "source_url": "https://…", "as_of": "2026-11-03" },
      "official_summary": { "value": "…" | null, "source_url": "https://…" | null, "as_of": "2026-11-03",
                            "by": "Legislative Council (Blue Book)" },          // who wrote the official summary
      "full_text":        { "value": "…" | null, "url": "https://…" | null, "source_url": "https://…", "as_of": "…" },
                            // value = the ballot question exactly as printed; null + url when too long (> ~4000 chars)
      "placed_by": {
        "type": "initiative" | "legislative_referral" | "other",
        "proponent_name": "…" | null,          // initiatives: designated representatives / sponsoring committee from the filing
        "bill_number": "SCR 25-001" | null,    // referrals
        "detail": "…" | null,                  // e.g. "Referred by the General Assembly", "Automatic constitutional convention question"
        "source_url": "https://…", "as_of": "…"
      },
      "proponent_website":         { "value": "https://…", "source_url": "https://…", "as_of": "…", "reviewed": false } | null,
      "opposition_committee_name": { "value": "…", "source_url": "https://… (campaign-finance filing)", "as_of": "…" } | null,
      "opposition_website":        { "value": "https://…", "source_url": "https://…", "as_of": "…", "reviewed": false } | null,
      "party_positions": [
        { "party": "Colorado Democratic Party", "position": "support" | "oppose" | "no_position",
          "source_url": "https://…", "as_of": "…", "reviewed": false }
      ],
      "legislative_vote": {                    // referrals only; else null
        "chambers": [
          { "chamber": "Senate", "yes": 23, "no": 12, "other": 0,     // other = absent / excused / not voting
            "by_party": { "D": { "yes": 23, "no": 0 }, "R": { "yes": 0, "no": 12 } } | null }
        ],
        "roll_call_url": "https://…",
        "source_url": "https://…", "as_of": "…"
      } | null,
      "unsourced": ["official_summary: the state publishes no neutral summary for referred measures"]
    }
  ]
}
```

`by_party` is filled only when the official roll call (or the legislature's own member list) gives each member's
party; otherwise `null` with a note in `unsourced`.
