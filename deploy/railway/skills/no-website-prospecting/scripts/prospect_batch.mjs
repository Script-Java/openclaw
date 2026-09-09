#!/usr/bin/env node
// Unattended prospecting batch for the no-website-prospecting skill.
//
// Works through the target queue in leads.sqlite (see leads_db.mjs): for each
// pending "<category> in <area>" search it runs maps_no_website.mjs, records
// every listing in the database (new businesses without a real website become
// leads), and stops once it has checked --budget listings, run out of targets,
// or Google blocked the browser. It then writes the batch's new leads to a CSV,
// optionally appends them to a Google Sheet through gog, and prints a short
// summary. The summary is the only stdout, so an OpenClaw command automation
// can deliver it straight to Telegram.
//
// Usage: prospect_batch.mjs [--budget 1000] [--max-targets 40] [--refresh-days 30]
//                           [--min-pause 15] [--max-pause 45] [--sheet <sheetId>]
//                           [--dry-run] [--json]
//
// Exit codes: 0 when at least one search completed or there was nothing to do;
// 1 when every attempted search failed or was blocked (so failure alerts fire).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultDbPath,
  leadToCsvRow,
  leadsToCsv,
  listLeads,
  openDb,
  parseArgs,
  pickTargets,
  recordRun,
  recordTargetRun,
  stats,
  upsertListing,
} from "./leads_db.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR = path.join(HERE, "maps_no_website.mjs");

function intOption(options, name, fallback) {
  const raw = options[name];
  if (raw === undefined || raw === true) {
    return fallback;
  }
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveSettings(argv, env = process.env) {
  const { options } = parseArgs(argv);
  return {
    budget: intOption(
      options,
      "budget",
      Number.parseInt(env.PROSPECTING_DAILY_BUDGET || "1000", 10),
    ),
    maxTargets: intOption(options, "max-targets", 40),
    refreshDays: intOption(options, "refresh-days", 30),
    minPause: intOption(options, "min-pause", 15),
    maxPause: intOption(options, "max-pause", 45),
    sheetId: typeof options.sheet === "string" ? options.sheet : env.PROSPECTING_SHEET_ID || "",
    dryRun: options["dry-run"] === true,
    json: options.json === true,
    dbPath: defaultDbPath(env),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function extractListings(
  category,
  area,
  { extractor = EXTRACTOR, timeoutMs = 300_000 } = {},
) {
  const proc = spawnSync(process.execPath, [extractor, category, area, "--all", "--json"], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = proc.stdout || "";
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(jsonStart));
      if (parsed && typeof parsed.status === "string") {
        return parsed;
      }
    } catch {
      // fall through to the error below
    }
  }
  const reason = proc.error
    ? proc.error.message
    : (proc.stderr || "").trim().split("\n").slice(-3).join(" ") || `exit ${proc.status}`;
  return { status: "error", checked: 0, listings: [], note: reason.slice(0, 300) };
}

// Runs the queue. `extract` is injectable for tests.
export async function runBatch(
  db,
  settings,
  { extract = extractListings, log = () => {}, wait = sleep } = {},
) {
  const batchId = `batch-${nowIso().replace(/[:.]/g, "-")}`;
  const summary = {
    batchId,
    startedAt: nowIso(),
    checked: 0,
    searches: 0,
    newBusinesses: 0,
    newLeads: 0,
    blocked: false,
    errors: 0,
    stoppedBecause: "",
    targetsRun: [],
    remainingTargets: 0,
  };
  const targets = pickTargets(db, {
    limit: settings.maxTargets,
    refreshDays: settings.refreshDays,
  });
  if (targets.length === 0) {
    summary.stoppedBecause = "no pending targets";
    summary.finishedAt = nowIso();
    return summary;
  }
  let consecutiveErrors = 0;
  for (const [index, target] of targets.entries()) {
    if (summary.checked >= settings.budget) {
      summary.stoppedBecause = "budget reached";
      break;
    }
    if (settings.dryRun) {
      summary.targetsRun.push({ category: target.category, area: target.area, status: "dry-run" });
      continue;
    }
    const startedAt = nowIso();
    log(`search ${index + 1}/${targets.length}: ${target.category} in ${target.area}`);
    const result = extract(target.category, target.area);
    const finishedAt = nowIso();
    const entry = {
      category: target.category,
      area: target.area,
      status: result.status,
      checked: 0,
      newLeads: 0,
    };
    if (result.status === "ok") {
      consecutiveErrors = 0;
      db.exec("BEGIN");
      try {
        for (const listing of result.listings || []) {
          const { outcome, isLead } = upsertListing(db, listing, {
            searchCategory: target.category,
            searchArea: target.area,
            seenAt: finishedAt,
          });
          if (outcome === "inserted") {
            summary.newBusinesses += 1;
            if (isLead) {
              entry.newLeads += 1;
            }
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      entry.checked = (result.listings || []).length;
      summary.checked += entry.checked;
      summary.newLeads += entry.newLeads;
      summary.searches += 1;
      recordTargetRun(db, target.id, {
        status: "ok",
        checked: entry.checked,
        newLeads: entry.newLeads,
        ranAt: finishedAt,
      });
    } else {
      entry.note = result.note || "";
      recordTargetRun(db, target.id, {
        status: result.status,
        checked: 0,
        newLeads: 0,
        ranAt: finishedAt,
        advance: false,
      });
      summary.errors += 1;
    }
    recordRun(db, {
      batchId,
      targetId: target.id,
      category: target.category,
      area: target.area,
      startedAt,
      finishedAt,
      status: result.status,
      checked: entry.checked,
      withoutWebsite: result.without_website ?? 0,
      newLeads: entry.newLeads,
      note: result.note || "",
    });
    summary.targetsRun.push(entry);
    log(`  -> ${result.status}: ${entry.checked} checked, ${entry.newLeads} new leads`);
    if (result.status === "blocked") {
      summary.blocked = true;
      summary.stoppedBecause = "Google blocked the browser";
      break;
    }
    if (result.status !== "ok") {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        summary.stoppedBecause = "three searches in a row failed";
        break;
      }
    }
    const isLast = index === targets.length - 1;
    if (!isLast && summary.checked < settings.budget) {
      const span = Math.max(0, settings.maxPause - settings.minPause);
      const pauseSeconds = settings.minPause + Math.floor(Math.random() * (span + 1));
      await wait(pauseSeconds * 1000);
    }
  }
  if (!summary.stoppedBecause) {
    summary.stoppedBecause = settings.dryRun ? "dry run" : "queue drained for this run";
  }
  summary.remainingTargets = pickTargets(db, {
    limit: 100_000,
    refreshDays: settings.refreshDays,
  }).length;
  summary.finishedAt = nowIso();
  return summary;
}

export function newLeadsForBatch(db, summary) {
  return listLeads(db, { since: summary.startedAt, limit: 100_000 }).filter(
    (lead) => lead.first_seen <= summary.finishedAt,
  );
}

export function writeBatchCsv(leads, exportsDir, date = new Date()) {
  fs.mkdirSync(exportsDir, { recursive: true });
  const file = path.join(exportsDir, `${date.toISOString().slice(0, 10)}-new-leads.csv`);
  fs.writeFileSync(file, leadsToCsv(leads));
  return file;
}

// Appends the batch's leads to a Google Sheet through gog when it is installed
// and authorized. Returns a note for the summary; never throws.
export function appendToSheet(sheetId, leads, { run = spawnSync } = {}) {
  if (!sheetId || leads.length === 0) {
    return "";
  }
  const chunks = [];
  for (let i = 0; i < leads.length; i += 200) {
    chunks.push(leads.slice(i, i + 200).map((lead) => leadToCsvRow(lead).map(String)));
  }
  for (const chunk of chunks) {
    const proc = run(
      "gog",
      [
        "sheets",
        "append",
        sheetId,
        "Sheet1!A:J",
        "--values-json",
        JSON.stringify(chunk),
        "--insert",
        "INSERT_ROWS",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (proc.error || proc.status !== 0) {
      const reason = proc.error
        ? proc.error.message
        : (proc.stderr || "").trim().split("\n").pop() || `exit ${proc.status}`;
      return `Google Sheet append failed (${reason.slice(0, 160)}); the CSV has every row.`;
    }
  }
  return `Also appended to Google Sheet https://docs.google.com/spreadsheets/d/${sheetId}`;
}

export function formatSummary(summary, dbStats, { csvFile, sheetNote, leads, date = new Date() }) {
  const areas = [...new Set(summary.targetsRun.map((t) => t.area))];
  const lines = [`Daily prospecting, ${date.toISOString().slice(0, 10)}`];
  if (summary.stoppedBecause === "no pending targets") {
    lines.push(
      "Nothing to do: every target was searched within the refresh window.",
      "Add more categories or areas to the queue to keep collecting.",
    );
    return lines.join("\n");
  }
  lines.push(
    `Checked ${summary.checked} businesses in ${summary.searches} searches` +
      (areas.length ? ` (${areas.slice(0, 6).join(", ")}${areas.length > 6 ? ", ..." : ""})` : "") +
      ".",
    `New leads without a website: ${summary.newLeads} (database total: ${dbStats.leads}, still uncontacted: ${dbStats.uncontacted_leads}).`,
  );
  const top = leads.slice(0, 5);
  if (top.length > 0) {
    lines.push("Sample of the new leads:");
    for (const lead of top) {
      lines.push(
        `- ${lead.name} | ${lead.category || "?"} | ${lead.phone || "no phone"} | ${lead.search_area}`,
      );
    }
  }
  if (csvFile) {
    lines.push(`CSV: ${csvFile}`);
  }
  if (sheetNote) {
    lines.push(sheetNote);
  }
  if (summary.blocked) {
    lines.push("Google blocked the browser part-way; the remaining searches continue tomorrow.");
  } else if (summary.errors > 0) {
    lines.push(`${summary.errors} search(es) failed and will be retried tomorrow.`);
  }
  lines.push(`Queue: ${summary.remainingTargets} target searches still pending.`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const settings = resolveSettings(argv, env);
  const workspace = path.dirname(path.dirname(settings.dbPath));
  const prospectingDir = path.dirname(settings.dbPath);
  fs.mkdirSync(prospectingDir, { recursive: true });
  const logFile = path.join(prospectingDir, "batch.log");
  const log = (line) => {
    fs.appendFileSync(logFile, `${nowIso()} ${line}\n`);
  };
  log(
    `start budget=${settings.budget} maxTargets=${settings.maxTargets} dryRun=${settings.dryRun}`,
  );

  const db = openDb(settings.dbPath);
  let summary;
  try {
    summary = await runBatch(db, settings, { log });
    const leads = settings.dryRun ? [] : newLeadsForBatch(db, summary);
    const csvFile =
      leads.length > 0 ? writeBatchCsv(leads, path.join(prospectingDir, "exports")) : "";
    const sheetNote = settings.dryRun ? "" : appendToSheet(settings.sheetId, leads);
    const dbStats = stats(db);
    log(
      `done: ${summary.checked} checked, ${summary.newLeads} new leads (${summary.stoppedBecause})`,
    );
    if (settings.json) {
      console.log(
        JSON.stringify({ ...summary, csvFile, sheetNote, stats: dbStats, workspace }, null, 2),
      );
    } else {
      console.log(formatSummary(summary, dbStats, { csvFile, sheetNote, leads }));
    }
  } finally {
    db.close();
  }
  const attempted = summary.targetsRun.filter((t) => t.status !== "dry-run").length;
  return attempted > 0 && summary.searches === 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.log(
        `Daily prospecting failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
