"use strict";

const NodeHelper = require("node_helper");
const { pollAll } = require("./lib/sources");

/*
 * Every poll opens a fresh IMAP session per account. Polling faster than this
 * gets the upstream account throttled and, on Gmail, temporarily locked out --
 * so the floor is enforced here rather than trusted to config.
 */
const MINIMUM_POLL_INTERVAL_MS = 60 * 1000;

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
      pollIntervalMs: MINIMUM_POLL_INTERVAL_MS
    };

    this.timer = null;
    this.polling = false;
    this.lastPollAt = 0;
  },

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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

        pollIntervalMs: Math.max(
          MINIMUM_POLL_INTERVAL_MS,
          requestedInterval
        )
      };

      this.schedulePolling();
      this.pollNow();

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

  schedulePolling() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(
      () => this.pollNow(),
      this.config.pollIntervalMs
    );
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
        {
          maxItems: this.config.maxItems,
          maxPackageItems: this.config.maxPackageItems,
          stateDir: this.config.stateDir
        },
        console
      );

      console.log(
        `[MMM-SecondBrain] Publishing ` +
        `${items.length} item(s) to display.`
      );

      this._sendSanitizedSocketNotification(
        "SECOND_BRAIN_UPDATE",
        {
          items,
          generatedAt: Date.now()
        }
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
