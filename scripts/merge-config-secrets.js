#!/usr/bin/env node
/*
 * Merge what only the mirror knows into a staged config.js: the private
 * calendar URLs, and where the wall is.
 *
 * Two of the four calendars are secrets -- a Nextcloud public-share token and a
 * Jane booking token -- so the repo carries REDACTED_PRIVATE_PATH in their
 * place. deploy.sh used to rsync that file straight over the mirror's config,
 * which pointed both calendars at a 404 and took personal events off the wall
 * without logging anything. This runs on the mirror, just before install, and
 * copies the live URLs back into the staged file, matched by calendar name.
 *
 * The weather location is the same kind of thing. The repo's config.js carries
 * a stand-in on the lines marked `// @lat`, `// @lon` and `// @place`, because
 * the real one says where the house is, and the repo is public. Those lines get
 * the live config's own location back.
 *
 * It is deliberately loud: if any placeholder is still there afterwards it
 * exits non-zero, and deploy.sh aborts before the config is installed.
 *
 * Usage: merge-config-secrets.js <staged-config.js> <live-config.js>
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLACEHOLDER = /REDACTED_PRIVATE_PATH|CHANGEME/;

const [stagedPath, livePath] = process.argv.slice(2);

if (!stagedPath || !livePath) {
  fail("usage: merge-config-secrets.js <staged-config.js> <live-config.js>");
}

/**
 * Every entry of every `calendar` module in a MagicMirror config.
 * @param {object} cfg a loaded config object
 * @returns {object[]} the calendar entries, in config order
 */
function calendarsOf (cfg) {
  const found = [];

  for (const mod of cfg?.modules ?? []) {
    if (mod?.module !== "calendar") continue;
    for (const cal of mod?.config?.calendars ?? []) found.push(cal);
  }

  return found;
}

/**
 * @param {string} file path to a config.js
 * @returns {object|null} the config, or null if it is not there
 */
function loadConfig (file) {
  if (!fs.existsSync(file)) return null;
  return require(path.resolve(file));
}

/**
 * @param {string} message what went wrong
 * @param {string[]} [detail] extra lines, printed after the message
 */
function fail (message, detail = []) {
  console.error(`merge-config-secrets: ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
}

/*
 * The weather cards: this repo's Weather module, and MagicMirror's stock
 * weather module it replaced -- which is what a wall's live config still says
 * until the first deploy after the switch, and where its location has to be
 * read from then.
 */
const isWeather = (mod) => mod?.module === "Weather" || mod?.module === "weather";

/**
 * Where a config's weather is for: the current-conditions module's location
 * and header, or the first weather module that has one.
 * @param {object} cfg a loaded config object
 * @returns {{lat: number, lon: number, place: (string|undefined)}|null} the location, or null
 */
function locationOf (cfg) {
  const weather = (cfg?.modules ?? []).filter((mod) =>
    isWeather(mod) && Number.isFinite(mod?.config?.lat) && Number.isFinite(mod?.config?.lon));
  const current = weather.find((mod) => mod.config.type === "current") ?? weather[0];
  if (!current) return null;
  return { lat: current.config.lat, lon: current.config.lon, place: current.header };
}

const staged = loadConfig(stagedPath);
if (!staged) fail(`staged config not found: ${stagedPath}`);

const live = loadConfig(livePath);
let text = fs.readFileSync(stagedPath, "utf8");

// ---- private calendar urls -------------------------------------------------

const redacted = calendarsOf(staged).filter((cal) => PLACEHOLDER.test(cal.url ?? ""));

if (redacted.length > 0) {
  if (!live) {
    fail(`the staged config has ${redacted.length} redacted calendar url(s) and there is no live config to take them from`, [
      `looked for: ${livePath}`,
      "On a fresh mirror, install config.js by hand once with the real urls in it.",
      "Every deploy after that keeps them."
    ]);
  }

  const liveUrls = new Map(
    calendarsOf(live)
      .filter((cal) => cal.name && cal.url && !PLACEHOLDER.test(cal.url))
      .map((cal) => [cal.name, cal.url])
  );

  const unresolved = redacted.filter((cal) => !liveUrls.has(cal.name)).map((cal) => cal.name);
  if (unresolved.length > 0) {
    fail(`no live url to restore for: ${unresolved.join(", ")}`, [
      `The mirror's ${livePath} has no usable url under those names, so a deploy`,
      "would put a placeholder on the wall. Put the real urls back in the",
      "mirror's own config.js (scripts/restore-calendar-urls.js can recover them",
      "from the journal), then deploy again."
    ]);
  }

  for (const cal of redacted) {
    const quoted = JSON.stringify(cal.url);
    const occurrences = text.split(quoted).length - 1;

    // Two calendars sharing one placeholder string cannot be told apart by text.
    if (occurrences !== 1) {
      fail(`expected exactly one occurrence of the placeholder url for "${cal.name}", found ${occurrences}`, [
        "Give each private calendar a distinct placeholder url in config/config.js."
      ]);
    }

    text = text.replace(quoted, JSON.stringify(liveUrls.get(cal.name)));
    console.log(`    ${cal.name}: restored from the live config`);
  }
} else {
  console.log("    no redacted calendar urls in the staged config");
}

// ---- the wall's location ---------------------------------------------------

const LAT = /(lat: )[-0-9.]+(, \/\/ @lat)/g;
const LON = /(lon: )[-0-9.]+(, \/\/ @lon)/g;
const PLACE = /(header: )"[^"]*"(, \/\/ @place)/g;
const marked = (text.match(LAT) ?? []).length + (text.match(LON) ?? []).length;

if (marked > 0) {
  const where = locationOf(live);
  if (!where) {
    fail("the staged config's weather location is a stand-in and there is no live location to take it from", [
      `looked in: ${livePath}`,
      "Deploying would put the wrong city's weather on the wall. Set lat/lon in",
      "the mirror's own config.js first, then deploy again."
    ]);
  }
  text = text.replace(LAT, `$1${where.lat}$2`).replace(LON, `$1${where.lon}$2`);
  if (typeof where.place === "string" && where.place !== "") {
    text = text.replace(PLACE, `$1${JSON.stringify(where.place)}$2`);
  }
  console.log("    weather location: restored from the live config");
}

fs.writeFileSync(stagedPath, text);

// Re-read from disk rather than trusting the substitutions above.
// require caches by real path; resolve it, or a staged file under a symlinked
// directory (macOS's /var is /private/var) re-reads the stale copy.
delete require.cache[require.resolve(path.resolve(stagedPath))];
const merged = loadConfig(stagedPath);
const mergedCalendars = calendarsOf(merged);
const stillRedacted = mergedCalendars.filter((cal) => PLACEHOLDER.test(cal.url ?? ""));

if (stillRedacted.length > 0) {
  fail(`still redacted after merging: ${stillRedacted.map((c) => c.name).join(", ")}`);
}

const missing = mergedCalendars.filter((cal) => !cal.url);
if (missing.length > 0) {
  fail(`calendar with no url after merging: ${missing.map((c) => c.name).join(", ")}`);
}

if (marked > 0) {
  const want = locationOf(live);
  const off = (merged.modules ?? []).filter((mod) =>
    isWeather(mod) && (mod.config?.lat !== want.lat || mod.config?.lon !== want.lon));
  if (off.length > 0) {
    fail(`${off.length} weather module(s) still not at the live location after merging`);
  }
}
