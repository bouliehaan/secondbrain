/* global Module, Log, RailLogic */

/*
 * The rail's layout -- what fits, and what gives way.
 *
 * The right-hand rail is a fixed 1056 pixels and its modules do not know
 * about each other. The schedule at the bottom got whatever the cards above
 * it left, clipped through the middle of a row; on a busy day that was the
 * only agenda on the wall and it was the thing cut short. This module reads
 * the rail after every change to it, measures what everything would take at
 * full height, and hides whole items -- forecast rows, cards, days, events,
 * the rows under the radio card -- so that the rest of today is always
 * listed and nothing ends mid-row.
 *
 * The decision is RailLogic.allocate in lib/rail.js, a pure function from
 * measured heights to counts, so it can be checked without a browser. This
 * file does the two things that need one: measure, and apply.
 *
 * Measuring happens with a class on the rail's container that switches the
 * cuts off and lets the schedule take its natural height, so every item has
 * its real size; the class comes off in the same task, before the browser
 * paints, so the wall never sees the untrimmed rail. Applying toggles one
 * class per hidden item and writes the "+ N more" lines. Both are idempotent:
 * a pass that finds nothing to change changes nothing.
 *
 * It runs from a MutationObserver on the rail, so a module that redraws is
 * re-fitted before that redraw is painted -- the same task, no flash. The
 * records our own changes leave behind are drained at the end of each pass,
 * which is what keeps the observer from feeding itself.
 */

/* If a change never arrives, a pass a minute keeps the rail honest anyway. */
const SAFETY_TICK_MS = 60 * 1000;

/* Passes in a second that would mean something is feeding the observer. */
const RUNAWAY_PASSES = 25;
const RUNAWAY_PAUSE_MS = 5 * 1000;

/* How many times to re-fit against what the browser actually laid out. */
const SETTLE_PASSES = 3;

Module.register("Rail", {
  defaults: {
    /* Where the rail's modules are. Their order is the rail's order. */
    container: ".region.top.right > .container",

    /* Pixels kept back from the budget, for the half-pixels of measuring. */
    slackPx: 2,

    /*
     * Modules whose redraws never change their height, so a change inside
     * them is not worth a pass. The clock redraws every second and the
     * seconds are always the same size; a module being shown or hidden is
     * still seen, because that is a change to the wrapper, not inside it.
     */
    ignore: [".module.clock"],

    /*
     * What each list shows before anything else is considered, where the
     * rest of the space goes, and what gives way when the minimums alone do
     * not fit. See lib/rail.js for the defaults; any of the three can be
     * replaced wholesale here.
     */
    minimums: null,
    ladder: null,
    sacrifice: null
  },

  start () {
    this.container = null;
    this.observer = null;
    this.safetyTimer = null;
    this.attachTimer = null;
    this.passTimes = [];
    this.pausedUntil = 0;
    this.pauseTimer = null;
    this.warnedOverflow = false;
    this.last = null;
  },

  stop () {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    for (const key of ["safetyTimer", "attachTimer", "pauseTimer"]) {
      if (this[key]) {
        window.clearTimeout(this[key]);
        window.clearInterval(this[key]);
        this[key] = null;
      }
    }
  },

  getStyles () {
    return ["Rail.css"];
  },

  getScripts () {
    return [this.file("lib/rail.js")];
  },

  /* This module draws nothing of its own. */
  getDom () {
    const wrapper = document.createElement("div");
    wrapper.style.display = "none";
    wrapper.setAttribute("aria-hidden", "true");
    return wrapper;
  },

  notificationReceived (notification) {
    if (
      notification === "DOM_OBJECTS_CREATED" ||
      notification === "ALL_MODULES_STARTED"
    ) {
      this.attach();
    }
  },

  attach () {
    if (this.observer) {
      this.pass();
      return;
    }

    const container = document.querySelector(this.config.container);

    if (!container) {
      /* The regions exist before the modules do, but be patient anyway. */
      if (!this.attachTimer) {
        this.attachTimer = window.setTimeout(() => {
          this.attachTimer = null;
          this.attach();
        }, 500);
      }
      return;
    }

    this.container = container;

    /*
     * childList for redraws, attributes for MagicMirror's show and hide,
     * which are a class and an inline style on the module wrapper.
     */
    this.observer = new MutationObserver((records) => {
      if (records.some((record) => !this.ignored(record.target))) {
        this.pass();
      }
    });
    this.observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"]
    });

    /*
     * Text is measured in whatever font is loaded at the time. Rajdhani is
     * local() on the wall and instant, but a page served elsewhere gets it a
     * moment later, and every height changes when it lands.
     */
    if (document.fonts) {
      document.fonts.ready.then(() => this.pass());
      document.fonts.addEventListener("loadingdone", () => this.pass());
    }

    window.addEventListener("resize", () => this.pass());

    this.safetyTimer = window.setInterval(() => this.pass(), SAFETY_TICK_MS);

    this.pass();
  },

  /* A change inside a module whose height it cannot have changed. */
  ignored (node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;

    if (!element) {
      return false;
    }

    for (const selector of Array.isArray(this.config.ignore) ? this.config.ignore : []) {
      const module = element.closest(selector);

      if (module && module !== element) {
        return true;
      }
    }

    return false;
  },

  /* ------------------------------------------------------------------ *
   * A pass: measure, decide, apply, check.
   * ------------------------------------------------------------------ */

  pass () {
    if (!this.container || !this.container.isConnected) {
      return;
    }

    const now = Date.now();

    if (now < this.pausedUntil) {
      return;
    }

    this.passTimes = this.passTimes.filter((t) => now - t < 1000);
    this.passTimes.push(now);

    if (this.passTimes.length > RUNAWAY_PASSES) {
      Log.warn(`[Rail] ${this.passTimes.length} passes in a second; pausing for ${RUNAWAY_PAUSE_MS / 1000}s.`);
      this.pausedUntil = now + RUNAWAY_PAUSE_MS;
      this.passTimes = [];

      if (!this.pauseTimer) {
        this.pauseTimer = window.setTimeout(() => {
          this.pauseTimer = null;
          this.pass();
        }, RUNAWAY_PAUSE_MS + 50);
      }
      return;
    }

    try {
      this.fit();
    } catch (error) {
      Log.error("[Rail] pass failed:", error);
    } finally {
      /*
       * Whatever this pass changed has queued records for our own observer.
       * Taking them now is what stops the next pass being caused by this one.
       */
      if (this.observer) {
        this.observer.takeRecords();
      }
    }
  },

  fit () {
    const model = this.measure();
    let alloc = RailLogic.allocate(model, this.options());
    this.apply(model, alloc);

    /*
     * Trust, then verify. The model is exact for prefixes of what was
     * measured, but a line box can still round the other way. Read what the
     * browser actually laid out; if the schedule's box is over by anything,
     * fit again with that much less, so the giving-way order still applies
     * rather than the last row simply vanishing.
     */
    let budget = model.height;

    for (let i = 0; i < SETTLE_PASSES; i++) {
      const over = this.overflow(model);

      if (over <= 0) {
        break;
      }

      budget -= over + 1;
      alloc = RailLogic.allocate({ ...model, height: budget }, this.options());
      this.apply(model, alloc);
    }

    this.report(model, alloc);
  },

  options () {
    return {
      minimums: this.config.minimums || undefined,
      ladder: this.config.ladder || undefined,
      sacrifice: this.config.sacrifice || undefined
    };
  },

  /* ------------------------------------------------------------------ *
   * Measure.
   *
   * Item heights are marginal: an item's bottom less the bottom of the item
   * before it, so a flex gap or a margin above an item belongs to that item.
   * A block's base is what remains of it once every item is subtracted.
   * Hiding a suffix of the items then costs exactly their sum.
   * ------------------------------------------------------------------ */

  measure () {
    const container = this.container;
    container.classList.add("rail-measuring");

    try {
      const style = window.getComputedStyle(container);
      const gap = parseFloat(style.rowGap) || parseFloat(style.gap) || 0;
      const height = container.clientHeight - (Number(this.config.slackPx) || 0);
      const blocks = [];

      for (const module of container.children) {
        if (!module.classList.contains("module")) {
          continue;
        }

        if (window.getComputedStyle(module).display === "none") {
          continue;
        }

        blocks.push(this.measureBlock(module));
      }

      return { height, gap, blocks };
    } finally {
      container.classList.remove("rail-measuring");
    }
  },

  measureBlock (module) {
    const classes = module.classList;

    if (classes.contains("side-forecast")) {
      return this.measureForecast(module);
    }

    if (classes.contains("side-nowplaying") || classes.contains("NowPlaying")) {
      return this.measureNowPlaying(module);
    }

    if (classes.contains("MMM-SecondBrain")) {
      return this.measureSecondBrain(module);
    }

    if (classes.contains("side-agenda") || classes.contains("MMM-CalendarExt3Agenda")) {
      return this.measureSchedule(module);
    }

    return this.fixed(module);
  },

  /*
   * A module that has not drawn its list yet -- LOADING, or an agenda that is
   * still waiting for events -- is whatever height it is, and stays.
   */
  fixed (module) {
    return {
      id: module.id || module.className,
      height: this.rect(module).height,
      ref: { module }
    };
  },

  measureForecast (module) {
    const rows = Array.from(module.querySelectorAll(".fc-row"));

    if (rows.length === 0) {
      return this.fixed(module);
    }

    const items = this.marginals(rows);

    return {
      id: "forecast",
      list: "forecast",
      base: this.rect(module).height - items.reduce((a, b) => a + b, 0),
      items,
      ref: { module, rows }
    };
  },

  /*
   * The radio card and what hangs under it: the rows saying what comes next,
   * and the row of covers for what the channel owes. The card is the base
   * and stands whatever happens below; each section is measured from the
   * bottom of what precedes it, so the first carries its hairline and the
   * space above it, and goes with its last item.
   */
  measureNowPlaying (module) {
    const card = module.querySelector(".nowplaying-card");
    const parts = [
      { list: "upnext", node: module.querySelector(".nowplaying-next"), rows: ".nowplaying-next-row" },
      { list: "due", node: module.querySelector(".nowplaying-due"), rows: ".nowplaying-due-row" }
    ].filter((part) => part.node);

    if (!card || parts.length === 0) {
      return this.fixed(module);
    }

    const sectionMarginals = this.marginals([card, ...parts.map((p) => p.node)]).slice(1);
    const sections = [];
    let listed = 0;

    parts.forEach((part, i) => {
      const rows = Array.from(part.node.querySelectorAll(part.rows));
      const items = this.marginals(rows);

      listed += sectionMarginals[i];
      sections.push({
        list: part.list,
        base: sectionMarginals[i] - items.reduce((a, b) => a + b, 0),
        items,
        ref: { section: part.node, cards: rows, count: null }
      });
    });

    return {
      id: "nowplaying",
      standalone: true,
      base: this.rect(module).height - listed,
      sections,
      ref: { module }
    };
  },

  measureSecondBrain (module) {
    const names = {
      "secondbrain-section-notifications": "messages",
      "secondbrain-section-packages": "inbound",
      "secondbrain-section-downloads": "transfers"
    };

    const sectionNodes = Array.from(module.querySelectorAll(".secondbrain-section"));
    const sectionMarginals = this.marginals(sectionNodes);
    const sections = [];
    let listed = 0;

    sectionNodes.forEach((node, i) => {
      const list = Object.keys(names).find((c) => node.classList.contains(c));

      /* A section this does not know stays where it is, as part of the base. */
      if (!list) {
        return;
      }

      const cards = Array.from(node.querySelectorAll(".secondbrain-card"));
      const items = this.marginals(cards);

      listed += sectionMarginals[i];
      sections.push({
        list: names[list],
        base: sectionMarginals[i] - items.reduce((a, b) => a + b, 0),
        items,
        ref: {
          section: node,
          cards,
          count: node.querySelector(".secondbrain-heading-count")
        }
      });
    });

    if (sections.length === 0) {
      return this.fixed(module);
    }

    return {
      id: "secondbrain",
      base: this.rect(module).height - listed,
      sections,
      ref: { module }
    };
  },

  measureSchedule (module) {
    const cells = Array.from(module.querySelectorAll(".CX3A .agenda > .cell"));

    if (cells.length === 0) {
      return this.fixed(module);
    }

    const cellMarginals = this.marginals(cells);

    const days = cells.map((cell, i) => {
      const events = Array.from(cell.querySelectorAll(".cellBody .event"));
      const items = this.marginals(events);

      return {
        base: cellMarginals[i] - items.reduce((a, b) => a + b, 0),
        items,
        today: cell.classList.contains("today"),
        ref: { cell, events, body: cell.querySelector(".cellBody") }
      };
    });

    /*
     * The "+ N more" line is ours, so nothing has measured it yet: put one in
     * the first day, read it, take it out again.
     */
    let more = 0;
    const host = days[0] && days[0].ref.body;

    if (host) {
      const probe = this.moreLine(99);
      probe.classList.add("rail-probe");
      host.appendChild(probe);
      const probeStyle = window.getComputedStyle(probe);
      more = this.rect(probe).height
        + (parseFloat(probeStyle.marginTop) || 0)
        + (parseFloat(probeStyle.marginBottom) || 0);
      probe.remove();
    }

    return {
      id: "schedule",
      base: this.rect(module).height - cellMarginals.reduce((a, b) => a + b, 0),
      more,
      days,
      ref: { module, cells }
    };
  },

  marginals (nodes) {
    const out = [];
    let previous = null;

    for (const node of nodes) {
      const r = this.rect(node);
      out.push(previous === null ? r.height : r.bottom - previous);
      previous = r.bottom;
    }

    return out;
  },

  rect (node) {
    return node.getBoundingClientRect();
  },

  /* ------------------------------------------------------------------ *
   * Apply.
   * ------------------------------------------------------------------ */

  apply (model, alloc) {
    for (const block of model.blocks) {
      if (block.list && block.ref && Array.isArray(block.ref.rows)) {
        const n = alloc.lists[block.list] || 0;
        block.ref.rows.forEach((row, i) => this.cut(row, i >= n));
        this.cut(block.ref.module, n === 0);
        continue;
      }

      if (Array.isArray(block.sections)) {
        let shown = 0;

        for (const section of block.sections) {
          const n = alloc.lists[section.list] || 0;
          const total = section.ref.cards.length;

          section.ref.cards.forEach((card, i) => this.cut(card, i >= n));
          this.cut(section.ref.section, n === 0);
          shown += n > 0 ? 1 : 0;

          /* The heading count reads 01 / 03 while cards are held back. */
          const count = section.ref.count;

          if (count) {
            const shownLabel = n > 0 && n < total ? String(n).padStart(2, "0") : null;

            if (shownLabel === null) {
              if (count.dataset.railShown !== undefined) {
                delete count.dataset.railShown;
              }
            } else if (count.dataset.railShown !== shownLabel) {
              count.dataset.railShown = shownLabel;
            }
          }
        }

        /* A block that is only its sections goes with them; a standalone one stays. */
        this.cut(block.ref.module, shown === 0 && !block.standalone);
        continue;
      }

      if (Array.isArray(block.days)) {
        const { days, tail } = alloc.schedule;

        block.days.forEach((day, i) => {
          const shown = i < days;
          const partial = shown && tail && i === days - 1;
          const keep = partial ? tail.events : day.items.length;

          this.cut(day.ref.cell, !shown);
          day.ref.events.forEach((event, j) => this.cut(event, shown && j >= keep));
          this.more(day.ref.body, partial ? tail.more : 0);
        });
      }
    }
  },

  cut (node, cut) {
    if (node && node.classList.contains("rail-cut") !== cut) {
      node.classList.toggle("rail-cut", cut);
    }
  },

  /* The "+ N more" line at the end of a day, or none. */
  more (body, n) {
    if (!body) {
      return;
    }

    const existing = body.querySelector(":scope > .rail-more");

    if (n <= 0) {
      if (existing) {
        existing.remove();
      }
      return;
    }

    const text = this.moreText(n);

    if (existing) {
      if (existing.textContent !== text) {
        existing.textContent = text;
      }

      if (existing !== body.lastElementChild) {
        body.appendChild(existing);
      }
      return;
    }

    body.appendChild(this.moreLine(n));
  },

  moreLine (n) {
    const line = document.createElement("div");
    line.className = "rail-more";
    line.textContent = this.moreText(n);
    return line;
  },

  moreText (n) {
    return `+ ${n} more`;
  },

  /* ------------------------------------------------------------------ *
   * Check.
   * ------------------------------------------------------------------ */

  /*
   * By how much the schedule's content overruns the box the browser gave it,
   * after everything above it took its share. Zero when it fits.
   */
  overflow (model) {
    const block = model.blocks.find((b) => Array.isArray(b.days));

    if (!block) {
      return 0;
    }

    const agenda = block.ref.module.querySelector(".CX3A .agenda");

    if (!agenda) {
      return 0;
    }

    const visible = block.ref.cells.filter((c) => !c.classList.contains("rail-cut"));

    if (visible.length === 0) {
      return 0;
    }

    const box = this.rect(agenda);
    const last = this.rect(visible[visible.length - 1]);
    const style = window.getComputedStyle(agenda);
    const inner = box.bottom - (parseFloat(style.paddingBottom) || 0) - (parseFloat(style.borderBottomWidth) || 0);

    return Math.max(0, Math.ceil(last.bottom - inner));
  },

  report (model, alloc) {
    const summary = JSON.stringify({
      lists: alloc.lists,
      schedule: alloc.schedule,
      sacrificed: alloc.sacrificed,
      fits: alloc.fits
    });

    if (summary === this.last) {
      return;
    }

    this.last = summary;

    if (!alloc.fits) {
      if (!this.warnedOverflow) {
        this.warnedOverflow = true;
        Log.warn(`[Rail] does not fit even at the floor: ${Math.round(alloc.cost)}px into ${Math.round(model.height)}px.`);
      }
    } else {
      this.warnedOverflow = false;
    }

    Log.info(`[Rail] ${summary}`);
  }
});
