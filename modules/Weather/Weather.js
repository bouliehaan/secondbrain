/* global Module, Log, config, WeatherLogic */

/*
 * Weather -- the current conditions card and the forecast card.
 *
 * Two instances in config.js, `type: "current"` and `type: "forecast"`, share
 * one fetch in node_helper.js. Which model, and why, is in lib/weather.js; so
 * is everything that decides what a card says, where the offline checks can
 * reach it. This file draws.
 *
 * The DOM is the one modules/WeatherTheme's templates drew for the stock
 * module -- .wx for the current card, one .fc-row per day -- so Rail measures
 * it as before and custom.css styles it as before.
 *
 * Every redraw replaces the content outright (updateDom(0)). Rail re-fits a
 * change before it paints; a fade takes the card out of the rail and lurches
 * everything under it, which is what the stock module did to the wall on every
 * new reading.
 */

/* Re-check the clock once a minute: a day passes, a reading goes stale. */
const RECHECK_INTERVAL_MS = 60 * 1000;

Module.register("Weather", {
  defaults: {
    type: "current",
    lat: null,
    lon: null,
    model: "ncep_nbm_conus",
    units: config.units,
    updateInterval: 15 * 60 * 1000,

    /* The forecast offers this many days; Rail shows the whole rows that fit. */
    maxNumberOfDays: 7,
    showPrecipitationProbability: true,

    /* The current card says how old its reading is after this long. */
    staleAfterMinutes: 90
  },

  start () {
    this.reading = null;
    this.rendered = null;

    const settings = WeatherLogic.settings(this.config, config.units);
    this.key = settings ? WeatherLogic.key(settings) : null;

    if (!settings) {
      Log.error(`[Weather] ${this.identifier} has no usable lat/lon in config.js.`);
      return;
    }

    this.sendSocketNotification("WEATHER_CONFIG", { ...settings });

    this.timer = window.setInterval(() => this.redraw(), RECHECK_INTERVAL_MS);
  },

  stop () {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  },

  getStyles () {
    return ["weather-icons.css", "Weather.css"];
  },

  getScripts () {
    return [this.file("lib/weather.js")];
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "WEATHER_DATA" || !payload || payload.key !== this.key) {
      return;
    }

    const isNew = !this.reading || this.reading.fetchedAt !== payload.fetchedAt;
    this.reading = payload;
    this.redraw();

    /*
     * Tell FreezeWatch and MMM-SolarTheme only about a new answer. Repeating an
     * old one -- the helper re-sends it when a page loads -- would make a stale
     * reading look fresh to the freeze card.
     */
    if (isNew) {
      this.sendNotification("WEATHER_UPDATED",
        WeatherLogic.broadcast(this.config.type, payload.data, Date.now(), `openmeteo:${this.config.model}`));
    }
  },

  /* Redraw only when what the card would say has changed. */
  redraw () {
    const signature = JSON.stringify(this.view(Date.now()));

    if (signature !== this.rendered) {
      this.rendered = signature;
      this.updateDom(0);
    }
  },

  /* What the card says, as plain data; getDom draws exactly this. */
  view (now) {
    const data = this.reading && this.reading.data;
    const deg = "°";

    if (this.config.type === "forecast") {
      const days = data ? WeatherLogic.upcomingDays(data.days, now, this.config.maxNumberOfDays) : [];

      return {
        rows: days.map((day, i) => {
          const { label, icon } = WeatherLogic.describe(day.code, true);
          const pp = WeatherLogic.round(day.precipitationProbability);
          return {
            today: i === 0 && WeatherLogic.startOfLocalDay(day.date + 12 * WeatherLogic.HOUR_MS) === WeatherLogic.startOfLocalDay(now),
            day: WeatherLogic.weekday(day.date),
            icon,
            label,
            hi: `${WeatherLogic.round(day.maxTemperature)}${deg}`,
            lo: `${WeatherLogic.round(day.minTemperature)}${deg}`,
            pp: pp === null ? null : `${pp}%`,
            segments: WeatherLogic.segments(day.precipitationProbability)
          };
        })
      };
    }

    const current = data && data.current;

    if (!current) {
      return { current: null };
    }

    const { label, icon } = WeatherLogic.describe(current.code, current.isDay);
    const today = WeatherLogic.today(data.days, now);
    const stale = WeatherLogic.isStale(this.reading.fetchedAt, now, this.config.staleAfterMinutes);
    const timeFormat = config.timeFormat;
    const windUnit = data.units === "metric" ? "km/h" : "mph";

    return {
      current: {
        temperature: WeatherLogic.round(current.temperature),
        icon: stale ? null : icon,
        label: stale ? `as of ${WeatherLogic.clock(this.reading.fetchedAt, { timeFormat, showPeriod: true })}` : label,
        stale,
        feels: current.feelsLike === null ? null : `${WeatherLogic.round(current.feelsLike)}${deg}`,
        humidity: current.humidity === null ? null : `${WeatherLogic.round(current.humidity)}%`,
        wind: current.windSpeed === null ? null : `${WeatherLogic.round(current.windSpeed)} ${windUnit} ${WeatherLogic.cardinal(current.windFromDirection)}`.trim(),
        sun: today && Number.isFinite(today.sunrise) && Number.isFinite(today.sunset)
          ? [WeatherLogic.clock(today.sunrise, { timeFormat }), WeatherLogic.clock(today.sunset, { timeFormat })]
          : null
      }
    };
  },

  getDom () {
    const view = this.view(Date.now());
    return this.config.type === "forecast" ? this.forecastDom(view) : this.currentDom(view);
  },

  el (tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  },

  icon (name) {
    return this.el("span", `wi weathericon wi-${name}`);
  },

  loading () {
    return this.el("div", "wx-loading", "Loading");
  },

  /*
   * The temperature is the biggest thing in the card because it is the one
   * number people cross the room for. Everything else is a labelled value.
   */
  currentDom (view) {
    const c = view.current;

    if (!c) {
      return this.loading();
    }

    const root = this.el("div", c.stale ? "wx wx-stale" : "wx");
    const primary = this.el("div", "wx-primary");

    /* The degree sign is split out: at this size Rajdhani's ring is as tall as a digit. */
    const temp = this.el("div", "wx-temp", String(c.temperature));
    temp.appendChild(this.el("span", "wx-deg", "°"));
    primary.appendChild(temp);

    const cond = this.el("div", "wx-cond");
    if (c.icon) {
      cond.appendChild(this.icon(c.icon));
    }
    cond.appendChild(this.el("span", "wx-cond-text", c.label));
    primary.appendChild(cond);
    root.appendChild(primary);

    const metrics = this.el("div", "wx-metrics");
    const metric = (key, value) => {
      if (value === null || value === undefined) {
        return;
      }
      const box = this.el("div", "wx-metric");
      box.appendChild(this.el("div", "wx-k", key));
      const v = this.el("div", "wx-v");
      if (Array.isArray(value)) {
        v.appendChild(document.createTextNode(`${value[0]} `));
        v.appendChild(this.el("span", "wx-sep", "/"));
        v.appendChild(document.createTextNode(` ${value[1]}`));
      } else {
        v.textContent = value;
      }
      box.appendChild(v);
      metrics.appendChild(box);
    };

    metric("Feels", c.feels);
    metric("Humidity", c.humidity);
    metric("Wind", c.wind);
    metric("Sun", c.sun);
    root.appendChild(metrics);

    return root;
  },

  /*
   * One row per day: weekday, icon, condition, high, low, and the chance of
   * precipitation as five segments of 20%. The first row is today and gets the
   * live edge. Weekday names throughout: the month grid already says which
   * day it is, and a column of three-letter days lines up.
   */
  forecastDom (view) {
    if (view.rows.length === 0) {
      return this.loading();
    }

    const root = this.el("div", "fc");

    for (const row of view.rows) {
      const node = this.el("div", row.today ? "fc-row fc-today" : "fc-row");
      node.appendChild(this.el("span", "fc-day", row.day));
      const icon = this.el("span", "fc-icon");
      icon.appendChild(this.icon(row.icon));
      node.appendChild(icon);
      node.appendChild(this.el("span", "fc-cond", row.label));
      node.appendChild(this.el("span", "fc-hi", row.hi));
      node.appendChild(this.el("span", "fc-lo", row.lo));

      if (this.config.showPrecipitationProbability) {
        const pp = this.el("span", "fc-pp");
        if (row.pp !== null) {
          pp.title = row.pp;
        }
        for (let i = 1; i <= 5; i++) {
          pp.appendChild(this.el("i", i <= row.segments ? "on" : ""));
        }
        node.appendChild(pp);
      }

      root.appendChild(node);
    }

    return root;
  }
});
