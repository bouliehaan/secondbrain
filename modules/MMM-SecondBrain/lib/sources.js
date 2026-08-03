"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { simpleParser } = require("mailparser");
const { ImapFlow } = require("imapflow");
const { resolveVoiceContact } = require("./contacts");

/*
 * Package state must live outside the module directory. The mirror service runs
 * as `calendar-display` while the deployed module tree is owned by root, so a
 * state file sitting next to this source is unwritable in production.
 */
const DEFAULT_STATE_DIR = "/var/lib/magicmirror-secondbrain";

/*
 * How long a Google Voice notification stays on the wall.
 *
 * This is deliberately not the same knob as the scan window: how far back to
 * look and how long to keep showing something are different questions, and only
 * the second one decides when a text finally leaves the display.
 */
const DEFAULT_VOICE_DISPLAY_MINUTES = 60;

/*
 * A package card outlives the mail that announced it, because retailers stop
 * mentioning a shipment once it has been delivered.
 *
 * It must not outlive it forever, though. An order that never produces a
 * delivery mail -- the common case, since plenty of shipments are only ever
 * "Ordered" or "Shipped" -- used to stay in package_state.json permanently and
 * be republished on every poll. That is why archiving the order and shipping
 * mail did not clear the card: nothing ever removed it. Once no message in the
 * scan has mentioned a shipment for this long, it is forgotten.
 */
const PACKAGE_FORGET_AFTER_MS = 6 * 60 * 60 * 1000;

/* A hard ceiling on a package card's life, whatever its status claims. */
const PACKAGE_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

/*
 * How long a shipment stays on the wall after the last thing anyone said about
 * it. This has to be a *display* rule, not a state one: the mail that created
 * the card is still sitting in All Mail for `packageMaxAgeDays`, so expiring the
 * cached entry would only make the next poll rebuild it from the same message.
 * Bounding the state file stops a card outliving its mail; this is what stops it
 * outliving its usefulness.
 */
const PACKAGE_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/*
 * ImapFlow reports every NO/BAD response as the same bare "Command failed" and
 * hangs the actual reason off the error object. Logging only `message` turns a
 * permanent failure into an undiagnosable one -- which is exactly what the
 * Proton path did. `executedCommand` is ImapFlow's own logging copy, compiled
 * with credentials already masked.
 */
function imapErrorDetail(error) {
  if (!error) {
    return "unknown error";
  }

  const parts = [error.message || String(error)];

  if (error.responseText && error.responseText !== error.message) {
    parts.push(error.responseText);
  }

  if (error.serverResponseCode) {
    parts.push(`[${error.serverResponseCode}]`);
  }

  if (error.authenticationFailed) {
    parts.push("authentication failed");
  }

  if (error.code && error.code !== error.serverResponseCode) {
    parts.push(`(${error.code})`);
  }

  if (error.executedCommand) {
    parts.push(`while running: ${error.executedCommand}`);
  }

  return parts.join(" — ");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(directory, name));
}

function cleanText(value, maxLength = 180) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/*
 * A short deterministic digest of the given parts, used to key items that carry
 * no natural identifier. The same message must yield the same id on every poll,
 * otherwise deduplication never converges and the state file grows without end.
 */
function stableKey(...parts) {
  return crypto
    .createHash("sha1")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

function messageTimestamp(message) {
  return new Date(
    message?.internalDate ||
    message?.envelope?.date ||
    Date.now()
  ).getTime();
}

function stripGoogleVoiceBoilerplate(value) {
  let text = String(value || "")
    .replace(/\r/g, "")
    .trim();

  text = text.replace(
    /^\s*(?:<https?:\/\/voice\.google\.com(?:\/[^>]*)?>|https?:\/\/voice\.google\.com(?:\/\S*)?)\s*/i,
    ""
  );

  text = text.replace(
    /^\s*(?:\[?Google Voice\]?(?:\s*\([^)\n]*\)|\s*<?https?:\/\/[^\s>]+>?)?)\s*/i,
    ""
  );

  text = text.replace(
    /\s*To\s+respond\s+to\s+this(?:\s+text)?\s+message,\s*reply\s+to\s+this\s+email\s+or\s+visit\s+Google\s+Voice\.?[\s\S]*$/i,
    ""
  );

  text = text.replace(
    /(?:^|\n)\s*(?:YOUR ACCOUNT\b|HELP CENTER\b|HELP FORUM\b|This email was sent to you because\b|Google LLC\b|1600 Amphitheatre Pkwy\b)[\s\S]*$/im,
    ""
  );

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  while (
    lines.length > 0 &&
    /^Google Voice(?:\s*<?https?:\/\/\S+>?)?$/i.test(lines[0])
  ) {
    lines.shift();
  }

  return lines.join(" ").trim();
}

function ageText(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));

  if (seconds < 60) {
    return "now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function voiceClassification(from, subject) {
  const sender = String(from || "").toLowerCase();
  const topic = String(subject || "").toLowerCase();
  const combined = `${sender} ${topic}`;

  const looksLikeVoice =
    sender.includes("@txt.voice.google.com") ||
    sender.includes("@voice.google.com") ||
    topic.includes("google voice");

  if (!looksLikeVoice) {
    return null;
  }

  if (combined.includes("missed call")) {
    return "Missed call";
  }

  if (combined.includes("voicemail")) {
    return "Voicemail";
  }

  if (
    combined.includes("text message") ||
    combined.includes("new message") ||
    combined.includes("sms")
  ) {
    return "Voice message";
  }

  return "Google Voice";
}

function envelopeIdentity(addresses) {
  const first = Array.isArray(addresses) ? addresses[0] : null;
  if (!first) {
    return {
      address: "",
      display: "Unknown sender"
    };
  }

  return {
    address: first.address || "",
    display: first.name || first.address || "Unknown sender"
  };
}

function envelopeAddress(addresses) {
  const first = Array.isArray(addresses) ? addresses[0] : null;
  if (!first) {
    return "Unknown sender";
  }

  return first.name || first.address || "Unknown sender";
}

/*
 * A configured name wins; special-use is the fallback, not the override.
 *
 * Resolving special-use first meant `packageMailbox: "INBOX"` silently kept
 * scanning All Mail, because the \All folder was matched before the requested
 * name was ever looked at -- the setting appeared to do nothing at all.
 *
 * Falling back to special-use still covers the case it was added for: Gmail
 * localises its visible folder names, so a default like "All Mail" will not
 * match by name on a non-English account, and \All finds it anyway.
 */
function resolveMailbox(mailboxes, requested, specialUse = null) {
  const name = String(requested || "").trim();

  const exact = mailboxes.find((mailbox) => mailbox.path === name);
  if (exact) {
    return exact.path;
  }

  const lowered = name.toLowerCase();
  const insensitive = mailboxes.find(
    (mailbox) => String(mailbox.path || "").toLowerCase() === lowered
  );
  if (insensitive) {
    return insensitive.path;
  }

  if (specialUse) {
    const special = mailboxes.find(
      (mailbox) => String(mailbox.specialUse || "").toLowerCase() === specialUse.toLowerCase()
    );
    if (special) {
      return special.path;
    }
  }

  return null;
}

/*
 * Decode a raw message once, returning both the readable text and a
 * whitespace-free copy of it.
 *
 * Tracking numbers are routinely split across line breaks, so carrier patterns
 * are matched against the compact form. Both are built from the decoded body and
 * never from the raw MIME source, whose base64 attachment blocks are otherwise a
 * rich source of phantom 12- and 15-digit "tracking numbers".
 */
async function decodeMessage(source) {
  if (!source) {
    return { text: "", compact: "" };
  }

  try {
    const parsed = await simpleParser(source, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true
    });

    const text = String(parsed.text || "");

    return { text, compact: text.replace(/\s+/g, "") };
  } catch {
    return { text: "", compact: "" };
  }
}

async function parsedPreview(source, maxLength = 180) {
  const { text } = await decodeMessage(source);
  return cleanText(stripGoogleVoiceBoilerplate(text), maxLength);
}

/*
 * Return envelope summaries for the newest messages in the open mailbox, keeping
 * only those inside the time window.
 *
 * Gmail's time-based IMAP SEARCH has been observed returning no UIDs even when
 * matching messages are present, so a bounded range of the newest sequence
 * numbers is scanned instead and the window is enforced locally.
 */
async function fetchRecentSummaries(client, since, scanLimit) {
  const messageCount = Number(client.mailbox?.exists || 0);

  if (messageCount <= 0) {
    return [];
  }

  const firstSequence = Math.max(1, messageCount - scanLimit + 1);

  const summaries = await client.fetchAll(
    `${firstSequence}:*`,
    { envelope: true, internalDate: true },
    { uid: false }
  );

  const threshold =
    since instanceof Date ? since.getTime() : new Date(since).getTime();

  return summaries.filter((message) => {
    const timestamp = messageTimestamp(message);
    return Number.isFinite(timestamp) && timestamp >= threshold;
  });
}

/*
 * Attach raw bodies to already-selected summaries. Bodies are fetched only after
 * filtering, so a full mailbox is never downloaded.
 */
async function attachSources(client, messages) {
  const completed = [];

  for (const message of messages) {
    let rawSource = null;

    try {
      const fullMessage = await client.fetchOne(
        message.uid,
        { source: true },
        { uid: true }
      );

      rawSource = fullMessage?.source || null;
    } catch {
      // Header data alone is still enough to display a notification.
    }

    completed.push({ ...message, source: rawSource });
  }

  return completed;
}

async function fetchUnreadMailbox(client, mailbox, since, maxResults) {
  let lock;

  try {
    /*
     * readOnly matters: without it the fetch below sets \Seen, so the mirror
     * would silently mark real mail as read and the notification would vanish
     * after a single poll.
     */
    lock = await client.getMailboxLock(mailbox, { readOnly: true });

    const uids = await client.search({ seen: false, since }, { uid: true });
    const selected = uids
      .sort((a, b) => b - a)
      .slice(0, Math.max(1, Number(maxResults || 8)));

    if (selected.length === 0) {
      return [];
    }

    return await client.fetchAll(
      selected,
      {
        envelope: true,
        internalDate: true,
        source: true
      },
      { uid: true }
    );
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

async function fetchRecentMailbox(client, mailbox, since, maxResults) {
  let lock;

  try {
    lock = await client.getMailboxLock(mailbox, { readOnly: true });

    const resultLimit = Math.max(1, Number(maxResults || 100));
    const scanLimit = Math.min(250, Math.max(50, resultLimit * 2));

    const selected = (await fetchRecentSummaries(client, since, scanLimit))
      .sort((a, b) => Number(b.uid || 0) - Number(a.uid || 0))
      .slice(0, resultLimit);

    return await attachSources(client, selected);
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Package tracking
 * ------------------------------------------------------------------ */

const PACKAGE_SENDER_HINTS = ["amazon", "newegg", "shipment-tracking"];

const PACKAGE_SUBJECT_HINTS = [
  "tracking",
  "shipped",
  "delivery",
  "delivered",
  "order",
  "receipt",
  "purchase",
  "confirmation",
  "payment"
];

function looksLikePackageMail(message) {
  const subject = String(message.envelope?.subject || "").toLowerCase();
  const from = message.envelope?.from?.[0];
  const sender = String(from?.address || from?.name || "").toLowerCase();

  return (
    PACKAGE_SENDER_HINTS.some((hint) => sender.includes(hint)) ||
    PACKAGE_SUBJECT_HINTS.some((hint) => subject.includes(hint))
  );
}

/*
 * Scan the newest slice of a mailbox for order and shipping mail.
 *
 * The scan is bounded by sequence number rather than by an open-ended SEARCH, so
 * that a busy All Mail folder cannot turn one poll into thousands of envelope
 * fetches.
 */
async function fetchPackageEmails(client, mailbox, since, options = {}, log = console) {
  let lock;

  try {
    lock = await client.getMailboxLock(mailbox, { readOnly: true });

    const scanLimit = Math.min(500, Math.max(50, Number(options.scanLimit || 250)));
    const resultLimit = Math.max(1, Number(options.maxResults || 15));

    const candidates = (await fetchRecentSummaries(client, since, scanLimit))
      .filter(looksLikePackageMail)
      .sort((a, b) => Number(b.uid || 0) - Number(a.uid || 0))
      .slice(0, resultLimit);

    return await attachSources(client, candidates);
  } catch (error) {
    log.error(
      `[MMM-SecondBrain] Package scan of '${mailbox}' failed: ${imapErrorDetail(error)}`
    );
    return null;
  } finally {
    if (lock) {
      lock.release();
    }
  }
}

const ETA_PATTERN =
  /(?:Arriving|Estimated delivery|Expected delivery|Scheduled delivery|Delivery date).{0,15}?([A-Za-z]+,\s*[A-Za-z]+\s*\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]+\s+\d{1,2}|[A-Za-z]+\s+by\s+\d{1,2}\s*[A-Za-z]+)/i;

/*
 * Each identifier is matched twice, because neither pass alone is sufficient.
 *
 * The strict pass runs against the readable text and requires a non-alphanumeric
 * character or a string edge on both sides. Word boundaries are intact there, so
 * this is the high-confidence match.
 *
 * The relaxed pass runs against the whitespace-stripped copy, which is the only
 * way to catch an identifier the sending mail client wrapped across two lines.
 * Stripping whitespace also glues the number to the words on either side of it,
 * so boundary punctuation cannot be required at all. Instead the guard only
 * forbids extending the match within its own character class -- enough to stop a
 * 12-digit pattern matching the middle of a 20-digit run, which is the failure
 * mode that actually matters.
 */
const TRACKING_PATTERNS = {
  usps: {
    body: "(94001\\d{17}|92055\\d{17}|94073\\d{17}|93033\\d{17}|92060\\d{17}|92039\\d{17}|92050\\d{17})",
    guard: "\\d"
  },
  ups: {
    body: "(1Z[0-9A-Z]{16})",
    guard: "0-9A-Z",
    flags: "i"
  },
  fedex: {
    body: "(\\d{15}|\\d{12})",
    guard: "\\d"
  },
  amazonOrder: {
    body: "(\\d{3}-\\d{7}-\\d{7})",
    guard: "\\d"
  }
};

function compilePatterns({ body, guard, flags = "" }) {
  return {
    strict: new RegExp(`(?:[^A-Za-z0-9]|^)${body}(?:[^A-Za-z0-9]|$)`, flags),
    relaxed: new RegExp(`(?<![${guard}])${body}(?![${guard}])`, flags)
  };
}

const COMPILED_TRACKING = Object.fromEntries(
  Object.entries(TRACKING_PATTERNS).map(([key, spec]) => [key, compilePatterns(spec)])
);

function findTracking(key, text, compact) {
  const { strict, relaxed } = COMPILED_TRACKING[key];
  return text.match(strict) || compact.match(relaxed);
}

const GENERIC_ORDER_PATTERN =
  /Order\s*(?:(?:number\s+|no\.?\s*|#\s*|:\s*)([A-Za-z0-9-]*\d[A-Za-z0-9-]*)|([A-Za-z0-9-]*\d[A-Za-z0-9-]{3,}))/i;

function detectCarrier(compact, text, subject) {
  const usps = findTracking("usps", text, compact);
  if (usps) {
    return { carrier: "USPS", trackingId: usps[1] };
  }

  const ups = findTracking("ups", text, compact);
  if (ups) {
    return { carrier: "UPS", trackingId: ups[1].toUpperCase() };
  }

  /*
   * A bare run of 12 or 15 digits is far too weak a signal on its own, so a
   * FedEx number is only accepted when the message actually names FedEx.
   */
  const mentionsFedex = /fedex/i.test(text) || /fedex/i.test(subject);
  const fedex = mentionsFedex ? findTracking("fedex", text, compact) : null;
  if (fedex) {
    return { carrier: "FedEx", trackingId: fedex[1] };
  }

  return { carrier: null, trackingId: null };
}

function storeNameFor(senderDisplayName, sender) {
  if (senderDisplayName) {
    return senderDisplayName;
  }

  if (sender.includes("newegg.com")) {
    return "Newegg";
  }

  if (sender.includes("@")) {
    const domain = sender.split("@")[1].split(".")[0];
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }

  return "Store";
}

async function extractPackageInfo(message) {
  const subject = message.envelope?.subject || "";
  const from = message.envelope?.from?.[0];
  const sender = String(from?.address || from?.name || "").toLowerCase();
  const senderDisplayName = from?.name || "";

  const timestamp = messageTimestamp(message);
  const s = subject.toLowerCase();

  const { text, compact } = await decodeMessage(message.source);

  const etaMatch = text.match(ETA_PATTERN);
  const etaString = etaMatch?.[1]?.trim() || "";

  const { carrier, trackingId } = detectCarrier(compact, text, subject);

  const withEta = (detail, status) =>
    etaString && status !== "Delivered" ? `${detail} (ETA: ${etaString})` : detail;

  const isAmazon =
    sender.includes("amazon") ||
    s.includes("amazon.com order") ||
    sender.includes("shipment-tracking");

  const genericOrderMatch =
    subject.match(GENERIC_ORDER_PATTERN) || text.match(GENERIC_ORDER_PATTERN);
  const genOrderId = genericOrderMatch
    ? genericOrderMatch[1] || genericOrderMatch[2]
    : null;

  /* ---- Storefront order mail (Newegg and friends) ---- */
  if (
    !isAmazon &&
    (genOrderId ||
      sender.includes("newegg.com") ||
      s.includes("order confirmed") ||
      s.includes("receipt for order") ||
      s.includes("your order"))
  ) {
    if (
      s.includes("refund") || s.includes("canceled") || s.includes("cancelled") ||
      s.includes("return") || s.includes("cancellation")
    ) {
      return null;
    }

    const lowerBody = text.toLowerCase();

    if (lowerBody.includes("refund")) {
      return null;
    }

    const isPhysical =
      lowerBody.includes("shipping") ||
      lowerBody.includes("shipped") ||
      lowerBody.includes(" delivery") ||
      lowerBody.includes("package") ||
      lowerBody.includes("tracking") ||
      lowerBody.includes("arriving") ||
      lowerBody.includes("on the way");

    // Digital bills and subscriptions carry no physical-shipment signal at all.
    if (!isPhysical && !carrier && !trackingId && !s.includes("shipped")) {
      return null;
    }

    let status = "Ordered";
    if (
      s.includes("delivered:") || s.includes("delivery confirmation") ||
      s.includes("delivered")
    ) {
      status = "Delivered";
    } else if (
      s.includes("shipped") || s.includes("on the way") || s.includes("has shipped")
    ) {
      status = "Shipped";
    }

    const storeName = storeNameFor(senderDisplayName, sender);
    const orderKey = genOrderId || `unknown-${stableKey(sender, subject, timestamp)}`;
    const itemName = genOrderId
      ? `${storeName} Order #${genOrderId}`
      : `${storeName} Order`;

    return {
      id: `package:${storeName.toLowerCase()}:${orderKey}`,
      kind: "package",
      label: carrier || storeName,
      title: cleanText(itemName, 100),
      detail: withEta(trackingId ? `${status} (${carrier || "Tracking"})` : status, status),
      timestamp,
      priority: 95,
      status,
      orderId: genOrderId,
      trackingId
    };
  }

  /* ---- Amazon ---- */
  if (isAmazon) {
    if (s.includes("refund") || s.includes("return") || s.includes("cancellation")) {
      return null;
    }

    if (s.includes("subscribe & save") && !s.includes("shipped")) {
      return null;
    }

    let status = "Ordered";
    if (
      s.includes("delivered") || s.includes("delivery notification") ||
      s.includes("delivery confirmation")
    ) {
      status = "Delivered";
    } else if (
      s.includes("out for delivery") || s.includes("arriving today") ||
      s.includes("expected today") || s.includes("scheduled for delivery")
    ) {
      status = "Out for delivery";
    } else if (s.includes("shipped") || s.includes("on the way")) {
      status = "Shipped";
    } else if (s.includes("delayed") || s.includes("update on")) {
      status = "Delayed";
    }

    const titleMatch =
      subject.match(/order of "([^"]+)"/i) ||
      subject.match(/Delivered:\s*(.+)/i) ||
      subject.match(/Out for delivery:\s*(.+)/i) ||
      subject.match(/Arriving today:\s*(.+)/i) ||
      subject.match(/Shipped:\s*(.+)/i);

    // Amazon quotes the item in some subject forms and not others.
    const itemName = titleMatch
      ? titleMatch[1].trim().replace(/^"(.*)"$/s, "$1")
      : "Amazon Package";

    const amazonOrder = findTracking("amazonOrder", `${subject}\n${text}`, compact);
    const orderId = amazonOrder
      ? amazonOrder[1]
      : `unknown-${stableKey("amazon", itemName)}`;

    return {
      id: `package:amazon:${orderId}`,
      kind: "package",
      label: carrier || "Amazon",
      title: cleanText(itemName, 100),
      detail: withEta(trackingId ? `${status} (${carrier})` : status, status),
      timestamp,
      priority: 95,
      status,
      orderId,
      trackingId
    };
  }

  /* ---- Bare carrier notification from anyone else ---- */
  if (trackingId && carrier) {
    let status = "Shipped";
    let detail = "On the way";

    if (
      s.includes("delivered") || s.includes("delivery notification") ||
      s.includes("delivery confirmation")
    ) {
      status = "Delivered";
      detail = "Delivered";
    } else if (
      s.includes("out for delivery") || s.includes("arriving today") ||
      s.includes("expected today") || s.includes("scheduled for delivery")
    ) {
      status = "Out for delivery";
      detail = "Out for delivery";
    } else if (s.includes("delayed") || s.includes("update on")) {
      status = "Delayed";
      detail = "Delayed";
    }

    return {
      id: `package:${carrier.toLowerCase()}:${trackingId}`,
      kind: "package",
      label: carrier,
      title: `Tracking: ${trackingId}`,
      detail: withEta(detail, status),
      timestamp,
      priority: 95,
      status,
      orderId: null,
      trackingId
    };
  }

  return null;
}

/*
 * Run the package scan for one already-connected account. Failures are contained
 * here so that a bad package scan can never take down ordinary mail polling.
 */
async function collectPackages(client, mailbox, account, results, log, report = null) {
  if (!mailbox || account.monitorPackages === false) {
    return;
  }

  const maxAgeDays = Math.max(1, Number(account.packageMaxAgeDays || 7));
  const since = new Date(Date.now() - maxAgeDays * 86400000);

  const messages = await fetchPackageEmails(
    client,
    mailbox,
    since,
    {
      scanLimit: account.packageScanLimit,
      maxResults: account.packageMaxResults
    },
    log
  );

  /*
   * A failed scan returns null rather than an empty array. The difference
   * matters: "the mailbox holds no package mail" and "the mailbox could not be
   * read" look identical downstream, and treating the second as the first would
   * let one outage expire every remembered shipment.
   */
  if (messages === null) {
    return;
  }

  if (report) {
    report.scanned = true;
  }

  for (const message of messages) {
    try {
      const info = await extractPackageInfo(message);
      if (info) {
        results.push(info);
      }
    } catch (error) {
      log.error(`[MMM-SecondBrain] Package parse failed: ${error.message}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Mail sources
 * ------------------------------------------------------------------ */

async function pollGmail(configDir, log = console, report = null) {
  const accountsDir = path.join(configDir, "gmail", "accounts");
  const results = [];

  for (const accountPath of listJsonFiles(accountsDir)) {
    let client;

    try {
      const account = readJson(accountPath);
      if (account.enabled === false || !account.password) {
        continue;
      }

      const accountName = account.displayName || account.email || account.alias || "Gmail";
      const alias = account.alias || account.email || "account";

      /*
       * One window governs every Google Voice card, whichever mailbox it was
       * found in. A text picked up from the important mailbox used to have no
       * age limit at all beyond maxAgeDays, so it sat on the wall until it was
       * read for real -- up to a fortnight.
       */
      const voiceDisplayMs =
        Math.max(
          1,
          Number(account.voiceDisplayMinutes || DEFAULT_VOICE_DISPLAY_MINUTES)
        ) * 60000;

      const voiceHasExpired = (timestamp) =>
        Date.now() - Number(timestamp || 0) > voiceDisplayMs;

      client = new ImapFlow({
        host: account.host || "imap.gmail.com",
        port: Number(account.port || 993),
        secure: account.secure !== false,
        auth: {
          user: account.username || account.email,
          pass: account.password
        },
        tls: {
          rejectUnauthorized: account.rejectUnauthorized !== false
        },
        logger: false
      });

      await client.connect();
      const mailboxes = await client.list();

      const importantMailbox = resolveMailbox(
        mailboxes,
        account.importantMailbox || "Wall-Display"
      );

      if (!importantMailbox) {
        log.error(
          `[MMM-SecondBrain] Gmail mailbox '${account.importantMailbox || "Wall-Display"}' ` +
          "was not found. Important-email polling is skipped; other sources continue."
        );
      }

      if (importantMailbox) {
        const importantSince = new Date(
          Date.now() - Number(account.maxAgeDays || 14) * 86400000
        );

        const importantMessages = await fetchUnreadMailbox(
          client,
          importantMailbox,
          importantSince,
          Number(account.maxResults || 8)
        );

        for (const message of importantMessages) {
          const sender = envelopeIdentity(message.envelope?.from);
          const subject = message.envelope?.subject || "No subject";
          const timestamp = messageTimestamp(message);
          const voiceLabel = voiceClassification(sender.address, subject);

          // A text routed into the important mailbox is still a text.
          if (voiceLabel && voiceHasExpired(timestamp)) {
            continue;
          }

          const voiceContact = voiceLabel
            ? await resolveVoiceContact(configDir, subject, sender.address, log)
            : null;
          const preview = await parsedPreview(message.source, 180);
          const messageKey =
            message.envelope?.messageId || `${importantMailbox}:${message.uid}`;

          results.push({
            id: `gmail:${alias}:${messageKey}`,
            kind: voiceLabel ? "voice" : "email",
            label: voiceLabel || `Email · ${accountName}`,
            title: voiceLabel
              ? cleanText(voiceContact?.name || subject, 110)
              : `${cleanText(sender.display, 70)} — ${cleanText(subject, 100)}`,
            detail: stripGoogleVoiceBoilerplate(preview),
            timestamp,
            priority: voiceLabel ? 100 : 75,
            source: accountName
          });
        }
      }

      const packageMailbox =
        resolveMailbox(mailboxes, account.packageMailbox || "All Mail", "\\All") ||
        importantMailbox;

      await collectPackages(client, packageMailbox, account, results, log, report);

      if (account.monitorVoice !== false) {
        const voiceMailbox = resolveMailbox(
          mailboxes,
          account.voiceMailbox || "INBOX",
          "\\Inbox"
        );

        if (!voiceMailbox) {
          throw new Error("Gmail INBOX could not be found for Google Voice monitoring.");
        }

        /*
         * How far back to look. Scanning a shorter span than the display window
         * would retire a text early no matter what the display window says, so
         * the two are kept consistent here rather than left to config.
         */
        const voiceMaxAgeMinutes = Math.max(
          5,
          Number(account.voiceMaxAgeMinutes || 60),
          voiceDisplayMs / 60000
        );
        const voiceSince = new Date(Date.now() - voiceMaxAgeMinutes * 60000);
        const voiceMessages = await fetchRecentMailbox(
          client,
          voiceMailbox,
          voiceSince,
          Number(account.voiceMaxResults || 100)
        );

        for (const message of voiceMessages) {
          const sender = envelopeIdentity(message.envelope?.from);
          const subject = message.envelope?.subject || "Google Voice";
          const voiceLabel = voiceClassification(sender.address, subject);

          if (!voiceLabel) {
            continue;
          }

          const timestamp = messageTimestamp(message);

          if (voiceHasExpired(timestamp)) {
            continue;
          }

          const voiceContact = await resolveVoiceContact(
            configDir,
            subject,
            sender.address,
            log
          );
          const preview = await parsedPreview(message.source, 180);
          const messageKey = message.envelope?.messageId || `${voiceMailbox}:${message.uid}`;

          results.push({
            id: `gmail:${alias}:${messageKey}`,
            kind: "voice",
            label: voiceLabel,
            title: cleanText(voiceContact?.name || subject, 110),
            detail: stripGoogleVoiceBoilerplate(preview),
            timestamp,
            priority: 100,
            source: accountName
          });
        }
      }
    } catch (error) {
      log.error(
        `[MMM-SecondBrain] Gmail IMAP account ${path.basename(accountPath)} failed: ` +
        imapErrorDetail(error)
      );
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          // The server may already have closed the connection.
        }
      }
    }
  }

  return results;
}

async function pollProton(configDir, log = console, report = null) {
  const accountsDir = path.join(configDir, "proton", "accounts");
  const results = [];

  for (const accountPath of listJsonFiles(accountsDir)) {
    let client;

    try {
      const account = readJson(accountPath);
      if (account.enabled === false) {
        continue;
      }

      client = new ImapFlow({
        host: account.host || "127.0.0.1",
        port: Number(account.port || 1143),
        secure: Boolean(account.secure),
        auth: {
          user: account.username,
          pass: account.password
        },
        tls: {
          rejectUnauthorized: account.rejectUnauthorized === true
        },
        logger: false
      });

      await client.connect();

      const mailboxes = await client.list();
      const requestedMailbox = account.mailbox || "All Mail";

      /*
       * Prefer the IMAP special-use All Mail folder. This stays reliable even if
       * Bridge presents the visible folder name differently.
       */
      const mailbox = resolveMailbox(mailboxes, requestedMailbox, "\\All");

      if (!mailbox) {
        throw new Error(`Proton mailbox '${requestedMailbox}' was not found`);
      }

      const accountName = account.displayName || account.alias || "Proton Mail";
      const since = new Date(Date.now() - Number(account.maxAgeDays || 14) * 86400000);

      let lock;
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true });

        const uids = await client.search({ seen: false, since }, { uid: true });
        const selected = uids
          .sort((a, b) => b - a)
          .slice(0, Number(account.maxResults || 8));

        if (selected.length > 0) {
          const messages = await client.fetchAll(
            selected,
            { envelope: true, internalDate: true },
            { uid: true }
          );

          for (const message of messages) {
            results.push({
              id: `proton:${account.alias || "account"}:${message.uid}`,
              kind: "email",
              label: `Proton · ${accountName}`,
              title:
                `${cleanText(envelopeAddress(message.envelope?.from), 70)} — ` +
                `${cleanText(message.envelope?.subject || "No subject", 105)}`,
              detail: `Unread in ${mailbox}`,
              timestamp: messageTimestamp(message),
              priority: 78,
              source: accountName
            });
          }
        }
      } finally {
        if (lock) {
          lock.release();
        }
      }

      await collectPackages(client, mailbox, account, results, log, report);
    } catch (error) {
      log.error(
        `[MMM-SecondBrain] Proton account ${path.basename(accountPath)} failed: ` +
        imapErrorDetail(error)
      );
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          // Bridge may already have closed the connection.
        }
      }
    }
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Transmission
 * ------------------------------------------------------------------ */

async function transmissionRpc(config, payload) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (config.username) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password || ""}`).toString("base64")}`;
  }

  let response = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });

  if (response.status === 409) {
    const sessionId = response.headers.get("x-transmission-session-id");
    if (!sessionId) {
      throw new Error("Transmission requested a session ID but did not return one");
    }

    headers["X-Transmission-Session-Id"] = sessionId;
    response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
  }

  if (!response.ok) {
    throw new Error(`Transmission RPC returned HTTP ${response.status}`);
  }

  const result = await response.json();
  if (result.result && result.result !== "success") {
    throw new Error(`Transmission RPC error: ${result.result}`);
  }

  return result.arguments || result.params || {};
}

function formatBytesPerSecond(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) {
    return `${bytes} B/s`;
  }
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
}

function formatEta(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0 || value >= 31536000) {
    return "ETA unknown";
  }

  if (value < 60) {
    return "under 1 min";
  }

  const minutes = Math.round(value / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

async function pollTransmission(configDir, log = console) {
  const configPath = path.join(configDir, "transmission.json");
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const config = readJson(configPath);
  if (config.enabled === false) {
    return [];
  }

  try {
    const response = await transmissionRpc(
      {
        url: config.url || "http://127.0.0.1:9091/transmission/rpc",
        username: config.username || "",
        password: config.password || ""
      },
      {
        method: "torrent-get",
        arguments: {
          fields: [
            "id",
            "name",
            "status",
            "percentDone",
            "rateDownload",
            "eta",
            "error",
            "errorString",
            "addedDate",
            "doneDate",
            "isFinished"
          ]
        }
      }
    );

    const now = Date.now();
    const completedWindow = Number(config.recentCompletedMinutes || 45) * 60000;
    const results = [];

    for (const torrent of response.torrents || []) {
      const progress = Math.round(Number(torrent.percentDone || 0) * 100);
      const hasError = Number(torrent.error || 0) !== 0;
      const downloading = [3, 4].includes(Number(torrent.status)) && progress < 100;
      const addedTimestamp = Number(torrent.addedDate || 0) * 1000 || now;
      const doneTimestamp = Number(torrent.doneDate || 0) * 1000;
      const recentlyCompleted =
        progress >= 100 &&
        doneTimestamp > 0 &&
        now - doneTimestamp <= completedWindow;

      if (hasError) {
        results.push({
          id: `transmission:error:${torrent.id}`,
          kind: "warning",
          label: "Transmission error",
          title: cleanText(torrent.name, 120),
          detail: cleanText(torrent.errorString || "Download error", 170),
          timestamp: now,
          priority: 90
        });
        continue;
      }

      if (downloading) {
        results.push({
          id: `transmission:active:${torrent.id}`,
          kind: "download",
          label: "Downloading",
          title: cleanText(torrent.name, 120),
          detail: `${progress}% · ${formatBytesPerSecond(torrent.rateDownload)} · ${formatEta(torrent.eta)}`,
          /*
           * When it was added, not when it was polled. Every active torrent
           * shares a priority, so timestamp is the only thing separating them;
           * stamping them all with `now` left the sort a no-op and handed the
           * single download slot to whichever torrent Transmission listed first
           * -- which is ID order, so always the oldest one still running.
           */
          timestamp: addedTimestamp,
          priority: 45,
          progress
        });
        continue;
      }

      if (recentlyCompleted) {
        results.push({
          id: `transmission:done:${torrent.id}`,
          kind: "download",
          label: "Download finished",
          title: cleanText(torrent.name, 120),
          detail: "Ready",
          timestamp: doneTimestamp,
          priority: 35,
          progress: 100
        });
      }
    }

    return results;
  } catch (error) {
    log.error(`[MMM-SecondBrain] Transmission failed: ${error.message}`);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

const PLACEHOLDER_TITLES = new Set(["Amazon Order", "Amazon Package"]);

function isPlaceholderTitle(title) {
  const value = String(title || "");
  return PLACEHOLDER_TITLES.has(value) || value.startsWith("Tracking:");
}

/*
 * One shipment is announced several times -- ordered, shipped, out for delivery
 * -- often under different identifiers. Collapse those into a single card that
 * keeps the newest status while inheriting whichever identifiers and
 * human-readable title the other messages carried.
 */
function mergePackage(target, source) {
  target.orderId = target.orderId || source.orderId;
  target.trackingId = target.trackingId || source.trackingId;

  /*
   * A shipment counts as still current if *any* of the messages that describe it
   * turned up in the latest scan, so the freshest sighting wins the merge.
   */
  target.lastSeenAt = Math.max(
    Number(target.lastSeenAt || 0),
    Number(source.lastSeenAt || 0)
  );

  if (isPlaceholderTitle(target.title) && !isPlaceholderTitle(source.title)) {
    target.title = source.title;
  }
}

function samePackage(a, b) {
  if (b.kind !== "package") {
    return false;
  }

  if (a.id === b.id) {
    return true;
  }

  if (a.trackingId && b.trackingId && a.trackingId === b.trackingId) {
    return true;
  }

  return Boolean(
    a.orderId &&
    b.orderId &&
    a.orderId === b.orderId &&
    !String(a.orderId).startsWith("unknown-")
  );
}

function deduplicate(items) {
  const merged = [];

  for (const item of items) {
    if (item.kind === "package") {
      const index = merged.findIndex((existing) => samePackage(item, existing));

      if (index === -1) {
        merged.push(item);
        continue;
      }

      const existing = merged[index];

      if (Number(item.timestamp || 0) > Number(existing.timestamp || 0)) {
        mergePackage(item, existing);
        merged[index] = item;
      } else {
        mergePackage(existing, item);
      }

      continue;
    }

    const index = merged.findIndex((existing) => existing.id === item.id);

    if (index === -1) {
      merged.push(item);
    } else if (Number(item.priority || 0) > Number(merged[index].priority || 0)) {
      merged[index] = item;
    }
  }

  return merged;
}

let stateWriteWarned = false;

/*
 * Merge this poll's packages with what earlier polls saw, then persist the
 * result. Retailers stop mentioning a shipment once it is delivered, so without
 * this the card would vanish the moment its source mail aged out of the scan
 * window.
 */
function persistAndMergePackages(items, stateDir, log, packagesScanned = true) {
  const stateFile = path.join(stateDir || DEFAULT_STATE_DIR, "package_state.json");

  let cached = [];

  if (fs.existsSync(stateFile)) {
    try {
      const parsed = readJson(stateFile);
      cached = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      log.error(
        `[MMM-SecondBrain] Package state unreadable, starting fresh: ${error.message}`
      );
    }
  }

  const now = Date.now();
  const retainDelivered = 48 * 60 * 60 * 1000;

  /*
   * Anything this poll found is, by definition, still backed by a message that
   * is sitting in the mailbox right now. State files written before lastSeenAt
   * existed fall back to the message timestamp rather than looking infinitely
   * stale on the first poll after an upgrade.
   */
  const seenNow = items.map((item) =>
    item.kind === "package" ? { ...item, lastSeenAt: now } : item
  );

  const remembered = cached.map((entry) => ({
    ...entry,
    lastSeenAt: Number(entry.lastSeenAt) || Number(entry.timestamp) || 0
  }));

  const combined = deduplicate([...seenNow, ...remembered]).filter((item) => {
    if (item.kind !== "package") {
      return true;
    }

    if (now - Number(item.timestamp || 0) > PACKAGE_MAX_AGE_MS) {
      return false;
    }

    if (
      item.status === "Delivered" &&
      now - Number(item.timestamp || 0) > retainDelivered
    ) {
      return false;
    }

    /*
     * Only forget on the strength of a scan that actually ran. A mail source
     * that is down contributes nothing, and without this guard an outage longer
     * than the window would quietly erase every remembered shipment.
     */
    if (!packagesScanned) {
      return true;
    }

    return now - Number(item.lastSeenAt || 0) <= PACKAGE_FORGET_AFTER_MS;
  });

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeJsonAtomic(stateFile, combined.filter((item) => item.kind === "package"));
    stateWriteWarned = false;
  } catch (error) {
    // Warn once rather than on every poll.
    if (!stateWriteWarned) {
      log.error(
        `[MMM-SecondBrain] Package state is not writable at ${stateFile} ` +
        `(${error.code || error.message}). Continuing in memory; package history ` +
        "will not survive a restart."
      );
      stateWriteWarned = true;
    }
  }

  return combined;
}

const isTransmissionItem = (item) => {
  const id = String(item?.id || "").toLowerCase();
  const label = String(item?.label || "").toLowerCase();

  return (
    item?.kind === "download" ||
    id.startsWith("transmission:") ||
    label.includes("transmission")
  );
};

const isPackageItem = (item) => item?.kind === "package";

/*
 * Drop packages that have stopped being interesting: anything nothing has said
 * anything new about in a day and a half, anything delivered before today,
 * anything that was out for delivery on an earlier day (it has almost certainly
 * arrived), and bare "Ordered" entries with no identifier once a real shipment
 * is already on the board.
 */
function pruneStalePackages(items, staleAfterMs = PACKAGE_STALE_AFTER_MS) {
  const now = Date.now();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dayStart = todayStart.getTime();

  const hasActiveShipment = items.some(
    (item) =>
      isPackageItem(item) &&
      ["Shipped", "Delivered", "Out for delivery"].includes(item.status)
  );

  return items.filter((item) => {
    if (!isPackageItem(item)) {
      return true;
    }

    /*
     * `deduplicate` keeps the newest message for a shipment, so timestamp is the
     * age of the latest news about it. A shipment stops being news long before
     * its mail leaves the scan window: one that shipped days ago and has said
     * nothing since has almost certainly arrived, whatever status it got stuck
     * on -- "Shipped" and "Delayed" never reach any of the rules below.
     */
    if (now - Number(item.timestamp || 0) > staleAfterMs) {
      return false;
    }

    if (
      (item.status === "Delivered" || item.status === "Out for delivery") &&
      item.timestamp < dayStart
    ) {
      return false;
    }

    if (
      item.status === "Ordered" &&
      String(item.orderId || "").startsWith("unknown-") &&
      hasActiveShipment
    ) {
      return false;
    }

    return true;
  });
}

async function pollAll(configDir, options = {}, log = console) {
  /*
   * Set by whichever accounts managed to read their package mailbox this poll.
   * It gates the forget-pass below, so a dead mail source cannot be mistaken for
   * an empty one.
   */
  const packageScan = { scanned: false };

  const settled = await Promise.allSettled([
    pollGmail(configDir, log, packageScan),
    pollProton(configDir, log, packageScan),
    pollTransmission(configDir, log)
  ]);

  const items = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      log.error(
        `[MMM-SecondBrain] Source poll failed: ${result.reason?.message || result.reason}`
      );
    }
  }

  const now = Date.now();

  const sorted = persistAndMergePackages(
    items,
    options.stateDir,
    log,
    packageScan.scanned
  )
    .sort((a, b) => {
      const priorityDifference = Number(b.priority || 0) - Number(a.priority || 0);

      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return Number(b.timestamp || 0) - Number(a.timestamp || 0);
    });

  const staleAfterMs =
    Number(options.packageStaleAfterHours) > 0
      ? Number(options.packageStaleAfterHours) * 3600000
      : PACKAGE_STALE_AFTER_MS;

  const active = pruneStalePackages(sorted, staleAfterMs);

  /*
   * Notifications, packages and Transmission each get their own limit, so a
   * crowded inbox can never crowd an active download or a shipment off the
   * display.
   */
  const limitFor = (value, fallback) => Math.max(0, Number(value ?? fallback));

  const notificationLimit = limitFor(
    options.maxNotificationItems ?? options.maxItems,
    3
  );
  const packageLimit = limitFor(options.maxPackageItems, 3);
  const downloadLimit = limitFor(options.maxDownloadItems, 1);

  const selected = [
    ...active
      .filter((item) => !isTransmissionItem(item) && !isPackageItem(item))
      .slice(0, notificationLimit),

    ...active.filter(isPackageItem).slice(0, packageLimit),

    ...active.filter(isTransmissionItem).slice(0, downloadLimit)
  ];

  /*
   * lastSeenAt is bookkeeping for the state file and must not reach the browser.
   * It changes on every poll, and the frontend skips its DOM update by comparing
   * the serialised payload against the last one -- shipping a field that always
   * differs would defeat that guard and make the wall flash once a minute.
   */
  return selected.map(({ lastSeenAt, ...item }) => ({
    ...item,
    age: ageText(Number(item.timestamp || 0), now)
  }));
}

module.exports = {
  pollAll,
  pollGmail,
  pollProton,
  pollTransmission,
  // Exported for scripts/dev-poll.js and the checks in scripts/check-packages.js
  extractPackageInfo,
  deduplicate,
  detectCarrier,
  stableKey,
  resolveMailbox,
  persistAndMergePackages,
  pruneStalePackages
};
