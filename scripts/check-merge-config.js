#!/usr/bin/env node
/*
 * merge-config-secrets.js is what keeps a deploy from putting placeholders on
 * the wall: redacted calendar urls, and the stand-in weather location the
 * public repo carries instead of where the house is. This runs it against the
 * real config/config.js and a made-up live config, and checks both come back --
 * and that a live config with no location stops the deploy instead of shipping
 * the stand-in city.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const merge = path.join(root, "scripts/merge-config-secrets.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-check-"));

function liveConfig ({ withLocation }) {
  const repo = require(path.join(root, "config/config.js"));
  const cfg = JSON.parse(JSON.stringify(repo, (k, v) => (typeof v === "function" ? undefined : v)));
  for (const mod of cfg.modules) {
    if (mod.module === "calendar") {
      for (const cal of mod.config.calendars) {
        if (/REDACTED_PRIVATE_PATH/.test(cal.url)) cal.url = `https://calendars.test/${cal.name}.ics`;
      }
    }
    if (mod.module === "weather") {
      if (withLocation) {
        mod.config.lat = 12.3456;
        mod.config.lon = -65.4321;
        if (mod.config.type === "current") mod.header = "TESTVILLE";
      } else {
        delete mod.config.lat;
        delete mod.config.lon;
      }
    }
  }
  return `let config = ${JSON.stringify(cfg, null, 2)};\nmodule.exports = config;\n`;
}

function run (live) {
  const staged = path.join(dir, `staged-${Math.random()}.js`);
  const livePath = path.join(dir, `live-${Math.random()}.js`);
  fs.copyFileSync(path.join(root, "config/config.js"), staged);
  fs.writeFileSync(livePath, live);
  const result = spawnSync(process.execPath, [merge, staged, livePath], { encoding: "utf8" });
  return { result, staged };
}

try {
  const ok = run(liveConfig({ withLocation: true }));
  assert.equal(ok.result.status, 0, ok.result.stderr);
  delete require.cache[require.resolve(ok.staged)];
  const merged = require(ok.staged);
  for (const mod of merged.modules) {
    if (mod.module === "calendar") {
      for (const cal of mod.config.calendars) assert.doesNotMatch(cal.url, /REDACTED_PRIVATE_PATH/, cal.name);
    }
    if (mod.module === "weather") {
      assert.equal(mod.config.lat, 12.3456);
      assert.equal(mod.config.lon, -65.4321);
      if (mod.config.type === "current") assert.equal(mod.header, "TESTVILLE");
    }
  }

  const bad = run(liveConfig({ withLocation: false }));
  assert.notEqual(bad.result.status, 0, "a live config without a location must stop the deploy");
  assert.match(bad.result.stderr, /weather location/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("merge config ok");
