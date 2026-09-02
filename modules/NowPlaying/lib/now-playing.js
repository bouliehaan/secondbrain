"use strict";

/*
 * Turning a samo-radio device status snapshot into the three or four lines the
 * wall shows.
 *
 * This file does no I/O on purpose. Everything here is a decision about what to
 * put on a wall you read from across the room, and those decisions are the part
 * worth testing -- `scripts/check-nowplaying.js` exercises them with no server,
 * no device and no network.
 *
 * The one rule behind all of it: **the station name is not the answer.** A card
 * reading "Jake Channel" tells you something you already knew -- you set the
 * station. What you cannot know without asking is what it is playing right now,
 * so the track takes the headline and the station is demoted to context. The
 * station name only gets promoted when nothing else is known, because a card
 * with an empty headline is worse than a redundant one.
 */

/* Device modes, mirrored from the daemon's internal/player/types.go. */
const MODE_IDLE = "idle";
const MODE_CHANNEL = "channel";
const MODE_QUEUE = "queue";

/* Device statuses, same source. */
const STATUS_IDLE = "idle";
const STATUS_PLAYING = "playing";
const STATUS_PAUSED = "paused";
const STATUS_BUFFERING = "buffering";
const STATUS_ERROR = "error";

/*
 * Station kinds. "channel" is a Samo channel the server programmes and encodes;
 * "station" is somebody else's internet stream. They need different handling
 * because only one of them has a scheduler that knows what it is playing.
 */
const KIND_CHANNEL = "channel";
const KIND_STATION = "station";

/*
 * The separator inside a now-playing key.
 *
 * NUL rather than a space or a dash, because the key is built by joining
 * user-visible strings and any printable separator can also occur *inside* one
 * of them: a station called "Jake" playing "Channel - Bad Guy" would otherwise
 * key identically to the "Jake Channel" station playing "Bad Guy", and the two
 * would share an artwork cache entry. Nothing in a title or an artist name can
 * be a NUL.
 *
 * Written as an escape rather than typed literally on purpose -- a raw control
 * character in source is invisible in an editor and does not survive a
 * copy-paste.
 */
const KEY_SEPARATOR = "\u0000";

const text = (value) =>
  typeof value === "string" ? value.trim() : "";

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const trimmed = text(value);

    if (trimmed) {
      return trimmed;
    }
  }

  return "";
};

const normalizeLabel = (value) =>
  text(value).toLowerCase().replace(/\s+/g, " ");

const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/*
 * True when a piece of "now playing" text only repeats the station's own name.
 *
 * Internet radio does this constantly: a stream with nothing better to say
 * fills StreamTitle with its own branding, so the honest reading of
 * `title: "NPR"` on the NPR station is "no track information", not "a song
 * called NPR". Without this check the wall confidently renders
 *
 *     NPR
 *     NPR
 *
 * which looks like a bug and hides the fact that we simply do not know.
 *
 * Ported from the samo client's own `isRedundantRadioStationLabel`
 * (packages/core/src/mobile/mobile-radio-metadata.ts) so the wall and the phone
 * disagree about as little as possible.
 */
function isRedundantStationLabel (stationName, value) {
  const candidate = text(value);

  if (!candidate) {
    return true;
  }

  const station = normalizeLabel(stationName);
  const normalized = normalizeLabel(candidate);

  if (!station) {
    return false;
  }

  if (normalized === station) {
    return true;
  }

  /*
   * Also catch the station name used as a prefix -- "NPR - Morning Edition"
   * against station "NPR" leaves "Morning Edition", which is real information
   * and must survive. Only the cases that strip to nothing, or that still
   * contain the station name, are redundant.
   */
  const stripped = normalized.replace(
    new RegExp(`^${escapeRegExp(station)}(?:\\s*[-–—|:]\\s*|\\s+)`, "u"),
    ""
  );

  if (stripped !== normalized) {
    return stripped.length === 0 || stripped.includes(station);
  }

  return false;
}

/*
 * Strip a leading station name from a line, keeping whatever it was introducing.
 *
 * "NPR - Morning Edition" on the NPR station should read "Morning Edition".
 * Runs only after isRedundantStationLabel has cleared the line, so the case
 * where nothing is left never reaches here.
 */
function stripStationPrefix (stationName, value) {
  const candidate = text(value);
  const station = normalizeLabel(stationName);

  if (!station || !candidate) {
    return candidate;
  }

  const match = candidate.match(
    new RegExp(`^${escapeRegExp(stationName.trim())}\\s*[-–—|:]\\s*(.+)$`, "iu")
  );

  return match ? text(match[1]) : candidate;
}

/*
 * Split an unparsed "Artist - Title" line.
 *
 * samo-server parses ICY metadata into artist/title where it can, and the
 * daemon falls back to the raw StreamTitle when it could not. That raw string
 * is very often "Artist - Title" and splitting it is the difference between
 * two useful lines and one long one that gets ellipsised on a wall.
 *
 * Split on the FIRST separator only: "Simon - Garfunkel - The Boxer" is far
 * more likely to be artist "Simon" than a title containing a dash, and titles
 * with dashes ("Marquee Moon - Remastered") keep theirs intact this way.
 *
 * Returns null when the line does not look like a pair, which leaves the caller
 * to treat it as a bare title -- the safe reading.
 */
function splitArtistTitle (value) {
  const candidate = text(value);

  if (!candidate) {
    return null;
  }

  const match = candidate.match(/^(.{1,120}?)\s+[-–—]\s+(.+)$/u);

  if (!match) {
    return null;
  }

  const artist = text(match[1]);
  const title = text(match[2]);

  if (!artist || !title) {
    return null;
  }

  return { artist, title };
}

/*
 * Whether a status is worth putting on the wall at all.
 *
 * `buffering` counts as playing: it is what a device looks like for a second or
 * two between tracks and at the moment it tunes, and blinking the card off and
 * back on for that is worse than showing a stale title very briefly.
 *
 * `error` does not count. The device reports its own errors and there is a
 * sound coming out of a speaker or there is not -- an error card on a wall
 * calendar is noise nobody can act on from across the room.
 */
function isAudible (status) {
  return (
    status === STATUS_PLAYING ||
    status === STATUS_BUFFERING ||
    status === STATUS_PAUSED
  );
}

/*
 * What a tuned internet radio station is playing, as far as anyone can tell.
 *
 * Everything here is best-effort by nature: the only metadata is whatever the
 * stream chooses to put in StreamTitle, which ranges from a full artist/title
 * pair to the station's own name on a loop to nothing at all. So this degrades
 * in steps rather than requiring any particular field.
 */
function describeInternetStation (channel) {
  const stationName = firstNonEmpty(channel.name, "Internet radio");
  const rawTitle = text(channel.title);
  const rawArtist = text(channel.artist);

  const titleIsRedundant = isRedundantStationLabel(stationName, rawTitle);
  const artistIsRedundant = isRedundantStationLabel(stationName, rawArtist);

  /*
   * Nothing usable: the station is all we have, so it takes the headline. This
   * is the "NPR + any info you can get" case where the info turned out to be
   * none, and saying so plainly beats inventing a track.
   */
  if (titleIsRedundant) {
    return {
      title: stationName,
      artist: "",
      album: "",
      context: "",
      station: stationName,
      artwork: text(channel.artworkUrl)
    };
  }

  const cleaned = stripStationPrefix(stationName, rawTitle);

  /*
   * An artist field the station actually filled in is better than anything we
   * could infer, so only reach for the split when it is missing.
   */
  if (!artistIsRedundant && rawArtist) {
    return {
      title: cleaned,
      artist: rawArtist,
      album: "",
      context: stationName,
      station: stationName,
      artwork: text(channel.artworkUrl)
    };
  }

  const split = splitArtistTitle(cleaned);

  if (split && !isRedundantStationLabel(stationName, split.artist)) {
    return {
      title: split.title,
      artist: split.artist,
      album: "",
      context: stationName,
      station: stationName,
      artwork: text(channel.artworkUrl)
    };
  }

  /*
   * A single unsplittable line. Usually a programme name ("Morning Edition")
   * rather than a song, which is exactly the kind of thing worth showing.
   */
  return {
    title: cleaned,
    artist: "",
    album: "",
    context: stationName,
    station: stationName,
    artwork: text(channel.artworkUrl)
  };
}

/*
 * What a Samo channel is playing.
 *
 * This is the case the whole feature exists for. The channel has a scheduler
 * that picked the item deliberately and a now-playing endpoint that will say
 * what it was, so unlike internet radio there is no guessing -- and rendering
 * "Jake Channel" here, with the answer one field away, is the specific failure
 * this avoids.
 */
function describeChannel (channel) {
  const channelName = firstNonEmpty(channel.name, "Channel");
  const title = text(channel.title);
  const artist = text(channel.artist);

  /*
   * The streamer between items, or a channel whose encoder has only just
   * started. Falling back to the channel name keeps the card on the wall for
   * the few seconds it takes the next item to be announced, instead of
   * flickering out and back.
   */
  if (!title || isRedundantStationLabel(channelName, title)) {
    return {
      title: channelName,
      artist: "",
      album: "",
      context: text(channel.sourceLabel),
      station: channelName,
      artwork: text(channel.artworkUrl)
    };
  }

  return {
    title,
    artist: isRedundantStationLabel(channelName, artist) ? "" : artist,
    album: "",
    /*
     * Whatever the channel is airing, pictured. Samo resolves this before it
     * reaches the device -- the cover of the song, or the logo of the station
     * being relayed -- so there is nothing to work out from here.
     */
    artwork: text(channel.artworkUrl),
    /*
     * The channel is the context -- "this is what Jake Channel is playing" --
     * and sourceLabel ("Morning rotation", "Podcasts") says which part of the
     * programming picked it, which is genuinely interesting and free.
     */
    context: channelName,
    station: channelName,
    sourceLabel: text(channel.sourceLabel)
  };
}

/*
 * An ad-hoc queue somebody cast to the device from a phone or the web UI.
 *
 * The API layer resolves these items fully before handing them over -- title,
 * subtitle and artwork are all already correct -- so there is nothing to infer.
 */
function describeQueueItem (item, deviceName) {
  const title = firstNonEmpty(item.title, "Unknown");
  const subtitle = text(item.subtitle);

  /*
   * Subtitles arrive as "Artist · Album" or just "Artist". Splitting gives the
   * album its own dimmer line instead of padding the artist line with it.
   */
  const parts = subtitle
    .split("·")
    .map((part) => text(part))
    .filter(Boolean);

  return {
    title,
    artist: parts[0] || "",
    album: parts.slice(1).join(" · "),
    context: firstNonEmpty(deviceName, "samo-radio"),
    station: ""
  };
}

/**
 * Build the wall's Now Playing card from a samo-radio device state snapshot.
 *
 * Returns null whenever there is nothing worth showing -- a device that is
 * idle, stopped, erroring or unreachable. The frontend hides itself on null
 * rather than rendering an empty shell, because a permanently dark card in the
 * rail is a thing people ask about.
 *
 * @param {object|null|undefined} state  a samo-radio `State`, as returned by
 *   GET /api/v1/samo-radio/devices/{id}/state
 * @param {object} [options]
 * @param {string} [options.deviceName]  falls back to state.deviceName
 * @returns {object|null}
 */
function resolveNowPlaying (state, options = {}) {
  if (!state || typeof state !== "object") {
    return null;
  }

  const status = text(state.status).toLowerCase();
  const mode = text(state.mode).toLowerCase();

  if (!isAudible(status) || mode === MODE_IDLE) {
    return null;
  }

  const deviceName = firstNonEmpty(options.deviceName, state.deviceName);
  const channel = state.channel && typeof state.channel === "object"
    ? state.channel
    : null;
  const item = state.item && typeof state.item === "object"
    ? state.item
    : null;

  let described = null;
  let source = "";

  if (mode === MODE_CHANNEL && channel) {
    const kind = text(channel.kind).toLowerCase() || KIND_CHANNEL;

    described = kind === KIND_STATION
      ? describeInternetStation(channel)
      : describeChannel(channel);

    source = kind === KIND_STATION ? KIND_STATION : KIND_CHANNEL;
  } else if (mode === MODE_QUEUE && item) {
    described = describeQueueItem(item, deviceName);
    source = MODE_QUEUE;
  } else if (item) {
    /*
     * Mode and payload disagree -- a state we should never see, but the device
     * is the authority on what is coming out of the speaker and it says an item
     * is playing. Render it rather than showing nothing.
     */
    described = describeQueueItem(item, deviceName);
    source = MODE_QUEUE;
  }

  if (!described || !text(described.title)) {
    return null;
  }

  /*
   * A live stream has no meaningful position: the device has been connected for
   * however long it has been connected, which says nothing about where the
   * current track is. Only a finite queue item gets a progress figure.
   */
  const live = Boolean(item?.live) || source !== MODE_QUEUE;
  const duration = Number(state.durationSeconds) || 0;
  const position = Number(state.positionSeconds) || 0;

  return {
    title: described.title,
    artist: described.artist || "",
    album: described.album || "",
    /*
     * An artwork URL the server already resolved, when there is one. The
     * backend still fetches the bytes -- see samo-client's artworkFor -- but it
     * no longer has to deduce WHICH picture from an item ref, which is what it
     * could not do for a relayed stream.
     */
    artwork: described.artwork || "",
    context: described.context || "",
    station: described.station || "",
    sourceLabel: described.sourceLabel || "",
    source,
    live,
    paused: status === STATUS_PAUSED,
    buffering: status === STATUS_BUFFERING,
    listenerCount: Number(channel?.listenerCount) || 0,
    positionSeconds: live ? 0 : position,
    durationSeconds: live ? 0 : duration,
    deviceName,
    /*
     * A stable identity for "this is the same thing that was playing last
     * poll". The frontend skips its DOM update when this has not changed, and
     * the backend uses it to avoid re-resolving artwork every ten seconds --
     * both of which matter on a wall that must not flicker.
     */
    key: [
      source,
      described.station,
      described.title,
      described.artist,
      /*
       * The picture is part of the identity, not a decoration of it. A relay
       * that re-serves the current cover from ONE fixed address changes what
       * that address returns without changing anything else on the card, and
       * samo tags such a URL so it moves when the picture does. Leaving it out
       * of the key is what would pin the first song's cover to every song
       * after it.
       */
      described.artwork || ""
    ].join(KEY_SEPARATOR)
  };
}

/*
 * Which device to read, when the server reports more than one.
 *
 * A samo-radio device is a physical box in a physical room, and there may be
 * one in the kitchen and one in the workshop. Preference order:
 *
 *   1. the id in config -- an explicit choice always wins
 *   2. the one that is actually making a sound
 *   3. the first enabled one, so a silent single-device setup still shows up
 *      the moment it starts playing
 */
function selectDevice (devices, configuredId) {
  const list = Array.isArray(devices) ? devices : [];
  const wanted = text(configuredId);

  if (wanted) {
    return list.find((device) => text(device?.id) === wanted) || null;
  }

  const audible = list.find(
    (device) =>
      device?.enabled !== false &&
      isAudible(text(device?.state?.status).toLowerCase()) &&
      text(device?.state?.mode).toLowerCase() !== MODE_IDLE
  );

  if (audible) {
    return audible;
  }

  return list.find((device) => device?.enabled !== false) || null;
}

module.exports = {
  resolveNowPlaying,
  selectDevice,
  isRedundantStationLabel,
  splitArtistTitle,
  stripStationPrefix,
  isAudible,
  MODE_IDLE,
  MODE_CHANNEL,
  MODE_QUEUE,
  STATUS_IDLE,
  STATUS_PLAYING,
  STATUS_PAUSED,
  STATUS_BUFFERING,
  STATUS_ERROR,
  KIND_CHANNEL,
  KIND_STATION
};
