/* global Module */

/*
 * Now Playing -- what is coming out of samo-radio, on the wall.
 *
 * The browser half does no thinking. Every decision about what the lines should
 * say was made in lib/now-playing.js before the payload was sent, because that
 * is where it can be tested without a browser, a mirror or a radio.
 */

/*
 * A liveness nudge, not a poll rate: the backend owns the schedule. This only
 * matters after the kiosk browser has been reloaded, when the backend is
 * already running and would otherwise wait out its interval before saying
 * anything.
 */
const CONFIGURE_RETRY_MS = 10 * 1000;

Module.register("NowPlaying", {
  defaults: {
    /*
     * Matches the rate the samo-radio daemon refreshes its own channel
     * metadata. Faster returns the same answer; much slower shows finished
     * tracks. The backend enforces a 5s floor.
     */
    pollIntervalMs: 10 * 1000,

    /* Where samo.json lives. Same directory as every other credential. */
    configDir: "/etc/magicmirror-secondbrain",

    /*
     * Show the album when one is known. Off makes the card two lines instead of
     * three, which is the right trade if the rail is tight.
     */
    showAlbum: true,

    /* Cover art on the left of the card. */
    showArtwork: true
  },

  start () {
    this.nowPlaying = null;
    this.loaded = false;
    this.configureRetryTimer = null;

    /* Nothing to show until the backend says otherwise. */
    this.hide(0);

    window.setTimeout(() => this.configureBackend(), 750);

    this.configureRetryTimer = window.setInterval(() => {
      if (!this.loaded) {
        this.configureBackend();
      }
    }, CONFIGURE_RETRY_MS);
  },

  stop () {
    if (this.configureRetryTimer) {
      window.clearInterval(this.configureRetryTimer);
      this.configureRetryTimer = null;
    }
  },

  getStyles () {
    return ["NowPlaying.css"];
  },

  configureBackend () {
    this.sendSocketNotification("NOW_PLAYING_CONFIG", {
      pollIntervalMs: this.config.pollIntervalMs,
      configDir: this.config.configDir
    });
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "NOW_PLAYING_UPDATE") {
      return;
    }

    this.loaded = true;

    if (this.configureRetryTimer) {
      window.clearInterval(this.configureRetryTimer);
      this.configureRetryTimer = null;
    }

    this.nowPlaying = payload?.nowPlaying || null;

    if (this.nowPlaying) {
      this.updateDom(0);
      this.show(0);
    } else {
      /*
       * Order matters: redraw the empty shell first, then hide. Hiding a module
       * that still holds the last track leaves it briefly visible on the next
       * show, which on a wall reads as the radio flicking back to a song that
       * finished ten minutes ago.
       */
      this.updateDom(0);
      this.hide(0);
    }
  },

  getDom () {
    const wrapper = document.createElement("section");
    wrapper.className = "nowplaying-shell";

    if (!this.loaded || !this.nowPlaying) {
      wrapper.classList.add("nowplaying-empty");
      return wrapper;
    }

    wrapper.appendChild(this.renderCard(this.nowPlaying));

    return wrapper;
  },

  renderCard (now) {
    const card = document.createElement("article");

    card.className = "nowplaying-card";

    if (now.paused) {
      card.classList.add("nowplaying-paused");
    }

    if (now.source) {
      card.classList.add(`nowplaying-source-${now.source}`);
    }

    if (this.config.showArtwork && now.artwork) {
      card.appendChild(this.renderArtwork(now));
    }

    card.appendChild(this.renderBody(now));

    return card;
  },

  renderArtwork (now) {
    const frame = document.createElement("div");
    frame.className = "nowplaying-art";

    const image = document.createElement("img");
    image.src = now.artwork;

    /*
     * Decorative: the title and artist beside it already say what this is, so
     * announcing the same thing again as alt text would only be noise. An empty
     * alt is the correct way to say that.
     */
    image.alt = "";

    frame.appendChild(image);

    return frame;
  },

  renderBody (now) {
    const body = document.createElement("div");
    body.className = "nowplaying-body";

    body.appendChild(this.renderLabel(now));

    const title = document.createElement("div");
    title.className = "nowplaying-title";
    title.textContent = now.title;
    body.appendChild(title);

    const detail = this.detailLine(now);

    if (detail) {
      const meta = document.createElement("div");
      meta.className = "nowplaying-meta";
      meta.textContent = detail;
      body.appendChild(meta);
    }

    return body;
  },

  /*
   * The small line above the title: what this is, and where it is coming from.
   *
   * The station belongs here rather than in the headline. Knowing it is Jake
   * Channel is worth one glance a day; knowing what Jake Channel is playing is
   * the reason to look at all, so the track gets the big text and the station
   * gets this.
   */
  renderLabel (now) {
    const row = document.createElement("div");
    row.className = "nowplaying-label-row";

    const label = document.createElement("span");
    label.className = "nowplaying-label";

    label.textContent = now.paused
      ? "Paused"
      : "Now playing";

    row.appendChild(label);

    const context = now.context || now.station;

    if (context) {
      const source = document.createElement("span");
      source.className = "nowplaying-context";
      source.textContent = context;
      row.appendChild(source);
    }

    return row;
  },

  /*
   * Artist, then album if there is one and there is room for it.
   *
   * The album is dropped rather than wrapped when both are present and long:
   * three tidy lines beat four ragged ones at wall-reading distance, and the
   * artist is the half people actually want.
   */
  detailLine (now) {
    const parts = [];

    if (now.artist) {
      parts.push(now.artist);
    }

    /*
     * The album earns its place only by saying something the other lines do
     * not. A podcast's show name arrives as both the artist and the parent
     * title, which without this reads "Comedy Bang Bang · Comedy Bang Bang".
     * The backend already drops those, so this is the belt to that braces.
     */
    const duplicate = [now.title, now.artist, now.station]
      .filter(Boolean)
      .some((line) => line.toLowerCase() === String(now.album).toLowerCase());

    if (this.config.showAlbum && now.album && !duplicate) {
      parts.push(now.album);
    }

    /*
     * With no artist and no album there is still the source label -- which part
     * of the channel's programming picked this. On a channel that is genuinely
     * informative ("Morning rotation"), and it beats an empty line.
     */
    if (parts.length === 0 && now.sourceLabel) {
      parts.push(now.sourceLabel);
    }

    return parts.join(" · ");
  }
});
