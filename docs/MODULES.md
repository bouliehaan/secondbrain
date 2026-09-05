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
│ ▪▪▪  NOW PLAYING · JAKE CHANNEL         │
│ ▪▪▪  Bad Guy                            │
│ ▪▪▪  Billie Eilish · When We All Fall…  │
└─────────────────────────────────────────┘
```

Three sources, in decreasing order of how much is knowable:

- **A Samo channel** has a scheduler that chose the item on purpose, so the
  answer is exact. The album and the cover come from walking the channel's
  `itemRef` into the catalog.
- **An internet station** gives whatever it puts in ICY metadata, which ranges
  from a full artist/title pair to its own name on a loop. A station echoing its
  own branding is treated as "no track information" rather than a song called
  NPR — see `isRedundantStationLabel`.
- **A cast queue** ("play to samo-radio" from the phone) arrives already
  resolved, artwork and all.

Nothing playing means no card. Idle, stopped, erroring, unreachable and
unconfigured all render as nothing, because on a wall they mean the same thing.

To turn it on, put a samo API token on the mirror:

```bash
scp config/secondbrain/samo.example.json <mirror>:/tmp/samo.json
# edit in the real token, then:
ssh <mirror> "sudo mv /tmp/samo.json /etc/magicmirror-secondbrain/samo.json"
```

Without that file the module does not run, which is the supported way to leave
it off. The token is only ever used server-side: cover art is fetched by the
node helper and handed to the browser as a data URI, so no credential reaches
the kiosk page — which is served to anything on the LAN that asks.

Verify the display logic and the fetch path with no samo-server and no mirror:

```bash
node scripts/check-nowplaying.js
```

## Drip the faucets

`FreezeWatch` puts a card in the rail when it is cold enough to worry about the
pipes. Two strengths, in the language the forecast already uses:

```
┌─────────────────────────────────────────┐    forecast low below 15
│ •  FREEZE WATCH                         │    -- a chore for tonight
│    Drip the faucets tonight             │
│    Forecast low 11°                     │
└─────────────────────────────────────────┘

┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓    it is below 15 right now
┃ •  FREEZE WARNING                       ┃    -- the cold is already here
┃    Drip the faucets now                 ┃
┃    9° outside · 2° tonight              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

The warning is a step up, not a different design: a brighter edge, a faint ice
wash, a larger headline, and a dot that breathes on a four-and-a-half second
cycle. It is deliberately not red and deliberately not full-bleed. This card can
be up for a fortnight in January, so it has to be liveable — and red would read
as *fault* rather than as *weather*, which is the wrong first glance.

Three things stop it becoming wallpaper:

- **It only looks 36 hours ahead.** The wall shows five days of forecast and
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
