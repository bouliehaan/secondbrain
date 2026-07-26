#!/usr/bin/env node
"use strict";

/*
 * Run one full poll locally and print what the mirror would display.
 *
 * This replaces the three ad-hoc scripts that used to sit in the repo root
 * (debug_poll.js, test_proton.js, check_proton.js), each with a different
 * hardcoded config path.
 *
 *   node scripts/dev-poll.js <configDir> [--state <dir>] [--json] [--twice]
 *
 * <configDir> holds the real gmail/, proton/ and transmission.json. On the
 * mirror that is /etc/magicmirror-secondbrain. Locally, point it at a directory
 * of your own with real credentials -- config/secondbrain/ in this repo has only
 * *.example.json templates, and the real files are gitignored.
 *
 *   --twice  poll twice and compare item ids, which is how to confirm that
 *            package identifiers are stable across polls rather than churning.
 */

const os = require("node:os");
const path = require("node:path");

const { pollAll } = require("../modules/MMM-SecondBrain/lib/sources.js");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const stateFlagIndex = args.indexOf("--state");
const stateDir =
  stateFlagIndex !== -1 && args[stateFlagIndex + 1]
    ? args[stateFlagIndex + 1]
    : path.join(os.tmpdir(), "secondbrain-dev-state");

const configDir = positional.find((a) => a !== stateDir);

if (!configDir) {
  console.error(
    "Usage: node scripts/dev-poll.js <configDir> [--state <dir>] [--json] [--twice]\n\n" +
    "  <configDir> is the directory holding gmail/, proton/ and transmission.json\n" +
    "  (on the mirror: /etc/magicmirror-secondbrain)"
  );
  process.exit(2);
}

const options = {
  maxItems: 10,
  maxPackageItems: 10,
  maxDownloadItems: 5,
  stateDir
};

function render(items) {
  if (items.length === 0) {
    console.log("  (nothing to display)");
    return;
  }

  const groups = new Map();
  for (const item of items) {
    const kind = item.kind || "other";
    if (!groups.has(kind)) {
      groups.set(kind, []);
    }
    groups.get(kind).push(item);
  }

  for (const [kind, group] of groups) {
    console.log(`\n  ${kind.toUpperCase()} (${group.length})`);
    for (const item of group) {
      console.log(`    ${item.label}  ${item.age ? `· ${item.age}` : ""}`);
      console.log(`      ${item.title}`);
      if (item.detail) {
        console.log(`      ${item.detail}`);
      }
      if (item.trackingId) {
        console.log(`      tracking: ${item.trackingId}`);
      }
      console.log(`      id: ${item.id}`);
    }
  }
}

async function main() {
  console.log(`config: ${configDir}`);
  console.log(`state:  ${stateDir}\n`);

  const started = Date.now();
  const items = await pollAll(configDir, options, console);
  const elapsed = Date.now() - started;

  if (flags.has("--json")) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    console.log(`Poll finished in ${elapsed}ms, ${items.length} item(s).`);
    render(items);
  }

  if (!flags.has("--twice")) {
    return;
  }

  console.log("\n\nSecond poll, to check that ids are stable...\n");

  const again = await pollAll(configDir, options, console);

  const firstIds = new Set(items.map((i) => i.id));
  const secondIds = new Set(again.map((i) => i.id));

  const appeared = [...secondIds].filter((id) => !firstIds.has(id));
  const vanished = [...firstIds].filter((id) => !secondIds.has(id));

  if (appeared.length === 0 && vanished.length === 0) {
    console.log("  ids are identical across both polls.");
    return;
  }

  console.log("  ids changed between polls:");
  for (const id of appeared) {
    console.log(`    + ${id}`);
  }
  for (const id of vanished) {
    console.log(`    - ${id}`);
  }
  console.log(
    "\n  New ids for the same messages mean identifiers are not stable, which\n" +
    "  causes duplicate cards and unbounded state growth."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
