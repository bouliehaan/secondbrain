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

// The repo is public, so neither the example nor the maintainer's wall template
// may say where anybody lives: every weather module carries the stand-in, on a
// marked line, and the real location is merged back in on the mirror (see
// merge-config-secrets.js). A real lat/lon here fails the build.
const STAND_IN = { lat: 40.7128, lon: -74.006 };
for (const [name, cfg, file] of [["example", example, examplePath], ["config.js", wall, path.join(root, "config/config.js")]]) {
  assert.ok(!cfg.modules.some((m) => m.module === "weather"), `${name}: the stock weather module is replaced by modules/Weather`);
  assert.equal(cfg.modules.filter((m) => m.module === "Weather").length, 2, `${name}: two Weather cards, current and forecast`);
  for (const mod of cfg.modules.filter((m) => m.module === "Weather")) {
    assert.equal(mod.config.lat, STAND_IN.lat, `${name}: weather lat must be the stand-in, not a real place`);
    assert.equal(mod.config.lon, STAND_IN.lon, `${name}: weather lon must be the stand-in, not a real place`);
  }
  const source = fs.readFileSync(file, "utf8");
  assert.equal((source.match(/\/\/ @lat/g) ?? []).length, 2, `${name}: both lat lines must carry the @lat marker`);
  assert.equal((source.match(/\/\/ @lon/g) ?? []).length, 2, `${name}: both lon lines must carry the @lon marker`);
}
// Private calendars live in the public file as placeholders only.
for (const cal of wall.modules.find((m) => m.module === "calendar").config.calendars) {
  const host = new URL(cal.url).hostname;
  assert.ok(/REDACTED_PRIVATE_PATH/.test(cal.url) || ["www.officeholidays.com", "raw.githubusercontent.com"].includes(host),
    `config.js: calendar "${cal.name}" points at ${host} without being redacted`);
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
  const weather = cfg.modules.filter((m) => m.module === "Weather");
  for (const w of weather) {
    assert.ok(Number.isFinite(w.config.lat) && Number.isFinite(w.config.lon), "seeded weather has no location");
  }
} finally {
  fs.rmSync(tmp, { force: true });
}
console.log("example config ok");
