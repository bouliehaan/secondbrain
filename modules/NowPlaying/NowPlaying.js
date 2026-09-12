/* global Module, config */

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
    showArtwork: true,

    /*
     * The rows under the card: when what is playing gives way, and to what.
     * A channel's next booked block, the end of the block it is in, the next
     * item of a cast queue, the station the radio goes back to when the
     * queue runs out, a station's next programme where one is published --
     * and, for a channel, a row of small covers for the episodes it owes,
     * in the order it means to play them. The rail treats all of it as the
     * cheapest thing to drop, so it never costs a card or an event; off here
     * skips the requests that build it.
     */
    showUpNext: true
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
      configDir: this.config.configDir,
      upNext: this.config.showUpNext !== false
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

    /*
     * The status line under the calendar shows whether samo is answering. It
     * cannot see this module's socket, so the helper's verdict is re-broadcast
     * as a module notification. "off" means no samo.json; that is not a fault
     * and the status line leaves it out.
     */
    if (payload?.samo) {
      this.sendNotification("NOWPLAYING_STATUS", { samo: payload.samo });
    }

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

    const next = this.renderNext(this.nowPlaying);

    if (next) {
      wrapper.appendChild(next);
    }

    const due = this.renderDue(this.nowPlaying);

    if (due) {
      wrapper.appendChild(due);
    }

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

  /*
   * The rows under the card, each `LABEL  time  what`: NEXT 4:00 PM All
   * Things Considered; UNTIL 9:00 AM; ENDS 2:40 PM. Time before title, as
   * the schedule below writes its own rows. Rows are whole things to the
   * rail, which hides them from the last up when the day is full.
   */
  renderNext (now) {
    const rows = this.config.showUpNext !== false && Array.isArray(now.next)
      ? now.next.filter((row) => row && (row.title || row.at))
      : [];

    if (rows.length === 0) {
      return null;
    }

    const list = document.createElement("div");
    list.className = "nowplaying-next";

    for (const entry of rows) {
      const row = document.createElement("div");
      row.className = `nowplaying-next-row nowplaying-next-${String(entry.label).toLowerCase()}`;

      const label = document.createElement("span");
      label.className = "nowplaying-next-label";
      label.textContent = entry.label;
      row.appendChild(label);

      if (entry.at) {
        const time = document.createElement("span");
        time.className = "nowplaying-next-time";
        time.textContent = this.formatMoment(entry.at);
        row.appendChild(time);
      }

      if (entry.title) {
        const title = document.createElement("span");
        title.className = "nowplaying-next-title";
        title.textContent = entry.title;

        if (entry.detail) {
          const detail = document.createElement("span");
          detail.className = "nowplaying-next-detail";
          detail.textContent = ` // ${entry.detail}`;
          title.appendChild(detail);
        }

        row.appendChild(title);
      }

      list.appendChild(row);
    }

    return list;
  },

  /*
   * The episodes the channel owes, as a row of small covers in the order the
   * station means to play them: `DUE  [▪][▪][▪][▪]  +3`. Covers are in colour,
   * like the one in the card; a show with no picture is its initials on a
   * panel. One whole row to the rail -- it is there or it is not.
   */
  renderDue (now) {
    const tiles = this.config.showUpNext !== false && Array.isArray(now.due?.tiles)
      ? now.due.tiles.filter((tile) => tile && (tile.show || tile.title))
      : [];

    if (tiles.length === 0) {
      return null;
    }

    const section = document.createElement("div");
    section.className = "nowplaying-due";

    const row = document.createElement("div");
    row.className = "nowplaying-due-row";

    const label = document.createElement("span");
    label.className = "nowplaying-next-label";
    label.textContent = "DUE";
    row.appendChild(label);

    const strip = document.createElement("div");
    strip.className = "nowplaying-due-tiles";

    for (const tile of tiles) {
      const cell = document.createElement("div");
      cell.className = "nowplaying-due-tile";

      if (tile.tier) {
        cell.classList.add(`nowplaying-due-tier-${String(tile.tier).toLowerCase()}`);
      }

      /*
       * Owed, but a rule of the station's is holding it back for now -- it
       * aired at lunch and is owed a second hearing, say. Drawn faint, after
       * the free ones; the rule's own words are in the tooltip.
       */
      if (tile.held) {
        cell.classList.add("nowplaying-due-held");
      }

      /* Not decorative: the picture is the only thing that names the show. */
      cell.title = [tile.show, tile.title].filter(Boolean).join(" — ") +
        (tile.held && tile.held.reason ? ` (held: ${tile.held.reason})` : "");

      if (tile.artwork) {
        const image = document.createElement("img");
        image.src = tile.artwork;
        image.alt = tile.show || tile.title;
        cell.appendChild(image);
      } else {
        const initials = document.createElement("span");
        initials.className = "nowplaying-due-initials";
        initials.textContent = tile.initials || "";
        cell.appendChild(initials);
      }

      strip.appendChild(cell);
    }

    row.appendChild(strip);

    const rest = Math.max(0, Number(now.due.pending) - tiles.length);

    if (rest > 0) {
      const more = document.createElement("span");
      more.className = "nowplaying-due-more";
      more.textContent = `+ ${rest}`;
      row.appendChild(more);
    }

    section.appendChild(row);

    return section;
  },

  /*
   * A moment as the wall writes one: the clock's own format, and the weekday
   * in front of it only when it is not today's -- "Mon 12:00 AM" at eleven
   * on a Sunday night, "4:00 PM" the rest of the time.
   */
  formatMoment (at) {
    const moment = new Date(at);

    if (!Number.isFinite(moment.getTime())) {
      return "";
    }

    const locale = (typeof config !== "undefined" && config.locale) || "en-US";
    const hour12 = !(typeof config !== "undefined" && Number(config.timeFormat) === 24);

    const time = moment.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12
    });

    const today = new Date();
    const sameDay =
      moment.getFullYear() === today.getFullYear() &&
      moment.getMonth() === today.getMonth() &&
      moment.getDate() === today.getDate();

    return sameDay
      ? time
      : `${moment.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
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
     * title, which without this reads "Comedy Bang Bang // Comedy Bang Bang".
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

    return parts.join(" // ");
  }
});
