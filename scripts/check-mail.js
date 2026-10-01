#!/usr/bin/env node
"use strict";

/*
 * Offline checks for how long mail stays on the wall, and for the poll floor.
 *
 * These need no mail account and no mirror: the sorting is fed hand-built
 * headers, and the pollers run against a fake IMAP server on loopback that
 * answers the way Proton Bridge and Gmail do.
 *
 * They guard the defect Jake hit on 2026-09-26: every unread Proton mail stayed
 * on the wall until it was opened or two weeks had passed, so an appointment
 * confirmation sat there for a day. And the one found while chasing it: every
 * update that changed a card made the browser send its config again, which
 * started a poll on the spot -- a Gmail and Proton login every seven seconds
 * for seven hours.
 *
 *   node scripts/check-mail.js
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const {
  headerFields,
  sortMail,
  mailLifetimeMs,
  present,
  pollProton,
  pollGmail
} = require("../modules/MMM-SecondBrain/lib/sources.js");

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function temporaryDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MINUTE = 60000;
const HOUR = 60 * MINUTE;

/* ------------------------------------------------------------------ *
 * Who sent it
 * ------------------------------------------------------------------ */

function sorted(from, subject, headerLines = "") {
  return sortMail({ from, subject, headers: headerFields(headerLines) });
}

function checkSorting() {
  console.log("\nWho sent it\n");

  const confirmation = sorted("noreply@clinic.example", "Appointment Confirmation");
  check(
    "an appointment confirmation from a no-reply address is automated",
    confirmation.automated,
    JSON.stringify(confirmation)
  );

  const frontDesk = sorted(
    "frontdesk@clinic.example",
    "Your appointment on Tuesday is confirmed"
  );
  check(
    "so is one from a human-looking address, by its subject",
    frontDesk.automated,
    JSON.stringify(frontDesk)
  );

  const person = sorted("sam@example.net", "dinner saturday?");
  check("a person writing is a person", !person.automated, JSON.stringify(person));

  const reply = sorted("sam@example.net", "Re: your appointment tomorrow");
  check(
    "a person answering about an appointment is still a person",
    !reply.automated,
    JSON.stringify(reply)
  );

  const doorCode = sorted("sam@example.net", "the door code for saturday");
  check(
    "a person mentioning a code is still a person",
    !doorCode.automated,
    JSON.stringify(doorCode)
  );

  const newsletter = sorted(
    "editor@widgets.example",
    "This week in widgets",
    "List-Unsubscribe: <mailto:leave@widgets.example>,\r\n <https://widgets.example/leave>\r\n\r\n"
  );
  check(
    "a newsletter is automated by its List-Unsubscribe",
    newsletter.automated && newsletter.reason === "List-Unsubscribe",
    JSON.stringify(newsletter)
  );

  const bulk = sorted("offers@shop.example", "Hello", "Precedence: bulk\r\n\r\n");
  check("Precedence: bulk is automated", bulk.automated, JSON.stringify(bulk));

  const generated = sorted(
    "sam@example.net",
    "Out of office",
    "Auto-Submitted: auto-replied\r\n\r\n"
  );
  check("Auto-Submitted is automated", generated.automated, JSON.stringify(generated));

  const notSubmitted = sorted(
    "sam@example.net",
    "photos from the lake",
    "Auto-Submitted: no\r\n\r\n"
  );
  check(
    "Auto-Submitted: no says a person sent it",
    !notSubmitted.automated,
    JSON.stringify(notSubmitted)
  );

  const invite = sorted(
    "sam@example.net",
    "Invitation: Dinner @ Sat Sep 27, 2026 7pm - 9pm (MDT) (you@proton.me)"
  );
  check("a calendar invitation is automated", invite.automated, JSON.stringify(invite));

  const updated = sorted("sam@example.net", "Updated invitation with note: Dinner");
  check(
    "so is an updated one with a note",
    updated.automated,
    JSON.stringify(updated)
  );

  for (const address of [
    "no-reply@service.example",
    "no_reply@service.example",
    "donotreply@service.example",
    "noreply+abc123@service.example",
    "notifications@service.example",
    "receipts@payments.example"
  ]) {
    const machine = sorted(address, "Hello");
    check(`${address} is automated`, machine.automated, JSON.stringify(machine));
  }

  const code = sorted("sam@proton.example", "Your Proton verification code");
  check("a verification code is automated", code.automated, JSON.stringify(code));

  const body = headerFields(
    "From: Sam <sam@example.net>\r\nSubject: hi\r\n\r\n" +
    "Precedence: bulk\r\nList-Unsubscribe: <mailto:nobody@example.net>\r\n"
  );
  check(
    "only the header block of a whole message is read",
    !body.has("precedence") && !body.has("list-unsubscribe") && body.get("subject") === "hi",
    JSON.stringify([...body])
  );

  const folded = headerFields("List-Unsubscribe: <mailto:a@b.example>,\r\n <https://b.example/u>\r\n\r\n");
  check(
    "a folded header is read whole",
    folded.get("list-unsubscribe") === "<mailto:a@b.example>, <https://b.example/u>",
    folded.get("list-unsubscribe")
  );

  check("no headers at all read as none", headerFields(undefined).size === 0);
}

/* ------------------------------------------------------------------ *
 * How long it stays
 * ------------------------------------------------------------------ */

function checkLifetimes() {
  console.log("\nHow long it stays\n");

  check(
    "automated mail stays half an hour",
    mailLifetimeMs({ automated: true }) === 30 * MINUTE
  );
  check(
    "a person's mail stays half a day",
    mailLifetimeMs({ automated: false }) === 12 * HOUR
  );
  check(
    "an account can set both",
    mailLifetimeMs({ automated: true }, { automatedMailMinutes: 10 }) === 10 * MINUTE &&
      mailLifetimeMs({ automated: false }, { personMailMinutes: 90 }) === 90 * MINUTE
  );
  check(
    "a nonsense setting falls back instead of pinning a card for ever",
    mailLifetimeMs({ automated: true }, { automatedMailMinutes: "soon" }) === 30 * MINUTE &&
      mailLifetimeMs({ automated: false }, { personMailMinutes: -5 }) === 12 * HOUR
  );

  const now = Date.now();
  const shown = present([
    { id: "a", kind: "email", title: "gone", timestamp: now - HOUR, expiresAt: now - MINUTE, priority: 78 },
    { id: "b", kind: "email", title: "still up", timestamp: now - MINUTE, expiresAt: now + MINUTE, priority: 78 },
    { id: "c", kind: "voice", title: "a text", timestamp: now - MINUTE, priority: 100 }
  ], { maxItems: 5 });

  check(
    "a card past its time is not shown, even replayed over a hang",
    shown.map((item) => item.id).join(",") === "c,b",
    shown.map((item) => item.id).join(",")
  );
  check(
    "and the browser is never sent expiresAt",
    shown.every((item) => !("expiresAt" in item))
  );
}

/* ------------------------------------------------------------------ *
 * A fake IMAP server with mail in it
 * ------------------------------------------------------------------ */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

const pad = (value) => String(value).padStart(2, "0");

function imapDate(date) {
  return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

function imapDateTime(date) {
  return (
    `${imapDate(date)} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

function quoted(value) {
  return `"${String(value).replace(/["\\]/g, "")}"`;
}

/*
 * One message: who from, how old, whether it has been read, and any headers
 * beyond From/Subject/Date/Message-ID.
 */
function mail(uid, { name, from, subject, ageMs, seen = false, headers = "", body = "Hello." }) {
  const date = new Date(Date.now() - ageMs);
  const [mailbox, host] = from.split("@");

  return {
    uid,
    seen,
    date,
    envelope:
      `(${quoted(date.toUTCString())} ${quoted(subject)} ` +
      `((${quoted(name)} NIL ${quoted(mailbox)} ${quoted(host)})) ` +
      `((${quoted(name)} NIL ${quoted(mailbox)} ${quoted(host)})) ` +
      `((${quoted(name)} NIL ${quoted(mailbox)} ${quoted(host)})) ` +
      '((NIL NIL "you" "proton.example")) NIL NIL NIL ' +
      `${quoted(`<${uid}@${host}>`)})`,
    extraHeaders: headers,
    source:
      `From: ${name} <${from}>\r\nTo: you@proton.example\r\nSubject: ${subject}\r\n` +
      `Date: ${date.toUTCString()}\r\nMessage-ID: <${uid}@${host}>\r\n${headers}` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\n" +
      `${body}\r\n`
  };
}

/* The header lines of a message whose names are in the requested list. */
function requestedHeaders(message, fields) {
  const wanted = new Set(fields.map((field) => field.toLowerCase()));

  // A header's continuation lines start with whitespace, so they stay with it.
  return message.extraHeaders
    .split(/\r\n(?![ \t])/)
    .filter((header) => wanted.has(header.split(":")[0].trim().toLowerCase()))
    .join("\r\n");
}

function uidSet(text, known) {
  const uids = new Set();

  for (const part of text.split(",")) {
    const [start, end] = part.split(":");
    const low = Number(start);
    const high = end === undefined ? low : end === "*" ? Math.max(...known) : Number(end);

    for (const uid of known) {
      if (uid >= Math.min(low, high) && uid <= Math.max(low, high)) {
        uids.add(uid);
      }
    }
  }

  return [...uids].sort((a, b) => a - b);
}

function fakeImapServer(folders, seen) {
  const listing = Object.entries(folders).map(([name, folder]) =>
    `* LIST (\\HasNoChildren${folder.specialUse ? ` ${folder.specialUse}` : ""}) "/" ${quoted(name)}`
  );

  const respond = (socket, session, tag, line) => {
    const words = line.split(" ");
    const command = String(words[0] || "").toUpperCase();
    const sub = String(words[1] || "").toUpperCase();

    if (command === "LOGOUT") {
      socket.write(`* BYE\r\n${tag} OK logged out\r\n`);
      socket.end();
      return;
    }

    if (command === "CAPABILITY") {
      socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN LOGIN\r\n${tag} OK done\r\n`);
      return;
    }

    if (command === "LIST") {
      // `LIST "" ""` asks only for the hierarchy delimiter.
      if (/""\s*$/.test(line)) {
        socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK list done\r\n`);
        return;
      }

      socket.write(`${listing.join("\r\n")}\r\n${tag} OK list done\r\n`);
      return;
    }

    if (command === "EXAMINE" || command === "SELECT") {
      session.folder = line.slice(command.length + 1).trim().replace(/^"|"$/g, "");
      const messages = folders[session.folder]?.messages || [];
      const next = Math.max(0, ...messages.map((message) => message.uid)) + 1;

      socket.write(`* ${messages.length} EXISTS\r\n* 0 RECENT\r\n`);
      socket.write("* OK [UIDVALIDITY 1] uids valid\r\n");
      socket.write(`* OK [UIDNEXT ${next}] next\r\n`);
      socket.write(`${tag} OK [READ-ONLY] examined\r\n`);
      return;
    }

    const messages = folders[session.folder]?.messages || [];

    if (command === "UID" && sub === "SEARCH") {
      const criteria = words.slice(2).map((word) => word.toUpperCase());
      const sinceAt = criteria.indexOf("SINCE");
      const since = sinceAt === -1 ? null : criteria[sinceAt + 1];

      seen.searches.push({ folder: session.folder, criteria: criteria.join(" ") });

      const sinceDay = since ? new Date(`${since.replace(/-/g, " ")} UTC`).getTime() : 0;
      const hits = messages.filter((message) =>
        (!criteria.includes("UNSEEN") || !message.seen) &&
        Date.UTC(
          message.date.getUTCFullYear(),
          message.date.getUTCMonth(),
          message.date.getUTCDate()
        ) >= sinceDay
      );

      socket.write(`* SEARCH ${hits.map((message) => message.uid).join(" ")}\r\n`);
      socket.write(`${tag} OK search done\r\n`);
      return;
    }

    if (command === "UID" && sub === "FETCH") {
      seen.fetches.push(line);

      const wanted = uidSet(words[2], messages.map((message) => message.uid));
      const fields = (line.match(/HEADER\.FIELDS \(([^)]*)\)/i) || [])[1];
      const whole = /BODY\.PEEK\[\]/i.test(line);

      for (const message of messages.filter((entry) => wanted.includes(entry.uid))) {
        const parts = [
          `UID ${message.uid}`,
          `INTERNALDATE "${imapDateTime(message.date)}"`,
          `ENVELOPE ${message.envelope}`
        ];

        let literal = null;

        if (fields) {
          const block = requestedHeaders(message, fields.split(/\s+/));
          literal = { key: `BODY[HEADER.FIELDS (${fields})]`, value: `${block}${block ? "\r\n" : ""}\r\n` };
        } else if (whole) {
          literal = { key: "BODY[]", value: message.source };
        }

        if (literal) {
          socket.write(
            `* ${message.uid} FETCH (${parts.join(" ")} ${literal.key} ` +
            `{${Buffer.byteLength(literal.value)}}\r\n${literal.value})\r\n`
          );
        } else {
          socket.write(`* ${message.uid} FETCH (${parts.join(" ")})\r\n`);
        }
      }

      socket.write(`${tag} OK uid fetch done\r\n`);
      return;
    }

    socket.write(`${tag} OK ${command || "noop"} done\r\n`);
  };

  return net.createServer((socket) => {
    const session = { folder: null };
    let buffer = "";

    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN LOGIN] fake ready\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let index = buffer.indexOf("\r\n");

      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        const separator = line.indexOf(" ");
        respond(socket, session, line.slice(0, separator), line.slice(separator + 1));

        index = buffer.indexOf("\r\n");
      }
    });
  });
}

async function withServer(folders, work) {
  const seen = { searches: [], fetches: [] };
  const server = fakeImapServer(folders, seen);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    return await work(server.address().port, seen);
  } finally {
    server.close();
  }
}

function recordingLog() {
  const lines = { info: [], error: [] };

  return {
    lines,
    info: (line) => lines.info.push(String(line)),
    log: (line) => lines.info.push(String(line)),
    warn: () => {},
    error: (line) => lines.error.push(String(line))
  };
}

/* ------------------------------------------------------------------ *
 * Proton, end to end
 * ------------------------------------------------------------------ */

async function checkProton() {
  console.log("\nProton, through a fake Bridge\n");

  const folders = {
    INBOX: { messages: [] },
    "All Mail": {
      specialUse: "\\All",
      messages: [
        mail(1, { name: "Sam", from: "sam@example.net", subject: "Dinner this week", ageMs: 13 * HOUR }),
        mail(2, { name: "Sam", from: "sam@example.net", subject: "Re: your appointment tomorrow", ageMs: 11.5 * HOUR }),
        mail(3, {
          name: "Widget Weekly",
          from: "editor@widgets.example",
          subject: "This week in widgets",
          ageMs: 45 * MINUTE,
          headers: "List-Unsubscribe: <mailto:leave@widgets.example>,\r\n <https://widgets.example/leave>\r\n"
        }),
        mail(4, { name: "Front Desk", from: "noreply@clinic.example", subject: "Appointment Confirmation", ageMs: 10 * MINUTE }),
        mail(5, { name: "Sam", from: "sam@example.net", subject: "already read this", ageMs: 2 * MINUTE, seen: true }),
        mail(6, {
          name: "Shop",
          from: "deals@shop.example",
          subject: "Everything must go",
          ageMs: 5 * MINUTE,
          headers: "Precedence: bulk\r\n"
        })
      ]
    }
  };

  await withServer(folders, async (port, seen) => {
    const configDir = temporaryDir("sb-proton-");
    fs.mkdirSync(path.join(configDir, "proton", "accounts"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "proton", "accounts", "fake.json"),
      JSON.stringify({
        alias: "fake",
        displayName: "you@proton.example",
        host: "127.0.0.1",
        port,
        secure: false,
        username: "you@proton.example",
        password: "bridge-password",
        monitorPackages: false
      })
    );

    const log = recordingLog();
    const started = Date.now();
    const items = await pollProton(configDir, log);

    check(
      "the poll itself succeeds",
      log.lines.error.length === 0,
      log.lines.error.join(" | ")
    );

    const ids = items.map((item) => item.id).join(",");
    check(
      "the wall gets the bulk mail, the confirmation and the person, newest first",
      ids === "proton:fake:6,proton:fake:4,proton:fake:2",
      ids
    );

    const byId = Object.fromEntries(items.map((item) => [item.id, item]));
    const confirmation = byId["proton:fake:4"];
    const person = byId["proton:fake:2"];

    check(
      "the confirmation comes down half an hour after it arrived",
      confirmation && Math.abs(confirmation.expiresAt - (confirmation.timestamp + 30 * MINUTE)) < 1000,
      confirmation ? `${((confirmation.expiresAt - started) / MINUTE).toFixed(1)} min left` : "missing"
    );
    check(
      "the person's mail half a day after",
      person && Math.abs(person.expiresAt - (person.timestamp + 12 * HOUR)) < 1000,
      person ? `${((person.expiresAt - started) / MINUTE).toFixed(1)} min left` : "missing"
    );
    check(
      "a newsletter three quarters of an hour old is already gone",
      !byId["proton:fake:3"]
    );
    check(
      "and so is a person's mail from thirteen hours ago",
      !byId["proton:fake:1"]
    );
    check(
      "read mail is not shown at all",
      !byId["proton:fake:5"]
    );

    /*
     * The search is the one that has always run -- unread, over maxAgeDays --
     * and the lifetime is applied to what it finds. Gmail's time-based SEARCH
     * has misbehaved before (docs/ARCHITECTURE.md), so the query is left alone.
     */
    const search = seen.searches[0]?.criteria || "";
    check(
      "the search is still unread mail over maxAgeDays",
      /UNSEEN/.test(search) &&
        search.includes(`SINCE ${imapDate(new Date(Date.now() - 14 * 24 * HOUR)).toUpperCase()}`),
      search
    );

    const fetch = seen.fetches[0] || "";
    check(
      "only the sorting headers are fetched, never a body",
      /HEADER\.FIELDS \(/i.test(fetch) && !/BODY\.PEEK\[\]/i.test(fetch) && /LIST-UNSUBSCRIBE/i.test(fetch),
      fetch
    );

    check(
      "each card says once in the journal what it was taken for",
      log.lines.info.length === 3 &&
        log.lines.info.some((line) => line.includes("clinic.example is automated (sent from noreply@)")) &&
        log.lines.info.some((line) => line.includes("shop.example is automated (Precedence: bulk)")) &&
        log.lines.info.some((line) => line.includes("example.net is from a person")),
      log.lines.info.join(" | ")
    );
    check(
      "the journal learns the sender's domain, never the subject",
      log.lines.info.every((line) => !/Appointment Confirmation|Everything must go|your appointment/i.test(line))
    );

    await pollProton(configDir, log);

    check(
      "and says it only once",
      log.lines.info.length === 3,
      `${log.lines.info.length} line(s) after two polls`
    );
  });
}

/* ------------------------------------------------------------------ *
 * Gmail's wall label, end to end
 * ------------------------------------------------------------------ */

async function checkGmail() {
  console.log("\nGmail's wall label, through a fake Gmail\n");

  const folders = {
    INBOX: { specialUse: "\\Inbox", messages: [] },
    "Wall-Display": {
      messages: [
        mail(1, {
          name: "Bank",
          from: "alerts@bank.example",
          subject: "Your statement is ready",
          ageMs: 40 * MINUTE,
          headers: "Auto-Submitted: auto-generated\r\n"
        }),
        mail(2, {
          name: "Mum",
          from: "mum@example.net",
          subject: "call me when you can",
          ageMs: 3 * HOUR,
          body: "Nothing urgent, just want to hear how the move went."
        })
      ]
    },
    "[Gmail]/All Mail": { specialUse: "\\All", messages: [] }
  };

  await withServer(folders, async (port) => {
    const configDir = temporaryDir("sb-gmail-");
    fs.mkdirSync(path.join(configDir, "gmail", "accounts"), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "gmail", "accounts", "fake.json"),
      JSON.stringify({
        alias: "fake",
        email: "you@example.com",
        password: "app-password",
        host: "127.0.0.1",
        port,
        secure: false,
        monitorPackages: false,
        monitorVoice: false
      })
    );

    const log = recordingLog();
    const items = await pollGmail(configDir, log);

    check(
      "the poll itself succeeds",
      log.lines.error.length === 0,
      log.lines.error.join(" | ")
    );
    check(
      "a filtered alert forty minutes old is gone; a person's mail from this afternoon is not",
      items.length === 1 && items[0].id === "gmail:fake:<2@example.net>",
      items.map((item) => item.id).join(",")
    );
    check(
      "the card still carries its preview",
      /how the move went/.test(items[0]?.detail || ""),
      items[0]?.detail
    );
    check(
      "and comes down half a day after it arrived",
      items[0] && Math.abs(items[0].expiresAt - (items[0].timestamp + 12 * HOUR)) < 1000
    );
  });
}

/* ------------------------------------------------------------------ *
 * The browser's config is not a poll
 * ------------------------------------------------------------------ */

async function checkPollFloor() {
  console.log("\nThe poll floor\n");

  const load = Module._load;

  Module._load = function (request, ...rest) {
    if (request === "node_helper") {
      return { create: (definition) => definition };
    }

    return load.call(this, request, ...rest);
  };

  let helper;

  try {
    helper = require("../modules/MMM-SecondBrain/node_helper.js");
  } finally {
    Module._load = load;
  }

  const sent = [];
  let polls = 0;

  helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });
  helper.start();
  helper.pollNow = async function () {
    polls += 1;
    this.lastPollAt = Date.now();
  };

  const config = {
    pollIntervalMs: 60000,
    configDir: temporaryDir("sb-helper-etc-"),
    stateDir: temporaryDir("sb-helper-state-")
  };

  try {
    helper.socketNotificationReceived("SECOND_BRAIN_CONFIG", config);
    check("the first config starts a poll", polls === 1, `${polls} poll(s)`);

    const timer = helper.timer;

    // What resume() sends after every update that changed a card.
    for (let index = 0; index < 20; index += 1) {
      helper.socketNotificationReceived("SECOND_BRAIN_CONFIG", config);
    }

    check(
      "twenty more inside the minute start none",
      polls === 1,
      `${polls} poll(s)`
    );
    check(
      "and do not keep restarting the poll timer",
      helper.timer === timer
    );

    helper.lastUpdate = { items: [{ id: "x", title: "a card" }], generatedAt: 1 };
    sent.length = 0;
    helper.socketNotificationReceived("SECOND_BRAIN_CONFIG", config);

    check(
      "a page that has just loaded is sent the last answer instead",
      polls === 1 &&
        sent.length === 1 &&
        sent[0].notification === "SECOND_BRAIN_UPDATE" &&
        sent[0].payload.items[0].id === "x",
      JSON.stringify(sent)
    );

    helper.lastPollAt = Date.now() - 61000;
    helper.socketNotificationReceived("SECOND_BRAIN_CONFIG", config);
    check("a config that arrives when a poll is due still polls", polls === 2, `${polls} poll(s)`);

    helper.socketNotificationReceived("SECOND_BRAIN_CONFIG", { ...config, pollIntervalMs: 120000 });
    check(
      "a new interval gets a new timer",
      helper.timer !== timer && helper.timerIntervalMs === 120000
    );

    helper.lastPollAt = Date.now();
    helper.socketNotificationReceived("SECOND_BRAIN_REFRESH");
    check("a refresh inside the interval is still ignored", polls === 2, `${polls} poll(s)`);
  } finally {
    helper.stop();
  }
}

async function run() {
  checkSorting();
  checkLifetimes();
  await checkProton();
  await checkGmail();
  await checkPollFloor();

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
