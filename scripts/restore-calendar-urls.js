#!/usr/bin/env node
/*
 * Recover the private calendar urls from the journal.
 *
 * The Nextcloud and Jane urls only ever existed in the mirror's own config.js.
 * The repo was sanitised before it was first committed, so every copy in git --
 * including the ones under backups/ -- carries REDACTED_PRIVATE_PATH instead.
 * When a deploy shipped that file over the live config, the last surviving copy
 * of those urls was the journal, which logs them on every fetcher creation and
 * every fetch error.
 *
 * This reads them back out and prints a repaired config.js on stdout. It writes
 * nothing itself; restore-calendar-urls.sh installs the result.
 *
 * Journal retention is finite. Once the wall is working again, keep a copy of
 * /opt/MagicMirror/config/config.js somewhere that is backed up.
 *
 * Usage: node restore-calendar-urls.js [config.js] > repaired-config.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const UNIT = "magicmirror";
const PLACEHOLDER = /REDACTED_PRIVATE_PATH|CHANGEME/;
const CONFIG = process.argv[2] ?? "/opt/MagicMirror/config/config.js";

// stdout carries the repaired config, so everything else goes to stderr.
const say = (message) => process.stderr.write(`${message}\n`);

/**
 * @param {string} message what went wrong
 * @param {string[]} [detail] extra lines
 */
function fail (message, detail = []) {
  say(`restore-calendar-urls: ${message}`);
  for (const line of detail) say(`  ${line}`);
  process.exit(1);
}

/**
 * Every calendar url the journal has ever seen, oldest first.
 * @returns {string[]} urls, in the order they were logged
 */
function urlsFromJournal () {
  let out;

  try {
    out = execFileSync("journalctl", ["-u", UNIT, "--no-pager"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024
    });
  } catch (error) {
    fail(`could not read the journal: ${error.message}`);
  }

  const found = [];

  for (const line of out.split("\n")) {
    const created = line.match(/Create new calendarfetcher for url:\s+(\S+)\s+-\s+Interval/);
    if (created) {
      found.push(created[1]);
      continue;
    }

    const errored = line.match(/Could not fetch calendar:\s+(\S+)/);
    if (errored) found.push(errored[1]);
  }

  return found;
}

/**
 * @param {string} url any url
 * @returns {string|null} its hostname
 */
function hostOf (url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

if (!fs.existsSync(CONFIG)) fail(`no config at ${CONFIG}`);

const config = require(path.resolve(CONFIG));

const calendars = (config?.modules ?? [])
  .filter((mod) => mod?.module === "calendar")
  .flatMap((mod) => mod?.config?.calendars ?? []);

const broken = calendars.filter((cal) => PLACEHOLDER.test(cal.url ?? ""));

if (broken.length === 0) {
  say("No redacted calendar urls in the live config; nothing to restore.");
  process.stdout.write(fs.readFileSync(CONFIG, "utf8"));
  process.exit(0);
}

// Newest first, so the most recently seen url for a host wins.
const logged = urlsFromJournal().filter((url) => !PLACEHOLDER.test(url)).reverse();

let text = fs.readFileSync(CONFIG, "utf8");
const unresolved = [];

for (const cal of broken) {
  const host = hostOf(cal.url);

  if (!host) {
    unresolved.push(`${cal.name}: its placeholder url has no usable hostname`);
    continue;
  }

  const candidates = [...new Set(logged.filter((url) => hostOf(url) === host))];

  if (candidates.length === 0) {
    unresolved.push(`${cal.name}: the journal has no url for ${host}`);
    continue;
  }

  if (candidates.length > 1) {
    unresolved.push(
      `${cal.name}: the journal has ${candidates.length} different urls for ${host}, `
      + "so this one has to be chosen by hand"
    );
    for (const candidate of candidates) say(`    candidate: ${candidate}`);
    continue;
  }

  const quoted = JSON.stringify(cal.url);
  const occurrences = text.split(quoted).length - 1;

  if (occurrences !== 1) {
    unresolved.push(`${cal.name}: expected one occurrence of its url in the file, found ${occurrences}`);
    continue;
  }

  text = text.replace(quoted, JSON.stringify(candidates[0]));
  say(`  ${cal.name}: recovered from the journal (${host})`);
}

if (unresolved.length > 0) {
  fail("could not recover every calendar url", [
    ...unresolved,
    "",
    "Get the missing ones from the source instead: in Nextcloud, the calendar's",
    "share menu gives the public ics link. Then edit",
    `${CONFIG} by hand.`
  ]);
}

process.stdout.write(text);
