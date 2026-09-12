#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the status line under the calendar.
 *
 * These need no chrony, no network and no mirror: they feed hand-built
 * results straight into the composition and read the words back. The cases
 * worth guarding are the ones where the line would lie -- a source that is
 * not configured showing as broken, a feed that has not been probed showing
 * as fine, and chrony output that means "no source" reading as a lock.
 *
 *   node scripts/check-status-line.js
 */

const StatusLine = require("../modules/StatusLine/lib/status-line.js");

let failures = 0;

function check (name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

const texts = (segments) => segments.map((s) => s.text);
const bads = (segments) => segments.filter((s) => s.bad).map((s) => s.text);

function run () {
  console.log("\nStatus line checks\n");

  /* ------------------------------------------------------------------ *
   * Sources.
   * ------------------------------------------------------------------ */

  check(
    "a working source reads NAME OK",
    StatusLine.formatSource({ name: "Gmail", state: "ok" }).text === "GMAIL OK"
  );

  check(
    "a dead source reads NAME DOWN and is flagged",
    (() => {
      const s = StatusLine.formatSource({ name: "Proton", state: "down" });
      return s.text === "PROTON DOWN" && s.bad === true;
    })()
  );

  check(
    "an unconfigured source is left off the line entirely",
    StatusLine.formatSource({ name: "Proton", state: "off" }) === null
  );

  check(
    "one account of two failing reads NAME 1/2 and is flagged",
    (() => {
      const s = StatusLine.formatSource({ name: "Gmail", state: "ok", ok: 1, total: 2 });
      return s.text === "GMAIL 1/2" && s.bad === true;
    })()
  );

  check(
    "one account of one working does not show a fraction",
    StatusLine.formatSource({ name: "Gmail", state: "ok", ok: 1, total: 1 }).text === "GMAIL OK"
  );

  /* ------------------------------------------------------------------ *
   * Calendars.
   * ------------------------------------------------------------------ */

  check(
    "before any probe has answered the line does not claim a verdict",
    (() => {
      const s = StatusLine.formatCalendars([{ ok: null }, { ok: null }]);
      return s.text === "CAL --/2" && s.bad === false;
    })()
  );

  check(
    "every feed answering reads CAL 4/4, unflagged",
    (() => {
      const s = StatusLine.formatCalendars([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
      return s.text === "CAL 4/4" && s.bad === false;
    })()
  );

  check(
    "one dead feed of four reads CAL 3/4 and is flagged",
    (() => {
      const s = StatusLine.formatCalendars([{ ok: true }, { ok: false }, { ok: true }, { ok: true }]);
      return s.text === "CAL 3/4" && s.bad === true;
    })()
  );

  check(
    "no calendars configured means no CAL segment",
    StatusLine.formatCalendars([]) === null && StatusLine.formatCalendars(undefined) === null
  );

  check(
    "2xx is fine, everything else is not",
    StatusLine.isCalendarOk(200) && StatusLine.isCalendarOk(204) &&
    !StatusLine.isCalendarOk(301) && !StatusLine.isCalendarOk(401) &&
    !StatusLine.isCalendarOk(404) && !StatusLine.isCalendarOk(500) &&
    !StatusLine.isCalendarOk(null)
  );

  /* ------------------------------------------------------------------ *
   * The whole left half.
   * ------------------------------------------------------------------ */

  check(
    "the left half is feeds, then sources, then the radio, in that order",
    (() => {
      const left = StatusLine.composeLeft({
        calendars: [{ ok: true }, { ok: true }],
        sources: [
          { name: "Gmail", state: "ok" },
          { name: "Proton", state: "down" },
          { name: "Transmission", state: "off" }
        ],
        samo: "ok"
      });
      return texts(left).join(" // ") === "CAL 2/2 // GMAIL OK // PROTON DOWN // SAMO OK" &&
        bads(left).join() === "PROTON DOWN";
    })(),
    "a source that is off must not appear; a source that is down must be the only flag"
  );

  check(
    "with nothing known yet the left half is empty rather than wrong",
    StatusLine.composeLeft({}).length === 0
  );

  check(
    "a samo that is off is not mentioned; a samo that is down is flagged",
    StatusLine.formatSamo("off") === null &&
    StatusLine.formatSamo(undefined) === null &&
    StatusLine.formatSamo("down").bad === true
  );

  /* ------------------------------------------------------------------ *
   * The right half.
   * ------------------------------------------------------------------ */

  const polledAt = new Date(2026, 8, 11, 15, 41, 7).getTime();

  check(
    "the poll time reads AM/PM with how long it took, in seconds",
    texts(StatusLine.composeRight({ polledAt, pollMs: 41200 }))[0] === "POLLED 3:41:07 PM (41 S)"
  );

  check(
    "a poll that took under half a second still says one second, not zero",
    texts(StatusLine.composeRight({ polledAt, pollMs: 120 }))[0] === "POLLED 3:41:07 PM (1 S)"
  );

  check(
    "midnight and noon are 12, not 0",
    StatusLine.formatClock(new Date(2026, 8, 11, 0, 5, 0).getTime()) === "12:05:00 AM" &&
    StatusLine.formatClock(new Date(2026, 8, 11, 12, 5, 0).getTime()) === "12:05:00 PM"
  );

  check(
    "NTP: lock, none (flagged), unknown (--), and not-yet-reported (absent)",
    (() => {
      const lock = StatusLine.composeRight({ ntp: "lock" });
      const none = StatusLine.composeRight({ ntp: "none" });
      const unknown = StatusLine.composeRight({ ntp: null });
      const absent = StatusLine.composeRight({});
      return texts(lock).join() === "NTP LOCK" && bads(lock).length === 0 &&
        texts(none).join() === "NTP NONE" && bads(none).join() === "NTP NONE" &&
        texts(unknown).join() === "NTP --" && bads(unknown).length === 0 &&
        absent.length === 0;
    })()
  );

  check(
    "uptime is days, then hours, then minutes, never fractions",
    StatusLine.formatUptime(41 * 86400 + 3600 * 6) === "41 D" &&
    StatusLine.formatUptime(6 * 3600 + 59 * 60) === "6 H" &&
    StatusLine.formatUptime(12 * 60 + 30) === "12 M" &&
    StatusLine.formatUptime(-1) === null &&
    StatusLine.formatUptime("soon") === null
  );

  /* ------------------------------------------------------------------ *
   * chrony.
   * ------------------------------------------------------------------ */

  check(
    "a normal leap status is a lock",
    StatusLine.parseChronyTracking(
      "Reference ID    : C0A80101 (time.nist.gov)\nStratum         : 2\nLeap status     : Normal\n"
    ) === "lock"
  );

  check(
    "not synchronised is none, in either spelling",
    StatusLine.parseChronyTracking("Leap status     : Not synchronised\n") === "none" &&
    StatusLine.parseChronyTracking("Leap status     : Not synchronized\n") === "none"
  );

  check(
    "no output at all is unknown, not a lock",
    StatusLine.parseChronyTracking("") === null &&
    StatusLine.parseChronyTracking(null) === null &&
    StatusLine.parseChronyTracking("506 Cannot talk to daemon\n") === null
  );
}

run();

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
);

process.exit(failures === 0 ? 0 : 1);
