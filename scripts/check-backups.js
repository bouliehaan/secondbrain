#!/usr/bin/env node
"use strict";

/*
 * Checks for the off-site backup source.
 *
 * Needs no backup server: reports are written to a temporary folder the way
 * the receiver writes them, and the real sanitizer, card rules, pollAll and
 * receiver script are run against them.
 *
 *   node scripts/check-backups.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { sanitizeReport, backupCards } = require("../modules/MMM-SecondBrain/lib/backups.js");
const { pollAll, refreshBackups, getLastPollStatus } = require("../modules/MMM-SecondBrain/lib/sources.js");
const StatusLineLogic = require("../modules/StatusLine/lib/status-line.js");

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
const hour = 60 * minute;
const GB = 1e9;
const now = Date.parse("2026-10-27T16:00:00Z");
const ago = (ms) => new Date(now - ms).toISOString();

function job(id, fields = {}) {
  return {
    id,
    label: `${id} label`,
    pending: { files: 0, bytes: 0 },
    done: { files: 0, bytes: 0, since: null },
    lastSuccess: ago(5 * minute),
    lastProgress: ago(5 * minute),
    ...fields
  };
}

function received(jobs, { running = null, heardAgo = minute } = {}) {
  return {
    report: sanitizeReport(JSON.stringify({ version: 1, sentAt: ago(heardAgo), running, jobs })),
    heardAt: now - heardAgo
  };
}

const cardsFor = (...args) => backupCards(received(...args), {}, now);

function sanitizing() {
  console.log("Sanitizing what arrives");

  check("not JSON is no report", sanitizeReport("{nope") === null);
  check("another version is no report", sanitizeReport('{"version":2,"jobs":[]}') === null);
  check("no jobs array is no report", sanitizeReport('{"version":1}') === null);
  check("an oversized report is no report", sanitizeReport(" ".repeat(70000)) === null);

  const report = sanitizeReport(JSON.stringify({
    version: 1,
    running: "ghost",
    extra: "dropped",
    jobs: [
      { id: "ok-1", label: "Line\u2028break\u0007 and\n tabs\t", script: "<b>x</b>" },
      { id: "Bad Id" },
      { id: "../etc" },
      { id: "ok-1", label: "duplicate" },
      { id: "ok-2", label: "x".repeat(200), pending: { files: -5, bytes: "lots" }, problem: { kind: "exploded", hint: 7 } }
    ]
  }));

  check("bad and duplicate ids are dropped", report.jobs.map((j) => j.id).join() === "ok-1,ok-2");
  check("control characters become spaces", report.jobs[0].label === "Line break and tabs", JSON.stringify(report.jobs[0].label));
  check("unknown fields do not survive", !("script" in report.jobs[0]) && !("extra" in report));
  check("labels are cut to length", report.jobs[1].label.length === 60);
  check("nonsense counts read as zero", report.jobs[1].pending.files === 0 && report.jobs[1].pending.bytes === 0);
  check("an unknown problem kind is a failure", report.jobs[1].problem.kind === "failing");
  check("a running job that is not reported is nobody", report.running === null);

  const many = sanitizeReport(JSON.stringify({ version: 1, jobs: Array.from({ length: 40 }, (_, i) => ({ id: `j${i}` })) }));
  check("at most twelve jobs", many.jobs.length === 12);
}

function cards() {
  console.log("\nWhat goes on the wall");

  const quiet = cardsFor([job("photos"), job("files")]);
  check("caught up shows nothing", quiet.items.length === 0);
  check("and counts as healthy", quiet.health.tried === 2 && quiet.health.failed === 0);

  const small = cardsFor(
    [job("photos", { pending: { files: 6, bytes: 92853 }, rate: 1254 })],
    { running: "photos" }
  );
  check("a small upload shows too", small.items.length === 1 && small.items[0].label === "Backing up", JSON.stringify(small.items));
  check("with a bar", small.items[0]?.kind === "download" && small.items[0]?.progress === 0);
  check("and no speed borrowed from the last backlog", small.items[0]?.detail === "0% · 93 KB left", small.items[0]?.detail);

  const scanning = cardsFor([job("photos")], { running: "photos" });
  check("a run that has nothing to send shows nothing", scanning.items.length === 0);

  const leftover = cardsFor([job("photos", { pending: { files: 12, bytes: 40e6 } })]);
  check("a few files waiting between runs show nothing", leftover.items.length === 0);

  const backlog = {
    pending: { files: 6185, bytes: 182.3 * GB },
    done: { files: 7400, bytes: 77.2 * GB, since: ago(30 * hour) },
    rate: 4.2e6
  };

  const one = cardsFor([job("photos", backlog), job("files")], { running: "photos" });
  const card = one.items[0];
  check("a big backlog uploading is one card", one.items.length === 1, JSON.stringify(one.items));
  check("in Transfers, with a bar", card?.kind === "download" && card?.progress === 29, JSON.stringify(card));
  check("saying how much is left and how fast", card?.detail === "29% · 182.3 GB left · 4.2 MB/s · ~12h", card?.detail);
  check("aged from when the backlog began", card?.timestamp === now - 30 * hour);

  const two = cardsFor(
    [job("photos", backlog), job("other", { pending: { files: 11971, bytes: 63.9 * GB } }), job("files")],
    { running: "photos" }
  );
  const waiting = two.items.find((item) => item.id === "backup:waiting");
  check("a second backlog waits on its own card", two.items.length === 2 && waiting?.title === "other label");
  check("which says what is left", waiting?.detail === "63.9 GB · 11,971 files left", waiting?.detail);
  check("and the running one drops its ETA", !two.items[0].detail.includes("~"), two.items[0].detail);

  const many = cardsFor(
    ["a", "b", "c"].map((id) => job(id, { pending: { files: 2000, bytes: 2 * GB } })),
    { running: "b" }
  );
  check(
    "several waiting are named on one card",
    many.items.find((item) => item.id === "backup:waiting")?.title === "a label and c label"
  );

  /*
   * What the sender sends the moment a backlog clears: nothing pending, and
   * the size of what just went up. It is the expected outcome, so it is not
   * shown, however big or however recent.
   */
  const finished = (at, bytes) => job("photos", { finished: { at: ago(at), files: 13585, bytes } });
  const justDone = cardsFor([finished(minute, 259.5 * GB)]);
  check("a big backlog that just finished shows nothing", justDone.items.length === 0, JSON.stringify(justDone.items));
  check("and counts as healthy", justDone.health.failed === 0);
  check("and the journal says all caught up", justDone.summary === "all 1 caught up", justDone.summary);

  const handedOver = cardsFor(
    [finished(minute, 259.5 * GB), job("files", backlog)],
    { running: "files" }
  );
  check("one job finishing does not hide another uploading", handedOver.items.length === 1 && handedOver.items[0].title === "files label");

  const afterTrouble = cardsFor([
    job("photos", {
      finished: { at: ago(minute), files: 13585, bytes: 259.5 * GB },
      problem: { kind: "failing", since: ago(hour) }
    })
  ]);
  check("but a problem on that job still shows", afterTrouble.items.length === 1 && afterTrouble.items[0].kind === "warning");

  console.log("\nProblems");

  const signedOut = (id) => job(id, {
    pending: { files: 4, bytes: 1e7 },
    problem: { kind: "signed-out", since: ago(2 * hour), hint: "Sign in again" }
  });
  const out = cardsFor([signedOut("a"), signedOut("b"), job("c"), job("d")]);
  check("one card per kind of problem", out.items.length === 1, JSON.stringify(out.items));
  check("naming every job that has it", out.items[0]?.title === "a label and b label");
  check("as a warning", out.items[0]?.kind === "warning" && out.items[0]?.label === "Backup signed out");
  check("with the hint and since when", /^Sign in again · since /.test(out.items[0]?.detail || ""), out.items[0]?.detail);
  check("and no time limit", out.items[0]?.expiresAt === undefined);
  check("the status line reads BACKUP 2/4", (() => {
    const segment = StatusLineLogic.formatSource({ name: "Backup", state: "ok", ok: 4 - out.health.failed, total: out.health.tried });
    return segment?.text === "BACKUP 2/4" && segment.bad;
  })());

  const troubledBacklog = cardsFor(
    [job("photos", { ...backlog, problem: { kind: "failing", since: ago(hour) } })],
    { running: "photos" }
  );
  check("a failing job is not also shown uploading", troubledBacklog.items.length === 1 && troubledBacklog.items[0].kind === "warning");

  const stuck = cardsFor([job("photos", { pending: { files: 30, bytes: 1e8 }, lastProgress: ago(7 * hour) })]);
  check("pending and no upload for hours is a stall", stuck.items[0]?.label === "Backup stalled", JSON.stringify(stuck.items));

  const busy = cardsFor(
    [job("photos", { ...backlog, lastProgress: ago(7 * hour) })],
    { running: "photos" }
  );
  check("but not while it is the one uploading", busy.items[0]?.label === "Backing up");

  console.log("\nSilence");

  const silent = cardsFor([job("photos", backlog)], { running: "photos", heardAgo: 25 * minute });
  check("no report for twenty minutes is a warning", silent.items.length === 1 && silent.items[0].id === "backup:silent");
  check("and nothing stale is shown with it", !silent.items.some((item) => item.kind === "download"));
  check("and the status line says DOWN", silent.health.failed >= silent.health.tried);

  const nonsense = backupCards({ report: null, heardAt: now - minute }, {}, now);
  check("a report that makes no sense is a warning", nonsense.items[0]?.id === "backup:unreadable" && nonsense.health.failed === 1);
}

async function polling() {
  console.log("\nThrough pollAll");

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-backups-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-backups-state-"));
  const reportDir = path.join(configDir, "report");
  const reportPath = path.join(reportDir, "report.json");
  const quiet = { log() {}, info() {}, error() {}, warn() {} };
  const backupStatus = () => getLastPollStatus()?.sources?.find((source) => source.name === "Backup");

  try {
    fs.mkdirSync(reportDir);
    fs.writeFileSync(path.join(configDir, "backups.json"), JSON.stringify({ reportPath }));

    check(
      "before the first full poll there is no wall to refresh",
      (await refreshBackups(configDir, { stateDir }, quiet)) === null
    );

    /*
     * Something that is not a backup card, remembered from a mail poll, to
     * prove the refresh below leaves the rest of the wall alone.
     */
    const shipment = {
      id: "package:amazon:114-0000000-0000002",
      kind: "package",
      title: "Something on its way",
      status: "Shipped",
      orderId: "114-0000000-0000002",
      trackingId: null,
      timestamp: Date.now() - hour,
      lastSeenAt: Date.now() - hour
    };
    fs.writeFileSync(path.join(stateDir, "package_state.json"), JSON.stringify([shipment]));

    const first = await pollAll(configDir, { stateDir }, quiet);
    check("no report yet is off, not down", backupStatus()?.state === "off");
    check("the shipment is on the wall", first.some((item) => item.id === shipment.id));

    /*
     * Through the receiver, as sshd runs it, so the file is exactly what the
     * wall would read.
     */
    const receiver = path.join(__dirname, "..", "system", "backup-report", "secondbrain-backup-receive");
    const report = JSON.stringify({
      version: 1,
      sentAt: new Date().toISOString(),
      running: "photos",
      jobs: [
        {
          id: "photos",
          label: "Photos",
          pending: { files: 5000, bytes: 50 * GB },
          done: { files: 5000, bytes: 50 * GB, since: new Date(Date.now() - hour).toISOString() },
          lastProgress: new Date().toISOString()
        }
      ]
    });
    execFileSync(receiver, [reportDir], { input: report });

    const published = await pollAll(configDir, { stateDir }, quiet);
    const card = published.find((item) => item.id === "backup:running:photos");
    check("the receiver's file becomes a card", card?.progress === 50, JSON.stringify(published));
    check("and the status line says OK", backupStatus()?.state === "ok");

    /*
     * Between full polls. The photo goes up in seconds, so the card has to
     * follow the report without waiting for the next mail poll.
     */
    const photo = JSON.stringify({
      version: 1,
      sentAt: new Date().toISOString(),
      running: "photos",
      jobs: [
        {
          id: "photos",
          label: "Photos",
          pending: { files: 1, bytes: 3.1e6 },
          done: { files: 0, bytes: 0, since: new Date().toISOString() },
          rate: 1254,
          lastProgress: new Date().toISOString()
        }
      ]
    });
    execFileSync(receiver, [reportDir], { input: photo });

    const during = await refreshBackups(configDir, { stateDir }, quiet);
    const photoCard = during?.find((item) => item.id === "backup:running:photos");
    check("a refresh between polls shows the upload", photoCard?.detail === "0% · 3 MB left", JSON.stringify(photoCard));
    check("and keeps everything else", during?.some((item) => item.id === shipment.id));
    check("and does not leave the old card beside it", during?.filter((item) => item.id.startsWith("backup:")).length === 1);

    const finishedReport = JSON.stringify({
      version: 1,
      sentAt: new Date().toISOString(),
      running: null,
      jobs: [{ id: "photos", label: "Photos", finished: { at: new Date().toISOString(), files: 1, bytes: 3.1e6 } }]
    });
    execFileSync(receiver, [reportDir], { input: finishedReport });

    const after = await refreshBackups(configDir, { stateDir }, quiet);
    check("when it is done the card goes at the next refresh", after?.every((item) => !item.id.startsWith("backup:")), JSON.stringify(after));
    check("and the rest of the wall is still there", after?.some((item) => item.id === shipment.id));

    execFileSync(receiver, [reportDir], { input: report });
    await pollAll(configDir, { stateDir }, quiet);

    let refused = false;
    try {
      execFileSync(receiver, [reportDir], { input: "x".repeat(70000), stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      refused = true;
    }
    check("the receiver refuses an oversized report", refused);
    check("and keeps the last good one", fs.readFileSync(reportPath, "utf8") === report);
    check("and leaves nothing behind", fs.readdirSync(reportDir).join() === "report.json");

    const old = new Date(Date.now() - hour);
    fs.utimesSync(reportPath, old, old);
    const stale = await pollAll(configDir, { stateDir }, quiet);
    check("a report an hour old is silence", stale.some((item) => item.id === "backup:silent"));
    check("and the status line says DOWN", backupStatus()?.state === "down");
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function run() {
  console.log("Backup checks\n");

  sanitizing();
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
