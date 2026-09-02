"use strict";

const fs = require("fs");
const path = require("path");

const { resolveNowPlaying, selectDevice } = require("./now-playing");

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
    timeoutMs: Math.max(1000, Number(parsed.timeoutMs) || DEFAULT_TIMEOUT_MS)
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
 * Fetch an image and return it as a data URI.
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
 */
async function getImageDataUri (config, apiPath, log) {
  const url = `${config.baseUrl}${apiPath}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "image/*"
      },
      /* Covers may redirect out to a remote URL the metadata layer supplied. */
      redirect: "follow",
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!response.ok) {
      return null;
    }

    const type = text(response.headers.get("content-type")) || "image/jpeg";

    if (!type.startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0 || buffer.length > MAX_ARTWORK_BYTES) {
      return null;
    }

    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (error) {
    return null;
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
 * Fetch whatever picture samo has already chosen for what is playing.
 *
 * Two shapes arrive here. A samo-relative path ("/api/v1/...") is asked for at
 * a thumbnail width, because the server resizes and sending a wall a full-size
 * cover every track change is a needless megabyte. An absolute URL belongs to
 * somebody else's server, which knows nothing about our width parameter and is
 * fetched untouched -- and without our token, which is not theirs to have.
 */
async function artworkFor (config, rawURL, log) {
  const target = text(rawURL);

  if (!target) {
    return "";
  }

  if (/^https?:\/\//i.test(target)) {
    if (target.startsWith(config.baseUrl)) {
      return getImageDataUri(config, target.slice(config.baseUrl.length), log);
    }

    return getExternalImageDataUri(config, target);
  }

  /*
   * Preserve an existing query rather than assuming there is none: samo tags a
   * relay's fixed cover URL with the identity of the current track, and
   * replacing that with "?width=" would pin the first cover to every song.
   */
  const separator = target.includes("?") ? "&" : "?";

  return getImageDataUri(config, `${target}${separator}width=${ARTWORK_WIDTH}`, log);
}

/*
 * Resolve an itemRef into the album line and a cover.
 *
 * Refs come in four shapes (internal/channels: `track:`, `episode:`, `stream:`
 * and `station:`). Only the first two are looked up here, and only for the
 * album line -- the third line of the card, which exists nowhere else.
 *
 * Pictures no longer come from this path at all. Samo resolves artwork for
 * every kind of item before it leaves the server, including the two live ones
 * this function still declines: a relayed station has no catalog row to find a
 * cover in, which is exactly why deducing it from a ref could never work.
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
        ? `/api/v1/music/albums/${encodeURIComponent(albumId)}` +
          `/cover?width=${ARTWORK_WIDTH}`
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
        ? `/api/v1/podcasts/shows/${encodeURIComponent(showId)}` +
          `/cover?width=${ARTWORK_WIDTH}`
        : ""
    };
  }

  return null;
}

/*
 * An internet station's own logo, used when there is no track to illustrate.
 *
 * Stations carry either a cover uploaded into samo or an external logo URL from
 * the directory. The uploaded one is preferred: it is local, it is already the
 * right shape, and it does not depend on somebody else's CDN being up.
 */
async function resolveStationArtwork (config, stationId, log) {
  const station = await getJSON(
    config,
    `/api/v1/internet-radio/stations/${encodeURIComponent(stationId)}`,
    log
  );

  if (!station) {
    return null;
  }

  const coverUrl = text(station.coverUrl);
  const imageUrl = text(station.imageUrl);

  if (coverUrl) {
    return coverUrl.startsWith("http")
      ? { absolute: coverUrl }
      : { path: coverUrl };
  }

  if (imageUrl) {
    return { absolute: imageUrl };
  }

  return null;
}

/*
 * An image from somewhere that is not samo -- a station's logo on its own CDN.
 * Same data-URI treatment, but no Authorization header: sending samo's token to
 * a third party would be a credential leak, and they would not want it anyway.
 */
async function getExternalImageDataUri (config, url) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(config.timeoutMs)
    });

    if (!response.ok) {
      return null;
    }

    const type = text(response.headers.get("content-type")) || "image/jpeg";

    if (!type.startsWith("image/")) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0 || buffer.length > MAX_ARTWORK_BYTES) {
      return null;
    }

    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (error) {
    return null;
  }
}

/*
 * A tiny bounded cache of resolved artwork and album lines, keyed by the
 * now-playing identity.
 *
 * Without it a three-minute track costs eighteen redundant round trips through
 * the track lookup and the cover endpoint. Insertion-ordered, oldest evicted --
 * a Map iterates in insertion order, which is all the LRU this needs.
 */
function createDetailCache (limit = ARTWORK_CACHE_LIMIT) {
  const entries = new Map();

  return {
    get (key) {
      return entries.get(key) || null;
    },

    set (key, value) {
      if (entries.has(key)) {
        entries.delete(key);
      }

      entries.set(key, value);

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
 * runs, and every failure in here leaves it that way. Artwork is the part of
 * this feature most likely to be missing -- a station with no logo, a track
 * whose album has no embedded art, a relayed stream that is not in the catalog
 * at all -- so none of it is allowed to be load-bearing.
 */
async function decorate (config, now, device, cache, log) {
  const cached = cache.get(now.key);

  if (cached) {
    return { ...now, ...cached };
  }

  const detail = { album: now.album, artwork: "" };
  const channel = device?.state?.channel;

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

  if (now.source === "channel" && text(channel?.id)) {
    const { ref } = await channelItemRef(config, text(channel.id), log);

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

        if (resolved.artworkPath) {
          detail.artwork =
            (await getImageDataUri(config, resolved.artworkPath, log)) || "";
        }
      }
    }
  } else if (now.source === "station" && text(channel?.id)) {
    const artwork = await resolveStationArtwork(config, text(channel.id), log);

    if (artwork?.path) {
      detail.artwork =
        (await getImageDataUri(config, artwork.path, log)) || "";
    } else if (artwork?.absolute) {
      detail.artwork =
        (await getExternalImageDataUri(config, artwork.absolute)) || "";
    }
  } else if (now.source === "queue") {
    /*
     * Cast items arrive fully resolved -- the API layer built the absolute
     * artwork URL when it handed the queue to the device -- so there is nothing
     * to look up, only to fetch.
     */
    const artworkUrl = text(device?.state?.item?.artworkUrl);

    if (artworkUrl) {
      detail.artwork = artworkUrl.startsWith(config.baseUrl)
        ? (await getImageDataUri(
            config,
            artworkUrl.slice(config.baseUrl.length),
            log
          )) || ""
        : (await getExternalImageDataUri(config, artworkUrl)) || "";
    }
  }

  /*
   * Cache even the empty result. "This track has no cover" is worth remembering
   * for the three minutes it plays; re-deciding it every ten seconds is the
   * thing the cache exists to stop.
   */
  cache.set(now.key, detail);

  return { ...now, ...detail };
}

/**
 * Ask samo-server what the radio is playing, and build the card.
 *
 * Returns null for every "nothing to show" case there is -- unconfigured,
 * unreachable, no device, device idle -- because they are all the same to the
 * wall, which simply does not draw the card.
 */
async function pollNowPlaying (configDir, options = {}, log = console) {
  const config = options.config || loadSamoConfig(configDir, log);

  if (!config) {
    return null;
  }

  const devices = await getJSON(config, "/api/v1/samo-radio/devices", log);

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

  const now = resolveNowPlaying(device.state, { deviceName: device.name });

  if (!now) {
    return null;
  }

  const cache = options.cache || createDetailCache();

  return decorate(config, now, device, cache, log);
}

module.exports = {
  pollNowPlaying,
  loadSamoConfig,
  createDetailCache,
  decorate,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  ARTWORK_WIDTH,
  MAX_ARTWORK_BYTES
};
