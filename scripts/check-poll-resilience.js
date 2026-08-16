#!/usr/bin/env node
"use strict";

/*
 * Checks that one sick source cannot take the whole wall down with it.
 *
 * These need no mail account and no mirror: they stand up a fake IMAP server and
 * a fake Nextcloud on loopback and drive the real pollAll against them. Both
 * cases guard the defect found on 2026-08-07, when a single hung source stopped
 * the wall publishing for 23.8 minutes with no error line to say why -- long
 * enough to lose a text outright, since texts only live an hour while packages
 * are remembered in package_state.json.
 *
 *   node scripts/check-poll-resilience.js
 *
 * Takes about half a minute: the deadline has a 30s floor, deliberately, because
 * a normal poll takes 27s and anything tighter would abandon healthy sources.
 */

const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pollAll } = require("../modules/MMM-SecondBrain/lib/sources.js");
const { resolveVoiceContact } = require("../modules/MMM-SecondBrain/lib/contacts.js");

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

/* ------------------------------------------------------------------ *
 * A fake IMAP server that can be told to stop answering
 * ------------------------------------------------------------------ */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

/*
 * The message has to be dated now. The voice window is 60 minutes, so a fixed
 * date would be discarded before it was ever classified and the check would pass
 * for the wrong reason.
 */
function internalDateNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return (
    `${pad(now.getUTCDate())}-${MONTHS[now.getUTCMonth()]}-${now.getUTCFullYear()} ` +
    `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} +0000`
  );
}

const MAILBOXES = [
  '* LIST (\\HasNoChildren) "/" "INBOX"',
  '* LIST (\\HasNoChildren) "/" "Wall-Display"',
  '* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"'
];

// Only INBOX holds anything, so only the Google Voice path produces a card.
const EXISTS = { INBOX: 1 };

function fakeImapServer(state, sockets) {
  const respond = (socket, tag, line) => {
    const [rawCommand, ...rest] = line.split(" ");
    const command = String(rawCommand || "").toUpperCase();
    const argument = String(rest[0] || "");

    if (command === "LOGOUT") {
      socket.write(`* BYE\r\n${tag} OK logged out\r\n`);
      socket.end();
      return;
    }

    if (command === "CAPABILITY") {
      socket.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN LOGIN\r\n");
      socket.write(`${tag} OK done\r\n`);
      return;
    }

    if (command === "LIST") {
      // The hang under test: the command is accepted and simply never answered.
      if (state.hang) {
        return;
      }

      socket.write(`${MAILBOXES.join("\r\n")}\r\n${tag} OK list done\r\n`);
      return;
    }

    if (command === "EXAMINE" || command === "SELECT") {
      const count = EXISTS[argument.replace(/^"|"$/g, "")] || 0;

      socket.write(`* ${count} EXISTS\r\n* 0 RECENT\r\n`);
      socket.write("* OK [UIDVALIDITY 1] uids valid\r\n");
      socket.write(`* OK [UIDNEXT ${count + 1}] next\r\n`);
      socket.write(`${tag} OK [READ-ONLY] examined\r\n`);
      return;
    }

    if (command === "SEARCH" || (command === "UID" && /^SEARCH$/i.test(argument))) {
      socket.write(`* SEARCH\r\n${tag} OK search done\r\n`);
      return;
    }

    if (command === "UID" && /^FETCH$/i.test(argument)) {
      // No body: attachSources tolerates a message it cannot download, and the
      // voice path needs no body to classify one.
      socket.write(`${tag} OK uid fetch done\r\n`);
      return;
    }

    if (command === "FETCH") {
      // Envelope omitted on purpose: with none, the voice path defaults the
      // subject to "Google Voice", which is enough to classify.
      socket.write(`* 1 FETCH (UID 1 INTERNALDATE "${internalDateNow()}")\r\n`);
      socket.write(`${tag} OK fetch done\r\n`);
      return;
    }

    socket.write(`${tag} OK ${command || "noop"} done\r\n`);
  };

  return net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));

    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN LOGIN] fake ready\r\n");

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let index = buffer.indexOf("\r\n");

      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        const separator = line.indexOf(" ");
        respond(socket, line.slice(0, separator), line.slice(separator + 1));

        index = buffer.indexOf("\r\n");
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * A hung source must not hold the publish
 * ------------------------------------------------------------------ */

async function checkDeadline() {
  console.log("\nA hung source\n");

  const state = { hang: false };
  const sockets = new Set();
  const server = fakeImapServer(state, sockets);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const configDir = temporaryDir("sb-deadline-");
  fs.mkdirSync(path.join(configDir, "gmail", "accounts"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "gmail", "accounts", "fake.json"),
    JSON.stringify({
      alias: "fake",
      email: "fake@example.com",
      password: "secret",
      host: "127.0.0.1",
      port: server.address().port,
      secure: false
    })
  );

  const errors = [];
  const log = {
    info: () => {},
    warn: () => {},
    error: (line) => errors.push(String(line))
  };

  const options = {
    stateDir: temporaryDir("sb-state-"),
    sourceTimeoutMs: 30000,
    maxItems: 5
  };

  try {
    const healthy = await pollAll(configDir, options, log);

    check(
      "a healthy source produces its card",
      healthy.filter((item) => item.kind === "voice").length === 1,
      `${healthy.filter((item) => item.kind === "voice").length} voice item(s)`
    );

    state.hang = true;
    errors.length = 0;

    const started = Date.now();
    const stalled = await pollAll(configDir, options, log);
    const elapsed = Date.now() - started;

    check(
      "the poll returns instead of hanging with it",
      elapsed < 45000,
      `took ${(elapsed / 1000).toFixed(1)}s`
    );
    check(
      "it waits for the deadline before giving up",
      elapsed >= 30000,
      `took ${(elapsed / 1000).toFixed(1)}s`
    );
    check(
      "the timeout names the source in the journal",
      errors.some((line) => line.includes("Gmail did not answer within")),
      errors[0] || "nothing logged"
    );
    check(
      "the hung source's last cards are replayed, not dropped",
      stalled.filter((item) => item.kind === "voice").length === 1,
      `${stalled.filter((item) => item.kind === "voice").length} voice item(s)`
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  }
}

/* ------------------------------------------------------------------ *
 * A failing contacts server must be asked once, not once per text
 * ------------------------------------------------------------------ */

async function checkContactsBackoff() {
  console.log("\nA failing contacts server\n");

  let requests = 0;

  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("nextcloud is having a day");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const configDir = temporaryDir("sb-contacts-");
  fs.writeFileSync(
    path.join(configDir, "nextcloud-contacts.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      username: "wall",
      password: "secret",
      timeoutMs: 5000
    })
  );

  const errors = [];
  const log = { info: () => {}, error: (line) => errors.push(String(line)) };

  try {
    const resolved = [];

    for (let index = 0; index < 5; index += 1) {
      resolved.push(
        await resolveVoiceContact(
          configDir,
          `New text message from +1719555123${index}`,
          "+17195551230.abc@txt.voice.google.com",
          log
        )
      );
    }

    check(
      "five texts in one scan cost one request, not five",
      requests === 1,
      `${requests} request(s)`
    );
    check(
      "the failure is still reported",
      errors.some((line) => line.includes("Nextcloud contacts failed")),
      errors[0] || "nothing logged"
    );
    check(
      "cards keep a readable name while it is down",
      resolved.every((entry) => /^\(\d{3}\) \d{3}-\d{4}$/.test(entry.name)),
      resolved.map((entry) => entry.name).join(", ")
    );
  } finally {
    server.close();
  }
}

async function run() {
  await checkDeadline();
  await checkContactsBackoff();

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
