/* global Module, config, StatusLineLogic */

/*
 * The line under the month grid.
 *
 *   CAL 4/4 // GMAIL OK // PROTON DOWN // TRANSMISSION OK // SAMO OK
 *                    POLLED 41 S AGO (TOOK 21 S) // NTP LOCK // UP 41 D
 *
 * Every word on it is something the wall already knows or can cheaply ask:
 * the mail poll's per-source result comes from MMM-SecondBrain, samo's from
 * NowPlaying, both re-broadcast as module notifications; the helper asks
 * chrony whether the clock is locked, reads uptime, and probes each calendar
 * feed with a plain GET every fifteen minutes. The poll's age is the one
 * thing here that changes on its own, and it ticks: that segment is
 * rewritten in place once a second.
 *
 * The probe is the reason this module exists. A calendar that starts
 * answering 404 does not go blank -- the grid keeps drawing whatever it last
 * fetched and nothing logs it. That has happened here for six days at a
 * stretch, twice. A hatched CAL 3/4 is the whole of the fix: it is not clever,
 * it is just visible.
 */

Module.register("StatusLine", {
  defaults: {
    /* How often the calendar feeds are probed. */
    probeIntervalMs: 15 * 60 * 1000,

    /* How often the helper re-reads NTP and uptime. */
    tickMs: 60 * 1000
  },

  start () {
    this.state = {
      calendars: null,
      sources: null,
      samo: null,
      ntp: undefined,
      uptimeSec: null,
      polledAt: null,
      pollMs: null,
      pollIntervalMs: null
    };

    this.configured = false;
    this.ticker = null;
  },

  suspend () {
    this.stopTicker();
  },

  resume () {
    this.startTicker();
    this.updateDom(0);
  },

  getStyles () {
    return ["StatusLine.css"];
  },

  getScripts () {
    return [this.file("lib/status-line.js")];
  },

  notificationReceived (notification, payload) {
    if (
      notification === "DOM_OBJECTS_CREATED" ||
      notification === "ALL_MODULES_STARTED"
    ) {
      this.configureBackend();
      this.startTicker();
      return;
    }

    if (notification === "SECONDBRAIN_STATUS" && payload) {
      this.state.sources = Array.isArray(payload.sources) ? payload.sources : null;
      this.state.polledAt = payload.at ?? null;
      this.state.pollMs = payload.ms ?? null;
      this.state.pollIntervalMs = payload.intervalMs ?? null;
      this.updateDom(0);
      return;
    }

    if (notification === "NOWPLAYING_STATUS" && payload) {
      this.state.samo = payload.samo ?? null;
      this.updateDom(0);
    }
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "STATUS_LINE_UPDATE" || !payload) {
      return;
    }

    if (Array.isArray(payload.calendars)) {
      this.state.calendars = payload.calendars;
    }

    if ("ntp" in payload) {
      this.state.ntp = payload.ntp;
    }

    if ("uptimeSec" in payload) {
      this.state.uptimeSec = payload.uptimeSec;
    }

    this.updateDom(0);
  },

  /*
   * The calendar feeds come from the stock calendar module's config, read off
   * the page's own config object. Their urls carry private share tokens; they
   * go to the helper over the module socket exactly as the calendar module's
   * own do, and only the name and a verdict ever come back.
   */
  configureBackend () {
    if (this.configured) {
      return;
    }

    const calendars = [];

    try {
      for (const module of (config && Array.isArray(config.modules)) ? config.modules : []) {
        if (module.module !== "calendar" || !module.config) {
          continue;
        }

        for (const calendar of Array.isArray(module.config.calendars) ? module.config.calendars : []) {
          if (calendar && calendar.url) {
            calendars.push({ name: calendar.name || calendar.url, url: calendar.url });
          }
        }
      }
    } catch {
      /* A malformed config is not this module's problem to report. */
    }

    this.configured = true;

    this.sendSocketNotification("STATUS_LINE_CONFIG", {
      calendars,
      probeIntervalMs: this.config.probeIntervalMs,
      tickMs: this.config.tickMs
    });
  },

  /*
   * The poll's age is the one thing on the line that moves between
   * notifications. Once a second, that segment alone is rewritten -- its text
   * and its hatch -- rather than the whole line redrawn: a redraw a second
   * across the bottom of the wall is a flicker waiting to happen.
   */
  startTicker () {
    if (this.ticker) {
      return;
    }

    this.ticker = window.setInterval(() => this.tick(), 1000);
  },

  stopTicker () {
    if (this.ticker) {
      window.clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  tick () {
    const segment = StatusLineLogic.composeRight(this.state).find((s) => s.role === "poll");
    const item = document.querySelector(`#${this.identifier} .statusline-item[data-role="poll"]`);

    if (!segment || !item) {
      return;
    }

    if (item.textContent !== segment.text) {
      item.textContent = segment.text;
    }

    if (item.classList.contains("statusline-bad") !== Boolean(segment.bad)) {
      item.classList.toggle("statusline-bad", Boolean(segment.bad));
    }
  },

  getDom () {
    const lib = StatusLineLogic;

    const wrapper = document.createElement("div");
    wrapper.className = "statusline";

    const band = document.createElement("div");
    band.className = "statusline-band";
    wrapper.appendChild(band);

    const row = document.createElement("div");
    row.className = "statusline-row";

    row.appendChild(this.renderSide("statusline-left", lib.composeLeft(this.state)));
    row.appendChild(this.renderSide("statusline-right", lib.composeRight(this.state)));

    wrapper.appendChild(row);

    return wrapper;
  },

  renderSide (className, segments) {
    const side = document.createElement("span");
    side.className = className;

    segments.forEach((segment, index) => {
      if (index > 0) {
        const sep = document.createElement("span");
        sep.className = "statusline-sep";
        sep.textContent = "//";
        side.appendChild(sep);
      }

      const item = document.createElement("span");
      item.className = "statusline-item" + (segment.bad ? " statusline-bad" : "");
      item.textContent = segment.text;

      if (segment.role) {
        item.dataset.role = segment.role;
      }

      side.appendChild(item);
    });

    return side;
  }
});
