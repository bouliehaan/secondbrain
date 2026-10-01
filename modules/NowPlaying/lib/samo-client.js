"use strict";

const crypto = require("crypto");
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
 * A ceiling on what we are willing to hold for one picture. Cover art that
 * overshoots this is dropped rather than truncated: a card with no picture is
 * fine, a card with half a picture is not.
 *
 * Generous on purpose. The bytes are served to the browser from the artwork
 * store (see createArtworkStore) rather than inlined in the card, so the only
 * thing this bounds is memory -- and the pictures that need the room are
 * real. A feed's cover that is too big for samo's own 5 MB download cap is
 * never kept by samo at all: its cover route redirects to the feed's CDN,
 * where `?width=` means nothing and the original comes back as it is. One
 * show on Jake Channel ships a 7.8 MB PNG that way, and the old 512 KB
 * ceiling threw it away 2,500 times in a fortnight. Chromium draws a picture
 * that size without noticing; the wall has no business refusing it.
 */
const MAX_ARTWORK_BYTES = 16 * 1024 * 1024;

/*
 * How much the artwork store holds altogether, across every picture on the
 * card and in the due row. Most entries are a samo thumbnail of a few tens of
 * kilobytes; the budget is sized so that a handful of the oversized originals
 * described above fit beside them without pushing anything out.
 */
const ARTWORK_STORE_BYTES = 64 * 1024 * 1024;

/* How many resolved artworks to keep. A channel cycles through far fewer than
 * this in a day; the bytes themselves live in the artwork store, and an
 * entry here is a URL into it. */
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

/*
 * A moment samo wrote, as an ISO instant -- or "" when it wrote nothing, or
 * something that is not a date. Samo spells its times RFC 3339 with whatever
 * offset the feed used; one spelling here means the same episode makes the
 * same card whichever it was.
 */
const instantOf = (value) => {
  const parsed = new Date(text(value));

  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
};

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
 * What kind of picture a buffer holds, from its first bytes, as the MIME type
 * the browser would want -- or "" for anything that is not a picture Chromium
 * can draw.
 *
 * The bytes are the truth; the Content-Type header is not. Samo names a
 * stored cover after the extension it guessed from the feed's own header when
 * it downloaded it, and serves anything it did not guess -- a .gif, an .avif,
 * a .bin from a feed that said `image/jpg` or `binary/octet-stream` -- as
 * `application/octet-stream`. That is how a show with a perfectly good cover
 * had none on the wall: the header was believed over the picture, 1,100
 * times in a fortnight. The signatures below are the ones any image decoder
 * checks first, and the same ones the browser would sniff itself if the
 * server's helmet did not forbid it.
 */
function sniffImageType (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return "";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  const head = buffer.subarray(0, 12).toString("latin1");

  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) {
    return "image/gif";
  }

  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") {
    return "image/webp";
  }

  /* ISO base media: a box length, then "ftyp" and the brand. */
  if (head.slice(4, 8) === "ftyp" && /^(avif|avis)$/.test(head.slice(8, 12))) {
    return "image/avif";
  }

  /* An SVG is text: an XML prologue, or the element itself, near the top. */
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
    buffer.subarray(0, 512).toString("utf8")
  )) {
    return "image/svg+xml";
  }

  return "";
}

/*
 * Fetch an image and return its bytes and what kind of picture they are, or
 * say why not.
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
 * credential leak, and they would not want it anyway. A samo path that
 * redirects off the box -- a feed cover samo could not keep -- is followed,
 * and fetch drops the Authorization header at the origin boundary on its own.
 *
 * The picture's type comes from its bytes, never from the response header;
 * see sniffImageType for the show that taught us that.
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

  const failure = (reason) => ({ bytes: null, type: "", reason });

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

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.length === 0) {
      return failure("empty response");
    }

    /*
     * Dropped rather than truncated: a card with no picture is fine, a card
     * with half a picture is not.
     */
    if (bytes.length > MAX_ARTWORK_BYTES) {
      return failure(
        `${bytes.length} bytes is over the ${MAX_ARTWORK_BYTES}-byte ceiling`
      );
    }

    const type = sniffImageType(bytes);

    if (!type) {
      const claimed = text(response.headers.get("content-type")) || "no content-type";

      return failure(`not a picture the browser can draw (served as ${claimed})`);
    }

    return { bytes, type, reason: "" };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return failure(`no answer in ${config.timeoutMs} ms`);
    }

    return failure(error.message);
  }
}

/* Where the browser finds the pictures the helper holds. Served by node_helper. */
const ARTWORK_ROUTE = "/nowplaying/artwork";

/*
 * The pictures the helper has fetched, kept for the browser to load by URL.
 *
 * A card used to carry its cover inline, as a base64 data URI, which put a
 * ceiling on the picture: every byte of it travelled in every notification
 * and sat in the DOM, so anything over half a megabyte was refused -- and
 * some covers are eight. Holding the bytes here and handing the card a URL
 * under ARTWORK_ROUTE lifts that. The token still never reaches the page:
 * the browser asks this process, not samo, and the id is a hash of the
 * picture itself, so nothing on the LAN can make the helper fetch anything.
 *
 * Bounded by bytes, oldest out first, and a picture asked for again moves to
 * the back of the queue. Entries are looked up by the URL the card carries as
 * well as by id, so a cache that still names a picture can check the bytes
 * are here before promising them to the browser -- see artworkAlive.
 */
function createArtworkStore (budget = ARTWORK_STORE_BYTES) {
  const entries = new Map();
  let held = 0;

  const idOf = (url) => {
    const match = new RegExp(`^${ARTWORK_ROUTE}/([0-9a-f]{24})$`).exec(text(url));

    return match ? match[1] : "";
  };

  return {
    /* Keep a picture; answer the URL the browser loads it by. */
    put (bytes, type) {
      const id = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 24);
      const existing = entries.get(id);

      if (existing) {
        /* Freshly wanted: to the back of the queue. */
        entries.delete(id);
        entries.set(id, existing);
        return `${ARTWORK_ROUTE}/${id}`;
      }

      entries.set(id, { bytes, type });
      held += bytes.length;

      while (held > budget && entries.size > 1) {
        const oldest = entries.keys().next().value;

        held -= entries.get(oldest).bytes.length;
        entries.delete(oldest);
      }

      return `${ARTWORK_ROUTE}/${id}`;
    },

    /* The bytes and type behind an id, or null. */
    get (id) {
      return entries.get(text(id)) || null;
    },

    /* Whether a URL the card carries still leads to a picture here. */
    holds (url) {
      return entries.has(idOf(url));
    },

    get size () {
      return entries.size;
    },

    get bytes () {
      return held;
    }
  };
}

/* The store a caller that brought none of its own gets; see pollNowPlaying. */
let fallbackStore = null;

function sharedArtworkStore () {
  if (!fallbackStore) {
    fallbackStore = createArtworkStore();
  }

  return fallbackStore;
}

/*
 * Whether a remembered artwork URL is still good: empty means "no picture",
 * which is always still true; anything else must still be in the store, or
 * the browser would be sent to a 404 and the card would be blank until the
 * cache entry expired.
 */
function artworkAlive (store, url) {
  return !url || store.holds(url);
}

/*
 * Fetch a picture into the store and answer the URL the browser loads it by,
 * or "" with the reason logged by the caller.
 */
async function storeImage (config, store, target) {
  const result = await fetchImage(config, target);

  return {
    url: result.bytes ? store.put(result.bytes, result.type) : "",
    reason: result.reason
  };
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
 *
 * Answers the URL the browser loads the picture by, into `store`, or "".
 */
async function artworkFor (config, rawURL, store, log) {
  const target = text(rawURL);

  if (!target) {
    return "";
  }

  const local = samoPathOf(config, target);
  const foreign =
    /^https?:\/\//i.test(target) && !target.startsWith(`${config.baseUrl}/`);

  let result = { url: "", reason: "" };

  if (local) {
    /*
     * Preserve an existing query rather than assuming there is none: samo tags
     * a relay's fixed cover URL with the identity of the current track, and
     * replacing that with "?width=" would pin the first cover to every song.
     */
    const separator = local.includes("?") ? "&" : "?";

    result = await storeImage(config, store, `${local}${separator}width=${ARTWORK_WIDTH}`);
  }

  /* Only a URL that named some other host is worth a second opinion. */
  if (!result.url && (!local || foreign)) {
    result = await storeImage(config, store, target);
  }

  if (!result.url) {
    /*
     * Samo said there was a picture and the wall could not produce it. That is
     * the one artwork failure worth a line in the journal -- it is a broken
     * URL on samo's side or a limit on this one, and both are fixable once
     * somebody knows. The retry window in decorate keeps this to one line a
     * minute for the same item.
     */
    log.warn(`[NowPlaying] Could not fetch artwork ${target}: ${result.reason}`);
  }

  return result.url;
}

/*
 * Resolve an itemRef into the album line, a cover, and -- for an episode --
 * when it came out.
 *
 * Refs come in four shapes (internal/channels: `track:`, `episode:`, `stream:`
 * and `station:`). The first two are looked up for the album line -- the third
 * line of the card, which exists nowhere else -- so this runs for every new
 * track. An episode's record also says when the feed published it, which the
 * card shows and nothing else carries. The cover is a fallback: samo names
 * the picture itself in the device state, and only when it named nothing is
 * one deduced here. For a track or an episode that is the album's or the
 * show's; for a relayed station it is the station's own cover or logo, which
 * is the least a card for it should show. A `stream:` ref is a bare URL with
 * nothing to look up.
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
      publishedAt: "",
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
      /* When the feed put it out. Absent from a feed that never said. */
      publishedAt: instantOf(episode.publishedAt),
      artworkPath: showId
        ? `/api/v1/podcasts/shows/${encodeURIComponent(showId)}/cover`
        : ""
    };
  }

  if (kind === "station") {
    return {
      album: "",
      artist: "",
      publishedAt: "",
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
 * Fill in the album line, the cover and an episode's release for a card that
 * already knows what is playing.
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
 * `store` is the artwork store the picture's bytes go into and the browser
 * reads them back from; the card carries the URL. `extras.channelNow` is the
 * channel's now-playing document when the caller has already fetched it for
 * the rows under the card; it saves asking twice in one poll and changes
 * nothing else.
 */
async function decorate (config, now, cache, store, log, extras = {}) {
  const cached = cache.get(now.key);

  /*
   * A remembered card is only as good as its picture: the store is bounded
   * separately, and a URL it has since let go of would be a blank frame. That
   * is a miss, and costs one fetch.
   */
  if (cached && artworkAlive(store, cached.artwork)) {
    return { ...now, ...cached };
  }

  const detail = { album: now.album, artwork: "", publishedAt: "" };

  /* The picture we set out to fetch, whoever named it. */
  let wanted = now.artwork;

  if (wanted) {
    detail.artwork = await artworkFor(config, wanted, store, log);
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

        detail.publishedAt = resolved.publishedAt || "";

        if (!wanted && resolved.artworkPath) {
          wanted = resolved.artworkPath;
          detail.artwork = await artworkFor(config, wanted, store, log);
        }
      }
    }
  } else if (now.source === "station" && !wanted && now.sourceId) {
    wanted = await resolveStationArtwork(config, now.sourceId, log);

    if (wanted) {
      detail.artwork = await artworkFor(config, wanted, store, log);
    }
  } else if (now.source === "queue" && text(now.itemRef).startsWith("episode:")) {
    /*
     * An episode cast from a phone arrives with its title, its show and its
     * cover already on the item, and not the one thing the card wants that
     * the item does not carry: when it came out. One lookup per episode,
     * remembered with the rest for as long as it plays.
     */
    const resolved = await resolveRefDetail(config, now.itemRef, log);

    if (resolved) {
      detail.publishedAt = resolved.publishedAt || "";
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
 * A show's cover for the due row, as a URL into the artwork store, or "" --
 * remembered per show rather than per episode, because that is what it is a
 * picture of.
 */
async function showCover (config, podcastId, covers, store, log) {
  const id = text(podcastId);

  if (!id) {
    return "";
  }

  const key = `cover:${id}`;
  const hit = covers.get(key);

  /* A remembered URL the store has since let go of is a miss; see decorate. */
  if (hit && artworkAlive(store, hit.value)) {
    return hit.value;
  }

  const result = await storeImage(
    config,
    store,
    `/api/v1/podcasts/shows/${encodeURIComponent(id)}/cover?width=${DUE_ARTWORK_WIDTH}`
  );

  /*
   * "Samo has no cover for this show" is a fact worth keeping for the day,
   * and the tile shows the show's initials instead. A fetch that failed is
   * not, and gets the same short retry -- and the one line -- a card's
   * artwork does.
   */
  const missing = result.reason === "HTTP 404";

  if (!result.url && !missing) {
    log.warn(`[NowPlaying] Could not fetch the cover of show ${id} for the due row: ${result.reason}`);
  }

  covers.set(key, { value: result.url }, {
    retryAfterMs: result.url || missing ? COVER_TTL_MS : COVER_RETRY_MS
  });

  return result.url;
}

/*
 * The episodes a channel owes, most urgent first, with each show's cover:
 * `{ tiles, pending }`. Two documents that change slowly and are remembered
 * accordingly, then one small picture per show that is remembered for a day.
 */
async function gatherDue (config, channelId, currentRef, programmes, covers, store, log) {
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
    artwork: await showCover(config, tile.podcastId, covers, store, log)
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
   * Where the pictures go. The helper owns one and serves it to the browser;
   * a caller without one shares a store nobody serves, which is fine for a
   * check that only wants the card. Shared rather than fresh per call, because
   * a cache that remembers a URL is only worth having while the store behind
   * it is the same one.
   */
  const artworks = options.artworks || sharedArtworkStore();

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

  const decorated = await decorate(config, now, cache, artworks, log, { channelNow });

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
      artworks,
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
  createArtworkStore,
  sniffImageType,
  ARTWORK_ROUTE,
  ARTWORK_STORE_BYTES,
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
