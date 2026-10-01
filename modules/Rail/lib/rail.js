/*
 * The rail's layout: the pure part.
 *
 * The rail is 1056 pixels of things that all want to be there, and the
 * schedule at the bottom used to get whatever the cards left, clipped through
 * the middle of a row. This decides, from measured heights alone, how many
 * whole items each block shows, so that:
 *
 *   - the schedule always lists the rest of today, whole -- that is the
 *     floor of the rail, and nothing above it is allowed to cost it a row;
 *   - every card stack (messages, inbound, transfers) shows at least one card;
 *   - what is left over goes to a ladder of priorities, one whole item at a
 *     time, and a rung that does not fit is skipped rather than half drawn;
 *   - when even that does not fit -- a twenty-event day with a freeze warning
 *     and the radio on -- everything else gives way in a stated order, first
 *     the cards one at a time and then whole blocks, down to the clock and
 *     today's events alone. Today's own rows are never on that list.
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
 *       { id: "clock", height: 86, keep: true },           fixed: shown as is,
 *                                                          and never hidden
 *       { id: "freeze", height: 78 },                      fixed: shown as is
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
 * Any block can also be named in the giving-way order by its id, and then it
 * goes whole -- base, items, sections, gap and all -- when its turn comes.
 * A block marked `keep` is the exception: the clock's box is filled by the
 * native overlay, which draws over whatever the page puts there, so hiding
 * the box would only slide the rest of the rail under its ink.
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
     * they are about the next hour and cost a line each, so the ladder adds
     * them early and cheaply, and they are never something the day's events
     * or a card make room for. The covers of what the channel owes, likewise.
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
   * Today is the floor and tomorrow is the leftover: everything between them
   * goes up whole, in order, and the schedule beyond today takes what that
   * leaves. The order once put tomorrow on the fourth rung, ahead of the
   * forecast's second row, and on an ordinary day -- a text, a package, the
   * radio on, seven events tomorrow -- the wall listed all of tomorrow and
   * cut the week's weather to one or two rows. Tomorrow is on the month grid
   * to the left; the forecast is on the wall nowhere else.
   *
   * Every text first. A text is on the wall nowhere else and gone in an
   * hour; the order once put tomorrow ahead of the second text too, and on
   * the evening of 2026-09-13 the wall showed three rows of tomorrow and
   * "+ 4 more" with a text held back that would have fit twice over. Then
   * the forecast, whole; then what the radio does next -- one line, about
   * the next hour -- and the covers of the episodes the channel owes; then
   * every package, the radio's second row, every download; and only then
   * tomorrow, the day after, and on down, as far as the room goes.
   */
  DEFAULT_LADDER: [
    ["messages", "all"],
    ["forecast", "all"],
    ["upnext", 1],
    ["due", 1],
    ["inbound", "all"],
    ["upnext", "all"],
    ["transfers", "all"],
    ["schedule", "all"]
  ],

  /*
   * What gives way, first to last, when the minimums alone do not fit. A list
   * is emptied one item at a time before the next name is touched; a block
   * named here goes whole. The cards go first, a text last among them,
   * because a text is the one card that is on the wall nowhere else and gone
   * in an hour; then the radio card, which is only saying what the speakers
   * already are; then the weather, which is on a phone; and the freeze
   * warning last, because when it is up it is the most important thing in
   * the rail after the day itself.
   *
   * The schedule is not here, and naming it changes nothing: the rest of
   * today is the floor this order exists to protect, and it is never
   * trimmed, not even behind a "+ N more" line. If today's events alone do
   * not fit under the clock, the rail reports that it does not fit; it does
   * not hide one.
   */
  DEFAULT_SACRIFICE: ["transfers", "inbound", "forecast", "nowplaying", "messages", "weather", "freeze"],

  /*
   * Decide what each block shows.
   *
   * Returns
   *   {
   *     lists: { forecast: 3, messages: 1, inbound: 1, transfers: 0 },
   *     schedule: { days: 2, floor: 1, tail: null | { events: 4, more: 3 } },
   *     hidden: ["nowplaying"],          blocks that gave way whole
   *     cost, height, fits, overflow,
   *     sacrificed: ["transfers", "nowplaying"]   what was given up, in order
   *   }
   *
   * `floor` is how many of the schedule's days are the minimum -- everything
   * through today -- and none of those is ever partial. `tail` describes the
   * last shown day when it is partial: `events` of its rows are drawn, then
   * one "+ more more" line; it is only ever a day beyond the floor.
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

    const alloc = { lists: {}, schedule: { days: 0, floor: 0, tail: null }, hidden: new Set() };
    const closed = new Set();
    const sacrificed = [];

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
       * to and including today is the floor; failing a today, the first day
       * listed. A minimum higher than that adds days beyond the floor, and
       * those can still give way.
       */
      const todayIndex = days.findIndex((d) => d && d.today);
      const throughToday = todayIndex >= 0 ? todayIndex + 1 : Math.min(1, days.length);
      alloc.schedule.floor = throughToday;
      alloc.schedule.days = Math.min(days.length, Math.max(throughToday, this.count(minimums.schedule, 1)));
    }

    /* ------------------------------------------------------------------ *
     * If they do not fit, give way in order.
     * ------------------------------------------------------------------ */

    if (!fits()) {
      for (const id of sacrifice) {
        let reduced = false;
        while (!fits() && this.reduce(id, alloc, lists, blocks, closed)) {
          reduced = true;
        }
        if (reduced) {
          closed.add(id);
          sacrificed.push(id);
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
      hidden: [...alloc.hidden],
      cost: total,
      height,
      fits: total <= height,
      overflow: Math.max(0, total - height),
      sacrificed
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
        lists[block.list] = { items: block.items, block };
      }

      for (const section of Array.isArray(block.sections) ? block.sections : []) {
        if (section.list && Array.isArray(section.items) && !lists[section.list]) {
          lists[section.list] = { items: section.items, block };
        }
      }
    }

    return lists;
  },

  /* The lists a block carries: its own, or one per section. */
  listsOf(block) {
    if (!block) {
      return [];
    }

    if (block.list && Array.isArray(block.items)) {
      return [block.list];
    }

    return (Array.isArray(block.sections) ? block.sections : [])
      .filter((section) => section.list && Array.isArray(section.items))
      .map((section) => section.list);
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

    if (alloc.hidden && alloc.hidden.has(block.id)) {
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
   * Take something away under a name. True if something was taken.
   *
   * A list's name takes one item from its end. The schedule's name trims the
   * last shown day, but only a day beyond the floor: a whole day becomes its
   * rows less one and a "+ 1 more" line, then fewer rows and a bigger number,
   * down to the header and the line alone, and only then does the day go.
   * The days through today are the floor and are never touched, whatever
   * the order says.
   *
   * A block's name hides the block whole, with everything in it, unless it
   * is marked `keep`. Its lists are closed with it, so the ladder does not
   * go on filling something that is not there.
   */
  reduce(id, alloc, lists, blocks, closed) {
    if (id === "schedule") {
      const s = alloc.schedule;

      if (s.days <= s.floor) {
        return false;
      }

      const schedule = blocks.find((b) => Array.isArray(b.days));
      const day = schedule ? schedule.days[s.days - 1] : null;
      const n = day && Array.isArray(day.items) ? day.items.length : 0;

      if (!s.tail) {
        if (n > 0) {
          s.tail = { events: n - 1, more: 1 };
          return true;
        }

        s.days -= 1;
        return true;
      }

      if (s.tail.events > 0) {
        s.tail.events -= 1;
        s.tail.more += 1;
        return true;
      }

      s.days -= 1;
      s.tail = null;
      return true;
    }

    if (lists[id]) {
      if (!(alloc.lists[id] > 0)) {
        return false;
      }

      alloc.lists[id] -= 1;
      return true;
    }

    const block = blocks.find((b) => b && b.id === id && !b.keep && !Array.isArray(b.days) && !alloc.hidden.has(id));

    if (!block || this.blockCost(block, alloc) <= 0) {
      return false;
    }

    alloc.hidden.add(id);

    for (const list of this.listsOf(block)) {
      alloc.lists[list] = 0;
      closed.add(list);
    }

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
