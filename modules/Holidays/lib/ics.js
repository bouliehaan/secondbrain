"use strict";

/*
 * Writes a list of all-day events as an iCalendar feed (RFC 5545), shaped
 * like the officeholidays.com feed the wall read before: VALUE=DATE starts and
 * ends, one day each. That is the shape MagicMirror's calendar module already
 * parsed without trouble.
 */

const { addDays } = require("./dates");

/** @param {Date} date @returns {string} YYYYMMDD */
const icsDate = (date) => date.toISOString().slice(0, 10).replace(/-/g, "");

/* RFC 5545 3.3.11: TEXT escapes backslash, semicolon, comma and newline. */
const icsText = (text) => String(text)
  .replace(/\\/g, "\\\\")
  .replace(/;/g, "\\;")
  .replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

const slug = (text) => text
  .normalize("NFKD")
  .replace(/\p{M}/gu, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

/*
 * RFC 5545 3.1: a line is at most 75 octets. A longer one is folded by
 * breaking it and starting the next line with a space. This counts bytes,
 * because a name like "Día de los Muertos" uses more bytes than characters.
 */
function fold (line) {
  const out = [];
  let current = "";
  let bytes = 0;

  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }

  out.push(current);
  return out.join("\r\n ");
}

/**
 * @param {object} feed
 * @param {string} feed.name    X-WR-CALNAME
 * @param {string} feed.uidTag  makes UIDs unique across feeds
 * @param {{date: Date, name: string}[]} feed.days
 * @returns {string} with CRLF line endings
 */
function toIcs ({ name, uidTag, days }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//secondbrain//Holidays//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(name)}`
  ];

  for (const day of days) {
    const start = icsDate(day.date);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${start}-${slug(day.name)}@${uidTag}.secondbrain`,
      `DTSTAMP:${start}T000000Z`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(day.date, 1))}`,
      `SUMMARY:${icsText(day.name)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/*
 * Every feed covers last year through next year. MagicMirror looks 365 days
 * ahead (`maximumNumberOfDays`), and in early January the month grid still
 * shows late December.
 */
const yearsAround = (now) => [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

module.exports = { toIcs, yearsAround, icsText, slug };
