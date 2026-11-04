"use strict";

/*
 * Texts, as ito's phone reports them.
 *
 * ito (github.com/bouliehaan/ito) puts an Android phone's texts and calls on a
 * Mac. The phone is on the Wi-Fi all the time, so the phone is what tells the
 * wall: whenever its unread texts change, and every ten minutes besides, it
 * POSTs the whole list here. The list says who, how many and when. It never
 * carries what a text says, so the wall never has it to show or to leak.
 *
 * The wall never asks the phone for anything. Each report is signed with a
 * key only the wall and the phone hold: enable-ito makes it, keeps it in
 * /etc/magicmirror-secondbrain/ito.json, and prints it for pasting into ito on
 * the Mac, which hands it to the phone over ito's own encrypted link. This
 * route is open to the whole LAN, like the page, so the signature is what
 * stops anything else on the network putting "text from Mom" on the wall.
 *
 *   POST /secondbrain/ito
 *   Content-Type: application/x-ito-wall
 *   X-Ito-Time: 1793836800123                  the phone's clock, ms
 *   X-Ito-Signature: hex HMAC-SHA256(key, "ito-wall/1\n" + time + "\n" + body)
 *
 *   {
 *     "v": 1,
 *     "texts": [{
 *       "id": "3fa9c1d2e4b5",                  stable per conversation
 *       "from": "Mom",                         the contact's name, or the number
 *       "n": 2,                                unread texts in it
 *       "at": 1793836700000,                   the newest of them, ms
 *       "group": "family",                     the ito group it is filed in, if any
 *       "person": true                         false: a short code, or a sender like "T-Mobile"
 *     }]
 *   }
 *
 * A report replaces the last one whole. A text read on the phone or on the
 * Mac, or answered from either, is simply missing from the next report, and
 * its card goes. A report more than five minutes off the wall's clock, or no
 * newer than the last one accepted, is refused, so a recorded report cannot
 * be played back later to put old cards up again.
 *
 * The answers, which the phone passes on to the Mac's settings:
 *
 *   200 {"ok": true, "cards": 2}      taken; that many are on the wall now
 *   403 {"error": "signature"}        not signed with this wall's key
 *   403 {"error": "clock", "skewMs"}  signed, but the clocks disagree
 *   409 {"error": "stale"}            older than one already taken
 *   404 {"error": "off"}              enable-ito has not been run here
 *   400 / 413                         not a report, or far too big for one
 *
 * 403 and not 401: there is no login to offer, and a 401 without one makes
 * Java's HTTP client throw the answer away before the phone can read it.
 * MagicMirror's own ipWhitelist also answers 403, with a page instead of
 * JSON, which is how the phone tells the two apart.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG_FILE = "ito.json";

const SIGNATURE_CONTEXT = "ito-wall/1";

/*
 * "An hour or two": a text is somebody wanting you, and a wall is where you
 * look when you are not holding the phone. Two hours, unless it is read or
 * answered first. A short code is a machine -- a code you asked for, a
 * pharmacy reminder -- and gets the half hour a machine's mail gets.
 */
const DEFAULT_TEXT_MINUTES = 120;
const DEFAULT_MACHINE_MINUTES = 30;

/*
 * Five minutes either way. Both ends keep network time; this only has to
 * absorb a phone that has not synced since it booted, and a replay has to
 * fall inside it as well as past the newer-than check.
 */
const MAX_SKEW_MS = 5 * 60 * 1000;

/*
 * A report is a few hundred bytes. The cap is only there so a stranger on
 * the LAN cannot make the helper hold megabytes before it has checked a
 * signature.
 */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TEXTS = 50;

const PRIORITY_PERSON = 100;
const PRIORITY_MACHINE = 70;

/*
 * The last report accepted, and when, on the wall's clock. In memory only: a
 * restarted wall has nothing until the phone's next report, which is at most
 * ten minutes away and sooner if a text arrives.
 */
let latest = null;
let lastSignedAt = 0;

function readConfig(configDir) {
  const file = path.join(configDir, CONFIG_FILE);

  if (!fs.existsSync(file)) {
    return null;
  }

  const config = JSON.parse(fs.readFileSync(file, "utf8"));

  if (!config || config.enabled === false) {
    return null;
  }

  return config;
}

/*
 * The key as enable-ito writes it: 32 random bytes, base64url, no padding.
 * Anything shorter is not a key this wall made.
 */
function keyBytes(config) {
  const text = String(config?.key || "").trim();

  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) {
    return null;
  }

  return Buffer.from(text, "base64url");
}

function sign(key, time, body) {
  return crypto
    .createHmac("sha256", key)
    .update(`${SIGNATURE_CONTEXT}\n${time}\n`)
    .update(body)
    .digest("hex");
}

/*
 * Whether a request is a report from the phone, before anything in it is
 * read. The signature is checked before the clock, so the wall's clock is
 * told only to something that holds the key.
 */
function verify(key, timeHeader, signatureHeader, body, now = Date.now()) {
  const timeText = String(timeHeader || "");
  const signature = String(signatureHeader || "").toLowerCase();

  if (!/^\d{1,16}$/.test(timeText) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { status: 403, error: "signature" };
  }

  const expected = Buffer.from(sign(key, timeText, body), "hex");

  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
    return { status: 403, error: "signature" };
  }

  const time = Number(timeText);
  const skew = time - now;

  if (Math.abs(skew) > MAX_SKEW_MS) {
    return { status: 403, error: "clock", skewMs: skew };
  }

  if (time <= lastSignedAt) {
    return { status: 409, error: "stale" };
  }

  return { status: 200, time };
}

function cut(value, maxLength) {
  const cleaned = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/*
 * Keep the fields above and nothing else. The phone is trusted to say who
 * texted, not to say anything the browser would act on: every string is cut
 * to length here, and the frontend only ever sets textContent.
 */
function sanitizeReport(report) {
  const texts = Array.isArray(report?.texts) ? report.texts : [];
  const seen = new Set();
  const out = [];

  for (const text of texts.slice(0, MAX_TEXTS)) {
    const id = String(text?.id || "").toLowerCase();
    const at = Number(text?.at);

    if (!/^[a-z0-9]{1,32}$/.test(id) || seen.has(id) || !Number.isFinite(at) || at <= 0) {
      continue;
    }

    seen.add(id);

    out.push({
      id,
      from: cut(text.from, 80) || "someone",
      n: Math.max(1, Math.min(999, Math.floor(Number(text.n) || 1))),
      at,
      group: cut(text.group, 60) || null,
      person: text.person !== false
    });
  }

  return { texts: out };
}

function minutesSetting(value, fallback) {
  const minutes = Number(value);

  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

/*
 * One card per conversation: who, and how many, never what. A conversation
 * filed in an ito group says which.
 */
function itoCards(report, config = {}, now = Date.now()) {
  const textMs = minutesSetting(config.textMinutes, DEFAULT_TEXT_MINUTES) * 60000;
  const machineMs = minutesSetting(config.machineMinutes, DEFAULT_MACHINE_MINUTES) * 60000;
  const cards = [];

  for (const text of report?.texts || []) {
    const expiresAt = text.at + (text.person ? textMs : machineMs);

    if (expiresAt <= now) {
      continue;
    }

    const detail = [
      text.n > 1 ? `${text.n} texts` : "",
      text.group ? `in ${text.group}` : ""
    ].filter(Boolean).join(" ");

    cards.push({
      id: `ito:${text.id}`,
      kind: "voice",
      label: "Text",
      title: text.from,
      detail,
      timestamp: text.at,
      expiresAt,
      priority: text.person ? PRIORITY_PERSON : PRIORITY_MACHINE,
      source: "ito"
    });
  }

  return cards;
}

/*
 * Take one request. Never throws: whatever goes wrong becomes a status and a
 * reason for the phone to pass on.
 *
 * @param {string} configDir where ito.json lives
 * @param {object} headers the request's headers, lower-cased as node gives them
 * @param {Buffer} body the raw bytes, exactly as signed
 * @returns {{status: number, body: object, accepted?: boolean}}
 */
function receive(configDir, headers, body, now = Date.now()) {
  let config;

  try {
    config = readConfig(configDir);
  } catch (error) {
    return { status: 500, body: { error: "config", detail: error.message } };
  }

  const key = keyBytes(config);

  if (!key) {
    return { status: 404, body: { error: "off" } };
  }

  if (body.length > MAX_BODY_BYTES) {
    return { status: 413, body: { error: "size" } };
  }

  const verdict = verify(
    key,
    headers["x-ito-time"],
    headers["x-ito-signature"],
    body,
    now
  );

  if (verdict.status !== 200) {
    const { status, ...reason } = verdict;
    return { status, body: reason };
  }

  let report;

  try {
    report = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "body" } };
  }

  if (!report || report.v !== 1) {
    return { status: 400, body: { error: "version" } };
  }

  lastSignedAt = verdict.time;
  latest = { report: sanitizeReport(report), receivedAt: now };

  return {
    status: 200,
    accepted: true,
    body: { ok: true, cards: itoCards(latest.report, config, now).length }
  };
}

/*
 * The cards the last report puts on the wall now. Nothing at all when ito is
 * not set up, whatever was received before it was turned off.
 */
function currentCards(configDir, now = Date.now()) {
  let config;

  try {
    config = readConfig(configDir);
  } catch {
    return [];
  }

  if (!keyBytes(config) || !latest) {
    return [];
  }

  return itoCards(latest.report, config, now);
}

// For the checks: start from nothing, as a freshly started helper does.
function reset() {
  latest = null;
  lastSignedAt = 0;
}

module.exports = {
  CONFIG_FILE,
  MAX_BODY_BYTES,
  MAX_SKEW_MS,
  DEFAULT_TEXT_MINUTES,
  DEFAULT_MACHINE_MINUTES,
  sign,
  verify,
  sanitizeReport,
  itoCards,
  receive,
  currentCards,
  reset
};
