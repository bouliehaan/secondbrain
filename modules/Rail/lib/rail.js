/*
 * The rail's layout: the pure part.
 *
 * The rail is 1056 pixels of things that all want to be there, and the
 * schedule at the bottom used to get whatever the cards left, clipped through
 * the middle of a row. This decides, from measured heights alone, how many
 * whole items each block shows, so that:
 *
 *   - the schedule always lists the rest of today, whole;
 *   - every card stack (messages, inbound, transfers) shows at least one card;
 *   - what is left over goes to a ladder of priorities, one whole item at a
 *     time, and a rung that does not fit is skipped rather than half drawn;
 *   - when even the guaranteed set does not fit -- a twenty-event day with a
 *     freeze warning and the radio on -- things give way in a stated order,
 *     and the schedule's own tail goes only after the packages and the
 *     forecast, with an explicit "+ N more" line rather than a cut.
 *
 * Everything here takes plain numbers and returns counts, so
 * scripts/check-rail.js can exercise it with no browser and no mirror. The
 * measuring and the DOM are in Rail.js.
 *
 * The model is what Rail.js measured, top to bottom:
 *
 *   {
 *     height: 1056,            px available to all blocks together
 *     gap: 10,                 px between neighbouring blocks
 *     blocks: [
 *       { id: "clock", height: 86 },                       fixed: shown as is
 *       { id: "forecast", list: "forecast",
 *         base: 30, items: [28, 28, 28, 28, 27] },         a list: base + the
 *                                                          first n items
 *       { id: "nowplaying", base: 78, standalone: true,   the radio card, with
 *         sections: [                                      the rows under it
 *           { list: "upnext", base: 10, items: [22, 22] },
 *           { list: "due", base: 13, items: [30] } ] },
 *       { id: "secondbrain", base: 0, sections: [          card stacks
 *         { list: "messages", base: 30, items: [72, 96] },
 *         { list: "inbound",  base: 40, items: [64] } ] },
 *       { id: "schedule", base: 42, more: 24, days: [      the agenda
 *         { base: 37, items: [26, 26, 31], today: true },
 *         { base: 37, items: [26] },
 *         { base: 61, items: [] } ] }                      a CLEAR day
 *     ]
 *   }
 *
 * Every item height is marginal -- what the block gets shorter by when that
 * item is the last one dropped -- so a flex gap or a margin before an item is
 * the item's to carry. A block with nothing shown costs nothing, not even the
 * rail's gap after it -- unless it is `standalone`, a block whose base is a
 * thing in its own right (the radio card) and whose items or sections are
 * extras under it (the rows saying what comes next, the covers of what is
 * due); that one costs its base with nothing under it at all, and is never
 * absent for want of them.
 *
 * One object, like lib/freeze-watch.js: a global in the browser, a CommonJS
 * export in node.
 */

const RailLogic = {

  /*
   * What is shown before anything else is considered. "schedule" is in days
   * and means today, whole; the rest are cards or rows.
   */
  DEFAULT_MINIMUMS: {
    schedule: 1,
    messages: 1,
    inbound: 1,
    transfers: 1,
    forecast: 1,
    /*
     * The rows under the radio card are the one thing here with no floor:
     * they are about the next hour and cost a line each, so they are the
     * first thing the ladder adds and never something the day's events or
     * a card make room for. The covers of what the channel owes, likewise.
     */
    upnext: 0,
    due: 0
  },

  /*
   * Where the rest of the space goes, in order. Each rung raises one list to
   * a count; a rung that does not wholly fit takes what does and closes that
   * list, and the walk carries on, so a smaller thing further down can still
   * use what a bigger one could not. "all" means every item there is.
   *
   * A day's schedule and its weather go up together: tomorrow, then
   * tomorrow's row of the forecast, then the second message. What the radio
   * does next comes first of all -- one line, about the next hour, on the
   * wall nowhere else -- then the covers of the episodes the channel owes,
   * and the line after those once the second card of each kind is up.
   */
  DEFAULT_LADDER: [
    ["upnext", 1],
    ["due", 1],
    ["schedule", 2],
    ["forecast", 2],
    ["messages", 2],
    ["inbound", 2],
    ["upnext", "all"],
    ["schedule", 3],
    ["forecast", 3],
    ["messages", 3],
    ["inbound", 3],
    ["forecast", 5],
    ["transfers", "all"],
    ["schedule", "all"]
  ],

  /*
   * What gives way, first to last, when the minimums alone do not fit. A list
   * is emptied before the next one is touched. The schedule gives up today's
   * events from the end, one at a time, behind a "+ N more" line; it never
   * loses its day. Messages are last because a text is the one thing here
   * that is on the wall nowhere else and gone in an hour.
   */
  DEFAULT_SACRIFICE: ["transfers", "inbound", "forecast", "schedule", "messages"],

  /*
   * Decide what each block shows.
   *
   * Returns
   *   {
   *     lists: { forecast: 3, messages: 1, inbound: 1, transfers: 0 },
   *     schedule: { days: 2, tail: null | { events: 4, more: 3 } },
   *     cost, height, fits, overflow,
   *     sacrificed: ["transfers"]        lists left below their minimum
   *   }
   *
   * `tail` describes the last shown day when it is partial: `events` of its
   * rows are drawn, then one "+ more more" line. A day with `events: 0` is a
   * header and that line, which is the floor for today.
   */
  allocate(model, options = {}) {
    const minimums = { ...this.DEFAULT_MINIMUMS, ...(options.minimums || {}) };
    const ladder = Array.isArray(options.ladder) ? options.ladder : this.DEFAULT_LADDER;
    const sacrifice = Array.isArray(options.sacrifice) ? options.sacrifice : this.DEFAULT_SACRIFICE;

    const height = Number(model?.height) || 0;
    const blocks = Array.isArray(model?.blocks) ? model.blocks : [];
    const lists = this.collectLists(blocks);
    const schedule = blocks.find((b) => Array.isArray(b.days)) || null;
    const days = schedule ? schedule.days : [];

    const alloc = { lists: {}, schedule: { days: 0, tail: null } };
    const closed = new Set();
    const sacrificed = new Set();

    const cost = () => this.railCost(model, alloc);
    const fits = () => cost() <= height;

    /* ------------------------------------------------------------------ *
     * The minimums.
     * ------------------------------------------------------------------ */

    for (const id of Object.keys(lists)) {
      alloc.lists[id] = Math.min(this.count(minimums[id], 1), lists[id].items.length);
    }

    if (schedule) {
      /*
       * Today is normally the first day, but the agenda can be configured to
       * skip empty days, and then it may not be there at all. Everything up
       * to and including today is the minimum; failing a today, the first
       * day listed.
       */
      const todayIndex = days.findIndex((d) => d && d.today);
      const throughToday = todayIndex >= 0 ? todayIndex + 1 : Math.min(1, days.length);
      alloc.schedule.days = Math.min(days.length, Math.max(throughToday, this.count(minimums.schedule, 1)));
    }

    /* ------------------------------------------------------------------ *
     * If they do not fit, give way in order.
     * ------------------------------------------------------------------ */

    if (!fits()) {
      for (const id of sacrifice) {
        let reduced = false;
        while (!fits() && this.reduce(id, alloc, lists, days)) {
          reduced = true;
        }
        if (reduced) {
          closed.add(id);
          sacrificed.add(id);
        }
        if (fits()) {
          break;
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * The ladder.
     * ------------------------------------------------------------------ */

    if (fits()) {
      for (const rung of ladder) {
        if (!Array.isArray(rung) || rung.length < 2) {
          continue;
        }

        const [id, target] = rung;

        if (closed.has(id)) {
          continue;
        }

        if (id === "schedule") {
          if (schedule && !this.raiseSchedule(target, alloc, schedule, fits)) {
            closed.add(id);
          }
          continue;
        }

        if (lists[id] && !this.raiseList(id, target, alloc, lists, fits)) {
          closed.add(id);
        }
      }
    }

    const total = cost();

    return {
      lists: alloc.lists,
      schedule: alloc.schedule,
      cost: total,
      height,
      fits: total <= height,
      overflow: Math.max(0, total - height),
      sacrificed: [...sacrificed]
    };
  },

  /* A count from config: a number, or "all" (and anything else) for no limit. */
  count(value, fallback) {
    if (value === "all") {
      return Infinity;
    }

    const n = Number(value);

    if (Number.isFinite(n) && n >= 0) {
      return Math.floor(n);
    }

    return value === undefined || value === null ? fallback : Infinity;
  },

  collectLists(blocks) {
    const lists = {};

    for (const block of blocks) {
      if (block.list && Array.isArray(block.items) && !lists[block.list]) {
        lists[block.list] = { items: block.items };
      }

      for (const section of Array.isArray(block.sections) ? block.sections : []) {
        if (section.list && Array.isArray(section.items) && !lists[section.list]) {
          lists[section.list] = { items: section.items };
        }
      }
    }

    return lists;
  },

  sum(items, n) {
    let total = 0;

    for (let i = 0; i < Math.min(n, items.length); i++) {
      total += Number(items[i]) || 0;
    }

    return total;
  },

  /* What one block costs under an allocation. Zero means absent. */
  blockCost(block, alloc) {
    if (!block) {
      return 0;
    }

    if (block.list && Array.isArray(block.items)) {
      const n = alloc.lists[block.list] || 0;

      if (n > 0 || block.standalone) {
        return (Number(block.base) || 0) + this.sum(block.items, n);
      }

      return 0;
    }

    if (Array.isArray(block.sections)) {
      let shown = 0;
      let total = Number(block.base) || 0;

      for (const section of block.sections) {
        const n = alloc.lists[section.list] || 0;

        if (n > 0) {
          shown += 1;
          total += (Number(section.base) || 0) + this.sum(section.items, n);
        }
      }

      return shown > 0 || block.standalone ? total : 0;
    }

    if (Array.isArray(block.days)) {
      const { days, tail } = alloc.schedule;

      if (days <= 0) {
        return 0;
      }

      let total = Number(block.base) || 0;

      for (let i = 0; i < Math.min(days, block.days.length); i++) {
        const day = block.days[i];
        const items = Array.isArray(day.items) ? day.items : [];

        total += Number(day.base) || 0;

        if (tail && i === days - 1) {
          total += this.sum(items, tail.events) + (Number(block.more) || 0);
        } else {
          total += this.sum(items, items.length);
        }
      }

      return total;
    }

    return Number(block.height) || 0;
  },

  /* The whole rail: every present block, and a gap between neighbours. */
  railCost(model, alloc) {
    const blocks = Array.isArray(model?.blocks) ? model.blocks : [];
    const gap = Number(model?.gap) || 0;
    let present = 0;
    let total = 0;

    for (const block of blocks) {
      const c = this.blockCost(block, alloc);

      if (c > 0) {
        present += 1;
        total += c;
      }
    }

    return present > 0 ? total + (present - 1) * gap : 0;
  },

  /*
   * Take one item away from a list. True if something was taken.
   *
   * For the schedule this trims the last shown day from its end: a whole day
   * becomes its rows less one and a "+ 1 more" line, then fewer rows and a
   * bigger number, down to the header and the line alone. Only then, and only
   * if it is not the last day standing, does the day go.
   */
  reduce(id, alloc, lists, days) {
    if (id === "schedule") {
      const s = alloc.schedule;

      if (s.days <= 0) {
        return false;
      }

      const day = days[s.days - 1];
      const n = day && Array.isArray(day.items) ? day.items.length : 0;

      if (!s.tail) {
        if (n > 0) {
          s.tail = { events: n - 1, more: 1 };
          return true;
        }

        if (s.days > 1) {
          s.days -= 1;
          return true;
        }

        return false;
      }

      if (s.tail.events > 0) {
        s.tail.events -= 1;
        s.tail.more += 1;
        return true;
      }

      if (s.days > 1) {
        s.days -= 1;
        s.tail = null;
        return true;
      }

      return false;
    }

    if (!lists[id] || !(alloc.lists[id] > 0)) {
      return false;
    }

    alloc.lists[id] -= 1;
    return true;
  },

  /* Raise a list towards a target, one whole item at a time. False when it stalls. */
  raiseList(id, target, alloc, lists, fits) {
    const items = lists[id].items;
    const goal = Math.min(this.count(target, 0), items.length);

    while ((alloc.lists[id] || 0) < goal) {
      alloc.lists[id] = (alloc.lists[id] || 0) + 1;

      if (!fits()) {
        alloc.lists[id] -= 1;
        return false;
      }
    }

    return true;
  },

  /*
   * Raise the schedule towards a target number of days. A day that does not
   * fit whole is tried with fewer rows and a "+ N more" line, down to one row;
   * a day that cannot show even one is left off, and the list closes either
   * way, because the days after it come after it.
   */
  raiseSchedule(target, alloc, schedule, fits) {
    const days = schedule.days;
    const goal = Math.min(this.count(target, 0), days.length);
    const s = alloc.schedule;

    if (s.tail) {
      return false;
    }

    while (s.days < goal) {
      const index = s.days;
      const items = Array.isArray(days[index].items) ? days[index].items : [];

      s.days = index + 1;
      s.tail = null;

      if (fits()) {
        continue;
      }

      for (let k = items.length - 1; k >= 1; k--) {
        s.tail = { events: k, more: items.length - k };

        if (fits()) {
          return false;
        }
      }

      s.days = index;
      s.tail = null;
      return false;
    }

    return true;
  }
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = RailLogic;
}
