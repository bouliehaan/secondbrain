/*
 * The status line under the month grid: the pure parts.
 *
 * Everything here takes plain data and returns the segments the line is made
 * of, so scripts/check-status-line.js can exercise it with no mirror, no
 * chrony and no network. The DOM and the probes live in StatusLine.js and
 * node_helper.js.
 *
 * A segment is { text, bad }. `bad` is drawn hatched: it is the one thing on
 * the line meant to be noticed from across the room.
 *
 * One object, like lib/freeze-watch.js: a global in the browser, a CommonJS
 * export in node.
 */

const StatusLineLogic = {

  SECOND_MS: 1000,
  MINUTE_S: 60,
  HOUR_S: 3600,
  DAY_S: 86400,

  /*
   * How a source reads on the wall.
   *
   *   { name: "Gmail", state: "ok" }                   GMAIL OK
   *   { name: "Proton", state: "down" }                PROTON DOWN   (bad)
   *   { name: "Gmail", state: "ok", ok: 1, total: 2 }  GMAIL 1/2     (bad)
   *   { name: "Proton", state: "off" }                 nothing -- not configured is not a fault
   */
  formatSource(source) {
    if (!source || !source.name) {
      return null;
    }

    const name = String(source.name).toUpperCase();
    const state = String(source.state || "").toLowerCase();

    if (state === "off") {
      return null;
    }

    if (state === "down") {
      return { text: `${name} DOWN`, bad: true };
    }

    const ok = Number(source.ok);
    const total = Number(source.total);

    if (
      Number.isFinite(ok) &&
      Number.isFinite(total) &&
      total > 1 &&
      ok < total
    ) {
      return { text: `${name} ${ok}/${total}`, bad: true };
    }

    if (state === "ok") {
      return { text: `${name} OK`, bad: false };
    }

    return null;
  },

  /*
   * The calendar feeds, as one segment: CAL 4/4, or CAL 2/4 hatched. Until
   * the first probe has answered it reads CAL --/4 -- not knowing is not the
   * same as knowing it is wrong.
   */
  formatCalendars(calendars) {
    if (!Array.isArray(calendars) || calendars.length === 0) {
      return null;
    }

    const answered = calendars.filter((c) => c && typeof c.ok === "boolean");

    if (answered.length === 0) {
      return { text: `CAL --/${calendars.length}`, bad: false };
    }

    const ok = answered.filter((c) => c.ok).length;

    return {
      text: `CAL ${ok}/${calendars.length}`,
      bad: ok < calendars.length
    };
  },

  formatSamo(samo) {
    const state = String(samo || "").toLowerCase();

    if (state === "ok") {
      return { text: "SAMO OK", bad: false };
    }

    if (state === "down") {
      return { text: "SAMO DOWN", bad: true };
    }

    return null;
  },

  /*
   * The left half: what is feeding the wall, and whether it answered.
   */
  composeLeft({ calendars, sources, samo } = {}) {
    const segments = [];

    const cal = this.formatCalendars(calendars);
    if (cal) {
      segments.push(cal);
    }

    for (const source of Array.isArray(sources) ? sources : []) {
      const segment = this.formatSource(source);
      if (segment) {
        segments.push(segment);
      }
    }

    const radio = this.formatSamo(samo);
    if (radio) {
      segments.push(radio);
    }

    return segments;
  },

  pad2(n) {
    return String(n).padStart(2, "0");
  },

  /* "3:41:07 PM" -- the wall reads AM/PM. */
  formatClock(timestamp) {
    const d = new Date(timestamp);
    const hours = d.getHours();
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12}:${this.pad2(d.getMinutes())}:${this.pad2(d.getSeconds())} ${hours < 12 ? "AM" : "PM"}`;
  },

  /*
   * "41 D", "6 H", "12 M". Coarse on purpose: the line says how long the box
   * has been up, not how long to the second.
   */
  formatUptime(seconds) {
    const s = Number(seconds);

    if (!Number.isFinite(s) || s < 0) {
      return null;
    }

    if (s >= this.DAY_S) {
      return `${Math.floor(s / this.DAY_S)} D`;
    }

    if (s >= this.HOUR_S) {
      return `${Math.floor(s / this.HOUR_S)} H`;
    }

    return `${Math.floor(s / this.MINUTE_S)} M`;
  },

  /*
   * The right half: the last poll and how long it took, whether the clock is
   * locked to NTP, and uptime.
   *
   *   ntp   "lock" | "none" | null   null is "could not ask" and reads NTP --
   *         undefined means the helper has not reported yet: nothing drawn
   */
  composeRight({ polledAt, pollMs, ntp, uptimeSec } = {}) {
    const segments = [];

    if (Number.isFinite(Number(polledAt)) && Number(polledAt) > 0) {
      const took = Number.isFinite(Number(pollMs))
        ? ` (${Math.max(1, Math.round(Number(pollMs) / this.SECOND_MS))} S)`
        : "";

      segments.push({
        text: `POLLED ${this.formatClock(Number(polledAt))}${took}`,
        bad: false
      });
    }

    if (ntp === "lock") {
      segments.push({ text: "NTP LOCK", bad: false });
    } else if (ntp === "none") {
      segments.push({ text: "NTP NONE", bad: true });
    } else if (ntp === null) {
      segments.push({ text: "NTP --", bad: false });
    }

    const up = this.formatUptime(uptimeSec);
    if (up) {
      segments.push({ text: `UP ${up}`, bad: false });
    }

    return segments;
  },

  /*
   * `chronyc tracking` says, among other things:
   *
   *   Leap status     : Normal
   *
   * or "Not synchronised" when it has no source. Anything else -- no output,
   * chrony not installed -- is null.
   */
  parseChronyTracking(output) {
    const text = String(output || "");
    const match = text.match(/Leap status\s*:\s*(.+)/i);

    if (!match) {
      return null;
    }

    const status = match[1].trim().toLowerCase();

    if (status.startsWith("not synchronised") || status.startsWith("not synchronized")) {
      return "none";
    }

    if (status === "normal" || status.startsWith("insert") || status.startsWith("delete")) {
      return "lock";
    }

    return null;
  },

  /*
   * A calendar feed is fine if it answers 2xx. A redirect that lands somewhere
   * 2xx counts too -- fetch follows them. Anything else, including a 401 from
   * a share link that has expired, is the failure this line exists to show.
   */
  isCalendarOk(statusCode) {
    const code = Number(statusCode);
    return Number.isFinite(code) && code >= 200 && code < 300;
  }
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = StatusLineLogic;
}
