/* global Module, Log, config, FreezeWatchLogic */

/*
 * Freeze Watch -- drip the faucets, on the wall.
 *
 * Below a threshold the wall says so, in two strengths: a quiet card when the
 * forecast low is coming, a louder one when it is already that cold outside.
 *
 * The browser half does no thinking. Whether to show anything, which level, and
 * what the lines say were all decided in lib/freeze-watch.js before this file
 * saw them, because that is where it can be tested without a browser, a mirror
 * or a cold night.
 *
 * There is no node_helper here on purpose. The weather modules already fetch
 * this data every fifteen minutes and broadcast it, so a second fetch would be
 * a second set of numbers to disagree with what the wall is showing two cards
 * further down. This module is a reader.
 */

/*
 * Re-evaluate on a timer as well as on each broadcast.
 *
 * Weather arrives every fifteen minutes, but the decision also depends on the
 * clock: a low passes out of the lookahead window, "tonight" becomes "tomorrow
 * night", a reading goes stale. Without this the card could sit there being
 * quietly wrong for a quarter of an hour at a time.
 */
const REEVALUATE_INTERVAL_MS = 60 * 1000;

Module.register("FreezeWatch", {
  defaults: {
    /* Degrees Fahrenheit. Below this, say something. */
    thresholdF: 15,

    /*
     * How much it has to warm up before the card comes down. Stops a
     * temperature parked on the threshold blinking the card on and off all
     * night.
     */
    clearMarginF: 2,

    /*
     * How far ahead a forecast low may raise a watch. 36 hours covers tonight
     * and tomorrow night. Raising this puts the card up earlier and leaves it
     * up longer, which is the fastest way to make it stop being read.
     */
    lookaheadHours: 36,

    /* Say how old the reading is after this long without a fresh one. */
    staleAfterMinutes: 90,

    /* Stop claiming to know the weather after this long. */
    giveUpAfterHours: 6
  },

  start () {
    this.card = null;

    /*
     * What is currently drawn, serialised. Seeded with the empty card rather
     * than with null so the first tick of a mild day is a genuine no-op --
     * start() has already hidden the module, and there is nothing to redraw.
     */
    this.rendered = JSON.stringify(null);

    /*
     * What the weather modules have told us so far, and when.
     *
     * Two weather instances broadcast into this: the current-conditions one and
     * the forecast one. Neither payload carries both halves, so this is
     * accumulated rather than replaced -- see notificationReceived.
     */
    this.current = null;
    this.forecast = null;
    this.receivedAt = null;

    /* Nothing to show until the weather says otherwise. */
    this.hide(0);

    this.timer = window.setInterval(
      () => this.evaluate(),
      REEVALUATE_INTERVAL_MS
    );
  },

  stop () {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  },

  getStyles () {
    return ["FreezeWatch.css"];
  },

  getScripts () {
    return [this.file("lib/freeze-watch.js")];
  },

  notificationReceived (notification, payload) {
    if (notification !== "WEATHER_UPDATED") {
      return;
    }

    const reading = FreezeWatchLogic.readWeatherPayload(payload);

    /*
     * Merge, never overwrite.
     *
     * config.js runs two weather modules -- one `type: "current"`, one
     * `type: "forecast"` -- and both broadcast WEATHER_UPDATED. The forecast
     * instance sends no current conditions and the current instance sends no
     * forecast array, so assigning the whole reading would have each broadcast
     * wipe out what the other one just supplied, and the module would flip
     * between knowing one half and knowing the other every fifteen minutes.
     */
    if (reading.current) {
      this.current = reading.current;
    }

    if (reading.forecast) {
      this.forecast = reading.forecast;
    }

    if (!reading.current && !reading.forecast) {
      return;
    }

    this.receivedAt = Date.now();

    this.evaluate();
  },

  evaluate () {
    const card = FreezeWatchLogic.evaluateFreeze({
      now: Date.now(),
      current: this.current,
      forecast: this.forecast,
      receivedAt: this.receivedAt,
      previousLevel: this.card ? this.card.level : null
    }, {
      thresholdF: this.config.thresholdF,
      clearMarginF: this.config.clearMarginF,
      lookaheadHours: this.config.lookaheadHours,
      staleAfterMinutes: this.config.staleAfterMinutes,
      giveUpAfterHours: this.config.giveUpAfterHours,
      /*
       * MagicMirror defines `config` globally, but this runs on a timer once a
       * minute -- a ReferenceError here would kill the module silently and
       * leave a wall that simply never mentions the cold.
       */
      locale: (typeof config !== "undefined" && config.locale) || "en-US"
    });

    /*
     * Redraw only on a real change. The wall visibly flashes on every
     * updateDom, and this runs once a minute -- on a cold week that would be a
     * card twitching in the corner of the room ten thousand times for no
     * reason.
     */
    const serialised = JSON.stringify(card);

    if (serialised === this.rendered) {
      return;
    }

    if (card && (!this.card || this.card.level !== card.level)) {
      Log.info(`[FreezeWatch] ${card.label}: ${card.headline} (${card.detail})`);
    } else if (!card && this.card) {
      Log.info("[FreezeWatch] Above the threshold again; the card is coming down.");
    }

    this.rendered = serialised;
    this.card = card;

    if (card) {
      this.updateDom(0);
      this.show(0);
    } else {
      /*
       * Order matters: redraw the empty shell first, then hide. Hiding a module
       * that still holds the old card leaves it briefly visible on the next
       * show, which on a wall reads as a freeze warning flickering back in the
       * middle of a mild afternoon.
       */
      this.updateDom(0);
      this.hide(0);
    }
  },

  getDom () {
    const wrapper = document.createElement("section");
    wrapper.className = "freezewatch-shell";

    if (!this.card) {
      wrapper.classList.add("freezewatch-empty");
      return wrapper;
    }

    wrapper.classList.add(`freezewatch-${this.card.level}`);

    /*
     * The card is an advisory rather than a live region: it changes a handful
     * of times a winter, and the wall has no screen reader on it. Marking it up
     * as an alert would be a claim about urgency that the markup cannot cash.
     */
    wrapper.appendChild(this.renderLabel(this.card));

    const headline = document.createElement("div");
    headline.className = "freezewatch-headline";
    headline.textContent = this.card.headline;
    wrapper.appendChild(headline);

    if (this.card.detail) {
      const detail = document.createElement("div");
      detail.className = "freezewatch-detail";
      detail.textContent = this.card.detail;
      wrapper.appendChild(detail);
    }

    return wrapper;
  },

  renderLabel (card) {
    const row = document.createElement("div");
    row.className = "freezewatch-label-row";

    /*
     * The dot is the whole of the escalation that moves: it breathes on a
     * warning and sits still on a watch. Confining the motion to six pixels is
     * deliberate -- something has to distinguish "it is cold now" from "it will
     * be", and a card that pulses as a whole would be unbearable in a room you
     * live in for the fortnight it is cold.
     */
    const dot = document.createElement("span");
    dot.className = "freezewatch-dot";
    row.appendChild(dot);

    const label = document.createElement("span");
    label.className = "freezewatch-label";
    label.textContent = card.label;
    row.appendChild(label);

    if (card.stale) {
      const flag = document.createElement("span");
      flag.className = "freezewatch-stale";
      flag.textContent = "stale";
      row.appendChild(flag);
    }

    return row;
  }
});
