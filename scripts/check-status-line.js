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
    "the poll reads as an age, with how long it took labelled as such",
    texts(StatusLine.composeRight({ polledAt, pollMs: 21200 }, polledAt + 41 * 1000))[0] === "POLLED 41 S AGO (TOOK 21 S)"
  );

  check(
    "the age ticks: a second later it is a second older, and the duration is not",
    texts(StatusLine.composeRight({ polledAt, pollMs: 21200 }, polledAt + 42 * 1000))[0] === "POLLED 42 S AGO (TOOK 21 S)" &&
    texts(StatusLine.composeRight({ polledAt, pollMs: 21200 }, polledAt + 59 * 1000))[0] === "POLLED 59 S AGO (TOOK 21 S)"
  );

  check(
    "a poll that took under half a second still says one second, not zero",
    texts(StatusLine.composeRight({ polledAt, pollMs: 120 }, polledAt))[0] === "POLLED 0 S AGO (TOOK 1 S)"
  );

  check(
    "a poll with no duration is still an age",
    texts(StatusLine.composeRight({ polledAt }, polledAt + 5000))[0] === "POLLED 5 S AGO"
  );

  check(
    "the poll segment is the one the browser rewrites in place",
    StatusLine.composeRight({ polledAt }, polledAt)[0].role === "poll" &&
    StatusLine.composeRight({ ntp: "lock" }).every((seg) => seg.role === undefined)
  );

  check(
    "an age is exact under a minute and coarse above it",
    StatusLine.formatAge(0) === "0 S" &&
    StatusLine.formatAge(59 * 1000) === "59 S" &&
    StatusLine.formatAge(60 * 1000) === "1 M" &&
    StatusLine.formatAge(59 * 60 * 1000 + 59 * 1000) === "59 M" &&
    StatusLine.formatAge(3600 * 1000) === "1 H" &&
    StatusLine.formatAge(86400 * 1000 * 2 + 5) === "2 D" &&
    StatusLine.formatAge(-40) === "0 S" &&
    StatusLine.formatAge("later") === "0 S"
  );

  check(
    "a poll a minute old on a minute's interval is not overdue; one three intervals late is hatched",
    bads(StatusLine.composeRight({ polledAt, pollIntervalMs: 60000 }, polledAt + 61 * 1000)).length === 0 &&
    bads(StatusLine.composeRight({ polledAt, pollIntervalMs: 60000 }, polledAt + 180 * 1000)).length === 0 &&
    bads(StatusLine.composeRight({ polledAt, pollIntervalMs: 60000 }, polledAt + 181 * 1000)).join() === "POLLED 3 M AGO"
  );

  check(
    "the overdue line scales with the interval, and assumes the floor when no interval was said",
    bads(StatusLine.composeRight({ polledAt, pollIntervalMs: 5 * 60000 }, polledAt + 10 * 60000)).length === 0 &&
    bads(StatusLine.composeRight({ polledAt, pollIntervalMs: 5 * 60000 }, polledAt + 16 * 60000)).length === 1 &&
    bads(StatusLine.composeRight({ polledAt }, polledAt + 181 * 1000)).length === 1
  );

  check(
    "a poll from the future is zero seconds ago, not negative",
    texts(StatusLine.composeRight({ polledAt }, polledAt - 5000))[0] === "POLLED 0 S AGO"
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
