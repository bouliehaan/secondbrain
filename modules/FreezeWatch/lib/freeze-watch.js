"use strict";

/*
 * Deciding whether the wall should tell you to drip the faucets.
 *
 * This file does no I/O and touches no DOM. Everything here is a judgement
 * about what to put on a wall -- which temperature counts, when a forecast low
 * is still worth acting on, and what the card should say -- and those are the
 * parts worth testing. `scripts/check-freeze-watch.js` exercises them with no
 * weather provider, no browser and no mirror.
 *
 * Two levels, borrowed from the language the forecast already uses:
 *
 *   WATCH    the forecast low is below the threshold -- act tonight
 *   WARNING  it is actually that cold outside right now -- act now
 *
 * The distinction matters because they ask for different things. A watch is a
 * chore to do before bed. A warning means the cold is already here and the
 * faucets should already be running.
 *
 * Everything is Fahrenheit. The wall runs `units: "imperial"`, and the
 * MagicMirror weather module converts its whole broadcast payload to imperial
 * before sending it (see `readWeatherPayload`), so no conversion happens here.
 */

const FreezeWatchLogic = {

  LEVEL_WATCH: "watch",
  LEVEL_WARNING: "warning",

  MINUTE_MS: 60 * 1000,
  HOUR_MS: 60 * 60 * 1000,
  DAY_MS: 24 * 60 * 60 * 1000,

  DEFAULTS: {
    /*
     * The rule of thumb is "below 20F for several hours" for exposed pipes;
     * 15F is the tighter number people actually use for a house that is
     * otherwise heated. It is a default, not a law -- raise it in config.js if
     * this house wants more margin.
     */
    thresholdF: 15,

    /*
     * How far above the threshold it has to climb before the card comes down.
     *
     * Without this a temperature sitting on 15F flips the card on and off every
     * time the provider updates, which on a wall is a light blinking in the
     * corner of the room all night. Only ever applied on the way *out*: the
     * alert still appears the moment it is genuinely cold.
     */
    clearMarginF: 2,

    /*
     * How far ahead a forecast low is allowed to raise a watch.
     *
     * 36 hours covers tonight and tomorrow night, which is the horizon a chore
     * like this is actually actionable on. The wall shows five days of forecast
     * and deliberately does not alert on all of them -- a cold snap on Friday
     * does not need a card up since Tuesday, and a card that lives for a week
     * stops being read.
     */
    lookaheadHours: 36,

    /*
     * A daily low is reported against the whole day, but it lands in the small
     * hours. Treating it as 7am local is what stops a low that already happened
     * this morning from raising a watch at dinner time.
     */
    lowHourOfDay: 7,

    /* After this long with no fresh reading, say so on the card. */
    staleAfterMinutes: 90,

    /* After this long, stop claiming to know the weather at all. */
    giveUpAfterHours: 6,

    locale: "en-US"
  },

  /*
   * Normalise whatever the weather module put in a `date` field.
   *
   * `WeatherObject.simpleClone()` flattens `date`, `sunrise` and `sunset`
   * through `valueOf()`, so a Date or a moment arrives as epoch milliseconds.
   * The openmeteo provider builds those from `timeformat=unixtime`, and the
   * seconds-vs-milliseconds distinction is exactly the kind of thing that
   * silently turns "tonight" into "some time in 1970". Anything below the
   * threshold below is far too small to be a plausible millisecond timestamp,
   * so it is read as seconds.
   */
  toEpochMs (value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : null;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }

      /* ~1973 in milliseconds; anything smaller is a seconds timestamp. */
      return value < 1e11 ? value * 1000 : value;
    }

    if (typeof value === "object" && typeof value.valueOf === "function") {
      return this.toEpochMs(value.valueOf());
    }

    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  },

  /*
   * Read a temperature out of a broadcast payload.
   *
   * One trap worth naming. The weather module converts its payload with
   * `WeatherUtils.convertTemp(value, "imperial")`, which is `value * 1.8 + 32`
   * with no null check -- so a provider that reports no temperature at all
   * arrives here as a confident 32. There is no way to tell that apart from a
   * real 32F reading, and happily there is no need to: 32 is above any sane
   * freeze threshold, so a missing reading fails safe as "not cold enough to
   * alert" rather than as a false alarm. `undefined` becomes NaN and is
   * rejected here.
   */
  readTemperature (value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  },

  /*
   * Pull the two things this module cares about out of a `WEATHER_UPDATED`
   * payload: what it is now, and what the coming lows are.
   *
   * Kept here rather than in the module so the payload shape is covered by the
   * offline checks -- it is the half most likely to break under a MagicMirror
   * upgrade, and the least likely to be noticed breaking, because the failure
   * looks exactly like mild weather.
   */
  readWeatherPayload (payload) {
    const result = { current: null, forecast: null };

    if (!payload || typeof payload !== "object") {
      return result;
    }

    const current = payload.currentWeather;

    if (current && typeof current === "object") {
      const temperatureF = this.readTemperature(current.temperature);

      if (temperatureF !== null) {
        result.current = {
          temperatureF,
          observedAt: this.toEpochMs(current.date)
        };
      }
    }

    if (Array.isArray(payload.forecastArray) && payload.forecastArray.length > 0) {
      const days = payload.forecastArray
        .map((day) => ({
          startsAt: this.toEpochMs(day?.date),
          minTemperatureF: this.readTemperature(day?.minTemperature)
        }))
        .filter((day) => day.startsAt !== null && day.minTemperatureF !== null);

      if (days.length > 0) {
        result.forecast = days;
      }
    }

    return result;
  },

  /*
   * The moment a forecast day's low is expected to arrive.
   *
   * The openmeteo provider reports a daily entry against local midnight, and
   * the low lands in the small hours after it. Without this offset the wall
   * would still be advising a drip at 6pm on the strength of a low that
   * happened before breakfast.
   */
  lowArrivesAt (day, options) {
    return day.startsAt + options.lowHourOfDay * this.HOUR_MS;
  },

  /*
   * The coldest forecast low still ahead of us and close enough to act on.
   */
  upcomingLow (forecast, now, options) {
    if (!Array.isArray(forecast)) {
      return null;
    }

    const horizon = now + options.lookaheadHours * this.HOUR_MS;

    let coldest = null;

    for (const day of forecast) {
      const arrivesAt = this.lowArrivesAt(day, options);

      if (arrivesAt < now || arrivesAt > horizon) {
        continue;
      }

      if (coldest === null || day.minTemperatureF < coldest.minTemperatureF) {
        coldest = { ...day, arrivesAt };
      }
    }

    return coldest;
  },

  startOfLocalDay (ms) {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  },

  /*
   * "tonight", "tomorrow night", or "Thursday night".
   *
   * A low arriving on the morning of day D is something you act on the evening
   * of D-1, so the label names that evening rather than the day the number
   * belongs to. Saying "Thursday" for a Thursday-dawn low would read as an
   * instruction to do the chore a day late.
   */
  nightLabel (arrivesAt, now, options) {
    const daysOut = Math.round(
      (this.startOfLocalDay(arrivesAt) - this.startOfLocalDay(now)) / this.DAY_MS
    );

    if (daysOut <= 1) {
      return "tonight";
    }

    if (daysOut === 2) {
      return "tomorrow night";
    }

    const eveningBefore = new Date(arrivesAt - this.DAY_MS);

    const weekday = eveningBefore.toLocaleDateString(options.locale, {
      weekday: "long"
    });

    return `${weekday} night`;
  },

  /*
   * Temperatures are compared as they are displayed.
   *
   * The wall runs `roundTemp: true`, so a raw 14.6 is shown as 15. Comparing
   * the raw value would put a card on the wall reading "low 15" under a rule
   * that says "below 15", which reads as a bug. Rounding first costs half a
   * degree of precision against a threshold that is a rule of thumb anyway, and
   * buys a card that always agrees with itself.
   */
  displayTemperature (temperatureF) {
    return Math.round(temperatureF);
  },

  /*
   * True when a temperature is cold enough to raise, or to keep, an alert.
   *
   * `alreadyShowing` widens the threshold by the clear margin, which is the
   * whole of the hysteresis: it takes `thresholdF` to turn a card on and
   * `thresholdF + clearMarginF` to let it turn off again.
   */
  isCold (temperatureF, alreadyShowing, options) {
    const limit = alreadyShowing
      ? options.thresholdF + options.clearMarginF
      : options.thresholdF;

    return this.displayTemperature(temperatureF) < limit;
  },

  describeAge (ageMs) {
    const hours = Math.floor(ageMs / this.HOUR_MS);

    if (hours >= 1) {
      return `${hours}h ago`;
    }

    return `${Math.max(1, Math.round(ageMs / this.MINUTE_MS))}m ago`;
  },

  /*
   * The decision.
   *
   *   state.now                epoch ms
   *   state.current            { temperatureF, observedAt } or null
   *   state.forecast           [{ startsAt, minTemperatureF }] or null
   *   state.receivedAt         when the last broadcast arrived, epoch ms
   *   state.previousLevel      the level currently on the wall, or null
   *
   * Returns null for "show nothing", or a finished card. The browser half does
   * no thinking -- the strings below are the strings it renders.
   */
  evaluateFreeze (state, config = {}) {
    const options = { ...this.DEFAULTS, ...config };

    const now = Number.isFinite(state?.now) ? state.now : Date.now();
    const previousLevel = state?.previousLevel || null;
    const showing = previousLevel !== null;

    /*
     * How old the information is.
     *
     * `receivedAt` is when the broadcast arrived rather than when the reading
     * was taken, because it is the honest measure for both halves: a forecast
     * entry's own date is the day it describes, not the moment it was fetched.
     * The current observation's own timestamp is preferred when it is older,
     * since a provider serving a stale reading is stale however promptly the
     * module relayed it.
     */
    const timestamps = [state?.receivedAt, state?.current?.observedAt]
      .filter((value) => Number.isFinite(value) && value > 0);

    const freshestAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const ageMs = freshestAt === null ? null : Math.max(0, now - freshestAt);

    /*
     * Past the give-up point we do not know what the weather is doing, and a
     * card that keeps insisting on yesterday's cold snap is worse than no card
     * -- it is the state this dashboard has been burned by twice, where a dead
     * feed goes on displaying confident stale information.
     *
     * Short of that, a stale reading keeps its card. The two ways to be wrong
     * are not symmetric: dripping the faucets on a mild night wastes a little
     * water, and not dripping them on a cold one costs a plumber. So the card
     * stays up and says how old it is.
     */
    if (ageMs !== null && ageMs > options.giveUpAfterHours * this.HOUR_MS) {
      return null;
    }

    const stale = ageMs !== null && ageMs > options.staleAfterMinutes * this.MINUTE_MS;

    const currentF = state?.current?.temperatureF ?? null;
    const low = this.upcomingLow(state?.forecast, now, options);

    const currentIsCold =
      currentF !== null &&
      this.isCold(currentF, showing && previousLevel === this.LEVEL_WARNING, options);

    const forecastIsCold =
      low !== null && this.isCold(low.minTemperatureF, showing, options);

    if (!currentIsCold && !forecastIsCold) {
      return null;
    }

    /*
     * A warning outranks a watch. When it is already this cold outside, what
     * the forecast thinks tonight will do is no longer the headline.
     */
    return currentIsCold
      ? this.buildWarning(currentF, low, now, stale, ageMs, options)
      : this.buildWatch(low, now, stale, ageMs, options);
  },

  buildWarning (currentF, low, now, stale, ageMs, options) {
    const temperature = this.displayTemperature(currentF);

    const detail = [`${temperature}° outside`];

    /*
     * The overnight low earns its place on a warning only by saying something
     * the big number does not. If it is no colder than it already is, it is
     * just a second way of saying "cold".
     */
    if (low !== null && this.displayTemperature(low.minTemperatureF) < temperature) {
      detail.push(
        `${this.displayTemperature(low.minTemperatureF)}° ` +
        `${this.nightLabel(low.arrivesAt, now, options)}`
      );
    }

    if (stale) {
      detail.push(this.describeAge(ageMs));
    }

    return {
      level: this.LEVEL_WARNING,
      label: "Freeze warning",
      headline: "Drip the faucets now",
      detail: detail.join(" · "),
      temperature,
      stale
    };
  },

  buildWatch (low, now, stale, ageMs, options) {
    const temperature = this.displayTemperature(low.minTemperatureF);
    const when = this.nightLabel(low.arrivesAt, now, options);

    const detail = [`Forecast low ${temperature}°`];

    if (stale) {
      detail.push(this.describeAge(ageMs));
    }

    return {
      level: this.LEVEL_WATCH,
      label: "Freeze watch",
      headline: `Drip the faucets ${when}`,
      detail: detail.join(" · "),
      temperature,
      stale
    };
  }
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = FreezeWatchLogic;
}
