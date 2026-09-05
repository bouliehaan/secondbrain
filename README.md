# secondbrain

A wall-mounted dashboard for a headless Linux box driving a display through
LightDM, Openbox and Chromium in kiosk mode.

- **Calendar and weather**, on a wall you never log into. After a power cut it
  comes back by itself, and it refuses to draw until the clock is actually
  synchronised — a dashboard showing the wrong day is worse than a blank one.
- **The things you would otherwise check a phone for**: Google Voice messages,
  important mail, package shipments, Transmission downloads, what
  [samo-radio](https://github.com/bouliehaan/samo-radio) is playing, and a
  drip-the-faucets alert when it turns cold.

It is not a container, because it drives a real display through a real X
session.

## Install

On the box with the display, Debian or Ubuntu:

```bash
curl -fsSLO https://github.com/bouliehaan/secondbrain/releases/latest/download/secondbrain_all.deb
sudo apt install ./secondbrain_all.deb
```

That is the whole install. **MagicMirror is bundled**, so there is nothing to
clone and no prerequisite to satisfy — the package carries MagicMirror 2.37.0
and the two pinned `MMM-CalendarExt3` modules alongside the five written here,
installs the unprivileged `calendar-display` account the wall runs as, the
systemd unit, the LightDM autologin drop-in, the kiosk supervisor and the clock,
points chrony at the NIST servers, creates `/etc/magicmirror-secondbrain/` for
credentials, and starts the service.

Upgrading is the same two commands. `apt remove` leaves your credentials and
config alone, `apt purge` takes them with it.

Versions come from [config/third-party-modules.json](config/third-party-modules.json),
which is the one place the pins live. Everything bundled is MIT; the licenses
ship in `/usr/share/doc/secondbrain/licenses/`.

**One thing to know about node.** MagicMirror 2.37 requires `>=22.21.1 <23` or
`>=24` — the 23.x line is excluded upstream, and Ubuntu's own `nodejs` is older
than the floor. If `node` on your `PATH` does not satisfy that, point
`SECONDBRAIN_NODE` at one that does; the service refuses to start on a version
MagicMirror would reject rather than going dark with the reason buried in the
journal.

## Credentials

Nothing reads credentials out of this repo, and the package never writes into
the credential directory — it only creates it, `0700` and owned by the service
user. Fill it in by hand, shaped like the templates in
`/usr/share/doc/secondbrain/examples/`:

```bash
sudo install -m 600 /dev/stdin /etc/magicmirror-secondbrain/samo.json <<'JSON'
{ "baseUrl": "http://samo.local:6969", "token": "your-samo-api-token" }
JSON
```

A missing file is the supported way to leave a source off — without
`samo.json`, NowPlaying does not run. The samo token is only ever used
server-side: cover art is fetched by the node helper and handed to the browser
as a data URI, so no credential reaches the kiosk page, which is served to
anything on the LAN that asks.

## The one thing the package will not do for you

`config.js` is yours, not the package's. Two of the four calendars are private
urls — a Nextcloud public-share token and a Jane booking token — and MagicMirror
insists on having them inside `config.js`, so **the wall's own copy is the only
copy**. The repo carries `REDACTED_PRIVATE_PATH` where they belong.

The package therefore never installs a `config.js`. It ships one to
`/usr/share/doc/secondbrain/config.example.js` and leaves the live file
untouched, because the alternative is what already happened once: a deploy
shipped the redacted file verbatim, both private calendars answered 404, nothing
logged it, and personal events quietly stopped appearing for a week.

This holds even though the package now owns `/opt/MagicMirror` outright: it
ships nothing whatsoever under `config/`, and the release build fails if a
`config.js` ever turns up inside the package. dpkg also leaves files it did not
ship alone, so a module you installed there by hand — `MMT-CalmCurrentWeather`,
for one — survives every upgrade.

If it happens anyway, `node scripts/restore-calendar-urls.js` recovers them from
`journalctl`, which logs them on every fetch. Journal retention is finite, so
keep a backup of the wall's `config.js`.

## Settings

`/etc/default/secondbrain`, a conffile your edits survive upgrades in:

| | |
|---|---|
| `SECONDBRAIN_NODE` | which node runs MagicMirror (default: whatever is on `PATH`) |
| `SECONDBRAIN_MM_ROOT` | where MagicMirror is installed (default `/opt/MagicMirror`) |
| `SECONDBRAIN_CHROMIUM` | which browser the kiosk launches (default: the snap, then `PATH`) |
| `SECONDBRAIN_TZ` | timezone for Chromium and `calendar-kiosk` (default `America/Denver`; the box itself is `Etc/UTC`). It does **not** reach the clock, which sets `os.environ['TZ']` itself at import — see below. |
| `SECONDBRAIN_PORT` | the port MagicMirror serves on (default `43761`) |

## Checks

These need no wall, no account and no credentials — they stand up their own
fakes. `make check` is what CI runs:

| | |
|---|---|
| `make check` | every shipped script parses, then the three fast suites |
| `make check-all` | the above plus poll resilience (~30s; it waits out a real deadline) |
| `node scripts/check-packages.js` | the package parser |
| `node scripts/check-nowplaying.js` | the NowPlaying display logic and fetch path |
| `node scripts/check-freeze-watch.js` | both freeze levels, the thresholds, the payload |
| `node scripts/check-poll-resilience.js` | that one sick source cannot take the wall down |
| `node scripts/dev-poll.js <config dir> --twice` | a real poll, diffed against itself — churning ids mean duplicate cards |

`dev-poll.js` needs real credentials; on the wall that is
`/etc/magicmirror-secondbrain`.

`scripts/check-calendars.js` runs **on the wall** and reads its live config: it
fetches every calendar, checks something is actually fetching them, and prints
today's events so you can compare the feeds against what is on the glass. It
changes nothing and needs no sudo. Run it whenever the wall looks stale — the
calendar has failed silently twice, and neither failure showed up in the log.

## Building the package

```bash
make deb
```

`dist/secondbrain_all.deb`. The filename carries no version on purpose, so
`releases/latest/download/secondbrain_all.deb` never goes stale; the real
version is in the control file, which is what dpkg and apt read. Tagging `v*`
builds and publishes it.

The build needs network the first time: it fetches MagicMirror's release tarball
and clones the two third-party modules at their pinned refs, then caches both
under `build/cache/` so rebuilds are offline. `make clean` throws that away.

It builds on any node. MagicMirror refuses to `npm install` outside its engine
range, so the build passes `--engine-strict=false` — the dependencies are pure
JavaScript and the tree is identical either way. The version that matters is the
one at runtime, and `secondbrain-server` checks that before it starts.

### Committing

```bash
./scripts/commit.sh "what changed and why"
```

Refuses to run off `master`, checks that no credential file, live calendar url
or host-specific address is about to go public, runs `make check-all`, commits,
rebases if origin moved, pushes, and then re-checks the remote rather than
trusting its own exit code. `--skip-gates` for a docs-only change.

## The clock

`clock/magicmirror-python-clock.py` draws the time over kiosk Chromium. It is a
GTK popup with `keep_above` set, given an RGBA visual and painted transparent so
only the digits land on the wall, positioned from the primary monitor's geometry
so its right edge sits 30px in — matching MagicMirror's own padding.

It polls at 100ms rather than 1s so the second flips on the kernel's boundary
instead of drifting up to a second behind it, and redraws only when the rendered
markup actually changes. `time.strftime` reads the kernel clock directly, which
chrony holds within 10ms of NIST, and `calendar-kiosk` refuses to start Chromium
at all until that is true.

Light and dark come from `MMM-SolarTheme`, which writes
`/tmp/magicmirror-clock-color` on `THEME_CHANGED`; the clock re-reads it on
every tick. One wrinkle worth knowing: SolarTheme writes `${color #000000}` —
conky syntax, left over from an earlier clock — and the Python clock only
matches it because it substring-searches for `000000`. It works, but the two
ends agree by accident rather than by contract.

The timezone is set inside the script (`os.environ['TZ']` + `tzset()` at
import), so it does not follow `SECONDBRAIN_TZ`.

Anything touching the clock has to be verified on the physical display. A
running process is not a visible window, and a mapped window is not a window
above kiosk Chromium — [docs/HANDOFF.md](docs/HANDOFF.md) lists the specific
ways a clock change looks fine and is not.

## Troubleshooting

```bash
journalctl -u magicmirror -f | grep -iE 'secondbrain|nowplaying'
```

**The calendar is frozen but the service is running.** The stock calendar module
registers its fetchers when the *page* loads and never again, so a server that
restarts without the browser reloading has no calendar fetchers at all: no
fetches, no errors, and a month grid frozen at whatever it last drew. It stayed
that way for six days once. The package's postinst reloads the kiosk for you; by
hand it is:

```bash
sudo pkill -u calendar-display -f magicmirror-kiosk
```

`calendar-kiosk` supervises Chromium in a loop, so killing it is the reload.

**Nothing on the display at all.** The kiosk deliberately will not start
Chromium until chrony reports `Leap status: Normal` and the system clock within
10ms of its reference. `chronyc tracking` says whether that is ever going to
happen.

**A source stopped updating and nothing was logged.** Every source has a
deadline, but one slow source used to block the whole poll; texts die first
because they only live 60 minutes. `check-poll-resilience.js` is the regression
test for that.

## Rules that are load-bearing

- **Credentials never enter this repo.** They live in
  `/etc/magicmirror-secondbrain/`. The two private calendar urls are the
  awkward exception, and the wall's copy is authoritative.
- **Do not lower `pollIntervalMs` below 60s.** Every poll opens a fresh IMAP
  session per account; `node_helper.js` clamps anything faster, because the
  alternative is getting the account throttled.
- **Mail is never marked read.** Mailboxes are opened read-only, so a
  notification stays on the wall until it is read for real.

## Docs

- [docs/MODULES.md](docs/MODULES.md) — what each module puts on the wall and
  why: the NowPlaying card's three sources, the two freeze levels, and the three
  things that stop the card becoming wallpaper.
- [docs/HANDOFF.md](docs/HANDOFF.md) — the kiosk and X11 constraints. Read them
  before touching the clock or the display stack.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
