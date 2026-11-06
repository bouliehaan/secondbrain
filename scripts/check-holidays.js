#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the holiday feeds.
 *
 * Federal: the expected dates are OPM's published days off (opm.gov, "Federal
 * Holidays"), not something worked out from the same rules being tested.
 * 2021, 2022, 2027 and 2028 cover each kind of weekend shift. 2026 also has
 * to match, date for date, the officeholidays.com feed this replaces.
 *
 * Fun days: published dates for each kind of rule (Easter, the Hebrew,
 * Chinese and Islamic calendars, the equinoxes, Tax Day's shifts), checked
 * across years.
 *
 * The equinoxes fall on a local day, so this runs in the wall's timezone
 * whatever machine runs it.
 *
 *   node scripts/check-holidays.js
 */

process.env.TZ = "America/Denver";

const Federal = require("../modules/Holidays/lib/federal.js");
const Fun = require("../modules/Holidays/lib/fun-days.js");
const Dates = require("../modules/Holidays/lib/dates.js");

let failures = 0;

function check (name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

const ymd = (date) => date.toISOString().slice(0, 10);

/*
 * The weekday each holiday is a day off, per OPM. Where the holiday itself
 * falls on a weekend, this is the observed day.
 */
const OPM = {
  2021: {
    "New Year's Day": "2021-01-01",
    "Martin Luther King Jr. Day": "2021-01-18",
    "Presidents' Day": "2021-02-15",
    "Memorial Day": "2021-05-31",
    "Juneteenth": "2021-06-18",
    "Independence Day": "2021-07-05",
    "Labor Day": "2021-09-06",
    "Columbus Day": "2021-10-11",
    "Veterans Day": "2021-11-11",
    "Thanksgiving": "2021-11-25",
    "Christmas Day": "2021-12-24"
  },
  2022: {
    "New Year's Day": "2021-12-31",
    "Martin Luther King Jr. Day": "2022-01-17",
    "Presidents' Day": "2022-02-21",
    "Memorial Day": "2022-05-30",
    "Juneteenth": "2022-06-20",
    "Independence Day": "2022-07-04",
    "Labor Day": "2022-09-05",
    "Columbus Day": "2022-10-10",
    "Veterans Day": "2022-11-11",
    "Thanksgiving": "2022-11-24",
    "Christmas Day": "2022-12-26"
  },
  2026: {
    "New Year's Day": "2026-01-01",
    "Martin Luther King Jr. Day": "2026-01-19",
    "Presidents' Day": "2026-02-16",
    "Memorial Day": "2026-05-25",
    "Juneteenth": "2026-06-19",
    "Independence Day": "2026-07-03",
    "Labor Day": "2026-09-07",
    "Columbus Day": "2026-10-12",
    "Veterans Day": "2026-11-11",
    "Thanksgiving": "2026-11-26",
    "Christmas Day": "2026-12-25"
  },
  2027: {
    "New Year's Day": "2027-01-01",
    "Martin Luther King Jr. Day": "2027-01-18",
    "Presidents' Day": "2027-02-15",
    "Memorial Day": "2027-05-31",
    "Juneteenth": "2027-06-18",
    "Independence Day": "2027-07-05",
    "Labor Day": "2027-09-06",
    "Columbus Day": "2027-10-11",
    "Veterans Day": "2027-11-11",
    "Thanksgiving": "2027-11-25",
    "Christmas Day": "2027-12-24"
  },
  2028: {
    "New Year's Day": "2027-12-31",
    "Martin Luther King Jr. Day": "2028-01-17",
    "Presidents' Day": "2028-02-21",
    "Memorial Day": "2028-05-29",
    "Juneteenth": "2028-06-19",
    "Independence Day": "2028-07-04",
    "Labor Day": "2028-09-04",
    "Columbus Day": "2028-10-09",
    "Veterans Day": "2028-11-10",
    "Thanksgiving": "2028-11-23",
    "Christmas Day": "2028-12-25"
  }
};

/* Every date in officeholidays.com's 2026 feed, as fetched on 2026-11-06. */
const OFFICEHOLIDAYS_2026 = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
  "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"
];

/** The day each holiday is off in a year: its "(observed)" entry if it has one. */
function daysOff (year) {
  const off = {};

  for (const day of Federal.holidaysOf(year)) {
    if (!(day.holiday in off) || day.name.endsWith("(observed)")) off[day.holiday] = ymd(day.date);
  }

  return off;
}

/**
 * Just enough of RFC 5545 to read our own output back: unfold, split into
 * events, read the properties. MagicMirror's node-ical is not installed
 * here. The deploy's calendar check parses the served feed with it on the wall.
 */
function parseIcs (text) {
  const lines = text.replace(/\r\n[ \t]/g, "").split("\r\n");
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT") { events.push(current); current = null; }
    else if (current) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).split(";")[0];
      current[key] = line.slice(colon + 1);
    }
  }

  return { lines, events };
}

function run () {
  console.log("\nHoliday checks\n");

  for (const [year, expected] of Object.entries(OPM)) {
    const got = daysOff(Number(year));
    const wrong = Object.keys(expected).filter((name) => got[name] !== expected[name]);
    const extra = Object.keys(got).filter((name) => !(name in expected));
    check(
      `${year}: every day off matches OPM`,
      wrong.length === 0 && extra.length === 0,
      [...wrong.map((n) => `${n}: got ${got[n]}, OPM says ${expected[n]}`), ...extra.map((n) => `unexpected ${n}`)].join("; ")
    );
  }

  const ours2026 = Federal.holidaysOf(2026).map((d) => ymd(d.date));
  check(
    "2026 has exactly the dates of the officeholidays.com feed it replaces",
    JSON.stringify(ours2026) === JSON.stringify(OFFICEHOLIDAYS_2026),
    `got ${ours2026.join(", ")}`
  );

  check(
    "a weekend holiday keeps its own date and gains an (observed) weekday",
    (() => {
      const july = Federal.holidaysOf(2026).filter((d) => d.holiday === "Independence Day");
      return july.length === 2 &&
        ymd(july[0].date) === "2026-07-03" && july[0].name === "Independence Day (observed)" &&
        ymd(july[1].date) === "2026-07-04" && july[1].name === "Independence Day";
    })()
  );

  check(
    "a weekday holiday appears once",
    Federal.holidaysOf(2026).filter((d) => d.holiday === "Thanksgiving").length === 1
  );

  check(
    "Juneteenth starts in 2021, not before",
    !Federal.holidaysOf(2020).some((d) => d.holiday === "Juneteenth") &&
      Federal.holidaysOf(2021).some((d) => d.holiday === "Juneteenth")
  );

  check(
    "no holiday is ever on a weekend unless it also has an (observed) weekday",
    (() => {
      for (let y = 2021; y <= 2060; y += 1) {
        const days = Federal.holidaysOf(y);
        for (const d of days) {
          const weekend = [0, 6].includes(d.date.getUTCDay());
          if (d.name.endsWith("(observed)") && weekend) return false;
          if (weekend && !days.some((o) => o.holiday === d.holiday && o.name.endsWith("(observed)"))) return false;
        }
      }
      return true;
    })()
  );

  /* ------------------------------------------------------------------ *
   * The feed itself.
   * ------------------------------------------------------------------ */

  const now = new Date(2026, 10, 6, 12, 0, 0);
  const text = Federal.calendar(now);
  const { lines, events } = parseIcs(text);

  check(
    "lines end in CRLF and nothing is bare LF",
    text.endsWith("\r\n") && !/[^\r]\n/.test(text)
  );

  check(
    "one VCALENDAR, opened first and closed last",
    lines[0] === "BEGIN:VCALENDAR" && lines.at(-2) === "END:VCALENDAR" &&
      lines.filter((l) => l === "BEGIN:VCALENDAR").length === 1
  );

  const expectedCount = [2025, 2026, 2027].reduce((n, y) => n + Federal.holidaysOf(y).length, 0);
  check(
    "covers last year, this year and next year",
    events.length === expectedCount &&
      events[0].DTSTART === "20250101" && events.at(-1).DTSTART === "20271225",
    `got ${events.length} events, ${events[0]?.DTSTART} to ${events.at(-1)?.DTSTART}`
  );

  check(
    "every event has a UID, DTSTAMP, all-day DTSTART and DTEND, and a SUMMARY",
    events.every((e) => e.UID && e.DTSTAMP && /^\d{8}$/.test(e.DTSTART) && /^\d{8}$/.test(e.DTEND) && e.SUMMARY) &&
      text.includes("DTSTART;VALUE=DATE:") && text.includes("DTEND;VALUE=DATE:")
  );

  check(
    "every event lasts exactly one day, across month and year ends",
    events.every((e) => {
      const start = Date.UTC(+e.DTSTART.slice(0, 4), +e.DTSTART.slice(4, 6) - 1, +e.DTSTART.slice(6));
      const end = Date.UTC(+e.DTEND.slice(0, 4), +e.DTEND.slice(4, 6) - 1, +e.DTEND.slice(6));
      return end - start === 86400000;
    })
  );

  check(
    "UIDs are unique",
    new Set(events.map((e) => e.UID)).size === events.length
  );

  check(
    "in late December the feed already has next January",
    (() => {
      const dec = parseIcs(Federal.calendar(new Date(2026, 11, 31, 22, 0, 0))).events;
      return dec.some((e) => e.DTSTART === "20270101" && e.SUMMARY === "New Year's Day") &&
        dec.some((e) => e.DTSTART === "20270118");
    })()
  );

  check(
    "the same year always gives the same text, so a refetch changes nothing",
    Federal.calendar(new Date(2026, 0, 1, 0, 5)) === Federal.calendar(new Date(2026, 11, 31, 23, 55))
  );

  check(
    "apostrophes survive and nothing needed escaping",
    events.some((e) => e.SUMMARY === "New Year's Day") && events.some((e) => e.SUMMARY === "Presidents' Day") &&
      !events.some((e) => e.SUMMARY.includes("\\"))
  );
}

/* ---------------------------------------------------------------------- *
 * Fun days.
 * ---------------------------------------------------------------------- */

/* Published dates. Hebrew days are the first full day (the holiday begins at sundown the evening before). */
const KNOWN = {
  "Easter": ["2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28", "2028-04-16"],
  "Mardi Gras": ["2025-03-04", "2026-02-17"],
  "Good Friday": ["2025-04-18", "2026-04-03"],
  "Rosh Hashanah": ["2024-10-03", "2025-09-23", "2026-09-12"],
  "Yom Kippur": ["2024-10-12", "2025-10-02", "2026-09-21"],
  "First day of Hanukkah": ["2024-12-26", "2025-12-15", "2026-12-05"],
  "First day of Passover": ["2024-04-23", "2025-04-13", "2026-04-02"],
  "Purim": ["2024-03-24", "2025-03-14", "2026-03-03"],
  /* 2027 and 2030 are the two years ICU alone gets wrong (new moons at 23:56 and 00:07 Beijing time). */
  "Lunar New Year": ["2024-02-10", "2025-01-29", "2026-02-17", "2027-02-06", "2028-01-26", "2030-02-03"],
  "Mid-Autumn Festival": ["2024-09-17", "2025-10-06", "2026-09-25"],
  "First day of Ramadan": ["2024-03-11", "2025-03-01", "2026-02-18"],
  "Eid al-Fitr": ["2024-04-10", "2025-03-30", "2026-03-20"],
  "Eid al-Adha": ["2024-06-16", "2025-06-06", "2026-05-27"],
  "Tax Day": ["2022-04-18", "2023-04-18", "2024-04-15", "2025-04-15", "2026-04-15", "2028-04-18"],
  "Oktoberfest begins": ["2023-09-16", "2024-09-21", "2025-09-20", "2026-09-19"],
  "Daylight saving time starts": ["2025-03-09", "2026-03-08"],
  "National Napping Day": ["2026-03-09"],
  "Daylight saving time ends": ["2025-11-02", "2026-11-01"],
  "Mother's Day": ["2025-05-11", "2026-05-10"],
  "Father's Day": ["2025-06-15", "2026-06-21"],
  "Grandparents Day": ["2025-09-07", "2026-09-13"],
  "Black Friday": ["2025-11-28", "2026-11-27"],
  "Cyber Monday": ["2025-12-01", "2026-11-30"],
  "Election Day": ["2024-11-05", "2026-11-03", "2028-11-07"],
  "Programmers' Day": ["2024-09-12", "2025-09-13", "2026-09-13"],
  "Inauguration Day": ["2025-01-20", "2029-01-20"],
  "Leap Day": ["2024-02-29", "2028-02-29"],
  "National Hot Dog Day": ["2025-07-16", "2026-07-15"],
  "National Ice Cream Day": ["2025-07-20", "2026-07-19"],
  "Sysadmin Day": ["2025-07-25", "2026-07-31"],
  "National Donut Day": ["2025-06-06", "2026-06-05"],
  /* In Denver: 2025's June solstice is 02:42 UTC on the 21st, the 20th here. */
  "First day of spring": ["2025-03-20", "2026-03-20"],
  "First day of summer": ["2025-06-20", "2026-06-21"],
  "First day of fall": ["2025-09-22", "2026-09-22"],
  "First day of winter": ["2025-12-21", "2026-12-21"],
  "Friday the 13th": ["2026-02-13", "2026-03-13", "2026-11-13"],
  "Pokémon Day": ["2026-02-27"],
  "National Siblings Day": ["2026-04-10"],
  "Aunt and Uncle Day": ["2026-07-26"]
};

/* Equinox and solstice instants, UTC, as the US Naval Observatory publishes them. */
const SEASON_INSTANTS = [
  [2024, "march", "2024-03-20T03:06Z"], [2024, "june", "2024-06-20T20:51Z"],
  [2024, "september", "2024-09-22T12:44Z"], [2024, "december", "2024-12-21T09:20Z"],
  [2025, "march", "2025-03-20T09:01Z"], [2025, "june", "2025-06-21T02:42Z"],
  [2025, "september", "2025-09-22T18:19Z"], [2025, "december", "2025-12-21T15:03Z"],
  [2026, "march", "2026-03-20T14:46Z"], [2026, "june", "2026-06-21T08:24Z"],
  [2026, "september", "2026-09-23T00:05Z"], [2026, "december", "2026-12-21T20:50Z"]
];

/* New moons, UTC. Three are eclipse days, whose timings are well published. */
const NEW_MOONS = [
  "2017-08-21T18:30Z", "2024-04-08T18:21Z", "2025-01-29T12:36Z", "2026-02-17T12:01Z", "2027-02-06T15:56Z"
];

function runFun () {
  console.log("\nFun day checks\n");

  const datesOf = (name, years) => years.flatMap((y) => Fun.funDaysOf(y))
    .filter((d) => d.name === name).map((d) => ymd(d.date));

  for (const [name, expected] of Object.entries(KNOWN)) {
    const years = [...new Set(expected.map((d) => Number(d.slice(0, 4))))];
    const got = datesOf(name, years);
    check(`${name}: ${expected.join(", ")}`, JSON.stringify(got) === JSON.stringify(expected), `got ${got.join(", ") || "nothing"}`);
  }

  check(
    "equinoxes and solstices land within 3 minutes of the published instant",
    SEASON_INSTANTS.every(([y, which, iso]) => Math.abs(Dates.seasonInstant(y, which) - new Date(iso)) < 3 * 60 * 1000),
    SEASON_INSTANTS.map(([y, which, iso]) => `${y} ${which} off by ${Math.round((Dates.seasonInstant(y, which) - new Date(iso)) / 1000)} s`).join("; ")
  );

  check(
    "new moons land within 3 minutes of the published instant (the 2027 one is 4 minutes before Beijing midnight)",
    NEW_MOONS.every((iso) => Math.abs(Dates.newMoonNear(new Date(iso)) - new Date(iso)) < 3 * 60 * 1000),
    NEW_MOONS.map((iso) => `${iso} off by ${Math.round((Dates.newMoonNear(new Date(iso)) - new Date(iso)) / 1000)} s`).join("; ")
  );

  check(
    "no Leap Day or Inauguration Day in the years without one",
    datesOf("Leap Day", [2025, 2026, 2027, 2100]).length === 0 && datesOf("Inauguration Day", [2026, 2027, 2028]).length === 0 &&
      datesOf("Leap Day", [2000]).length === 1
  );

  check(
    "a Gregorian year can hold Eid al-Fitr twice (2033) and gets both",
    datesOf("Eid al-Fitr", [2033]).length === 2
  );

  const names = Fun.DAYS.map(([name]) => name);
  check(
    "every name in the list is unique",
    new Set(names).size === names.length,
    names.filter((n, i) => names.indexOf(n) !== i).join(", ")
  );

  check(
    "no fun day repeats a federal holiday's name",
    !names.some((n) => Federal.RULES.some((r) => r.name === n))
  );

  check(
    "every rule gives each year at least one date, 1990 to 2150, except the ones that skip years",
    (() => {
      const sometimes = new Set(["Leap Day", "Inauguration Day", "Friday the 13th", "Eid al-Fitr", "Eid al-Adha", "First day of Ramadan"]);
      for (let y = 1990; y <= 2150; y += 1) {
        const present = new Set(Fun.funDaysOf(y).map((d) => d.name));
        for (const n of names) if (!sometimes.has(n) && !present.has(n)) return false;
      }
      return true;
    })()
  );

  check(
    "every date a rule gives lies inside its own year",
    (() => {
      for (let y = 2000; y <= 2100; y += 1) {
        if (Fun.funDaysOf(y).some((d) => d.date.getUTCFullYear() !== y)) return false;
      }
      return true;
    })()
  );

  /*
   * September 22 collects six in 2029 and 2040 (Hobbit Day, Ice Cream Cone
   * Day, Public Lands Day, Oktoberfest, the equinox, Sukkot or Mid-Autumn).
   * That is real. The limit is there to catch an edit that piles up more.
   */
  check(
    "never more than six on one day, 2020 to 2060",
    (() => {
      for (let y = 2020; y <= 2060; y += 1) {
        const per = {};
        for (const d of Fun.funDaysOf(y)) per[ymd(d.date)] = (per[ymd(d.date)] ?? 0) + 1;
        if (Math.max(...Object.values(per)) > 6) return false;
      }
      return true;
    })()
  );

  const text = Fun.calendar(new Date(2026, 10, 6, 12));
  const { events } = parseIcs(text);
  const expected = [2025, 2026, 2027].reduce((n, y) => n + Fun.funDaysOf(y).length, 0);

  check(
    "the feed covers last year to next year",
    events.length === expected && events[0].DTSTART.startsWith("2025") && events.at(-1).DTSTART.startsWith("2027"),
    `got ${events.length}, expected ${expected}`
  );

  check(
    "UIDs are unique across the fun feed and do not collide with the federal one",
    (() => {
      const fed = parseIcs(Federal.calendar(new Date(2026, 10, 6, 12))).events.map((e) => e.UID);
      const fun = events.map((e) => e.UID);
      return new Set(fun).size === fun.length && !fun.some((u) => fed.includes(u));
    })()
  );

  check(
    "accented names arrive intact and every line is at most 75 bytes",
    events.some((e) => e.SUMMARY === "Pokémon Day") && events.some((e) => e.SUMMARY === "Día de los Muertos") &&
      text.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)
  );

  check(
    "building three years of fun days takes under 250 ms",
    (() => {
      const start = process.hrtime.bigint();
      Fun.calendar(new Date(2091, 5, 1));
      return Number(process.hrtime.bigint() - start) / 1e6 < 250;
    })()
  );
}

run();
runFun();

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
);

process.exit(failures === 0 ? 0 : 1);
