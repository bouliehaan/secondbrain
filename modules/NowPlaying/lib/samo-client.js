"use strict";

const fs = require("fs");
const path = require("path");

const {
  resolveNowPlaying,
  selectDevice,
  castSource,
  isAudible
} = require("./now-playing");

const {
  resolveUpNext,
  resolveDue,
  scheduleProviderFor,
  parseSchedule,
  describeProgramme,
  channelItemEnd
} = require("./up-next");

/*
 * Talking to samo-server on behalf of the wall.
 *
 * Everything network lives here so `now-playing.js` can stay a pure function of
 * a status snapshot, and so the API token never leaves the server process --
 * see `artworkFor` for why that constraint shapes how pictures get to the
 * browser.
 */

/*
 * samo-server and MagicMirror run on the same box, so the default is loopback.
 * Setting it to the LAN address works too; it just adds a hop for no reason.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:6969";

/*
 * Short by the standards of this repo's other sources, and deliberately so.
 * The mail sources talk to Gmail over the internet and are given two minutes;
 * this one talks to a process on the same machine. If loopback has not answered
 * in six seconds it is not going to, and the next poll is ten seconds away.
 */
const DEFAULT_TIMEOUT_MS = 6000;

/*
 * 256 is the rung of samo-server's thumbnail ladder (64/128/256/384/512/...)
 * that suits a card thumbnail on a 1080p wall. Asking for a width off the
 * ladder is harmless -- the server snaps up, or serves the original -- but
 * asking for the original on every track change is a needless megabyte.
 */
const ARTWORK_WIDTH = 256;

/*
 * A ceiling on what we are willing to inline. Cover art that overshoots this is
 * dropped rather than truncated: a card with no picture is fine, a card with
 * half a picture is not.
 */
const MAX_ARTWORK_BYTES = 512 * 1024;

/* How many resolved artworks to keep. A channel cycles through far fewer than
 * this in a day, and each entry is bounded by MAX_ARTWORK_BYTES. */
const ARTWORK_CACHE_LIMIT = 24;

/*
 * How long to remember that a picture samo named could not be fetched, before
 * asking for it again.
 *
 * "Samo has no picture for this" is worth keeping for as long as the item
 * plays. "The fetch failed" is not: the usual cause is a station's CDN taking
 * seven seconds to answer once, and a station stays tuned for an afternoon
 * under one unchanging key. Remembering that one bad second for the life of
 * the key is how a wall ends up showing NPR with no logo until somebody
 * changes the station.
 */
const ARTWORK_RETRY_MS = 60 * 1000;

/*
 * Where samo's own API lives in URL space. A picture under it is samo's
 * whatever host the URL names, and needs our token: the cover routes sit
 * behind the same login as everything else. See samoPathOf.
 */
const SAMO_API_PREFIX = "/api/v1/";

/*
 * How long each piece of what the "up next" rows are built from stands
 * before it is asked for again. None of it moves fast: a channel's next
 * booked block changes when a block passes, a plan when somebody edits it, a
 * station record when somebody edits that, and a broadcast schedule at the
 * top of the hour. The channel's own now-playing says when the current item
 * ends and is remembered by the item's identity, so it is asked once per
 * track rather than once per poll.
 */
const ITEM_TTL_MS = 60 * 1000;
const PROGRAMME_TTL_MS = 60 * 1000;
const PLAN_TTL_MS = 15 * 60 * 1000;
const STATION_TTL_MS = 15 * 60 * 1000;
const SCHEDULE_TTL_MS = 5 * 60 * 1000;
const SCHEDULE_MIN_TTL_MS = 30 * 1000;

/*
 * A document that names its own boundary -- a now-playing that says when
 * its item ends, a status that says when the next booked block starts -- is
 * stale at that boundary however recently it was read, and is remembered no
 * longer than that (see ttlUntil). This is the least it is remembered for
 * once the boundary is at hand or behind it: samo is on loopback and answers
 * in a millisecond, so asking again on the next poll costs nothing, but a
 * boundary that has just passed while samo is still on the old item must
 * not be asked about in a tight loop either.
 *
 * Without this the wall showed no end -- often no rows at all -- for the
 * first minute of every booked hour: the status remembered from before the
 * cut-in still named the block before and an appointment that had just
 * started, and nothing in it was still ahead.
 */
const BOUNDARY_MIN_TTL_MS = 5 * 1000;

/* A schedule endpoint that failed is left alone for this long. */
const SCHEDULE_RETRY_MS = 60 * 1000;

/*
 * What the channel owes -- the episodes due to play -- moves when a feed
 * drops an episode or one airs, neither of which happens twice a minute; the
 * sources it is read against, like the plan, change when somebody edits them.
 */
const OBLIGATIONS_TTL_MS = 60 * 1000;
const SOURCES_TTL_MS = 15 * 60 * 1000;

/*
 * The covers in the due row are 30px squares, so 64 -- the bottom rung of
 * samo's thumbnail ladder -- is already twice what is drawn. A show's cover
 * is the same picture for every episode it owes and for as long as the show
 * runs, so it is kept for a day; one that did not arrive is asked for again
 * after a minute, for the reasons ARTWORK_RETRY_MS gives.
 */
const DUE_ARTWORK_WIDTH = 64;
const COVER_TTL_MS = 24 * 60 * 60 * 1000;
const COVER_RETRY_MS = 60 * 1000;
const COVER_CACHE_LIMIT = 64;

/*
 * How we introduce ourselves to somebody else's schedule API. The BBC's and
 * NPR's both answer anonymous requests; a name in the log at their end is
 * the least a polite client can do.
 */
const USER_AGENT = "secondbrain-wall/1 (NowPlaying; +https://github.com/bouliehaan/secondbrain)";

const text = (value) =>
  typeof value === "string" ? value.trim() : "";

/**
 * Read the samo credentials.
 *
 * Same convention as every other credential in this project: a JSON file in
 * configDir, real on the mirror and gitignored here, with
 * `config/secondbrain/samo.example.json` as the shape.
 *
 * Returns null when the file is absent, which is not an error -- it is how you
 * turn the module off. A malformed or tokenless file *is* an error, because
 * somebody meant to configure this and it will otherwise fail silently.
 */
function loadSamoConfig (configDir, log = console) {
  const file = path.join(configDir, "samo.json");

  let raw;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    log.error(`[NowPlaying] Could not read ${file}: ${error.message}`);
    return null;
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error(`[NowPlaying] ${file} is not valid JSON: ${error.message}`);
    return null;
  }

  const token = text(parsed.token);

  if (!token) {
    log.error(
      `[NowPlaying] ${file} has no "token". Create an API token in samo and ` +
      "put it there; without one every request comes back 401."
    );
    return null;
  }

  return {
    baseUrl: (text(parsed.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    token,
    /* Empty means "work it out" -- see selectDevice. */
    deviceId: text(parsed.deviceId),
    timeoutMs: Math.max(1000, Number(parsed.timeoutMs) || DEFAULT_TIMEOUT_MS),
    /*
     * Which internet stations publish a schedule, and where. Optional: the
     * BBC is recognised from its stream URL with nothing here. See
     * scheduleProviderFor in up-next.js for the shape.
     */
    schedules: parsed.schedules && typeof parsed.schedules === "object"
      ? parsed.schedules
      : {}
  };
}

/*
 * A GET against the samo API returning parsed JSON, or null on any failure.
 *
 * Null rather than throw: every call site here has a sensible answer for "could
 * not find out" (skip the artwork, skip the album, show nothing), and a poll
 * that throws on a missing cover would take the whole card down over a
 * decoration.
 */
async function getJSON (config, apiPath, log) {
  const url = `${config.baseUrl}${apiPath}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (response.status === 401 || response.status === 403) {
      log.error(
        "[NowPlaying] samo rejected the API token (HTTP " +
        `${response.status}). Check "token" in samo.json.`
      );
      return null;
    }

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    /*
     * Connection refused is the ordinary state of affairs when samo-server is
     * restarting or simply not running, and logging it every ten seconds would
     * bury everything else in the journal. The caller logs the transition.
     */
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return null;
    }

    if (error.cause?.code === "ECONNREFUSED") {
      return null;
    }

    log.error(`[NowPlaying] GET ${apiPath} failed: ${error.message}`);
    return null;
  }
}

/*
 * A GET against somebody else's JSON -- a broadcaster's schedule -- with no
 * credential of ours on it. Null on any failure, for the same reason as
 * getJSON: a schedule is a decoration on the card, never load-bearing.
 */
async function getExternalJSON (url, timeoutMs, log) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      log.warn(`[NowPlaying] Schedule ${url} answered HTTP ${response.status}.`);
      return null;
    }

    return await response.json();
  } catch (error) {
    const reason = error.name === "TimeoutError" || error.name === "AbortError"
      ? `no answer in ${timeoutMs} ms`
      : error.message;

    log.warn(`[NowPlaying] Schedule ${url} failed: ${reason}`);
    return null;
  }
}

/*
 * Fetch an image and return it as a data URI, or say why not.
 *
 * The bytes are pulled here, in the server process, rather than letting the
 * browser load the URL directly. Two reasons, and the first is the important
 * one:
 *
 *   - The API token would have to reach the browser to sign an <img src>, and
 *     the kiosk page is served to anything on the LAN that asks. samo has a
 *     `stream_token` query parameter for exactly this, but it still puts a
 *     credential in a URL in a page, and there is no need: this process already
 *     has the token and can hand over finished pixels.
 *   - MagicMirror's page and samo-server are different origins, so a direct
 *     load is a CORS conversation nobody needs to have.
 *
 * A samo-relative path is fetched from baseUrl with the token. An absolute URL
 * is somebody else's server -- a station's logo on its own CDN -- and gets no
 * Authorization header: sending samo's token to a third party would be a
 * credential leak, and they would not want it anyway.
 *
 * Failure is a `reason` rather than a throw or a bare null: every caller has a
 * sensible answer for "no picture", but the journal deserves to know why the
 * picture samo promised did not arrive.
 */
async function fetchImage (config, target) {
  const ours = target.startsWith("/");
  const url = ours ? `${config.baseUrl}${target}` : target;
  const headers = { Accept: "image/*" };

  if (ours) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const failure = (reason) => ({ dataUri: "", reason });

  try {
    const response = await fetch(url, {
      headers,
      /* Covers may redirect out to a remote URL the metadata layer supplied. */
      redirect: "follow",
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!response.ok) {
      return failure(`HTTP ${response.status}`);
    }

    const type = text(response.headers.get("content-type")) || "image/jpeg";

    if (!type.startsWith("image/")) {
      return failure(`not an image (${type})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0) {
      return failure("empty response");
    }

    /*
     * Dropped rather than truncated: a card with no picture is fine, a card
     * with half a picture is not.
     */
    if (buffer.length > MAX_ARTWORK_BYTES) {
      return failure(
        `${buffer.length} bytes is over the ${MAX_ARTWORK_BYTES}-byte ceiling`
      );
    }

    return { dataUri: `data:${type};base64,${buffer.toString("base64")}`, reason: "" };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return failure(`no answer in ${config.timeoutMs} ms`);
    }

    return failure(error.message);
  }
}

/*
 * What the channel's scheduler says is on, which is the only place an itemRef
 * exists. The device's own status carries title and artist but not the
 * catalog id, and without the id there is no album and no cover.
 */
async function channelItemRef (config, channelId, log) {
  const now = await getJSON(
    config,
    `/api/v1/channels/${encodeURIComponent(channelId)}/now`,
    log
  );

  return {
    ref: text(now?.current?.itemRef),
    sourceLabel: text(now?.current?.sourceLabel)
  };
}

/*
 * The samo-relative path of an artwork URL, or "" when the picture is somebody
 * else's.
 *
 * Samo hands out its own pictures in two spellings. A channel item carries a
 * bare path ("/api/v1/media/covers/x/image"), because the scheduler refuses to
 * guess the server's public address. A station's uploaded cover arrives
 * absolute, built from whatever address the radio daemon paired through --
 * the LAN address, typically, while this process talks over loopback.
 * Matching on the origin would call that URL foreign, fetch it without the
 * token, and get a 401 for samo's own picture. Matching on the API prefix
 * recognises it however the host is spelled.
 */
function samoPathOf (config, target) {
  if (target.startsWith("/")) {
    return target;
  }

  if (target.startsWith(`${config.baseUrl}/`)) {
    return target.slice(config.baseUrl.length);
  }

  let parsed;

  try {
    parsed = new URL(target);
  } catch (error) {
    return "";
  }

  return parsed.pathname.startsWith(SAMO_API_PREFIX)
    ? `${parsed.pathname}${parsed.search}`
    : "";
}

/*
 * Fetch whatever picture samo has already chosen for what is playing.
 *
 * Samo's own paths are asked for at a thumbnail width, because the server
 * resizes and sending a wall a full-size cover every track change is a
 * needless megabyte. Anything else belongs to somebody else's server, which
 * knows nothing about our width parameter and is fetched untouched -- and
 * without our token, which is not theirs to have.
 *
 * A URL that merely LOOKS like samo's -- some station's bridge that happens to
 * publish under /api/v1/ -- gets one try through samo, which answers 404 in a
 * millisecond over loopback, and is then fetched as the outsider it is. The
 * token only ever travels to baseUrl either way.
 */
async function artworkFor (config, rawURL, log) {
  const target = text(rawURL);

  if (!target) {
    return "";
  }

  const local = samoPathOf(config, target);
  const foreign =
    /^https?:\/\//i.test(target) && !target.startsWith(`${config.baseUrl}/`);

  let result = { dataUri: "", reason: "" };

  if (local) {
    /*
     * Preserve an existing query rather than assuming there is none: samo tags
     * a relay's fixed cover URL with the identity of the current track, and
     * replacing that with "?width=" would pin the first cover to every song.
     */
    const separator = local.includes("?") ? "&" : "?";

    result = await fetchImage(config, `${local}${separator}width=${ARTWORK_WIDTH}`);
  }

  /* Only a URL that named some other host is worth a second opinion. */
  if (!result.dataUri && (!local || foreign)) {
    result = await fetchImage(config, target);
  }

  if (!result.dataUri) {
    /*
     * Samo said there was a picture and the wall could not produce it. That is
     * the one artwork failure worth a line in the journal -- it is a broken
     * URL on samo's side or a limit on this one, and both are fixable once
     * somebody knows. The retry window in decorate keeps this to one line a
     * minute for the same item.
     */
    log.warn(`[NowPlaying] Could not fetch artwork ${target}: ${result.reason}`);
  }

  return result.dataUri;
}

/*
 * Resolve an itemRef into the album line and a cover.
 *
 * Refs come in four shapes (internal/channels: `track:`, `episode:`, `stream:`
 * and `station:`). The first two are looked up for the album line -- the third
 * line of the card, which exists nowhere else -- so this runs for every new
 * track. The cover is a fallback: samo names the picture itself in the device
 * state, and only when it named nothing is one deduced here. For a track or an
 * episode that is the album's or the show's; for a relayed station it is the
 * station's own cover or logo, which is the least a card for it should show.
 * A `stream:` ref is a bare URL with nothing to look up.
 */
async function resolveRefDetail (config, ref, log) {
  const [kind, ...rest] = ref.split(":");
  const id = rest.join(":");

  if (!id) {
    return null;
  }

  if (kind === "track") {
    const track = await getJSON(
      config,
      `/api/v1/music/tracks/${encodeURIComponent(id)}`,
      log
    );

    if (!track) {
      return null;
    }

    const albumId = text(track.albumId);

    return {
      album: text(track.albumTitle),
      artist: text(track.displayArtist),
      artworkPath: albumId
        ? `/api/v1/music/albums/${encodeURIComponent(albumId)}/cover`
        : ""
    };
  }

  if (kind === "episode") {
    const episode = await getJSON(
      config,
      `/api/v1/podcasts/episodes/${encodeURIComponent(id)}`,
      log
    );

    if (!episode) {
      return null;
    }

    const showId = text(episode.podcastId);

    return {
      /* The show is the "album" of a podcast -- same slot, same meaning. */
      album: text(episode.podcastTitle),
      artist: "",
      artworkPath: showId
        ? `/api/v1/podcasts/shows/${encodeURIComponent(showId)}/cover`
        : ""
    };
  }

  if (kind === "station") {
    return {
      album: "",
      artist: "",
      artworkPath: await resolveStationArtwork(config, id, log)
    };
  }

  return null;
}

/*
 * An internet station's own logo, for a samo old enough not to name it in the
 * device state.
 *
 * Stations carry either a cover uploaded into samo or an external logo URL from
 * the directory. The uploaded one is preferred: it is local, it is already the
 * right shape, and it does not depend on somebody else's CDN being up. It
 * arrives as an absolute URL of samo's own, which artworkFor knows to fetch
 * with the token.
 */
async function resolveStationArtwork (config, stationId, log) {
  const station = await getJSON(
    config,
    `/api/v1/internet-radio/stations/${encodeURIComponent(stationId)}`,
    log
  );

  if (!station) {
    return "";
  }

  return text(station.coverUrl) || text(station.imageUrl);
}

/*
 * A tiny bounded cache of resolved artwork and album lines, keyed by the
 * now-playing identity.
 *
 * Without it a three-minute track costs eighteen redundant round trips through
 * the track lookup and the cover endpoint. Insertion-ordered, oldest evicted --
 * a Map iterates in insertion order, which is all the LRU this needs.
 *
 * An entry stored with `retryAfterMs` is a remembered failure: it answers like
 * any other until that long has passed, then counts as a miss so the picture
 * is asked for again. `clock` exists so the checks can move time without
 * waiting for it.
 */
function createDetailCache (limit = ARTWORK_CACHE_LIMIT, clock = Date.now) {
  const entries = new Map();

  return {
    get (key) {
      const entry = entries.get(key);

      if (!entry) {
        return null;
      }

      if (entry.retryAt && clock() >= entry.retryAt) {
        entries.delete(key);
        return null;
      }

      return entry.value;
    },

    set (key, value, { retryAfterMs = 0 } = {}) {
      if (entries.has(key)) {
        entries.delete(key);
      }

      entries.set(key, {
        value,
        retryAt: retryAfterMs > 0 ? clock() + retryAfterMs : 0
      });

      while (entries.size > limit) {
        entries.delete(entries.keys().next().value);
      }
    }
  };
}

/*
 * Fill in the album line and the cover for a card that already knows what is
 * playing.
 *
 * Deliberately additive: `now` is already complete and showable before this
 * runs, and every failure in here leaves it that way. Nothing here is allowed
 * to be load-bearing.
 *
 * The picture is samo's call, not ours. It has already decided what
 * illustrates the item -- the cover of the song, the show, the track a relayed
 * station is playing, or failing all of that the station's own logo -- and
 * named it in the device state as `now.artwork`. This function's job is to
 * turn that name into bytes the browser can show without holding a
 * credential. The lookups further down only run when samo named nothing,
 * which a current samo never does; they are there for a daemon or server old
 * enough to predate the field, and they deduce what they can from the item
 * ref, which for a relayed station is nothing.
 *
 * `extras.channelNow` is the channel's now-playing document when the caller
 * has already fetched it for the rows under the card; it saves asking twice
 * in one poll and changes nothing else.
 */
async function decorate (config, now, cache, log, extras = {}) {
  const cached = cache.get(now.key);

  if (cached) {
    return { ...now, ...cached };
  }

  const detail = { album: now.album, artwork: "" };

  /* The picture we set out to fetch, whoever named it. */
  let wanted = now.artwork;

  if (wanted) {
    detail.artwork = await artworkFor(config, wanted, log);
  }

  /*
   * Drop an album that only repeats a line the card already shows.
   *
   * Podcasts do this every time: the show name is both what the channel
   * streamer reports as the artist and what the catalog calls the parent, so
   * "Comedy Bang Bang: The Podcast · Comedy Bang Bang: The Podcast" is the
   * unguarded result. An album is a third line worth having only when it says
   * something the first two did not.
   */
  const redundantAlbum = (album) => {
    const value = text(album).toLowerCase();

    if (!value) {
      return true;
    }

    return (
      value === text(now.artist).toLowerCase() ||
      value === text(now.title).toLowerCase() ||
      value === text(now.station).toLowerCase()
    );
  };

  if (now.source === "channel" && now.sourceId) {
    const ref = extras.channelNow && typeof extras.channelNow === "object"
      ? text(extras.channelNow.current?.itemRef)
      : (await channelItemRef(config, now.sourceId, log)).ref;

    if (ref) {
      const resolved = await resolveRefDetail(config, ref, log);

      if (resolved) {
        detail.album = resolved.album || detail.album;

        /*
         * The catalog's artist is better than the streamer's label when the
         * streamer left it blank, and identical otherwise.
         */
        if (!now.artist && resolved.artist) {
          detail.artist = resolved.artist;
        }

        if (redundantAlbum(detail.album)) {
          detail.album = "";
        }

        if (!wanted && resolved.artworkPath) {
          wanted = resolved.artworkPath;
          detail.artwork = await artworkFor(config, wanted, log);
        }
      }
    }
  } else if (now.source === "station" && !wanted && now.sourceId) {
    wanted = await resolveStationArtwork(config, now.sourceId, log);

    if (wanted) {
      detail.artwork = await artworkFor(config, wanted, log);
    }
  }

  /*
   * Cache even the empty result: "this has no picture" is worth remembering
   * for the three minutes it plays, and re-deciding it every ten seconds is
   * the thing the cache exists to stop. A picture that exists and did not
   * arrive is a different fact, and is remembered only briefly -- see
   * ARTWORK_RETRY_MS.
   */
  const failed = Boolean(wanted) && !detail.artwork;

  cache.set(now.key, detail, { retryAfterMs: failed ? ARTWORK_RETRY_MS : 0 });

  return { ...now, ...detail };
}

/*
 * What samo-server knows about the station or channel a cast queue item is
 * playing, or null when the item is a catalog item or samo could not say.
 *
 * Asked on every poll while a cast source plays, not once per item: the whole
 * point is what the source is airing NOW, which moves while the device's own
 * report of the item stays "Elvis Radio" for the afternoon. One small JSON over
 * loopback every ten seconds is what a tuned source costs the daemon anyway.
 * Null degrades to the bare queue card, never to no card.
 */
async function castLookup (config, state, log) {
  if (
    text(state?.mode).toLowerCase() !== "queue" ||
    !isAudible(text(state?.status).toLowerCase())
  ) {
    return null;
  }

  const cast = castSource(state.item);

  if (!cast) {
    return null;
  }

  if (cast.kind === "channel") {
    const now = await getJSON(
      config,
      `/api/v1/channels/${encodeURIComponent(cast.id)}/now`,
      log
    );

    return now ? { kind: "channel", now } : null;
  }

  const station = await getJSON(
    config,
    `/api/v1/internet-radio/stations/${encodeURIComponent(cast.id)}`,
    log
  );

  return station ? { kind: "station", station } : null;
}

/* ---------------------------------------------------------------------- *
 * What the rows under the card are built from.
 *
 * Everything here is remembered for a while in `programmes`, a second
 * detail cache, because none of it changes between one poll and the next
 * and all of it costs somebody a request. An entry is stored wrapped, as
 * `{ value }`, so that "we asked and there was nothing" is remembered too
 * and is not mistaken for "we have not asked".
 * ---------------------------------------------------------------------- */

/*
 * How long to remember a document that is good for `ttlMs`, or until the
 * boundary it names -- whichever is sooner, and never less than the floor.
 * No boundary, or one that is not a moment, leaves the full life.
 */
function ttlUntil (ttlMs, boundaryMs, now = Date.now(), floorMs = BOUNDARY_MIN_TTL_MS) {
  const boundary = Number(boundaryMs) || 0;

  if (boundary <= 0) {
    return ttlMs;
  }

  return Math.min(ttlMs, Math.max(floorMs, boundary - now));
}

/*
 * `staleAt`, given, is asked of a freshly fetched value for the instant it
 * stops being true -- the item's end, the next block's start -- and the
 * value is remembered no longer than that.
 */
async function remembered (programmes, key, ttlMs, fetchValue, { failedTtlMs = ttlMs, staleAt = null } = {}) {
  const hit = programmes.get(key);

  if (hit) {
    return hit.value;
  }

  const value = await fetchValue();

  const ttl = value === null
    ? failedTtlMs
    : staleAt ? ttlUntil(ttlMs, staleAt(value)) : ttlMs;

  programmes.set(key, { value }, { retryAfterMs: ttl });

  return value;
}

/*
 * A station's schedule, if anyone publishes one for it: `{ now, next }` or
 * null. The provider is worked out from the station record and samo.json;
 * the document is asked for at most every few minutes, and sooner only when
 * the programme on air is about to end.
 */
async function stationSchedule (config, station, programmes, log) {
  const found = scheduleProviderFor(station, config.schedules);

  if (!found) {
    return null;
  }

  const key = `schedule:${found.provider}:${found.id}`;
  const hit = programmes.get(key);

  if (hit) {
    return hit.value;
  }

  const document = await getExternalJSON(found.url, config.timeoutMs, log);
  const now = Date.now();
  const parsed = document ? parseSchedule(found.provider, document, now) : null;

  /*
   * Ask again when the programme on air ends -- or, between programmes, when
   * the next one starts -- or in a few minutes, whichever is sooner; but not
   * so soon after an ending that a schedule still showing the finished
   * programme is fetched every poll.
   */
  let ttl = SCHEDULE_TTL_MS;
  const ends = Number(parsed?.now?.end) || 0;
  const starts = Number(parsed?.next?.start) || 0;
  const boundary = ends > now ? ends : starts > now ? starts : 0;

  if (boundary) {
    ttl = Math.min(ttl, Math.max(SCHEDULE_MIN_TTL_MS, boundary - now));
  } else if (parsed) {
    ttl = SCHEDULE_MIN_TTL_MS;
  }

  programmes.set(key, { value: parsed }, { retryAfterMs: document ? ttl : SCHEDULE_RETRY_MS });

  return parsed;
}

/*
 * A show's cover for the due row, as a small data URI, or "" -- remembered
 * per show rather than per episode, because that is what it is a picture of.
 */
async function showCover (config, podcastId, covers, log) {
  const id = text(podcastId);

  if (!id) {
    return "";
  }

  const key = `cover:${id}`;
  const hit = covers.get(key);

  if (hit) {
    return hit.value;
  }

  const result = await fetchImage(
    config,
    `/api/v1/podcasts/shows/${encodeURIComponent(id)}/cover?width=${DUE_ARTWORK_WIDTH}`
  );

  /*
   * "Samo has no cover for this show" is a fact worth keeping for the day,
   * and the tile shows the show's initials instead. A fetch that failed is
   * not, and gets the same short retry -- and the one line -- a card's
   * artwork does.
   */
  const missing = result.reason === "HTTP 404";

  if (!result.dataUri && !missing) {
    log.warn(`[NowPlaying] Could not fetch the cover of show ${id} for the due row: ${result.reason}`);
  }

  covers.set(key, { value: result.dataUri }, {
    retryAfterMs: result.dataUri || missing ? COVER_TTL_MS : COVER_RETRY_MS
  });

  return result.dataUri;
}

/*
 * The episodes a channel owes, most urgent first, with each show's cover:
 * `{ tiles, pending }`. Two documents that change slowly and are remembered
 * accordingly, then one small picture per show that is remembered for a day.
 */
async function gatherDue (config, channelId, currentRef, programmes, covers, log) {
  const encoded = encodeURIComponent(channelId);

  const fetchSources = () => getJSON(config, `/api/v1/channels/${encoded}/sources`, log);

  const [obligations, sources] = await Promise.all([
    remembered(programmes, `obligations:${channelId}`, OBLIGATIONS_TTL_MS, () =>
      getJSON(config, `/api/v1/channels/${encoded}/obligations`, log)),
    remembered(programmes, `sources:${channelId}`, SOURCES_TTL_MS, fetchSources)
  ]);

  let due = resolveDue({ obligations, sources, currentRef });

  /*
   * An owed episode from a show the remembered sources do not list is a show
   * subscribed since they were read -- its first episode, at the front of
   * the row with no cover and no name. Read the sources again, at the
   * obligations' own cadence so a source samo has since deleted costs one
   * request a minute rather than one a poll.
   */
  if (due.tiles.some((tile) => !tile.known)) {
    const fresh = await remembered(programmes, `sources:fresh:${channelId}`, OBLIGATIONS_TTL_MS, fetchSources);

    if (fresh) {
      programmes.set(`sources:${channelId}`, { value: fresh }, { retryAfterMs: SOURCES_TTL_MS });
      due = resolveDue({ obligations, sources: fresh, currentRef });
    }
  }

  const tiles = await Promise.all(due.tiles.map(async (tile) => ({
    ...tile,
    artwork: await showCover(config, tile.podcastId, covers, log)
  })));

  return { tiles, pending: due.pending };
}

/*
 * The channel's own now-playing for the card on air -- GET
 * /channels/{id}/now -- remembered for as long as the item plays.
 *
 * Once per item, not once per key: the key is the card's, and the card is
 * the same when a booked hour of KRCC hands over to another, or when the
 * channel is between items and shows its own name. So the document is
 * remembered no longer than the item's own end -- the moment samo said the
 * item would give way, or, from a samo old enough not to say, the end of
 * its measured length -- and the next poll after that asks again. Without
 * that the wall kept the previous item's end, already behind it, for up to
 * a minute of the next.
 */
async function channelNowFor (config, now, programmes, log) {
  return remembered(programmes, `now:${now.key}`, ITEM_TTL_MS, () =>
    getJSON(config, `/api/v1/channels/${encodeURIComponent(now.sourceId)}/now`, log), {
    staleAt: (value) => channelItemEnd({ now: value }).at
  });
}

/*
 * Gather what "up next" needs for this card: the channel's programme, or the
 * station's schedule, as far as either is knowable.
 *
 * `known` is what the poll already fetched -- a cast lookup, the channel's
 * now-playing -- so nothing is asked for twice. Returns `{ programme,
 * schedule, station }`, any of which may be null; a station is the relayed
 * or tuned station's record, for the card to name its programme by.
 */
async function gatherUpNext (config, now, known, programmes, log) {
  const out = { programme: null, schedule: null, station: null };
  const id = text(now.sourceId);

  if (now.source === "channel" && id) {
    const encoded = encodeURIComponent(id);

    /*
     * The status is good for a minute, or until the next booked block
     * starts: from that moment it names the block before and an appointment
     * already begun, and the rows built from it are empty.
     */
    const [status, plan] = await Promise.all([
      remembered(programmes, `status:${id}`, PROGRAMME_TTL_MS, () =>
        getJSON(config, `/api/v1/channels/${encoded}/schedule/status`, log), {
        staleAt: (value) => Date.parse(text(value?.programming?.nextAnchor?.start)) || 0
      }),
      remembered(programmes, `plan:${id}`, PLAN_TTL_MS, () =>
        getJSON(config, `/api/v1/channels/${encoded}/plan`, log))
    ]);

    out.programme = { status, plan, now: known.channelNow || null };

    /*
     * A block relaying an internet station -- the KRCC hour -- is that
     * station's programme for the length of the block, and the station may
     * publish what that is.
     */
    const ref = text(known.channelNow?.current?.itemRef).match(/^station:(.+)$/);

    if (ref) {
      out.station = await remembered(programmes, `station:${ref[1]}`, STATION_TTL_MS, () =>
        getJSON(config, `/api/v1/internet-radio/stations/${encodeURIComponent(ref[1])}`, log));
    }
  } else if (now.source === "station" && id) {
    out.station = known.cast?.kind === "station" && known.cast.station
      ? known.cast.station
      : await remembered(programmes, `station:${id}`, STATION_TTL_MS, () =>
        getJSON(config, `/api/v1/internet-radio/stations/${encodeURIComponent(id)}`, log));
  }

  if (out.station) {
    out.schedule = await stationSchedule(config, out.station, programmes, log);
  }

  return out;
}

/**
 * Ask samo-server what the radio is playing, and build the card.
 *
 * Returns null for every "nothing to show" case there is -- unconfigured,
 * unreachable, no device, device idle -- because they are all the same to the
 * wall, which simply does not draw the card.
 *
 * With `options.upNext` (the default) the card carries `next`: the rows
 * under it, from resolveUpNext. Pass false to leave them off and skip the
 * requests that build them.
 */
async function pollNowPlaying (configDir, options = {}, log = console) {
  const config = options.config || loadSamoConfig(configDir, log);

  if (!config) {
    return null;
  }

  const devices = await getJSON(config, "/api/v1/samo-radio/devices", log);

  /*
   * Whether samo-server answered at all is a different fact from whether
   * anything is playing, and the wall's status line wants the first one. A
   * caller that passes `options.status` gets it written there; the return
   * value stays "the card or null" as before.
   */
  if (options.status && typeof options.status === "object") {
    options.status.reachable = devices !== null;
  }

  if (!devices) {
    return null;
  }

  /* The list endpoint has been seen paginated elsewhere in this API; accept
   * both shapes rather than depending on which one this route uses. */
  const list = Array.isArray(devices)
    ? devices
    : Array.isArray(devices.items)
      ? devices.items
      : [];

  const device = selectDevice(list, config.deviceId);

  if (!device) {
    return null;
  }

  /*
   * A device Samo could not reach lists with no state and a lastError. That is
   * a real condition -- the box is off, or off the network -- and the honest
   * rendering of it is no card.
   */
  if (!device.state) {
    return null;
  }

  const cast = await castLookup(config, device.state, log);

  const now = resolveNowPlaying(device.state, {
    deviceName: device.name,
    cast
  });

  if (!now) {
    return null;
  }

  const cache = options.cache || createDetailCache();
  const programmes = options.programmes || createDetailCache();
  const upNext = options.upNext !== false;

  /*
   * A tuned channel's now-playing says when its current item ends, which is
   * a row under the card; a cast channel's was fetched by the lookup above.
   * Asked once per item -- see channelNowFor -- and handed on to the
   * decoration so the album lookup does not ask for it again.
   */
  let channelNow = cast?.kind === "channel" ? cast.now : null;

  if (upNext && now.source === "channel" && now.sourceId && !channelNow) {
    channelNow = await channelNowFor(config, now, programmes, log);
  }

  const decorated = await decorate(config, now, cache, log, { channelNow });

  if (!upNext) {
    return { ...decorated, next: [], due: { tiles: [], pending: 0 } };
  }

  const known = await gatherUpNext(config, decorated, { channelNow, cast }, programmes, log);

  /* What the channel owes -- a channel's alone; a queue and a station owe nothing. */
  const due = decorated.source === "channel" && decorated.sourceId
    ? await gatherDue(
      config,
      decorated.sourceId,
      text(channelNow?.current?.itemRef),
      programmes,
      options.covers || createDetailCache(COVER_CACHE_LIMIT),
      log
    )
    : { tiles: [], pending: 0 };

  return {
    ...decorated,
    ...describeProgramme(decorated, known.schedule, known.station?.name),
    next: resolveUpNext({
      now: decorated,
      state: device.state,
      programme: known.programme,
      schedule: known.schedule
    }),
    due
  };
}

module.exports = {
  pollNowPlaying,
  loadSamoConfig,
  createDetailCache,
  decorate,
  gatherUpNext,
  gatherDue,
  channelNowFor,
  stationSchedule,
  ttlUntil,
  BOUNDARY_MIN_TTL_MS,
  ITEM_TTL_MS,
  PROGRAMME_TTL_MS,
  COVER_CACHE_LIMIT,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  ARTWORK_WIDTH,
  MAX_ARTWORK_BYTES,
  ARTWORK_RETRY_MS
};
