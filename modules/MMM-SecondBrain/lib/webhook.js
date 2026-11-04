"use strict";

/*
 * Cards your own scripts put on the wall: a cron job, Home Assistant, a NAS's
 * alert hook -- anything that can make an HTTP request.
 *
 *   POST /secondbrain/webhook
 *   Authorization: Bearer <the token in webhook.json>
 *   Content-Type: application/json
 *
 *   {
 *     "id": "garage",                 required; the same id again replaces the card
 *     "title": "Garage door open",    the card's big line
 *     "detail": "since 9:40 PM",      the small one, if any
 *     "kind": "warning",              the default; or email, voice, package, download, nextcloud
 *     "ttl": 3600                     seconds until it comes down by itself; absent, it stays
 *   }
 *
 *   DELETE /secondbrain/webhook/garage
 *   Authorization: Bearer <token>
 *
 * The route is open to the whole LAN, like the page: MagicMirror's
 * ipWhitelist lets in every private address. So the token is what stops a
 * guest's phone or a smart plug putting "Front door unlocked" on the wall. It
 * is read from /etc/magicmirror-secondbrain/webhook.json on every request, so
 * adding, changing or removing it needs no restart. Without that file the
 * route takes nothing.
 *
 * A bearer token, not ito's signature: the callers here are curl lines and
 * home automation, which can send a header but not compute an HMAC. What that
 * gives up is the token crossing the LAN in the clear, as everything the wall
 * serves does -- it keeps out anything on the network, not something already
 * capturing the network's traffic. A card is keyed by its id, so a replayed
 * request can only put back a card its sender already put up.
 *
 * The answers:
 *
 *   200 {"success": true, "id"}        up (or, for DELETE, down)
 *   401 {"error": "token"}             no token, or not this wall's
 *   404 {"error": "off"}               no webhook.json, or no usable token in it
 *   404 {"error": "Not found"}         DELETE of a card that is not up
 *   400 {"error": ...}                 not JSON, or no id
 *   413 {"error": "size"}              far bigger than a card could be
 *
 * A card goes up without polling anything. Every poll logs in to every
 * mailbox, and a script posting every few seconds must not be able to make
 * that happen more often than the 60s floor allows (docs/ARCHITECTURE.md).
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG_FILE = "webhook.json";

/* Every webhook card's id starts with this; nothing else's does. */
const ID_PREFIX = "webhook:";

/*
 * A card is a few hundred bytes. The cap is only there so nothing on the LAN
 * can make the helper hold megabytes.
 */
const MAX_BODY_BYTES = 16 * 1024;

/*
 * `openssl rand -hex 32` is 64 characters. Thirty-two is the floor, so that
 * "changeme" and the example's placeholder are not tokens; the characters are
 * the ones a bearer token may carry (RFC 6750's token68).
 */
const MIN_TOKEN_LENGTH = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;

const MAX_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 120;
const MAX_DETAIL_LENGTH = 280;

const OFF = { status: 404, body: { error: "off" } };
const BAD_TOKEN = { status: 401, body: { error: "token" } };

/*
 * The token, or why there is none. A file that is there but unreadable is
 * off, never open.
 */
function readToken(configDir) {
  const file = path.join(configDir, CONFIG_FILE);
  let config;

  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { off: error.code === "ENOENT" ? `no ${CONFIG_FILE}` : `${CONFIG_FILE} unreadable: ${error.message}` };
  }

  if (!config || config.enabled === false) {
    return { off: `${CONFIG_FILE} says enabled: false` };
  }

  const token = String(config.token ?? "").trim();

  if (token.length < MIN_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    return { off: `no usable token in ${CONFIG_FILE}` };
  }

  return { token };
}

/*
 * Constant time whatever the lengths: comparing digests, not the strings,
 * says nothing about how long the real token is either.
 */
function sameToken(given, expected) {
  const digest = (value) => crypto.createHash("sha256").update(value).digest();

  return crypto.timingSafeEqual(digest(given), digest(expected));
}

/*
 * Null if the request carries this wall's token; otherwise the answer to
 * give, and a reason for the journal that is never sent back.
 */
function authorize(configDir, headers = {}) {
  const { token, off } = readToken(configDir);

  if (!token) {
    return { ...OFF, reason: off };
  }

  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(String(headers.authorization || ""));

  if (!match) {
    return { ...BAD_TOKEN, reason: headers.authorization ? "not a bearer token" : "no token" };
  }

  if (!sameToken(match[1], token)) {
    return { ...BAD_TOKEN, reason: "wrong token" };
  }

  return null;
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
 * The key a card is filed under, from a POST's id or a DELETE's path, so the
 * two always agree. Empty if it is not one.
 */
function cardKey(id) {
  if (typeof id !== "string" && typeof id !== "number") {
    return "";
  }

  const key = String(id).trim();

  if (key.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    return "";
  }

  return key;
}

function sameCard(a, b) {
  return a.kind === b.kind && a.title === b.title && a.detail === b.detail;
}

/*
 * What a POST's body becomes on the wall: { key, item }, or { error } for a
 * 400. Posting a card that is already up, unchanged, keeps its timestamp, so
 * a script that re-posts to keep a card alive renews its ttl without the
 * wall redrawing.
 */
function cardFrom(payload, previous = null, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Missing 'id' in payload" };
  }

  const key = cardKey(payload.id);

  if (!key) {
    return { error: "Missing 'id' in payload" };
  }

  const ttl = Number(payload.ttl);

  const item = {
    id: `${ID_PREFIX}${key}`,
    kind: typeof payload.kind === "string" && payload.kind ? payload.kind : "warning",
    label: "Webhook",
    title: cut(payload.title, MAX_TITLE_LENGTH) || "Alert",
    detail: cut(payload.detail, MAX_DETAIL_LENGTH),
    timestamp: now,
    expiresAt: typeof payload.ttl === "number" && Number.isFinite(ttl) ? now + ttl * 1000 : null
  };

  if (previous && sameCard(previous, item)) {
    item.timestamp = previous.timestamp;
  }

  return { key, item };
}

module.exports = {
  CONFIG_FILE,
  ID_PREFIX,
  MAX_BODY_BYTES,
  authorize,
  cardKey,
  cardFrom
};
