# secondbrain — the modules written here

What each module puts on the wall and why it is shaped that way. For installing
and running the mirror, see the [README](../README.md).

## Now Playing

The `NowPlaying` module shows what samo-radio — the headless player on this same
box, wired into the line-out — is putting through the speakers.

The point of it is that **the station name is not the answer**. A card reading
"Jake Channel" tells you what you already set; what you cannot know without
asking is what Jake Channel is *playing*. So the track takes the headline and
the station is demoted to the small line above it:

```
┌─────────────────────────────────────────┐
│ ▪▪▪  [NOW PLAYING]       JAKE CHANNEL   │
│ ▪▪▪  Bad Guy                            │
│ ▪▪▪  Billie Eilish // When We All Fall… │
└─────────────────────────────────────────┘
```

A podcast episode says when it came out, at the right-hand end of the third
line where the station sits at the end of the first: `POSTED 11:04 AM` for
one posted today, `POSTED Sep 9` for one from before, with the year only when
it is not this one. The time matters on the day and stops mattering after
it; a bare time means today everywhere on the wall. The show's name beside
it gives way first — it is on the cover already — and the release is never
cut. A feed that never dated its episode gets no line rather than a guess.

```
│ ▪▪▪  JRE #2214 - Duncan Trussell        │
│ ▪▪▪  The Joe Rogan Experi…  POSTED Sep 9│
```

The cover is drawn in colour, as it comes. The wall's chrome is black and
white and only its content -- calendar events in their calendar's colour, and
this square -- carries colour, so a cover is the loudest object in the room,
which is the weight the radio should have.

Three sources, in decreasing order of how much is knowable:

- **A Samo channel** has a scheduler that chose the item on purpose, so the
  answer is exact. The album, and an episode's release, come from walking the
  channel's `itemRef` into the catalog.
- **An internet station** gives whatever it puts in ICY metadata, which ranges
  from a full artist/title pair to its own name on a loop. A station echoing its
  own branding is treated as "no track information" rather than a song called
  NPR — see `isRedundantStationLabel`.
- **A cast queue** ("play to samo-radio" from the phone) arrives already
  resolved — an episode's release excepted, which the item does not carry and
  is looked up once — and except when the thing cast is a station or a channel. Those reach
  the device as a one-item queue whose only facts are a name and a stream URL:
  the daemon refreshes live metadata only for a *tuned* source, and the cast
  item carries no picture. So the wall works out the source from the item and
  asks samo-server about it — a channel's now-playing says what it is airing,
  picture included; a station's record has the probe's last line and the
  station's cover — and builds the card as if the source had been tuned.
  Without that lookup the wall read "Elvis Radio / Crosley" for an afternoon,
  no track, no picture.

The picture, for all three, is whatever samo named in the device state: samo
resolves artwork for everything it plays — the song's cover, the show's, the
track a relayed station is on, or that station's logo — and the wall fetches
that URL rather than deducing one of its own. See "Artwork" in ARCHITECTURE.md
for the ways it can go wrong and how each is handled.

Nothing playing means no card. Idle, stopped, erroring, unreachable and
unconfigured all render as nothing, because on a wall they mean the same thing.

### What comes next

Under the card, on a hairline, one or two rows say when what is playing gives
way and to what:

```
│ NEXT   4:00 PM   All Things Considered      │
│ UNTIL  9:00 AM                              │
│ ENDS   2:40 PM                              │
```

The rule behind them is that **a boundary the station will keep is worth a
line; a guess is not.** What that leaves, by source:

- **A Samo channel** has a plan, and the plan has booked blocks that start on
  the clock. The next one is `NEXT` with its start; the end of the block on
  air now is `UNTIL`; a long item — an episode, not a song — gets `ENDS`.
  The item's end is samo's word, not the wall's arithmetic: the channel's
  now-playing says when the station will move on (`endsAt` — the end of the
  audio, the play window the scheduler capped the item to, or the appointment
  due to cut in, whichever is first), so a relayed station runs `UNTIL` its
  slot or its turn is up, and an episode the feed never measured ends where
  the scheduler capped it. A samo that does not say gets start plus length,
  which only ever answers for a measured item. Nearest first, at most two,
  and a block that ends exactly when the next begins is one row, not two a
  minute apart. What the rows never say is the
  next *track*: samo's scheduler does not pick it until the current one ends,
  and picks by a weighted draw among near-equal candidates seeded by the
  second, so a "next song" read off a preview would change every poll and be
  wrong when the moment came.
- **A cast queue** names the next item. When the queue runs out the device
  tunes back to its default station, so an audiobook's row is not "chapter
  two" but `NEXT 6:40 PM Jake Channel` — the station comes back when the book
  ends. A device with nowhere to go back to reads `ENDS`. A next song three
  minutes off carries no clock; a next item a quarter of an hour off does.
- **An internet station** knows nothing of its future unless somebody
  publishes a schedule. The BBC does, openly, and every BBC stream URL carries
  the service id, so a BBC station needs no configuration: the programme on
  air becomes the headline (the stream itself only says "BBC Radio 4") and the
  next programme is the row. NPR member stations on Composer publish one by a
  24-hex `ucs` id that only appears inside the station's own web widgets — put
  it in `samo.json` under `schedules`, or paste the widget link into the
  station's homepage field in samo (see `config/secondbrain/samo.example.json`).
  A channel block relaying such a station gets its programme too. Any other
  station gets no row, because a line that is not there beats one that is
  made up.

### What the channel owes

Under the rows, for a channel, a row of small covers:

```
│ DUE   [▪][▪][▪][▪][▪][▪][▪][▪]  + 3          │
```

These are the episodes the station **owes** you — a new episode is not a
candidate to samo but an obligation, and the obligation queue is an order:
tier first, then newest first, with anything about to stop being news lifted
up. Ordering that queue and scoring a candidate are, in samo's own words, the
same question asked twice and cannot disagree. That is why a row of them is
honest where a "next track" is not, and why it moves for honest reasons: a new
S-tier episode lands at the front, the one that just aired drops off, and what
is on air now is not in it.

The queue's order is not quite the running order, though: a decision filters
through its hard rules before it scores, so an episode a rule is holding back
— aired at lunch and owed a second hearing, with eight hours of separation
still to run — is at the front of the queue and nowhere near the front of the
air. Which rules, and what they say, is samo's business and stays there:
`GET /channels/{id}/obligations` marks each pending item the scheduler's own
rules would not offer right now with `held: { rule, reason }`, from the same
rules asked without deciding anything. The wall reads it and derives nothing:
free episodes first in samo's order, then held ones in samo's order, drawn
faint, the rule's own words in the tooltip. It is still `DUE` and not `NEXT` —
a booked show can cut in, an episode too long for the room before it waits.

Each tile is the show's cover at 30px, in colour like the one in the card; a
show samo has no cover for is its initials on a panel; eight covers and then
a count. The covers come from `GET /channels/{id}/obligations` (pending, most
urgent first) through `GET /channels/{id}/sources` (each show's podcast id) to
`/podcasts/shows/{id}/cover?width=64`, and are kept for a day — a show's cover
is the same picture for every episode it owes. A source saved without a label
(more than half of them, as it turned out) used to name no show in samo's owed
list; samo now names it from the feed's own title, on read, so the wall never
has to.

What counts as owed is samo's definition, not "every episode you have not
heard": a new episode within its freshness window that has not yet been
surfaced as many times as its tier asks for — an A-tier show that wants two
airings stays due after its first. On a weekday morning that is several
tiles; by a Saturday afternoon, once the day's episodes have played through,
it can honestly be one.

The rows and the covers are the cheapest things in the rail: two lists with a
floor of zero, first on the ladder for the first row, then the covers, then
mid-way for the second row, so they show whenever there is a line to spare and
never cost a card or an event of today's. Everything that builds them is
remembered between polls — the channel's plan, obligations and next booked
block for a minute, a station's record and schedule for longer — so the card's
ten-second poll stays one request; `showUpNext: false` in the module's config
leaves all of it off and skips those requests.

To turn it on, put a samo API token on the mirror:

```bash
scp config/secondbrain/samo.example.json <mirror>:/tmp/samo.json
# edit in the real token, then:
ssh <mirror> "sudo mv /tmp/samo.json /etc/magicmirror-secondbrain/samo.json"
```

Without that file the module does not run, which is the supported way to leave
it off. The helper reads it when the service starts and again whenever the
browser sends its config, so a restarted service picks up where it left off
without the browser's help — a helper that waited for the browser came back from
`apt upgrade` idle, and the wall showed the same song for twelve hours. The token
is only ever used server-side: cover art is fetched by the
node helper, which serves the bytes itself at `/nowplaying/artwork/<id>` on
MagicMirror's own web server, so no credential reaches the kiosk page — which
is served to anything on the LAN that asks. The helper decides what kind of
picture it holds from the bytes, not from samo's `Content-Type` (samo serves a
cover it saved under an extension it did not recognise as
`application/octet-stream`), and takes a cover at whatever size the feed
publishes it, because a show whose cover is too big for samo's own download
cap is redirected to the feed's CDN with no thumbnail on offer.

Verify the display logic and the fetch path with no samo-server and no mirror:

```bash
node scripts/check-nowplaying.js
```

## Drip the faucets

`FreezeWatch` puts a card in the rail when it is cold enough to worry about the
pipes. Two strengths, in the language the forecast already uses:

```
┌─────────────────────────────────────────┐    forecast low below 15
│ [FREEZE WATCH]                          │    -- a chore for tonight
│ ■  DRIP THE FAUCETS TONIGHT             │
│    FORECAST LOW 11° // TONIGHT          │
└─────────────────────────────────────────┘

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓    it is below 15 right now
┃ [FREEZE WARNING]  ░░░░░░░░░░░░░░░░░░░░  ┃    -- the cold is already here
┃ ■  DRIP THE FAUCETS NOW   ░░░░░░░░░░░░  ┃
┃    9° OUTSIDE // 2° TONIGHT  ░░░░░░░░░  ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

The warning is a step up, not a different design. The wall's chrome has no
colours, so the step is not a colour: the card takes the 45° hatching the wall
uses for hazard, a 4px edge instead of 2px, a larger headline, and the square beside
the headline breathes on a four-and-a-half second cycle. Nothing is full-bleed
and nothing else moves. This card can be up for a fortnight in January, so it
has to be liveable.

Three things stop it becoming wallpaper:

- **It only looks 36 hours ahead.** The wall offers seven days of forecast and
  this alerts on none of them but tonight's. A cold snap on Friday does not need
  a card up since Tuesday.
- **A low that already happened does not count.** A daily low is reported
  against the whole day but lands before dawn, so at six in the evening
  "today's low of 11°" is weather that finished twelve hours ago.
- **It has hysteresis.** It takes 15° to raise the card and 17° to let it go,
  because a temperature parked on the threshold would otherwise blink it on and
  off all night.

It fetches nothing. The two weather modules already poll open-meteo every
fifteen minutes and broadcast the result, so `FreezeWatch` reads that and can
never disagree with the numbers shown two cards further down. Change the
threshold in `config/config.js`; the common advice for exposed pipes is nearer
20° than 15°.

A stale reading keeps its card and says how old it is, because failing to drip
costs more than dripping needlessly. After six hours with nothing fresh it stops
claiming to know the weather at all.

Verify the whole thing — both levels, the thresholds, and the payload it reads —
with no weather provider and no mirror:

```bash
node scripts/check-freeze-watch.js
```

## The status line

`StatusLine` is the line under the month grid:

```
CAL 4/4 // GMAIL OK // ░PROTON DOWN░ // TRANSMISSION OK // SAMO OK
                              POLLED 41 S AGO (TOOK 21 S) // NTP LOCK // UP 41 D
```

Every word on it is something the wall already knows or can cheaply ask. The
mail poll's per-source result comes from `MMM-SecondBrain` and samo's from
`NowPlaying`, both re-broadcast as module notifications; the helper asks
`chronyc tracking` whether the clock is locked, reads uptime, and probes each
calendar feed with a plain GET every fifteen minutes.

`POLLED` is how long ago the mail poll last finished, and it ticks — that one
segment is rewritten in place every second, so the number on the wall is
never stale by more than a second. The bracket is how long that poll took,
kept because a poll that takes four minutes should look different from one
that takes two seconds (one slow source holds up every text behind it). It
used to read `POLLED 15:41:07 (41 S)`, the bracket being the duration, which
reads as an age and then sits at 41 for a minute; it said what it meant and
was still wrong to look at. A poll more than three intervals overdue is
hatched: a stalled poll is what lets a text die unseen, and nothing else on
the wall says so.

The probe is why the module exists. A calendar that starts answering 404 does
not go blank — the grid keeps drawing whatever it last fetched and nothing
logs it. That has happened here for six days at a stretch, twice. A hatched
`CAL 3/4` is the whole of the fix: it is not clever, it is just visible.

What is left off the line is as deliberate as what is on it. A source with no
credentials is off, not broken, and does not appear. A feed that has not been
probed yet reads `CAL --/4`, not `CAL 4/4`. A box without `chronyc` reads
`NTP --`, because not knowing is not the same as knowing it is wrong.

Verify the words with no chrony, no network and no mirror:

```bash
node scripts/check-status-line.js
```

## The rail

`Rail` decides what the right-hand column shows. It draws nothing of its own.

The rail is 1056 pixels of things that all want to be there — clock, freeze
card, weather, forecast, radio, three stacks of cards, schedule — and the
modules do not know about each other. The schedule at the bottom used to take
whatever the cards left and clip it through the middle of a row. On a busy day
that is the only agenda on the wall (the month grid runs out of lines at six
events a day), and it was the thing cut short.

So after every change to the rail, `Rail` measures what everything would take
at full height and hides whole items — forecast rows, cards, days, events, the
rows under the radio card, and on a day full enough whole cards and blocks —
until it fits. Three promises:

- **The rest of today is always listed, whole.** Passed events are already
  filtered out of the agenda; what is left of today is the floor of the
  whole rail. Nothing above it may cost it a row: not a text, not a package,
  not the radio, not the weather, not a freeze warning. Only the clock never
  moves for it, because the visible clock is the native overlay and hiding
  the box it reserves would only slide the rail under its ink.
- **Every card stack keeps a card** — as long as today allows it. Messages,
  inbound and transfers each show at least one; a section that has to hold
  cards back says so in its heading: `MESSAGES 01 / 03`.
- **Nothing ends mid-row.** A day beyond today that only partly fits shows
  as many whole rows as fit, with `+ 4 MORE` in its day heading. The count
  costs no extra row: a separate line used to leave 74px empty even when
  the next day's heading and first event would fit. A day with no room for
  a single row is left off. Today is never partial.

What the rest of the space goes to is a ladder, climbed one rung at a time.
Today is the floor and tomorrow is the leftover: everything between them
goes up whole, in order, and the schedule beyond today takes what that
leaves.

```
messages all   every text there is
forecast all   the week's weather, whole
upnext 1       what the radio does next
due 1          the covers of the episodes the channel owes
inbound all    every package
upnext all     the radio's second row
transfers all  every download
schedule all   tomorrow, the day after, and on down
```

A rung raises one list to a count. One that does not wholly fit takes the
whole items that do and closes that list; the walk carries on, so a small
thing further down can still use what a big one could not. Texts come before
everything, because a text is on the wall nowhere else and gone in an hour,
while tomorrow is on the grid to the left — the order once had tomorrow
ahead of the second text, and the wall spent its spare room on three rows of
tomorrow and `+ 4 MORE` while a text that would have fit twice over was held
back. Tomorrow comes after everything, for the same reason: the order once
had it on the fourth rung, ahead of the forecast's second row, and on any
ordinary day — a text, a package, the radio on, seven events tomorrow — the
wall listed all of tomorrow and cut the week's weather to a row or two. The
radio's rows and its row of covers are lists with a floor of zero: the card
they hang under stands whatever happens to them, so they are cheap to add
and never part of what gives way.

The gaps between modules stay exactly 10px. As space opens up, Rail restores
whole forecast rows, cards and schedule events in the ladder's order. The
forecast offers seven days, and the agenda offers up to 30 days for Rail to
choose from. `custom.css` stacks the modules from the top with `flex-start`;
the schedule fills the remaining height without an auto margin. After fitting
whole items, Rail distributes the remainder through the visible schedule rows
(or day cells when there are no events), bringing the content to the bottom
edge. It clears that expansion before each allocation so incoming cards,
finished downloads and resizing still get the full natural-height budget.
The gaps between modules never expand.

When even that does not fit — a twenty-event day with a freeze warning, the
radio on and all three stacks — everything but today gives way, in a stated
order: transfers, then inbound, then the forecast, then the radio card whole,
then the last message, because a text is the one card that is on the wall
nowhere else and gone in an hour; then the weather, and the freeze warning
last of all, because when it is up it is the most important thing in the rail
after the day itself. Both orders are in `config.js` and can be rewritten
there — except that naming the schedule in the second changes nothing. Today
is never trimmed, not even behind `+ N MORE`; if today's events alone do not
fit under the clock, the rail logs that it does not fit rather than hide one.

How it stays honest: the heights are measured, not assumed, from the real
DOM in a measuring state that is put on and taken off inside one task, so the
wall never paints the untrimmed rail; a redraw by any module is re-fitted by a
MutationObserver before that redraw reaches the screen; and after applying,
the schedule's box is read back and the fit is redone with less if a line box
rounded the wrong way. The decision itself is a pure function in
`modules/Rail/lib/rail.js`, so it goes wherever the wall goes next.

Verify the promises with no browser and no mirror:

```bash
node scripts/check-rail.js
```

## The weather card

`WeatherTheme` is not a module. It is a `themeDir` for MagicMirror's stock
weather module — two nunjucks templates and a stylesheet — so the current
conditions read numbers-first (the temperature is the biggest thing on the
card, then FEELS / HUMIDITY / WIND / SUN as labelled values) and the forecast
is one row per day with the chance of rain as a five-segment bar. It replaces
`MMT-CalmCurrentWeather`, which only ever existed on the mirror and could not
be rebuilt from this repo.

## Working on the notification logic

Verify the package parser with no mail account and no mirror:

```bash
node scripts/check-packages.js
```

Verify that one sick source cannot take the wall down with it. This stands up a
fake IMAP server and a fake Nextcloud on loopback, so it also needs no account
and no mirror. Allow about half a minute — it waits out a real deadline:

```bash
node scripts/check-poll-resilience.js
```

Run a real poll and see what the wall would show:

```bash
node scripts/dev-poll.js /path/to/config/dir --twice
```

`--twice` polls twice and diffs the item ids. They should be identical — ids
that churn mean duplicate cards and unbounded state growth.

`/path/to/config/dir` needs real credentials (`gmail/`, `proton/`,
`transmission.json`). On the mirror that is `/etc/magicmirror-secondbrain`.
`config/secondbrain/` here holds templates only; the real files are gitignored.

## History

The repo once carried a `.gitignore` beginning with `*` that whitelisted two
files, so `git add .` stored nothing: 6 of 222 files were tracked and commit
messages described work that was never committed. Package-tracking code lost to
a `git reset --hard` is preserved at tag `recovered/package-tracking-6afc993`.
