"use strict";

const NodeHelper = require("node_helper");

const { pollNowPlaying, loadSamoConfig, createDetailCache } = require("./lib/samo-client");

/*
 * The poll floor.
 *
 * Unlike the mail sources next door, there is no upstream to anger here: this
 * talks to a process on the same machine over loopback and reads one small JSON
 * document. The floor exists only to stop a misconfigured interval turning into
 * a busy loop.
 *
 * The default of ten seconds is not arbitrary either -- it is the rate the
 * samo-radio daemon itself refreshes channel metadata at, so polling faster
 * would return the same answer and polling much slower would show a finished
 * track.
 */
const MINIMUM_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;

module.exports = NodeHelper.create({
  start () {
    this.config = {
      configDir: "/etc/magicmirror-secondbrain",
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS
    };

    this.timer = null;
    this.polling = false;
    this.cache = createDetailCache();

    /*
     * The last payload we published, serialised.
     *
     * The frontend does its own identical check, but the comparison has to
     * happen here too: a card carries its cover art inline as a data URI, and
     * pushing forty kilobytes of unchanged base64 down the socket every ten
     * seconds to have the browser throw it away is work nobody needs doing.
     */
    this.lastPayload = null;

    /*
     * Whether samo answered last time. Only transitions are logged -- a wall
     * that runs for a week with samo-server stopped would otherwise write sixty
     * thousand identical lines into the journal, which is how the interesting
     * lines get lost.
     */
    this.reachable = null;
  },

  stop () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "NOW_PLAYING_CONFIG") {
      return;
    }

    const requested = Number(payload?.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;

    this.config = {
      configDir: payload?.configDir || "/etc/magicmirror-secondbrain",
      pollIntervalMs: Math.max(MINIMUM_POLL_INTERVAL_MS, requested)
    };

    /*
     * Read the credentials once, here, rather than on every poll. It also gives
     * the one clear startup line that says whether this module is configured at
     * all -- the difference between "off on purpose" and "broken" is otherwise
     * invisible, and this project has lost days to exactly that distinction.
     */
    this.samo = loadSamoConfig(this.config.configDir, console);

    if (!this.samo) {
      console.log(
        "[NowPlaying] No samo.json in " + this.config.configDir +
        " -- Now Playing is off. Copy config/secondbrain/samo.example.json " +
        "there and put a samo API token in it to turn it on."
      );
      return;
    }

    console.log(
      `[NowPlaying] Watching samo at ${this.samo.baseUrl} ` +
      `every ${this.config.pollIntervalMs / 1000}s ` +
      (this.samo.deviceId
        ? `(device ${this.samo.deviceId}).`
        : "(device chosen automatically).")
    );

    this.schedulePolling();
    this.pollNow();
  },

  schedulePolling () {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(
      () => this.pollNow(),
      this.config.pollIntervalMs
    );
  },

  async pollNow () {
    if (this.polling || !this.samo) {
      return;
    }

    this.polling = true;

    try {
      const now = await pollNowPlaying(
        this.config.configDir,
        { config: this.samo, cache: this.cache },
        console
      );

      this.noteReachability(now !== null);
      this.publish(now);
    } catch (error) {
      /*
       * Nothing in the client is supposed to throw -- it answers null for every
       * failure it knows about. Reaching here means something genuinely
       * unexpected happened, and the wall's response is the same either way:
       * take the card down rather than leave a stale one up.
       */
      console.error(
        `[NowPlaying] Poll failed: ${error.stack || error.message}`
      );

      this.publish(null);
    } finally {
      this.polling = false;
    }
  },

  noteReachability (ok) {
    if (this.reachable === ok) {
      return;
    }

    /*
     * The first poll of a process is not a transition worth announcing when it
     * succeeds -- the startup line above already said what we are watching.
     */
    if (this.reachable !== null || !ok) {
      console.log(
        ok
          ? "[NowPlaying] samo is answering again."
          : "[NowPlaying] samo is not answering; the card is hidden until it does."
      );
    }

    this.reachable = ok;
  },

  publish (nowPlaying) {
    const payload = { nowPlaying, generatedAt: Date.now() };

    /*
     * Compare everything except the timestamp, which changes every poll by
     * definition and would defeat the check entirely.
     */
    const serialised = JSON.stringify(nowPlaying);

    if (serialised === this.lastPayload) {
      return;
    }

    this.lastPayload = serialised;

    if (nowPlaying) {
      console.log(
        "[NowPlaying] " +
        [nowPlaying.artist, nowPlaying.title].filter(Boolean).join(" - ") +
        (nowPlaying.station ? ` (${nowPlaying.station})` : "") +
        (nowPlaying.artwork ? " [artwork]" : "")
      );
    }

    this.sendSocketNotification("NOW_PLAYING_UPDATE", payload);
  }
});
