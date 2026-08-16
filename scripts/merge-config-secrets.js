#!/usr/bin/env node
/*
 * Merge the mirror's private calendar URLs into a staged config.js.
 *
 * Two of the four calendars are secrets -- a Nextcloud public-share token and a
 * Jane booking token -- so the repo carries REDACTED_PRIVATE_PATH in their
 * place. deploy.sh used to rsync that file straight over the mirror's config,
 * which pointed both calendars at a 404 and took personal events off the wall
 * without logging anything. This runs on the mirror, just before install, and
 * copies the live URLs back into the staged file, matched by calendar name.
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

const staged = loadConfig(stagedPath);
if (!staged) fail(`staged config not found: ${stagedPath}`);

const stagedCalendars = calendarsOf(staged);
const redacted = stagedCalendars.filter((cal) => PLACEHOLDER.test(cal.url ?? ""));

if (redacted.length === 0) {
  console.log("    no redacted calendar urls in the staged config; nothing to merge");
  process.exit(0);
}

const live = loadConfig(livePath);

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

const unresolved = [];
const replacements = [];

for (const cal of redacted) {
  const url = liveUrls.get(cal.name);

  if (!url) {
    unresolved.push(cal.name);
    continue;
  }

  replacements.push({ name: cal.name, from: cal.url, to: url });
}

if (unresolved.length > 0) {
  fail(`no live url to restore for: ${unresolved.join(", ")}`, [
    `The mirror's ${livePath} has no usable url under those names, so a deploy`,
    "would put a placeholder on the wall. Fix the live config first -- see",
    "'Private calendar urls' in README.md -- then deploy again."
  ]);
}

let text = fs.readFileSync(stagedPath, "utf8");

for (const { name, from, to } of replacements) {
  const quoted = JSON.stringify(from);
  const occurrences = text.split(quoted).length - 1;

  // Two calendars sharing one placeholder string cannot be told apart by text.
  if (occurrences !== 1) {
    fail(`expected exactly one occurrence of the placeholder url for "${name}", found ${occurrences}`, [
      "Give each private calendar a distinct placeholder url in config/config.js."
    ]);
  }

  text = text.replace(quoted, JSON.stringify(to));
  console.log(`    ${name}: restored from the live config`);
}

fs.writeFileSync(stagedPath, text);

// Re-read from disk rather than trusting the substitution above.
delete require.cache[path.resolve(stagedPath)];
const merged = calendarsOf(loadConfig(stagedPath));
const stillRedacted = merged.filter((cal) => PLACEHOLDER.test(cal.url ?? ""));

if (stillRedacted.length > 0) {
  fail(`still redacted after merging: ${stillRedacted.map((c) => c.name).join(", ")}`);
}

const missing = merged.filter((cal) => !cal.url);
if (missing.length > 0) {
  fail(`calendar with no url after merging: ${missing.map((c) => c.name).join(", ")}`);
}
