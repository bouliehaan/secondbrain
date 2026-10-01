#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the rail's layout.
 *
 * These need no browser and no mirror: they hand RailLogic.allocate the
 * heights Rail.js would have measured and read the counts back. The cases
 * worth guarding are the promises the rail makes -- the rest of today is
 * always listed whole, every card stack keeps a card, nothing is drawn in
 * part -- and the order everything else gives way in when those promises
 * collide, with today never among the things that give.
 *
 *   node scripts/check-rail.js
 */

const Rail = require("../modules/Rail/lib/rail.js");

let failures = 0;

function check (name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

/* ---------------------------------------------------------------------- *
 * Building blocks, in the sizes the wall actually draws them.
 * ---------------------------------------------------------------------- */

const CLOCK = { id: "clock", height: 86, keep: true };
const FREEZE = { id: "freeze", height: 78 };
const WEATHER = { id: "weather", height: 112 };
const RADIO = { id: "nowplaying", height: 72 };

/*
 * The radio card with what hangs under it: the rows saying what comes next
 * and the row of covers for what is due. The card is the base and stands on
 * its own; each section carries the hairline above it.
 */
const radio = (rows = 2, due = 1) => {
  const sections = [];
  if (rows > 0) sections.push({ list: "upnext", base: 10, items: [22, 22].slice(0, rows) });
  if (due > 0) sections.push({ list: "due", base: 13, items: [30] });
  return { id: "nowplaying", standalone: true, base: 78, sections };
};

const forecast = () => ({ id: "forecast", list: "forecast", base: 30, items: [28, 28, 28, 28, 27] });

const cards = (n, h = 72) => Array.from({ length: n }, (_, i) => (i === 0 ? h : h + 6));

const secondbrain = ({ messages = 0, inbound = 0, transfers = 0 } = {}) => {
  const sections = [];
  const add = (list, n, h) => {
    if (n > 0) {
      sections.push({ list, base: sections.length === 0 ? 30 : 40, items: cards(n, h) });
    }
  };
  add("messages", messages, 72);
  add("inbound", inbound, 64);
  add("transfers", transfers, 80);
  return { id: "secondbrain", base: 0, sections };
};

const day = (events, extra = {}) => ({
  base: events === 0 ? 61 : 37,
  items: Array.from({ length: events }, () => 26),
  ...extra
});

const schedule = (days) => ({ id: "schedule", base: 42, more: 24, days });

const model = (blocks, height = 1054) => ({ height, gap: 10, blocks });

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/* What a result costs, worked out independently of the library's own sum. */
function costOf (m, r) {
  const parts = [];
  const hidden = new Set(r.hidden || []);

  for (const b of m.blocks) {
    if (hidden.has(b.id)) {
      continue;
    }

    if (b.list) {
      const n = r.lists[b.list] || 0;
      if (n > 0 || b.standalone) parts.push(b.base + sum(b.items.slice(0, n)));
    } else if (b.sections) {
      let t = b.base;
      let shown = 0;
      for (const s of b.sections) {
        const n = r.lists[s.list] || 0;
        if (n > 0) { shown++; t += s.base + sum(s.items.slice(0, n)); }
      }
      if (shown || b.standalone) parts.push(t);
    } else if (b.days) {
      const { days, tail } = r.schedule;
      if (days > 0) {
        let t = b.base;
        for (let i = 0; i < days; i++) {
          const d = b.days[i];
          t += d.base;
          if (tail && i === days - 1) t += sum(d.items.slice(0, tail.events)) + b.more;
          else t += sum(d.items);
        }
        parts.push(t);
      }
    } else if (b.height > 0) {
      parts.push(b.height);
    }
  }

  return sum(parts) + Math.max(0, parts.length - 1) * m.gap;
}

function run () {
  console.log("\nRail layout checks\n");

  {
    // Captured at 1920x1080 with two transfers shown and a third held back.
    // Tomorrow's heading + first event fit by 0.078125px. A blanket 2px
    // reserve incorrectly left 55.671875px blank below today's events.
    const fs = require("node:fs");
    const vm = require("node:vm");
    let renderer;
    vm.runInNewContext(fs.readFileSync(require.resolve("../modules/Rail/Rail.js"), "utf8"), {
      Module: { register: (_name, definition) => { renderer = definition; } }
    });
    const m = model([
      CLOCK,
      { id: "weather", height: 107.75 },
      { id: "forecast", list: "forecast", base: 27.25, items: [28, 28, 28, 28, 28, 28, 27] },
      { id: "nowplaying", standalone: true, base: 72.859375, sections: [
        { list: "upnext", base: 9, items: [22] },
        { list: "due", base: 13, items: [30] }
      ] },
      { id: "secondbrain", base: 0, sections: [
        { list: "transfers", base: 30.5, items: [86.0625, 92.0625, 92.0625] }
      ] },
      { id: "schedule", base: 27.25, more: 0, days: [
        { base: 31.59375, items: [24, 24, 24, 24, 24], today: true },
        { base: 31.59375, items: [24, 24, 24, 24, 24, 24] }
      ] }
    ], 1056 - renderer.defaults.slackPx);
    const r = Rail.allocate(m);
    check("two transfers leave room for tomorrow's first event", r.lists.transfers === 2 && r.schedule.days === 2 && r.schedule.tail?.events === 1, JSON.stringify(r));
    check("the captured rail fills without clipping", r.fits && r.height - r.cost < 1, JSON.stringify(r));
  }

  {
    // The live rail left 74px below tomorrow: a new day and an event fit,
    // but a separate overflow line made Rail reject both. A heading count
    // costs no vertical space and must let the next day's first row in.
    const agenda = { ...schedule([day(3, { today: true }), day(8), day(7)]), more: 0 };
    const blocks = [CLOCK, WEATHER, forecast(), RADIO, agenda];
    const firstTwo = Rail.allocate(model(blocks), { ladder: [["forecast", "all"], ["schedule", 2]] });
    const m = model(blocks, firstTwo.cost + 74);
    const r = Rail.allocate(m);
    check("74 spare pixels show the next day's event instead of blank space", r.schedule.days === 3 && r.schedule.tail.events === 1, JSON.stringify(r));
    check("the heading reports the other six events", r.schedule.tail.more === 6, JSON.stringify(r.schedule));
    check("the remainder is smaller than another event", r.height - r.cost < 26 && r.fits, JSON.stringify(r));

    const crowded = Rail.allocate({ ...m, height: firstTwo.cost - 100 });
    check("compact counts still protect all of today when crowded", crowded.schedule.days >= 1 && !(crowded.schedule.days === 1 && crowded.schedule.tail), JSON.stringify(crowded));
  }

  /* ------------------------------------------------------------------ *
   * A quiet day: everything fits, so everything is shown.
   * ------------------------------------------------------------------ */

  {
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(2, { today: true }), day(1), day(0), day(3)])]);
    const r = Rail.allocate(m);

    check("a quiet day shows every forecast row", r.lists.forecast === 5, JSON.stringify(r));
    check("a quiet day shows every day of the schedule", r.schedule.days === 4 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("the cost is what the blocks add up to", Math.abs(r.cost - costOf(m, r)) < 0.001, `${r.cost} vs ${costOf(m, r)}`);
    check("nothing was sacrificed", r.sacrificed.length === 0 && r.fits);
  }

  /* ------------------------------------------------------------------ *
   * The schedule takes what the cards leave -- but never today.
   * ------------------------------------------------------------------ */

  {
    /* 86+10 +112+10 +(30+139)+10 +72+10 = 479; cards 30+72+6+72+6+72 + 40+64+6+64 + 40+80 = 552 -> 1041 before the schedule. */
    const m = model([
      CLOCK, WEATHER, forecast(), RADIO,
      secondbrain({ messages: 3, inbound: 2, transfers: 1 }),
      schedule([day(6, { today: true }), day(2), day(4)])
    ]);
    const r = Rail.allocate(m);

    check("with the rail full, today is still listed whole", r.schedule.days >= 1 && !(r.schedule.tail && r.schedule.days === 1), JSON.stringify(r.schedule));
    check("every card stack keeps at least one card", r.lists.messages >= 1 && r.lists.inbound >= 1 && r.lists.transfers >= 1, JSON.stringify(r.lists));
    check("the forecast keeps at least one row", r.lists.forecast >= 1);
    check("and it all fits", r.fits && costOf(m, r) <= m.height, `${costOf(m, r)} into ${m.height}`);
    check("nothing was sacrificed to get there", r.sacrificed.length === 0, JSON.stringify(r.sacrificed));
  }

  /* ------------------------------------------------------------------ *
   * The ladder: what the leftover goes to, in order. Today is the floor and
   * tomorrow is the leftover; everything between goes up whole, in order.
   * ------------------------------------------------------------------ */

  {
    /*
     * Clock 86, weather 112, forecast min 58, messages 30+72 = 102, schedule
     * base 42 + today 37+52 = 131; four gaps 40: 529 before the ladder.
     * Leftover 525 for: messages 2 and 3 (78 each), the forecast's other
     * four rows (111), then tomorrow (37+26=63) and every day after.
     */
    const m = model([
      CLOCK, WEATHER, forecast(),
      secondbrain({ messages: 3 }),
      schedule([day(2, { today: true }), day(1), day(1), day(1), day(1)])
    ]);
    const r = Rail.allocate(m);

    check("with room to spare the ladder is climbed to the top", r.lists.messages === 3 && r.lists.forecast === 5 && r.schedule.days === 5, JSON.stringify(r));
  }

  {
    /*
     * Same rail, 300 pixels less: 754 total, 529 spoken for, 225 left.
     * Ladder: every text first -> 78 + 78 (69 left); the forecast whole ->
     * 28 + 28 fit (13 left) and the fourth row does not; tomorrow -> 63,
     * no, and a partial needs 37 + 26 + 24 = 87, no; nothing fits in 13.
     */
    const m = model([
      CLOCK, WEATHER, forecast(),
      secondbrain({ messages: 3 }),
      schedule([day(2, { today: true }), day(1), day(1), day(1), day(1)])
    ], 754);
    const r = Rail.allocate(m);

    check("every text comes before tomorrow", r.lists.messages === 3, JSON.stringify(r.lists));
    check("the forecast comes before tomorrow", r.lists.forecast > 1 && r.schedule.days === 1, JSON.stringify(r));
    check("a rung takes the whole items that do fit and leaves the rest", r.lists.forecast === 3, JSON.stringify(r.lists));
    check("a rung that does not fit is left out, not squeezed in", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("what is left over is less than the smallest thing that wanted it", m.height - r.cost < 27, `${m.height - r.cost}px spare`);
  }

  {
    /*
     * At 900: texts to 685, the forecast whole to 796, tomorrow to 859; the
     * day after (63) does not fit in the 41 left, and with one row it has
     * no partial to offer.
     */
    const m = model([
      CLOCK, WEATHER, forecast(),
      secondbrain({ messages: 3 }),
      schedule([day(2, { today: true }), day(1), day(1), day(1), day(1)])
    ], 900);
    const r = Rail.allocate(m);

    check("with the forecast whole, the days take what is left one at a time", r.lists.forecast === 5 && r.schedule.days === 2, JSON.stringify(r));
    check("what is left over is less than the next day", m.height - r.cost < 63, `${m.height - r.cost}px spare`);
  }

  /* ------------------------------------------------------------------ *
   * The wall on the evening of 2026-09-13, as it measured itself: three
   * events left today, seven tomorrow, a package, a download, the radio on,
   * and two test texts. It showed one text and three rows of tomorrow.
   * ------------------------------------------------------------------ */

  {
    const wall = (texts) => ({ height: 1054, gap: 10, blocks: [
      { id: "clock", height: 89, keep: true },
      { id: "weather", height: 107.75 },
      { id: "forecast", list: "forecast", base: 27.25, items: [28, 28, 28, 28, 27] },
      { id: "nowplaying", standalone: true, base: 72.86, sections: [
        { list: "upnext", base: 9, items: [22] },
        { list: "due", base: 13, items: [30] }
      ] },
      { id: "secondbrain", base: 0, sections: [
        { list: "messages", base: 30.5, items: [72, 78, 78].slice(0, texts) },
        { list: "inbound", base: 40.5, items: [69.06] },
        { list: "transfers", base: 40.5, items: [86.06] }
      ] },
      { id: "schedule", base: 27.25, more: 21.59, days: [
        { base: 36.59, items: [22, 24, 24], today: true },
        { base: 31.59, items: [24, 24, 24, 24, 24, 24, 24] },
        { base: 31.59, items: [24, 24, 24, 24, 24, 24, 24, 24, 24] }
      ] }
    ] });

    const r = Rail.allocate(wall(2));

    check("the wall of 2026-09-13: both texts, and today whole", r.lists.messages === 2 && r.schedule.days >= 1 && r.schedule.tail === null && r.fits, JSON.stringify(r));
    check("tomorrow gave way to the second text, not the other way round", r.schedule.days === 1, JSON.stringify(r.schedule));

    const asItWas = Rail.allocate(wall(2), { ladder: [["upnext", 1], ["due", 1], ["schedule", 2], ["forecast", 2], ["messages", 2]] });
    check("(with tomorrow ahead of the texts, as the order once was, the second text lost)", asItWas.lists.messages === 1 && asItWas.schedule.days === 2 && asItWas.schedule.tail !== null, JSON.stringify(asItWas));

    const three = Rail.allocate(wall(3));
    check("a third text still comes before tomorrow", three.lists.messages === 3 && three.schedule.days === 1, JSON.stringify(three));
  }

  /* ------------------------------------------------------------------ *
   * The same wall on an ordinary day: one text, a package, a download, the
   * radio on with a row and its covers, three events left today and seven
   * tomorrow. Until 2026-09-19 the order put tomorrow on the fourth rung,
   * and this rail showed three rows of tomorrow, "+ 4 more", and a forecast
   * cut to its first row; the other four rows of the week's weather were
   * what tomorrow had cost.
   * ------------------------------------------------------------------ */

  {
    const wall = () => ({ height: 1054, gap: 10, blocks: [
      { id: "clock", height: 86, keep: true },
      { id: "weather", height: 107.75 },
      { id: "forecast", list: "forecast", base: 27.25, items: [28, 28, 28, 28, 27] },
      { id: "nowplaying", standalone: true, base: 72.86, sections: [
        { list: "upnext", base: 9, items: [22] },
        { list: "due", base: 13, items: [30] }
      ] },
      { id: "secondbrain", base: 0, sections: [
        { list: "messages", base: 30.5, items: [72] },
        { list: "inbound", base: 40.5, items: [69.06] },
        { list: "transfers", base: 40.5, items: [86.06] }
      ] },
      { id: "schedule", base: 27.25, more: 21.59, days: [
        { base: 36.59, items: [22, 24, 24], today: true },
        { base: 31.59, items: [24, 24, 24, 24, 24, 24, 24] },
        { base: 31.59, items: [24, 24, 24, 24, 24, 24, 24, 24, 24] }
      ] }
    ] });

    const r = Rail.allocate(wall());

    check("an ordinary day: the week's weather is whole", r.lists.forecast === 5, JSON.stringify(r.lists));
    check("the radio's row and its covers are up", r.lists.upnext === 1 && r.lists.due === 1, JSON.stringify(r.lists));
    check("today is whole and tomorrow, which does not fit, is left to the grid", r.schedule.days === 1 && r.schedule.tail === null && r.fits, JSON.stringify(r.schedule));

    const asItWas = Rail.allocate(wall(), { ladder: [
      ["messages", "all"], ["upnext", 1], ["due", 1], ["schedule", 2], ["forecast", 2], ["inbound", 2],
      ["upnext", "all"], ["schedule", 3], ["forecast", 3], ["inbound", 3], ["forecast", 5], ["transfers", "all"], ["schedule", "all"]
    ] });
    check("(with tomorrow on the fourth rung, as the order was, the forecast lost four rows to three of tomorrow)",
      asItWas.lists.forecast === 1 && asItWas.schedule.days === 2 && asItWas.schedule.tail !== null && asItWas.schedule.tail.events === 3,
      JSON.stringify(asItWas));
  }

  /* ------------------------------------------------------------------ *
   * A day that only partly fits ends with "+ N more", never mid-row.
   * ------------------------------------------------------------------ */

  {
    /*
     * 218 + 58+10 + 42 + today 63 = 391, and the forecast's other four rows
     * 111: 502 of 600; 98 left. Tomorrow whole is 37+8*26 = 245; two rows
     * and the line are 37+52+24 = 113; one row and the line, 87.
     */
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(1, { today: true }), day(8)])], 600);
    const r = Rail.allocate(m);

    check("a day too long for the space is shown in part", r.schedule.days === 2 && r.schedule.tail !== null, JSON.stringify(r.schedule));
    check("as many whole rows as fit, then the count of the rest",
      r.schedule.tail && r.schedule.tail.events === 1 && r.schedule.tail.more === 7,
      JSON.stringify(r.schedule.tail));
    check("the part shown fits", r.fits && costOf(m, r) <= m.height);
  }

  {
    /* Not even one row of tomorrow fits: 502 of 580; 78 left; a row and the line need 37+26+24 = 87. */
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(1, { today: true }), day(8)])], 580);
    const r = Rail.allocate(m);

    check("a day with no room for a single row is left off entirely", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
  }

  /* ------------------------------------------------------------------ *
   * When the minimums themselves do not fit, things give way in order.
   * ------------------------------------------------------------------ */

  const heavy = (todayEvents, height) => model([
    CLOCK, FREEZE, WEATHER, forecast(), RADIO,
    secondbrain({ messages: 1, inbound: 1, transfers: 1 }),
    schedule([day(todayEvents, { today: true }), day(2)])
  ], height);

  {
    /*
     * Minimums: 86+78+112+58+72 = 406, cards 102+104+120 = 326, schedule 42+37+12*26 = 391;
     * six blocks -> 50 of gaps: 1173. At 1080 something has to go.
     * Transfers (120 + its 0 gap inside the stack) first: 1053 fits.
     */
    const r = Rail.allocate(heavy(12, 1080));

    check("the transfers card goes first", r.lists.transfers === 0 && r.sacrificed.join() === "transfers", JSON.stringify(r));
    check("the package card is still there", r.lists.inbound === 1);
    check("today is still whole", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("it fits", r.fits);
  }

  {
    /* 1053 - inbound 104 = 949; 940 needs the forecast (58 + gap 10) as well: 881. */
    const r = Rail.allocate(heavy(12, 940));

    check("then the package card, then the forecast", r.lists.inbound === 0 && r.lists.forecast === 0 && r.sacrificed.join() === "transfers,inbound,forecast", JSON.stringify(r));
    check("today is still whole even then", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("and the message card is untouched", r.lists.messages === 1);
  }

  {
    /*
     * Without transfers, inbound and forecast: clock 86, freeze 78, weather
     * 112, radio 72, the message 102, today 391; five gaps 50: 891. Today's
     * own rows are never on the list. At 850 the radio card goes, whole,
     * with its gap: 809.
     */
    const r = Rail.allocate(heavy(12, 850));

    check("then the radio card goes, whole", r.hidden.join() === "nowplaying" && r.lists.messages === 1, JSON.stringify(r));
    check("today is still whole", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("it fits", r.fits && costOf(heavy(12, 850), r) <= 850);
  }

  {
    /* 809 at 800: the last message goes too, with its gap: 697. */
    const r = Rail.allocate(heavy(12, 800));

    check("then the last message -- and today has not lost a row", r.lists.messages === 0 && r.schedule.days >= 1 && r.schedule.tail === null, JSON.stringify(r));
    check("what the message could not use, tomorrow can", r.schedule.days === 2, JSON.stringify(r.schedule));
    check("in that order", r.sacrificed.join() === "transfers,inbound,forecast,nowplaying,messages", JSON.stringify(r.sacrificed));
    check("it fits", r.fits && costOf(heavy(12, 800), r) <= 800);
  }

  {
    /* 697 at 690: the weather goes: 575. */
    const r = Rail.allocate(heavy(12, 690));

    check("then the weather", r.hidden.includes("weather") && !r.hidden.includes("freeze"), JSON.stringify(r.hidden));
    check("today is still whole even then", r.schedule.days >= 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("it fits", r.fits && costOf(heavy(12, 690), r) <= 690);
  }

  {
    /* 575 at 570: the freeze card is the very last thing to go: 487. */
    const r = Rail.allocate(heavy(12, 570));

    check("the freeze card is the last thing to go", r.hidden.includes("freeze") && r.sacrificed[r.sacrificed.length - 1] === "freeze", JSON.stringify(r));
    check("leaving the clock and all of today", r.hidden.length === 3 && !r.hidden.includes("clock") && r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r));
    check("it fits", r.fits && costOf(heavy(12, 570), r) <= 570);
  }

  {
    const r = Rail.allocate(heavy(12, 480));

    check("a rail that cannot fit today under the clock says so", r.fits === false && r.overflow > 0, JSON.stringify(r));
    check("and still lists all of today rather than a row less", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("the clock is never hidden", !r.hidden.includes("clock"), JSON.stringify(r.hidden));
  }

  {
    const r = Rail.allocate(heavy(12, 100));

    check("even a rail far too small keeps today whole", r.fits === false && r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r));
  }

  /* ------------------------------------------------------------------ *
   * The day the rule is for: a full day, the cards up, the radio on.
   * ------------------------------------------------------------------ */

  {
    /*
     * Eighteen events left today, a text, a package, the radio with its rows
     * and covers, a freeze warning. Nothing but the clock and today has a
     * claim to a pixel until today is listed whole.
     */
    const m = model([
      CLOCK, FREEZE, WEATHER, forecast(), radio(),
      secondbrain({ messages: 2, inbound: 1 }),
      schedule([day(18, { today: true }), day(3), day(2)])
    ]);
    const r = Rail.allocate(m);

    check("on a full day every one of today's events is listed", r.schedule.days >= 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("and it is the cards that gave way", r.sacrificed.length > 0 && !r.sacrificed.includes("schedule"), JSON.stringify(r.sacrificed));
    check("it fits", r.fits && costOf(m, r) <= m.height, `${costOf(m, r)} into ${m.height}`);

    /* And when the day gets fuller still. */
    for (const n of [20, 24, 28, 32]) {
      const fuller = model([
        CLOCK, FREEZE, WEATHER, forecast(), radio(),
        secondbrain({ messages: 2, inbound: 1 }),
        schedule([day(n, { today: true }), day(3)])
      ]);
      const rr = Rail.allocate(fuller);

      check(`${n} events left today are all listed`, rr.schedule.days >= 1 && rr.schedule.tail === null && rr.fits, JSON.stringify(rr));
    }
  }

  /* ------------------------------------------------------------------ *
   * Edges.
   * ------------------------------------------------------------------ */

  {
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(0, { today: true }), day(3)])]);
    const r = Rail.allocate(m);

    check("a CLEAR today is a day like any other", r.schedule.days === 2 && r.schedule.tail === null, JSON.stringify(r.schedule));
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(1), day(2, { today: true }), day(3)])], 470);
    const r = Rail.allocate(m);

    check("a today that is not first is still reached", r.schedule.days >= 2, JSON.stringify(r.schedule));
  }

  {
    const r = Rail.allocate(model([CLOCK, WEATHER]));

    check("a rail with no lists at all is fine", r.fits && r.schedule.days === 0 && Object.keys(r.lists).length === 0, JSON.stringify(r));
  }

  {
    const r = Rail.allocate({});

    check("an empty model is fine", r.fits && r.cost === 0, JSON.stringify(r));
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), { id: "secondbrain", base: 0, sections: [] }]);
    const r = Rail.allocate(m);

    check("a card stack with no sections costs nothing", r.cost === 86 + 10 + 112 + 10 + 30 + 139, `${r.cost}`);
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), secondbrain({ transfers: 2 }), schedule([day(1, { today: true })])]);
    const r = Rail.allocate(m, { ladder: [["transfers", "all"]] });

    check("\"all\" on a rung means every item there is", r.lists.transfers === 2, JSON.stringify(r.lists));
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), secondbrain({ messages: 3 }), schedule([day(1, { today: true }), day(1)])]);
    const r = Rail.allocate(m, { ladder: [] });

    check("with no ladder, only the minimums show", r.lists.messages === 1 && r.lists.forecast === 1 && r.schedule.days === 1, JSON.stringify(r));
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), secondbrain({ messages: 3 }), schedule([day(1, { today: true }), day(1)])]);
    const r = Rail.allocate(m, { minimums: { messages: 2, forecast: 2 }, ladder: [] });

    check("minimums can be raised from config", r.lists.messages === 2 && r.lists.forecast === 2, JSON.stringify(r.lists));
  }

  {
    const m = model([
      CLOCK, FREEZE, WEATHER, forecast(), RADIO,
      secondbrain({ messages: 1, inbound: 1, transfers: 1 }),
      schedule([day(12, { today: true })])
    ], 940);
    const r = Rail.allocate(m, { sacrifice: ["messages", "schedule", "transfers", "inbound", "forecast"] });

    check("the giving-way order can be changed from config", r.sacrificed[0] === "messages" && r.lists.messages === 0, JSON.stringify(r));
    check("but naming the schedule changes nothing: today is still whole", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("and the next name is taken instead", r.lists.transfers === 0, JSON.stringify(r.lists));
  }

  {
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(30, { today: true })])], 400);
    const r = Rail.allocate(m, { sacrifice: ["clock", "weather", "forecast"] });

    check("naming the clock changes nothing either", !r.hidden.includes("clock") && r.hidden.includes("weather"), JSON.stringify(r));
  }

  {
    /*
     * A minimum of three days puts two beyond the floor, and those can still
     * give way from the end -- the last day's row behind "+ 1 more" (which
     * saves only 2), then the day -- but today cannot. Clock 86, schedule 42
     * + today 37+52 + two days of 37+26: 257; one gap: 353.
     */
    const m = model([CLOCK, schedule([day(2, { today: true }), day(1), day(1)])], 340);
    const r = Rail.allocate(m, { minimums: { schedule: 3 }, ladder: [], sacrifice: ["schedule"] });

    check("days beyond the floor can give way", r.schedule.floor === 1 && r.schedule.days < 3, JSON.stringify(r.schedule));
    check("today cannot", r.schedule.days >= 1 && !(r.schedule.tail && r.schedule.days === 1), JSON.stringify(r.schedule));
    check("it fits", r.fits);
  }

  /* ------------------------------------------------------------------ *
   * What hangs under the radio card: two lists with a floor of zero, whose
   * base -- the card -- stands whatever happens to them.
   * ------------------------------------------------------------------ */

  {
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3 }), schedule([day(2, { today: true }), day(1), day(1)])]);
    const r = Rail.allocate(m);

    check("with room to spare the radio shows both its rows and the due covers", r.lists.upnext === 2 && r.lists.due === 1, JSON.stringify(r.lists));
    check("and the cost counts the card, the rows and the covers", Math.abs(r.cost - costOf(m, r)) < 0.001, `${r.cost} vs ${costOf(m, r)}`);
  }

  {
    /*
     * Clock 86, weather 112, forecast 58, card 78, one message 102, schedule
     * 42 + 37 + 52 = 131; five gaps 50: 617. The forecast's other four rows
     * are 111, to 728; then the first row (10 + 22) to 760, the covers (43)
     * to 803, the second row (22) to 825, tomorrow (63) to 888. Each height
     * below is two pixels past one of those, which nothing after it fits in.
     */
    const rail = (height) => model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 1 }), schedule([day(2, { today: true }), day(1)])], height);

    const a = Rail.allocate(rail(730));
    check("with the texts up, the forecast is next, ahead of the radio's rows", a.lists.forecast === 5 && a.lists.upnext === 0 && a.lists.due === 0 && a.schedule.days === 1, JSON.stringify(a));

    const b = Rail.allocate(rail(762));
    check("then the radio's first row, ahead of the covers and tomorrow", b.lists.forecast === 5 && b.lists.upnext === 1 && b.lists.due === 0 && b.schedule.days === 1, JSON.stringify(b));

    const c = Rail.allocate(rail(805));
    check("then the covers", c.lists.upnext === 1 && c.lists.due === 1 && c.schedule.days === 1, JSON.stringify(c));

    const d = Rail.allocate(rail(827));
    check("then the second row", d.lists.upnext === 2 && d.lists.due === 1 && d.schedule.days === 1, JSON.stringify(d));

    const e = Rail.allocate(rail(890));
    check("and tomorrow last of all", e.lists.upnext === 2 && e.lists.due === 1 && e.schedule.days === 2 && e.schedule.tail === null, JSON.stringify(e));
  }

  {
    /* 83 spare pixels with a second text waiting: the text takes them (78) and neither a forecast row nor the radio's row fits in what is left. */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 2 }), schedule([day(2, { today: true }), day(1)])], 700);
    const r = Rail.allocate(m);

    check("but a second text comes before the forecast and the radio's row", r.lists.messages === 2 && r.lists.forecast === 1 && r.lists.upnext === 0 && r.lists.due === 0, JSON.stringify(r.lists));
  }

  {
    /* 617 spoken for; 620 leaves 3px, which nothing fits in. */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3 }), schedule([day(2, { today: true }), day(1)])], 620);
    const r = Rail.allocate(m);

    check("with no room the rows and covers go and the card stays", r.lists.upnext === 0 && r.lists.due === 0 && r.fits && costOf(m, r) === 617, JSON.stringify(r));
    check("a card with nothing under it is not a sacrifice", r.sacrificed.length === 0, JSON.stringify(r.sacrificed));
  }

  {
    /*
     * The second row waits its turn. The floor with a package is 721 (617
     * plus the inbound section, 40 + 64); then the texts (78 + 78, to 877),
     * the forecast (111, to 988), the first row (32), the covers (43), the
     * second package (70) -- 1133 -- and only then the 22 of the second
     * row, to 1155; tomorrow (63) after that.
     */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3, inbound: 2 }), schedule([day(2, { today: true }), day(1), day(1)])], 1157);
    const r = Rail.allocate(m);

    check("the second row comes after the texts, the forecast and the second package", r.lists.upnext === 2 && r.lists.due === 1 && r.lists.messages === 3 && r.lists.forecast === 5 && r.lists.inbound === 2 && r.schedule.days === 1, JSON.stringify(r));

    const tighter = Rail.allocate({ ...m, height: 1150 });
    check("and not before them", tighter.lists.upnext === 1 && tighter.lists.due === 1 && tighter.lists.messages === 3 && tighter.lists.inbound === 2, JSON.stringify(tighter.lists));
  }

  {
    /* A day so full the floor itself gives way: the rows and covers were never part of it. */
    const m = model([CLOCK, FREEZE, WEATHER, forecast(), radio(), secondbrain({ messages: 1, inbound: 1, transfers: 1 }), schedule([day(14, { today: true })])], 900);
    const r = Rail.allocate(m);

    check("when the floor gives way the rows and covers are already gone, and the card goes whole in its turn", r.lists.upnext === 0 && r.lists.due === 0 && r.hidden.includes("nowplaying") && r.fits && costOf(m, r) === r.cost, JSON.stringify(r));
    check("neither is in the giving-way order, having nothing to give", !r.sacrificed.includes("upnext") && !r.sacrificed.includes("due"), JSON.stringify(r.sacrificed));
    check("and today is whole", r.schedule.days === 1 && r.schedule.tail === null, JSON.stringify(r.schedule));
  }

  {
    /* A radio card with no rows at all -- a station nobody publishes a schedule for. */
    const m = model([CLOCK, WEATHER, forecast(), radio(0, 0), schedule([day(2, { today: true })])]);
    const r = Rail.allocate(m);

    check("a card with nothing to hang under it is measured as the card", Math.abs(r.cost - costOf(m, r)) < 0.001 && r.fits, `${r.cost} vs ${costOf(m, r)}`);
  }

  /* ------------------------------------------------------------------ *
   * Properties that must hold for any rail at all.
   * ------------------------------------------------------------------ */

  {
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    let bad = null;

    for (let trial = 0; trial < 2000 && !bad; trial++) {
      const blocks = [CLOCK];
      if (rnd(3) === 0) blocks.push(FREEZE);
      blocks.push(WEATHER, forecast());
      if (rnd(2) === 0) blocks.push(rnd(2) === 0 ? RADIO : radio(rnd(3), rnd(2)));
      const sb = secondbrain({ messages: rnd(4), inbound: rnd(4), transfers: rnd(3) });
      if (sb.sections.length) blocks.push(sb);
      const days = Array.from({ length: 1 + rnd(8) }, (_, i) => day(rnd(14), i === 0 ? { today: true } : {}));
      blocks.push(schedule(days));
      const m = model(blocks, 300 + rnd(900));
      const r = Rail.allocate(m);

      const floor = Rail.allocate({ ...m, height: 1e9 }, { ladder: [] });
      const minimumFits = floor.cost <= m.height;

      if (Math.abs(r.cost - costOf(m, r)) > 0.001) {
        bad = `cost ${r.cost} != ${costOf(m, r)}`;
      } else if (r.fits !== (r.cost <= m.height)) {
        bad = "fits disagrees with cost";
      } else if (minimumFits && !r.fits) {
        bad = `the minimum fits (${floor.cost}) but the result does not (${r.cost})`;
      } else if (minimumFits && r.sacrificed.length) {
        bad = `sacrificed ${r.sacrificed} although the minimum fits`;
      } else if (minimumFits && (r.schedule.days < 1 || (r.schedule.days === 1 && r.schedule.tail))) {
        bad = `today not whole: ${JSON.stringify(r.schedule)}`;
      } else if (minimumFits && sb.sections.some((s) => (r.lists[s.list] || 0) < 1)) {
        bad = `a stack lost its card: ${JSON.stringify(r.lists)}`;
      } else if (r.schedule.tail && r.schedule.tail.events + r.schedule.tail.more !== days[r.schedule.days - 1].items.length) {
        bad = `tail does not add up: ${JSON.stringify(r.schedule)}`;
      } else if (r.schedule.tail && r.schedule.tail.events === 0 && !r.sacrificed.includes("schedule")) {
        bad = `an empty tail outside a sacrifice: ${JSON.stringify(r.schedule)}`;
      } else if (r.schedule.days < r.schedule.floor || (r.schedule.tail && r.schedule.days <= r.schedule.floor)) {
        bad = `today is not whole: ${JSON.stringify(r.schedule)}`;
      } else if (r.hidden.includes("clock")) {
        bad = `the clock was hidden: ${JSON.stringify(r)}`;
      } else if (86 + 10 + 42 + days[0].base + sum(days[0].items) <= m.height && !r.fits) {
        bad = `today would fit under the clock alone but the rail does not fit: ${JSON.stringify(r)}`;
      } else if (r.fits && r.sacrificed.length === 0 && r.hidden.length > 0) {
        bad = `hidden without a sacrifice: ${JSON.stringify(r)}`;
      } else {
        for (const [id, n] of Object.entries(r.lists)) {
          const own = blocks.flatMap((b) => b.list ? [b] : (b.sections || [])).find((l) => l.list === id)?.items
            || (id === "forecast" ? forecast().items : []);
          if (n < 0 || n > own.length) bad = `${id} shows ${n} of ${own.length}`;
        }
        if (!bad && minimumFits && !r.fits) bad = "does not fit";
        const radioBlock = blocks.find((b) => b.standalone);
        if (!bad && radioBlock && radioBlock.sections.some((l) => l.list === "upnext") && r.lists.upnext === undefined) bad = "the radio's rows were not counted";
        if (!bad && radioBlock && radioBlock.sections.some((l) => l.list === "due") && r.lists.due === undefined) bad = "the due covers were not counted";
      }

      if (bad) {
        bad = `trial ${trial} (height ${m.height}): ${bad}`;
      }
    }

    check("2000 random rails: cost adds up, fits is honest, today is always whole, the clock stays, tails add up", bad === null, bad || "");
  }
}

run();

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
);

process.exit(failures === 0 ? 0 : 1);
