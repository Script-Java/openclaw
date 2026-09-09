#!/usr/bin/env node
// SQLite lead store for the no-website-prospecting skill.
//
// One database on the Railway volume keeps every business the batch runner has
// looked at, the search queue (category x area "targets"), and run history, so
// nightly runs never list a business twice and the agent can answer questions
// with SQL instead of re-reading CSV files.
//
// Usage (CLI):
//   leads_db.mjs init
//   leads_db.mjs targets add "<category>" "<area>"
//   leads_db.mjs targets add-many --categories "a,b,c" --areas "x,y"
//   leads_db.mjs targets list [--all] [--json]
//   leads_db.mjs targets enable <id> | disable <id>
//   leads_db.mjs stats [--json]
//   leads_db.mjs leads [--area A] [--category C] [--since YYYY-MM-DD] [--status new]
//                      [--limit N] [--csv | --json]
//   leads_db.mjs export <file.csv> [same filters as leads]
//   leads_db.mjs mark <maps_url> <new|contacted|not_interested|won|skip> [note]
//   leads_db.mjs sql "<SELECT ...>" [--json]       (read-only)
//
// The database path is $PROSPECTING_DB, else <workspace>/prospecting/leads.sqlite.
// Requires Node 22.13+ (node:sqlite); the OpenClaw image ships Node 24.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const LEAD_STATUSES = ["new", "contacted", "not_interested", "won", "skip"];
export const CSV_HEADER =
  "name,category,address,phone,rating,review_count,google_maps_url,source_id,social_or_notes,found_on";

const SOCIAL_HOSTS =
  /(^|\.)(facebook\.com|fb\.com|instagram\.com|linktr\.ee|tiktok\.com|yelp\.com|nextdoor\.com|linkedin\.com|x\.com|twitter\.com|youtube\.com|pinterest\.com|thumbtack\.com|angi\.com|homeadvisor\.com|business\.site)$/i;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  maps_url TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  rating REAL,
  review_count INTEGER,
  website TEXT NOT NULL DEFAULT '',
  has_website INTEGER NOT NULL DEFAULT 0,
  social TEXT NOT NULL DEFAULT '',
  search_category TEXT NOT NULL DEFAULT '',
  search_area TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS businesses_lead_idx ON businesses (has_website, status, first_seen);
CREATE INDEX IF NOT EXISTS businesses_area_idx ON businesses (search_area, search_category);
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  area TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  last_checked INTEGER,
  last_new_leads INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category, area)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  target_id INTEGER,
  category TEXT NOT NULL,
  area TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  without_website INTEGER NOT NULL DEFAULT 0,
  new_leads INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS runs_batch_idx ON runs (batch_id);
`;

export function defaultDbPath(env = process.env) {
  if (env.PROSPECTING_DB) {
    return env.PROSPECTING_DB;
  }
  return path.join(env.OPENCLAW_WORKSPACE_DIR || "/data/workspace", "prospecting", "leads.sqlite");
}

export function openDb(dbPath = defaultDbPath(), { readOnly = false } = {}) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!readOnly) {
    if (dbPath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec(SCHEMA);
  }
  return db;
}

// A Facebook page or a directory profile is not a website of the business's
// own; those listings stay leads and the link is kept as a note.
export function classifyWebsite(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) {
    return { hasWebsite: false, social: "" };
  }
  let host;
  try {
    host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { hasWebsite: true, social: "" };
  }
  if (SOCIAL_HOSTS.test(host)) {
    return { hasWebsite: false, social: trimmed };
  }
  return { hasWebsite: true, social: "" };
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Records one listing from maps_no_website.mjs. Returns "inserted" or "updated"
// plus whether the row is a lead (no real website) after the write.
export function upsertListing(db, listing, { searchCategory, searchArea, seenAt }) {
  const mapsUrl = listing.maps_url;
  if (!mapsUrl || !listing.name) {
    return { outcome: "skipped", isLead: false };
  }
  const { hasWebsite, social } = classifyWebsite(listing.website);
  const existing = db.prepare("SELECT maps_url FROM businesses WHERE maps_url = ?").get(mapsUrl);
  const row = {
    maps_url: mapsUrl,
    name: listing.name,
    category: listing.category || "",
    address: listing.address || "",
    phone: listing.phone || "",
    rating: toNumber(listing.rating),
    review_count: toNumber(listing.reviews ?? listing.review_count),
    website: listing.website || "",
    has_website: hasWebsite ? 1 : 0,
    social,
    search_category: searchCategory,
    search_area: searchArea,
    seen_at: seenAt,
  };
  if (existing) {
    // node:sqlite rejects named parameters the statement does not use.
    const { search_category: _sc, search_area: _sa, ...update } = row;
    db.prepare(
      `UPDATE businesses SET name = @name, category = @category, address = @address,
         phone = @phone, rating = @rating, review_count = @review_count, website = @website,
         has_website = @has_website, social = @social, last_seen = @seen_at
       WHERE maps_url = @maps_url`,
    ).run(update);
    return { outcome: "updated", isLead: !hasWebsite };
  }
  db.prepare(
    `INSERT INTO businesses (maps_url, name, category, address, phone, rating, review_count,
       website, has_website, social, search_category, search_area, first_seen, last_seen)
     VALUES (@maps_url, @name, @category, @address, @phone, @rating, @review_count, @website,
       @has_website, @social, @search_category, @search_area, @seen_at, @seen_at)`,
  ).run(row);
  return { outcome: "inserted", isLead: !hasWebsite };
}

export function addTargets(db, categories, areas) {
  const insert = db.prepare("INSERT OR IGNORE INTO targets (category, area) VALUES (?, ?)");
  let added = 0;
  for (const category of categories) {
    for (const area of areas) {
      const c = category.trim();
      const a = area.trim();
      if (c && a && insert.run(c, a).changes > 0) {
        added += 1;
      }
    }
  }
  return added;
}

// Targets that have never run come first, then the ones that ran longest ago.
// A target that ran within refreshDays is skipped, so a fully refreshed queue
// yields nothing until the window passes.
export function pickTargets(db, { limit = 50, refreshDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - refreshDays * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT * FROM targets
       WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at < ?)
       ORDER BY last_run_at IS NOT NULL, last_run_at ASC, id ASC
       LIMIT ?`,
    )
    .all(cutoff, limit);
}

// advance=false records the attempt without moving last_run_at, so a blocked
// or failed target is retried in the next batch.
export function recordTargetRun(
  db,
  targetId,
  { status, checked, newLeads, ranAt, advance = true },
) {
  if (advance) {
    db.prepare(
      `UPDATE targets SET last_status = ?, last_checked = ?, last_new_leads = ?,
         run_count = run_count + 1, last_run_at = ? WHERE id = ?`,
    ).run(status, checked, newLeads, ranAt, targetId);
    return;
  }
  db.prepare(
    `UPDATE targets SET last_status = ?, last_checked = ?, last_new_leads = ?,
       run_count = run_count + 1 WHERE id = ?`,
  ).run(status, checked, newLeads, targetId);
}

export function recordRun(db, run) {
  db.prepare(
    `INSERT INTO runs (batch_id, target_id, category, area, started_at, finished_at, status,
       checked, without_website, new_leads, note)
     VALUES (@batch_id, @target_id, @category, @area, @started_at, @finished_at, @status,
       @checked, @without_website, @new_leads, @note)`,
  ).run({
    batch_id: run.batchId,
    target_id: run.targetId ?? null,
    category: run.category,
    area: run.area,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    status: run.status,
    checked: run.checked ?? 0,
    without_website: run.withoutWebsite ?? 0,
    new_leads: run.newLeads ?? 0,
    note: run.note ?? "",
  });
}

function leadFilters({ area, category, since, status } = {}) {
  const where = ["b.has_website = 0"];
  const params = [];
  if (area) {
    where.push("(b.search_area LIKE ? OR b.address LIKE ?)");
    params.push(`%${area}%`, `%${area}%`);
  }
  if (category) {
    where.push("(b.search_category LIKE ? OR b.category LIKE ?)");
    params.push(`%${category}%`, `%${category}%`);
  }
  if (since) {
    where.push("b.first_seen >= ?");
    params.push(since);
  }
  if (status) {
    where.push("b.status = ?");
    params.push(status);
  }
  return { where: where.join(" AND "), params };
}

export function listLeads(db, filters = {}) {
  const { where, params } = leadFilters(filters);
  const limit = Number.isFinite(filters.limit) ? filters.limit : 500;
  return db
    .prepare(
      `SELECT b.* FROM businesses b WHERE ${where} ORDER BY b.first_seen DESC, b.name ASC LIMIT ?`,
    )
    .all(...params, limit);
}

export function stats(db, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const lastRun = one("SELECT finished_at, batch_id FROM runs ORDER BY finished_at DESC LIMIT 1");
  return {
    businesses: one("SELECT COUNT(*) AS n FROM businesses").n,
    leads: one("SELECT COUNT(*) AS n FROM businesses WHERE has_website = 0").n,
    leads_today: one(
      "SELECT COUNT(*) AS n FROM businesses WHERE has_website = 0 AND first_seen >= ?",
      today,
    ).n,
    uncontacted_leads: one(
      "SELECT COUNT(*) AS n FROM businesses WHERE has_website = 0 AND status = 'new'",
    ).n,
    targets_enabled: one("SELECT COUNT(*) AS n FROM targets WHERE enabled = 1").n,
    targets_never_run: one(
      "SELECT COUNT(*) AS n FROM targets WHERE enabled = 1 AND last_run_at IS NULL",
    ).n,
    last_run_at: lastRun ? lastRun.finished_at : null,
    last_batch_id: lastRun ? lastRun.batch_id : null,
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadToCsvRow(lead) {
  const notes = [lead.social ? `Social: ${lead.social}` : "", lead.notes || ""]
    .filter(Boolean)
    .join("; ");
  return [
    lead.name,
    lead.category,
    lead.address,
    lead.phone,
    lead.rating ?? "",
    lead.review_count ?? "",
    lead.maps_url,
    `maps:${lead.maps_url}`,
    notes,
    (lead.first_seen || "").slice(0, 10),
  ];
}

export function leadsToCsv(leads) {
  const lines = [CSV_HEADER, ...leads.map((l) => leadToCsvRow(l).map(csvCell).join(","))];
  return `${lines.join("\n")}\n`;
}

// ---- CLI -------------------------------------------------------------------

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const keys = Object.keys(rows[0]);
  console.log(keys.join(" | "));
  for (const row of rows) {
    console.log(
      keys.map((k) => (row[k] === null || row[k] === undefined ? "" : String(row[k]))).join(" | "),
    );
  }
}

function usage() {
  console.error(
    [
      "usage: leads_db.mjs <command>",
      "  init | stats [--json]",
      "  targets add <category> <area> | targets add-many --categories a,b --areas x,y",
      "  targets list [--all] [--json] | targets enable <id> | targets disable <id>",
      "  leads [--area A] [--category C] [--since YYYY-MM-DD] [--status S] [--limit N] [--csv|--json]",
      '  export <file.csv> [filters] | mark <maps_url> <status> [note] | sql "SELECT ..." [--json]',
    ].join("\n"),
  );
  return 2;
}

function runTargets(db, rest, options) {
  const [sub, a, b] = rest;
  if (sub === "add" && a && b) {
    console.log(`added ${addTargets(db, [a], [b])} target(s)`);
    return 0;
  }
  if (sub === "add-many" && options.categories && options.areas) {
    const added = addTargets(
      db,
      String(options.categories).split(","),
      String(options.areas).split(","),
    );
    console.log(`added ${added} target(s)`);
    return 0;
  }
  if (sub === "list") {
    const rows = db
      .prepare(`SELECT * FROM targets ${options.all ? "" : "WHERE enabled = 1"} ORDER BY id`)
      .all();
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      printTable(rows);
    }
    return 0;
  }
  if ((sub === "enable" || sub === "disable") && a) {
    const r = db
      .prepare("UPDATE targets SET enabled = ? WHERE id = ?")
      .run(sub === "enable" ? 1 : 0, Number(a));
    console.log(r.changes ? `${sub}d target ${a}` : `no target with id ${a}`);
    return 0;
  }
  return usage();
}

export function runCli(argv, { dbPath = defaultDbPath() } = {}) {
  const { positional, options } = parseArgs(argv);
  const [command, ...rest] = positional;
  const filters = {
    area: options.area,
    category: options.category,
    since: options.since,
    status: options.status,
    limit: options.limit ? Number.parseInt(options.limit, 10) : undefined,
  };
  switch (command) {
    case "init": {
      openDb(dbPath).close();
      console.log(`ok: ${dbPath}`);
      return 0;
    }
    case "stats": {
      const db = openDb(dbPath);
      const s = stats(db);
      db.close();
      console.log(
        options.json
          ? JSON.stringify(s, null, 2)
          : Object.entries(s)
              .map(([k, v]) => `${k}: ${v ?? "-"}`)
              .join("\n"),
      );
      return 0;
    }
    case "targets": {
      const db = openDb(dbPath);
      try {
        return runTargets(db, rest, options);
      } finally {
        db.close();
      }
    }
    case "leads": {
      const db = openDb(dbPath, { readOnly: true });
      const rows = listLeads(db, filters);
      db.close();
      if (options.csv) {
        process.stdout.write(leadsToCsv(rows));
      } else if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else {
        printTable(
          rows.map((r) => ({
            name: r.name,
            category: r.category,
            phone: r.phone,
            area: r.search_area,
            status: r.status,
            maps_url: r.maps_url,
          })),
        );
      }
      return 0;
    }
    case "export": {
      const [file] = rest;
      if (!file) {
        return usage();
      }
      const db = openDb(dbPath, { readOnly: true });
      const rows = listLeads(db, { ...filters, limit: filters.limit ?? 100_000 });
      db.close();
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, leadsToCsv(rows));
      console.log(`wrote ${rows.length} lead(s) to ${file}`);
      return 0;
    }
    case "mark": {
      const [mapsUrl, status, ...noteParts] = rest;
      if (!mapsUrl || !LEAD_STATUSES.includes(status)) {
        return usage();
      }
      const note = noteParts.join(" ");
      const db = openDb(dbPath);
      const r = db
        .prepare(
          "UPDATE businesses SET status = ?, notes = CASE WHEN ? = '' THEN notes ELSE ? END WHERE maps_url = ?",
        )
        .run(status, note, note, mapsUrl);
      db.close();
      console.log(r.changes ? `marked ${status}` : "no business with that maps_url");
      return r.changes ? 0 : 1;
    }
    case "sql": {
      const [query] = rest;
      if (!query || !/^\s*(select|with|explain)\b/i.test(query)) {
        console.error("sql: only SELECT / WITH queries are allowed");
        return 2;
      }
      const db = openDb(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(query).all();
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          printTable(rows);
        }
        return 0;
      } finally {
        db.close();
      }
    }
    default:
      return usage();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
