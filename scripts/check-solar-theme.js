#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let moduleDefinition;
let now;
let tick;
const classes = new Set();
const root = {
  classList: {
    add: (name) => classes.add(name),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
  },
  dataset: {},
  style: { setProperty() {} }
};
class Clock extends Date {
  static now() { return now; }
}
vm.runInNewContext(fs.readFileSync(path.join(__dirname,
  "../modules/MMM-SolarTheme/MMM-SolarTheme.js"), "utf8"), {
  Module: { register: (_, definition) => { moduleDefinition = definition; } },
  Date: Clock,
  document: { documentElement: root },
  window: { setInterval: (callback) => { tick = callback; return 1; } },
  Log: { info() {} }
});

const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const messages = [];
const theme = {
  ...moduleDefinition,
  config: { ...moduleDefinition.defaults },
  sendSocketNotification: (name, payload) => messages.push({ name, payload })
};
now = at(21, 6, 30);
theme.start();
theme.notificationReceived("WEATHER_UPDATED", {
  currentWeather: { sunrise: at(21, 6, 45), sunset: at(21, 19) }
});
assert.equal(root.dataset.solarTheme, "dark");
now = at(21, 6, 45);
tick();
assert.equal(root.dataset.solarTheme, "light", "switch at sunrise without a 30-minute delay");
assert(classes.has("solar-light") && !classes.has("solar-dark"));
assert.equal(messages.at(-1).payload.theme, "light", "the native clock follows the page");

now = at(21, 18, 40);
tick();
assert.equal(root.dataset.solarTheme, "dark", "preserve the evening offset");
now = at(22, 7);
tick();
assert.equal(root.dataset.solarTheme, "light", "stale weather uses today's fallback");
now = at(22, 19);
tick();
assert.equal(root.dataset.solarTheme, "dark");

theme.config.lightAfterSunriseMinutes = 10;
theme.sunrise = at(22, 6, 45);
theme.sunset = at(22, 19);
assert.equal(theme.themeIsLight(at(22, 6, 54)), false, "explicit offsets still work");
assert.equal(theme.themeIsLight(at(22, 6, 55)), true);
console.log("Solar theme: sunrise, midnight rollover, fallback, clock sync and offsets pass.");
