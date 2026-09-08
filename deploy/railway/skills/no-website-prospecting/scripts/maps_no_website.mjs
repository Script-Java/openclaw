#!/usr/bin/env node
// Google Maps results extractor for the no-website-prospecting skill.
//
// Usage: node maps_no_website.mjs "<category>" "<area>" [--max N] [--all] [--json]
//   --max N   stop after N listings (default 120, the practical Maps cap)
//   --all     include businesses that do have a website (default: only those without)
//   --json    machine output (default: a readable table)
//
// Opens Maps in the headless Chromium bundled with OpenClaw, scrolls the results
// feed until Maps reports the end of the list, and reads each card: name, Maps
// category label, phone, rating, review count, address, and website link. No
// API key. Google may throttle datacenter traffic; the script reports a block
// instead of retrying so the caller can fall back to another source.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name) => args.includes(name);
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const [category, area] = positional;
if (!category || !area) {
  console.error('usage: maps_no_website.mjs "<category>" "<area>" [--max N] [--all] [--json]');
  process.exit(2);
}
const maxListings = Number.parseInt(flagValue("--max", "120"), 10);
const includeWithWebsite = flag("--all");
const asJson = flag("--json");

const require = createRequire("/app/package.json");
const { chromium } = require("playwright-core");

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/home/node/.cache/ms-playwright";
  const dirs = fs.existsSync(root) ? fs.readdirSync(root) : [];
  for (const dir of dirs
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const candidate = path.join(root, dir, rel);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const query = `${category} ${area}`;
const url = `https://www.google.com/maps/search/${encodeURIComponent(query).replace(/%20/g, "+")}/?hl=en`;

const browser = await chromium.launch({
  headless: true,
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=en-US"],
});
const context = await browser.newContext({
  locale: "en-US",
  viewport: { width: 1280, height: 900 },
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
});
const page = await context.newPage();
const result = { query, url, status: "ok", checked: 0, without_website: 0, listings: [] };

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Consent interstitial (mostly EU exits): take the minimal option if shown.
  const consent = page
    .locator('button:has-text("Reject all"), button:has-text("Accept all")')
    .first();
  if (await consent.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await consent.click().catch(() => {});
  }
  const bodyText = (
    await page
      .locator("body")
      .innerText()
      .catch(() => "")
  ).slice(0, 2000);
  if (/unusual traffic|not a robot|captcha/i.test(bodyText)) {
    result.status = "blocked";
    result.note = "Google presented a bot check; try again later or use another source.";
  } else {
    const feed = page.locator('div[role="feed"]');
    await feed.first().waitFor({ timeout: 30_000 });

    let previous = -1;
    let stalls = 0;
    for (let round = 0; round < 60; round += 1) {
      const count = await page.locator('div[role="feed"] a[href*="/maps/place/"]').count();
      const ended = await page
        .locator('div[role="feed"]')
        // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Playwright locator API; rendered text is what Maps shows
        .innerText()
        .then((t) => /reached the end of the list/i.test(t))
        .catch(() => false);
      if (count >= maxListings || ended) {
        break;
      }
      stalls = count === previous ? stalls + 1 : 0;
      if (stalls >= 4) {
        break;
      }
      previous = count;
      await page.evaluate(() => {
        const el = document.querySelector('div[role="feed"]');
        if (el) {
          el.scrollTo(0, el.scrollHeight);
        }
      });
      await page.waitForTimeout(1_500);
    }

    const rows = await page.evaluate(() => {
      const seen = new Set();
      const out = [];
      const links = document.querySelectorAll('div[role="feed"] a[href*="/maps/place/"]');
      for (const link of links) {
        const card = link.closest('div[role="feed"] > div') || link.parentElement;
        if (!card) {
          continue;
        }
        const href = link.getAttribute("href") || "";
        const name = link.getAttribute("aria-label") || "";
        if (!name || seen.has(href)) {
          continue;
        }
        seen.add(href);
        const website = card.querySelector('a[data-value="Website"]');
        // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText keeps the card's visual line breaks, which the field parser relies on
        const text = card.innerText || "";
        const phone = (text.match(/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/) || [""])[0];
        const ratingEl = card.querySelector('span[role="img"][aria-label*="star"]');
        const ratingLabel = ratingEl ? ratingEl.getAttribute("aria-label") || "" : "";
        const rating = (ratingLabel.match(/([\d.]+) star/) || ["", ""])[1];
        const reviews = (ratingLabel.match(/([\d,]+) review/i) || ["", ""])[1].replace(/,/g, "");
        // Maps renders "Category · Address" (sometimes "Category · · Address")
        // on one line of the card; the category is the text before the first dot.
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const isHours = (l) => /^(Open|Closed|Opens|Closes|Temporarily|Permanently)\b/i.test(l);
        const dotted = lines.find(
          (l) =>
            l.includes("·") && !/\d{3}[ .-]\d{4}/.test(l) && !/★|stars?\b/.test(l) && !isHours(l),
        );
        let category = "";
        let address = "";
        if (dotted) {
          const parts = dotted
            .split("·")
            .map((p) => p.trim())
            .filter(Boolean);
          category = parts[0] || "";
          address = parts.slice(1).join(", ");
        }
        if (!category) {
          // Service-area businesses show the category on its own line, without an address.
          const plain = lines.find(
            (l) =>
              l !== name &&
              !/\d/.test(l) &&
              !isHours(l) &&
              !/★/.test(l) &&
              !/^No reviews/i.test(l) &&
              l.length < 45,
          );
          category = plain || "";
        }
        out.push({
          name,
          category,
          rating,
          reviews,
          phone,
          address,
          website: website ? website.getAttribute("href") || "" : "",
          maps_url: href.startsWith("http") ? href : `https://www.google.com${href}`,
        });
      }
      return out;
    });
    result.checked = rows.length;
    result.without_website = rows.filter((r) => !r.website).length;
    result.listings = includeWithWebsite ? rows : rows.filter((r) => !r.website);
  }
} catch (error) {
  result.status = "error";
  result.note = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close().catch(() => {});
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(
    `${result.status}: checked ${result.checked} listings for "${query}", ${result.without_website} without a website${result.note ? ` (${result.note})` : ""}`,
  );
  for (const r of result.listings) {
    console.log(
      `- ${r.name} | ${r.category || "no category"} | ${r.phone || "no phone"} | ${r.rating ? `${r.rating}★ (${r.reviews})` : "no rating"} | ${r.website || "NO WEBSITE"} | ${r.address}`,
    );
  }
}
process.exit(result.status === "ok" ? 0 : 1);
