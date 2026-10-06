"use strict";

/*
 * The weather: what to ask for, and what the answer means.
 *
 * This file does no I/O and touches no DOM. It builds the one Open-Meteo
 * request the wall makes, turns the answer into numbers and words, and decides
 * which days are still worth a row. `scripts/check-weather.js` exercises all
 * of it with no network, no browser and no mirror.
 *
 * Why its own module rather than MagicMirror's stock weather. The stock
 * openmeteo provider cannot choose a model, and in the mountains the model is
 * the whole question. Scored a day ahead against the three thermometers around
 * the wall for September 2026 -- two co-op stations on the slopes and a
 * fire-weather station on the valley floor -- the stock
 * default -- GFS -- had the afternoon highs within about 2F but put the
 * overnight lows 3F too warm on the slopes and 8F too warm in the valley,
 * where cold air pools. ECMWF was no better (7F). NOAA's National Blend of
 * Models is a 2.5 km blend corrected against station readings, and it cut the
 * valley error to 3-4F and held the slopes within 2F. The lows are what the
 * freeze card acts on.
 *
 * The stock provider also reported "chance of precipitation" as the hours of
 * precipitation divided by 24, so a likely one-hour storm drew an empty bar,
 * and named conditions after an icon chosen for them, so heavy drizzle read
 * THUNDERSTORM and heavy snow read "snow thunderstorm". Here the bar is the
 * day's real chance, and the words come from the forecast's own code.
 *
 * One object, like lib/freeze-watch.js: a global in the browser, a CommonJS
 * export in node.
 */

const WeatherLogic = {

  MINUTE_MS: 60 * 1000,
  HOUR_MS: 60 * 60 * 1000,
  DAY_MS: 24 * 60 * 60 * 1000,

  API: "https://api.open-meteo.com/v1/forecast",

  DEFAULTS: {
    /* ncep_nbm_conus covers the contiguous US; elsewhere use "best_match". */
    model: "ncep_nbm_conus",
    units: "imperial",
    /* The blend is rerun hourly; current conditions move every 15 minutes. */
    updateInterval: 15 * 60 * 1000,
    /* NBM runs out at about eleven days; asking for more returns blanks. */
    forecastDays: 10
  },

  /* Polling faster than this asks for the same numbers again. */
  MINIMUM_INTERVAL_MS: 5 * 60 * 1000,

  CURRENT: ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "weather_code",
    "wind_speed_10m", "wind_direction_10m", "is_day"],
  DAILY: ["weather_code", "temperature_2m_max", "temperature_2m_min",
    "precipitation_probability_max", "sunrise", "sunset"],

  /*
   * What the forecast's WMO code means: the words on the wall, and an icon
   * from the weather-icons font MagicMirror ships. Only the clear-to-cloudy
   * codes change with the time of day; nobody needs a moon on a snowflake.
   * Words are kept to about thirteen letters, which is what the current card's
   * first column holds without running into the numbers beside it.
   */
  CODES: {
    0: { day: ["sunny", "day-sunny"], night: ["clear", "night-clear"] },
    1: { day: ["mostly sunny", "day-sunny-overcast"], night: ["mostly clear", "night-alt-partly-cloudy"] },
    2: { day: ["partly cloudy", "day-cloudy"], night: ["partly cloudy", "night-alt-cloudy"] },
    3: ["overcast", "cloudy"],
    45: ["fog", "fog"],
    48: ["freezing fog", "fog"],
    51: ["light drizzle", "sprinkle"],
    53: ["drizzle", "sprinkle"],
    55: ["heavy drizzle", "sprinkle"],
    56: ["icy drizzle", "sleet"],
    57: ["icy drizzle", "sleet"],
    61: ["light rain", "showers"],
    63: ["rain", "rain"],
    65: ["heavy rain", "rain"],
    66: ["freezing rain", "rain-mix"],
    67: ["freezing rain", "rain-mix"],
    71: ["light snow", "snow"],
    73: ["snow", "snow"],
    75: ["heavy snow", "snow"],
    77: ["snow grains", "snow"],
    80: ["light showers", "showers"],
    81: ["showers", "showers"],
    82: ["heavy showers", "rain"],
    85: ["snow showers", "snow"],
    86: ["snow squalls", "snow"],
    95: ["thunderstorms", "thunderstorm"],
    96: ["hailstorms", "hail"],
    99: ["hailstorms", "hail"]
  },

  /*
   * The settings that decide what is fetched, from a module's config (the
   * browser's, with defaults applied, or config.js's own, read by the helper
   * at startup). Null when there is no usable location.
   */
  settings (config, fallbackUnits) {
    /* Number(null) is 0: a missing latitude must not become the equator. */
    const coordinate = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));
    const lat = coordinate(config?.lat);
    const lon = coordinate(config?.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return null;
    }

    const units = (config?.units || fallbackUnits || this.DEFAULTS.units) === "metric" ? "metric" : "imperial";
    const interval = Number(config?.updateInterval) || this.DEFAULTS.updateInterval;

    return {
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      model: typeof config?.model === "string" && config.model ? config.model : this.DEFAULTS.model,
      units,
      updateInterval: Math.max(this.MINIMUM_INTERVAL_MS, interval)
    };
  },

  /* Both cards share one fetch when they want the same thing. */
  key (settings) {
    return `${settings.lat},${settings.lon},${settings.model},${settings.units}`;
  },

  requestUrl (settings) {
    const imperial = settings.units === "imperial";
    const params = [
      ["latitude", settings.lat],
      ["longitude", settings.lon],
      ["models", settings.model],
      ["timezone", "auto"],
      ["timeformat", "unixtime"],
      ["forecast_days", this.DEFAULTS.forecastDays],
      ["temperature_unit", imperial ? "fahrenheit" : "celsius"],
      ["wind_speed_unit", imperial ? "mph" : "kmh"],
      ["current", this.CURRENT.join(",")],
      ["daily", this.DAILY.join(",")]
    ];

    return `${this.API}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  },

  number (value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  },

  seconds (value) {
    const n = this.number(value);
    return n === null ? null : n * 1000;
  },

  /*
   * Turn Open-Meteo's answer into { current, days }.
   *
   * Every time is epoch milliseconds. A day's `date` is its local midnight,
   * which is what Open-Meteo reports with `timezone=auto` and
   * `timeformat=unixtime`, and what FreezeWatch expects of a forecast day.
   * A day the model has no numbers for -- past the end of its run -- is left
   * out rather than drawn blank. Throws when there is nothing usable at all,
   * so the helper keeps the last good answer instead.
   */
  parse (json, units) {
    if (!json || typeof json !== "object") {
      throw new Error("not a JSON object");
    }

    if (json.error) {
      throw this.refusal(json.reason);
    }

    const c = json.current || {};
    const temperature = this.number(c.temperature_2m);
    let current = null;

    if (temperature !== null && this.number(c.time) !== null) {
      current = {
        date: this.seconds(c.time),
        temperature,
        feelsLike: this.number(c.apparent_temperature),
        humidity: this.number(c.relative_humidity_2m),
        windSpeed: this.number(c.wind_speed_10m),
        windFromDirection: this.number(c.wind_direction_10m),
        code: this.number(c.weather_code),
        isDay: c.is_day !== 0
      };
    }

    const d = json.daily || {};
    const times = Array.isArray(d.time) ? d.time : [];
    const column = (name, i) => (Array.isArray(d[name]) ? d[name][i] : undefined);

    const days = times.map((time, i) => ({
      date: this.seconds(time),
      maxTemperature: this.number(column("temperature_2m_max", i)),
      minTemperature: this.number(column("temperature_2m_min", i)),
      precipitationProbability: this.number(column("precipitation_probability_max", i)),
      code: this.number(column("weather_code", i)),
      sunrise: this.seconds(column("sunrise", i)),
      sunset: this.seconds(column("sunset", i))
    })).filter((day) => day.date !== null && day.maxTemperature !== null && day.minTemperature !== null);

    if (!current && days.length === 0) {
      const error = new Error("no current conditions and no forecast days in the answer");
      /* The model answered, with blanks: it does not cover this place. */
      error.empty = true;
      throw error;
    }

    return { units: units === "metric" ? "metric" : "imperial", current, days };
  },

  /*
   * Open-Meteo's own error. "No data is available for this location" is a
   * model that does not cover the place, which the helper answers by asking
   * for another model; anything else is a failure to retry.
   */
  refusal (reason) {
    const error = new Error(`Open-Meteo: ${reason || "error"}`);
    error.empty = /no data is available/i.test(String(reason));
    return error;
  },

  /* { label, icon } for a WMO code. Unknown codes say so rather than guess. */
  describe (code, isDay = true) {
    const entry = this.CODES[code];

    if (!entry) {
      return { label: "", icon: "na" };
    }

    const [label, icon] = Array.isArray(entry) ? entry : entry[isDay ? "day" : "night"];
    return { label, icon };
  },

  /* Sixteen points, as the stock card drew them. */
  cardinal (degrees) {
    const d = this.number(degrees);

    if (d === null) {
      return "";
    }

    const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return points[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
  },

  startOfLocalDay (ms) {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  },

  /*
   * The days still worth a row: today and on, up to `max`. Rows are chosen by
   * date, not by position, so an answer that is hours old -- the network was
   * down overnight -- never shows yesterday in today's place.
   */
  upcomingDays (days, now, max = Infinity) {
    const today = this.startOfLocalDay(now);
    return (Array.isArray(days) ? days : [])
      .filter((day) => this.startOfLocalDay(day.date + 12 * this.HOUR_MS) >= today)
      .slice(0, Math.max(0, max));
  },

  /* Today's entry, for the sun times on the current card. */
  today (days, now) {
    return this.upcomingDays(days, now, 1).find((day) => this.startOfLocalDay(day.date + 12 * this.HOUR_MS) === this.startOfLocalDay(now)) || null;
  },

  isStale (fetchedAt, now, staleAfterMinutes) {
    return !Number.isFinite(fetchedAt) || now - fetchedAt > staleAfterMinutes * this.MINUTE_MS;
  },

  /* Five segments, each 20%. */
  segments (probability) {
    const p = this.number(probability);
    return p === null ? 0 : Math.max(0, Math.min(5, Math.round(p / 20)));
  },

  round (value) {
    const n = this.number(value);
    return n === null ? null : Math.round(n) === 0 ? 0 : Math.round(n);
  },

  /* "6:59" or "6:59 AM" -- the wall's 12-hour clock -- or "18:40". */
  clock (ms, { timeFormat = 12, showPeriod = false } = {}) {
    if (!Number.isFinite(ms)) {
      return "";
    }

    const date = new Date(ms);
    const minutes = String(date.getMinutes()).padStart(2, "0");

    if (Number(timeFormat) === 24) {
      return `${String(date.getHours()).padStart(2, "0")}:${minutes}`;
    }

    const hours = date.getHours() % 12 || 12;
    return `${hours}:${minutes}${showPeriod ? (date.getHours() < 12 ? " AM" : " PM") : ""}`;
  },

  weekday (ms) {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms).getDay()];
  },

  /*
   * The WEATHER_UPDATED broadcast, shaped like the stock module's so
   * FreezeWatch and MMM-SolarTheme read it unchanged: temperatures in the
   * configured units, every time in epoch milliseconds, and each card sending
   * its own half -- the current card the conditions and today's sun, the
   * forecast card the days.
   */
  broadcast (type, data, now, providerName) {
    const payload = { currentWeather: null, forecastArray: [], locationName: null, providerName };

    if (!data) {
      return payload;
    }

    if (type === "current" && data.current) {
      const today = this.today(data.days, now);
      payload.currentWeather = {
        date: data.current.date,
        temperature: data.current.temperature,
        feelsLikeTemp: data.current.feelsLike,
        humidity: data.current.humidity,
        windSpeed: data.current.windSpeed,
        windFromDirection: data.current.windFromDirection,
        weatherType: this.describe(data.current.code, data.current.isDay).icon,
        sunrise: today ? today.sunrise : null,
        sunset: today ? today.sunset : null,
        minTemperature: today ? today.minTemperature : null,
        maxTemperature: today ? today.maxTemperature : null
      };
    }

    if (type === "forecast") {
      payload.forecastArray = this.upcomingDays(data.days, now).map((day) => ({
        date: day.date,
        minTemperature: day.minTemperature,
        maxTemperature: day.maxTemperature,
        precipitationProbability: day.precipitationProbability,
        weatherType: this.describe(day.code, true).icon,
        sunrise: day.sunrise,
        sunset: day.sunset
      }));
    }

    return payload;
  },

  /*
   * One journal line per answer that differs from the last: what the wall is
   * about to show, so it can be checked against the wall without a screen.
   */
  summary (data, now) {
    const deg = data.units === "metric" ? "C" : "F";
    const parts = [];

    if (data.current) {
      parts.push(`now ${this.round(data.current.temperature)}${deg} ${this.describe(data.current.code, data.current.isDay).label}`);
    }

    for (const day of this.upcomingDays(data.days, now, 7)) {
      const pp = this.round(day.precipitationProbability);
      parts.push(`${this.weekday(day.date)} ${this.round(day.maxTemperature)}/${this.round(day.minTemperature)}${pp === null ? "" : ` ${pp}%`} ${this.describe(day.code).label}`);
    }

    return parts.join(" | ");
  }
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = WeatherLogic;
}
