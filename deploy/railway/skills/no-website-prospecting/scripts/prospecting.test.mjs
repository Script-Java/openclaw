// Run with: node --test deploy/railway/skills/no-website-prospecting/scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addTargets,
  classifyWebsite,
  leadsToCsv,
  listLeads,
  openDb,
  pickTargets,
  stats,
  upsertListing,
} from "./leads_db.mjs";
import { appendToSheet, formatSummary, resolveSettings, runBatch } from "./prospect_batch.mjs";

const listing = (overrides = {}) => ({
  name: "Morris Power Washing",
  category: "Pressure washing service",
  address: "19251 Lloyd Cir",
  phone: "(469) 989-9819",
  rating: "5.0",
  reviews: "6",
  website: "",
  maps_url: "https://www.google.com/maps/place/morris",
  ...overrides,
});

test("classifyWebsite treats social and directory pages as no website", () => {
  assert.deepEqual(classifyWebsite(""), { hasWebsite: false, social: "" });
  assert.deepEqual(classifyWebsite("https://www.facebook.com/morrispowerwash"), {
    hasWebsite: false,
    social: "https://www.facebook.com/morrispowerwash",
  });
  assert.equal(classifyWebsite("https://linktr.ee/x").hasWebsite, false);
  assert.equal(classifyWebsite("https://morrispowerwash.com").hasWebsite, true);
  assert.equal(classifyWebsite("not a url").hasWebsite, true);
});

test("upsertListing inserts once and updates on re-sight", () => {
  const db = openDb(":memory:");
  const ctx = {
    searchCategory: "power washing",
    searchArea: "McKinney, TX",
    seenAt: "2026-09-08T12:00:00.000Z",
  };
  assert.deepEqual(upsertListing(db, listing(), ctx), { outcome: "inserted", isLead: true });
  assert.deepEqual(upsertListing(db, listing({ phone: "(469) 000-0000" }), ctx), {
    outcome: "updated",
    isLead: true,
  });
  const rows = listLeads(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, "(469) 000-0000");
  assert.equal(rows[0].rating, 5);
  assert.equal(rows[0].review_count, 6);
  // Gaining a website drops it from the lead list without deleting the row.
  assert.deepEqual(upsertListing(db, listing({ website: "https://morris.com" }), ctx), {
    outcome: "updated",
    isLead: false,
  });
  assert.equal(listLeads(db).length, 0);
  assert.equal(stats(db).businesses, 1);
  db.close();
});

test("pickTargets prefers never-run targets and honours the refresh window", () => {
  const db = openDb(":memory:");
  assert.equal(addTargets(db, ["plumber", "roofer"], ["Plano, TX", "Allen, TX"]), 4);
  assert.equal(addTargets(db, ["plumber"], ["Plano, TX"]), 0, "duplicates are ignored");
  const now = new Date("2026-09-08T12:00:00.000Z");
  db.prepare("UPDATE targets SET last_run_at = ? WHERE id = 1").run("2026-09-01T00:00:00.000Z");
  db.prepare("UPDATE targets SET last_run_at = ? WHERE id = 2").run("2026-07-01T00:00:00.000Z");
  const picked = pickTargets(db, { limit: 10, refreshDays: 30, now });
  assert.deepEqual(
    picked.map((t) => t.id),
    [3, 4, 2],
    "never-run first, then the stalest; id 1 ran inside the window",
  );
  db.close();
});

test("runBatch records listings, stops on block, and keeps blocked targets pending", async () => {
  const db = openDb(":memory:");
  addTargets(db, ["power washing"], ["McKinney, TX", "Frisco, TX", "Allen, TX"]);
  const calls = [];
  const extract = (category, area) => {
    calls.push(`${category}|${area}`);
    if (area === "Frisco, TX") {
      return { status: "blocked", checked: 0, listings: [], note: "bot check" };
    }
    return {
      status: "ok",
      checked: 2,
      without_website: 1,
      listings: [
        listing({ maps_url: `https://maps/${area}/a` }),
        listing({ maps_url: `https://maps/${area}/b`, website: "https://has-site.com" }),
      ],
    };
  };
  const settings = {
    budget: 1000,
    maxTargets: 10,
    refreshDays: 30,
    minPause: 0,
    maxPause: 0,
    dryRun: false,
  };
  const summary = await runBatch(db, settings, { extract, wait: async () => {} });
  assert.deepEqual(calls, ["power washing|McKinney, TX", "power washing|Frisco, TX"]);
  assert.equal(summary.checked, 2);
  assert.equal(summary.newLeads, 1);
  assert.equal(summary.blocked, true);
  assert.equal(summary.remainingTargets, 2, "Frisco stays pending and Allen was never reached");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 2);
  const frisco = db.prepare("SELECT * FROM targets WHERE area = 'Frisco, TX'").get();
  assert.equal(frisco.last_run_at, null);
  assert.equal(frisco.last_status, "blocked");
  db.close();
});

test("runBatch stops at the listing budget", async () => {
  const db = openDb(":memory:");
  addTargets(db, ["a", "b", "c"], ["X"]);
  let n = 0;
  const extract = () => ({
    status: "ok",
    listings: Array.from({ length: 60 }, () => listing({ maps_url: `https://maps/${(n += 1)}` })),
  });
  const settings = {
    budget: 100,
    maxTargets: 10,
    refreshDays: 30,
    minPause: 0,
    maxPause: 0,
    dryRun: false,
  };
  const summary = await runBatch(db, settings, { extract, wait: async () => {} });
  assert.equal(summary.searches, 2);
  assert.equal(summary.checked, 120);
  assert.equal(summary.stoppedBecause, "budget reached");
  assert.equal(summary.remainingTargets, 1);
  db.close();
});

test("runBatch with an empty queue reports nothing to do", async () => {
  const db = openDb(":memory:");
  const settings = {
    budget: 10,
    maxTargets: 10,
    refreshDays: 30,
    minPause: 0,
    maxPause: 0,
    dryRun: false,
  };
  const summary = await runBatch(db, settings, { extract: () => assert.fail("must not run") });
  assert.equal(summary.stoppedBecause, "no pending targets");
  assert.match(formatSummary(summary, stats(db), { leads: [] }), /Nothing to do/);
  db.close();
});

test("resolveSettings reads flags and env defaults", () => {
  const env = { PROSPECTING_DAILY_BUDGET: "250", OPENCLAW_WORKSPACE_DIR: "/w" };
  const s = resolveSettings(["--max-targets", "5", "--sheet", "abc", "--dry-run"], env);
  assert.equal(s.budget, 250);
  assert.equal(s.maxTargets, 5);
  assert.equal(s.sheetId, "abc");
  assert.equal(s.dryRun, true);
  assert.equal(
    s.dbPath,
    "/w/prospecting/leads.sqlite".replace(/\//g, s.dbPath.includes("\\") ? "\\" : "/"),
  );
  assert.equal(resolveSettings(["--budget", "1500"], env).budget, 1500);
});

test("CSV export uses the shared header and escapes cells", () => {
  const csv = leadsToCsv([
    {
      name: 'Bob "The Builder", LLC',
      category: "Contractor",
      address: "1 Main St",
      phone: "",
      rating: null,
      review_count: null,
      maps_url: "https://maps/x",
      social: "https://facebook.com/bob",
      notes: "",
      first_seen: "2026-09-08T12:00:00.000Z",
    },
  ]);
  const [header, row] = csv.trim().split("\n");
  assert.equal(
    header,
    "name,category,address,phone,rating,review_count,google_maps_url,source_id,social_or_notes,found_on",
  );
  assert.equal(
    row,
    '"Bob ""The Builder"", LLC",Contractor,1 Main St,,,,https://maps/x,maps:https://maps/x,Social: https://facebook.com/bob,2026-09-08',
  );
});

test("appendToSheet reports failures without throwing", () => {
  const lead = {
    name: "A",
    category: "",
    address: "",
    phone: "",
    maps_url: "https://maps/a",
    first_seen: "2026-09-08",
  };
  assert.equal(appendToSheet("", [lead]), "");
  const note = appendToSheet("sheet1", [lead], {
    run: () => ({ status: 1, stderr: "not authorized" }),
  });
  assert.match(note, /append failed \(not authorized\)/);
  const ok = appendToSheet("sheet1", [lead], { run: () => ({ status: 0, stderr: "" }) });
  assert.match(ok, /spreadsheets\/d\/sheet1/);
});
