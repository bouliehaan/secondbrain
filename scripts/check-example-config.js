#!/usr/bin/env node
/*
 * The example wall is what every fresh install starts from: postinst seeds
 * /opt/MagicMirror/config/config.js with it. So it has to load, it has to be
 * the same wall as the maintainer's config.js (same modules, same order -- the
 * layout is the product), and it must carry nothing of the maintainer's own:
 * no private calendar, no home coordinates.
 *
 * It also runs the seed the way postinst does and checks the result still
 * parses, since that output is a config file nobody reviewed.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const examplePath = path.join(root, "config/config.example.js");
const example = require(examplePath);
const wall = require(path.join(root, "config/config.js"));
const text = fs.readFileSync(examplePath, "utf8");

const names = (cfg) => cfg.modules.map((m) => `${m.module}@${m.position ?? "-"}`);
assert.deepEqual(names(example), names(wall), "example and config.js disagree about the wall's modules");

assert.doesNotMatch(text, /REDACTED_PRIVATE_PATH|CHANGEME/, "a placeholder url would be a failing feed on every new wall");
for (const personal of [/WEATHER/, /cloud\.example\.com/]) {
  assert.doesNotMatch(text, personal, `example carries maintainer data: ${personal}`);
}
for (const marker of ["// @lat", "// @lon", "// @place"]) {
  assert.ok(text.includes(marker), `seed marker missing: ${marker}`);
}
assert.equal(example.customCss, "css/secondbrain.css", "example must use the packaged stylesheet");

const calendars = example.modules.find((m) => m.module === "calendar").config.calendars;
assert.ok(calendars.length >= 1, "a fresh wall needs at least one working calendar");
for (const m of example.modules) {
  if (Array.isArray(m.config?.calendarSet)) {
    assert.equal(m.config.calendarSet.length, 0, `${m.module}: calendarSet must be empty so added calendars show up`);
  }
}

const seeded = execFileSync("python3", [path.join(root, "packaging/seed-config.py"), examplePath], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"]
});
const tmp = path.join(require("node:os").tmpdir(), `seeded-${process.pid}.js`);
fs.writeFileSync(tmp, seeded);
try {
  execFileSync(process.execPath, ["--check", tmp]);
  const cfg = require(tmp);
  const weather = cfg.modules.filter((m) => m.module === "weather");
  for (const w of weather) {
    assert.ok(Number.isFinite(w.config.lat) && Number.isFinite(w.config.lon), "seeded weather has no location");
  }
} finally {
  fs.rmSync(tmp, { force: true });
}
console.log("example config ok");
