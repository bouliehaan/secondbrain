"use strict";

/*
 * Calendar arithmetic for the holiday feeds. No I/O, no data.
 *
 * A holiday is a calendar day, not an instant, so every day here is a Date
 * at UTC midnight and is read back with the getUTC* methods. That keeps the
 * process timezone from moving any date. The equinoxes and solstices are the
 * exception: they are instants, and the wall's own timezone decides which
 * local day they fall on (see `season`).
 */

const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;
const WEDNESDAY = 3;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

const DAY_MS = 86400000;

/** @returns {Date} the calendar day year-month-day (month 1-12) */
const utc = (year, month, day) => new Date(Date.UTC(year, month - 1, day));

const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** @returns {string} YYYY-MM-DD */
const ymd = (date) => date.toISOString().slice(0, 10);

/**
 * The nth given weekday of a month, or the last one when nth is -1.
 *
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} weekday 0 = Sunday
 * @param {number} nth 1-5, or -1 for the last
 * @returns {Date}
 */
function nthWeekday (year, month, weekday, nth) {
  if (nth === -1) {
    const last = utc(year, month + 1, 0);
    return addDays(last, -((last.getUTCDay() - weekday + 7) % 7));
  }

  const first = utc(year, month, 1);
  return addDays(first, (weekday - first.getUTCDay() + 7) % 7 + (nth - 1) * 7);
}

/** @returns {Date} the first given weekday on or after date */
const onOrAfter = (date, weekday) => addDays(date, (weekday - date.getUTCDay() + 7) % 7);

/**
 * Western Easter Sunday: the anonymous Gregorian algorithm (Meeus,
 * Astronomical Algorithms, ch. 8). It is exact for every Gregorian year.
 *
 * @param {number} year
 * @returns {Date}
 */
function easter (year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/*
 * The Hebrew, Chinese and Islamic calendars come from the ICU data built into
 * Node (Intl.DateTimeFormat with a -u-ca- calendar), so no table needs
 * updating. Each lookup walks the Gregorian year once per calendar and keeps
 * the result. A lunar year is about 354 days, so a Gregorian year can hold a
 * lunar date twice (Eid al-Fitr in 2033) or not at all. Every match is
 * returned.
 */
const lunarYears = new Map();

function lunarYear (calendar, year) {
  const key = `${calendar}:${year}`;
  if (lunarYears.has(key)) return lunarYears.get(key);

  const format = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, {
    month: calendar === "hebrew" ? "long" : "numeric",
    day: "numeric",
    timeZone: "UTC"
  });

  const days = [];
  for (let date = utc(year, 1, 1); date.getUTCFullYear() === year; date = addDays(date, 1)) {
    const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
    days.push({ date, month: parts.month, day: Number(parts.day) });
  }

  lunarYears.set(key, days);
  return days;
}

/**
 * Every Gregorian day in `year` that is the given day of another calendar.
 *
 * @param {"hebrew"|"chinese"|"islamic-umalqura"} calendar
 * @param {number} year Gregorian
 * @param {string|string[]} month ICU's month: an English name for Hebrew
 *   ("Tishri", "Adar II"), a number as text for the others ("1"; a Chinese
 *   leap month is "6bis" and never matches "6")
 * @param {number} day
 * @returns {Date[]}
 */
function lunar (calendar, year, month, day) {
  const months = Array.isArray(month) ? month : [month];
  const dates = lunarYear(calendar, year)
    .filter((d) => d.day === day && months.includes(d.month))
    .map((d) => d.date);

  return calendar === "chinese" ? dates.map((d) => chineseCorrected(d, day)) : dates;
}

/*
 * A Chinese month starts on the Beijing day of a new moon. ICU computes that
 * new moon with an approximation a few minutes off, so when it falls near
 * Beijing midnight ICU puts the month a day late. That happens in 2027: the
 * new moon is at 23:56 Beijing time on February 6, which is Lunar New Year,
 * and ICU says February 7. ICU is kept for which new moon starts the month,
 * which involves leap months and solar terms. The day comes from the true
 * new moon below, accurate to seconds.
 */
const BEIJING_MS = 8 * 3600 * 1000;

function chineseCorrected (date, dayOfMonth) {
  const icuStart = addDays(date, -(dayOfMonth - 1));
  const moon = new Date(newMoonNear(icuStart).getTime() + BEIJING_MS);
  const start = utc(moon.getUTCFullYear(), moon.getUTCMonth() + 1, moon.getUTCDate());
  return addDays(start, dayOfMonth - 1);
}

/*
 * The true new moon: Meeus, Astronomical Algorithms, ch. 49. The mean
 * lunation, the periodic terms in the Sun's and Moon's anomalies, then the
 * fourteen planetary terms. Good to well under a minute for centuries either
 * side of 2000.
 */
const NEW_MOON_TERMS = [
  // [coefficient, power of E, M multiple, M' multiple, F multiple, Omega multiple]
  [-0.40720, 0, 0, 1, 0, 0], [0.17241, 1, 1, 0, 0, 0], [0.01608, 0, 0, 2, 0, 0],
  [0.01039, 0, 0, 0, 2, 0], [0.00739, 1, -1, 1, 0, 0], [-0.00514, 1, 1, 1, 0, 0],
  [0.00208, 2, 2, 0, 0, 0], [-0.00111, 0, 0, 1, -2, 0], [-0.00057, 0, 0, 1, 2, 0],
  [0.00056, 1, 1, 2, 0, 0], [-0.00042, 0, 0, 3, 0, 0], [0.00042, 1, 1, 0, 2, 0],
  [0.00038, 1, 1, 0, -2, 0], [-0.00024, 1, -1, 2, 0, 0], [-0.00017, 0, 0, 0, 0, 1],
  [-0.00007, 0, 2, 1, 0, 0], [0.00004, 0, 0, 2, -2, 0], [0.00004, 0, 3, 0, 0, 0],
  [0.00003, 0, 1, 1, -2, 0], [0.00003, 0, 0, 2, 2, 0], [-0.00003, 0, 1, 1, 2, 0],
  [0.00003, 0, -1, 1, 2, 0], [-0.00002, 0, -1, 1, -2, 0], [-0.00002, 0, 1, 3, 0, 0],
  [0.00002, 0, 0, 4, 0, 0]
];

const PLANETARY_TERMS = [
  // [coefficient, base degrees, degrees per lunation, T^2 term]
  [0.000325, 299.77, 0.107408, -0.009173], [0.000165, 251.88, 0.016321, 0],
  [0.000164, 251.83, 26.651886, 0], [0.000126, 349.42, 36.412478, 0],
  [0.000110, 84.66, 18.206239, 0], [0.000062, 141.74, 53.303771, 0],
  [0.000060, 207.14, 2.453732, 0], [0.000056, 154.84, 7.306860, 0],
  [0.000047, 34.52, 27.261239, 0], [0.000042, 207.19, 0.121824, 0],
  [0.000040, 291.34, 1.844379, 0], [0.000037, 161.72, 24.198154, 0],
  [0.000035, 239.56, 25.513099, 0], [0.000023, 331.55, 3.592518, 0]
];

const LUNATION = 29.530588861;

/** @param {number} k lunations since the new moon of 2000-01-06 @returns {Date} */
function newMoon (k) {
  const t = k / 1236.85;
  const jde0 = 2451550.09766 + LUNATION * k + 0.00015437 * t ** 2 - 0.000000150 * t ** 3 + 0.00000000073 * t ** 4;
  const e = 1 - 0.002516 * t - 0.0000074 * t ** 2;
  const m = rad(2.5534 + 29.10535670 * k - 0.0000014 * t ** 2 - 0.00000011 * t ** 3);
  const mp = rad(201.5643 + 385.81693528 * k + 0.0107582 * t ** 2 + 0.00001238 * t ** 3 - 0.000000058 * t ** 4);
  const f = rad(160.7108 + 390.67050284 * k - 0.0016118 * t ** 2 - 0.00000227 * t ** 3 + 0.000000011 * t ** 4);
  const om = rad(124.7746 - 1.56375588 * k + 0.0020672 * t ** 2 + 0.00000215 * t ** 3);

  let jde = jde0;
  for (const [c, ep, im, imp, iff, iom] of NEW_MOON_TERMS) {
    jde += c * e ** ep * Math.sin(im * m + imp * mp + iff * f + iom * om);
  }
  for (const [c, base, perK, t2] of PLANETARY_TERMS) {
    jde += c * Math.sin(rad(base + perK * k + t2 * t ** 2));
  }

  return new Date((jde - 2440587.5) * DAY_MS - DELTA_T_MS);
}

/** @param {Date} date @returns {Date} the instant of the new moon nearest to it */
function newMoonNear (date) {
  const jd = date.getTime() / DAY_MS + 2440587.5;
  const k0 = Math.round((jd - 2451550.09766) / LUNATION);
  return [k0 - 1, k0, k0 + 1]
    .map(newMoon)
    .reduce((best, moon) => (Math.abs(moon - date) < Math.abs(best - date) ? moon : best));
}

/*
 * The equinoxes and solstices: Meeus, Astronomical Algorithms, ch. 27 (the
 * mean instant for 2000-3000, then 24 periodic terms). The result is good to
 * about a minute, which only matters when the instant is near local midnight.
 */
const SEASON_MEAN = {
  march: [2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
  june: [2451716.56767, 365241.62603, 0.00325, 0.00888, -0.00030],
  september: [2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
  december: [2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032]
};

const SEASON_TERMS = [
  [485, 324.96, 1934.136], [203, 337.23, 32964.467], [199, 342.08, 20.186],
  [182, 27.85, 445267.112], [156, 73.14, 45036.886], [136, 171.52, 22518.443],
  [77, 222.54, 65928.934], [74, 296.72, 3034.906], [70, 243.58, 9037.513],
  [58, 119.81, 33718.147], [52, 297.17, 150.678], [50, 21.02, 2281.226],
  [45, 247.54, 29929.562], [44, 325.15, 31555.956], [29, 60.93, 4443.417],
  [18, 155.12, 67555.328], [17, 288.79, 4562.452], [16, 198.04, 62894.029],
  [14, 199.76, 31436.921], [12, 95.39, 14577.848], [12, 287.11, 31931.756],
  [12, 320.81, 34777.259], [9, 227.73, 1222.114], [8, 15.45, 16859.074]
];

const rad = (degrees) => (degrees * Math.PI) / 180;

/* Terrestrial time runs about 69 s ahead of UTC this century (delta T). */
const DELTA_T_MS = 69 * 1000;

/**
 * The instant of an equinox or solstice.
 *
 * @param {number} year
 * @param {"march"|"june"|"september"|"december"} which
 * @returns {Date}
 */
function seasonInstant (year, which) {
  const y = (year - 2000) / 1000;
  const [a, b, c, d, e] = SEASON_MEAN[which];
  const jde0 = a + b * y + c * y ** 2 + d * y ** 3 + e * y ** 4;
  const t = (jde0 - 2451545.0) / 36525;
  const w = 35999.373 * t - 2.47;
  const dl = 1 + 0.0334 * Math.cos(rad(w)) + 0.0007 * Math.cos(rad(2 * w));
  const s = SEASON_TERMS.reduce((sum, [A, B, C]) => sum + A * Math.cos(rad(B + C * t)), 0);
  const jde = jde0 + (0.00001 * s) / dl;
  return new Date((jde - 2440587.5) * DAY_MS - DELTA_T_MS);
}

/**
 * The local calendar day of an equinox or solstice, in this process's
 * timezone. The wall runs in its own, so "the first day of summer" is the day
 * it happens there.
 *
 * @returns {Date} as a calendar day (UTC midnight)
 */
function season (year, which) {
  const at = seasonInstant(year, which);
  return utc(at.getFullYear(), at.getMonth() + 1, at.getDate());
}

module.exports = {
  SUNDAY,
  MONDAY,
  TUESDAY,
  WEDNESDAY,
  THURSDAY,
  FRIDAY,
  SATURDAY,
  utc,
  addDays,
  isLeap,
  ymd,
  nthWeekday,
  onOrAfter,
  easter,
  lunar,
  newMoonNear,
  seasonInstant,
  season
};
