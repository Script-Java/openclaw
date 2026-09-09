---
name: no-website-prospecting
description: "Find local small businesses that have no website and keep them as leads in a SQLite database on the volume (with CSV and Google Sheets exports). Use when asked to research, prospect, or list businesses without websites, to add categories or cities to the daily prospecting queue, or to answer questions about collected leads. Needs no API key: a bundled script reads the full Google Maps results list in the server browser, and a batch runner drains the queue unattended every morning."
metadata: { "openclaw": { "emoji": "🏪" } }
---

# No-website prospecting

Goal: build a clean, de-duplicated list of small businesses in a given area and
category that have **no website**, keep it in one database, and hand the user
what they ask for (a CSV, a Google Sheet, a count, a shortlist).

## Where the data lives

`{baseDir}/scripts/leads_db.mjs` manages a SQLite database at
`<workspace>/prospecting/leads.sqlite` (on the Railway volume, so it survives
redeploys). Three tables:

- `businesses`: every listing ever checked, keyed by its Google Maps URL.
  `has_website = 0` marks a lead; `status` is `new`, `contacted`,
  `not_interested`, `won`, or `skip`; `search_category` / `search_area` say
  which queue entry found it.
- `targets`: the search queue, one row per `category` x `area` pair, with the
  time it last ran.
- `runs`: one row per search the batch runner performed.

Handy commands (run with `exec`, from any directory):

```bash
node {baseDir}/scripts/leads_db.mjs stats
node {baseDir}/scripts/leads_db.mjs leads --area "Frisco" --category roofing --status new --limit 50
node {baseDir}/scripts/leads_db.mjs leads --since 2026-09-01 --csv > leads/frisco.csv
node {baseDir}/scripts/leads_db.mjs export leads/all-new-leads.csv --status new
node {baseDir}/scripts/leads_db.mjs mark "<maps_url>" contacted "left voicemail 9/12"
node {baseDir}/scripts/leads_db.mjs sql "SELECT search_area, COUNT(*) n FROM businesses WHERE has_website = 0 GROUP BY 1 ORDER BY n DESC"
node {baseDir}/scripts/leads_db.mjs targets list
node {baseDir}/scripts/leads_db.mjs targets add "roofing contractor" "Plano TX"
node {baseDir}/scripts/leads_db.mjs targets add-many --categories "plumber,electrician" --areas "Allen TX,Wylie TX"
node {baseDir}/scripts/leads_db.mjs targets disable <id>
```

Write areas as `Allen TX` (no comma): `add-many` splits its lists on commas.

Answer questions about leads with `stats`, `leads`, or a read-only `sql`
query; never re-scrape to answer a question the database can answer.

## The daily batch (runs on its own)

`{baseDir}/scripts/prospect_batch.mjs` is what the morning automation runs. It
picks the targets that have never run (then the stalest, skipping any run in
the last 30 days), runs the Maps extractor for each, records every listing,
and stops after `--budget` listings (default 1000), when the queue is empty,
or when Google blocks the browser. It writes the batch's new leads to
`<workspace>/prospecting/exports/<date>-new-leads.csv`, appends them to a
Google Sheet when `PROSPECTING_SHEET_ID` is set and `gog` is authorized, and
prints a summary that the automation delivers to the user's chat. Progress is
logged to `<workspace>/prospecting/batch.log`.

The automation is an OpenClaw command job named "Daily prospecting" (see
Control UI -> Automations). The user changes the schedule or the budget
there, and changes **what** gets searched by editing the `targets` table with
the commands above. When the user asks to "add roofers in Plano" or "stop
searching Denton", edit targets; do not start a manual scrape unless asked.

To run a batch by hand (for example "run prospecting now"):

```bash
node {baseDir}/scripts/prospect_batch.mjs --budget 300 --max-targets 5
```

It takes about a minute per target search. Report the printed summary.

## One-off research (user asks for a specific category and area)

Run the extractor directly with `exec` (20 to 60 seconds):

```bash
node {baseDir}/scripts/maps_no_website.mjs "<category>" "<area>" --json
node {baseDir}/scripts/maps_no_website.mjs "<category>" "<area>" --all --json   # include those with websites
```

The JSON has `status` (`ok`, `blocked`, or `error`), `checked`, `without_website`,
and `listings` with `name`, `category`, `phone`, `rating`, `reviews`, `address`,
`website`, `maps_url`. Without `--all` only listings with no website are returned.

Prefer adding the search as a target and running the batch with
`--max-targets 1`, so the results land in the database too:

```bash
node {baseDir}/scripts/leads_db.mjs targets add "<category>" "<area>"
node {baseDir}/scripts/prospect_batch.mjs --max-targets 1 --budget 200
node {baseDir}/scripts/leads_db.mjs leads --area "<area>" --category "<category>" --since <today>
```

Rules:

- Maps mixes in unrelated results (retail stores, car washes, rental shops).
  When presenting leads, keep a listing only when its `category` matches what
  the user asked for, or its name clearly does; say how many you dropped.
- Run several phrasings when the user wants volume ("power washing",
  "pressure washing", "exterior cleaning") and neighboring towns. The database
  merges duplicates on `maps_url`.
- A website that is a Facebook, Instagram, Linktree, Yelp, or directory page
  counts as "no real website"; the database keeps the listing as a lead and
  stores the link in `social`.
- If `status` is `blocked`, wait for the user before retrying, or switch to the
  Places API (below) if its key exists.

## Alternatives when the extractor cannot run

1. **Google Places API**: if `goplaces` runs and `GOOGLE_PLACES_API_KEY` is set
   (`goplaces search "test" --limit 1 --json` succeeds). Resolve the area with
   `goplaces resolve "<area>" --json`, then
   `goplaces search "<category> in <area>" --lat <lat> --lng <lng> --radius-m 5000 --limit 20 --json`
   and page with `--page-token`. If the search JSON has no `websiteUri`, run
   `goplaces details <place_id> --json` per candidate. Keep only `OPERATIONAL`
   places with no website. Use `google_maps_url`
   `https://www.google.com/maps/place/?q=place_id:<place_id>` when writing rows.
2. **OpenStreetMap + web check (storefronts only)**: `web_fetch` the Overpass
   API (`area["name"="<City>"]["admin_level"="8"]->.a;(node["shop"="bakery"](area.a);way["shop"="bakery"](area.a););out center tags 60;`),
   then verify each candidate with one DuckDuckGo HTML search
   (`https://html.duckduckgo.com/html/?q=%22<name>%22+<city>`), ignoring
   directories and social sites. Service trades (power washing, plumbers,
   landscapers) are rarely in OpenStreetMap; do not use this mode for them.
3. **Browser by hand**: only when asked. Google Maps ranks businesses with
   websites first, so scroll the results list itself; leads appear after the
   first screen. Stop on any block.

## Know which source can answer

- **Storefront categories** (bakeries, salons, restaurants, dentists, gyms,
  shops): the extractor and OpenStreetMap both work.
- **Service trades** (power washing, plumbers, electricians, landscapers,
  roofers, handymen, cleaners, painters): mostly home-based; only the extractor
  or the Places API find them.
- Google Maps ranks businesses that have websites first. The first 10 to 20
  results are almost always websites; leads live deeper in the list, which is
  why the extractor scrolls to the end.

## Output format

Use exactly this header, in this order, so runs can be appended to the same
sheet (`leads_db.mjs leads --csv` and `export` already produce it):

```
name,category,address,phone,rating,review_count,google_maps_url,source_id,social_or_notes,found_on
```

Example row:

```
Morris Power Washing,Pressure washing service,19251 Lloyd Cir,(469) 989-9819,5.0,6,https://www.google.com/maps/place/...,maps:https://www.google.com/maps/place/...,Social: https://facebook.com/morrispowerwash,2026-09-07
```

### Google Sheets (when `gog auth status --no-input` shows an account)

- New sheet: create it in Drive, name it `Leads - <area> - <category>`, write the
  header row with `gog sheets update <sheetId> "Sheet1!A1:J1" --values-json '[[...]]'`.
- Existing sheet: read `"Sheet1!G:G"` with `gog sheets get <sheetId> "Sheet1!G:G" --json`
  to collect known Maps URLs, then append only new rows with
  `gog sheets append <sheetId> "Sheet1!A:J" --values-json '[[...],[...]]' --insert INSERT_ROWS`.
- To make the daily batch append automatically, tell the user to set
  `PROSPECTING_SHEET_ID=<sheetId>` as a Railway variable (or ask you to edit
  the automation's command to add `--sheet <sheetId>`).
- Report the sheet URL `https://docs.google.com/spreadsheets/d/<sheetId>` at the end.

### CSV fallback

Write `leads/<area>-<category>-<date>.csv` in the workspace with the same header,
and say that Google Sheets was not authorized (`gog auth add ...`).

## Reporting

Finish with: how many places were checked, how many had no website, how many
were new to the database, where the list was saved, and anything you were
unsure about.
