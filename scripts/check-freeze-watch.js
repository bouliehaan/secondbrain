#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the freeze alert.
 *
 * These need no weather provider, no browser and no mirror -- they feed
 * hand-built readings straight into the decision. Where a check exercises the
 * broadcast payload it is shaped exactly like MagicMirror's `WEATHER_UPDATED`,
 * imperial conversion artefacts and all, so what is asserted here is what the
 * wall gets.
 *
 * The cases worth guarding are the ones where being wrong is expensive or
 * annoying: a low that already happened raising a chore for tonight, a card
 * blinking on and off at the threshold all night, and a dead feed going on
 * insisting it is cold.
 *
 *   node scripts/check-freeze-watch.js
 */

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

/*
 * All times are built local rather than from epoch literals, so these checks
 * assert the same thing in Denver, where the mirror runs, as on whatever
 * machine happens to run them.
 */
const at = (day, hour, minute = 0) =>
  new Date(2026, 0, day, hour, minute, 0, 0).getTime();

/* A forecast entry is reported against local midnight of the day it covers. */
const day = (dayOfMonth, minTemperatureF) => ({
  startsAt: at(dayOfMonth, 0),
  minTemperatureF
});

const evaluate = (state, options) =>
  FreezeWatch.evaluateFreeze({ receivedAt: state.now, ...state }, options);

function run () {
  console.log("\nFreeze watch checks\n");

  /* ------------------------------------------------------------------ *
   * The two levels.
   * ------------------------------------------------------------------ */

  const watch = evaluate({
    now: at(5, 18),
    current: { temperatureF: 34 },
    forecast: [day(6, 11)]
  });

  check(
    "a forecast low below the threshold raises a watch",
    watch && watch.level === "watch",
    `got ${JSON.stringify(watch)}`
  );

  check(
    "the watch names the evening the chore belongs to, not the dawn the low lands on",
    watch && watch.headline === "Drip the faucets tonight",
    `got ${watch && watch.headline}`
  );

  check(
    "the watch reports the low it is acting on",
    watch && watch.detail === "Forecast low 11°",
    `got ${watch && watch.detail}`
  );

  const warning = evaluate({
    now: at(5, 18),
    current: { temperatureF: 9 },
    forecast: [day(6, 4)]
  });

  check(
    "an actual temperature below the threshold raises a warning",
    warning && warning.level === "warning",
    `got ${JSON.stringify(warning)}`
  );

  check(
    "the warning leads with how cold it is right now",
    warning && warning.headline === "Drip the faucets now",
    `got ${warning && warning.headline}`
  );

  check(
    "a warning outranks a watch rather than showing both",
    warning && warning.detail === "9° outside · 4° tonight",
    `got ${warning && warning.detail}`
  );

  /*
   * The overnight low has to say something the big number does not. Repeating
   * "cold" twice in one card is just noise.
   */
  const noRedundantLow = evaluate({
    now: at(5, 18),
    current: { temperatureF: 9 },
    forecast: [day(6, 12)]
  });

  check(
    "a warning drops the overnight low when it is no colder than it already is",
    noRedundantLow && noRedundantLow.detail === "9° outside",
    `got ${noRedundantLow && noRedundantLow.detail}`
  );

  check(
    "a mild day shows nothing at all",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 41 },
      forecast: [day(6, 33)]
    }) === null
  );

  /* ------------------------------------------------------------------ *
   * A low that has already happened is not a chore for tonight.
   *
   * The daily forecast reports one low against the whole day, and it lands
   * before dawn. Read naively, a 6am low of 11 degrees is still "today's low"
   * at six in the evening, and the wall would spend a mild evening telling
   * you to go and drip the faucets over weather that finished twelve hours
   * ago.
   * ------------------------------------------------------------------ */

  check(
    "this morning's low does not raise a watch this evening",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 38 },
      forecast: [day(5, 11)]
    }) === null
  );

  check(
    "the same low does raise a watch while it is still ahead",
    evaluate({
      now: at(5, 3),
      current: { temperatureF: 19 },
      forecast: [day(5, 11)]
    }) !== null
  );

  /* ------------------------------------------------------------------ *
   * The lookahead window.
   * ------------------------------------------------------------------ */

  check(
    "a cold snap five days out does not put a card up now",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 38 },
      forecast: [day(6, 40), day(7, 38), day(10, 2)]
    }) === null
  );

  check(
    "tonight is covered all day, not just in the evening",
    evaluate({
      now: at(5, 8),
      current: { temperatureF: 30 },
      forecast: [day(6, 11)]
    }) !== null
  );

  const tomorrow = evaluate({
    now: at(5, 22),
    current: { temperatureF: 30 },
    forecast: [day(7, 9)]
  });

  check(
    "a low the night after next is named as such",
    tomorrow && tomorrow.headline === "Drip the faucets tomorrow night",
    `got ${tomorrow && tomorrow.headline}`
  );

  const named = evaluate({
    now: at(5, 18),
    current: { temperatureF: 30 },
    forecast: [day(8, 9)]
  }, { lookaheadHours: 96 });

  check(
    "further out, the card names the evening by weekday",
    named && named.headline === "Drip the faucets Wednesday night",
    `got ${named && named.headline}`
  );

  const coldest = evaluate({
    now: at(5, 18),
    current: { temperatureF: 30 },
    forecast: [day(6, 14), day(7, 6)]
  }, { lookaheadHours: 96 });

  check(
    "with two cold nights in the window it acts on the colder one",
    coldest && coldest.temperature === 6,
    `got ${coldest && coldest.temperature}`
  );

  /* ------------------------------------------------------------------ *
   * Hysteresis.
   *
   * A temperature parked on the threshold must not blink the card on and off
   * every time the provider updates. On a wall that is a light flickering in
   * the corner of the room all night.
   * ------------------------------------------------------------------ */

  check(
    "16 degrees does not raise a warning on its own",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 16 },
      forecast: [day(6, 30)]
    }) === null
  );

  check(
    "16 degrees keeps a warning that is already up",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 16 },
      forecast: [day(6, 30)],
      previousLevel: "warning"
    }) !== null
  );

  check(
    "18 degrees finally takes it down",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 18 },
      forecast: [day(6, 30)],
      previousLevel: "warning"
    }) === null
  );

  check(
    "the same margin holds a watch up",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 30 },
      forecast: [day(6, 16)],
      previousLevel: "watch"
    }) !== null
  );

  /* ------------------------------------------------------------------ *
   * The card must agree with itself.
   *
   * The wall rounds temperatures for display. Comparing the raw value would
   * put a card up reading "Forecast low 15°" under a rule that says "below
   * 15", which reads as a bug in the module rather than a rounding choice.
   * ------------------------------------------------------------------ */

  check(
    "14.6 displays as 15 and so does not trigger a rule that says below 15",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 34 },
      forecast: [day(6, 14.6)]
    }) === null
  );

  const rounded = evaluate({
    now: at(5, 18),
    current: { temperatureF: 34 },
    forecast: [day(6, 14.4)]
  });

  check(
    "14.4 triggers, and the card says 14",
    rounded && rounded.detail === "Forecast low 14°",
    `got ${rounded && rounded.detail}`
  );

  /* ------------------------------------------------------------------ *
   * Stale readings.
   *
   * The two ways to be wrong are not symmetric. Dripping the faucets on a
   * mild night wastes a little water; not dripping them on a cold one costs a
   * plumber. So a stale reading keeps its card and says how old it is -- up
   * to the point where claiming to know the weather is no longer honest.
   * ------------------------------------------------------------------ */

  const stale = FreezeWatch.evaluateFreeze({
    now: at(5, 18),
    receivedAt: at(5, 15),
    current: { temperatureF: 9 },
    forecast: [day(6, 30)],
    previousLevel: "warning"
  });

  check(
    "a three-hour-old reading keeps its warning",
    stale && stale.level === "warning",
    `got ${JSON.stringify(stale)}`
  );

  check(
    "and says how old it is rather than pretending to be current",
    stale && stale.stale === true && stale.detail === "9° outside · 3h ago",
    `got ${stale && stale.detail}`
  );

  check(
    "a feed that died this morning stops claiming to know the weather",
    FreezeWatch.evaluateFreeze({
      now: at(5, 18),
      receivedAt: at(5, 4),
      current: { temperatureF: 9 },
      forecast: [day(6, 4)],
      previousLevel: "warning"
    }) === null
  );

  check(
    "a fresh reading carries no stale flag",
    (() => {
      const fresh = FreezeWatch.evaluateFreeze({
        now: at(5, 18),
        receivedAt: at(5, 17, 45),
        current: { temperatureF: 9 },
        forecast: [day(6, 4)]
      });
      return fresh && fresh.stale === false;
    })()
  );

  /*
   * A provider serving an old observation is stale however promptly the module
   * relayed it, so the observation's own timestamp counts too.
   */
  check(
    "an old observation is stale even in a freshly delivered payload",
    (() => {
      const relayed = FreezeWatch.evaluateFreeze({
        now: at(5, 18),
        receivedAt: at(5, 18),
        current: { temperatureF: 9, observedAt: at(5, 14) },
        forecast: [day(6, 30)]
      });
      return relayed && relayed.stale === true;
    })()
  );

  /* ------------------------------------------------------------------ *
   * Missing data claims nothing.
   * ------------------------------------------------------------------ */

  check(
    "no weather at all shows nothing",
    evaluate({ now: at(5, 18) }) === null
  );

  check(
    "a forecast alone is enough to raise a watch",
    evaluate({
      now: at(5, 18),
      forecast: [day(6, 11)]
    }) !== null
  );

  check(
    "a current reading alone is enough to raise a warning",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: 9 }
    }) !== null
  );
}

/*
 * Everything below reads the broadcast payload rather than the decision. This
 * is the half most likely to break under a MagicMirror upgrade and the least
 * likely to be noticed breaking, because a module that reads no temperature
 * looks exactly like mild weather.
 */
function runPayloadChecks () {
  console.log("\nWEATHER_UPDATED payload checks\n");

  /*
   * Shaped as `WeatherObject.simpleClone()` leaves it: date flattened through
   * valueOf() to epoch milliseconds, temperatures already converted to
   * imperial by the weather module because config.units is "imperial".
   */
  const currentPayload = {
    locationName: "Florissant",
    providerName: "openmeteo",
    currentWeather: {
      date: at(5, 18),
      temperature: 8.6,
      minTemperature: 4.1,
      maxTemperature: 22.3,
      weatherType: "clear"
    },
    forecastArray: []
  };

  const read = FreezeWatch.readWeatherPayload(currentPayload);

  check(
    "the current temperature is read out of a current-conditions broadcast",
    read.current && read.current.temperatureF === 8.6,
    `got ${JSON.stringify(read.current)}`
  );

  check(
    "an empty forecast array reads as absent rather than as an empty forecast",
    read.forecast === null,
    "the module merges the two broadcasts, so 'no forecast here' must not " +
    "overwrite the forecast the other weather instance supplied"
  );

  const forecastPayload = {
    currentWeather: null,
    forecastArray: [
      { date: at(5, 0), minTemperature: 21.2, maxTemperature: 40.1 },
      { date: at(6, 0), minTemperature: 6.8, maxTemperature: 24.0 }
    ]
  };

  const readForecast = FreezeWatch.readWeatherPayload(forecastPayload);

  check(
    "the forecast lows are read out of a forecast broadcast",
    readForecast.forecast &&
      readForecast.forecast.length === 2 &&
      readForecast.forecast[1].minTemperatureF === 6.8,
    `got ${JSON.stringify(readForecast.forecast)}`
  );

  check(
    "a broadcast with no current conditions reads as absent, not as zero degrees",
    readForecast.current === null
  );

  /*
   * The openmeteo provider builds its dates from `timeformat=unixtime`. A
   * seconds timestamp arriving where milliseconds were expected does not throw
   * -- it silently places every forecast low in 1970, where it is neither
   * ahead of us nor inside the lookahead window, and the module goes quiet for
   * the winter.
   */
  const seconds = FreezeWatch.readWeatherPayload({
    forecastArray: [{ date: Math.floor(at(6, 0) / 1000), minTemperature: 6.8 }]
  });

  check(
    "a seconds-based timestamp is read as seconds, not as 1970",
    seconds.forecast && seconds.forecast[0].startsAt === at(6, 0),
    `got ${seconds.forecast && seconds.forecast[0].startsAt}`
  );

  check(
    "a Date survives the trip as well as a number does",
    (() => {
      const asDate = FreezeWatch.readWeatherPayload({
        forecastArray: [{ date: new Date(at(6, 0)), minTemperature: 6.8 }]
      });
      return asDate.forecast && asDate.forecast[0].startsAt === at(6, 0);
    })()
  );

  /*
   * The weather module converts with `value * 1.8 + 32` and no null check, so
   * a provider reporting nothing arrives as a confident 32. There is no way to
   * tell that from a real 32F reading and no need to: it is above any sane
   * freeze threshold, so a missing reading fails safe as "not cold enough".
   * `undefined` becomes NaN, which must be rejected outright.
   */
  check(
    "a missing temperature fails safe rather than reading as freezing",
    evaluate({
      now: at(5, 18),
      current: { temperatureF: null * 1.8 + 32 },
      forecast: [day(6, null * 1.8 + 32)]
    }) === null
  );

  check(
    "an undefined temperature is rejected rather than read as NaN",
    (() => {
      const nan = FreezeWatch.readWeatherPayload({
        currentWeather: { date: at(5, 18), temperature: undefined },
        forecastArray: [{ date: at(6, 0), minTemperature: undefined }]
      });
      return nan.current === null && nan.forecast === null;
    })()
  );

  check(
    "a payload that is not a payload at all is survivable",
    (() => {
      const empty = FreezeWatch.readWeatherPayload(null);
      return empty.current === null && empty.forecast === null;
    })()
  );
}

run();
runPayloadChecks();

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
);

process.exit(failures === 0 ? 0 : 1);
