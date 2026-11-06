"use strict";

/*
 * United States federal holidays, computed instead of fetched.
 *
 * The wall used to get these from officeholidays.com. From 2026-11-04 that site
 * hung for 15 to 30 seconds or answered 502 dozens of times a day. Its feed also
 * covered only the current year, so in late December the month grid showed
 * nothing for January. It also labelled four federal holidays "(Regional
 * Holiday)". The list is fixed by law, so nothing needs fetching:
 *
 *   5 U.S.C. 6103(a)  the eleven holidays, as a date or as "the nth weekday"
 *   5 U.S.C. 6103(b), Executive Order 11582
 *                     one that falls on a Saturday is observed the Friday
 *                     before, one on a Sunday the Monday after. New Year's Day
 *                     on a Saturday is therefore observed on December 31 of
 *                     the year before.
 *
 * Inauguration Day is a holiday only for federal staff around Washington,
 * D.C., so it is listed with the fun days, not here.
 *
 * This file does no I/O. `scripts/check-holidays.js` checks it against OPM's
 * published dates.
 */

const { MONDAY, THURSDAY, SATURDAY, SUNDAY, utc, addDays, nthWeekday } = require("./dates");
const { toIcs, yearsAround } = require("./ics");

/*
 * Names as people say them, not as the statute writes them: the statute's
 * "Washington's Birthday" is "Presidents' Day" on every calendar people read.
 * `since` is the first year the holiday applied.
 */
const RULES = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Martin Luther King Jr. Day", month: 1, weekday: MONDAY, nth: 3, since: 1986 },
  { name: "Presidents' Day", month: 2, weekday: MONDAY, nth: 3 },
  { name: "Memorial Day", month: 5, weekday: MONDAY, nth: -1 },
  { name: "Juneteenth", month: 6, day: 19, since: 2021 },
  { name: "Independence Day", month: 7, day: 4 },
  { name: "Labor Day", month: 9, weekday: MONDAY, nth: 1 },
  { name: "Columbus Day", month: 10, weekday: MONDAY, nth: 2 },
  { name: "Veterans Day", month: 11, day: 11 },
  { name: "Thanksgiving", month: 11, weekday: THURSDAY, nth: 4 },
  { name: "Christmas Day", month: 12, day: 25 }
];

/**
 * The weekday a fixed-date holiday is observed on.
 *
 * @param {Date} date
 * @returns {Date}
 */
function observedOn (date) {
  if (date.getUTCDay() === SATURDAY) return addDays(date, -1);
  if (date.getUTCDay() === SUNDAY) return addDays(date, 1);
  return date;
}

/**
 * One year's federal holidays.
 *
 * A holiday that is observed on another day appears twice: once on its own
 * date, which is the day people celebrate, and once as "(observed)" on the
 * weekday offices close. The old feed did the same.
 *
 * @param {number} year
 * @returns {{date: Date, name: string, holiday: string}[]} in date order
 */
function holidaysOf (year) {
  const days = [];

  for (const rule of RULES) {
    if (rule.since && year < rule.since) continue;

    const date = rule.weekday === undefined
      ? utc(year, rule.month, rule.day)
      : nthWeekday(year, rule.month, rule.weekday, rule.nth);

    days.push({ date, name: rule.name, holiday: rule.name });

    const observed = observedOn(date);
    if (observed.getTime() !== date.getTime()) {
      days.push({ date: observed, name: `${rule.name} (observed)`, holiday: rule.name });
    }
  }

  return days.sort((a, b) => a.date - b.date);
}

/**
 * The feed the "holidays" calendar fetches. The output depends only on the
 * year, so a fetch every fifteen minutes always gets the same text.
 *
 * @param {Date} [now]
 * @returns {string}
 */
function calendar (now = new Date()) {
  return toIcs({
    name: "US Federal Holidays",
    uidTag: "federal",
    days: yearsAround(now).flatMap(holidaysOf)
  });
}

module.exports = {
  /* Where the node_helper serves it. config.js points the "holidays" calendar here. */
  FEED_PATH: "/holidays/us-federal.ics",
  RULES,
  holidaysOf,
  calendar,
  observedOn
};
