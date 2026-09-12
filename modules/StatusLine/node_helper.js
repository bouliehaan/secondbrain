"use strict";

const NodeHelper = require("node_helper");
const os = require("os");
const { execFile } = require("child_process");
const StatusLineLogic = require("./lib/status-line");

/*
 * A feed that has not answered in this long is down for the purposes of the
 * line. The calendar module's own fetch would have given up too.
 */
const PROBE_TIMEOUT_MS = 20 * 1000;

/* chronyc answers instantly or not at all. */
const CHRONY_TIMEOUT_MS = 5 * 1000;

const MINIMUM_PROBE_INTERVAL_MS = 60 * 1000;
const MINIMUM_TICK_MS = 15 * 1000;

module.exports = NodeHelper.create({
  start () {
    this.calendars = [];
    this.results = new Map();
    this.probeTimer = null;
    this.tickTimer = null;
    this.probing = false;

    /* Transitions are logged; a steady state is not. */
    this.lastVerdicts = new Map();
    this.lastNtp = undefined;
  },

  stop () {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "STATUS_LINE_CONFIG") {
      return;
    }

    this.calendars = (Array.isArray(payload?.calendars) ? payload.calendars : [])
      .filter((c) => c && typeof c.url === "string" && c.url.length > 0)
      .map((c) => ({ name: String(c.name || c.url), url: c.url }));

    const probeIntervalMs = Math.max(
      MINIMUM_PROBE_INTERVAL_MS,
      Number(payload?.probeIntervalMs) || 15 * 60 * 1000
    );

    const tickMs = Math.max(
      MINIMUM_TICK_MS,
      Number(payload?.tickMs) || 60 * 1000
    );

    /*
     * The browser re-sends this on every reload. Timers are replaced, not
     * stacked, and a reload costs one immediate probe -- which is also the
     * answer to "did my config change fix it".
     */
    this.stop();

    this.probeTimer = setInterval(() => this.probeAll(), probeIntervalMs);
    this.tickTimer = setInterval(() => this.tick(), tickMs);

    this.tick();
    this.probeAll();
  },

  /*
   * The cheap half: NTP and uptime. Published on their own so the line has
   * them within seconds of a page load, while the probes are still out.
   */
  async tick () {
    const ntp = await this.readNtp();

    if (ntp !== this.lastNtp) {
      console.log(`[StatusLine] NTP ${ntp === null ? "unknown (no chronyc)" : ntp}.`);
      this.lastNtp = ntp;
    }

    this.publish({ ntp, uptimeSec: Math.floor(os.uptime()) });
  },

  readNtp () {
    return new Promise((resolve) => {
      let done = false;

      const finish = (value) => {
        if (!done) {
          done = true;
          resolve(value);
        }
      };

      try {
        execFile(
          "chronyc",
          ["tracking"],
          { timeout: CHRONY_TIMEOUT_MS, windowsHide: true },
          (error, stdout) => {
            if (error && !stdout) {
              /* Not installed, not permitted, or not answering: unknown. */
              finish(null);
              return;
            }

            finish(StatusLineLogic.parseChronyTracking(stdout));
          }
        );
      } catch {
        finish(null);
      }
    });
  },

  async probeAll () {
    if (this.probing || this.calendars.length === 0) {
      return;
    }

    this.probing = true;

    try {
      const verdicts = await Promise.all(
        this.calendars.map((calendar) => this.probeCalendar(calendar))
      );

      for (const verdict of verdicts) {
        this.results.set(verdict.name, verdict);

        const previous = this.lastVerdicts.get(verdict.name);

        /*
         * Say so on every change, and on the first answer. A feed that dies
         * quietly is the failure this module exists for; the journal should
         * carry it too, with the status code, so it can be found later.
         */
        if (!previous || previous.ok !== verdict.ok) {
          console.log(
            `[StatusLine] calendar "${verdict.name}" is ` +
            (verdict.ok ? "answering" : "not answering") +
            (verdict.status ? ` (HTTP ${verdict.status})` : verdict.error ? ` (${verdict.error})` : "") +
            "."
          );
        }

        this.lastVerdicts.set(verdict.name, verdict);
      }

      this.publish({
        calendars: this.calendars.map((c) => {
          const r = this.results.get(c.name);
          return { name: c.name, ok: r ? r.ok : null };
        })
      });
    } catch (error) {
      console.error(`[StatusLine] Probe failed: ${error.stack || error.message}`);
    } finally {
      this.probing = false;
    }
  },

  /*
   * One GET, headers only, then hang up. HEAD would be cheaper but not every
   * calendar host honours it, and a 405 from a healthy feed would be the
   * false alarm that gets the whole line ignored. The url is a share link
   * with a private token in it: it is used here and never logged.
   */
  async probeCalendar (calendar) {
    try {
      const response = await fetch(calendar.url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { "User-Agent": "secondbrain-statusline" }
      });

      try {
        await response.body?.cancel();
      } catch {
        /* The body is not wanted; a cancel that fails changes nothing. */
      }

      return {
        name: calendar.name,
        ok: StatusLineLogic.isCalendarOk(response.status),
        status: response.status
      };
    } catch (error) {
      return {
        name: calendar.name,
        ok: false,
        status: null,
        error: error?.name === "TimeoutError" ? "timeout" : (error?.code || error?.message || "error")
      };
    }
  },

  publish (payload) {
    try {
      this.sendSocketNotification("STATUS_LINE_UPDATE", payload);
    } catch (error) {
      console.error(`[StatusLine] Publish failed: ${error.message}`);
    }
  }
});
