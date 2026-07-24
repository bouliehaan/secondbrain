Module.register("MMM-CalendarLiveHeader", {
  defaults: {
    name: "Jake",
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
         * that rebuild actually removed our status element.
         */
        if (
          realHeader &&
          !realHeader.querySelector(
            ".calendar-live-status"
          )
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
    const nextText = this.buildStatus(now);

    /*
     * The DOM is changed only when the visible sentence changed.
     * This removes the once-per-second flashing.
     */
    if (status.textContent !== nextText) {
      status.textContent = nextText;
    }

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

  buildStatus(now) {
    const greeting =
      `${this.greeting(now)}, ${this.config.name}`;

    const {
      currentEvent,
      nextEvent
    } = this.eventContext(now);

    if (currentEvent) {
      return (
        `${greeting} · ` +
        `Now: ${currentEvent.title} ` +
        `until ${this.formatTime(currentEvent.end)}`
      );
    }

    if (!nextEvent) {
      return greeting;
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
      return greeting;
    }

    if (
      !this.sameDay(
        now,
        nextEvent.start
      )
    ) {
      return greeting;
    }

    const minutes = Math.max(
      1,
      Math.ceil(
        (nextEvent.start - now) /
        60000
      )
    );

    if (minutes <= 90) {
      return (
        `${greeting} · ` +
        `In ${minutes} min: ${nextEvent.title}`
      );
    }

    return (
      `${greeting} · ` +
      `Free until ` +
      `${this.formatTime(nextEvent.start)}: ` +
      nextEvent.title
    );
  },

  nextMeaningfulUpdate(now) {
    const candidates = [
      this.nextGreetingBoundary(now)
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
         * The sentence changes from "Free until" to a minute countdown.
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

  nextGreetingBoundary(now) {
    const current =
      new Date(now);

    const noon =
      new Date(now);

    noon.setHours(12, 0, 0, 100);

    if (noon.getTime() > now) {
      return noon.getTime();
    }

    const evening =
      new Date(now);

    evening.setHours(17, 0, 0, 100);

    if (evening.getTime() > now) {
      return evening.getTime();
    }

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

  greeting(timestamp) {
    const hour =
      new Date(timestamp).getHours();

    if (hour < 12) {
      return "Good morning";
    }

    if (hour < 17) {
      return "Good afternoon";
    }

    return "Good evening";
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

  formatTime(timestamp) {
    return new Intl.DateTimeFormat(
      undefined,
      {
        hour: "numeric",
        minute: "2-digit"
      }
    ).format(
      new Date(timestamp)
    );
  }
});
