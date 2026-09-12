"use strict";

/*
 * What comes after what is playing, as far as anyone honestly knows.
 *
 * The card above says what the radio is doing now. This decides the line or
 * two under it: when the current thing gives way, and to what. No I/O here --
 * everything arrives as plain objects a caller already fetched, so
 * scripts/check-nowplaying.js can walk every case with no server behind it.
 *
 * The rule that shapes all of it: **a boundary the station will actually keep
 * is worth a line; a guess is not.** What that leaves, by source:
 *
 *   - A Samo channel has a plan, and the plan has booked blocks that start on
 *     the clock. The next one of those is a fact -- "All Things Considered at
 *     4:00 PM" -- and so is the end of the block that is on now. The next
 *     TRACK is not: the scheduler picks it only when the current item ends,
 *     as a weighted draw among near-equal candidates seeded by the second, so
 *     a "next song" read off a preview would change every poll and be wrong
 *     when the moment came. It is left off on purpose.
 *   - A cast queue is a list; the next item is the next item. When the list
 *     runs out the device tunes back to its default station, which is the
 *     honest "next" for an audiobook -- not chapter two, but "Jake Channel
 *     at 6:40 PM".
 *   - An internet station knows nothing of its future unless somebody
 *     publishes a schedule. The BBC does, openly; NPR member stations on
 *     Composer do, by station id. Everything else gets no line, because a
 *     line that is not there beats one that is made up.
 *
 * A row is `{ label, at, title, detail }`: the label is NEXT, UNTIL or ENDS;
 * `at` is the moment as epoch milliseconds (0 when there is none to name);
 * title and detail are what the moment brings, when known. Rows come back
 * nearest first, so a rail short of room can drop them from the end.
 *
 * Under the rows, for a channel, is the one thing it does know about what is
 * coming: the episodes it owes, in the order it means to play them -- see
 * resolveDue.
 */

/* Beyond this a boundary is not "next", it is the schedule; the wall has one. */
const HORIZON_MS = 12 * 60 * 60 * 1000;

/*
 * An item at least this long has an end worth naming. A song does not: "ENDS
 * 4:03 PM" on every track is noise, and the next thing is a coin toss anyway.
 * A podcast episode, an audiobook, a relayed programme -- those, yes.
 */
const LONG_FORM_SECONDS = 10 * 60;

/*
 * The next queue item gets a start time only when it is this far off. "NEXT
 * 4:03 PM  Bad Guy" two minutes before it plays is clutter; "NEXT 6:40 PM
 * Jake Channel" at the end of a two-hour audiobook is the point.
 */
const TIME_ON_QUEUE_SECONDS = 15 * 60;

/* Two boundaries closer than this are the same boundary. */
const SAME_MOMENT_MS = 60 * 1000;

/*
 * How far a recomputed end may drift before the shown time moves. A queue
 * item's end is worked out from the device's reported position every poll,
 * and that position is read at whatever instant the poll lands; without a
 * tolerance the last minute of an audiobook reads 6:40, 6:41, 6:40.
 */
const STEADY_MS = 30 * 1000;

const LABEL_NEXT = "NEXT";
const LABEL_UNTIL = "UNTIL";
const LABEL_ENDS = "ENDS";

const MAX_ROWS = 2;

const text = (value) =>
  typeof value === "string" ? value.trim() : "";

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const when = (value) => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const row = (label, at, title = "", detail = "") => ({
  label,
  at: Math.max(0, Math.round(number(at))),
  title: text(title),
  detail: text(detail)
});

/* ---------------------------------------------------------------------- *
 * The channel's programme.
 * ---------------------------------------------------------------------- */

/*
 * "18:00" as minutes into the day, or -1.
 *
 * Samo writes every clock in a plan this way: a bare minute of the day in the
 * channel's own zone, which only means anything against that zone's midnight.
 */
function parseClock (value) {
  const match = text(value).match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return -1;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return -1;
  }

  return hours * 60 + minutes;
}

/*
 * "90m", "1h30m", "2h", "45s" as milliseconds, or 0. The plan's duration
 * spelling, which is Go's.
 */
function parseDuration (value) {
  const candidate = text(value);

  if (!candidate || !/^(\d+(\.\d+)?[hms])+$/.test(candidate)) {
    return 0;
  }

  let total = 0;

  for (const part of candidate.match(/\d+(\.\d+)?[hms]/g)) {
    const amount = Number(part.slice(0, -1));
    const unit = part.slice(-1);

    total += amount * (unit === "h" ? 3600 : unit === "m" ? 60 : 1) * 1000;
  }

  return total;
}

/*
 * Where the channel's day began, as an instant.
 *
 * The schedule status carries `now` in the channel's zone, offset and all, and
 * `minuteOfDay` beside it. Midnight is the one less the other -- no zone
 * tables, no guessing what "America/Denver" means to this machine, and it is
 * correct across a clock change because samo did the zone arithmetic.
 */
function localMidnight (status) {
  const now = when(status?.now);

  if (!now) {
    return 0;
  }

  const minute = number(status.minuteOfDay);
  const seconds = new Date(now).getUTCSeconds() * 1000 + (now % 1000);

  return now - minute * 60 * 1000 - seconds;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * When the block that is on air gives up the hour, or 0 when it does not say.
 *
 * Only a hard-anchored block has an end worth stating: a rotation block runs
 * until something is booked, and the booked thing is the row. A block may
 * close at a clock time or after a duration from its start.
 *
 * The block is on air, so it began at the most recent pass of its entry
 * clock -- today, or yesterday when the entry clock is later in the day than
 * now, which is a night block seen from the small hours. Its exit clock is
 * read from that start: an exit at or before the entry ("22:00" to "01:00")
 * closes the next day. Working from the start rather than asking "has the
 * exit already passed today" matters at the end of a block: the status is
 * remembered for a minute, and for that minute after nine o'clock a block
 * that ran until nine must read as over, not as running until nine tomorrow.
 */
function activeBlockEnd (programme, at) {
  const status = programme?.status;
  const blockId = text(status?.programming?.blockId);
  const blocks = programme?.plan?.plan?.blocks;

  if (!blockId || !Array.isArray(blocks)) {
    return 0;
  }

  const block = blocks.find((b) => b && text(b.id) === blockId);

  if (!block || !block.enter || !block.enter.hard) {
    return 0;
  }

  const midnight = localMidnight(status);
  const enterMinute = parseClock(block.enter?.at);

  if (!midnight || enterMinute < 0) {
    return 0;
  }

  const nowMinute = number(status.minuteOfDay);
  const startDay = enterMinute <= nowMinute ? midnight : midnight - DAY_MS;
  const start = startDay + enterMinute * 60 * 1000;

  const exitMinute = parseClock(block.exit?.at);

  if (exitMinute >= 0) {
    return startDay + exitMinute * 60 * 1000 + (exitMinute <= enterMinute ? DAY_MS : 0);
  }

  const duration = parseDuration(block.exit?.duration);

  if (duration > 0) {
    return start + duration;
  }

  return 0;
}

/*
 * When the channel's current item ends, or 0 for a live one or one with no
 * known length.
 */
function channelItemEnd (programme) {
  const now = programme?.now;
  const started = when(now?.startedAt);
  const duration = number(now?.current?.durationSeconds);

  if (!started || duration < LONG_FORM_SECONDS || now?.current?.live) {
    return 0;
  }

  return started + duration * 1000;
}

function channelBoundaries (programme, at) {
  const found = [];
  const anchor = programme?.status?.programming?.nextAnchor;
  const nextStart = when(anchor?.start);

  if (nextStart > at) {
    found.push({ kind: "next", at: nextStart, title: text(anchor.label) || text(anchor.blockId) });
  }

  const blockEnd = activeBlockEnd(programme, at);

  if (blockEnd > at) {
    found.push({ kind: "until", at: blockEnd });
  }

  const itemEnd = channelItemEnd(programme);

  if (itemEnd > at) {
    found.push({ kind: "ends", at: itemEnd });
  }

  return found;
}

/* ---------------------------------------------------------------------- *
 * A cast queue.
 * ---------------------------------------------------------------------- */

/* "Artist · Album" arrives as one subtitle; the artist is the half worth a row. */
function subtitleArtist (subtitle) {
  return text(subtitle).split("·").map((part) => text(part)).filter(Boolean)[0] || "";
}

function queueRows (state, now, at) {
  const queue = Array.isArray(state?.queue) ? state.queue : [];
  const index = Math.max(0, Math.floor(number(state?.queueIndex)));
  const following = queue[index + 1];

  const duration = number(state?.durationSeconds);
  const position = number(state?.positionSeconds);
  const remaining = duration > 0 ? Math.max(0, duration - position) : 0;

  /*
   * A paused item ends at no particular time. The next item is still the next
   * item; only the clock comes off it.
   */
  const endsAt = remaining > 0 && !now?.paused ? at + remaining * 1000 : 0;

  if (following && typeof following === "object") {
    const title = text(following.title);

    if (!title) {
      return [];
    }

    return [row(
      LABEL_NEXT,
      remaining >= TIME_ON_QUEUE_SECONDS ? endsAt : 0,
      title,
      subtitleArtist(following.subtitle)
    )];
  }

  if (!endsAt) {
    return [];
  }

  /*
   * The last item. When it ends the device goes back to whatever it was
   * tuned to before somebody cast over it -- if it has anywhere to go. A
   * device with no default station simply falls silent, and ENDS says so.
   */
  const fallback = state?.defaultStation && typeof state.defaultStation === "object"
    ? text(state.defaultStation.name)
    : "";
  const paired = state?.server?.paired !== false;

  if (fallback && paired) {
    return [row(LABEL_NEXT, endsAt, fallback)];
  }

  return [row(LABEL_ENDS, endsAt)];
}

/* ---------------------------------------------------------------------- *
 * A station with a published schedule.
 * ---------------------------------------------------------------------- */

function scheduleBoundaries (schedule, at) {
  const found = [];
  const next = schedule?.next;
  const nextStart = when(next?.start);

  if (nextStart > at && text(next?.title)) {
    found.push({ kind: "next", at: nextStart, title: text(next.title) });
  }

  const nowEnd = when(schedule?.now?.end);

  if (nowEnd > at) {
    found.push({ kind: "until", at: nowEnd });
  }

  return found;
}

/* ---------------------------------------------------------------------- *
 * Putting it together.
 * ---------------------------------------------------------------------- */

/*
 * Boundaries, nearest first, with the ones that say the same thing folded
 * together: a block that ends exactly when the next one starts is one row
 * reading NEXT, not an UNTIL and a NEXT a minute apart; an item that ends when
 * a booked show cuts in is explained by the show.
 */
function fold (boundaries, at) {
  const horizon = at + HORIZON_MS;
  const sorted = boundaries
    .filter((b) => b.at > at && b.at <= horizon)
    .sort((a, b) => a.at - b.at);

  const rows = [];

  for (const boundary of sorted) {
    const last = rows[rows.length - 1];

    if (last && Math.abs(last.at - boundary.at) < SAME_MOMENT_MS) {
      /* Whichever of the two names what comes next wins the row. */
      if (last.label !== LABEL_NEXT && boundary.kind === "next") {
        rows[rows.length - 1] = row(LABEL_NEXT, last.at, boundary.title);
      }
      continue;
    }

    if (boundary.kind === "next") {
      rows.push(row(LABEL_NEXT, boundary.at, boundary.title));
    } else if (boundary.kind === "until") {
      rows.push(row(LABEL_UNTIL, boundary.at));
    } else {
      rows.push(row(LABEL_ENDS, boundary.at));
    }
  }

  return rows.slice(0, MAX_ROWS);
}

/**
 * The rows under the card.
 *
 * @param {object} input
 * @param {object} input.now  the card, as resolveNowPlaying built it
 * @param {object} [input.state]  the device state the card came from
 * @param {object} [input.programme]  for a channel: `{ status, plan, now }` --
 *   GET /channels/{id}/schedule/status, GET /channels/{id}/plan and
 *   GET /channels/{id}/now, as samo returns them
 * @param {object} [input.schedule]  for a station: `{ now, next }` from a
 *   schedule provider, see `parseSchedule`
 * @param {function} [input.clock]
 * @returns {object[]}  nearest first, at most two
 */
function resolveUpNext ({ now, state, programme, schedule, clock = Date.now } = {}) {
  if (!now || typeof now !== "object") {
    return [];
  }

  const at = clock();

  if (now.source === "queue") {
    return queueRows(state, now, at);
  }

  const boundaries = [];

  if (now.source === "channel") {
    boundaries.push(...channelBoundaries(programme, at));
  }

  /*
   * A station's schedule applies whether the station is tuned directly or
   * being relayed by a channel block: the block says when the relay stops,
   * the station says what it is airing until then.
   */
  if (schedule) {
    boundaries.push(...scheduleBoundaries(schedule, at));
  }

  return fold(boundaries, at);
}

/*
 * Hold a row's clock still against jitter.
 *
 * Given what was shown last time and what was just worked out, keeps the old
 * moment for a row that names the same thing at nearly the same time. The
 * boundaries that matter here move by whole minutes when they move at all;
 * the ones that wobble are the ones read off a playing position.
 */
function steadyUpNext (previous, rows, toleranceMs = STEADY_MS) {
  const before = Array.isArray(previous) ? previous : [];

  return (Array.isArray(rows) ? rows : []).map((current) => {
    const match = before.find(
      (p) =>
        p &&
        p.label === current.label &&
        p.title === current.title &&
        p.at > 0 &&
        current.at > 0 &&
        Math.abs(p.at - current.at) < toleranceMs
    );

    return match ? { ...current, at: match.at } : current;
  });
}

/* ---------------------------------------------------------------------- *
 * What the channel owes: the episodes due to play, in order.
 *
 * A new episode is not a candidate to samo, it is an obligation -- something
 * the station owes the listener -- and the obligation queue is an ORDER:
 * tier first, then newest first, with anything about to stop being news
 * lifted up. Ordering that queue and scoring a candidate are, in samo's own
 * words, the same question asked twice and cannot disagree, so the queue is
 * the order the station means to play them in. That makes it the one
 * "coming up" fact about a channel that is honest to show, and it moves for
 * honest reasons: a new S-tier episode goes to the front, the one that just
 * aired drops off.
 *
 * It is still not a promise -- a booked show can cut in, an episode too long
 * for the room before it waits -- which is why the row is labelled DUE and
 * not NEXT.
 *
 * And the queue's order is not quite the running order: a decision filters
 * through its hard rules before it scores, so an owed episode a rule is
 * holding back -- aired at lunch and owed a second hearing, with eight hours
 * of separation still to run -- is at the front of the queue and nowhere
 * near the front of the air. Which rules, and what they say, is samo's
 * business and stays there: each pending obligation arrives with `held:
 * { rule, reason }` when the scheduler's own rules would not offer it right
 * now (Engine.JudgeOwed), and this only reads it. Free episodes come first,
 * in samo's order; held ones after, in samo's order, marked as held.
 * ---------------------------------------------------------------------- */

/* How many covers the row carries. Past this the count says the rest. */
const DUE_MAX = 8;

/* Two letters for a show with no picture: "Joe Rogan Experience" reads JR. */
function initialsOf (name) {
  const words = text(name)
    .replace(/^the\s+/i, "")
    .split(/[\s/:&-]+/)
    .filter((w) => w && /[a-z0-9]/i.test(w));

  if (words.length === 0) {
    return "";
  }

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * The episodes the channel owes, most urgent first, as tiles for the row.
 *
 * @param {object} input
 * @param {object} [input.obligations]  GET /channels/{id}/obligations as samo
 *   answers it: `{ items, pending, total }`, pending items first and in
 *   the scheduler's order
 * @param {object} [input.sources]  GET /channels/{id}/sources, for each
 *   show's podcast id -- its cover -- and its label
 * @param {string} [input.currentRef]  the item on air, which is not due, it
 *   is playing
 * @param {number} [input.limit]
 * @returns {{ tiles: object[], pending: number }}  tiles carry `ref`, `show`,
 *   `title`, `tier`, `podcastId`, `initials`; pending is how many are owed in
 *   all, tiles included
 */
function resolveDue ({ obligations, sources, currentRef = "", limit = DUE_MAX } = {}) {
  const items = Array.isArray(obligations?.items) ? obligations.items : [];
  const sourceList = Array.isArray(sources?.items) ? sources.items : Array.isArray(sources) ? sources : [];
  const byId = new Map();

  for (const source of sourceList) {
    if (source && text(source.id)) {
      byId.set(text(source.id), source);
    }
  }

  const current = text(currentRef);
  const owed = items.filter((o) =>
    o &&
    typeof o === "object" &&
    text(o.state) === "pending" &&
    text(o.itemRef) &&
    text(o.itemRef) !== current
  );

  const held = (o) => {
    const hold = o.held && typeof o.held === "object" ? o.held : null;
    const rule = text(hold?.rule);

    return rule ? { rule, reason: text(hold.reason) } : null;
  };

  /* Free first, then held; samo's order within each. */
  const ordered = [...owed.filter((o) => !held(o)), ...owed.filter((o) => held(o))];

  const tiles = ordered.slice(0, Math.max(0, Math.floor(number(limit)) || DUE_MAX)).map((o) => {
    const source = byId.get(text(o.sourceId));
    const show = text(o.sourceLabel) || text(source?.label) || "";

    return {
      ref: text(o.itemRef),
      sourceId: text(o.sourceId),
      /* A show the sources do not list: samo's label if it gave one, else nothing yet. */
      known: Boolean(source),
      show,
      title: text(o.title),
      tier: text(o.tier).toUpperCase(),
      podcastId: text(source?.config?.podcastId),
      initials: initialsOf(show || o.title),
      held: held(o)
    };
  });

  return { tiles, pending: owed.length };
}

/* ---------------------------------------------------------------------- *
 * Schedule providers -- who publishes one, and how to read it.
 *
 * Each provider recognises a station from what samo knows about it and turns
 * the document at its URL into `{ now: { title, detail, start, end },
 * next: { title, start } }`. The fetching is the client's; this is the
 * knowing.
 * ---------------------------------------------------------------------- */

/*
 * BBC. Every BBC stream URL carries the service id -- bbc_radio_fourfm,
 * bbc_6music, bbc_world_service -- and the Sounds API answers for it with no
 * key: the broadcast on air and the ones after it, with start and end.
 */
const BBC_SERVICE_PATTERN = /\b(bbc_[a-z0-9_]+)\b/i;
const BBC_POLL_URL = "https://rms.api.bbc.co.uk/v2/broadcasts/poll/";

/*
 * NPR Composer, which a good share of NPR member stations schedule through.
 * The station is a 24-hex "ucs" id that only appears inside the station's own
 * web widgets, so it cannot be worked out from a stream URL; it is pasted
 * once, into samo.json or into a URL field on the station's samo record.
 */
const COMPOSER_UCS_PATTERN = /\bucs=([a-f0-9]{24})\b/i;
const COMPOSER_UCS_BARE = /^[a-f0-9]{24}$/i;
const COMPOSER_NOW_URL = "https://api.composer.nprstations.org/v1/widget/";

const PROVIDERS = {
  bbc: {
    /* An explicit `service` in config, else the id in the station's URLs. */
    recognise (station, configured) {
      const service = text(configured?.service);

      if (service && BBC_SERVICE_PATTERN.test(service)) {
        return service.toLowerCase();
      }

      for (const field of ["streamUrl", "homepageUrl", "metadataUrl"]) {
        const match = text(station?.[field]).match(BBC_SERVICE_PATTERN);

        if (match) {
          return match[1].toLowerCase();
        }
      }

      return "";
    },

    url (id) {
      return `${BBC_POLL_URL}${encodeURIComponent(id)}?limit=4`;
    },

    parse (document, at) {
      const broadcasts = Array.isArray(document?.data) ? document.data : [];
      const timed = broadcasts
        .map((b) => ({
          title: text(b?.titles?.primary),
          detail: text(b?.titles?.secondary),
          start: when(b?.start),
          end: when(b?.end)
        }))
        .filter((b) => b.title && b.start && b.end)
        .sort((a, b) => a.start - b.start);

      const current = timed.find((b) => b.start <= at && at < b.end) || null;
      const following = timed.find((b) => b.start > at && (!current || b.start >= current.end)) || null;

      return schedule(current, following);
    }
  },

  "npr-composer": {
    recognise (station, configured) {
      const ucs = text(configured?.ucs);

      if (COMPOSER_UCS_BARE.test(ucs)) {
        return ucs.toLowerCase();
      }

      const inConfig = ucs.match(COMPOSER_UCS_PATTERN);

      if (inConfig) {
        return inConfig[1].toLowerCase();
      }

      for (const field of ["homepageUrl", "metadataUrl", "streamUrl"]) {
        const match = text(station?.[field]).match(COMPOSER_UCS_PATTERN);

        if (match) {
          return match[1].toLowerCase();
        }
      }

      return "";
    },

    url (id) {
      return `${COMPOSER_NOW_URL}${encodeURIComponent(id)}/now?format=json`;
    },

    /*
     * `onNow` is the programme on air with ISO times; `nextUp` follows. Its
     * start is written as a JavaScript Date string rather than ISO, which
     * Date.parse reads, but when it does not the next programme starts when
     * this one ends, which is what a broadcast schedule means anyway.
     */
    parse (document, at) {
      const onNow = document?.onNow && typeof document.onNow === "object" ? document.onNow : null;
      const upcoming = Array.isArray(document?.nextUp) ? document.nextUp : [];

      const current = onNow
        ? {
            title: text(onNow.program?.name),
            detail: text(onNow.episode_title),
            start: when(onNow.start_utc),
            end: when(onNow.end_utc)
          }
        : null;

      const following = upcoming
        .map((entry) => ({
          title: text(entry?.program?.name),
          start: when(entry?.start_utc) || (current ? current.end : 0)
        }))
        .filter((entry) => entry.title && entry.start > at)
        .sort((a, b) => a.start - b.start)[0] || null;

      return schedule(
        current && current.title && current.end > at ? current : null,
        following
      );
    }
  }
};

function schedule (current, following) {
  if (!current && !following) {
    return null;
  }

  return {
    now: current
      ? { title: current.title, detail: current.detail || "", start: current.start, end: current.end }
      : null,
    next: following
      ? { title: following.title, start: following.start }
      : null
  };
}

/*
 * The provider for a station, if any: `{ provider, id, url }` or null.
 *
 * `schedules` is the optional map in samo.json, keyed by the station's samo
 * id or its name; an entry names a provider outright. Without one, each
 * provider is asked whether it recognises the station from its record.
 */
function scheduleProviderFor (station, schedules = {}) {
  if (!station || typeof station !== "object") {
    return null;
  }

  const entries = schedules && typeof schedules === "object" ? schedules : {};
  const id = text(station.id);
  const name = text(station.name).toLowerCase();

  let configured = null;

  for (const [key, value] of Object.entries(entries)) {
    const k = text(key);

    if (k && (k === id || k.toLowerCase() === name)) {
      configured = value && typeof value === "object" ? value : null;
      break;
    }
  }

  const order = configured && PROVIDERS[text(configured.provider)]
    ? [text(configured.provider)]
    : Object.keys(PROVIDERS);

  for (const key of order) {
    const provider = PROVIDERS[key];
    const found = provider.recognise(station, configured);

    if (found) {
      /* An entry may name where to ask outright -- a mirror, a proxy, a check. */
      const url = configured && text(configured.provider) === key
        ? text(configured.url) || provider.url(found)
        : provider.url(found);

      return { provider: key, id: found, url };
    }
  }

  return null;
}

/* A provider's document, read. Null when it says nothing usable. */
function parseSchedule (providerKey, document, at = Date.now()) {
  const provider = PROVIDERS[providerKey];

  if (!provider || !document || typeof document !== "object") {
    return null;
  }

  return provider.parse(document, at);
}

/*
 * What a station's schedule adds to the card itself.
 *
 * A station with no track information puts its own name in the headline,
 * because that is all the stream said. Its schedule knows better: the
 * programme on air is the headline, and the episode -- the guests, the
 * subject -- is the line under it. Returns only the fields to change.
 *
 * `stationName` is the relayed station's, for a channel block that is
 * carrying one: the card's own station is then the channel, and the line
 * that only repeats a name is repeating the station's.
 */
function describeProgramme (now, schedule, stationName = "") {
  const programme = schedule?.now;

  if (!now || !programme || !text(programme.title)) {
    return {};
  }

  const title = text(now.title).toLowerCase();
  const names = [text(now.station), text(stationName)]
    .filter(Boolean)
    .map((name) => name.toLowerCase());

  if (title && !names.includes(title)) {
    return {};
  }

  const patch = { title: text(programme.title) };
  const detail = text(programme.detail);

  if (detail && detail.toLowerCase() !== patch.title.toLowerCase()) {
    patch.album = detail;
  }

  return patch;
}

module.exports = {
  resolveUpNext,
  resolveDue,
  initialsOf,
  steadyUpNext,
  scheduleProviderFor,
  parseSchedule,
  describeProgramme,
  activeBlockEnd,
  localMidnight,
  parseClock,
  parseDuration,
  PROVIDERS,
  HORIZON_MS,
  LONG_FORM_SECONDS,
  TIME_ON_QUEUE_SECONDS,
  STEADY_MS,
  LABEL_NEXT,
  LABEL_UNTIL,
  LABEL_ENDS,
  MAX_ROWS,
  DUE_MAX
};
