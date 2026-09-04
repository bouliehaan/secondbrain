# Architecture

## The whole system in one picture

```
   Gmail IMAP ─┐
  Proton Bridge ┼─► lib/sources.js ──► node_helper.js ──socket──► MMM-SecondBrain.js
  Transmission ─┘      (polling,          (schedule,               (render)
                        parsing,           sanitise)
                        merging)
                           │
                           ▼
              /var/lib/magicmirror-secondbrain/
                    package_state.json
```

MagicMirror splits every module in two. `node_helper.js` runs in the server
process and may touch the network and disk. `MMM-SecondBrain.js` runs in the
kiosk browser and may not. They talk over socket notifications.

## The poll cycle

1. The browser sends `SECOND_BRAIN_CONFIG` on load, retrying every 10s until the
   backend answers.
2. `node_helper` clamps the interval to a **60s floor** and starts its timer. It
   owns the schedule — a `SECOND_BRAIN_REFRESH` from the browser is a hint that
   gets ignored if the last poll was recent.
3. Before polling anything, `cachedItems()` reads `package_state.json` and
   publishes the remembered shipments. See
   [Why the panel renders twice](#why-the-panel-renders-twice).
4. Each tick calls `pollAll(configDir, options, log)`, which runs the three
   sources concurrently, each under its own **120s deadline** — neither a dead
   source nor a hung one can take down the others. See
   [Why each source has a deadline](#why-each-source-has-a-deadline).
5. Package results are merged with persisted state, stale ones pruned.
6. Items are sorted by priority, then recency, and capped **per category** so a
   busy inbox cannot crowd out a shipment or a download. `pollAll` and the
   cached render share this step (`present()`), so the early paint is exactly
   what the poll will produce.
7. `SECOND_BRAIN_UPDATE` goes to the browser, which diffs against the last
   payload and skips the DOM update when nothing changed. Without that the wall
   visibly flashes on every poll.

### Why the panel renders twice

The frontend hides itself until its first update, and the first poll takes as
long as its slowest source. Measured against the journal that window ran from 18
seconds to **over four minutes** — during which the panel is invisible, nothing
is logged, and a slow Gmail is indistinguishable from a module that failed to
start. It has been mistaken for a broken deploy.

So the cached render goes up first. It reads only — no network, no write — so it
cannot disturb the state the real poll is about to merge, and it is published
**only before the first poll of a process**: the browser re-sends its config on
resume, and only packages are cached, so a later cached publish would knock
mail, Voice and downloads off the wall until the next poll.

Every publish now logs how long its poll took, because a four-minute poll and a
two-second one used to log the same line.

### Why each source has a deadline

`pollNow()` returns immediately while a poll is in flight, so a source that never
answers does not just lose its own results — it stops the wall publishing
**anything**, and logs nothing while it does. On 2026-08-07 that cost 23.8
minutes of silence between two publishes, and the only clue in the journal was
the gap itself.

Texts pay for this and packages do not. A shipment is remembered in
`package_state.json` and loses nothing to a stall; a Google Voice card lives 60
minutes from the moment the message arrives, so a long enough blackout means a
text is never seen at all. The wall keeps publishing its unchanged package count
throughout, which is why the symptom reads as "texts stopped working".

So each source races a deadline (`DEFAULT_SOURCE_TIMEOUT_MS`, 120s, floored at
30s). It bounds a hang; it is not a latency target — a normal poll takes about
45s and the slow tail reaches three minutes, so a tighter deadline would spend
its time abandoning sources that were about to succeed.

Three consequences worth knowing:

- A source that misses the deadline is **abandoned, not cancelled** — ImapFlow
  has no abort hook. Its own `finally` closes the session whenever it finishes,
  and only `pollAll` writes state, so a straggler has nowhere to put its results.
- Because abandoned sessions can break with nobody awaiting them, both IMAP
  clients get an `error` listener (`survivesAsyncErrors`). Node turns an `error`
  event with no listener into an uncaught exception, which would kill the helper.
- Voice, mail and downloads have no persistence anywhere, so a timed-out source
  **replays its last answer** for up to 5 minutes rather than letting its cards
  blink off the wall and back on. Packages are excluded from that replay: they
  already survive a missing source, and replaying them would refresh
  `lastSeenAt` as though the mail had been seen again.

The one network call that runs *only* when a text exists — the Nextcloud contacts
lookup — sits inside this same path, so `loadContacts` backs off on failure as
well as on success. Without that, `expiresAt` stayed in the past and every voice
message in the scan retried the full CardDAV discovery.

### Why the 60s floor exists

Every poll opens a fresh IMAP session per account: connect, list, search, fetch,
logout. The config previously asked for 3000ms *and* the frontend ran its own
timer on top, giving roughly a poll every 1.5s. That is a reliable way to get an
account throttled or temporarily locked. The floor is enforced in
`node_helper.js`, not trusted to config.

## Priorities

Higher wins. Ties break toward the more recent item.

| Priority | Kind | Source |
|---|---|---|
| 100 | `voice` | Google Voice — calls, texts, voicemail |
| 95 | `package` | shipments |
| 90 | `warning` | Transmission errors |
| 78 | `email` | Proton unread |
| 75 | `email` | Gmail important mailbox |
| 45 | `download` | active torrents |
| 35 | `download` | recently finished |

Each category has its own display limit (`maxItems`, `maxPackageItems`,
`maxDownloadItems`), so these priorities order *within* a section rather than
competing for one shared list.

## Sources

**Gmail** (`pollGmail`) — three separate scans per account: unread mail in a
dedicated label (default `Wall-Display`), Google Voice notifications in the
inbox, and package mail in All Mail.

A configured mailbox name is resolved first and IMAP special-use is the
fallback, not the other way round — special-use still covers Gmail localising
its visible folder names, but resolving it first meant an explicit
`packageMailbox` was silently ignored.

Google Voice cards expire on `voiceDisplayMinutes` (default 60) regardless of
which of the two scans found them. `voiceMaxAgeMinutes` only sets how far back
the inbox scan looks, and is raised to the display window if it is shorter. A
text picked up from the important mailbox previously had no age limit at all
and sat on the wall until it was read for real.

**Proton** (`pollProton`) — talks to the local Proton Mail Bridge on
`127.0.0.1:1143`, not to Proton directly. The bridge must be running.

**Transmission** (`pollTransmission`) — RPC, including the 409 session-id
handshake the protocol requires on first contact.

All mailboxes are opened `readOnly: true`. Without it, fetching sets `\Seen` and
the mirror marks real mail as read merely by displaying it.

### Gmail's SEARCH problem

Gmail has been observed returning no UIDs for a time-based `SEARCH` even when
matching messages plainly exist. `fetchRecentSummaries` works around it by
scanning a bounded window of the newest sequence numbers and filtering by
timestamp locally. This also bounds the work per poll, which an open-ended
search does not.

## Package tracking

The part with the most subtlety, because retail email is adversarial by
accident.

**Finding candidates.** `fetchPackageEmails` scans the newest slice of All Mail
and keeps messages whose sender or subject suggests an order. Envelope-only at
first; bodies are fetched for survivors only.

**Parsing.** `extractPackageInfo` tries three shapes in order — storefront order
mail, Amazon, then a bare carrier notification — and returns `null` for refunds,
cancellations and digital receipts.

### Every status has to be earned

The status shown on a card is read from the subject line, which is a blunt
instrument, so the design question is not how often it is right but **how it is
wrong**. Two rules, both bought with real mistakes:

**Nothing is assumed.** `Ordered` used to be the fallback in `deliveryStatus()`,
which made it the one status nobody had to earn: any subject the phrase lists
did not recognise became a confident claim that a purchase had been made. Telling
someone they bought something they did not is the most alarming way for this to
be wrong — worse than showing no status at all. Every stage in `DELIVERY_STAGES`
must now be stated outright, and anything else reports `UNKNOWN_STATUS`
("Update"), which claims nothing and invites a look at the inbox.

**Negation is honoured.** `includes("delivered")` also fires on "will be
delivered tomorrow" and on "undelivered", and `includes("shipped")` on "has not
shipped yet". Phrases are matched on word boundaries, and a match is discarded
if a negator sits within two words in front of it — enough for "will *be*
delivered" and "has not *yet been* delivered", not enough to reach across
punctuation, so "Do not reply — your package has shipped" still reads as
shipped.

The stage table is still a list of strings somebody wrote, and Amazon will
invent new ones. The point of these two rules is that the failure mode when that
happens is a card reading "Update" rather than a card telling you something
untrue.

**Tracking numbers are matched twice, never against raw MIME.** Matching the raw
source means matching base64 attachment payloads, which will happily yield a
UPS-shaped string that appears nowhere a human can see. So both passes run over
the *decoded* body:

- a **strict** pass over readable text, requiring punctuation or a string edge
  on both sides
- a **relaxed** pass over the whitespace-stripped copy, which is the only way to
  catch a number the sending client wrapped across two lines — guarded so it
  cannot match inside a longer digit run

A bare 12- or 15-digit run is only treated as FedEx if the message actually says
"FedEx". Account numbers are the same shape.

**Identity must be stable.** A message with no order number is keyed by a digest
of sender, subject and date. Keying it randomly — as an earlier version did —
mints a new id every poll, which means duplicate cards and a state file that
grows forever.

**Merging.** One shipment is announced several times (ordered → shipped → out
for delivery), often under different identifiers. `deduplicate` collapses them
by id, tracking number, or order number, keeping the newest status while
inheriting the best title and any identifiers the other messages carried.

**Persistence.** Retailers stop mentioning a shipment once delivered, so state
outlives the mail. `package_state.json` lives in `stateDir`
(`/var/lib/magicmirror-secondbrain`) — *not* beside the module, which the
service user cannot write. An unwritable directory degrades to in-memory with
one warning rather than one per poll.

**State must expire.** Every cached package carries a `lastSeenAt`, refreshed
whenever a message in the current scan still describes it. An entry is dropped
when it is delivered and older than 48h, when nothing has mentioned it for 6h,
or when it is 10 days old whatever its status. Without the middle rule an order
that never produced a delivery mail — most of them — stayed cached forever and
was republished on every poll, which is why archiving the mail never cleared
the card.

The forget-pass only runs if some account actually read its package mailbox.
`fetchPackageEmails` returns `null` on failure rather than `[]` precisely so
that "the mailbox is empty" and "the mailbox could not be read" stay
distinguishable; otherwise one outage longer than 6h would erase every shipment.

`lastSeenAt` is stripped before the payload reaches the browser. It changes
every poll, and the frontend skips its DOM update by comparing the serialised
payload against the previous one — a field that always differs would defeat
that and flash the wall once a minute.

**Two different expiries, and only one of them ends up mattering.** Bounding the
state file stops a card outliving its *mail*. It does nothing about a card
outliving its *usefulness*, because while the mail is still inside the scan
window every poll simply rebuilds the card from that same message and refreshes
its `lastSeenAt`. Expiring the cached entry is futile in that window.

So the rule that actually retires a shipment is a display filter:
`pruneStalePackages` drops anything whose newest message is older than
`packageStaleAfterHours` (default 36). `deduplicate` keeps the newest message
for a shipment, so `timestamp` is the age of the latest news about it — one that
shipped days ago and has said nothing since has almost certainly arrived.

This is what catches `Shipped` and `Delayed`, which reach none of the other
rules: they are not `Delivered`, not `Out for delivery`, and not old enough for
the 10-day ceiling, so before this they sat on the wall for the entire
`packageMaxAgeDays` window.

**Archiving.** The default package mailbox is All Mail, which by definition
still holds archived mail, so archiving an order does not remove it from the
scan and is not a way to dismiss a card. Point `packageMailbox` at `INBOX` if
you want it to be — that setting is honoured now that a configured name beats
special-use.

## Configuration

| Where | What |
|---|---|
| `config/config.js` | dashboard layout, module list — deployed whole |
| `config/secondbrain/*.example.json` | credential templates |
| `/etc/magicmirror-secondbrain/` | the real credentials, on the mirror only |
| `/etc/magicmirror-secondbrain/samo.json` | samo API token; absent means Now Playing is off |
| `/var/lib/magicmirror-secondbrain/` | runtime state, owned by `calendar-display` |

Real credentials are gitignored and never leave the mirror.

## Now Playing

```
  samo-server ──► NowPlaying/lib/samo-client.js ──► node_helper.js ──socket──► NowPlaying.js
  (loopback)          (fetch, artwork,               (10s schedule,              (render)
                       caching)                       change detection)
                            │
                            ▼
                  lib/now-playing.js
                  (pure: snapshot → card)
```

A separate module from `MMM-SecondBrain`, deliberately. The two share a wall and
nothing else:

- **Different cadence.** Now Playing polls every 10s; the mail sources are
  floored at 60s because each poll opens a fresh IMAP session. Folding this in
  would either show finished tracks or get the mail accounts throttled.
- **Different blast radius.** They are separate node helpers with separate
  timers, so a stalled IMAP source cannot freeze the radio card, and a stopped
  samo-server cannot delay a text message. The failure this avoids is documented
  above under [Why each source has a deadline](#why-each-source-has-a-deadline).
- **Different lifecycle.** A notification is an event with an expiry. Now Playing
  is a status: it has no age, no priority, and no place in the per-category caps.

### Where the answer comes from

samo-radio is a headless player daemon holding the sound card open, tuned to a
Samo channel or an internet station, and falling back to that station when a
cast queue runs out. It reports a complete status snapshot — never a delta — and
samo-server passes it through at `GET /api/v1/samo-radio/devices`, state
included, so one request answers everything.

The daemon refreshes its own channel metadata every 10 seconds by asking
samo-server (`/api/v1/channels/{id}/now` for a channel, the station record's ICY
`nowPlaying` for internet radio). That is why the wall polls at 10s: it is
exactly as fresh as the answer can be, and faster returns the same bytes.

### What the card decides

`lib/now-playing.js` is a pure function from snapshot to card and holds every
judgement worth testing. The rules it encodes:

| Situation | Headline | Why |
|---|---|---|
| Channel with a track | the track | the station is what you set; the track is what you cannot know |
| Channel between items | the channel name | better than an empty card for the few seconds it lasts |
| Station with a programme | the programme | real information the stream volunteered |
| Station echoing its own name | the station | that is not a track, and saying so beats inventing one |
| Cast queue | the item | already resolved by the API layer |

Two behaviours are ported from the samo client's own
`mobile-radio-metadata.ts`, so the wall and the phone disagree as little as
possible: the redundant-station-label test, and preferring a parsed artist over
a split of the raw ICY line.

### Artwork, and why it is fetched server-side

A channel's status carries no picture — only the catalog does. So the cover for
a Samo channel costs three extra calls: the channel's `now` for an `itemRef`,
the track or episode for its album and parent, then the cover itself at
`?width=256`. They are cached by now-playing identity, because a three-minute
track would otherwise pay for them eighteen times.

The bytes are fetched by the node helper and handed to the browser as a data
URI. Signing an `<img src>` would mean putting a samo credential in a page
served to the whole LAN — samo has a `stream_token` parameter for exactly that,
and it is still the wrong trade when this process already holds the token and
can hand over finished pixels.

### Publishing

The helper compares each payload against the last and stays quiet when nothing
changed. The frontend does the same check, but it has to happen on both sides:
a card carries its cover inline, and pushing tens of kilobytes of unchanged
base64 down the socket every ten seconds for the browser to discard is work
nobody needs done.

## Freeze Watch

```
  weather (current)  ─┐
                      ├─ WEATHER_UPDATED ─► FreezeWatch.js ──► lib/freeze-watch.js
  weather (forecast) ─┘      (browser)        (merge, render)     (pure: readings → card)
```

No node helper and no fetch of its own. The two stock weather modules already
poll open-meteo every fifteen minutes and broadcast the result to every module
on the page, so this one reads that. A second fetch would be a second set of
numbers, free to disagree with the ones the wall is showing two cards further
down the same rail.

`lib/freeze-watch.js` is a pure function from readings to card and holds every
judgement worth testing. `scripts/check-freeze-watch.js` exercises it with no
weather provider, no browser and no mirror.

### The two broadcasts must be merged, not assigned

`config.js` runs two weather instances — one `type: "current"`, one
`type: "forecast"` — and **both** send `WEATHER_UPDATED`. Neither payload
carries both halves: the forecast instance sends no current conditions, and the
current instance sends an empty `forecastArray`.

So the frontend accumulates. Assigning the whole reading would have each
broadcast wipe out what the other had just supplied, and the module would flip
between knowing the current temperature and knowing the forecast every fifteen
minutes — showing a watch when it should show a warning, and losing the
overnight low from the warning's detail line.

`readWeatherPayload` returns `null` rather than `[]` for an absent forecast
precisely so "there is no forecast in *this* payload" stays distinguishable from
"the forecast is empty", which is the same distinction `fetchPackageEmails`
draws next door and for the same reason.

### What the card decides

| Situation | Level | Why |
|---|---|---|
| below the threshold right now | warning | the cold is here; the forecast is no longer the headline |
| forecast low below it, within 36h | watch | a chore to do before bed |
| forecast low below it, further out | nothing | a card up since Tuesday stops being read |
| a low that already happened this morning | nothing | that weather finished twelve hours ago |
| nothing fresh for over six hours | nothing | a dead feed must not keep insisting it is cold |

Three details that are each a specific way of being wrong:

**A daily low lands before dawn.** open-meteo reports one low against the whole
day, dated local midnight. Read naively, a 6am low of 11° is still "today's low"
at six in the evening, and the wall spends a mild evening advising a chore over
weather that is long gone. `lowArrivesAt` treats a daily low as arriving at 7am
local, which is both roughly true and enough to retire it once it has passed.

**Thresholds need hysteresis.** It takes `thresholdF` to raise the card and
`thresholdF + clearMarginF` to let it go. Without that, a temperature parked on
15° flips the card on and off on every provider update, which on a wall is a
light blinking in the corner of a room all night.

**The card must agree with itself.** The wall runs `roundTemp: true`, so
comparisons are made on the *rounded* value. Comparing the raw one would put a
card up reading "Forecast low 15°" under a rule that says "below 15", which
reads as a bug rather than as a rounding choice. It costs half a degree against
a threshold that is a rule of thumb anyway.

### Two units traps, both already sprung upstream

`WEATHER_UPDATED` is converted to imperial *before it is sent* when
`config.units === "imperial"`, which it is here — so everything downstream is
Fahrenheit and no conversion happens in this module.

That conversion is `value * 1.8 + 32` with no null check, so a provider
reporting no temperature arrives as a confident **32**. There is no way to tell
that from a real 32° reading, and no need to: 32 is above any sane freeze
threshold, so a missing reading fails safe as "not cold enough to alert" rather
than as a false alarm. `undefined` becomes `NaN` and is rejected outright.

The second trap is the timestamps. The openmeteo provider builds its dates from
`timeformat=unixtime`, and `WeatherObject.simpleClone()` flattens them through
`valueOf()`. A seconds value arriving where milliseconds are expected does not
throw — it silently places every forecast low in 1970, where it is neither ahead
of us nor inside the lookahead window, and the module goes quiet for an entire
winter with nothing in the log. `toEpochMs` normalises by magnitude.

### Stale readings keep their card

The two ways to be wrong are not symmetric. Dripping the faucets on a mild night
wastes a little water; not dripping them on a cold one costs a plumber. So a
reading older than `staleAfterMinutes` keeps its card and says how old it is,
rather than silently taking the advice down.

That only holds so far. Past `giveUpAfterHours` the module stops claiming to
know the weather at all — a card that goes on insisting on a finished cold snap
is the failure this dashboard has already been burned by twice elsewhere, where
a dead feed kept displaying confident stale information and nothing logged it.

## Other modules

`MMM-SolarTheme` switches light/dark on sun position — it reads the same
`WEATHER_UPDATED` broadcast as `FreezeWatch`, for `sunrise` and `sunset`.
`MMM-CalendarLiveHeader` renders the greeting header. `MMM-CalendarExt3` and `MMM-CalendarExt3Agenda` are
upstream, pinned in `config/third-party-modules.json` and installed from there.

`MMT-CalmCurrentWeather` is referenced by `config.js` as a weather `themeDir` but
has no source here — it exists only on the mirror, and has to be copied back off
it.
