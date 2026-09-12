Module.register("MMM-CalendarLiveHeader", {
  defaults: {
    /*
     * How far ahead the header will announce the next event. Beyond this it
     * says nothing rather than something stale: a dentist at four is worth a
     * line at eight in the morning, not at midnight.
     */
    lookAheadHours: 12
  },

  start() {
    this.events = [];

    this.pendingRenderTimer = null;
    this.nextUpdateTimer = null;
    this.headerObserver = null;

    this.scheduleRender(750);
  },

  stop() {
    if (this.pendingRenderTimer) {
      window.clearTimeout(
        this.pendingRenderTimer
      );

      this.pendingRenderTimer = null;
    }

    if (this.nextUpdateTimer) {
      window.clearTimeout(
        this.nextUpdateTimer
      );

      this.nextUpdateTimer = null;
    }

    if (this.headerObserver) {
      this.headerObserver.disconnect();
      this.headerObserver = null;
    }
  },

  notificationReceived(notification, payload) {
    if (notification === "CALENDAR_EVENTS") {
      const events = Array.isArray(payload)
        ? payload
        : payload?.events;

      if (Array.isArray(events)) {
        this.events = events;
      }

      this.scheduleRender(25);
      return;
    }

    if (
      notification === "DOM_OBJECTS_CREATED" ||
      notification === "ALL_MODULES_STARTED"
    ) {
      this.startHeaderObserver();
      this.scheduleRender(100);
    }
  },

  getDom() {
    const wrapper =
      document.createElement("div");

    wrapper.style.display = "none";

    wrapper.setAttribute(
      "aria-hidden",
      "true"
    );

    return wrapper;
  },

  startHeaderObserver() {
    if (this.headerObserver) {
      return;
    }

    const calendarRegion =
      document.querySelector(
        ".region.bottom.bar"
      );

    if (!calendarRegion) {
      this.scheduleRender(1000);
      return;
    }

    this.headerObserver =
      new MutationObserver(() => {
        const realHeader =
          document.querySelector(
            ".region.bottom.bar " +
            ".module.MMM-CalendarExt3 " +
            ".CX3 > .headerTitle"
          );

        /*
         * CalendarExt3 periodically rebuilds its own DOM. Only act when
         * that rebuild actually removed our status element, or the week
         * numbers in the grid.
         */
        const weeksMissing =
          document.querySelector(
            ".region.bottom.bar " +
            ".module.MMM-CalendarExt3 " +
            ".CX3 > .week .cell.weekday_1"
          ) &&
          !document.querySelector(
            ".region.bottom.bar " +
            ".module.MMM-CalendarExt3 " +
            ".calendar-live-week"
          );

        if (
          (realHeader &&
            !realHeader.querySelector(
              ".calendar-live-status"
            )) ||
          weeksMissing
        ) {
          this.scheduleRender(40);
        }
      });

    this.headerObserver.observe(
      calendarRegion,
      {
        childList: true,
        subtree: true
      }
    );
  },

  scheduleRender(delayMilliseconds = 0) {
    if (this.pendingRenderTimer) {
      window.clearTimeout(
        this.pendingRenderTimer
      );
    }

    this.pendingRenderTimer =
      window.setTimeout(
        () => {
          this.pendingRenderTimer = null;
          this.renderAndScheduleNext();
        },
        Math.max(
          0,
          Number(delayMilliseconds || 0)
        )
      );
  },

  renderAndScheduleNext() {
    const status = this.ensureHeader();

    if (!status) {
      this.scheduleRender(1000);
      return;
    }

    const now = Date.now();
    const next = this.buildStatus(now);
    const key = JSON.stringify(next);

    /*
     * The DOM is changed only when the visible status changed.
     * This removes the once-per-second flashing.
     */
    if (status.dataset.key !== key) {
      status.dataset.key = key;
      this.renderStatus(status, next);
    }

    this.renderMeta(now);
    this.renderWeekNumbers();

    this.scheduleNextMeaningfulUpdate(now);
  },

  scheduleNextMeaningfulUpdate(now) {
    if (this.nextUpdateTimer) {
      window.clearTimeout(
        this.nextUpdateTimer
      );
    }

    const updateAt =
      this.nextMeaningfulUpdate(now);

    const delay = Math.max(
      1000,
      Math.min(
        updateAt - now,
        6 * 60 * 60 * 1000
      )
    );

    this.nextUpdateTimer =
      window.setTimeout(
        () => {
          this.nextUpdateTimer = null;
          this.renderAndScheduleNext();
        },
        delay
      );
  },

  ensureHeader() {
    /*
     * Hide MagicMirror's unused outer module heading if it exists.
     */
    const outerHeader =
      document.querySelector(
        ".region.bottom.bar " +
        ".module.MMM-CalendarExt3 > header"
      );

    if (outerHeader) {
      const outerText = String(
        outerHeader.textContent || ""
      )
        .trim()
        .toLowerCase();

      if (
        outerText === "" ||
        outerText === "undefined" ||
        outerText === "null"
      ) {
        outerHeader.style.display = "none";

        outerHeader.setAttribute(
          "aria-hidden",
          "true"
        );
      }
    }

    const header =
      document.querySelector(
        ".region.bottom.bar " +
        ".module.MMM-CalendarExt3 " +
        ".CX3 > .headerTitle"
      );

    if (!header) {
      return null;
    }

    header.classList.add(
      "calendar-live-header-host"
    );

    /*
     * The title CalendarExt3 draws is a bare text node ("September 2026").
     * Two spans go after it: the week and day-of-year meta, then the status
     * at the far end. Both survive CalendarExt3's own redraws only because
     * the observer above re-runs this when they vanish.
     */
    let meta = header.querySelector(
      ".calendar-live-meta"
    );

    if (!meta) {
      meta =
        document.createElement("span");

      meta.className =
        "calendar-live-meta";

      header.appendChild(meta);
    }

    let status = header.querySelector(
      ".calendar-live-status"
    );

    if (!status) {
      status =
        document.createElement("span");

      status.className =
        "calendar-live-status";

      status.setAttribute(
        "aria-live",
        "polite"
      );

      header.appendChild(status);
    }

    return status;
  },

  /*
   * ISO week and day of the year, after the month name. Real numbers the wall
   * can stand behind, in the place the old greeting used to be.
   */
  renderMeta(now) {
    const header =
      document.querySelector(
        ".region.bottom.bar " +
        ".module.MMM-CalendarExt3 " +
        ".CX3 > .headerTitle"
      );

    const meta =
      header &&
      header.querySelector(
        ".calendar-live-meta"
      );

    if (!meta) {
      return;
    }

    const text =
      `Week ${String(this.isoWeek(now)).padStart(2, "0")}` +
      " // " +
      `Day ${String(this.dayOfYear(now)).padStart(3, "0")}`;

    if (meta.textContent !== text) {
      meta.textContent = text;
    }
  },

  /*
   * The ISO week, once per row of the month grid, in the Monday cell.
   *
   * CalendarExt3 can number weeks itself, but it counts from the configured
   * first day of the week -- Sunday here -- and so disagrees with the ISO
   * number in the title for six days out of seven. This writes the real one,
   * from the cell's own date, and CalendarExt3's is left switched off.
   */
  renderWeekNumbers() {
    const mondays =
      document.querySelectorAll(
        ".region.bottom.bar " +
        ".module.MMM-CalendarExt3 " +
        ".CX3 > .week .cell.weekday_1"
      );

    for (const cell of mondays) {
      const date = Number(cell.dataset.date);

      if (!Number.isFinite(date)) {
        continue;
      }

      const header =
        cell.querySelector(".cellHeader") || cell;

      let span = cell.querySelector(
        ".calendar-live-week"
      );

      if (!span) {
        span =
          document.createElement("span");

        span.className =
          "calendar-live-week";

        header.appendChild(span);
      }

      const text =
        `W${String(this.isoWeek(date)).padStart(2, "0")}`;

      if (span.textContent !== text) {
        span.textContent = text;
      }
    }
  },

  renderStatus(status, next) {
    status.textContent = "";

    if (!next) {
      return;
    }

    const tag =
      document.createElement("span");

    tag.className = "sb-tag";
    tag.textContent = next.tag;
    status.appendChild(tag);

    const title =
      document.createElement("span");

    title.className =
      "calendar-live-title";

    title.textContent = next.title;
    status.appendChild(title);

    if (next.when) {
      const sep =
        document.createElement("span");

      sep.className = "sb-sep";
      sep.textContent = "//";
      status.appendChild(sep);

      const when =
        document.createElement("span");

      when.className =
        "calendar-live-when";

      when.textContent = next.when;
      status.appendChild(when);
    }
  },

  /*
   * What the header says at the far right of the month title:
   *
   *   NOW   DENTIST // UNTIL 4:00 PM      an event is in progress
   *   NEXT  DENTIST // IN 25 MIN          the next one starts within 90 min
   *   NEXT  DENTIST // 3:00 PM            later today, within lookAheadHours
   *   NEXT  UFC FIGHT NIGHT // SAT 16     not today, but the next timed thing
   *
   * Nothing at all when there is nothing timed ahead. There is no greeting:
   * the wall is an appliance, and the person reading it knows their name.
   */
  buildStatus(now) {
    const {
      currentEvent,
      nextEvent
    } = this.eventContext(now);

    if (currentEvent) {
      return {
        tag: "Now",
        title: currentEvent.title,
        when: `Until ${this.formatTime(currentEvent.end)}`
      };
    }

    if (!nextEvent) {
      return null;
    }

    if (
      !this.sameDay(
        now,
        nextEvent.start
      )
    ) {
      return {
        tag: "Next",
        title: nextEvent.title,
        when: this.formatDay(nextEvent.start)
      };
    }

    const lookAheadMilliseconds =
      Number(
        this.config.lookAheadHours || 12
      ) *
      60 *
      60 *
      1000;

    if (
      nextEvent.start - now >
      lookAheadMilliseconds
    ) {
      return null;
    }

    const minutes = Math.max(
      1,
      Math.ceil(
        (nextEvent.start - now) /
        60000
      )
    );

    if (minutes <= 90) {
      return {
        tag: "Next",
        title: nextEvent.title,
        when: `In ${minutes} min`
      };
    }

    return {
      tag: "Next",
      title: nextEvent.title,
      when: this.formatTime(nextEvent.start)
    };
  },

  nextMeaningfulUpdate(now) {
    const candidates = [
      this.nextDayBoundary(now)
    ];

    const {
      currentEvent,
      nextEvent
    } = this.eventContext(now);

    if (currentEvent) {
      candidates.push(
        currentEvent.end + 100
      );
    } else if (
      nextEvent &&
      this.sameDay(
        now,
        nextEvent.start
      )
    ) {
      const lookAheadMilliseconds =
        Number(
          this.config.lookAheadHours || 12
        ) *
        60 *
        60 *
        1000;

      const difference =
        nextEvent.start - now;

      if (
        difference >
        lookAheadMilliseconds
      ) {
        candidates.push(
          nextEvent.start -
          lookAheadMilliseconds +
          100
        );
      } else if (
        difference >
        90 * 60 * 1000
      ) {
        /*
         * The status changes from a clock time to a minute countdown.
         */
        candidates.push(
          nextEvent.start -
          90 * 60 * 1000 +
          100
        );
      } else {
        /*
         * During the countdown, update at the next exact minute boundary.
         */
        const nextMinute =
          Math.floor(
            now / 60000
          ) *
          60000 +
          60000 +
          75;

        candidates.push(
          Math.min(
            nextMinute,
            nextEvent.start + 100
          )
        );
      }
    }

    const valid = candidates.filter(
      (timestamp) =>
        Number.isFinite(timestamp) &&
        timestamp > now + 500
    );

    if (valid.length === 0) {
      return now + 60 * 60 * 1000;
    }

    return Math.min(...valid);
  },

  /*
   * Midnight. The week and day-of-year meta roll over then, and an event that
   * was "SAT 16" becomes today's business.
   */
  nextDayBoundary(now) {
    const tomorrow =
      new Date(now);

    tomorrow.setDate(
      tomorrow.getDate() + 1
    );

    tomorrow.setHours(0, 0, 0, 100);

    return tomorrow.getTime();
  },

  eventContext(now) {
    const events = this.events
      .map(
        (event) =>
          this.normalizeEvent(event)
      )
      .filter(Boolean)
      .filter(
        (event) =>
          !event.fullDay &&
          event.end > now
      )
      .sort(
        (first, second) =>
          first.start - second.start
      );

    const currentEvent = events
      .filter(
        (event) =>
          event.start <= now &&
          event.end > now
      )
      .sort(
        (first, second) =>
          first.end - second.end
      )[0] || null;

    const nextEvent =
      events.find(
        (event) =>
          event.start > now
      ) || null;

    return {
      currentEvent,
      nextEvent
    };
  },

  normalizeEvent(event) {
    if (!event) {
      return null;
    }

    const start = this.parseDate(
      event.startDate ??
      event.start
    );

    if (!Number.isFinite(start)) {
      return null;
    }

    let end = this.parseDate(
      event.endDate ??
      event.end
    );

    if (!Number.isFinite(end)) {
      end =
        start +
        60 *
        60 *
        1000;
    }

    return {
      title:
        String(
          event.title ||
          "Untitled event"
        ).trim(),

      start,
      end,

      fullDay: Boolean(
        event.fullDayEvent ||
        event.isFullday ||
        event.isFullDay
      )
    };
  },

  parseDate(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    const numeric =
      Number(value);

    if (Number.isFinite(numeric)) {
      return numeric < 100000000000
        ? numeric * 1000
        : numeric;
    }

    const parsed =
      Date.parse(value);

    return Number.isFinite(parsed)
      ? parsed
      : null;
  },

  isoWeek(timestamp) {
    const date = new Date(timestamp);

    /*
     * ISO 8601: weeks start on Monday and week 1 is the week with the year's
     * first Thursday. Shift to the Thursday of this week, then count from
     * the first Thursday of that Thursday's year.
     */
    const thursday = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + 3 - ((date.getDay() + 6) % 7)
    );

    const firstThursday = new Date(
      thursday.getFullYear(),
      0,
      4
    );

    firstThursday.setDate(
      firstThursday.getDate() + 3 -
      ((firstThursday.getDay() + 6) % 7)
    );

    return 1 + Math.round(
      (thursday - firstThursday) /
      (7 * 24 * 60 * 60 * 1000)
    );
  },

  dayOfYear(timestamp) {
    const date = new Date(timestamp);

    const start = new Date(
      date.getFullYear(),
      0,
      1
    );

    return 1 + Math.round(
      (new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      ) - start) /
      (24 * 60 * 60 * 1000)
    );
  },

  sameDay(first, second) {
    const a = new Date(first);
    const b = new Date(second);

    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  },

  /* 12-hour with AM/PM, to match the clock. */
  formatTime(timestamp) {
    return new Intl.DateTimeFormat(
      "en-US",
      {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }
    ).format(
      new Date(timestamp)
    );
  },

  /* "Sat 16" -- the day an event that is not today falls on. */
  formatDay(timestamp) {
    const date = new Date(timestamp);

    const weekday = new Intl.DateTimeFormat(
      "en-US",
      { weekday: "short" }
    ).format(date);

    return `${weekday} ${date.getDate()}`;
  }
});
