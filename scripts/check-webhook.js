#!/usr/bin/env node
"use strict";

/*
 * Checks for the cards scripts post to the wall.
 *
 * A webhook card must go up without a poll: every poll logs in to every
 * mailbox, and the 60s floor is there so nothing can make that happen more
 * often. So the route runs through the real node_helper, over a real socket,
 * with a Gmail and a Proton account configured -- and every IMAP login the
 * helper attempts is counted, at ImapFlow's connect(), which never leaves the
 * machine. One full poll is run first, to show the count would see a login.
 *
 *   node scripts/check-webhook.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");

const moduleDir = path.join(__dirname, "../modules/MMM-SecondBrain");

/*
 * The ImapFlow lib/sources.js loads, not some other copy: patched before
 * anything requires it, so every account the helper opens comes through here.
 */
const { ImapFlow } = require(require.resolve("imapflow", { paths: [moduleDir] }));
const logins = [];

ImapFlow.prototype.connect = async function () {
  logins.push(`${this.options?.host}:${this.options?.port}`);
  throw new Error("check-webhook: no IMAP here");
};

ImapFlow.prototype.logout = async function () {};

const webhook = require("../modules/MMM-SecondBrain/lib/webhook.js");

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

const temporary = [];

function folder(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-webhook-"));
  temporary.push(dir);

  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  }

  return dir;
}

const token = "3f".repeat(32);
const bearer = { authorization: `Bearer ${token}` };

console.log("\nwebhook cards\n");

/* ------------------------------------------------------------------ *
 * The token
 * ------------------------------------------------------------------ */

{
  const on = folder({ "webhook.json": { token } });

  check("with no webhook.json the route is off", webhook.authorize(folder(), bearer)?.body?.error === "off");

  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/secondbrain/webhook.example.json"), "utf8"));
  check("a copy of the example, with no real token, is off too",
    webhook.authorize(folder({ "webhook.json": example }), { authorization: `Bearer ${example.token}` })?.status === 404);

  check("a short token is not a token",
    webhook.authorize(folder({ "webhook.json": { token: "changeme" } }), { authorization: "Bearer changeme" })?.status === 404);

  check("enabled: false turns it off",
    webhook.authorize(folder({ "webhook.json": { token, enabled: false } }), bearer)?.status === 404);

  const broken = webhook.authorize(folder({ "webhook.json": "{ token: " }), bearer);
  check("a webhook.json that is not JSON is off, not open", broken?.status === 404 && /unreadable/.test(broken.reason), JSON.stringify(broken));

  check("the right token is let in", webhook.authorize(on, bearer) === null);
  check("so is the right token with a lower-case scheme", webhook.authorize(on, { authorization: `bearer ${token}` }) === null);

  const wrong = webhook.authorize(on, { authorization: `Bearer ${"4f".repeat(32)}` });
  check("the wrong token is refused", wrong?.status === 401 && wrong.body.error === "token" && wrong.reason === "wrong token", JSON.stringify(wrong));

  check("a prefix of the right token is refused", webhook.authorize(on, { authorization: `Bearer ${token.slice(0, 40)}` })?.status === 401);
  check("no token is refused", webhook.authorize(on, {})?.reason === "no token");
  check("the token sent other than as Bearer is refused", webhook.authorize(on, { authorization: `Basic ${token}` })?.status === 401);
  check("the reason for the journal is not in the answer", !JSON.stringify(wrong.body).includes("wrong"));
}

/* ------------------------------------------------------------------ *
 * What a request becomes on the wall
 * ------------------------------------------------------------------ */

{
  const t = Date.parse("2026-11-04T21:40:00Z");

  check("a card needs an id", webhook.cardFrom({ title: "x" }, null, t).error === "Missing 'id' in payload");
  check("an id that is an object is not one", Boolean(webhook.cardFrom({ id: { a: 1 } }, null, t).error));
  check("nor is a body that is not an object", Boolean(webhook.cardFrom("garage", null, t).error) && Boolean(webhook.cardFrom(null, null, t).error));

  const card = webhook.cardFrom({ id: " garage ", title: "Garage door open", detail: "since 9:40 PM", ttl: 600 }, null, t);
  check("a card is filed under its id, trimmed, and shown as a webhook",
    card.key === "garage" && card.item.id === "webhook:garage" && card.item.label === "Webhook", JSON.stringify(card));
  check("with no kind it is a warning", card.item.kind === "warning");
  check("ttl is seconds until it comes down", card.item.expiresAt === t + 600 * 1000);
  check("with no ttl it stays", webhook.cardFrom({ id: "a" }, null, t).item.expiresAt === null);
  check("and with no title it says Alert", webhook.cardFrom({ id: "a" }, null, t).item.title === "Alert");

  const long = webhook.cardFrom({ id: 7, title: `Jo\u0000\u001b[31m ${"o".repeat(500)}`, detail: { not: "a string" } }, null, t).item;
  check("strings lose control characters and are cut to length",
    !/[\u0000-\u001f]/.test(long.title) && long.title.length <= 120, JSON.stringify(long.title));
  check("a number is a fine id", long.id === "webhook:7");

  const later = t + 60000;
  const again = webhook.cardFrom({ id: "garage", title: "Garage door open", detail: "since 9:40 PM", ttl: 600 }, card.item, later).item;
  check("posting an unchanged card again keeps its time, and renews its ttl",
    again.timestamp === t && again.expiresAt === later + 600 * 1000, JSON.stringify(again));

  const changed = webhook.cardFrom({ id: "garage", title: "Garage door still open" }, card.item, later).item;
  check("a changed one is new", changed.timestamp === later);

  check("a DELETE's id is filed the way a POST's is", webhook.cardKey(" garage ") === card.key);
}

/* ------------------------------------------------------------------ *
 * The route, over a real socket, through the real node_helper
 * ------------------------------------------------------------------ */

/*
 * MagicMirror's NodeHelper, cut to what the helper uses, and an express app
 * cut to post/delete with :params, a status and a JSON answer -- on a real
 * HTTP server, so the body arrives in chunks the way it does on the wall.
 */
class FakeNodeHelper {
  constructor() {
    this.sent = [];
    const routes = [];
    this.routes = routes;
    const add = (method) => (route, handler) => {
      const names = [];
      const pattern = new RegExp(`^${route.replace(/:(\w+)/g, (_, name) => { names.push(name); return "([^/]+)"; })}$`);
      routes.push({ method, pattern, names, handler });
    };
    this.expressApp = { post: add("POST"), delete: add("DELETE") };
  }

  sendSocketNotification(notification, payload) {
    this.sent.push({ notification, payload });
  }

  static create(definition) {
    return class extends FakeNodeHelper {
      constructor() {
        super();
        Object.assign(this, definition);
      }
    };
  }
}

/*
 * `parsed`: stand in for some other module having put express.json() on the
 * shared app, so the stream is spent before the route sees it.
 */
function serve(helper, { parsed = false } = {}) {
  return http.createServer((req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); return res; };

    const url = req.url.split("?")[0];
    let match = null;
    const route = helper.routes.find((r) => r.method === req.method && (match = r.pattern.exec(url)));

    if (!route) {
      res.status(404).json({});
      return;
    }

    req.params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));

    if (!parsed) {
      route.handler(req, res);
      return;
    }

    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      req.body = JSON.parse(data);
      req._body = true;
      route.handler(req, res);
    });
  });
}

function request(port, { method = "POST", path: route = "/secondbrain/webhook", headers = bearer, body = null }) {
  return new Promise((resolve, reject) => {
    const bytes = body === null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: route,
      method,
      headers: { "Content-Type": "application/json", ...headers }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });

    // A route that waits for a body that is never coming fails here, not by hanging.
    req.setTimeout(3000, () => req.destroy(new Error(`${method} ${route} got no answer`)));
    req.on("error", reject);

    if (!bytes) {
      req.end();
      return;
    }

    // Two writes: the helper must put the body back together before reading it.
    const half = Math.floor(bytes.length / 2);
    req.write(bytes.subarray(0, half));
    req.end(bytes.subarray(half));
  });
}

const post = (port, body, headers = bearer) => request(port, { body, headers });
const remove = (port, id, headers = bearer) => request(port, { method: "DELETE", path: `/secondbrain/webhook/${encodeURIComponent(id)}`, headers });

function loadHelper() {
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (name, ...rest) {
    return name === "node_helper" ? "node_helper" : resolveFilename.call(this, name, ...rest);
  };
  const fake = new Module("node_helper");
  fake.exports = FakeNodeHelper;
  fake.loaded = true;
  require.cache.node_helper = fake;

  return require("../modules/MMM-SecondBrain/node_helper.js");
}

const updates = (helper) => helper.sent.filter((s) => s.notification === "SECOND_BRAIN_UPDATE");
const ids = (update) => (update?.payload?.items || []).map((item) => item.id);

async function routeChecks() {
  const Helper = loadHelper();
  const helper = new Helper();

  const warnings = [];
  const { warn, error } = console;
  console.warn = (line) => warnings.push(String(line));
  console.error = () => {};

  helper.start();

  // One account of each, for the poll to log in to -- on a port nothing answers, should the count ever miss one.
  const configDir = folder({
    "webhook.json": { token },
    "gmail/accounts/personal.json": { email: "wall@example.com", password: "app-password", host: "127.0.0.1", port: 9 },
    "proton/accounts/personal.json": { username: "wall@example.com", password: "bridge-password", host: "127.0.0.1", port: 9 }
  });
  helper.config.configDir = configDir;
  helper.config.stateDir = folder();

  const realPoll = helper.pollNow.bind(helper);
  let polls = 0;
  helper.pollNow = () => { polls += 1; return realPoll(); };

  const server = serve(helper);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    /* Before the first poll there is no wall to put a card on. */
    const early = await post(port, { id: "early", title: "Posted before the first poll" });
    check("before the first poll a card is taken", early.status === 200 && early.body.success === true && early.body.id === "early", JSON.stringify(early));
    check("but nothing is published, and nothing is polled for it",
      updates(helper).length === 0 && polls === 0 && logins.length === 0,
      `${updates(helper).length} update(s), ${polls} poll(s), ${logins.length} login(s)`);

    await realPoll();
    const first = updates(helper).at(-1);
    check("a full poll logs in to each mailbox -- so this check would see one",
      logins.length === 2, JSON.stringify(logins));
    check("and the first poll carries the card posted before it", ids(first).includes("webhook:early"), JSON.stringify(ids(first)));

    /* What that poll found, as if a mail had been there. */
    const mail = { id: "gmail:personal:41", kind: "email", label: "Gmail", title: "Sam", detail: "Dinner?", timestamp: 1 };
    helper.lastUpdate = { ...helper.lastUpdate, items: [...helper.lastUpdate.items, mail] };
    const polled = { status: helper.lastUpdate.status, generatedAt: helper.lastUpdate.generatedAt };
    const loginsAfterPoll = logins.length;

    const sentBefore = helper.sent.length;
    const answer = await post(port, { id: "garage", title: "Garage door open", detail: "since 9:40 PM" });
    check("a card posted after a poll is taken", answer.status === 200 && answer.body.id === "garage", JSON.stringify(answer));

    const next = helper.sent[sentBefore];
    check("and is in the very next SECOND_BRAIN_UPDATE",
      next?.notification === "SECOND_BRAIN_UPDATE" && next.payload.items.some((item) =>
        item.id === "webhook:garage" && item.title === "Garage door open" && item.detail === "since 9:40 PM"),
      JSON.stringify(next));
    check("which is the only update it caused", helper.sent.length === sentBefore + 1, `${helper.sent.length - sentBefore}`);
    check("without calling pollNow", polls === 0, `${polls} poll(s)`);
    check("without an IMAP login", logins.length === loginsAfterPoll, JSON.stringify(logins.slice(loginsAfterPoll)));
    check("with no ttl bookkeeping sent to the browser", !next?.payload.items.some((item) => "expiresAt" in item));
    check("the rest of the wall is the last poll's, cards in the order a poll puts them",
      JSON.stringify(ids(next)) === JSON.stringify(["webhook:early", "webhook:garage", "gmail:personal:41"]), JSON.stringify(ids(next)));
    check("and so are its poll time and status, so the status line claims no poll that did not happen",
      next?.payload.generatedAt === polled.generatedAt && JSON.stringify(next?.payload.status) === JSON.stringify(polled.status));

    await post(port, { id: "garage", title: "Garage door still open" });
    const replaced = updates(helper).at(-1);
    check("the same id again replaces the card, where it was",
      JSON.stringify(ids(replaced)) === JSON.stringify(["webhook:early", "webhook:garage", "gmail:personal:41"]) &&
      replaced.payload.items[1].title === "Garage door still open", JSON.stringify(replaced?.payload.items));

    const quiet = helper.sent.length;
    await post(port, { id: "garage", title: "Garage door still open", ttl: 3600 });
    check("an unchanged card posted again leaves the wall alone", helper.sent.length === quiet, `${helper.sent.length - quiet} update(s)`);

    for (let i = 0; i < 30; i += 1) {
      await post(port, { id: "counter", title: `Count ${i}` });
    }
    check("thirty posts in a row: thirty updates, no poll, no login",
      helper.sent.length === quiet + 30 && polls === 0 && logins.length === loginsAfterPoll,
      `${helper.sent.length - quiet} update(s), ${polls} poll(s), ${logins.length - loginsAfterPoll} login(s)`);

    const gone = await remove(port, "counter");
    check("DELETE takes a card down", gone.status === 200 && gone.body.deleted === true && !ids(updates(helper).at(-1)).includes("webhook:counter"), JSON.stringify(gone));
    check("in the next update, without a poll or a login", polls === 0 && logins.length === loginsAfterPoll);
    check("leaving everything else up", ids(updates(helper).at(-1)).includes("gmail:personal:41") && ids(updates(helper).at(-1)).includes("webhook:garage"));

    const missing = await remove(port, "counter");
    check("DELETE of a card that is not up is 404", missing.status === 404, JSON.stringify(missing));

    await post(port, { id: "blink", title: "Gone in a moment", ttl: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await post(port, { id: "other", title: "Something else" });
    check("a card past its ttl is gone at the next update", !ids(updates(helper).at(-1)).includes("webhook:blink"), JSON.stringify(ids(updates(helper).at(-1))));

    /* Refused. */
    const before = helper.sent.length;
    const forged = await post(port, { id: "door", title: "Front door unlocked" }, { authorization: `Bearer ${"4f".repeat(32)}` });
    check("the wrong token: 401, saying Bearer is wanted", forged.status === 401 && forged.body.error === "token" && forged.headers["www-authenticate"] === "Bearer", JSON.stringify(forged));
    const bare = await post(port, { id: "door", title: "Front door unlocked" }, {});
    check("no token: 401", bare.status === 401, JSON.stringify(bare));
    check("and neither card is anywhere", helper.sent.length === before && !helper.webhookItems.has("door"));

    const kept = await remove(port, "garage", { authorization: "Bearer nope" });
    check("DELETE with the wrong token is refused, and the card stays", kept.status === 401 && helper.webhookItems.has("garage"), JSON.stringify(kept));

    const big = await post(port, { id: "big", title: "x".repeat(webhook.MAX_BODY_BYTES) });
    check("a body bigger than a card could be: 413", big.status === 413 && !helper.webhookItems.has("big"), JSON.stringify(big));

    const garbled = await post(port, "{ id: 'nope' ");
    check("a body that is not JSON: 400", garbled.status === 400 && garbled.body.error === "not JSON", JSON.stringify(garbled));

    const noId = await post(port, { title: "No id" });
    check("a card with no id: 400, as it always was", noId.status === 400 && noId.body.error === "Missing 'id' in payload", JSON.stringify(noId));

    warnings.length = 0;
    helper.lastWebhookRefusal = null;
    for (let i = 0; i < 5; i += 1) {
      await post(port, { id: "door" }, { authorization: "Bearer nope" });
    }
    check("a refusal repeated five times is logged once", warnings.length === 1 && /401, wrong token/.test(warnings[0]), JSON.stringify(warnings));

    helper.config.configDir = folder();
    const off = await post(port, { id: "door" });
    check("a wall with no webhook.json answers 404 off", off.status === 404 && off.body.error === "off", JSON.stringify(off));
    check("and says why in the journal", /404, no webhook\.json/.test(warnings.at(-1)), JSON.stringify(warnings.at(-1)));
    helper.config.configDir = configDir;

    check("after all that, not one poll and not one login since the first",
      polls === 0 && logins.length === loginsAfterPoll, `${polls} poll(s), ${logins.length - loginsAfterPoll} login(s)`);

    await realPoll();
    check("and the next full poll keeps every card still up",
      ["webhook:early", "webhook:garage", "webhook:other"].every((id) => ids(updates(helper).at(-1)).includes(id)) &&
      !ids(updates(helper).at(-1)).includes("webhook:counter"),
      JSON.stringify(ids(updates(helper).at(-1))));
  } finally {
    server.close();
  }

  /* Another module's body parser on the shared app. */
  const parsedServer = serve(helper, { parsed: true });
  await new Promise((resolve) => parsedServer.listen(0, "127.0.0.1", resolve));

  try {
    const sentBefore = helper.sent.length;
    const parsed = await post(parsedServer.address().port, { id: "parsed", title: "Read by someone else's parser" });
    check("a body another module's parser already read is used, not waited for",
      parsed.status === 200 && ids(helper.sent.at(-1)).includes("webhook:parsed") && helper.sent.length === sentBefore + 1,
      JSON.stringify(parsed));
  } catch (failure) {
    check("a body another module's parser already read is used, not waited for", false, failure.message);
  } finally {
    parsedServer.close();
    helper.stop();
    console.warn = warn;
    console.error = error;
  }
}

(async () => {
  await routeChecks();

  for (const dir of temporary) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nall webhook checks passed\n" : `\n${failures} webhook check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((failure) => {
  console.error(failure);
  process.exit(1);
});
