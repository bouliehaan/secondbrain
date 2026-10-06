"use strict";

const NodeHelper = require("node_helper");
const WeatherLogic = require("./lib/weather.js");

/*
 * The fetch, for both weather cards.
 *
 * One request per place and model, however many cards show it: the current
 * conditions and the forecast come back in the same answer, so the two cards
 * can never disagree about it.
 *
 * It starts the moment the server does, from config.js itself, rather than
 * waiting for the page to ask. The page asks once, when it loads, so a helper
 * that waited came back from a server restart under a running kiosk with
 * nothing fetching -- the stock weather module sat frozen for nine hours
 * overnight into 2026-10-01 that way. The page's request is still honoured,
 * and answered at once with the last reading, so a reload is never blank.
 */

/* Every source gets a deadline; a request that hangs must not stop the polls. */
const DEADLINE_MS = 20 * 1000;

/* After a failure, try again sooner than the normal interval, then back off. */
const RETRY_MS = [60 * 1000, 2 * 60 * 1000, 5 * 60 * 1000];

module.exports = NodeHelper.create({
  start () {
    this.watches = new Map();

    for (const settings of this.configured()) {
      this.watch(settings);
    }
  },

  stop () {
    for (const watch of this.watches.values()) {
      clearTimeout(watch.timer);
    }
    this.watches.clear();
  },

  /* The Weather modules in config.js, as MagicMirror loaded it. */
  configured () {
    const config = global.config || {};
    const modules = Array.isArray(config.modules) ? config.modules : [];

    return modules
      .filter((mod) => mod && mod.module === "Weather" && mod.disabled !== true)
      .map((mod) => WeatherLogic.settings(mod.config, config.units))
      .filter(Boolean);
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "WEATHER_CONFIG") {
      return;
    }

    const settings = WeatherLogic.settings(payload, payload?.units);

    if (!settings) {
      console.warn("[Weather] A card asked for weather with no usable lat/lon; it will stay on LOADING.");
      return;
    }

    const watch = this.watch(settings);

    if (watch.last) {
      this.sendSocketNotification("WEATHER_DATA", watch.last);
    }
  },

  watch (settings) {
    const key = WeatherLogic.key(settings);
    let watch = this.watches.get(key);

    if (watch) {
      /* Two cards asking at different rates get the faster of the two. */
      watch.settings.updateInterval = Math.min(watch.settings.updateInterval, settings.updateInterval);
      return watch;
    }

    watch = { key, settings, timer: null, last: null, failures: 0, failingSince: null, said: null };
    this.watches.set(key, watch);

    console.log(`[Weather] Fetching ${settings.model} every ${Math.round(settings.updateInterval / 60000)} min.`);
    this.poll(watch);
    return watch;
  },

  async poll (watch) {
    clearTimeout(watch.timer);
    let delay = watch.settings.updateInterval;

    try {
      let data;

      try {
        data = WeatherLogic.parse(await this.fetchJson(watch.settings), watch.settings.units);
      } catch (error) {
        /*
         * A model answers with blanks for a place it does not cover -- the
         * National Blend is the contiguous US only -- so a wall anywhere else
         * would sit on LOADING. Open-Meteo's own choice for the place is the
         * next best thing.
         */
        if (!error.empty || watch.settings.model === "best_match") {
          throw error;
        }

        data = WeatherLogic.parse(await this.fetchJson({ ...watch.settings, model: "best_match" }), watch.settings.units);

        if (!watch.fellBack) {
          watch.fellBack = true;
          console.warn(`[Weather] ${watch.settings.model} has nothing for this location; using Open-Meteo's best_match instead.`);
        }
      }

      const now = Date.now();
      watch.last = { key: watch.key, fetchedAt: now, data };

      if (watch.failingSince) {
        console.log(`[Weather] Answering again after ${watch.failures} failed attempt(s) since ${new Date(watch.failingSince).toISOString()}.`);
      }
      watch.failures = 0;
      watch.failingSince = null;

      const line = WeatherLogic.summary(data, now);
      if (line !== watch.said) {
        watch.said = line;
        console.log(`[Weather] ${line}`);
      }

      this.sendSocketNotification("WEATHER_DATA", watch.last);
    } catch (error) {
      watch.failures += 1;
      delay = Math.min(delay, RETRY_MS[Math.min(watch.failures, RETRY_MS.length) - 1]);

      /* Only the first failure of a run is logged; an outage is one line, not ninety. */
      if (!watch.failingSince) {
        watch.failingSince = Date.now();
        const reason = error?.name === "TimeoutError" ? `no answer in ${DEADLINE_MS / 1000}s` : error?.message || String(error);
        console.warn(`[Weather] ${watch.settings.model} fetch failed (${reason}); the cards keep the last reading and say how old it is.`);
      }
    } finally {
      watch.timer = setTimeout(() => this.poll(watch), delay);
    }
  },

  async fetchJson (settings) {
    const response = await fetch(WeatherLogic.requestUrl(settings), {
      signal: AbortSignal.timeout(DEADLINE_MS),
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      /* A 400 carries Open-Meteo's reason, which says whether to try another model. */
      const body = await response.json().catch(() => null);
      throw body && body.reason ? WeatherLogic.refusal(body.reason) : new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }
});
