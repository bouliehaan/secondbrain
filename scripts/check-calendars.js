#!/usr/bin/env node
/*
 * Is the wall's calendar actually syncing?
 *
 * Runs on the mirror. Answers the question that took a missed appointment to
 * notice, because both ways this has failed were silent:
 *
 *   1. A deploy overwrote config.js with the repo's redacted copy, pointing the
 *      Nextcloud and Jane calendars at a 404. Nothing in the log said so.
 *   2. The stock calendar module registers its fetchers when the *page* loads.
 *      Restarting magicmirror without reloading the kiosk browser leaves a
 *      server with no fetchers at all -- no fetches, no errors, no clue, and a
 *      month grid frozen at whatever it last drew.
 *
 * Checked here in that order: the urls are real, they fetch, and something is
 * actually fetching them.
 *
 * Usage: node check-calendars.js [--show-urls] [config.js]
 * Exits non-zero if the wall is not syncing.
 *
 * The config argument is for checking a candidate before installing it; by
 * default it reads the one the mirror is running.
 */

"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DEFAULT_CONFIG = "/opt/MagicMirror/config/config.js";
const NODE_ICAL = "/opt/MagicMirror/node_modules/node-ical";
const KIOSK_LAUNCHER = "/usr/local/bin/calendar-kiosk";

const CONFIG = process.argv.slice(2).find((arg) => !arg.startsWith("--") && arg !== "-")
  ?? DEFAULT_CONFIG;
const UNIT = "magicmirror";
const PLACEHOLDER = /REDACTED_PRIVATE_PATH|CHANGEME/;
const FETCH_TIMEOUT_MS = 20000;

const showUrls = process.argv.includes("--show-urls");

// Optional: without it the fetch check still works, it just cannot say what is
// in the feed.
let ical = null;
try {
  ical = require(NODE_ICAL);
} catch {
  ical = null;
}

/**
 * Hide the path of a private calendar url unless --show-urls was passed.
 * @param {string} url the calendar url
 * @returns {string} the url, with its path masked
 */
function display (url) {
  if (showUrls) return url;

  try {
    const parsed = new URL(url);
    return `${parsed.origin}/…`;
  } catch {
    return url;
  }
}

/**
 * Mask every url inside a line of free text, so journal lines can be printed.
 * @param {string} line arbitrary text
 * @returns {string} the text with its urls masked
 */
function maskUrls (line) {
  if (showUrls) return line;
  return line.replace(/https?:\/\/\S+/g, (url) => display(url));
}

/**
 * @param {string[]} args extra arguments to journalctl
 * @returns {string[]} matching lines, oldest first
 */
function journal (args) {
  try {
    return execFileSync("journalctl", ["-u", UNIT, "--no-pager", "-o", "short-iso", ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string[]} lines journal lines in short-iso form
 * @param {string} needle substring to match
 * @returns {Date|null} timestamp of the last matching line
 */
function lastTimestamp (lines, needle) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes(needle)) continue;

    const when = new Date(lines[i].split(" ")[0]);
    if (!Number.isNaN(when.getTime())) return when;
  }

  return null;
}

/**
 * The timezone the wall renders in.
 *
 * Not the machine's: the box is Etc/UTC, and only calendar-kiosk's `export TZ`
 * makes the display show Mountain time. Read it from there, or every time
 * printed below is six hours out from what is actually on the wall.
 *
 * @returns {string} an IANA timezone name
 */
function wallTimezone () {
  try {
    const match = fs.readFileSync(KIOSK_LAUNCHER, "utf8").match(/^\s*export\s+TZ=["']?([^"'\s]+)/m);
    if (match) return match[1];
  } catch {
    // Not on the mirror, or the launcher moved.
  }

  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const TZ = wallTimezone();

/**
 * The wall's date for an instant, as YYYY-MM-DD.
 * @param {Date|string|number} at the instant
 * @returns {string} the calendar date on the wall
 */
function localDate (at) {
  return new Date(at).toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * @param {Date|string|number} at the instant
 * @returns {string} time of day on the wall, e.g. "11:00 AM"
 */
function localTime (at) {
  return new Date(at).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit"
  });
}

/**
 * Everything in an ics feed that lands on today, in the mirror's timezone.
 *
 * Times here are nothing like plain: today's 11am entry arrives as
 * DTSTART;TZID=US/Eastern:20260806T130000, and half the day is RRULE
 * occurrences whose VEVENT starts months ago. Both are why this uses
 * MagicMirror's own ics parser rather than reading DTSTART digits.
 *
 * @param {string} text the raw ics
 * @returns {{at: Date, summary: string, recurring: boolean}[]} today's events
 */
function eventsToday (text) {
  const today = localDate(Date.now());

  // A window either side of now, so an occurrence cannot fall off a timezone
  // edge. Occurrences are filtered to the local date afterwards.
  const from = new Date(Date.now() - 36 * 3600 * 1000);
  const to = new Date(Date.now() + 36 * 3600 * 1000);

  const found = [];
  const parsed = ical.sync.parseICS(text);

  for (const key of Object.keys(parsed)) {
    const event = parsed[key];
    if (event?.type !== "VEVENT") continue;

    const summary = String(event.summary ?? "(no title)").slice(0, 55);

    if (event.rrule) {
      const excluded = new Set(Object.values(event.exdate ?? {}).map(localDate));

      let occurrences = [];
      try {
        occurrences = event.rrule.between(from, to, true);
      } catch {
        continue;
      }

      for (const occurrence of occurrences) {
        if (localDate(occurrence) !== today) continue;
        if (excluded.has(localDate(occurrence))) continue;
        found.push({ at: new Date(occurrence), summary, recurring: true });
      }

      continue;
    }

    if (event.start && localDate(event.start) === today) {
      found.push({ at: new Date(event.start), summary, recurring: false });
    }
  }

  return found;
}

/**
 * @param {Date} when a moment in the past
 * @returns {string} e.g. "6d 2h ago"
 */
function ago (when) {
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  return `${minutes}m ago`;
}

/**
 * @returns {Promise<number>} process exit code
 */
async function main () {
  const problems = [];

  // -------------------------------------------------------------------------
  // 1. The urls the mirror is actually configured with
  // -------------------------------------------------------------------------
  if (!fs.existsSync(CONFIG)) {
    console.error(`No config at ${CONFIG}`);
    return 1;
  }

  const config = require(CONFIG);

  const calendars = (config?.modules ?? [])
    .filter((mod) => mod?.module === "calendar")
    .flatMap((mod) => mod?.config?.calendars ?? []);

  if (calendars.length === 0) {
    console.error("The config declares no calendars at all.");
    return 1;
  }

  console.log("Calendars in the deployed config:");

  for (const cal of calendars) {
    const url = cal.url ?? "";
    const name = String(cal.name ?? "(unnamed)").padEnd(14);

    if (!url) {
      console.log(`  ${name} NO URL`);
      problems.push(`${cal.name}: no url`);
    } else if (PLACEHOLDER.test(url)) {
      console.log(`  ${name} REDACTED PLACEHOLDER — ${display(url)}`);
      problems.push(`${cal.name}: url is a placeholder, so it can only 404`);
    } else {
      console.log(`  ${name} ${display(url)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Do they fetch?
  // -------------------------------------------------------------------------
  console.log("\nFetching each one:");

  const today = [];

  for (const cal of calendars) {
    if (!cal.url) continue;

    let status;

    try {
      const response = await fetch(cal.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });

      status = `HTTP ${response.status}`;

      if (!response.ok) {
        problems.push(`${cal.name}: ${status}`);
      } else if (ical) {
        const events = eventsToday(await response.text());
        status += `, ${events.length} event(s) today`;
        today.push(...events.map((event) => ({ ...event, calendar: cal.name })));
      }
    } catch (error) {
      status = `failed — ${error.message}`;
      problems.push(`${cal.name}: ${status}`);
    }

    console.log(`  ${String(cal.name).padEnd(14)} ${status}`);
  }

  // What the wall ought to be showing right now. Comparing this against the
  // wall is the whole point: everything above can pass while the display sits
  // on week-old data.
  if (ical) {
    console.log(`\nToday (${localDate(Date.now())}, ${TZ}), from those feeds:`);

    if (today.length === 0) {
      console.log("  nothing");
    } else {
      today
        .sort((a, b) => a.at - b.at)
        .forEach((event) => {
          const mark = event.recurring ? " (recurring)" : "";
          console.log(
            `  ${localTime(event.at).padStart(8)}  ${event.calendar.padEnd(13)} ${event.summary}${mark}`
          );
        });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Is anything fetching them? Fetchers are registered by the browser at
  //    page load, so a server that restarted after the kiosk did has none.
  // -------------------------------------------------------------------------
  const lines = journal([]);
  const lastStart = lastTimestamp(lines, "Starting MagicMirror: v");
  const lastFetcher = lastTimestamp(lines, "Create new calendarfetcher");

  console.log("\nFetcher registration:");

  if (!lastStart) {
    console.log("  magicmirror has not started within the journal's retention");
  } else {
    console.log(`  server started            ${ago(lastStart)}`);
    console.log(`  fetchers last registered  ${lastFetcher ? ago(lastFetcher) : "never"}`);

    if (!lastFetcher || lastFetcher < lastStart) {
      console.log("  → no fetchers on this server process: nothing is being fetched");
      problems.push(
        "the kiosk browser predates the running server, so the calendar module "
        + "never registered its fetchers — reload the browser"
      );
    }
  }

  const recentErrors = journal(["--since", "-1h"]).filter((line) => line.includes("Calendar Error"));

  if (recentErrors.length > 0) {
    console.log(`\n${recentErrors.length} calendar error(s) in the last hour, most recent:`);
    console.log(`  ${maskUrls(recentErrors.at(-1))}`);
  }

  // -------------------------------------------------------------------------
  console.log("");

  if (problems.length > 0) {
    console.log("NOT SYNCING:");
    for (const problem of problems) console.log(`  - ${problem}`);
    return 1;
  }

  console.log("Calendar sync looks healthy.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
