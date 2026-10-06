#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the weather cards.
 *
 * No network, no browser, no mirror: answers are built by hand in Open-Meteo's
 * shape, and the helper runs against a stubbed fetch. What is guarded is what
 * went wrong with the stock module, and what would go wrong quietly:
 *
 *   - the rain bar is the day's chance, not hours of rain over 24;
 *   - conditions are named from the forecast's code, so heavy drizzle is not
 *     a thunderstorm and heavy snow is not a "snow thunderstorm";
 *   - an old answer never shows yesterday in today's row;
 *   - the broadcast is what FreezeWatch and MMM-SolarTheme read;
 *   - the helper fetches the moment the server starts, once for both cards,
 *     keeps the last reading through an outage, and falls back to another
 *     model where the chosen one has no data.
 *
 *   node scripts/check-weather.js
 */

const Module = require("node:module");
const Weather = require("../modules/Weather/lib/weather.js");
const FreezeWatch = require("../modules/FreezeWatch/lib/freeze-watch.js");

let failures = 0;

function check (name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

/* Local times, so this asserts the same thing in Denver as anywhere else. */
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
const sec = (ms) => Math.round(ms / 1000);

/* An Open-Meteo answer for 3-9 October, as `timeformat=unixtime` returns it. */
function answer ({ current = true, days = 7, codes = [0, 1, 2, 55, 75, 86, 95], pp = [0, 2, 35, 81, 10, null, 100] } = {}) {
  const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], weather_code: [], sunrise: [], sunset: [] };
  for (let i = 0; i < days; i++) {
    daily.time.push(sec(at(3 + i, 0)));
    daily.temperature_2m_max.push(70 - i + 0.4);
    daily.temperature_2m_min.push(40 - i - 0.4);
    daily.precipitation_probability_max.push(pp[i] ?? null);
    daily.weather_code.push(codes[i] ?? 0);
    daily.sunrise.push(sec(at(3 + i, 6, 59)));
    daily.sunset.push(sec(at(3 + i, 18, 40)));
  }
  return {
    current: current
      ? { time: sec(at(3, 9, 15)), temperature_2m: 51.8, apparent_temperature: 46.2, relative_humidity_2m: 56,
        weather_code: 0, wind_speed_10m: 2.4, wind_direction_10m: 113, is_day: 1 }
      : undefined,
    daily
  };
}

async function run () {
  console.log("\nWeather checks\n");

  /* ------------------------------------------------------------------ *
   * Settings and the request.
   * ------------------------------------------------------------------ */

  const s = Weather.settings({ lat: "40.71284", lon: -74.00597 }, "imperial");
  check("a location is rounded to four places and defaults to the National Blend",
    s.lat === 40.7128 && s.lon === -74.006 && s.model === "ncep_nbm_conus" && s.units === "imperial", JSON.stringify(s));
  check("no location, no settings", Weather.settings({ lat: null, lon: 1 }) === null && Weather.settings({}) === null);
  check("an interval below five minutes is raised to five",
    Weather.settings({ lat: 1, lon: 1, updateInterval: 1000 }).updateInterval === 5 * 60 * 1000);
  check("both cards at one place share a key",
    Weather.key(Weather.settings({ lat: 40.7128, lon: -74.006, type: "current" }, "imperial")) ===
    Weather.key(Weather.settings({ lat: 40.71280001, lon: -74.006, type: "forecast" }, "imperial")));

  const url = Weather.requestUrl(s);
  check("the request names the model", url.includes("models=ncep_nbm_conus"), url);
  check("the request asks for the real chance of precipitation", url.includes("precipitation_probability_max"), url);
  check("the request asks for Fahrenheit and mph on an imperial wall",
    url.includes("temperature_unit=fahrenheit") && url.includes("wind_speed_unit=mph"), url);
  check("the request asks for epoch times in the place's own zone",
    url.includes("timeformat=unixtime") && url.includes("timezone=auto"), url);

  /* ------------------------------------------------------------------ *
   * Reading the answer.
   * ------------------------------------------------------------------ */

  const data = Weather.parse(answer(), "imperial");
  check("current conditions are read", data.current && data.current.temperature === 51.8 && data.current.humidity === 56,
    JSON.stringify(data.current));
  check("a day's date is its local midnight, in milliseconds", data.days[0].date === at(3, 0));
  check("seven days are read", data.days.length === 7);

  const short = answer();
  short.daily.temperature_2m_max[6] = null;
  check("a day past the end of the model's run is left out, not drawn blank",
    Weather.parse(short, "imperial").days.length === 6);

  let empty = null;
  try {
    Weather.parse({ daily: { time: [] } }, "imperial");
  } catch (error) {
    empty = error;
  }
  check("an answer with nothing in it is an error, marked as an empty model", empty && empty.empty === true);

  let refused = null;
  try {
    Weather.parse({ error: true, reason: "No data is available for this location" }, "imperial");
  } catch (error) {
    refused = error;
  }
  check("'no data for this location' is marked as an empty model", refused && refused.empty === true);
  check("any other refusal is not", Weather.refusal("Parameter 'x' is invalid").empty === false);

  /* ------------------------------------------------------------------ *
   * Words and icons.
   * ------------------------------------------------------------------ */

  check("heavy drizzle is drizzle, not a thunderstorm", Weather.describe(55).label === "heavy drizzle");
  check("heavy snow is heavy snow", Weather.describe(75).label === "heavy snow");
  check("snow showers are snow, not a wintry mix", Weather.describe(85).label === "snow showers");
  check("a thunderstorm is a thunderstorm", Weather.describe(95).label === "thunderstorms");
  check("clear at night is clear, under a moon",
    Weather.describe(0, false).label === "clear" && Weather.describe(0, false).icon === "night-clear");
  check("clear by day is sunny", Weather.describe(0, true).label === "sunny");
  check("an unknown code says nothing rather than guess", Weather.describe(42).label === "");

  const longest = Math.max(...Object.keys(Weather.CODES).flatMap((code) =>
    [Weather.describe(Number(code), true).label, Weather.describe(Number(code), false).label].map((l) => l.length)));
  check("no label is longer than the current card's column holds", longest <= 13, `longest is ${longest}`);

  check("wind from 113 degrees is ESE", Weather.cardinal(113) === "ESE");
  check("wind from 359 degrees is N", Weather.cardinal(359) === "N");

  /* ------------------------------------------------------------------ *
   * The rain bar.
   * ------------------------------------------------------------------ */

  check("0% lights nothing", Weather.segments(0) === 0);
  check("35% lights two of five", Weather.segments(35) === 2);
  check("81% lights four", Weather.segments(81) === 4);
  check("100% lights all five", Weather.segments(100) === 5);
  check("no number lights nothing", Weather.segments(null) === 0);

  /* ------------------------------------------------------------------ *
   * Which days get a row.
   * ------------------------------------------------------------------ */

  const rows = Weather.upcomingDays(data.days, at(3, 21), 7);
  check("at 9pm today is still the first row", rows[0].date === at(3, 0));
  const later = Weather.upcomingDays(data.days, at(5, 8), 7);
  check("an answer two days old starts at today, not at the day it was fetched", later[0].date === at(5, 0) && later.length === 5);
  check("a row limit is honoured", Weather.upcomingDays(data.days, at(3, 8), 3).length === 3);
  check("today's entry is found for the sun times", Weather.today(data.days, at(3, 12)).sunrise === at(3, 6, 59));
  check("no today, no sun times", Weather.today(data.days, at(20, 12)) === null);

  check("6:59 in the morning on the 12-hour wall", Weather.clock(at(3, 6, 59)) === "6:59");
  check("with the period when asked", Weather.clock(at(3, 18, 40), { showPeriod: true }) === "6:40 PM");
  check("24-hour when configured", Weather.clock(at(3, 18, 40), { timeFormat: 24 }) === "18:40");

  check("a reading 89 minutes old is not stale", !Weather.isStale(at(3, 9), at(3, 10, 29), 90));
  check("a reading 91 minutes old is", Weather.isStale(at(3, 9), at(3, 10, 31), 90));

  /* ------------------------------------------------------------------ *
   * What FreezeWatch and MMM-SolarTheme read.
   * ------------------------------------------------------------------ */

  const forecastPayload = Weather.broadcast("forecast", data, at(3, 9), "openmeteo:ncep_nbm_conus");
  const currentPayload = Weather.broadcast("current", data, at(3, 9), "openmeteo:ncep_nbm_conus");

  const read = FreezeWatch.readWeatherPayload(forecastPayload);
  check("FreezeWatch reads the forecast lows", read.forecast && read.forecast.length === 7 &&
    read.forecast[0].minTemperatureF === 39.6 && read.forecast[0].startsAt === at(3, 0), JSON.stringify(read.forecast?.[0]));
  check("the forecast card sends no current conditions", read.current === null);

  const readCurrent = FreezeWatch.readWeatherPayload(currentPayload);
  check("FreezeWatch reads the current temperature", readCurrent.current && readCurrent.current.temperatureF === 51.8 &&
    readCurrent.current.observedAt === at(3, 9, 15));
  check("the current card sends no forecast", readCurrent.forecast === null);
  check("the current card carries today's sunrise and sunset for the theme",
    currentPayload.currentWeather.sunrise === at(3, 6, 59) && currentPayload.currentWeather.sunset === at(3, 18, 40));

  const summary = Weather.summary(data, at(3, 9));
  check("the journal line says what the wall shows", summary.startsWith("now 52F sunny | Sat 70/40 0% sunny") &&
    summary.includes("Tue 67/37 81% heavy drizzle"), summary);

  /* ------------------------------------------------------------------ *
   * The helper.
   * ------------------------------------------------------------------ */

  await checkHelper();

  console.log(failures === 0 ? "\nAll weather checks passed.\n" : `\n${failures} weather check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/* Load node_helper.js with MagicMirror's NodeHelper stood in by a plain object. */
function loadHelper () {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "node_helper" ? { create: (definition) => definition } : load.call(this, request, ...rest);
  };
  try {
    const file = require.resolve("../modules/Weather/node_helper.js");
    delete require.cache[file];
    return Object.create(require(file));
  } finally {
    Module._load = load;
  }
}

async function checkHelper () {
  const realFetch = global.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  const logged = [];
  const helpers = [];

  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await tick();
    }
  };

  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  function boot (fetchImpl) {
    const helper = loadHelper();
    const sent = [];
    const requests = [];
    helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });
    global.fetch = async (url) => {
      requests.push(String(url));
      return fetchImpl(String(url), requests.length);
    };
    helper.start();
    helpers.push(helper);
    return { helper, sent, requests };
  }

  global.config = {
    units: "imperial",
    modules: [
      { module: "clock" },
      { module: "Weather", config: { type: "current", lat: 40.7128, lon: -74.006 } },
      { module: "Weather", config: { type: "forecast", lat: 40.7128, lon: -74.006, maxNumberOfDays: 7 } }
    ]
  };

  console.log = (...args) => logged.push(args.join(" "));
  console.warn = (...args) => logged.push(args.join(" "));

  try {
    /* Starts on its own, once for both cards. */
    const a = boot(async () => respond(200, answer()));
    await settle();
    const started = a.requests.length;
    const firstData = a.sent.filter((m) => m.notification === "WEATHER_DATA").length;

    /* A page loading later is answered at once, from what is already there. */
    a.helper.socketNotificationReceived("WEATHER_CONFIG", { lat: 40.7128, lon: -74.006, units: "imperial", type: "current" });
    const replay = a.sent.filter((m) => m.notification === "WEATHER_DATA").length;
    const requestsAfterPage = a.requests.length;

    /* An outage keeps the reading and is logged once. */
    const b = boot(async (url, n) => (n === 1 ? respond(200, answer()) : respond(503, { error: true, reason: "busy" })));
    await settle();
    const kept = b.helper.watches.values().next().value;
    await b.helper.poll(kept);
    await b.helper.poll(kept);
    const outageLines = logged.filter((l) => l.includes("fetch failed")).length;

    /* A place the Blend does not cover falls back to best_match. */
    const c = boot(async (url) => (url.includes("models=ncep_nbm_conus")
      ? respond(400, { error: true, reason: "No data is available for this location" })
      : respond(200, answer())));
    await settle();
    const fellBack = c.requests.some((u) => u.includes("models=best_match"));
    const fallbackData = c.sent.some((m) => m.notification === "WEATHER_DATA" && m.payload.data.current);

    console.log = realLog;
    console.warn = realWarn;

    check("the helper fetches at server start, before any page asks", started === 1 && firstData === 1,
      `${started} request(s), ${firstData} broadcast(s)`);
    check("both cards share that one fetch", started === 1);
    check("a page that asks later is answered at once from the last reading", replay === 2 && requestsAfterPage === 1);
    check("through an outage the last reading is kept", kept.last && kept.last.data.current.temperature === 51.8 && kept.failures === 2);
    check("an outage is one journal line, not one per attempt", outageLines === 1, `${outageLines} lines`);
    /* Node's timer keeps its delay; after two failures the next try is two minutes out. */
    check("a failed fetch is retried in minutes, not after the full fifteen",
      kept.timer && kept.timer._idleTimeout === 2 * 60 * 1000, `next try in ${kept.timer?._idleTimeout}ms`);
    check("a place the National Blend does not cover falls back to best_match", fellBack && fallbackData);
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    for (const helper of helpers) {
      helper.stop();
    }
    global.fetch = realFetch;
    delete global.config;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
