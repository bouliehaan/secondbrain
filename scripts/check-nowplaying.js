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
  isRedundantStationLabel,
  splitArtistTitle
} = require("../modules/NowPlaying/lib/now-playing.js");

const {
  pollNowPlaying,
  createDetailCache
} = require("../modules/NowPlaying/lib/samo-client.js");

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

function fakeSamo (state, { token = "test-token" } = {}) {
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
  const first = await pollNowPlaying(dir, { cache }, quietLog);

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

  /* The same track must not re-walk the catalog every ten seconds. */
  const countBefore = requests.length;
  const second = await pollNowPlaying(dir, { cache }, quietLog);

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

async function main () {
  run();
  await runFetchChecks();

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
