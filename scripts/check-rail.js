#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the rail's layout.
 *
 * These need no browser and no mirror: they hand RailLogic.allocate the
 * heights Rail.js would have measured and read the counts back. The cases
 * worth guarding are the promises the rail makes -- the rest of today is
 * always listed, every card stack keeps a card, nothing is drawn in part --
 * and the order things give way in when those promises collide.
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

const CLOCK = { id: "clock", height: 86 };
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

  for (const b of m.blocks) {
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
   * The ladder: what the leftover goes to, in order.
   * ------------------------------------------------------------------ */

  {
    /*
     * Clock 86, weather 112, forecast min 58, messages 30+72 = 102, schedule
     * base 42 + today 37+52 = 131; four gaps 40: 529 before the ladder.
     * Leftover 525 for: tomorrow (37+26=63), forecast to 2 (28), messages 2
     * (78), day 3 (63), forecast to 3 (28), messages 3 (78), forecast to 5
     * (55), then all remaining days.
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
     * Ladder: tomorrow 63 (162 left), forecast to 2 -> 28 (134 left),
     * messages 2 -> 78 (56 left), day 3 -> 63 does not fit and a partial
     * needs 37 + 26 + 24 = 87, no; forecast to 3 -> 28 (28 left); messages
     * 3 -> 78, no; forecast to 5 -> the fourth row is exactly 28 and fits,
     * the fifth does not.
     */
    const m = model([
      CLOCK, WEATHER, forecast(),
      secondbrain({ messages: 3 }),
      schedule([day(2, { today: true }), day(1), day(1), day(1), day(1)])
    ], 754);
    const r = Rail.allocate(m);

    check("tomorrow comes before the second message", r.schedule.days >= 2, JSON.stringify(r.schedule));
    check("the second message comes before the third forecast row", r.lists.messages === 2 && r.lists.forecast >= 3, JSON.stringify(r.lists));
    check("a rung that does not fit is left out, not squeezed in", r.schedule.days === 2 && r.schedule.tail === null, JSON.stringify(r.schedule));
    check("a rung takes the whole items that do fit and leaves the rest", r.lists.forecast === 4, JSON.stringify(r.lists));
    check("what is left over is less than the smallest thing that wanted it", m.height - r.cost < 27, `${m.height - r.cost}px spare`);
  }

  /* ------------------------------------------------------------------ *
   * A day that only partly fits ends with "+ N more", never mid-row.
   * ------------------------------------------------------------------ */

  {
    /* 218 + 58+10 + 42 + today 63 = 391 of 500; 109 left. Tomorrow whole is 37+8*26 = 245. */
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(1, { today: true }), day(8)])], 500);
    const r = Rail.allocate(m);

    check("a day too long for the space is shown in part", r.schedule.days === 2 && r.schedule.tail !== null, JSON.stringify(r.schedule));
    check("as many whole rows as fit, then the count of the rest",
      r.schedule.tail && r.schedule.tail.events === 1 && r.schedule.tail.more === 7,
      JSON.stringify(r.schedule.tail));
    check("the part shown fits", r.fits && costOf(m, r) <= m.height);
  }

  {
    /* Not even one row of tomorrow fits: 391 of 420; 29 left; a row and the line need 37+26+24. */
    const m = model([CLOCK, WEATHER, forecast(), schedule([day(1, { today: true }), day(8)])], 420);
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
     * 881 without transfers, inbound and forecast. At 800, today gives way
     * from its end: each row taken is 26 back, the line costs 24, so the
     * first row taken buys 2 and each after it 26. 881 -> 879 -> 853 -> 827 -> 801 -> 775.
     */
    const r = Rail.allocate(heavy(12, 800));

    check("only then does today lose rows, from the end", r.schedule.days === 1 && r.schedule.tail !== null, JSON.stringify(r.schedule));
    check("with a count of what was taken", r.schedule.tail && r.schedule.tail.events === 7 && r.schedule.tail.more === 5, JSON.stringify(r.schedule.tail));
    check("the message card outlasts today's tail", r.lists.messages === 1);
    check("it fits", r.fits && costOf(r === null ? null : heavy(12, 800), r) <= 800);
  }

  {
    /*
     * Today down to its header and the line. Clock, freeze, weather, radio
     * 348, the message 102, five gaps 50: 500 before the schedule, whose
     * header and today's are 79 and the line 24 -- 603. One row more is 629.
     */
    const r = Rail.allocate(heavy(12, 610));

    check("today's floor is its header and the line", r.schedule.days === 1 && r.schedule.tail && r.schedule.tail.events === 0 && r.schedule.tail.more === 12, JSON.stringify(r.schedule));
    check("the message is the last card standing", r.lists.messages === 1 && r.lists.inbound === 0 && r.lists.transfers === 0);
  }

  {
    const r = Rail.allocate(heavy(12, 560));

    check("the message card is the very last thing to go", r.lists.messages === 0 && r.sacrificed.includes("messages"), JSON.stringify(r));
    check("what cannot fit is reported as not fitting", r.fits === (r.cost <= 560));
  }

  {
    const r = Rail.allocate(heavy(12, 100));

    check("a rail that cannot fit its floor says so", r.fits === false && r.overflow > 0, JSON.stringify(r));
    check("and the schedule still has today's header", r.schedule.days === 1);
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
    const r = Rail.allocate(m, { sacrifice: ["schedule", "transfers", "inbound", "forecast", "messages"] });

    check("the giving-way order can be changed from config", r.schedule.tail !== null && r.lists.transfers === 1, JSON.stringify(r));
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
     * Clock 86, weather 112, forecast 58, card 78, messages 102, schedule
     * 42 + 37 + 52 = 131; five gaps 50: 617. With 660 there is room for the
     * first row (10 + 22, to 649) and nothing else -- not the covers (43),
     * not tomorrow (63), not a second forecast row (28).
     */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3 }), schedule([day(2, { today: true }), day(1)])], 660);
    const r = Rail.allocate(m);

    check("the first row is the first rung of the ladder, ahead of the covers and tomorrow", r.lists.upnext === 1 && r.lists.due === 0 && r.schedule.days === 1 && r.lists.forecast === 1, JSON.stringify(r));
  }

  {
    /* 649 + 43 = 692 for the covers; 700 fits them and nothing after. */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3 }), schedule([day(2, { today: true }), day(1)])], 700);
    const r = Rail.allocate(m);

    check("the covers come next, ahead of tomorrow", r.lists.upnext === 1 && r.lists.due === 1 && r.schedule.days === 1, JSON.stringify(r));
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
     * plus the inbound section, 40 + 64); then the first row (32), the
     * covers (43), tomorrow (63), tomorrow's forecast row (28), the second
     * message (78) and the second package (70) -- 1035 -- and only then the
     * 22 of the second row, to 1057.
     */
    const m = model([CLOCK, WEATHER, forecast(), radio(), secondbrain({ messages: 3, inbound: 2 }), schedule([day(2, { today: true }), day(1), day(1)])], 1060);
    const r = Rail.allocate(m);

    check("the second row comes after the second message and the second package", r.lists.upnext === 2 && r.lists.due === 1 && r.lists.messages === 2 && r.lists.inbound === 2, JSON.stringify(r.lists));

    const tighter = Rail.allocate({ ...m, height: 1050 });
    check("and not before them", tighter.lists.upnext === 1 && tighter.lists.due === 1 && tighter.lists.messages === 2 && tighter.lists.inbound === 2, JSON.stringify(tighter.lists));
  }

  {
    /* A day so full the floor itself gives way: the rows and covers were never part of it. */
    const m = model([CLOCK, FREEZE, WEATHER, forecast(), radio(), secondbrain({ messages: 1, inbound: 1, transfers: 1 }), schedule([day(14, { today: true })])], 900);
    const r = Rail.allocate(m);

    check("when the floor gives way the rows and covers are already gone and the card is still there", r.lists.upnext === 0 && r.lists.due === 0 && r.fits && costOf(m, r) === r.cost, JSON.stringify(r));
    check("neither is in the giving-way order, having nothing to give", !r.sacrificed.includes("upnext") && !r.sacrificed.includes("due"), JSON.stringify(r.sacrificed));
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

    check("2000 random rails: cost adds up, fits is honest, the floor holds when it can, tails add up", bad === null, bad || "");
  }
}

run();

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
);

process.exit(failures === 0 ? 0 : 1);
