#!/usr/bin/env node
"use strict";

/*
 * Checks for the Nextcloud notifications source.
 *
 * Needs no Nextcloud: a fake one on loopback answers the OCS notifications
 * endpoint the way a real server does, and the real pollNextcloud and pollAll
 * are driven against it.
 *
 *   node scripts/check-nextcloud.js
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  nextcloudCards,
  pollNextcloud,
  pollAll,
  getLastPollStatus
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

const minute = 60000;

let nextId = 1;

function notification(app, minutesAgo, fields = {}) {
  return {
    notification_id: nextId++,
    app,
    user: "jake",
    datetime: new Date(Date.now() - minutesAgo * minute).toISOString(),
    object_type: "thing",
    object_id: String(nextId),
    subject: `${app} subject`,
    subjectRich: "",
    subjectRichParameters: [],
    message: "",
    messageRich: "",
    messageRichParameters: [],
    link: `https://cloud.example.com/apps/${app}`,
    icon: "",
    actions: [],
    ...fields
  };
}

function capture() {
  const lines = { info: [], error: [] };

  return {
    lines,
    log: {
      info: (line) => lines.info.push(line),
      error: (line) => lines.error.push(line),
      log: () => {}
    }
  };
}

const config = {
  baseUrl: "https://cloud.example.com",
  username: "jake",
  password: "app-password"
};

function cardsFor(notifications, extra = {}) {
  return nextcloudCards(notifications, { ...config, ...extra }, capture().log);
}

function survives(app, minutesAgo, extra = {}) {
  return cardsFor([notification(app, minutesAgo)], extra).length === 1;
}

/* ------------------------------------------------------------------ *
 * How long each kind of notification stays, by the app that raised it
 * ------------------------------------------------------------------ */

function lifetimes() {
  console.log("How long each notification stays");

  const windows = [
    ["spreed", "a Talk message", 50, 70],
    ["dav", "a calendar reminder", 20, 40],
    ["files_sharing", "a share", 11 * 60, 13 * 60],
    ["comments", "a mention in a comment", 11 * 60, 13 * 60],
    ["deck", "a Deck card", 11 * 60, 13 * 60],
    ["updatenotification", "an update notice", 20, 40],
    ["admin_notifications", "a script's occ notification:generate", 20, 40],
    ["admin_notification_talk", "a push self-test", 20, 40],
    ["some_app_nobody_listed", "an app nobody listed", 20, 40]
  ];

  for (const [app, what, inside, outside] of windows) {
    check(`${what} ${inside} min old is on the wall`, survives(app, inside));
    check(`${what} ${outside} min old is not`, !survives(app, outside));
  }

  check(
    "an account can lengthen a window",
    survives("spreed", 70, { conversationMinutes: 120 })
  );
  check(
    "or shorten one",
    !survives("files_sharing", 60, { personMinutes: 30 })
  );

  for (const app of ["nextcloud_announcements", "firstrunwizard", "survey_client", "mail"]) {
    check(`${app} never goes up, however new`, !survives(app, 0));
  }

  check(
    "ignoreApps keeps an app off the wall",
    !survives("deck", 0, { ignoreApps: ["deck"] })
  );
  check(
    "a notification with no readable date is skipped",
    cardsFor([notification("spreed", 0, { datetime: "yesterday-ish" })]).length === 0
  );
}

/* ------------------------------------------------------------------ *
 * What a card says, and what it must not
 * ------------------------------------------------------------------ */

function cards() {
  console.log("\nWhat a card says");

  const [talk] = cardsFor([notification("spreed", 2, {
    object_type: "chat",
    object_id: "k3yt0k3n",
    subject: "Alice mentioned you in conversation Team",
    message: "are you\n  home yet?"
  })]);

  check("a Talk card is kind nextcloud", talk?.kind === "nextcloud", `got ${talk?.kind}`);
  check("and says it is Talk", talk?.label === "Talk · Nextcloud", `got ${talk?.label}`);
  check("its title is the subject", talk?.title === "Alice mentioned you in conversation Team");
  check("its detail is the message, on one line", talk?.detail === "are you home yet?", `got ${talk?.detail}`);
  check("it ranks just under a text", talk?.priority === 98, `got ${talk?.priority}`);

  check(
    "the room token never reaches the page",
    !JSON.stringify(talk).includes("k3yt0k3n"),
    JSON.stringify(talk)
  );
  check(
    "nor does the link",
    !JSON.stringify(talk).includes("cloud.example.com"),
    JSON.stringify(talk)
  );
  check("expiresAt is set for the backend to take it down", Number(talk?.expiresAt) > Date.now());

  const [unknown] = cardsFor([notification("some_app", 1)], { displayName: "Home Cloud" });

  check(
    "an app with no name of its own is labelled with the account",
    unknown?.label === "Home Cloud",
    `got ${unknown?.label}`
  );

  const conversation = cardsFor([
    notification("spreed", 30, { object_type: "chat", object_id: "room1", subject: "older" }),
    notification("spreed", 3, { object_type: "chat", object_id: "room1", subject: "newest" }),
    notification("spreed", 10, { object_type: "chat", object_id: "room1", subject: "middle" }),
    notification("spreed", 5, { object_type: "chat", object_id: "room2", subject: "other room" })
  ]);

  check(
    "one card per conversation, not per mention",
    conversation.length === 2,
    `got ${conversation.length}`
  );
  check(
    "and it shows the newest",
    conversation.some((card) => card.title === "newest") &&
      !conversation.some((card) => card.title === "older" || card.title === "middle"),
    JSON.stringify(conversation.map((card) => card.title))
  );

  const [rich] = cardsFor([notification("files_sharing", 1, {
    subject: "",
    subjectRich: "{user} shared {file} with you",
    subjectRichParameters: {
      user: { type: "user", id: "alice", name: "Alice" },
      file: { type: "file", id: "12", name: "taxes.pdf" }
    }
  })]);

  check(
    "an empty plain subject is rebuilt from the rich one",
    rich?.title === "Alice shared taxes.pdf with you",
    `got ${rich?.title}`
  );

  const { lines, log } = capture();

  nextcloudCards(
    [notification("spreed", 1, { subject: "Secret plans", object_id: "announce-1" })],
    config,
    log
  );
  nextcloudCards(
    [notification("spreed", 1, { subject: "Secret plans", object_id: "announce-1" })],
    config,
    log
  );

  check(
    "each card says once in the journal what it was taken for",
    lines.info.length === 1 && /Nextcloud spreed notification is a conversation; on the wall until .* unless it is dismissed first\./.test(lines.info[0]),
    JSON.stringify(lines.info)
  );
  check(
    "and never what it said",
    !lines.info.some((line) => line.includes("Secret plans"))
  );
}

/* ------------------------------------------------------------------ *
 * The fake Nextcloud
 * ------------------------------------------------------------------ */

function fakeNextcloud() {
  const state = {
    status: 200,
    userStatus: "",
    notifications: [],
    requests: []
  };

  const server = http.createServer((request, response) => {
    state.requests.push({ url: request.url, headers: request.headers });

    if (!request.url.startsWith("/ocs/v2.php/apps/notifications/api/v2/notifications")) {
      response.writeHead(404).end();
      return;
    }

    const headers = { "Content-Type": "application/json" };

    if (state.userStatus) {
      headers["X-Nextcloud-User-Status"] = state.userStatus;
    }

    if (state.status === 204) {
      response.writeHead(204, headers).end();
      return;
    }

    response.writeHead(state.status, headers);
    response.end(JSON.stringify({
      ocs: {
        meta: { status: state.status === 200 ? "ok" : "failure", statuscode: state.status, message: "" },
        data: state.status === 200 ? state.notifications : []
      }
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function writeConfig(configDir, value) {
  fs.writeFileSync(
    path.join(configDir, "nextcloud-notifications.json"),
    JSON.stringify(value)
  );
}

async function polling() {
  console.log("\nPolling a server");

  const { server, state, url } = await fakeNextcloud();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-nextcloud-"));

  try {
    check(
      "no config file means no cards and no complaint",
      (await pollNextcloud(configDir, capture().log)).length === 0 && state.requests.length === 0
    );

    writeConfig(configDir, { ...config, baseUrl: `${url}/`, enabled: false });
    check(
      "enabled: false asks the server nothing",
      (await pollNextcloud(configDir, capture().log)).length === 0 && state.requests.length === 0
    );

    writeConfig(configDir, { ...config, baseUrl: `${url}/` });
    state.notifications = [
      notification("spreed", 2, { object_id: "poll-room", subject: "Bob sent you a private message" }),
      notification("nextcloud_announcements", 1)
    ];

    const items = await pollNextcloud(configDir, capture().log);
    const request = state.requests.at(-1);

    check(
      "a live notification becomes a card",
      items.length === 1 && items[0].title === "Bob sent you a private message",
      JSON.stringify(items)
    );
    check(
      "a trailing slash on baseUrl does not double up",
      request?.url === "/ocs/v2.php/apps/notifications/api/v2/notifications?format=json",
      `asked for ${request?.url}`
    );
    check(
      "the request says it is an OCS API call",
      request?.headers["ocs-apirequest"] === "true"
    );
    check(
      "and signs in with the app password",
      request?.headers.authorization ===
        `Basic ${Buffer.from("jake:app-password").toString("base64")}`
    );

    state.userStatus = "dnd";
    const quiet = capture();
    check(
      "Do Not Disturb keeps every notification off the wall",
      (await pollNextcloud(configDir, quiet.log)).length === 0
    );
    await pollNextcloud(configDir, quiet.log);
    check(
      "and says so once, not every poll",
      quiet.lines.info.filter((line) => line.includes("Do Not Disturb")).length === 1,
      JSON.stringify(quiet.lines.info)
    );

    state.userStatus = "online";
    const back = capture();
    check(
      "they come back when it ends",
      (await pollNextcloud(configDir, back.log)).length === 1
    );
    check(
      "and the journal says that too",
      back.lines.info.some((line) => line.includes("off Do Not Disturb"))
    );

    state.status = 204;
    check(
      "204, no app can notify, is an empty answer and not a fault",
      (await pollNextcloud(configDir, capture().log)).length === 0
    );

    state.status = 404;
    const missing = capture();
    check(
      "a 404 puts nothing up",
      (await pollNextcloud(configDir, missing.log)).length === 0
    );
    check(
      "and the journal suggests the Notifications app is off",
      missing.lines.error.some((line) => line.includes("Notifications app")),
      JSON.stringify(missing.lines.error)
    );

    /*
     * Through pollAll, the way the helper calls it: the card reaches the
     * wall's notification slots, and the status line hears about Nextcloud.
     */
    state.status = 200;
    state.notifications = [notification("spreed", 1, { object_id: "via-poll-all", subject: "via pollAll" })];

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-nextcloud-state-"));
    const published = await pollAll(configDir, { stateDir, maxItems: 3 }, capture().log);
    const status = getLastPollStatus()?.sources?.find((source) => source.name === "Nextcloud");

    check(
      "pollAll publishes the card",
      published.some((item) => item.kind === "nextcloud" && item.title === "via pollAll"),
      JSON.stringify(published)
    );
    check(
      "the card reaching the browser has no expiresAt",
      published.every((item) => !("expiresAt" in item))
    );
    check(
      "the status line hears Nextcloud is ok",
      status?.state === "ok",
      JSON.stringify(status)
    );

    state.status = 500;
    await pollAll(configDir, { stateDir }, capture().log);
    check(
      "and that it is down when it fails",
      getLastPollStatus()?.sources?.find((source) => source.name === "Nextcloud")?.state === "down"
    );

    fs.rmSync(stateDir, { recursive: true, force: true });
  } finally {
    server.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function run() {
  console.log("Nextcloud notification checks\n");

  lifetimes();
  cards();
  await polling();

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
