"use strict";

/*
 * Off-site backups, as the backup server reports them.
 *
 * The wall never reaches out for this. The machine doing the backups pushes
 * a small JSON report over SSH every few minutes, to an account on the wall
 * that can do one thing: replace one file (system/bin/secondbrain-backup-receive,
 * set up by scripts/enable-backup-report.sh). The poll reads that file. So the
 * wall holds no credentials for the backup server, opens no port for it, and
 * the backup server needs nothing from the wall but that one account.
 *
 * Everything in the report is treated as untrusted. sanitizeReport keeps the
 * fields below and nothing else, and every string is cut to length:
 *
 *   {
 *     "version": 1,
 *     "sentAt": "2026-10-27T16:10:09Z",
 *     "running": "photos-a",                  id of the job uploading now, or null
 *     "jobs": [{
 *       "id": "photos-a",                     [a-z0-9_-], what the sender calls it
 *       "label": "Alex's photos",             what the wall calls it
 *       "pending":  { "files": 6185, "bytes": 182300000000 },
 *       "done":     { "files": 7400, "bytes": 77200000000, "since": "..." },
 *       "rate": 4200000,                      bytes per second of the last chunk
 *       "lastSuccess": "...",                 last run that left nothing pending
 *       "lastProgress": "...",                last time anything was uploaded
 *       "problem":  { "kind": "signed-out", "since": "...", "hint": "..." }
 *     }]
 *   }
 *
 * A problem's kind is signed-out, unreachable, source-missing, failing or
 * stalled; anything else reads as failing.
 *
 * `done` is the backlog being worked through: what has gone up since the job
 * last had nothing pending. The sender resets it when the backlog clears. So
 * done / (done + pending) is the progress of the whole backlog, which
 * survives the sender splitting a days-long upload into turns, and grows
 * honestly when new files join it.
 *
 * What goes on the wall, by what the backups are doing:
 *
 *   caught up                     nothing; the status line says BACKUP OK
 *   a run with nothing to send    nothing; it only looked
 *   uploading, of any size        Transfers card with a progress bar
 *   big backlogs waiting a turn   one Transfers card naming them
 *   a backlog finishing           nothing; a backup that works is not news
 *   a problem                     a warning for as long as it is true
 *   no report for STALE_MINUTES   a warning, and nothing older is shown
 *
 * The wall shows what is happening and what is wrong, never what went right.
 * The sender also reports the size of the last backlog it cleared (`finished`);
 * it is dropped here on purpose.
 *
 * The problem cards are the one thing here with no time limit. They are not
 * news that ages; they are the current state, and the next report that says
 * otherwise takes them down.
 */

const fs = require("node:fs");

const DEFAULT_REPORT_PATH = "/var/lib/secondbrain-backup/report/report.json";

/*
 * The sender reports every five minutes. Four missed reports in a row is a
 * dead sender, a dead network or a dead receiver, and any of those means the
 * wall no longer knows whether the backups work.
 */
const DEFAULT_STALE_MINUTES = 20;

/*
 * A backlog worth a card while it is only waiting its turn. One that is
 * uploading shows at any size; a few files left over between runs would be
 * a card that comes and goes for nothing.
 */
const DEFAULT_SHOW_FROM_GB = 1;
const DEFAULT_SHOW_FROM_FILES = 1000;

/*
 * Pending files and no upload for this long, with no problem reported, is a
 * backup that has quietly stopped. A job that is only waiting its turn behind
 * another one waits a few hours at most.
 */
const DEFAULT_STALLED_HOURS = 6;

const MAX_REPORT_BYTES = 64 * 1024;
const MAX_JOBS = 12;

const PROBLEM_LABELS = {
  "signed-out": "Backup signed out",
  unreachable: "Backup can't reach Drive",
  "source-missing": "Backup source missing",
  failing: "Backup failing",
  stalled: "Backup stalled"
};

function text(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function count(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function instant(value) {
  if (typeof value !== "string" || value.length > 40) {
    return null;
  }

  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

function amount(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return { files: count(value.files), bytes: count(value.bytes) };
}

function sanitizeJob(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = typeof raw.id === "string" ? raw.id : "";

  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
    return null;
  }

  const done = amount(raw.done);
  const problem = raw.problem && typeof raw.problem === "object" ? raw.problem : null;

  return {
    id,
    label: text(raw.label, 60) || id,
    pending: amount(raw.pending) || { files: 0, bytes: 0 },
    done: done ? { ...done, since: instant(raw.done.since) } : { files: 0, bytes: 0, since: null },
    rate: count(raw.rate),
    lastSuccess: instant(raw.lastSuccess),
    lastProgress: instant(raw.lastProgress),
    problem: problem
      ? {
        kind: Object.hasOwn(PROBLEM_LABELS, problem.kind) ? problem.kind : "failing",
        since: instant(problem.since),
        hint: text(problem.hint, 160)
      }
      : null
  };
}

/**
 * Turn whatever arrived into a report the rest of this file can trust, or null.
 *
 * @param {string} body the file as received
 * @returns {object|null}
 */
function sanitizeReport(body) {
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_REPORT_BYTES) {
    return null;
  }

  let raw;

  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object" || raw.version !== 1 || !Array.isArray(raw.jobs)) {
    return null;
  }

  const jobs = [];
  const seen = new Set();

  for (const candidate of raw.jobs.slice(0, MAX_JOBS)) {
    const job = sanitizeJob(candidate);

    if (job && !seen.has(job.id)) {
      seen.add(job.id);
      jobs.push(job);
    }
  }

  return {
    sentAt: instant(raw.sentAt),
    running: typeof raw.running === "string" && seen.has(raw.running) ? raw.running : null,
    jobs
  };
}

/**
 * Read the report the backup server last pushed.
 *
 * @param {string} reportPath
 * @returns {{report: object|null, heardAt: number}|null} null when nothing has
 *   ever arrived; throws when the file is there but cannot be read
 */
function readReport(reportPath) {
  let stat;

  try {
    stat = fs.statSync(reportPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  /*
   * When it arrived, by the wall's clock rather than the sender's: the file
   * is replaced whole on every report, so its mtime is the last time the
   * backup server got through.
   */
  return {
    report: sanitizeReport(fs.readFileSync(reportPath, "utf8")),
    heardAt: stat.mtimeMs
  };
}

function formatBytes(bytes) {
  if (bytes >= 1e12) {
    return `${(bytes / 1e12).toFixed(2)} TB`;
  }

  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }

  if (bytes >= 1e6) {
    return `${Math.round(bytes / 1e6)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function formatRate(bytesPerSecond) {
  return bytesPerSecond >= 1e6
    ? `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bytesPerSecond / 1e3))} KB/s`;
}

function formatFiles(files) {
  return `${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"}`;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/*
 * "3:12 PM" today, "Mon 3:12 PM" within the week, "Oct 21" before that. The
 * wall's own clock is twelve-hour, so this is too.
 */
function formatWhen(ms, now) {
  const when = new Date(ms);
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  if (when.toDateString() === new Date(now).toDateString()) {
    return time;
  }

  if (now - ms < 6 * 86400000) {
    return `${when.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  }

  return when.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function joinLabels(jobs) {
  const labels = jobs.map((job) => job.label);

  return labels.length <= 2
    ? labels.join(" and ")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function percentDone(job) {
  const total = job.done.bytes + job.pending.bytes;

  return total > 0 ? Math.min(99, Math.floor((job.done.bytes / total) * 100)) : null;
}

/**
 * What the wall shows for one report.
 *
 * @param {{report: object|null, heardAt: number}} received from readReport
 * @param {object} [options] the optional fields of backups.json
 * @param {number} [now]
 * @returns {{items: object[], health: {tried: number, failed: number}, summary: string}}
 */
function backupCards(received, options = {}, now = Date.now()) {
  const minutes = (value, fallback) =>
    Number(value) > 0 ? Number(value) * 60000 : fallback * 60000;

  const staleMs = minutes(options.staleAfterMinutes, DEFAULT_STALE_MINUTES);
  const stalledMs = minutes(Number(options.stalledAfterHours) * 60, DEFAULT_STALLED_HOURS * 60);
  const showFromBytes =
    (Number(options.showFromGB) > 0 ? Number(options.showFromGB) : DEFAULT_SHOW_FROM_GB) * 1e9;
  const showFromFiles =
    Number(options.showFromFiles) > 0 ? Number(options.showFromFiles) : DEFAULT_SHOW_FROM_FILES;

  const { report, heardAt } = received;

  if (!report) {
    return {
      items: [{
        id: "backup:unreadable",
        kind: "warning",
        label: "Backups",
        title: "The backup report makes no sense",
        detail: `Received ${formatWhen(heardAt, now)}`,
        timestamp: heardAt,
        priority: 90
      }],
      health: { tried: 1, failed: 1 },
      summary: "the last report could not be read"
    };
  }

  /*
   * Silence is the failure every other card here depends on noticing. Once
   * the reports stop, what the last one said is no longer true, so it is not
   * shown: a progress bar frozen at 41% would read as an upload in progress.
   */
  if (now - heardAt > staleMs) {
    return {
      items: [{
        id: "backup:silent",
        kind: "warning",
        label: "Backups",
        title: "No word from the backup server",
        detail: `Last report ${formatWhen(heardAt, now)}`,
        timestamp: heardAt,
        priority: 90
      }],
      health: { tried: 1, failed: 1 },
      summary: `no report since ${new Date(heardAt).toISOString()}`
    };
  }

  const items = [];
  const notes = [];

  const big = (job) =>
    job.done.bytes + job.pending.bytes >= showFromBytes ||
    job.done.files + job.pending.files >= showFromFiles;

  /*
   * One card per kind of problem, naming every job that has it. When the
   * network goes, every job fails at once, and four identical warnings
   * would push the texts off the wall for one fault.
   */
  const problems = new Map();

  for (const job of report.jobs) {
    let problem = job.problem;

    if (
      !problem &&
      job.pending.files > 0 &&
      report.running !== job.id &&
      job.lastProgress !== null &&
      now - job.lastProgress > stalledMs
    ) {
      problem = {
        kind: "stalled",
        since: job.lastProgress,
        hint: `${formatFiles(job.pending.files)} waiting, nothing uploaded`
      };
    }

    if (problem) {
      const group = problems.get(problem.kind) || [];
      group.push({ job, problem });
      problems.set(problem.kind, group);
    }
  }

  for (const [kind, group] of problems) {
    const since = Math.min(...group.map(({ problem }) => problem.since ?? now));
    const hints = [...new Set(group.map(({ problem }) => problem.hint).filter(Boolean))];

    items.push({
      id: `backup:problem:${kind}`,
      kind: "warning",
      label: PROBLEM_LABELS[kind],
      title: joinLabels(group.map(({ job }) => job)),
      detail: [hints.length === 1 ? hints[0] : "", `since ${formatWhen(since, now)}`]
        .filter(Boolean)
        .join(" · "),
      timestamp: since,
      priority: 90
    });

    notes.push(`${kind}: ${group.map(({ job }) => job.id).join(", ")}`);
  }

  const troubled = new Set(
    [...problems.values()].flat().map(({ job }) => job.id)
  );

  const backlogs = report.jobs.filter(
    (job) => job.pending.files > 0 && !troubled.has(job.id)
  );
  const running = backlogs.find((job) => job.id === report.running);
  const waiting = backlogs.filter((job) => job !== running && big(job));

  if (running) {
    const percent = percentDone(running);
    const parts = [];

    if (percent !== null) {
      parts.push(`${percent}%`);
    }

    parts.push(`${formatBytes(running.pending.bytes)} left`);

    /*
     * The sender keeps the last rate it measured after a backlog clears, so
     * until this one has uploaded something the rate is the previous
     * backlog's, and an ETA from it would be a guess about the wrong files.
     */
    if (running.rate > 0 && running.done.bytes > 0) {
      parts.push(formatRate(running.rate));

      /*
       * Only when nothing else is queued. Jobs take turns, so with another
       * backlog waiting this one gets a share of the time, and an ETA worked
       * out from its own rate would be wrong by however many there are.
       */
      if (waiting.length === 0) {
        parts.push(`~${formatDuration(running.pending.bytes / running.rate)}`);
      }
    }

    items.push({
      id: `backup:running:${running.id}`,
      kind: "download",
      label: "Backing up",
      title: running.label,
      detail: parts.join(" · "),
      timestamp: running.done.since ?? heardAt,
      priority: 44,
      ...(percent !== null ? { progress: percent } : {})
    });

    notes.push(`${running.id} uploading, ${percent ?? "?"}%, ${formatBytes(running.pending.bytes)} left`);
  }

  if (waiting.length > 0) {
    const files = waiting.reduce((sum, job) => sum + job.pending.files, 0);
    const bytes = waiting.reduce((sum, job) => sum + job.pending.bytes, 0);
    const since = Math.min(...waiting.map((job) => job.done.since ?? heardAt));

    items.push({
      id: "backup:waiting",
      kind: "download",
      label: "Backup waiting",
      title: joinLabels(waiting),
      detail: `${formatBytes(bytes)} · ${formatFiles(files)} left`,
      timestamp: since,
      priority: 40
    });

    notes.push(`waiting: ${waiting.map((job) => job.id).join(", ")}`);
  }

  return {
    items,
    health: {
      tried: Math.max(1, report.jobs.length),
      failed: troubled.size
    },
    summary: notes.length > 0 ? notes.join("; ") : `all ${report.jobs.length} caught up`
  };
}

module.exports = {
  DEFAULT_REPORT_PATH,
  sanitizeReport,
  readReport,
  backupCards
};
