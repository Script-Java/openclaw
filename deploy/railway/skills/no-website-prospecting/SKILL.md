---
name: no-website-prospecting
description: "Find local small businesses that have no website and record them as leads in a Google Sheet (or a CSV fallback). Use when asked to research, prospect, or list businesses without websites in an area or category. Needs no API key: a bundled script reads the full Google Maps results list in the server browser; the Google Places API and OpenStreetMap are alternatives."
metadata: { "openclaw": { "emoji": "🏪" } }
---

# No-website prospecting

Goal: build a clean, de-duplicated list of small businesses in a given area and
category that have **no website**, and store it where the user can use it.

## Pick a data source

Check which mode is available, in this order, and tell the user which one you used:

1. **Maps extractor script (default, no key)**: `{baseDir}/scripts/maps_no_website.mjs`
   opens Google Maps in the server's headless Chromium, scrolls the whole results
   list, and prints every listing with its category, phone, rating, address, and
   website link. One command replaces dozens of browser turns. See Mode 1.
2. **Google Places API**: if `goplaces` runs and `GOOGLE_PLACES_API_KEY` is set
   (`goplaces search "test" --limit 1 --json` succeeds). Same data through the
   official API; use it when the script reports `blocked`, or for very large runs.
3. **OpenStreetMap (storefronts only)**: candidates from the Overpass API through
   `web_fetch`, then a web-search check per candidate. Works for shops and
   restaurants, not for service trades. See Mode 3.
4. **Driving the `browser` tool by hand** on Maps or directories: last resort,
   only when the script and the API both fail, and only if the user asks.

## Mode 1: Maps extractor script

Run it from the workspace with `exec` (it takes 20 to 60 seconds):

```bash
node {baseDir}/scripts/maps_no_website.mjs "<category>" "<area>" --json
node {baseDir}/scripts/maps_no_website.mjs "<category>" "<area>" --all --json   # include those with websites
```

The JSON has `status` (`ok`, `blocked`, or `error`), `checked`, `without_website`,
and `listings` with `name`, `category`, `phone`, `rating`, `reviews`, `address`,
`website`, `maps_url`. Without `--all` only listings with no website are returned.

Rules:

- Maps mixes in unrelated results (retail stores, car washes, rental shops).
  Keep a listing only when its `category` matches what the user asked for, or
  its name clearly does; drop the rest and mention how many you dropped.
- Run the script once per phrasing ("power washing", "pressure washing",
  "exterior cleaning") and, when the user wants volume, once per nearby town.
  Merge on `maps_url` before writing.
- A website field that is a Facebook, Instagram, or Linktree page counts as
  "no real website"; keep the listing and put the link in `social_or_notes`.
- If `status` is `blocked`, wait for the user before retrying; switch to Mode 2
  if the Places key exists, otherwise report the block.

## Know which source can answer before you start

- **Storefront categories** (bakeries, salons, restaurants, cafes, florists,
  dentists, gyms, shops) are well covered by OpenStreetMap, so Mode 3 also works for them; the Maps script (Mode 1) works for everything.
- **Service trades** (power washing, pressure washing, plumbers, electricians,
  landscapers, roofers, handymen, cleaners, painters) are mostly home-based
  and are rarely mapped in OpenStreetMap. For these, OpenStreetMap (Mode 3) returns nothing;
  use the Maps script (Mode 1). Never spend turns on Overpass tag variants for a
  service trade.
- Google Maps ranks businesses that have websites first. The first 10 to 20
  results are almost always websites, so a Maps page that shows only "Website"
  buttons proves nothing about the long tail. Leads live deeper in the list.
  This is why the script (which scrolls the entire list) and the API (which
  pages through it) find them and a Maps screenshot does not.

## Inputs to confirm before starting

1. **Area**: a city, neighborhood, or postcode.
2. **Categories**: what kinds of businesses (plumbers, bakeries, salons, ...).
   Ask if the user did not say. Handle one category at a time.
3. **Destination**: an existing spreadsheet id, a new sheet, or a CSV.

## Mode 2: Google Places API

Resolve the area with `goplaces resolve "<area>" --json` and use its coordinates:

```bash
goplaces search "<category> in <area>" --lat <lat> --lng <lng> --radius-m <r> --limit 20 --json
goplaces search "<category> in <area>" --lat <lat> --lng <lng> --radius-m <r> --limit 20 --page-token "<token>" --json
```

Use `--radius-m 5000` for a town and `15000` for a city. If the search JSON has
no website field (`websiteUri` or `website`), run `goplaces details <place_id> --json`
per candidate. Keep a business only when the website field is absent or empty.
Skip places whose `businessStatus` is not `OPERATIONAL`. Stop paginating when a
page yields fewer than 5 new candidates.

To reach the long tail, run several phrasings per category ("power washing",
"pressure washing", "exterior cleaning", "house washing") and, when the user
wants volume, repeat for neighboring towns (for McKinney: Frisco, Allen, Plano,
Prosper). Each text search returns up to 60 results across three pages. Keep a
running de-duplicated set across all phrasings before checking websites, and
check websites once per unique place.

## Mode 3: OpenStreetMap + web check (storefronts only)

1. Fetch candidates with `web_fetch` from Overpass. Build the query with the
   OSM tag for the category (`shop=bakery`, `craft=plumber`, `shop=hairdresser`,
   `amenity=cafe`, `amenity=restaurant`, `craft=electrician`, `shop=florist`,
   `amenity=dentist`, ...). Use the area's admin boundary name:

   ```
   https://overpass-api.de/api/interpreter?data=[out:json][timeout:25];area["name"="<City>"]["admin_level"="8"]->.a;(node["shop"="bakery"](area.a);way["shop"="bakery"](area.a););out center tags 60;
   ```

   URL-encode the `data` parameter. Each element has `tags.name`, address parts
   (`addr:housenumber`, `addr:street`), sometimes `phone` or `contact:phone`,
   and `website` or `contact:website` when known. Skip elements with no `name`.
   If the area returns nothing, try `admin_level` 6 or drop the level filter.

2. A missing OSM website tag is only a hint. Verify each candidate with one web
   search through `web_fetch`:

   ```
   https://html.duckduckgo.com/html/?q=%22<name>%22+<city>
   ```

   Read the result URLs. Ignore directories and aggregators (yelp, yellowpages,
   facebook, instagram, mapquest, bbb, tripadvisor, doordash, grubhub, nextdoor,
   linkedin, google). A remaining result whose domain contains a distinctive
   word of the business name is its website: drop the business. If nothing
   remains, keep it as a lead; note any social-media page found. If the
   `web_search` tool is configured, it may be used instead of the fetch.

3. Obvious chains and franchises are not small businesses; skip them.

## Mode 4: browser by hand

Only when asked. Open the directory in the `browser` tool, search the category
and area, snapshot the results page, and treat a listing as a lead when it shows
no website link. Re-snapshot after paging. If the site blocks the session or
shows a captcha, stop and report it rather than retrying.

On Google Maps specifically: use the search URL
`https://www.google.com/maps/search/<category>+<area>/`, keep the results list
open, and scroll the list itself (not the map) to load more entries; leads
appear after the first screen. Do not click into individual places, which
collapses the list. Give up after three empty scrolls or any block, and say
that the Places key would have paged the same data in seconds.

## De-duplicate and write

De-duplicate by `maps_url` (script), place id (Places), or OSM id / normalized
name plus street (OpenStreetMap) against what is already in the destination
before appending.

Use exactly this header, in this order, so runs can be appended to the same sheet.
Do not rename, drop, or reorder columns; leave a cell empty when unknown:

```
name,category,address,phone,rating,review_count,google_maps_url,source_id,social_or_notes,found_on
```

Example row from the script (`maps_url` fills both link columns):

```
Morris Power Washing,Pressure washing service,19251 Lloyd Cir,(469) 989-9819,5.0,6,https://www.google.com/maps/place/...,maps:https://www.google.com/maps/place/...,Facebook: morrispowerwash,2026-09-07
```

`found_on` is today's date (YYYY-MM-DD). For the script, `google_maps_url` is the
listing's `maps_url` and `source_id` is `maps:<maps_url>`. For Places, `google_maps_url` is
`https://www.google.com/maps/place/?q=place_id:<place_id>` and `source_id` is the
place id. For OSM, `google_maps_url` is
`https://www.google.com/maps/search/?api=1&query=<name>%20<city>` and `source_id`
is `osm:<type>/<id>`. Leave rating and review_count empty when unknown.

### Google Sheets (when `gog auth status --no-input` shows an account)

- New sheet: create it in Drive, name it `Leads - <area> - <category>`, write the
  header row with `gog sheets update <sheetId> "Sheet1!A1:J1" --values-json '[[...]]'`.
- Existing sheet: read `"Sheet1!H:H"` with `gog sheets get <sheetId> "Sheet1!H:H" --json`
  to collect known ids, then append only new rows with
  `gog sheets append <sheetId> "Sheet1!A:J" --values-json '[[...],[...]]' --insert INSERT_ROWS`.
- Report the sheet URL `https://docs.google.com/spreadsheets/d/<sheetId>` at the end.

### CSV fallback

Write `leads/<area>-<category>-<date>.csv` in the workspace with the same header,
and say that Google Sheets was not authorized (`gog auth add ...`).

## Reporting

Finish with: the mode used, how many places were checked, how many had no
website, where the list was saved, and any places you were unsure about.
