#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the Now Playing display mapping.
 *
 * These need no samo-server, no samo-radio device and no mirror -- they feed
 * hand-built device status snapshots straight into the resolver. The snapshots
 * are shaped exactly like samo-radio's own `State` (its
 * internal/player/types.go), so what is asserted here is what the wall gets.
 *
 * The cases worth guarding are all variations on one theme: the station name is
 * not the answer. A card that says "Jake Channel" when it could say what Jake
 * Channel is playing is the specific failure this module exists to avoid.
 *
 *   node scripts/check-nowplaying.js
 */

const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");

const {
  resolveNowPlaying,
  selectDevice,
  castSource,
  isRedundantStationLabel,
  splitArtistTitle
} = require("../modules/NowPlaying/lib/now-playing.js");

const {
  pollNowPlaying,
  createDetailCache,
  ARTWORK_RETRY_MS
} = require("../modules/NowPlaying/lib/samo-client.js");

const {
  resolveUpNext,
  resolveDue,
  initialsOf,
  steadyUpNext,
  scheduleProviderFor,
  parseSchedule,
  describeProgramme,
  HORIZON_MS,
  DUE_MAX
} = require("../modules/NowPlaying/lib/up-next.js");

/*
 * MagicMirror's NodeHelper, reduced to the contract the helper uses: `create`
 * copies the module definition onto an instance, and sendSocketNotification is
 * what reaches the browser. On the mirror `require("node_helper")` resolves
 * through MagicMirror's module aliases; here it resolves to this, so the real
 * node_helper.js can be started, asked and read without a server behind it.
 */
class FakeNodeHelper {
  constructor () {
    this.sent = [];
  }

  sendSocketNotification (notification, payload) {
    this.sent.push({ notification, payload });
  }

  static create (definition) {
    return class extends FakeNodeHelper {
      constructor () {
        super();
        Object.assign(this, definition);
      }
    };
  }
}

const Module = require("node:module");
const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  return request === "node_helper"
    ? "node_helper"
    : resolveFilename.call(this, request, ...rest);
};

const fakeNodeHelperModule = new Module("node_helper");
fakeNodeHelperModule.exports = FakeNodeHelper;
fakeNodeHelperModule.loaded = true;
require.cache["node_helper"] = fakeNodeHelperModule;

const NowPlayingHelper = require("../modules/NowPlaying/node_helper.js");

let failures = 0;

/*
 * The client logs a line when samo rejects a token. That is correct on the
 * mirror and noise here, where rejecting a token is one of the things being
 * tested -- so the fetch checks pass this instead of console.
 */
const quietLog = { log () {}, warn () {}, error () {} };

function check (name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

/* A device tuned to a station, in the shape the daemon reports it. */
function tuned (channel, overrides = {}) {
  return {
    deviceName: "samo-radio",
    mode: "channel",
    status: "playing",
    volume: 0.7,
    positionSeconds: 0,
    channel,
    output: { backend: "alsa", open: true },
    server: { paired: true },
    ...overrides
  };
}

function run () {
  console.log("\nNow Playing display checks\n");

  /* ---------------------------------------------------------------- *
   * The Jake Channel case: show the track, not the channel.
   * ---------------------------------------------------------------- */

  const jake = resolveNowPlaying(tuned({
    id: "jake",
    kind: "channel",
    name: "Jake Channel",
    title: "Bad Guy",
    artist: "Billie Eilish",
    sourceLabel: "Evening rotation",
    listenerCount: 1
  }));

  check(
    "a channel puts the track in the headline, not the channel name",
    jake.title === "Bad Guy" && jake.artist === "Billie Eilish",
    `got title=${JSON.stringify(jake.title)} artist=${JSON.stringify(jake.artist)}`
  );
  check(
    "the channel name is kept as context rather than dropped",
    jake.context === "Jake Channel" && jake.station === "Jake Channel"
  );
  check(
    "the source label survives for the detail line",
    jake.sourceLabel === "Evening rotation"
  );
  check(
    "a live channel reports no position, because it has none worth showing",
    jake.live === true && jake.positionSeconds === 0 && jake.durationSeconds === 0
  );

  /* Between items the streamer has nothing to announce. Falling back to the
   * channel name keeps the card up for those few seconds. */
  const between = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "", artist: ""
  }));

  check(
    "a channel between items falls back to its own name rather than vanishing",
    between !== null && between.title === "Jake Channel" && between.artist === ""
  );

  /* ---------------------------------------------------------------- *
   * Internet radio: take whatever the stream is willing to say.
   * ---------------------------------------------------------------- */

  const npr = resolveNowPlaying(tuned({
    id: "npr", kind: "station", name: "NPR", title: "Morning Edition", artist: ""
  }));

  check(
    "an internet station shows the programme in the headline",
    npr.title === "Morning Edition" && npr.context === "NPR",
    `got title=${JSON.stringify(npr.title)}`
  );

  /* The common ICY echo: the stream fills StreamTitle with its own branding.
   * That is not a track, and rendering it as one produces "NPR / NPR". */
  const echo = resolveNowPlaying(tuned({
    id: "npr", kind: "station", name: "NPR", title: "NPR", artist: ""
  }));

  check(
    "a station echoing its own name is not mistaken for a track",
    echo.title === "NPR" && echo.artist === "" && echo.context === "",
    `got title=${JSON.stringify(echo.title)} context=${JSON.stringify(echo.context)}`
  );

  const prefixed = resolveNowPlaying(tuned({
    id: "npr", kind: "station", name: "NPR", title: "NPR - All Things Considered"
  }));

  check(
    "a station name used as a prefix is stripped, keeping what it introduced",
    prefixed.title === "All Things Considered",
    `got ${JSON.stringify(prefixed.title)}`
  );

  /* Most stations send one unparsed "Artist - Title" string. Splitting it is
   * the difference between two readable lines and one truncated one. */
  const unsplit = resolveNowPlaying(tuned({
    id: "kexp", kind: "station", name: "KEXP", title: "Talking Heads - Once in a Lifetime"
  }));

  check(
    "an unparsed \"Artist - Title\" line is split into its two parts",
    unsplit.artist === "Talking Heads" && unsplit.title === "Once in a Lifetime",
    `got artist=${JSON.stringify(unsplit.artist)} title=${JSON.stringify(unsplit.title)}`
  );

  /* A parsed artist from the server always beats one we inferred. */
  const parsed = resolveNowPlaying(tuned({
    id: "kexp", kind: "station", name: "KEXP",
    title: "Once in a Lifetime", artist: "Talking Heads"
  }));

  check(
    "an artist the station actually supplied is used as-is",
    parsed.artist === "Talking Heads" && parsed.title === "Once in a Lifetime"
  );

  /* Titles containing dashes must not lose half of themselves. */
  check(
    "splitting takes the first separator only",
    JSON.stringify(splitArtistTitle("Television - Marquee Moon - Remaster")) ===
      JSON.stringify({ artist: "Television", title: "Marquee Moon - Remaster" })
  );
  check(
    "a line with no separator is left alone",
    splitArtistTitle("Morning Edition") === null
  );

  /* ---------------------------------------------------------------- *
   * Cast queue: the server already resolved everything.
   * ---------------------------------------------------------------- */

  const cast = resolveNowPlaying({
    deviceName: "samo-radio",
    mode: "queue",
    status: "playing",
    positionSeconds: 42,
    durationSeconds: 210,
    item: {
      ref: "track:t1",
      title: "Blue Monday",
      subtitle: "New Order · Power, Corruption & Lies",
      artworkUrl: "http://127.0.0.1:6969/api/v1/music/albums/a1/cover",
      kind: "track"
    }
  });

  check(
    "a cast queue item splits its subtitle into artist and album",
    cast.title === "Blue Monday" &&
      cast.artist === "New Order" &&
      cast.album === "Power, Corruption & Lies",
    `got ${JSON.stringify([cast.title, cast.artist, cast.album])}`
  );
  check(
    "a finite queue item keeps its position, unlike a live stream",
    cast.live === false && cast.positionSeconds === 42 && cast.durationSeconds === 210
  );

  /* ---------------------------------------------------------------- *
   * A station cast as a queue item. What the wall showed on 2026-09-11: a
   * card reading "Elvis Radio / Crosley", no track, no picture, for hours --
   * the device's own report of a cast station is a bare name, and only
   * samo-server knows what the station is airing and what it looks like.
   * ---------------------------------------------------------------- */

  const castStation = (station) => resolveNowPlaying({
    deviceName: "Crosley",
    mode: "queue",
    status: "playing",
    item: {
      ref: "station:elvis",
      title: "Elvis Radio",
      subtitle: "The King, all day",
      kind: "station",
      live: true
    }
  }, { deviceName: "Crosley", cast: station ? { kind: "station", station } : null });

  const elvis = castStation({
    id: "elvis",
    name: "Elvis Radio",
    imageUrl: "https://cdn.example/elvis.png",
    coverUrl: "http://127.0.0.1:6969/api/v1/media/covers/c-9/image",
    metadataArtworkUrl: "http://sxm.lan:7717/cover.jpg",
    nowPlaying: { title: "Suspicious Minds", artist: "Elvis Presley", raw: "Elvis Presley - Suspicious Minds" }
  });

  check(
    "a cast station is described as the station, with the probe's track as the headline",
    elvis !== null && elvis.title === "Suspicious Minds" &&
      elvis.artist === "Elvis Presley" && elvis.context === "Elvis Radio" &&
      elvis.station === "Elvis Radio" && elvis.source === "station",
    `got ${JSON.stringify(elvis && [elvis.title, elvis.artist, elvis.context, elvis.source])}`
  );
  check(
    "a cast station's picture is the per-track one when the station has it",
    elvis.artwork === "http://sxm.lan:7717/cover.jpg",
    `got ${JSON.stringify(elvis.artwork)}`
  );

  const quietElvis = castStation({
    id: "elvis",
    name: "Elvis Radio",
    imageUrl: "https://cdn.example/elvis.png",
    coverUrl: "http://127.0.0.1:6969/api/v1/media/covers/c-9/image"
  });

  check(
    "a cast station with no probe line shows the station name, and its own cover",
    quietElvis.title === "Elvis Radio" && quietElvis.artist === "" &&
      quietElvis.artwork === "http://127.0.0.1:6969/api/v1/media/covers/c-9/image",
    `got ${JSON.stringify([quietElvis.title, quietElvis.artwork])}`
  );
  check(
    "a station's directory logo is the last resort",
    castStation({ name: "Elvis Radio", imageUrl: "https://cdn.example/elvis.png" }).artwork ===
      "https://cdn.example/elvis.png"
  );
  check(
    "a probe line that only repeats the station name is not a track",
    castStation({ name: "Elvis Radio", nowPlaying: { raw: "Elvis Radio" } }).title === "Elvis Radio"
  );

  const bare = castStation(null);

  check(
    "without samo's record the cast station is still a card, as the bare queue item",
    bare !== null && bare.title === "Elvis Radio" && bare.source === "queue" &&
      bare.context === "Crosley",
    `got ${JSON.stringify(bare && [bare.title, bare.source, bare.context])}`
  );
  check(
    "a cast track is not mistaken for a station even when a station record is offered",
    resolveNowPlaying({
      mode: "queue", status: "playing",
      item: { ref: "track:t1", title: "Blue Monday", subtitle: "New Order" }
    }, { cast: { kind: "station", station: { name: "Elvis Radio" } } }).source === "queue"
  );

  /*
   * A CHANNEL cast as a queue item -- the item the wall was actually holding on
   * 2026-09-11: title "Elvis Radio", stream URL a samo channel's, nothing else.
   * The channel's now-playing endpoint says what it is airing, picture and all.
   */
  const castChannel = (item, now) => resolveNowPlaying({
    deviceName: "Crosley",
    mode: "queue",
    status: "playing",
    item
  }, { deviceName: "Crosley", cast: now ? { kind: "channel", now } : null });

  const elvisChannel = castChannel({
    ref: "channel:channel_541e",
    title: "Elvis Radio",
    streamUrl: "http://127.0.0.1:6969/channels/channel_541e/stream",
    kind: "channel",
    live: true
  }, {
    channelId: "channel_541e",
    listenerCount: 2,
    current: {
      title: "Suspicious Minds",
      artist: "Elvis Presley",
      artworkUrl: "http://sxm.lan:7717/cover.jpg",
      sourceLabel: "SiriusXM relay",
      itemRef: "station:sxm-elvis"
    }
  });

  check(
    "a cast channel is described as the channel, with what it is airing as the headline",
    elvisChannel !== null && elvisChannel.title === "Suspicious Minds" &&
      elvisChannel.artist === "Elvis Presley" && elvisChannel.context === "Elvis Radio" &&
      elvisChannel.source === "channel" && elvisChannel.sourceId === "channel_541e" &&
      elvisChannel.sourceLabel === "SiriusXM relay" && elvisChannel.listenerCount === 2,
    `got ${JSON.stringify(elvisChannel && [elvisChannel.title, elvisChannel.artist, elvisChannel.context, elvisChannel.source, elvisChannel.sourceId])}`
  );
  check(
    "a cast channel's picture is the one samo resolved for what is airing",
    elvisChannel.artwork === "http://sxm.lan:7717/cover.jpg",
    `got ${JSON.stringify(elvisChannel.artwork)}`
  );
  check(
    "a cast channel between items shows the channel name, not nothing",
    castChannel({ ref: "channel:channel_541e", title: "Elvis Radio", streamUrl: "x", live: true },
      { channelId: "channel_541e" }).title === "Elvis Radio"
  );

  /* An item that arrived with no ref carries its stream URL as the ref. */
  const urlRef = castChannel({
    ref: "http://127.0.0.1:6969/channels/channel_541e/stream",
    title: "Elvis Radio",
    streamUrl: "http://127.0.0.1:6969/channels/channel_541e/stream",
    live: true
  }, { current: { title: "Burning Love", artist: "Elvis Presley" } });

  check(
    "a cast item whose ref is its stream URL is still recognised as the channel it streams",
    urlRef.title === "Burning Love" && urlRef.source === "channel" && urlRef.sourceId === "channel_541e",
    `got ${JSON.stringify([urlRef.title, urlRef.source, urlRef.sourceId])}`
  );
  check(
    "a station stream URL is recognised the same way",
    JSON.stringify(castSource({ ref: "", streamUrl: "http://samo.lan:6969/internet-radio/elvis%20radio/stream?x=1" })) ===
      JSON.stringify({ kind: "station", id: "elvis radio" })
  );
  check(
    "a catalog stream URL is not a cast source",
    castSource({ ref: "track:t1", streamUrl: "http://127.0.0.1:6969/api/v1/music/tracks/t1/stream" }) === null &&
      castSource({ ref: "http://127.0.0.1:6969/api/v1/media/files/f/stream" }) === null
  );
  check(
    "a channel record offered for a station item is ignored, and the bare item shown",
    castChannel({ ref: "station:elvis", title: "Elvis Radio", streamUrl: "x", live: true },
      { current: { title: "Wrong" } }).source === "queue"
  );

  /* ---------------------------------------------------------------- *
   * Nothing to show is a real answer, and must not render a card.
   * ---------------------------------------------------------------- */

  check(
    "an idle device shows nothing",
    resolveNowPlaying(tuned({ id: "jake", kind: "channel", name: "Jake Channel" }, {
      mode: "idle", status: "idle"
    })) === null
  );
  check(
    "a device in an error state shows nothing rather than an error card",
    resolveNowPlaying(tuned({
      id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy"
    }, { status: "error", error: "stream failed" })) === null
  );
  check(
    "a missing state shows nothing",
    resolveNowPlaying(null) === null && resolveNowPlaying(undefined) === null
  );

  /* Buffering is what a device looks like between tracks. Hiding the card for
   * it would make the wall blink several times an hour. */
  const buffering = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy", artist: "Billie Eilish"
  }, { status: "buffering" }));

  check(
    "a buffering device keeps its card, flagged",
    buffering !== null && buffering.buffering === true && buffering.title === "Bad Guy"
  );

  const paused = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy", artist: "Billie Eilish"
  }, { status: "paused" }));

  check(
    "a paused device keeps its card, flagged",
    paused !== null && paused.paused === true
  );

  /* ---------------------------------------------------------------- *
   * Identity, which drives both the artwork cache and the DOM diff.
   * ---------------------------------------------------------------- */

  const first = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy", artist: "Billie Eilish"
  }));
  const again = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy",
    artist: "Billie Eilish", listenerCount: 3
  }));
  const next = resolveNowPlaying(tuned({
    id: "jake", kind: "channel", name: "Jake Channel", title: "Bury a Friend", artist: "Billie Eilish"
  }));

  check(
    "the same track keeps the same key even as listeners come and go",
    first.key === again.key,
    `${first.key} vs ${again.key}`
  );
  check(
    "a new track gets a new key",
    first.key !== next.key
  );

  /* ---------------------------------------------------------------- *
   * Device selection, for a house with more than one box.
   * ---------------------------------------------------------------- */

  const devices = [
    { id: "kitchen", name: "Kitchen", enabled: true, state: { mode: "idle", status: "idle" } },
    { id: "shop", name: "Workshop", enabled: true, state: { mode: "channel", status: "playing" } }
  ];

  check(
    "with no device configured, the one actually playing wins",
    selectDevice(devices, "").id === "shop"
  );
  check(
    "an explicitly configured device wins even when it is silent",
    selectDevice(devices, "kitchen").id === "kitchen"
  );
  check(
    "a configured device that does not exist selects nothing, rather than the wrong room",
    selectDevice(devices, "garage") === null
  );
  check(
    "with nothing playing, the first enabled device is still selected",
    selectDevice(
      [{ id: "kitchen", enabled: true, state: { mode: "idle", status: "idle" } }],
      ""
    ).id === "kitchen"
  );
  check(
    "no devices at all selects nothing",
    selectDevice([], "") === null && selectDevice(undefined, "") === null
  );

  /* ---------------------------------------------------------------- *
   * The redundancy rule on its own.
   * ---------------------------------------------------------------- */

  check(
    "an empty value is redundant",
    isRedundantStationLabel("NPR", "") === true
  );
  check(
    "an exact echo is redundant",
    isRedundantStationLabel("NPR", "npr") === true
  );
  check(
    "a real track on a station is not redundant",
    isRedundantStationLabel("NPR", "Morning Edition") === false
  );
  check(
    "a prefixed line is not redundant, because something survives the prefix",
    isRedundantStationLabel("NPR", "NPR - Morning Edition") === false
  );

}

/* ------------------------------------------------------------------ *
 * The fetch path, against a fake samo-server on loopback.
 *
 * Everything above is a pure function of a snapshot. This part exercises the
 * bit that actually talks: device selection, the walk from a channel to the
 * catalog item it is playing, and the cover fetch that turns an album id into
 * pixels the browser can render without holding a credential.
 *
 * Needs no samo-server and no network -- the server here is this process.
 * ------------------------------------------------------------------ */

/* A 1x1 PNG, so a cover fetch has real bytes to carry. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQ" +
  "GAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function fakeSamo (state, { token = "test-token", extra = null } = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push(req.url);

    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "missing or invalid credentials" }));
    }

    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = req.url.split("?")[0];

    /* A check's own routes, layered over the standing ones. */
    if (extra && extra(url, req, res)) {
      return undefined;
    }

    if (url === "/api/v1/samo-radio/devices") {
      return json([{ id: "living-room", name: "Living Room", enabled: true, state }]);
    }

    if (url === "/api/v1/channels/jake/now") {
      return json({
        channelId: "jake",
        current: { title: "Bad Guy", artist: "Billie Eilish", itemRef: "track:t-77" }
      });
    }

    /* A podcast, whose show name is both artist and parent title. */
    if (url === "/api/v1/channels/pod/now") {
      return json({
        channelId: "pod",
        current: {
          title: "Shine The Vinyl",
          artist: "Comedy Bang Bang: The Podcast",
          itemRef: "episode:e-12"
        }
      });
    }

    if (url === "/api/v1/podcasts/episodes/e-12") {
      return json({
        id: "e-12",
        podcastId: "show-3",
        podcastTitle: "Comedy Bang Bang: The Podcast"
      });
    }

    if (url === "/api/v1/podcasts/shows/show-3/cover") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      return res.end(PNG);
    }

    if (url === "/api/v1/music/tracks/t-77") {
      return json({
        id: "t-77",
        albumId: "alb-9",
        albumTitle: "When We All Fall Asleep, Where Do We Go?",
        displayArtist: "Billie Eilish"
      });
    }

    if (url === "/api/v1/music/albums/alb-9/cover") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return { server, requests };
}

function listen (server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function writeConfig (dir, body) {
  fs.writeFileSync(path.join(dir, "samo.json"), JSON.stringify(body));
  return dir;
}

async function runFetchChecks () {
  console.log("\nNow Playing fetch checks\n");

  const playing = {
    deviceName: "Living Room",
    mode: "channel",
    status: "playing",
    channel: {
      id: "jake",
      kind: "channel",
      name: "Jake Channel",
      title: "Bad Guy",
      artist: "Billie Eilish",
      sourceLabel: "Evening rotation"
    },
    output: { backend: "alsa", open: true },
    server: { paired: true }
  };

  const { server, requests } = fakeSamo(playing);
  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));

  writeConfig(dir, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "test-token",
    deviceId: ""
  });

  const cache = createDetailCache();
  const programmes = createDetailCache();
  const first = await pollNowPlaying(dir, { cache, programmes }, quietLog);

  check(
    "a channel card is built from the device list in one poll",
    first !== null && first.title === "Bad Guy" && first.station === "Jake Channel",
    `got ${JSON.stringify(first && first.title)}`
  );
  check(
    "the album is resolved by walking the channel's itemRef into the catalog",
    first.album === "When We All Fall Asleep, Where Do We Go?",
    `got ${JSON.stringify(first.album)}`
  );
  check(
    "cover art arrives as a data URI, so the browser never needs the token",
    typeof first.artwork === "string" &&
      first.artwork.startsWith("data:image/png;base64,"),
    `got ${JSON.stringify(String(first.artwork).slice(0, 32))}`
  );
  check(
    "the cover is requested at a thumbnail width rather than full size",
    requests.some((url) => url === "/api/v1/music/albums/alb-9/cover?width=256"),
    requests.join(" ")
  );

  /*
   * The same track must not re-walk the catalog every ten seconds -- nor
   * re-ask for the channel's programme, which the rows under the card are
   * built from and which is remembered like the album is.
   */
  const countBefore = requests.length;
  const second = await pollNowPlaying(dir, { cache, programmes }, quietLog);

  check(
    "an unchanged track is not looked up again",
    requests.length - countBefore === 1 &&
      requests[requests.length - 1] === "/api/v1/samo-radio/devices",
    `made ${requests.length - countBefore} requests: ` +
      requests.slice(countBefore).join(" ")
  );
  check(
    "the cached poll still returns the full card",
    second.album === first.album && second.artwork === first.artwork
  );

  /*
   * A podcast on a channel. Caught against the real Jake Channel, which was
   * playing Comedy Bang Bang: the show name arrives as the artist AND as the
   * episode's parent title, so an unguarded card reads
   * "Comedy Bang Bang · Comedy Bang Bang".
   */
  const podState = {
    deviceName: "Living Room",
    mode: "channel",
    status: "playing",
    channel: {
      id: "pod",
      kind: "channel",
      name: "Jake Channel",
      title: "Shine The Vinyl",
      artist: "Comedy Bang Bang: The Podcast"
    },
    output: { backend: "alsa", open: true },
    server: { paired: true }
  };

  const podSamo = fakeSamo(podState);
  const podPort = await listen(podSamo.server);
  const podDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));

  writeConfig(podDir, {
    baseUrl: `http://127.0.0.1:${podPort}`,
    token: "test-token",
    deviceId: ""
  });

  const pod = await pollNowPlaying(podDir, {}, quietLog);

  check(
    "a podcast episode keeps its title and show",
    pod.title === "Shine The Vinyl" &&
      pod.artist === "Comedy Bang Bang: The Podcast",
    `got ${JSON.stringify([pod.title, pod.artist])}`
  );
  check(
    "an album that only repeats the artist is dropped rather than shown twice",
    pod.album === "",
    `got album=${JSON.stringify(pod.album)}`
  );
  check(
    "the podcast still gets its show artwork",
    typeof pod.artwork === "string" && pod.artwork.startsWith("data:image/jpeg;base64,")
  );

  podSamo.server.close();
  fs.rmSync(podDir, { recursive: true, force: true });

  /* A bad token must fail closed and quietly, not render a broken card. */
  const badTokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));
  writeConfig(badTokenDir, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "wrong",
    deviceId: ""
  });

  check(
    "a rejected token shows no card",
    (await pollNowPlaying(badTokenDir, {}, quietLog)) === null
  );

  /* A configured device that is not in the list must not fall through to
   * whatever else happens to be playing in another room. */
  const otherRoomDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));
  writeConfig(otherRoomDir, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "test-token",
    deviceId: "kitchen"
  });

  check(
    "a configured device that is absent shows nothing",
    (await pollNowPlaying(otherRoomDir, {}, quietLog)) === null
  );

  server.close();

  /* With samo-server down there is nothing to show, and it must not throw. */
  const downDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));
  writeConfig(downDir, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "test-token",
    deviceId: ""
  });

  check(
    "an unreachable samo-server shows nothing rather than throwing",
    (await pollNowPlaying(downDir, {}, quietLog)) === null
  );

  /* No credentials at all is how the module is turned off, not an error. */
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));

  check(
    "a missing samo.json shows nothing and logs nothing alarming",
    (await pollNowPlaying(emptyDir, {}, quietLog)) === null
  );

  for (const scratch of [dir, badTokenDir, otherRoomDir, downDir, emptyDir]) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The picture, as samo names it.
 *
 * A current samo decides what illustrates every item -- the song's cover, the
 * show's, the track a relayed station is playing, or that station's logo --
 * and hands the URL over in the device state. The wall's only job is to turn
 * that URL into bytes, and every case below is one where it used to fail to:
 * the URL was thrown away in favour of a lookup that could not know about
 * relayed stations, samo's own covers were fetched without the token because
 * the daemon spelled the host differently, and one bad fetch was remembered
 * for as long as the station stayed tuned.
 * ------------------------------------------------------------------ */

/* Somebody else's server: a station's CDN, which must never see our token. */
function fakeCDN () {
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization || "" });

    if (req.headers.authorization) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("not your token to give away");
    }

    if (req.url.startsWith("/logo.png") || req.url.startsWith("/api/v1/art/now.jpg")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no");
  });

  return { server, requests };
}

async function runArtworkChecks () {
  console.log("\nNow Playing artwork checks\n");

  const cdn = fakeCDN();
  const cdnPort = await listen(cdn.server);
  const cdnUrl = `http://127.0.0.1:${cdnPort}`;

  /* Covers that only exist as samo names them. `failCovers` makes the
   * uploaded-cover route fail until it is switched off. */
  let failCovers = false;
  const extra = (url, req, res) => {
    if (url === "/api/v1/internet-radio/stations/elvis") {
      if (!box.station) {
        return false;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(box.station));
      return true;
    }

    if (url === "/api/v1/internet-radio/stations/npr") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "npr",
        name: "NPR",
        coverUrl: "http://samo.lan:6969/api/v1/media/covers/c-2/image",
        imageUrl: "https://cdn.example/npr.png"
      }));
      return true;
    }

    if (url === "/api/v1/channels/channel_541e/now") {
      if (!box.channelNow) {
        return false;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(box.channelNow));
      return true;
    }

    if (url === "/api/v1/channels/relay/now") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        channelId: "relay",
        current: { title: "Morning Edition", itemRef: "station:npr", sourceLabel: "Mornings" }
      }));
      return true;
    }

    if (url === "/api/v1/media/covers/c-1/image" || url === "/api/v1/media/covers/c-2/image") {
      if (failCovers) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("thumbnailer hiccup");
        return true;
      }

      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
      return true;
    }

    return false;
  };

  const snapshot = (channel, mode = "channel", item = null) => ({
    deviceName: "Living Room",
    mode,
    status: "playing",
    channel,
    item,
    output: { backend: "alsa", open: true },
    server: { paired: true }
  });

  /* One fake samo whose state the checks swap between cases. */
  const box = { state: null, station: null, channelNow: null };
  const { server, requests } = fakeSamo(new Proxy({}, {
    get: (_, key) => box.state?.[key],
    ownKeys: () => Reflect.ownKeys(box.state || {}),
    getOwnPropertyDescriptor: (_, key) =>
      box.state && key in box.state
        ? { enumerable: true, configurable: true, value: box.state[key] }
        : undefined
  }), { extra });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));

  writeConfig(dir, { baseUrl, token: "test-token", deviceId: "" });

  const isPng = (card) =>
    typeof card?.artwork === "string" && card.artwork.startsWith("data:image/png;base64,");
  const since = (mark) => requests.slice(mark);

  /*
   * A channel relaying a station. The itemRef is `station:`, which the catalog
   * walk cannot picture; samo named the picture itself, tagged with the
   * identity of the track so a relay's fixed address moves when the song does.
   */
  box.state = snapshot({
    id: "relay",
    kind: "channel",
    name: "Jake Channel",
    title: "Morning Edition",
    artworkUrl: "/api/v1/media/covers/c-1/image?v=1a2b3c4d",
    sourceLabel: "Mornings"
  });

  let mark = requests.length;
  const relay = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a channel relaying a station gets the picture samo named for it",
    isPng(relay),
    `got ${JSON.stringify(String(relay?.artwork).slice(0, 32))}`
  );
  check(
    "samo's relative artwork path is fetched at thumbnail width with its query kept",
    since(mark).includes("/api/v1/media/covers/c-1/image?v=1a2b3c4d&width=256"),
    since(mark).join(" ")
  );
  check(
    "the browser is never handed a bare artwork URL",
    !String(relay?.artwork).startsWith("/") && !String(relay?.artwork).startsWith("http")
  );

  /*
   * The same relay from a samo that named no picture -- an older server, or a
   * station with nothing per-track. The least the card can show is the relayed
   * station's own cover, which the catalog walk finds from the `station:` ref.
   */
  box.state = snapshot({
    id: "relay",
    kind: "channel",
    name: "Jake Channel",
    title: "Morning Edition",
    sourceLabel: "Mornings"
  });

  mark = requests.length;
  const relayLogo = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a relayed station samo named no picture for falls back to the station's own cover",
    isPng(relayLogo) &&
      since(mark).includes("/api/v1/internet-radio/stations/npr") &&
      since(mark).includes("/api/v1/media/covers/c-2/image?width=256"),
    `got ${JSON.stringify(String(relayLogo?.artwork).slice(0, 32))}; ${since(mark).join(" ")}`
  );

  /*
   * A channel playing a catalog track. The album line still needs the track
   * walk; the picture does not, and the deduced cover must not be fetched over
   * the one samo named.
   */
  box.state = snapshot({
    id: "jake",
    kind: "channel",
    name: "Jake Channel",
    title: "Bad Guy",
    artist: "Billie Eilish",
    artworkUrl: "/api/v1/media/covers/c-2/image"
  });

  mark = requests.length;
  const track = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a catalog track keeps its album line from the track walk",
    track?.album === "When We All Fall Asleep, Where Do We Go?",
    `got ${JSON.stringify(track?.album)}`
  );
  check(
    "samo's picture is taken over the one deduced from the album",
    isPng(track) &&
      since(mark).includes("/api/v1/media/covers/c-2/image?width=256") &&
      !since(mark).some((url) => url.startsWith("/api/v1/music/albums/")),
    since(mark).join(" ")
  );

  /*
   * A station tuned directly, with a cover uploaded into samo. The daemon
   * paired over the LAN address, so the URL names a host that is not ours --
   * but the path is samo's, and only samo can serve it, and only to a token.
   */
  box.state = snapshot({
    id: "npr",
    kind: "station",
    name: "NPR",
    title: "NPR",
    artworkUrl: "http://samo.lan:6969/api/v1/media/covers/c-2/image"
  });

  mark = requests.length;
  const uploaded = await pollNowPlaying(dir, {}, quietLog);

  check(
    "samo's own cover is recognised however the daemon spelled the host",
    isPng(uploaded) && since(mark).includes("/api/v1/media/covers/c-2/image?width=256"),
    `got ${JSON.stringify(String(uploaded?.artwork).slice(0, 32))}; ${since(mark).join(" ")}`
  );

  /* A station whose logo lives on its own CDN. */
  box.state = snapshot({
    id: "kexp",
    kind: "station",
    name: "KEXP",
    title: "KEXP",
    artworkUrl: `${cdnUrl}/logo.png`
  });

  const cdnMark = cdn.requests.length;
  const logo = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a station's logo on somebody else's server is fetched without our token",
    isPng(logo) &&
      cdn.requests.slice(cdnMark).some((r) => r.url === "/logo.png" && r.authorization === ""),
    `got ${JSON.stringify(String(logo?.artwork).slice(0, 32))}; ` +
      JSON.stringify(cdn.requests.slice(cdnMark))
  );

  /* A bridge that happens to publish under /api/v1/ is not samo. */
  box.state = snapshot({
    id: "bridge",
    kind: "station",
    name: "Bridge FM",
    title: "Bridge FM",
    artworkUrl: `${cdnUrl}/api/v1/art/now.jpg?v=beef`
  });

  mark = requests.length;
  const bridge = await pollNowPlaying(dir, {}, quietLog);

  check(
    "an outside URL that merely looks like samo's falls through to its own host",
    isPng(bridge) &&
      cdn.requests.some((r) => r.url === "/api/v1/art/now.jpg?v=beef" && r.authorization === ""),
    `got ${JSON.stringify(String(bridge?.artwork).slice(0, 32))}`
  );

  /* A cast queue item names its picture the same way. */
  box.state = snapshot(null, "queue", {
    ref: "track:t1",
    title: "Blue Monday",
    subtitle: "New Order · Power, Corruption & Lies",
    artworkUrl: `${baseUrl}/api/v1/media/covers/c-1/image`,
    kind: "track"
  });

  const cast = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a cast queue item gets its picture through the same path",
    isPng(cast),
    `got ${JSON.stringify(String(cast?.artwork).slice(0, 32))}`
  );

  /*
   * One bad fetch must not cost the picture for as long as the station stays
   * tuned. The key of a station with no track information never changes, so
   * without a retry the first failure would be the last attempt.
   */
  box.state = snapshot({
    id: "npr",
    kind: "station",
    name: "NPR",
    title: "NPR",
    artworkUrl: "/api/v1/media/covers/c-2/image"
  });

  let clock = 1_000_000;
  const cache = createDetailCache(24, () => clock);
  const programmes = createDetailCache(24, () => clock);

  const warned = [];
  const noisyLog = { log () {}, warn: (line) => warned.push(line), error () {} };

  failCovers = true;
  const missed = await pollNowPlaying(dir, { cache, programmes }, noisyLog);

  check(
    "a cover that fails to fetch leaves the card up without a picture",
    missed !== null && missed.title === "NPR" && missed.artwork === "",
    `got ${JSON.stringify(missed && [missed.title, String(missed.artwork).slice(0, 16)])}`
  );
  check(
    "a picture samo named that did not arrive is one line in the journal, with the reason",
    warned.length === 1 &&
      warned[0].includes("/api/v1/media/covers/c-2/image") &&
      warned[0].includes("HTTP 500"),
    JSON.stringify(warned)
  );

  failCovers = false;
  clock += 10_000;
  mark = requests.length;
  const soon = await pollNowPlaying(dir, { cache, programmes }, quietLog);

  check(
    "the failure is remembered for the next few polls rather than retried every ten seconds",
    soon.artwork === "" && !since(mark).some((url) => url.startsWith("/api/v1/media/covers/")),
    since(mark).join(" ")
  );

  clock += ARTWORK_RETRY_MS;
  const retried = await pollNowPlaying(dir, { cache, programmes }, quietLog);

  check(
    "after the retry window the picture is asked for again and arrives",
    isPng(retried),
    `got ${JSON.stringify(String(retried?.artwork).slice(0, 32))}`
  );

  /* A picture that arrived is kept for good, with no retry clock on it. */
  clock += ARTWORK_RETRY_MS * 10;
  mark = requests.length;
  const kept = await pollNowPlaying(dir, { cache, programmes }, quietLog);

  check(
    "a picture that arrived is not fetched again",
    isPng(kept) && since(mark).length === 1,
    since(mark).join(" ")
  );

  /*
   * The wall on 2026-09-11: Elvis Radio cast to Crosley from the phone. The
   * device state is a one-item queue with a name and nothing else; samo-server
   * has the probe's line and the station's cover, and the wall must go and get
   * them.
   */
  box.state = snapshot(null, "queue", {
    ref: "station:elvis",
    title: "Elvis Radio",
    subtitle: "The King, all day",
    kind: "station",
    live: true
  });
  box.station = {
    id: "elvis",
    name: "Elvis Radio",
    coverUrl: "http://samo.lan:6969/api/v1/media/covers/c-2/image",
    nowPlaying: { title: "Suspicious Minds", artist: "Elvis Presley" }
  };

  mark = requests.length;
  const castElvis = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a station cast to the device shows what it is airing, not its name",
    castElvis?.title === "Suspicious Minds" && castElvis?.artist === "Elvis Presley" &&
      castElvis?.context === "Elvis Radio",
    `got ${JSON.stringify(castElvis && [castElvis.title, castElvis.artist, castElvis.context])}`
  );
  check(
    "a station cast to the device gets the station's cover from samo, with the token",
    isPng(castElvis) && since(mark).includes("/api/v1/media/covers/c-2/image?width=256"),
    `got ${JSON.stringify(String(castElvis?.artwork).slice(0, 32))}; ${since(mark).join(" ")}`
  );

  /* The probe moves on; the device's own report of the item does not. */
  box.station = { ...box.station, nowPlaying: { title: "Burning Love", artist: "Elvis Presley" } };

  const nextElvis = await pollNowPlaying(dir, {}, quietLog);

  check(
    "the station is asked again each poll, so the headline follows the probe",
    nextElvis?.title === "Burning Love" && nextElvis.key !== castElvis.key,
    `got ${JSON.stringify(nextElvis?.title)}`
  );

  /* samo cannot say: the card stays up as the bare item rather than vanishing. */
  box.station = null;

  const unknownElvis = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a cast station samo cannot describe is still a card",
    unknownElvis !== null && unknownElvis.title === "Elvis Radio" && unknownElvis.source === "queue",
    `got ${JSON.stringify(unknownElvis && [unknownElvis.title, unknownElvis.source])}`
  );

  /*
   * The item the wall was holding on 2026-09-11, exactly: queue mode, title
   * "Elvis Radio", a samo channel's stream URL, nothing else. The channel is
   * relaying a SiriusXM station through a bridge, and samo's now-playing for it
   * carries the track and the bridge's cover.
   */
  box.state = snapshot(null, "queue", {
    ref: "channel:channel_541e",
    title: "Elvis Radio",
    streamUrl: `${baseUrl}/channels/channel_541e/stream`,
    kind: "channel",
    live: true
  });
  box.channelNow = {
    channelId: "channel_541e",
    listenerCount: 1,
    current: {
      title: "Suspicious Minds",
      artist: "Elvis Presley",
      artworkUrl: `${cdnUrl}/logo.png`,
      sourceLabel: "SiriusXM",
      itemRef: "station:sxm-elvis"
    }
  };

  mark = requests.length;
  const castChannelCard = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a channel cast to the device shows what it is airing, with the channel as context",
    castChannelCard?.title === "Suspicious Minds" && castChannelCard?.artist === "Elvis Presley" &&
      castChannelCard?.context === "Elvis Radio" && castChannelCard?.source === "channel",
    `got ${JSON.stringify(castChannelCard && [castChannelCard.title, castChannelCard.artist, castChannelCard.context, castChannelCard.source])}`
  );
  check(
    "a channel cast to the device gets the picture samo resolved for the airing item",
    isPng(castChannelCard) && since(mark).includes("/api/v1/channels/channel_541e/now"),
    `got ${JSON.stringify(String(castChannelCard?.artwork).slice(0, 32))}; ${since(mark).join(" ")}`
  );

  /* The bridge's per-track cover changes with the song; the card must follow. */
  box.channelNow = {
    ...box.channelNow,
    current: { ...box.channelNow.current, title: "Burning Love" }
  };

  const nextChannelCard = await pollNowPlaying(dir, {}, quietLog);

  check(
    "a cast channel's headline follows samo's now-playing from poll to poll",
    nextChannelCard?.title === "Burning Love" && nextChannelCard.key !== castChannelCard.key,
    `got ${JSON.stringify(nextChannelCard?.title)}`
  );

  server.close();
  cdn.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/* Wait for a condition the helper reaches on its own schedule. */
function until (condition, timeoutMs = 3000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        return resolve();
      }

      if (Date.now() - started > timeoutMs) {
        return reject(new Error("timed out waiting for the helper"));
      }

      setTimeout(tick, 20);
    };

    tick();
  });
}

/*
 * The helper logs through console, as the rest of the helpers here do. These
 * checks read what it logged and keep it off the terminal -- but only around
 * the helper's own activity, because `check` prints through the same console.
 */
function captureConsole () {
  const lines = [];
  const original = { log: console.log, error: console.error };
  const record = (...args) => lines.push(args.join(" "));

  return {
    lines,
    start () {
      console.log = record;
      console.error = record;
    },
    stop () {
      console.log = original.log;
      console.error = original.error;
    }
  };
}

/* ---------------------------------------------------------------------- *
 * Up next: the rows under the card.
 *
 * Every case is "what would a person in the kitchen want to know when this
 * is over", and the answers are only ever things the station will keep to.
 * ---------------------------------------------------------------------- */

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/*
 * A Saturday afternoon on the channel's clock: 2:30 PM in Denver, which is
 * 20:30Z. Everything below is placed relative to this instant.
 */
const T = Date.parse("2026-09-12T14:30:00-06:00");
const at = (offsetMs) => new Date(T + offsetMs).toISOString();
const clock = () => T;

/* The channel's schedule status, as GET /channels/{id}/schedule/status answers. */
function status ({ blockId = "general", blockLabel = "General rotation", nextAnchor = null } = {}) {
  return {
    timezone: "America/Denver",
    now: "2026-09-12T14:30:00.250-06:00",
    localTime: "14:30",
    weekday: "Saturday",
    minuteOfDay: 14 * 60 + 30,
    onAir: "no slot is open right now; the rotation is playing",
    programming: {
      planSource: "custom",
      blockId,
      blockLabel,
      nextAnchor
    }
  };
}

/* The plan, as GET /channels/{id}/plan answers: the shape of Jake Channel's. */
const PLAN = {
  custom: true,
  plan: {
    version: 1,
    blocks: [
      { id: "general", label: "General rotation", default: true, enter: {}, exit: {} },
      { id: "fresh", label: "New episodes", enter: { at: "08:00", days: "*", when: "obligations.pending > 0" }, exit: { when: "obligations.pending == 0" } },
      { id: "music-hour", label: "Music hour", enter: { at: "17:00", days: "*", hard: true }, exit: { at: "18:00" } },
      { id: "slot-krcc", label: "KRCC", enter: { at: "08:00", days: "*", hard: true, start: "startImmediately" }, exit: { at: "09:00" } },
      { id: "slot-atc", label: "All Things Considered", enter: { at: "16:00", days: "mon,tue,wed,thu,fri", hard: true }, exit: { at: "17:00" } },
      { id: "slot-late", label: "Coast to Coast", enter: { at: "22:00", days: "sat", hard: true }, exit: { at: "01:00" } },
      { id: "slot-timed", label: "Timed block", enter: { at: "14:00", days: "*", hard: true }, exit: { duration: "1h30m" } }
    ]
  }
};

const anchor = (label, blockId, whenIso) => ({
  blockId, label, start: whenIso, at: "16:00", in: "1h30m", policy: "makeNext"
});

const channelCard = { source: "channel", sourceId: "jake", title: "Bad Guy", artist: "Billie Eilish", station: "Jake Channel", paused: false };

function runUpNextChecks () {
  console.log("\nUp next checks\n");

  /* ---------------------------------------------------------------- *
   * A Samo channel: the programme, never the next track.
   * ---------------------------------------------------------------- */

  {
    const rows = resolveUpNext({
      now: channelCard,
      programme: {
        status: status({ nextAnchor: anchor("Music hour", "music-hour", at(2.5 * HOUR)) }),
        plan: PLAN,
        now: { current: { title: "Bad Guy", durationSeconds: 194 }, startedAt: at(-MINUTE) }
      },
      clock
    });

    check(
      "in rotation, the next booked block is the row, with its start",
      rows.length === 1 && rows[0].label === "NEXT" && rows[0].title === "Music hour" && rows[0].at === T + 2.5 * HOUR,
      JSON.stringify(rows)
    );
    check(
      "a song's end is not a row -- the next song is a coin toss and three minutes away",
      !rows.some((r) => r.label === "ENDS"),
      JSON.stringify(rows)
    );
  }

  {
    const rows = resolveUpNext({
      now: channelCard,
      programme: {
        status: status({ nextAnchor: anchor("Music hour", "music-hour", at(2.5 * HOUR)) }),
        plan: PLAN,
        now: { current: { title: "JRE #2214", durationSeconds: 3 * 3600 }, startedAt: at(-2 * HOUR) }
      },
      clock
    });

    check(
      "a long item gets an ENDS row, nearest first, and the booked block after it",
      rows.length === 2 && rows[0].label === "ENDS" && rows[0].at === T + HOUR && rows[1].label === "NEXT" && rows[1].title === "Music hour",
      JSON.stringify(rows)
    );
  }

  {
    /* 8:30 AM in the KRCC block, which closes at 9:00; ATC is booked at 4. */
    const morning = status({ blockId: "slot-krcc", blockLabel: "KRCC", nextAnchor: anchor("All Things Considered", "slot-atc", "2026-09-12T16:00:00-06:00") });
    morning.now = "2026-09-12T08:30:00-06:00";
    morning.minuteOfDay = 8 * 60 + 30;
    const t = Date.parse(morning.now);

    const rows = resolveUpNext({
      now: { ...channelCard, title: "KRCC" },
      programme: { status: morning, plan: PLAN, now: { current: { title: "KRCC", live: true, durationSeconds: 0 }, startedAt: morning.now } },
      clock: () => t
    });

    check(
      "inside a booked block, the row is UNTIL its end, from the plan's clock in the channel's zone",
      rows.length >= 1 && rows[0].label === "UNTIL" && rows[0].at === Date.parse("2026-09-12T09:00:00-06:00") && rows[0].title === "",
      JSON.stringify(rows)
    );
    check(
      "and the next booked block is the row after it",
      rows.length === 2 && rows[1].label === "NEXT" && rows[1].title === "All Things Considered",
      JSON.stringify(rows)
    );
    check(
      "a live relay has no end of its own to name",
      !rows.some((r) => r.label === "ENDS"),
      JSON.stringify(rows)
    );
  }

  {
    /* 4:30 PM inside ATC, which ends at 5:00, exactly when Music hour starts. */
    const atc = status({ blockId: "slot-atc", blockLabel: "All Things Considered", nextAnchor: anchor("Music hour", "music-hour", "2026-09-11T17:00:00-06:00") });
    atc.now = "2026-09-11T16:30:00-06:00";
    atc.minuteOfDay = 16 * 60 + 30;

    const rows = resolveUpNext({
      now: channelCard,
      programme: { status: atc, plan: PLAN, now: null },
      clock: () => Date.parse(atc.now)
    });

    check(
      "a block that ends when the next begins is one NEXT row, not UNTIL and NEXT a minute apart",
      rows.length === 1 && rows[0].label === "NEXT" && rows[0].title === "Music hour" && rows[0].at === Date.parse("2026-09-11T17:00:00-06:00"),
      JSON.stringify(rows)
    );
  }

  {
    /* 11:30 PM inside a night block written as 22:00 to 01:00. */
    const late = status({ blockId: "slot-late", blockLabel: "Coast to Coast" });
    late.now = "2026-09-12T23:30:00-06:00";
    late.minuteOfDay = 23 * 60 + 30;

    const rows = resolveUpNext({ now: channelCard, programme: { status: late, plan: PLAN }, clock: () => Date.parse(late.now) });

    check(
      "a block that crosses midnight closes tomorrow, not twenty-two hours ago",
      rows.length === 1 && rows[0].label === "UNTIL" && rows[0].at === Date.parse("2026-09-13T01:00:00-06:00"),
      JSON.stringify(rows)
    );
  }

  {
    /* 12:30 AM, inside the same night block, seen from the other side of midnight. */
    const small = status({ blockId: "slot-late", blockLabel: "Coast to Coast" });
    small.now = "2026-09-13T00:30:00-06:00";
    small.minuteOfDay = 30;

    const rows = resolveUpNext({ now: channelCard, programme: { status: small, plan: PLAN }, clock: () => Date.parse(small.now) });

    check(
      "and seen from the small hours it still closes at one, not one tomorrow",
      rows.length === 1 && rows[0].label === "UNTIL" && rows[0].at === Date.parse("2026-09-13T01:00:00-06:00"),
      JSON.stringify(rows)
    );
  }

  {
    /*
     * 9:00:30, half a minute after the KRCC block ended, with the status still
     * the one remembered from 8:59:40. The block must read as over -- not as
     * running until nine tomorrow.
     */
    const stale = status({ blockId: "slot-krcc", blockLabel: "KRCC" });
    stale.now = "2026-09-12T08:59:40-06:00";
    stale.minuteOfDay = 8 * 60 + 59;

    const rows = resolveUpNext({ now: channelCard, programme: { status: stale, plan: PLAN }, clock: () => Date.parse("2026-09-12T09:00:30-06:00") });

    check("a block that has just ended, read from a status a minute old, is over, not on until tomorrow", rows.length === 0, JSON.stringify(rows));
  }

  {
    const timed = status({ blockId: "slot-timed", blockLabel: "Timed block" });
    const rows = resolveUpNext({ now: channelCard, programme: { status: timed, plan: PLAN }, clock });

    check(
      "a block that exits after a duration closes that long after it began",
      rows.length === 1 && rows[0].label === "UNTIL" && rows[0].at === Date.parse("2026-09-12T15:30:00-06:00"),
      JSON.stringify(rows)
    );
  }

  {
    const rows = resolveUpNext({
      now: channelCard,
      programme: { status: status({ nextAnchor: anchor("Wait Wait", "slot-ww", at(HORIZON_MS + HOUR)) }), plan: PLAN },
      clock
    });

    check("a booked block further off than the horizon is the schedule's business, not this line's", rows.length === 0, JSON.stringify(rows));
  }

  {
    const rows = resolveUpNext({ now: channelCard, programme: { status: null, plan: null, now: null }, clock });
    check("a channel whose programme could not be read gets no row rather than a wrong one", rows.length === 0, JSON.stringify(rows));
  }

  {
    const rows = resolveUpNext({
      now: channelCard,
      programme: {
        status: status({ nextAnchor: anchor("Music hour", "music-hour", at(3 * HOUR)) }),
        plan: PLAN,
        now: { current: { title: "Old episode", durationSeconds: 3600 }, startedAt: at(-2 * HOUR) }
      },
      clock
    });

    check(
      "an item that should already have ended names no end -- the streamer knows better than the arithmetic",
      rows.length === 1 && rows[0].label === "NEXT",
      JSON.stringify(rows)
    );
  }

  /* ---------------------------------------------------------------- *
   * A cast queue: the next item, and where the radio goes after.
   * ---------------------------------------------------------------- */

  const queueState = (queue, index, { position = 30, duration = 194, defaultStation = { kind: "channel", id: "jake", name: "Jake Channel" }, paired = true } = {}) => ({
    mode: "queue",
    status: "playing",
    positionSeconds: position,
    durationSeconds: duration,
    item: queue[index],
    queue,
    queueIndex: index,
    defaultStation,
    server: { paired }
  });

  const songs = [
    { ref: "track:1", title: "Bad Guy", subtitle: "Billie Eilish · When We All Fall Asleep", kind: "track", durationSeconds: 194 },
    { ref: "track:2", title: "Bury a Friend", subtitle: "Billie Eilish · When We All Fall Asleep", kind: "track", durationSeconds: 200 },
    { ref: "track:3", title: "Everything I Wanted", subtitle: "Billie Eilish", kind: "track", durationSeconds: 245 }
  ];

  const queueCard = { source: "queue", title: "Bad Guy", artist: "Billie Eilish", station: "", paused: false };

  {
    const rows = resolveUpNext({ now: queueCard, state: queueState(songs, 0), clock });

    check(
      "a cast queue names the next item, artist and all",
      rows.length === 1 && rows[0].label === "NEXT" && rows[0].title === "Bury a Friend" && rows[0].detail === "Billie Eilish",
      JSON.stringify(rows)
    );
    check("a song three minutes away carries no clock", rows[0].at === 0, JSON.stringify(rows));
  }

  {
    const book = [{ ref: "audiobook:b", title: "Project Hail Mary", subtitle: "Andy Weir", kind: "audiobook", durationSeconds: 16 * 3600 }];
    const rows = resolveUpNext({ now: { ...queueCard, title: "Project Hail Mary" }, state: queueState(book, 0, { position: 14 * 3600, duration: 16 * 3600 }), clock });

    check(
      "an audiobook's next is the station the radio goes back to, at the time the book ends",
      rows.length === 1 && rows[0].label === "NEXT" && rows[0].title === "Jake Channel" && rows[0].at === T + 2 * HOUR,
      JSON.stringify(rows)
    );
  }

  {
    const book = [{ ref: "audiobook:b", title: "Project Hail Mary", kind: "audiobook", durationSeconds: 16 * 3600 }];
    const rows = resolveUpNext({ now: queueCard, state: queueState(book, 0, { position: 14 * 3600, duration: 16 * 3600, defaultStation: null }), clock });

    check(
      "with nowhere to go back to, the last item simply ENDS",
      rows.length === 1 && rows[0].label === "ENDS" && rows[0].at === T + 2 * HOUR,
      JSON.stringify(rows)
    );
  }

  {
    const rows = resolveUpNext({ now: { ...queueCard, paused: true }, state: queueState(songs, 2, { position: 10, duration: 245 }), clock });
    check("a paused last song has no end to name", rows.length === 0, JSON.stringify(rows));

    const pausedNext = resolveUpNext({ now: { ...queueCard, paused: true }, state: queueState(songs, 0, { position: 10, duration: 20 * 60 }), clock });
    check(
      "a paused queue still names the next item, without a clock",
      pausedNext.length === 1 && pausedNext[0].title === "Bury a Friend" && pausedNext[0].at === 0,
      JSON.stringify(pausedNext)
    );
  }

  {
    const long = [
      { ref: "episode:1", title: "Episode 400", subtitle: "Some Show", kind: "episode", durationSeconds: 3600 },
      { ref: "episode:2", title: "Episode 401", subtitle: "Some Show", kind: "episode", durationSeconds: 3600 }
    ];
    const rows = resolveUpNext({ now: queueCard, state: queueState(long, 0, { position: 600, duration: 3600 }), clock });

    check(
      "a next item fifty minutes off carries the time it starts",
      rows.length === 1 && rows[0].title === "Episode 401" && rows[0].at === T + 50 * MINUTE,
      JSON.stringify(rows)
    );
  }

  {
    const rows = resolveUpNext({ now: queueCard, state: queueState([songs[0]], 0, { duration: 0 }), clock });
    check("a lone item of unknown length gets no row", rows.length === 0, JSON.stringify(rows));
  }

  /* ---------------------------------------------------------------- *
   * What the channel owes: the episodes due, as covers, in samo's order.
   * ---------------------------------------------------------------- */

  const owed = (ref, sourceId, tier, title, state = "pending") => ({
    channelId: "jake", sourceId, sourceLabel: "", itemRef: ref, title, tier,
    publishedAt: at(-3 * HOUR), noticedAt: at(-2 * HOUR), expiresAt: at(5 * 24 * HOUR),
    credit: 0, state, settleAt: 1, airings: 0
  });

  /* As GET /channels/jake/obligations answers: pending first, most urgent first, then satisfied. */
  const OBLIGATIONS = {
    items: [
      owed("episode:e-rogan", "src-rogan", "S", "JRE #2214 - Duncan Trussell"),
      owed("episode:e-radiolab", "src-radiolab", "A", "The Cataclysm Sentence"),
      owed("episode:e-pm", "src-pm", "B", "The price of eggs"),
      owed("episode:e-old", "src-radiolab", "A", "Last week's", "satisfied")
    ],
    pending: 3,
    total: 4
  };

  const SOURCES = {
    items: [
      { id: "src-rogan", kind: "podcast_subscription", label: "The Joe Rogan Experience", config: { podcastId: "pod-rogan", tier: "S" }, enabled: true },
      { id: "src-radiolab", kind: "podcast_subscription", label: "Radiolab", config: { podcastId: "pod-radiolab" }, enabled: true },
      { id: "src-pm", kind: "podcast_subscription", label: "Planet Money", config: { podcastId: "pod-pm" }, enabled: true }
    ],
    total: 3
  };

  {
    const due = resolveDue({ obligations: OBLIGATIONS, sources: SOURCES });

    check(
      "the episodes owed become tiles in the order samo will play them, and only the pending ones",
      due.tiles.length === 3 && due.pending === 3 && due.tiles.map((t) => t.show).join("|") === "The Joe Rogan Experience|Radiolab|Planet Money",
      JSON.stringify(due)
    );
    check(
      "each tile knows the show's podcast, which is where its cover lives",
      due.tiles[0].podcastId === "pod-rogan" && due.tiles[2].podcastId === "pod-pm" && due.tiles[0].tier === "S",
      JSON.stringify(due.tiles[0])
    );
    check(
      "a show with no picture will read as its initials",
      due.tiles[0].initials === "JR" && due.tiles[1].initials === "RA" && due.tiles[2].initials === "PM",
      JSON.stringify(due.tiles.map((t) => t.initials))
    );
  }

  {
    /*
     * The queue's order is not the running order: samo marks what its rules
     * would not offer right now, and says why in the rule's own words. The
     * wall puts those after the free ones and derives nothing itself.
     */
    const heldFirst = {
      items: [
        { ...owed("episode:e-dillon", "src-dillon", "A", "Episode 412"), credit: 1, settleAt: 2,
          held: { rule: "itemSeparation", reason: "this item aired 1h10m ago, needs 8h0m apart" } },
        owed("episode:e-huberman", "src-huberman", "B", "Sleep toolkit"),
        owed("episode:e-pm", "src-pm", "B", "The price of eggs")
      ],
      pending: 3, total: 3
    };
    const due = resolveDue({ obligations: heldFirst, sources: SOURCES });

    check(
      "an owed episode samo's rules are holding back goes after the free ones, in samo's order otherwise",
      due.tiles.map((t) => t.ref).join("|") === "episode:e-huberman|episode:e-pm|episode:e-dillon" && due.pending === 3,
      JSON.stringify(due.tiles.map((t) => t.ref))
    );
    check(
      "and carries the rule and reason for the tooltip, exactly as samo put them",
      due.tiles[2].held && due.tiles[2].held.rule === "itemSeparation" && due.tiles[2].held.reason.includes("needs 8h0m apart") && due.tiles[0].held === null,
      JSON.stringify(due.tiles.map((t) => t.held))
    );
    check(
      "a held object with no rule is not a hold",
      resolveDue({ obligations: { items: [{ ...owed("episode:e-x", "src-pm", "B", "X"), held: {} }], pending: 1 }, sources: SOURCES }).tiles[0].held === null
    );
  }

  {
    const due = resolveDue({ obligations: OBLIGATIONS, sources: SOURCES, currentRef: "episode:e-rogan" });

    check(
      "the episode on air is not due, it is playing",
      due.tiles.length === 2 && due.tiles[0].show === "Radiolab" && due.pending === 2,
      JSON.stringify(due.tiles.map((t) => t.show))
    );
  }

  {
    const many = { items: Array.from({ length: 12 }, (_, i) => owed(`episode:e-${i}`, "src-pm", "C", `Episode ${i}`)), pending: 12, total: 12 };
    const due = resolveDue({ obligations: many, sources: SOURCES });

    check(
      `the row carries ${DUE_MAX} covers and says how many are owed in all`,
      due.tiles.length === DUE_MAX && due.pending === 12,
      JSON.stringify([due.tiles.length, due.pending])
    );
  }

  {
    const labelled = { items: [{ ...owed("episode:e-x", "src-gone", "B", "Orphan"), sourceLabel: "A show samo still labels" }], pending: 1, total: 1 };
    const due = resolveDue({ obligations: labelled, sources: SOURCES });

    check(
      "samo's own label for the show wins, and a source it no longer lists costs only the picture",
      due.tiles.length === 1 && due.tiles[0].show === "A show samo still labels" && due.tiles[0].podcastId === "" && due.tiles[0].initials === "AS",
      JSON.stringify(due.tiles[0])
    );
  }

  {
    check("nothing owed is nothing", resolveDue({ obligations: { items: [], pending: 0, total: 0 }, sources: SOURCES }).tiles.length === 0);
    check("a channel whose obligations could not be read owes nothing the wall can say", resolveDue({ obligations: null, sources: null }).pending === 0);
    check("initials: the article drops, a lone word gives two letters, a number counts", initialsOf("The Daily") === "DA" && initialsOf("Radiolab") === "RA" && initialsOf("99% Invisible") === "9I");
  }

  /* ---------------------------------------------------------------- *
   * Holding a clock still.
   * ---------------------------------------------------------------- */

  {
    const before = [{ label: "NEXT", at: T + 2 * HOUR, title: "Jake Channel", detail: "" }];
    const wobbled = [{ label: "NEXT", at: T + 2 * HOUR + 12_000, title: "Jake Channel", detail: "" }];
    const steady = steadyUpNext(before, wobbled);

    check("an end read off a playing position twelve seconds later keeps the clock it had", steady[0].at === T + 2 * HOUR, JSON.stringify(steady));

    const moved = steadyUpNext(before, [{ label: "NEXT", at: T + 2 * HOUR + 5 * MINUTE, title: "Jake Channel", detail: "" }]);
    check("a real change -- a seek -- moves it", moved[0].at === T + 2 * HOUR + 5 * MINUTE, JSON.stringify(moved));

    const other = steadyUpNext(before, [{ label: "NEXT", at: T + 2 * HOUR + 12_000, title: "Elvis Radio", detail: "" }]);
    check("a different thing is not held to the old clock", other[0].at === T + 2 * HOUR + 12_000, JSON.stringify(other));
  }

  /* ---------------------------------------------------------------- *
   * Stations that publish a schedule.
   * ---------------------------------------------------------------- */

  /* The BBC's poll document for Radio 4, as fetched on 2026-09-12, cut to the fields read. */
  const BBC = {
    total: 64, limit: 4, offset: 0,
    data: [
      { type: "broadcast_summary", start: "2026-09-12T17:15:00Z", end: "2026-09-12T18:00:00Z", service_id: "bbc_radio_fourfm", titles: { primary: "Loose Ends", secondary: "Jay Rayner, Sindhu Vee, Helen Rebanks, Laura Veirs, Arab Strap, Stuart Maconie", tertiary: "" } },
      { type: "broadcast_summary", start: "2026-09-12T18:00:00Z", end: "2026-09-12T18:15:00Z", service_id: "bbc_radio_fourfm", titles: { primary: "Profile", secondary: "Richard Osman", tertiary: "" } },
      { type: "broadcast_summary", start: "2026-09-12T18:15:00Z", end: "2026-09-12T19:00:00Z", service_id: "bbc_radio_fourfm", titles: { primary: "This Cultural Life", secondary: "Ray Winstone", tertiary: "" } },
      { type: "broadcast_summary", start: "2026-09-12T19:00:00Z", end: "2026-09-12T20:00:00Z", service_id: "bbc_radio_fourfm", titles: { primary: "Archive on 4", secondary: "First Contact", tertiary: "" } }
    ]
  };

  {
    const station = { id: "r4", name: "BBC Radio 4", streamUrl: "http://as-hls-ww-live.akamaized.net/pool_904/live/ww/bbc_radio_fourfm/bbc_radio_fourfm.isml/bbc_radio_fourfm-audio%3d96000.norewind.m3u8" };
    const found = scheduleProviderFor(station);

    check(
      "a BBC station is recognised from its stream URL alone, with nothing configured",
      found && found.provider === "bbc" && found.id === "bbc_radio_fourfm" && found.url.includes("/broadcasts/poll/bbc_radio_fourfm"),
      JSON.stringify(found)
    );

    const t = Date.parse("2026-09-12T17:45:00Z");
    const schedule = parseSchedule("bbc", BBC, t);

    check(
      "the broadcast on air and the one after it are read off the poll",
      schedule && schedule.now.title === "Loose Ends" && schedule.now.end === Date.parse("2026-09-12T18:00:00Z") && schedule.next.title === "Profile" && schedule.next.start === schedule.now.end,
      JSON.stringify(schedule)
    );

    const rows = resolveUpNext({ now: { source: "station", sourceId: "r4", title: "BBC Radio 4", station: "BBC Radio 4" }, schedule, clock: () => t });

    check(
      "a station's next programme is the row, at the time it starts",
      rows.length === 1 && rows[0].label === "NEXT" && rows[0].title === "Profile" && rows[0].at === Date.parse("2026-09-12T18:00:00Z"),
      JSON.stringify(rows)
    );

    const patch = describeProgramme({ title: "BBC Radio 4", station: "BBC Radio 4" }, schedule);
    check(
      "a station echoing its own name takes the programme as its headline, and the episode under it",
      patch.title === "Loose Ends" && patch.album.startsWith("Jay Rayner"),
      JSON.stringify(patch)
    );
    check(
      "a station that named a track keeps it",
      Object.keys(describeProgramme({ title: "Blue Monday", artist: "New Order", station: "BBC 6 Music" }, schedule)).length === 0
    );
    check(
      "a channel relaying the station takes the programme too, matched against the station's own name",
      describeProgramme({ title: "BBC Radio 4", station: "Jake Channel" }, schedule, "BBC Radio 4").title === "Loose Ends"
    );

    const between = parseSchedule("bbc", BBC, Date.parse("2026-09-12T17:00:00Z"));
    check(
      "before the first listed broadcast there is no 'now', and the next is still the next",
      between && between.now === null && between.next.title === "Loose Ends",
      JSON.stringify(between)
    );
    check("a document with nothing in it is nothing", parseSchedule("bbc", { data: [] }, t) === null);
  }

  /* NPR Composer's `now` document, cut to the fields read; note nextUp's un-ISO start. */
  const COMPOSER = {
    status: true,
    onNow: {
      start_utc: "2026-09-12T20:00:00.000Z", end_utc: "2026-09-12T21:00:00.000Z",
      start_time: "14:00", end_time: "15:00", day: "Sat",
      program: { name: "Weekend All Things Considered", program_format: "News" }
    },
    nextUp: [
      { start_utc: "Sat Sep 12 2026 15:00:00 GMT-0600 (MDT)", end_utc: "Sat Sep 12 2026 16:00:00 GMT-0600 (MDT)", start_time: "15:00", program: { name: "This American Life" } },
      { start_utc: "Sat Sep 12 2026 16:00:00 GMT-0600 (MDT)", start_time: "16:00", program: { name: "Radiolab" } }
    ]
  };

  {
    const station = { id: "kxyz", name: "KXYZ", streamUrl: "https://kxyz.streamguys1.com/live" };

    check("a member station with no id anywhere is not guessed at", scheduleProviderFor(station) === null);

    const byConfig = scheduleProviderFor(station, { KXYZ: { provider: "npr-composer", ucs: "5192987ce1c820c7466cb663" } });
    check(
      "a Composer station is found by the id in samo.json, keyed by the station's name",
      byConfig && byConfig.provider === "npr-composer" && byConfig.id === "5192987ce1c820c7466cb663" && byConfig.url.includes("/widget/5192987ce1c820c7466cb663/now?format=json"),
      JSON.stringify(byConfig)
    );

    const byName = scheduleProviderFor(station, { kxyz: { provider: "npr-composer", ucs: "5192987CE1C820C7466CB663" } });
    check("the name matches whatever case it was typed in", byName && byName.id === "5192987ce1c820c7466cb663", JSON.stringify(byName));

    const byLink = scheduleProviderFor({ ...station, homepageUrl: "https://composer.nprstations.org/widgets/v2/playlist/index.html?v=5.13.1&ucs=5192987ce1c820c7466cb663" });
    check("or from a widget link pasted into the station's homepage field in samo", byLink && byLink.id === "5192987ce1c820c7466cb663", JSON.stringify(byLink));

    const t = Date.parse("2026-09-12T20:30:00Z");
    const schedule = parseSchedule("npr-composer", COMPOSER, t);

    check(
      "Composer's on-now and next-up are read, the odd date spelling included",
      schedule && schedule.now.title === "Weekend All Things Considered" && schedule.next.title === "This American Life" && schedule.next.start === Date.parse("2026-09-12T21:00:00Z"),
      JSON.stringify(schedule)
    );

    const rows = resolveUpNext({ now: { source: "station", sourceId: "kxyz", title: "KXYZ", station: "KXYZ" }, schedule, clock: () => t });
    check("and become the row", rows.length === 1 && rows[0].title === "This American Life" && rows[0].at === Date.parse("2026-09-12T21:00:00Z"), JSON.stringify(rows));
  }

  {
    const rows = resolveUpNext({ now: { source: "station", sourceId: "npr", title: "NPR", station: "NPR" }, schedule: null, clock });
    check("a station nobody publishes a schedule for gets no row -- not a guess, not chapter two", rows.length === 0, JSON.stringify(rows));
  }
}

/*
 * The rows under the card, fetched: the channel's programme through samo,
 * a station's schedule from its publisher, and what is asked for when.
 */
async function runUpNextFetchChecks () {
  console.log("\nUp next fetch checks\n");

  const NOW = Date.now();
  const inHours = (h) => new Date(NOW + h * 60 * 60 * 1000).toISOString();

  /* What samo says about Jake Channel's programme this afternoon. */
  const programme = {
    "/api/v1/channels/jake/schedule/status": {
      timezone: "America/Denver",
      now: new Date(NOW).toISOString(),
      minuteOfDay: 14 * 60 + 30,
      programming: {
        planSource: "custom",
        blockId: "general",
        blockLabel: "General rotation",
        nextAnchor: { blockId: "music-hour", label: "Music hour", start: inHours(2.5), at: "17:00", in: "2h30m", policy: "makeNext" }
      }
    },
    "/api/v1/channels/jake/plan": {
      custom: true,
      plan: { version: 1, blocks: [{ id: "general", label: "General rotation", default: true, enter: {}, exit: {} }, { id: "music-hour", label: "Music hour", enter: { at: "17:00", days: "*", hard: true }, exit: { at: "18:00" } }] }
    }
  };

  /* And the BBC's poll for Radio 4, served from here rather than Broadcasting House. */
  const bbcPoll = {
    data: [
      { start: new Date(NOW - 30 * 60 * 1000).toISOString(), end: inHours(0.5), titles: { primary: "Loose Ends", secondary: "Stuart Maconie" } },
      { start: inHours(0.5), end: inHours(1), titles: { primary: "Profile", secondary: "Richard Osman" } }
    ]
  };

  const box = {
    state: {
      deviceName: "Living Room",
      mode: "channel",
      status: "playing",
      channel: { id: "jake", kind: "channel", name: "Jake Channel", title: "Bad Guy", artist: "Billie Eilish" },
      output: { backend: "alsa", open: true },
      server: { paired: true }
    }
  };

  /* What the channel owes, and the shows it draws from; both can change under the wall. */
  let owedDoc = [
    { sourceId: "src-rogan", itemRef: "episode:e-rogan", title: "JRE #2214", tier: "S", state: "pending" },
    { sourceId: "src-radiolab", itemRef: "episode:e-radiolab", title: "The Cataclysm Sentence", tier: "A", state: "pending" },
    { sourceId: "src-nocover", itemRef: "episode:e-nc", title: "No picture", tier: "C", state: "pending" },
    /*
     * As on the wall on 2026-09-12: a source saved with no label. samo names
     * the show from the feed's own title on read, and marks the episode as
     * held -- it aired at lunch and is owed a second hearing.
     */
    { sourceId: "src-unlabelled", itemRef: "episode:e-512", title: "512 - 9/11, Netanyahu, & Artificial Annihilation", tier: "A", state: "pending",
      sourceLabel: "DarkHorse Podcast", credit: 1, settleAt: 2,
      held: { rule: "itemSeparation", reason: "this item aired 2h13m ago, needs 8h0m apart" } }
  ];
  let sourcesDoc = [
    { id: "src-rogan", label: "The Joe Rogan Experience", config: { podcastId: "pod-rogan" } },
    { id: "src-radiolab", label: "Radiolab", config: { podcastId: "pod-radiolab" } },
    { id: "src-nocover", label: "No Cover Show", config: { podcastId: "pod-nocover" } },
    { id: "src-unlabelled", label: "", config: { podcastId: "pod-darkhorse" } }
  ];

  const served = [];

  const { server, requests } = fakeSamo(null, {
    extra (url, req, res) {
      served.push(url);

      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return true;
      };

      if (url === "/api/v1/samo-radio/devices") {
        return json({ items: [{ id: "living-room", name: "Living Room", enabled: true, state: box.state }], total: 1 });
      }

      if (url === "/api/v1/channels/jake/now") {
        return json({
          channelId: "jake",
          current: { title: "Bad Guy", artist: "Billie Eilish", itemRef: "track:t-77", durationSeconds: 194 },
          startedAt: new Date(NOW - 60 * 1000).toISOString()
        });
      }

      if (programme[url]) {
        return json(programme[url]);
      }

      if (url === "/api/v1/internet-radio/stations/r4") {
        return json({ id: "r4", name: "BBC Radio 4", streamUrl: "http://stream.live.vc.bbcmedia.co.uk/bbc_radio_fourfm", nowPlaying: { title: "BBC Radio 4" } });
      }

      if (url === "/api/v1/channels/jake/obligations") {
        return json({ items: owedDoc, pending: owedDoc.filter((o) => o.state === "pending").length, total: owedDoc.length });
      }

      if (url === "/api/v1/channels/jake/sources") {
        return json({ items: sourcesDoc, total: sourcesDoc.length });
      }

      if (url === "/api/v1/podcasts/shows/pod-rogan/cover" || url === "/api/v1/podcasts/shows/pod-radiolab/cover" || url === "/api/v1/podcasts/shows/pod-new/cover" || url === "/api/v1/podcasts/shows/pod-darkhorse/cover") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
        return true;
      }

      if (url === "/api/v1/podcasts/shows/pod-nocover/cover") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no cover" }));
        return true;
      }

      if (url === "/bbc/poll") {
        return json(bbcPoll);
      }

      return false;
    }
  });

  /*
   * The BBC route above sits behind the same token check as everything else
   * on the fake, and the wall must not send samo's token to the BBC. So the
   * check that the token stays home is the request arriving without one --
   * which the fake answers 401 -- unless the route is let through first.
   */
  const bare = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (req.url === "/bbc/poll") {
      served.push(req.url);

      if (req.headers.authorization) {
        res.writeHead(500, { "content-type": "text/plain" });
        return res.end("the wall sent samo's token to the BBC");
      }

      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(bbcPoll));
    }

    return bare(req, res);
  });

  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));
  writeConfig(dir, {
    baseUrl: `http://127.0.0.1:${port}`,
    token: "test-token",
    schedules: { "BBC Radio 4": { provider: "bbc", service: "bbc_radio_fourfm", url: `http://127.0.0.1:${port}/bbc/poll` } }
  });

  const cache = createDetailCache();
  const programmes = createDetailCache();
  const covers = createDetailCache();

  /* ---------------------------------------------------------------- *
   * A channel: the programme rides along with the card.
   * ---------------------------------------------------------------- */

  const first = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "a channel card carries the episodes it owes, covers and all, in samo's order",
    first && first.due && first.due.pending === 4 && first.due.tiles.length === 4 &&
      first.due.tiles[0].show === "The Joe Rogan Experience" && first.due.tiles[0].artwork.startsWith("data:image/png;base64,") &&
      first.due.tiles[1].artwork.startsWith("data:image/png;base64,"),
    JSON.stringify(first && first.due && first.due.tiles.map((t) => [t.show, t.artwork.slice(0, 20)]))
  );
  check(
    "a show samo has no cover for keeps its tile, as initials",
    first.due.tiles[2].artwork === "" && first.due.tiles[2].initials === "NC",
    JSON.stringify(first.due.tiles[2])
  );
  check(
    "covers are asked for at the smallest rung of samo's ladder",
    requests.includes("/api/v1/podcasts/shows/pod-rogan/cover?width=64"),
    requests.filter((u) => u.includes("/cover")).join(" ")
  );
  check(
    "a show samo names from its feed keeps that name, its cover, and its hold -- and the wall looked nothing up itself",
    first.due.tiles[3].show === "DarkHorse Podcast" && first.due.tiles[3].initials === "DP" && first.due.tiles[3].artwork.startsWith("data:image/png") &&
      first.due.tiles[3].held.rule === "itemSeparation" && !requests.some((u) => u.includes("/podcasts/episodes/")),
    JSON.stringify([first.due.tiles[3], requests.filter((u) => u.includes("/episodes/"))])
  );

  check(
    "a channel card carries its next booked block",
    first && Array.isArray(first.next) && first.next.length === 1 && first.next[0].label === "NEXT" && first.next[0].title === "Music hour",
    JSON.stringify(first && first.next)
  );
  check(
    "the programme is read from the schedule status and the plan",
    requests.includes("/api/v1/channels/jake/schedule/status") && requests.includes("/api/v1/channels/jake/plan"),
    requests.join(" ")
  );
  check(
    "the channel's now-playing is asked for once, and shared with the album lookup",
    requests.filter((url) => url === "/api/v1/channels/jake/now").length === 1 && first.album === "When We All Fall Asleep, Where Do We Go?",
    requests.join(" ")
  );

  let mark = requests.length;
  const again = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "the next poll of the same track asks samo for the device list and nothing else -- the owed episodes, their covers and names included",
    requests.length - mark === 1 && again.next.length === 1 && again.due.tiles.length === 4,
    requests.slice(mark).join(" ")
  );

  /*
   * A show subscribed since the sources were read drops its first episode,
   * and samo puts it at the front. The wall must not show a nameless tile for
   * a quarter of an hour: an owed episode from a show it does not know is
   * the cue to read the sources again.
   */
  owedDoc = [{ sourceId: "src-new", itemRef: "episode:e-new", title: "First ever episode", tier: "S", state: "pending" }, ...owedDoc];
  sourcesDoc = [...sourcesDoc, { id: "src-new", label: "Brand New Show", config: { podcastId: "pod-new" } }];
  programmes.set("obligations:jake", { value: null }, { retryAfterMs: 1 });   /* the minute is up */
  await new Promise((resolve) => setTimeout(resolve, 5));

  mark = requests.length;
  const dropped = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "a new show's first episode arrives at the front with its name and cover, the sources re-read for it",
    dropped.due.tiles[0].show === "Brand New Show" && dropped.due.tiles[0].artwork.startsWith("data:image/png") && dropped.due.pending === 5 &&
      requests.slice(mark).filter((u) => u === "/api/v1/channels/jake/sources").length === 1,
    JSON.stringify([dropped.due.tiles[0], requests.slice(mark)])
  );

  mark = requests.length;
  const off = await pollNowPlaying(dir, { cache, programmes: createDetailCache(), covers: createDetailCache(), upNext: false }, quietLog);

  check(
    "with the rows switched off, nothing is asked that only they need",
    Array.isArray(off.next) && off.next.length === 0 && off.due.tiles.length === 0 &&
      !requests.slice(mark).some((url) => url.includes("/schedule/status") || url.includes("/plan") || url.includes("/obligations") || url.includes("/sources")),
    requests.slice(mark).join(" ")
  );

  /* ---------------------------------------------------------------- *
   * A station with a published schedule.
   * ---------------------------------------------------------------- */

  box.state = {
    deviceName: "Living Room",
    mode: "channel",
    status: "playing",
    channel: { id: "r4", kind: "station", name: "BBC Radio 4", title: "BBC Radio 4" },
    output: { backend: "alsa", open: true },
    server: { paired: true }
  };

  mark = requests.length;
  const radio4 = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "a station owes nothing -- the due row is a channel's alone",
    radio4 && radio4.due && radio4.due.tiles.length === 0 && radio4.due.pending === 0,
    JSON.stringify(radio4 && radio4.due)
  );
  check(
    "a tuned BBC station shows the programme on air as its headline",
    radio4 && radio4.title === "Loose Ends" && radio4.album === "Stuart Maconie" && radio4.station === "BBC Radio 4",
    JSON.stringify(radio4 && [radio4.title, radio4.album, radio4.station])
  );
  check(
    "and the programme after it as the row",
    radio4.next.length === 1 && radio4.next[0].label === "NEXT" && radio4.next[0].title === "Profile",
    JSON.stringify(radio4.next)
  );
  check(
    "the schedule was fetched from where samo.json pointed, without samo's token",
    served.includes("/bbc/poll") && served.filter((url) => url === "/bbc/poll").length === 1,
    served.join(" ")
  );

  mark = requests.length;
  const stillOn = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "the station record and its schedule are remembered between polls",
    requests.length - mark === 1 && stillOn.next.length === 1,
    requests.slice(mark).join(" ")
  );

  /* ---------------------------------------------------------------- *
   * A cast queue, read straight off the device.
   * ---------------------------------------------------------------- */

  box.state = {
    deviceName: "Living Room",
    mode: "queue",
    status: "playing",
    positionSeconds: 12,
    durationSeconds: 194,
    item: { ref: "track:t-1", title: "Bad Guy", subtitle: "Billie Eilish", kind: "track" },
    queue: [
      { ref: "track:t-1", title: "Bad Guy", subtitle: "Billie Eilish", kind: "track" },
      { ref: "track:t-2", title: "Bury a Friend", subtitle: "Billie Eilish · When We All Fall Asleep", kind: "track" }
    ],
    queueIndex: 0,
    defaultStation: { kind: "channel", id: "jake", name: "Jake Channel" },
    output: { backend: "alsa", open: true },
    server: { paired: true }
  };

  mark = requests.length;
  const queued = await pollNowPlaying(dir, { cache, programmes, covers }, quietLog);

  check(
    "a cast queue's next item needs no request beyond the device list",
    queued && queued.next.length === 1 && queued.next[0].title === "Bury a Friend" && queued.next[0].detail === "Billie Eilish" && requests.length - mark === 1,
    JSON.stringify(queued && queued.next) + " " + requests.slice(mark).join(" ")
  );

  server.close();
}

/*
 * The helper's lifecycle, with no browser anywhere.
 *
 * The case that matters is a server restart while the kiosk keeps running. The
 * browser sends NOW_PLAYING_CONFIG once, when its page loads; a helper that
 * waited for it came back from a restart idle, and the wall kept whatever card
 * it had last been sent. That is what `apt upgrade` did on 2026-09-10 -- twelve
 * hours of the same Keane song.
 */
async function runHelperChecks () {
  console.log("\nNow Playing helper checks\n");

  const playing = {
    deviceName: "Living Room",
    mode: "channel",
    status: "playing",
    channel: {
      id: "jake",
      kind: "channel",
      name: "Jake Channel",
      title: "Bad Guy",
      artist: "Billie Eilish",
      sourceLabel: "Evening rotation"
    },
    output: { backend: "alsa", open: true },
    server: { paired: true }
  };

  const { server } = fakeSamo(playing);
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));

  writeConfig(dir, { baseUrl, token: "test-token", deviceId: "" });

  const title = (message) => message?.payload?.nowPlaying?.title;
  const journal = captureConsole();

  /* A freshly restarted server: start() runs, the browser never speaks. */
  const helper = new NowPlayingHelper();
  helper.defaults = { configDir: dir, pollIntervalMs: 5000 };

  journal.start();
  helper.start();
  await until(() => helper.sent.length >= 1).catch(() => {});
  journal.stop();

  check(
    "the helper starts watching samo on its own, without waiting for the browser",
    helper.sent.length === 1 && title(helper.sent[0]) === "Bad Guy",
    `sent ${helper.sent.length} message(s); first title ${JSON.stringify(title(helper.sent[0]))}`
  );

  /* The kiosk reloads mid-track and asks, with the same config as before. */
  journal.start();
  helper.socketNotificationReceived("NOW_PLAYING_CONFIG", {
    configDir: dir,
    pollIntervalMs: 5000
  });
  await until(() => helper.sent.length >= 2).catch(() => {});
  journal.stop();

  check(
    "a browser that loads mid-track is sent the current card, though nothing changed",
    helper.sent.length === 2 && title(helper.sent[1]) === "Bad Guy",
    `sent ${helper.sent.length} message(s)`
  );
  check(
    "the 'Watching samo' line is logged once, not once per page load",
    journal.lines.filter((line) => line.includes("Watching samo")).length === 1,
    journal.lines.join("\n")
  );

  /* Between polls the identical-payload check still keeps the socket quiet. */
  journal.start();
  await helper.pollNow();
  journal.stop();

  check(
    "an unchanged answer is not re-sent between polls",
    helper.sent.length === 2,
    `sent ${helper.sent.length} message(s)`
  );

  helper.stop();

  /* No samo.json: off, and said so to the browser so it stops asking. */
  const offDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowplaying-check-"));
  const off = new NowPlayingHelper();
  off.defaults = { configDir: offDir, pollIntervalMs: 5000 };

  journal.start();
  off.start();
  journal.stop();

  check(
    "with no samo.json the helper tells the browser there is nothing to show",
    off.sent.length === 1 && off.sent[0].payload.nowPlaying === null,
    `sent ${off.sent.length} message(s)`
  );

  /* Then the token is installed and the kiosk reloaded, as enable-nowplaying.sh does. */
  writeConfig(offDir, { baseUrl, token: "test-token", deviceId: "" });

  journal.start();
  off.socketNotificationReceived("NOW_PLAYING_CONFIG", {
    configDir: offDir,
    pollIntervalMs: 5000
  });
  await until(() => off.sent.length >= 2).catch(() => {});
  journal.stop();

  check(
    "a samo.json installed later is picked up when the browser next asks",
    off.sent.length === 2 && title(off.sent[1]) === "Bad Guy",
    `sent ${off.sent.length} message(s)`
  );

  off.stop();
  server.close();

  for (const scratch of [dir, offDir]) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main () {
  run();
  runUpNextChecks();
  await runFetchChecks();
  await runUpNextFetchChecks();
  await runArtworkChecks();
  await runHelperChecks();

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
