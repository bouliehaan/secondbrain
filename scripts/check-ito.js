#!/usr/bin/env node
"use strict";

/*
 * Checks for the texts ito's phone pushes to the wall.
 *
 * Needs no phone: reports are signed here the way the phone signs them, and
 * sent to the real route over a real socket, through the real node_helper.
 * enable-ito runs against a temporary folder.
 *
 *   node scripts/check-ito.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

const ito = require("../modules/MMM-SecondBrain/lib/ito.js");
const { pollAll, refreshIto } = require("../modules/MMM-SecondBrain/lib/sources.js");

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

const quiet = { log() {}, info() {}, warn() {}, error() {} };
const minute = 60000;
const now = Date.parse("2026-11-04T18:00:00Z");

const keyText = Buffer.alloc(32, 7).toString("base64url");
const key = Buffer.from(keyText, "base64url");

function folder(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-ito-"));

  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, "ito.json"), JSON.stringify(config));
  }

  return dir;
}

function signed(report, time = now, signingKey = key) {
  const body = Buffer.from(typeof report === "string" ? report : JSON.stringify(report));

  return {
    headers: {
      "x-ito-time": String(time),
      "x-ito-signature": ito.sign(signingKey, String(time), body)
    },
    body
  };
}

function text(fields = {}) {
  return { id: "a1b2c3", from: "Mom", n: 1, at: now - 5 * minute, person: true, ...fields };
}

function receive(dir, request, at = now) {
  return ito.receive(dir, request.headers, request.body, at);
}

console.log("\nito texts\n");

/* ------------------------------------------------------------------ *
 * The signature, the clock and replays
 * ------------------------------------------------------------------ */

{
  ito.reset();
  const dir = folder({ key: keyText });

  const first = receive(dir, signed({ v: 1, texts: [text()] }));
  check("a signed report is taken", first.status === 200 && first.accepted, JSON.stringify(first));
  check("and the answer says how many cards are up", first.body.cards === 1, JSON.stringify(first.body));

  const again = receive(dir, signed({ v: 1, texts: [text()] }));
  check("the same report again is refused as stale", again.status === 409 && again.body.error === "stale", JSON.stringify(again));

  const older = receive(dir, signed({ v: 1, texts: [] }, now - minute));
  check("an older report is refused as stale", older.status === 409, JSON.stringify(older));

  const newer = receive(dir, signed({ v: 1, texts: [] }, now + 1000), now + 1000);
  check("a newer one is taken", newer.status === 200, JSON.stringify(newer));

  const wrongKey = receive(dir, signed({ v: 1, texts: [text()] }, now + 2000, Buffer.alloc(32, 9)), now + 2000);
  check("another key's signature is refused", wrongKey.status === 403 && wrongKey.body.error === "signature", JSON.stringify(wrongKey));

  const tampered = signed({ v: 1, texts: [text()] }, now + 3000);
  tampered.body = Buffer.from(tampered.body.toString().replace("Mom", "Mum"));
  const edited = receive(dir, tampered, now + 3000);
  check("a report changed after signing is refused", edited.status === 403, JSON.stringify(edited));

  const unsigned = ito.receive(dir, {}, Buffer.from("{\"v\":1,\"texts\":[]}"), now + 4000);
  check("an unsigned report is refused", unsigned.status === 403 && unsigned.body.error === "signature", JSON.stringify(unsigned));

  const skewed = receive(dir, signed({ v: 1, texts: [] }, now + 10 * minute), now + 5000);
  check(
    "a report ten minutes off the wall's clock is refused, and says by how much",
    skewed.status === 403 && skewed.body.error === "clock" && Math.round(skewed.body.skewMs / minute) === 10,
    JSON.stringify(skewed)
  );

  const garbage = receive(dir, signed("not json", now + 6000), now + 6000);
  check("a signed body that is not JSON is refused", garbage.status === 400, JSON.stringify(garbage));

  const future = receive(dir, signed({ v: 2, texts: [] }, now + 7000), now + 7000);
  check("a report of another version is refused", future.status === 400 && future.body.error === "version", JSON.stringify(future));

  const big = receive(dir, signed({ v: 1, texts: [], pad: "x".repeat(ito.MAX_BODY_BYTES) }, now + 8000), now + 8000);
  check("a report bigger than any report could be is refused", big.status === 413, JSON.stringify(big));
}

{
  ito.reset();
  const absent = receive(folder(), signed({ v: 1, texts: [text()] }));
  check("with no ito.json the wall says it is off", absent.status === 404 && absent.body.error === "off", JSON.stringify(absent));

  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "../config/secondbrain/ito.example.json"), "utf8"));
  const copied = receive(folder(example), signed({ v: 1, texts: [text()] }));
  check("a copy of the example, with no real key, is off too", copied.status === 404, JSON.stringify(copied));

  const disabled = receive(folder({ key: keyText, enabled: false }), signed({ v: 1, texts: [text()] }));
  check("enabled: false turns it off", disabled.status === 404, JSON.stringify(disabled));
}

/* ------------------------------------------------------------------ *
 * What a report becomes on the wall
 * ------------------------------------------------------------------ */

{
  const report = ito.sanitizeReport({
    v: 1,
    texts: [
      text({ body: "the text itself", extra: "<script>" }),
      text({ id: "a1b2c3", from: "duplicate" }),
      text({ id: "../etc", from: "bad id" }),
      text({ id: "b2", from: "no time", at: "soon" }),
      text({ id: "c3", from: `Jo\u0000\u001b[31m ${"o".repeat(200)}`, n: 1e9, group: "  the\nfamily  " })
    ]
  });

  check("only well-formed texts survive, once each", report.texts.map((t) => t.id).join() === "a1b2c3,c3", JSON.stringify(report));
  check("no field the wall did not ask for survives", !JSON.stringify(report).includes("the text itself") && !JSON.stringify(report).includes("script"));
  const jo = report.texts[1];
  check("names lose control characters and are cut to length", !/[\u0000-\u001f]/.test(jo.from) && jo.from.length <= 80, JSON.stringify(jo.from));
  check("counts are bounded", jo.n === 999, String(jo.n));
  check("group names are folded to one line", jo.group === "the family", JSON.stringify(jo.group));
}

{
  const report = ito.sanitizeReport({
    v: 1,
    texts: [
      text({ id: "mom", from: "Mom", n: 1, at: now - 5 * minute }),
      text({ id: "sam", from: "Sam", n: 3, at: now - 100 * minute, group: "trip" }),
      text({ id: "old", from: "Alex", at: now - 121 * minute }),
      text({ id: "code", from: "72975", at: now - 10 * minute, person: false }),
      text({ id: "oldcode", from: "72975", at: now - 31 * minute, person: false })
    ]
  });
  const cards = ito.itoCards(report, {}, now);
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));

  check("a person's text stays two hours", byId["ito:mom"] && !byId["ito:old"], Object.keys(byId).join());
  check("a short code's stays half an hour", byId["ito:code"] && !byId["ito:oldcode"], Object.keys(byId).join());
  check("the card says who, as a text", byId["ito:mom"]?.title === "Mom" && byId["ito:mom"]?.kind === "voice" && byId["ito:mom"]?.label === "Text");
  check("one text needs no detail", byId["ito:mom"]?.detail === "", JSON.stringify(byId["ito:mom"]?.detail));
  check("several, in a group, say so", byId["ito:sam"]?.detail === "3 texts in trip", JSON.stringify(byId["ito:sam"]?.detail));
  check("a person ranks with Google Voice, a short code below mail", byId["ito:mom"]?.priority === 100 && byId["ito:code"]?.priority < 75);
  check("each card comes down two hours after its text", byId["ito:mom"]?.expiresAt === now - 5 * minute + 120 * minute);

  const longer = ito.itoCards(report, { textMinutes: 180, machineMinutes: 60 }, now).map((card) => card.id);
  check("textMinutes and machineMinutes change the windows", longer.includes("ito:old") && longer.includes("ito:oldcode"), longer.join());
}

/* ------------------------------------------------------------------ *
 * Into the wall's poll, without polling a mailbox
 * ------------------------------------------------------------------ */

async function pollChecks() {
  ito.reset();
  const dir = folder({ key: keyText });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-ito-state-"));
  const options = { stateDir, maxItems: 3, sourceTimeoutMs: 30000 };
  const t = Date.now();

  check("before any report the poll has no texts", (await pollAll(dir, options, quiet)).length === 0);

  ito.receive(dir, signed({ v: 1, texts: [text({ at: t - minute })] }, t).headers, signed({ v: 1, texts: [text({ at: t - minute })] }, t).body, t);
  const first = await pollAll(dir, options, quiet);
  check("a full poll carries the phone's texts", first.length === 1 && first[0].id === "ito:a1b2c3", JSON.stringify(first));
  check("and nothing a card's lifetime is kept in reaches the browser", first[0] && !("expiresAt" in first[0]));

  const read = signed({ v: 1, texts: [] }, t + 1000);
  ito.receive(dir, read.headers, read.body, t + 1000);
  const after = refreshIto(dir, options, quiet);
  check("a text read or answered leaves at the next report, without a poll", Array.isArray(after) && after.length === 0, JSON.stringify(after));

  const many = signed({
    v: 1,
    texts: ["a", "b", "c", "d", "e"].map((id, i) => text({ id, from: id, at: t - i * minute }))
  }, t + 2000);
  ito.receive(dir, many.headers, many.body, t + 2000);
  const capped = refreshIto(dir, options, quiet);
  check("five unread conversations still take only maxItems cards", capped.length === 3 && capped[0].id === "ito:a", JSON.stringify(capped.map((c) => c.id)));

  fs.rmSync(path.join(dir, "ito.json"));
  check("turning ito off takes its cards down", refreshIto(dir, options, quiet).length === 0);
}

/* ------------------------------------------------------------------ *
 * The route, over a real socket, through the real node_helper
 * ------------------------------------------------------------------ */

/*
 * MagicMirror's NodeHelper, cut to what the helper uses, and an express app
 * cut to post/delete, a status and a JSON answer -- on a real HTTP server, so
 * the body arrives in chunks the way it does on the wall.
 */
class FakeNodeHelper {
  constructor() {
    this.sent = [];
    const routes = [];
    this.routes = routes;
    this.expressApp = {
      post: (route, handler) => routes.push({ method: "POST", route, handler }),
      delete: (route, handler) => routes.push({ method: "DELETE", route, handler })
    };
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

function serve(helper) {
  return http.createServer((req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); return res; };
    const match = helper.routes.find((r) => r.method === req.method && r.route === req.url);

    if (!match) {
      res.status(404).json({});
      return;
    }

    match.handler(req, res);
  });
}

function post(port, request) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/secondbrain/ito",
      method: "POST",
      headers: { "Content-Type": "application/x-ito-wall", ...request.headers }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    // Two writes: the helper must put the body back together before checking it.
    const half = Math.floor(request.body.length / 2);
    req.write(request.body.subarray(0, half));
    req.end(request.body.subarray(half));
  });
}

async function routeChecks() {
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === "node_helper" ? "node_helper" : resolveFilename.call(this, request, ...rest);
  };
  const fake = new Module("node_helper");
  fake.exports = FakeNodeHelper;
  fake.loaded = true;
  require.cache.node_helper = fake;

  const Helper = require("../modules/MMM-SecondBrain/node_helper.js");
  const helper = new Helper();
  const warn = console.warn;
  console.warn = () => {};
  helper.start();

  ito.reset();
  const dir = folder({ key: keyText });
  helper.config.configDir = dir;
  helper.config.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-ito-state-"));

  // What the first full poll left: the wall as it stood before the text.
  helper.lastUpdate = { items: [], status: null, generatedAt: Date.now() };
  await refreshIto(dir, helper.pollOptions(), quiet);
  await pollAll(dir, { stateDir: helper.config.stateDir }, quiet);
  let polled = 0;
  helper.pollNow = () => { polled += 1; };

  const server = serve(helper);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const t = Date.now();
    const answer = await post(port, signed({ v: 1, texts: [text({ at: t - minute })] }, t));
    check("the route takes a signed report", answer.status === 200 && answer.body.ok === true, JSON.stringify(answer));

    const update = helper.sent.at(-1);
    check(
      "and the card is on the wall at once",
      update?.notification === "SECOND_BRAIN_UPDATE" && update.payload.items.some((item) => item.id === "ito:a1b2c3"),
      JSON.stringify(update)
    );
    check("without logging into a mailbox to get it there", polled === 0, `${polled} poll(s)`);
    check("and no text body is anywhere in what the browser got", !JSON.stringify(helper.sent).includes("body"));

    const sentBefore = helper.sent.length;
    const forged = await post(port, signed({ v: 1, texts: [text({ id: "x", from: "Forged" })] }, t + 1000, Buffer.alloc(32, 1)));
    check("the route refuses a forged report", forged.status === 403 && forged.body.error === "signature", JSON.stringify(forged));
    check("and the wall does not change for it", helper.sent.length === sentBefore);

    const off = folder();
    helper.config.configDir = off;
    const unset = await post(port, signed({ v: 1, texts: [] }, t + 2000));
    check("a wall without ito set up answers 404 off", unset.status === 404 && unset.body.error === "off", JSON.stringify(unset));
  } finally {
    server.close();
    helper.stop();
    console.warn = warn;
  }
}

/* ------------------------------------------------------------------ *
 * enable-ito
 * ------------------------------------------------------------------ */

function enableChecks() {
  const script = path.join(__dirname, "../system/ito/enable-ito");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-ito-etc-"));
  const reader = os.userInfo().username;
  const run = (...args) => execFileSync("bash", [script, "--config-dir", dir, "--reader", reader, "--address", "10.0.0.5", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const printed = run();
  const file = path.join(dir, "ito.json");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  check("enable-ito writes a 32-byte key", Buffer.from(written.key, "base64url").length === 32 && /^[A-Za-z0-9_-]{43}$/.test(written.key), written.key);
  check("readable by the wall's account alone", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  check("and prints the line to paste into ito", printed.includes(`http://10.0.0.5:43761 ${written.key}`), printed);

  fs.writeFileSync(file, JSON.stringify({ ...written, textMinutes: 90 }));
  run();
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  check("run again, it keeps the key and the rest of the file", kept.key === written.key && kept.textMinutes === 90, JSON.stringify(kept));

  run("--new-key");
  const rotated = JSON.parse(fs.readFileSync(file, "utf8"));
  check("--new-key replaces only the key", rotated.key !== written.key && rotated.textMinutes === 90, JSON.stringify(rotated));

  ito.reset();
  const t = Date.now();
  const accepted = ito.receive(dir, signed({ v: 1, texts: [] }, t, Buffer.from(rotated.key, "base64url")).headers,
    signed({ v: 1, texts: [] }, t, Buffer.from(rotated.key, "base64url")).body, t);
  check("the wall takes reports signed with the key it printed", accepted.status === 200, JSON.stringify(accepted));

  run("--remove");
  check("--remove forgets it", !fs.existsSync(file));
}

(async () => {
  await pollChecks();
  await routeChecks();
  enableChecks();

  console.log(failures === 0 ? "\nall ito checks passed\n" : `\n${failures} ito check(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
