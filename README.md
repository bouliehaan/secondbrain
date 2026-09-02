# secondbrain

A wall-mounted MagicMirror dashboard: calendar, weather, and **MMM-SecondBrain**
— a notification module that surfaces Google Voice messages, important email,
package shipments and Transmission downloads. Plus **NowPlaying**, which shows
what samo-radio is playing, and **FreezeWatch**, which says when to drip the
faucets.

Runs on a headless Ubuntu box driving a display through LightDM, Openbox and
Chromium in kiosk mode.

## Layout

```
modules/      the five modules written here
  MMM-SecondBrain/    notifications: Gmail, Proton, packages, Transmission
  NowPlaying/         what samo-radio is playing
  FreezeWatch/        drip-the-faucets alert when it turns cold
  MMM-SolarTheme/     light/dark switching on sun position
  MMM-CalendarLiveHeader/
config/       config.js, and *.example.json credential templates
system/       systemd unit, openbox/lightdm, kiosk launchers, chrony
clock/        the python clock renderer
scripts/      deploy, pull, bootstrap, calendar health, dev tools
docs/         ARCHITECTURE.md, HANDOFF.md
```

Third-party modules are **not** vendored. They are pinned in
`config/third-party-modules.json` and installed by `scripts/bootstrap.sh`.

## Everyday use

```bash
scripts/deploy.sh
```

Checks syntax, runs every offline check, ships whole module directories,
installs dependencies from the lockfile, restarts `magicmirror`, then reads the
log back to confirm it actually came up.

```bash
scripts/deploy.sh --dry-run        # show what would transfer
scripts/deploy.sh --modules-only   # leave config.js and custom.css alone
```

The mirror defaults to `jake@192.168.1.10`; override with `SECONDBRAIN_REMOTE`.

## Is the calendar actually syncing?

```bash
scripts/check-calendars.sh
```

Reads the mirror's live config, fetches every calendar in it, checks that
something is actually fetching them, and prints today's events — so you can
compare the feeds against what the wall is showing. No sudo, changes nothing.
Run it whenever the wall looks stale; the calendar has failed silently twice,
and neither failure showed up in the log.

Times come out in the kiosk's timezone, which is set by `export TZ` in
`calendar-kiosk` and is *not* the machine's — the box itself is `Etc/UTC`.

## Private calendar urls

Two of the four calendars are secrets: a Nextcloud public-share token and a Jane
booking token. Like every other credential they stay out of this repo, so
`config/config.js` carries `REDACTED_PRIVATE_PATH` where they belong.

**The mirror's own `config.js` is the only copy.** `deploy.sh` reads the live
urls off the mirror and merges them into the file it installs, so deploying
never overwrites them, and it aborts rather than install a placeholder.

That is a repair, not a design. For a week `deploy.sh` shipped the redacted file
verbatim; both private calendars answered 404 and nothing logged it, so personal
events quietly stopped appearing on the wall. If it happens again:

```bash
scripts/restore-calendar-urls.sh --dry-run   # recover the urls, change nothing
scripts/restore-calendar-urls.sh             # install them and reload the wall
```

It recovers the urls from `journalctl`, which logs them on every fetch, and
keeps them on the mirror. Journal retention is finite — keep a copy of the
mirror's `config.js` somewhere backed up.

## Restarting magicmirror is not enough

The stock calendar module registers its fetchers when the **page** loads and
never again. Restart the service without reloading the kiosk browser and you get
a server with no calendar fetchers at all: no fetches, no errors, and a month
grid frozen at whatever it last drew. It stayed that way for six days before
anyone noticed.

`deploy.sh` and `restore-calendar-urls.sh` reload the browser for you. By hand:

```bash
ssh jake@192.168.1.10 "sudo pkill -u calendar-display -f magicmirror-kiosk"
```

`calendar-kiosk` supervises chromium in a loop, so killing it is the reload.

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
scp config/secondbrain/samo.example.json jake@192.168.1.10:/tmp/samo.json
# edit in the real token, then:
ssh jake@192.168.1.10 "sudo mv /tmp/samo.json /etc/magicmirror-secondbrain/samo.json"
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

## Recovering state from the mirror

Some things have only ever existed on the mirror — `custom.css` above all,
roughly 1800 lines styling the whole dashboard.

```bash
scripts/pull-from-pi.sh --diff   # report drift, write nothing
scripts/pull-from-pi.sh          # also fetch what the repo is missing
```

It reports drift rather than overwriting, because on a hand-edited mirror either
side may be the one you want. It copies no secrets.

## Rebuilding the mirror from scratch

```bash
scripts/bootstrap.sh    # install pinned third-party modules
scripts/deploy.sh       # install this repo's own modules and config
```

Then place real credentials in `/etc/magicmirror-secondbrain/` on the mirror,
using `config/secondbrain/*.example.json` as the shape, and install a
`config.js` carrying the real private calendar urls once — see
[Private calendar urls](#private-calendar-urls). Deploys preserve them after
that, but there is nothing for the first deploy to preserve.

## Notes

- **Credentials never enter this repo.** They live at
  `/etc/magicmirror-secondbrain/` on the mirror and are gitignored here. The two
  private calendar urls are the awkward exception: MagicMirror wants them inside
  `config.js`, so the mirror's copy of that file is authoritative and deploys
  merge them forward.
- **Do not lower `pollIntervalMs` below 60s.** Every poll opens a fresh IMAP
  session per account; `node_helper.js` clamps anything faster, because the
  alternative is getting the account throttled.
- **Mail is never marked read.** Mailboxes are opened read-only, so a
  notification stays on the wall until it is read for real.
- `docs/HANDOFF.md` carries the kiosk and X11 constraints. They are load-bearing
  — read them before touching the clock or the display stack.

## History

The repo previously carried a `.gitignore` beginning with `*` that whitelisted
two files, so `git add .` stored nothing: 6 of 222 files were tracked and commit
messages described work that was never committed. Package-tracking code lost to
a `git reset --hard` is preserved at tag `recovered/package-tracking-6afc993`,
and the full pre-restructure tree is in history — see `git log`.
