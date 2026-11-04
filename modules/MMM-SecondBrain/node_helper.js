"use strict";

const NodeHelper = require("node_helper");
const { pollAll, refreshBackups, cachedItems, getLastPollStatus } = require("./lib/sources");
const webhook = require("./lib/webhook");

/*
 * Every poll opens a fresh IMAP session per account. Polling faster than this
 * gets the upstream account throttled and, on Gmail, temporarily locked out --
 * so the floor is enforced here rather than trusted to config.
 */
const MINIMUM_POLL_INTERVAL_MS = 60 * 1000;

/*
 * The backup card reads a local file, not an account, so it is not held to
 * that floor. A photo uploads in ten or twenty seconds; looking once a
 * minute would miss it.
 */
const BACKUP_REFRESH_MS = 3 * 1000;

// MAGICMIRROR-GV-SANITIZER-V1
const GOOGLE_VOICE_GAP =
  String.raw`(?:\s|&nbsp;|&#160;|<[^>]*>)*`;

const GOOGLE_VOICE_BOILERPLATE = new RegExp(
  `${GOOGLE_VOICE_GAP}` +
  `to${GOOGLE_VOICE_GAP}` +
  `respond${GOOGLE_VOICE_GAP}` +
  `to${GOOGLE_VOICE_GAP}` +
  `this${GOOGLE_VOICE_GAP}` +
  `(?:text${GOOGLE_VOICE_GAP})?` +
  `message\\b[\\s\\S]*$`,
  "i"
);

function stripGoogleVoiceBoilerplate (value) {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .replace(GOOGLE_VOICE_BOILERPLATE, "")
    .replace(
      /(?:\s|&nbsp;|&#160;|<br\s*\/?\s*>|<\/?p\b[^>]*>)+$/gi,
      ""
    )
    .trim();
}

/*
 * A webhook's body, parsed. MagicMirror installs no body parser, so this
 * normally reads the stream itself, never holding more than `limit`; if
 * another module's parser got there first, the stream is spent and what it
 * held is req.body -- waiting for its 'end' would hang the request.
 */
function readJsonBody (req, limit, done) {
  const parse = (value) => {
    if (typeof value !== "string" && !Buffer.isBuffer(value)) {
      return done(null, value);
    }

    try {
      return done(null, JSON.parse(value.toString()));
    } catch {
      return done({ status: 400, body: { error: "not JSON" } });
    }
  };

  if (req.readableEnded) {
    parse(req.body);
    return;
  }

  const chunks = [];
  let size = 0;

  req.on("data", (chunk) => {
    size += chunk.length;

    if (size <= limit) {
      chunks.push(chunk);
    }
  });

  req.on("error", () => {});

  req.on("end", () => {
    if (size > limit) {
      done({ status: 413, body: { error: "size" } });
      return;
    }

    parse(Buffer.concat(chunks));
  });
}

function sanitizeSecondBrainPayload (value) {
  if (typeof value === "string") {
    return stripGoogleVoiceBoilerplate(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeSecondBrainPayload);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(
      ([key, child]) => [
        key,
        sanitizeSecondBrainPayload(child)
      ]
    )
  );
}

module.exports = NodeHelper.create({
  _sendSanitizedSocketNotification (notification, payload) {
    this.sendSocketNotification(
      notification,
      sanitizeSecondBrainPayload(payload)
    );
  },

  start() {
    this.config = {
      configDir: "/etc/magicmirror-secondbrain",
      stateDir: "/var/lib/magicmirror-secondbrain",
      maxItems: 3,
      maxPackageItems: 3,
      maxDownloadItems: 3,
      packageStaleAfterHours: 0,
      pollIntervalMs: MINIMUM_POLL_INTERVAL_MS
    };

    this.timer = null;
    this.timerIntervalMs = null;
    this.backupTimer = null;
    this.refreshingBackups = false;
    this.polling = false;
    this.lastPollAt = 0;
    this.published = false;
    this.lastUpdate = null;
    this.webhookItems = new Map();
    this.lastWebhookRefusal = null;

    if (this.expressApp) {
      /*
       * Cards from scripts on the LAN; lib/webhook.js says what a request
       * looks like and why it needs a token. A card goes up by swapping it
       * into the last full poll (refreshWebhooksNow), never by polling: these
       * used to call pollNow(), so every request was a login to every mailbox,
       * past the 60s floor.
       */
      this.expressApp.post("/secondbrain/webhook", (req, res) => {
        const refused = webhook.authorize(this.config.configDir, req.headers);

        if (refused) {
          req.resume();
          this.noteWebhookRefusal(req, refused);
          this.answerWebhook(res, refused);
          return;
        }

        readJsonBody(req, webhook.MAX_BODY_BYTES, (error, payload) => {
          const card = error ? null : webhook.cardFrom(
            payload,
            this.webhookItems.get(webhook.cardKey(payload?.id)) || null
          );

          if (error || card.error) {
            this.answerWebhook(res, error || { status: 400, body: { error: card.error } });
            return;
          }

          this.webhookItems.set(card.key, card.item);
          res.json({ success: true, id: card.key });
          this.refreshWebhooksNow();
        });
      });

      this.expressApp.delete("/secondbrain/webhook/:id", (req, res) => {
        const refused = webhook.authorize(this.config.configDir, req.headers);

        if (refused) {
          this.noteWebhookRefusal(req, refused);
          this.answerWebhook(res, refused);
          return;
        }

        const key = webhook.cardKey(req.params.id);

        if (!this.webhookItems.has(key)) {
          res.status(404).json({ error: "Not found" });
          return;
        }

        this.webhookItems.delete(key);
        res.json({ success: true, deleted: true });
        this.refreshWebhooksNow();
      });
    }
  },

  answerWebhook(res, outcome) {
    if (outcome.status === 401) {
      res.setHeader("WWW-Authenticate", "Bearer");
    }

    res.status(outcome.status).json(outcome.body);
  },

  /*
   * Say why a request was turned away -- a script that stopped working when
   * the token became required should find out from the journal -- but only
   * when that changes: one posting every few seconds would otherwise bury
   * everything else.
   */
  noteWebhookRefusal(req, outcome) {
    const line =
      `[MMM-SecondBrain] Refused ${req.method} ${req.originalUrl || req.url} from ` +
      `${req.socket?.remoteAddress || "?"}: ${outcome.status}, ${outcome.reason}.`;

    if (line === this.lastWebhookRefusal) {
      return;
    }

    this.lastWebhookRefusal = line;
    console.warn(line);
  },

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "SECOND_BRAIN_CONFIG") {
      const requestedInterval = Number(
        payload?.pollIntervalMs ||
        MINIMUM_POLL_INTERVAL_MS
      );

      if (requestedInterval < MINIMUM_POLL_INTERVAL_MS) {
        console.warn(
          `[MMM-SecondBrain] pollIntervalMs of ${requestedInterval}ms is ` +
          `below the ${MINIMUM_POLL_INTERVAL_MS}ms floor and would get the ` +
          "mail accounts throttled. Using the floor instead."
        );
      }

      this.config = {
        configDir:
          payload?.configDir ||
          "/etc/magicmirror-secondbrain",

        stateDir:
          payload?.stateDir ||
          "/var/lib/magicmirror-secondbrain",

        maxItems: Math.max(
          1,
          Number(payload?.maxItems || 3)
        ),

        maxPackageItems: Math.max(
          0,
          Number(payload?.maxPackageItems ?? 3)
        ),

        /*
         * Active torrents and recent finishes. This used to go unforwarded,
         * and the library's fallback of one meant the wall never showed a
         * second download whatever the config said.
         */
        maxDownloadItems: Math.max(
          0,
          Number(payload?.maxDownloadItems ?? 3)
        ),

        /*
         * How long a shipment stays up depends on its status (lib/sources.js,
         * PACKAGE_DISPLAY_HOURS). This is only a ceiling on those windows; zero
         * or absent means none.
         */
        packageStaleAfterHours: Math.max(
          0,
          Number(payload?.packageStaleAfterHours ?? 0)
        ),

        pollIntervalMs: Math.max(
          MINIMUM_POLL_INTERVAL_MS,
          requestedInterval
        )
      };

      this.publishCached();
      this.schedulePolling();

      /*
       * The browser's config is not a request to poll. MagicMirror calls a
       * module's resume() on every show(), the frontend shows itself on every
       * update that changes a card, and its resume() sends this config again --
       * so each poll that changed anything used to start the next one at once,
       * past the floor. A download's rate changes on every poll, and from
       * midnight to seven on 2026-09-26 the cards changed on every poll: a
       * fresh Gmail and Proton login every seven seconds, some three thousand
       * of them. A page that has just loaded still needs something to draw, so
       * it gets the last answer again; a poll that is due runs as it always
       * did.
       */
      if (Date.now() - this.lastPollAt >= this.config.pollIntervalMs) {
        this.pollNow();
      } else if (this.lastUpdate) {
        this._sendSanitizedSocketNotification(
          "SECOND_BRAIN_UPDATE",
          this.lastUpdate
        );
      }

      return;
    }

    if (notification === "SECOND_BRAIN_REFRESH") {
      /*
       * A refresh request from the browser is a hint, not a command. The backend
       * owns the schedule, so an over-eager or repeatedly reloading frontend can
       * never drive the poll rate past the floor.
       */
      const sinceLastPoll = Date.now() - this.lastPollAt;

      if (sinceLastPoll < this.config.pollIntervalMs) {
        return;
      }

      this.pollNow();
    }
  },

  /*
   * Put the remembered shipments on the wall straight away.
   *
   * The frontend hides itself until its first update, and the first poll waits
   * on every source -- so a slow Gmail or a sulking Proton Bridge used to leave
   * the panel invisible for minutes, looking for all the world like a module
   * that had failed to start. This costs a file read and fills the panel in
   * about a second; the real poll overwrites it moments later.
   */
  publishCached() {
    /*
     * Only ever before the first real poll. The browser re-sends its config on
     * resume and while retrying, and only packages are cached -- so publishing
     * this later would drop mail, Voice and downloads off the wall until the
     * next poll came round.
     */
    if (this.published) {
      return;
    }

    try {
      const items = cachedItems(
        this.config.stateDir,
        {
          maxItems: this.config.maxItems,
          maxPackageItems: this.config.maxPackageItems,
          maxDownloadItems: this.config.maxDownloadItems,
          packageStaleAfterHours: this.config.packageStaleAfterHours
        },
        console
      );

      if (items.length === 0) {
        return;
      }

      console.log(
        `[MMM-SecondBrain] Showing ${items.length} remembered item(s) ` +
        "while the first poll runs."
      );

      this._sendSanitizedSocketNotification(
        "SECOND_BRAIN_UPDATE",
        {
          items,
          generatedAt: Date.now()
        }
      );
    } catch (error) {
      // A cached render is an optimisation; never let it break startup.
      console.error(
        `[MMM-SecondBrain] Cached render failed: ${error.message}`
      );
    }
  },

  schedulePolling() {
    /*
     * Only when the interval changes. The config arrives again on every
     * resume, and restarting the timer each time would keep pushing the next
     * poll back -- often enough, forever.
     */
    if (this.timer && this.timerIntervalMs === this.config.pollIntervalMs) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timerIntervalMs = this.config.pollIntervalMs;

    this.timer = setInterval(
      () => this.pollNow(),
      this.config.pollIntervalMs
    );

    // Once, whatever the poll interval does: it does not depend on the config.
    if (!this.backupTimer) {
      this.backupTimer = setInterval(
        () => this.refreshBackupsNow(),
        BACKUP_REFRESH_MS
      );
    }
  },

  pollOptions() {
    return {
      maxItems: this.config.maxItems,
      maxPackageItems: this.config.maxPackageItems,
      maxDownloadItems: this.config.maxDownloadItems,
      packageStaleAfterHours: this.config.packageStaleAfterHours,
      stateDir: this.config.stateDir
    };
  },

  activeWebhooks() {
    // Clean up expired webhooks
    const now = Date.now();
    for (const [id, item] of this.webhookItems.entries()) {
      if (item.expiresAt && now > item.expiresAt) {
        this.webhookItems.delete(id);
      }
    }

    return Array.from(this.webhookItems.values()).map(item => {
      // Strip expiresAt before sending to frontend
      const { expiresAt, ...rest } = item;
      return rest;
    });
  },

  /*
   * A webhook card has just gone up or come down: put the wall up again
   * without polling. Everything else on it is what the last full poll found,
   * with the poll time and status that poll left, so the status line does not
   * claim a poll that did not happen; only the webhook cards are swapped, in
   * the place a poll puts them. Before the first full poll there is nothing
   * to swap them into, and that poll picks them up itself.
   */
  refreshWebhooksNow() {
    if (!this.lastUpdate) {
      return;
    }

    const others = this.lastUpdate.items.filter(
      (item) => !String(item?.id || "").startsWith(webhook.ID_PREFIX)
    );

    const finalItems = [...this.activeWebhooks(), ...others];

    if (JSON.stringify(finalItems) === JSON.stringify(this.lastUpdate.items)) {
      return;
    }

    this.lastUpdate = { ...this.lastUpdate, items: finalItems };

    this._sendSanitizedSocketNotification(
      "SECOND_BRAIN_UPDATE",
      this.lastUpdate
    );
  },

  /*
   * Between full polls: look at the backup report again and, only if the
   * backup cards changed, put the new wall up. Nothing else is polled, and the
   * poll time and status stay those of the last full poll, so the status line
   * does not claim a fresh poll that did not happen.
   */
  async refreshBackupsNow() {
    if (this.refreshingBackups || !this.lastUpdate) {
      return;
    }

    this.refreshingBackups = true;

    try {
      const items = await refreshBackups(
        this.config.configDir,
        this.pollOptions(),
        console
      );

      if (!items) {
        return;
      }

      const finalItems = [...this.activeWebhooks(), ...items];

      if (JSON.stringify(finalItems) === JSON.stringify(this.lastUpdate.items)) {
        return;
      }

      this.lastUpdate = { ...this.lastUpdate, items: finalItems };

      this._sendSanitizedSocketNotification(
        "SECOND_BRAIN_UPDATE",
        this.lastUpdate
      );
    } catch (error) {
      console.error(
        `[MMM-SecondBrain] Backup refresh failed: ${error.message}`
      );
    } finally {
      this.refreshingBackups = false;
    }
  },

  async pollNow() {
    if (this.polling) {
      return;
    }

    this.polling = true;
    this.lastPollAt = Date.now();

    try {
      const items = await pollAll(
        this.config.configDir,
        this.pollOptions(),
        console
      );

      const finalItems = [...this.activeWebhooks(), ...items];

      /*
       * The elapsed time is here because its absence cost an afternoon: a poll
       * that took four minutes logged exactly the same line as one that took
       * two seconds, so a slow source looked identical to a broken module.
       */
      console.log(
        `[MMM-SecondBrain] Publishing ` +
        `${finalItems.length} item(s) to display ` +
        `(poll took ${((Date.now() - this.lastPollAt) / 1000).toFixed(1)}s).`
      );

      this.published = true;

      this.lastUpdate = {
        items: finalItems,

        /*
         * Per-source health for the status line under the calendar: which
         * of Gmail, Proton and Transmission answered, how long the poll
         * took, and how often one is due -- so the line can say when the
         * next is late. The frontend re-broadcasts it; the items diff there
         * ignores it, so an unchanged wall still gets a fresh poll time.
         */
        status: getLastPollStatus()
          ? { ...getLastPollStatus(), intervalMs: this.config.pollIntervalMs }
          : null,

        generatedAt: Date.now()
      };

      this._sendSanitizedSocketNotification(
        "SECOND_BRAIN_UPDATE",
        this.lastUpdate
      );
    } catch (error) {
      console.error(
        `[MMM-SecondBrain] Poll failed: ` +
        `${error.stack || error.message}`
      );
    } finally {
      this.polling = false;
    }
  }
});
