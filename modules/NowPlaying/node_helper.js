"use strict";

const NodeHelper = require("node_helper");

const {
  pollNowPlaying,
  loadSamoConfig,
  createDetailCache,
  COVER_CACHE_LIMIT
} = require("./lib/samo-client");
const { steadyUpNext } = require("./lib/up-next");

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
  /*
   * What the helper runs with until the browser says otherwise.
   *
   * The helper starts watching samo the moment the server starts, on these,
   * and treats the browser's NOW_PLAYING_CONFIG as an adjustment rather than
   * a starting gun. It used to wait for that message -- which the page sends
   * once, when it loads -- so a server restart with the browser left running
   * produced a helper that never polled and a wall that kept the last card it
   * had been sent. `apt upgrade` did exactly that on 2026-09-10: needrestart
   * bounced the service, the kiosk reconnected, and the wall showed the same
   * Keane song for twelve hours.
   */
  defaults: {
    configDir: "/etc/magicmirror-secondbrain",
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    /* The rows under the card -- what comes next. Off skips their requests too. */
    upNext: true
  },

  start () {
    this.config = { ...this.defaults };
    this.samo = null;
    this.timer = null;
    this.polling = false;
    this.cache = createDetailCache();

    /*
     * What the rows under the card are built from -- a channel's plan and
     * next booked block, a station's record and published schedule -- kept
     * between polls so that none of it is asked for more often than it can
     * change. Bigger than the artwork cache because a channel keeps several
     * entries and each is a few hundred bytes, not a picture.
     */
    this.programmes = createDetailCache(48);

    /*
     * The show covers in the due row, one small picture per show, kept for
     * a day. Its own cache because its entries live longer than anything in
     * the other two and must not be pushed out by them.
     */
    this.covers = createDetailCache(COVER_CACHE_LIMIT);

    /* The rows as last sent, so a clock read off a playing position holds still. */
    this.lastNext = [];

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

    /* The last status line logged, so a repeat of it is not logged again. */
    this.announced = null;

    this.configure(this.config);
  },

  stop () {
    this.stopPolling();
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "NOW_PLAYING_CONFIG") {
      return;
    }

    const requested = Number(payload?.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;

    /*
     * A page that asks gets an answer, even when the answer has not changed.
     * The browser only sends this when it has just loaded and is showing
     * nothing, so the identical-payload check that keeps the socket quiet
     * between polls would otherwise leave it showing nothing until the next
     * track change -- a reload mid-song used to cost the whole song.
     */
    this.lastPayload = null;

    this.configure({
      configDir: payload?.configDir || this.defaults.configDir,
      pollIntervalMs: Math.max(MINIMUM_POLL_INTERVAL_MS, requested),
      upNext: payload?.upNext !== false
    });
  },

  /*
   * Read the credentials and start (or restart) the poll schedule.
   *
   * Runs at startup on the defaults and again whenever the browser sends its
   * config, which is the moment to re-read samo.json: enable-nowplaying.sh
   * installs the file and reloads the kiosk to make exactly that happen.
   * Reading it here rather than on every poll also gives the one clear line
   * that says whether this module is configured at all -- the difference
   * between "off on purpose" and "broken" is otherwise invisible, and this
   * project has lost days to exactly that distinction.
   */
  configure (config) {
    this.config = { ...config };
    this.samo = loadSamoConfig(this.config.configDir, console);

    if (!this.samo) {
      this.stopPolling();

      this.announce(
        "[NowPlaying] No samo.json in " + this.config.configDir +
        " -- Now Playing is off. Copy config/secondbrain/samo.example.json " +
        "there and put a samo API token in it to turn it on."
      );

      /*
       * Off is an answer. The browser hides itself until it hears something,
       * and keeps asking every ten seconds until it does -- so an unconfigured
       * module that stayed silent was asked, and logged, all day long.
       */
      this.publish(null);
      return;
    }

    this.announce(
      `[NowPlaying] Watching samo at ${this.samo.baseUrl} ` +
      `every ${this.config.pollIntervalMs / 1000}s ` +
      (this.samo.deviceId
        ? `(device ${this.samo.deviceId}).`
        : "(device chosen automatically).")
    );

    this.schedulePolling();
    this.pollNow();
  },

  /*
   * Log a status line unless it is the one already logged. The browser
   * re-sends its config on every page load, and a wall reloaded twenty times
   * should not have "Watching samo" twenty times in its journal burying the one
   * line that says what changed.
   */
  announce (line) {
    if (line === this.announced) {
      return;
    }

    this.announced = line;
    console.log(line);
  },

  schedulePolling () {
    this.stopPolling();

    this.timer = setInterval(
      () => this.pollNow(),
      this.config.pollIntervalMs
    );
  },

  stopPolling () {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  async pollNow () {
    if (this.polling || !this.samo) {
      return;
    }

    this.polling = true;

    try {
      const status = { reachable: null };

      const now = await pollNowPlaying(
        this.config.configDir,
        {
          config: this.samo,
          cache: this.cache,
          programmes: this.programmes,
          covers: this.covers,
          upNext: this.config.upNext !== false,
          status
        },
        console
      );

      if (now) {
        now.next = steadyUpNext(this.lastNext, now.next);
        this.lastNext = now.next;
      } else {
        this.lastNext = [];
      }

      /*
       * Reachability is whether samo-server answered, not whether a song is
       * on: an idle radio is not a fault. The client reports the first
       * through `status`; the card (or its absence) is the second.
       */
      this.noteReachability(status.reachable !== false);
      this.publish(now, status.reachable === false ? "down" : "ok");
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

      this.publish(null, "down");
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

  /*
   * `samo` is the server's health as the status line under the calendar shows
   * it: "ok", "down", or "off" when there is no samo.json. It travels with the
   * card because the browser has one socket per module and the status line
   * reads it second-hand, re-broadcast by NowPlaying.js.
   */
  publish (nowPlaying, samo = "off") {
    const payload = { nowPlaying, samo, generatedAt: Date.now() };

    /*
     * Compare everything except the timestamp, which changes every poll by
     * definition and would defeat the check entirely.
     */
    const serialised = JSON.stringify({ nowPlaying, samo });

    if (serialised === this.lastPayload) {
      return;
    }

    this.lastPayload = serialised;

    if (nowPlaying) {
      const rows = Array.isArray(nowPlaying.next) ? nowPlaying.next : [];
      const due = Array.isArray(nowPlaying.due?.tiles) ? nowPlaying.due.tiles : [];

      console.log(
        "[NowPlaying] " +
        [nowPlaying.artist, nowPlaying.title].filter(Boolean).join(" - ") +
        (nowPlaying.station ? ` (${nowPlaying.station})` : "") +
        (nowPlaying.artwork ? " [artwork]" : "") +
        rows.map((row) =>
          ` | ${row.label}` +
          (row.at ? ` ${new Date(row.at).toISOString().slice(11, 16)}Z` : "") +
          (row.title ? ` ${row.title}` : "")
        ).join("") +
        (due.length
          ? ` | DUE ${nowPlaying.due.pending}: ` +
            due.map((tile) => (tile.show || tile.title) + (tile.held ? ` (held: ${tile.held.rule})` : "")).join(", ")
          : "")
      );
    }

    try {
      this.sendSocketNotification("NOW_PLAYING_UPDATE", payload);
    } catch (error) {
      /*
       * The socket is MagicMirror's, and it is handed to the helper just
       * before start() -- but nothing here should depend on that order. A
       * send that fails is forgotten so the next poll tries again, instead of
       * being remembered as delivered.
       */
      this.lastPayload = null;
      console.error(`[NowPlaying] Could not send to the browser: ${error.message}`);
    }
  }
});
