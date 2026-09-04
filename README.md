# secondbrain

A wall-mounted MagicMirror dashboard: calendar, weather, and the modules written
here — **MMM-SecondBrain** (Google Voice messages, important email, package
shipments, Transmission downloads), **NowPlaying** (what samo-radio is playing)
and **FreezeWatch** (when to drip the faucets).

Runs on a headless Ubuntu box driving a display through LightDM, Openbox and
Chromium in kiosk mode. The mirror is `jake@192.168.1.10`; override with
`SECONDBRAIN_REMOTE`.

## Install

On a fresh mirror, from a clone of this repo:

```bash
scripts/bootstrap.sh    # install the pinned third-party modules
scripts/deploy.sh       # install this repo's own modules and config
```

Then put real credentials in `/etc/magicmirror-secondbrain/` on the mirror,
using `config/secondbrain/*.example.json` as the shape, and install a `config.js`
carrying the real private calendar urls once — see
[Private calendar urls](#private-calendar-urls). Deploys preserve them after
that, but there is nothing for the first deploy to preserve.

Third-party modules are **not** vendored. They are pinned in
`config/third-party-modules.json` and installed by `bootstrap.sh`.

To turn NowPlaying on, put a samo API token on the mirror:

```bash
scp config/secondbrain/samo.example.json jake@192.168.1.10:/tmp/samo.json
# edit in the real token, then:
ssh jake@192.168.1.10 "sudo mv /tmp/samo.json /etc/magicmirror-secondbrain/samo.json"
```

Without that file the module does not run, which is the supported way to leave
it off.

## Everyday use

```bash
scripts/deploy.sh
scripts/deploy.sh --dry-run        # show what would transfer
scripts/deploy.sh --modules-only   # leave config.js and custom.css alone
```

Checks syntax, runs every offline check, ships whole module directories,
installs dependencies from the lockfile, restarts `magicmirror`, then reads the
log back to confirm it actually came up.

## Checks

All of these need no mirror, no account and no credentials — except
`check-calendars.sh`, which reads the mirror's live config and changes nothing.

| | |
|---|---|
| `scripts/check-calendars.sh` | Fetch every calendar and print today's events, to compare against the wall |
| `node scripts/check-nowplaying.js` | The NowPlaying display logic and fetch path |
| `node scripts/check-freeze-watch.js` | Both freeze levels, the thresholds, the payload it reads |
| `node scripts/check-packages.js` | The package parser |
| `node scripts/check-poll-resilience.js` | That one sick source cannot take the wall down (~30s; it waits out a real deadline) |
| `node scripts/dev-poll.js <config dir> --twice` | A real poll, diffed against itself — ids that churn mean duplicate cards |

Run `check-calendars.sh` whenever the wall looks stale. The calendar has failed
silently twice, and neither failure showed up in the log. Its times come out in
the kiosk's timezone, set by `export TZ` in `calendar-kiosk` — the box itself is
`Etc/UTC`.

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

## Private calendar urls

Two of the four calendars are secrets: a Nextcloud public-share token and a Jane
booking token. Like every other credential they stay out of this repo, so
`config/config.js` carries `REDACTED_PRIVATE_PATH` where they belong.

**The mirror's own `config.js` is the only copy.** `deploy.sh` reads the live
urls off the mirror and merges them into the file it installs, so deploying
never overwrites them, and it aborts rather than install a placeholder.

That is a repair, not a design. For a week `deploy.sh` shipped the redacted file
verbatim; both private calendars answered 404, nothing logged it, and personal
events quietly stopped appearing. If it happens again:

```bash
scripts/restore-calendar-urls.sh --dry-run   # recover the urls, change nothing
scripts/restore-calendar-urls.sh             # install them and reload the wall
```

It recovers them from `journalctl`, which logs them on every fetch. Journal
retention is finite — keep a copy of the mirror's `config.js` backed up.

## Recovering state from the mirror

Some things have only ever existed there — `custom.css` above all, roughly 1800
lines styling the whole dashboard.

```bash
scripts/pull-from-pi.sh --diff   # report drift, write nothing
scripts/pull-from-pi.sh          # also fetch what the repo is missing
```

It reports drift rather than overwriting, because on a hand-edited mirror either
side may be the one you want. It copies no secrets.

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
```

## Rules that are load-bearing

- **Credentials never enter this repo.** They live at
  `/etc/magicmirror-secondbrain/` on the mirror. The two private calendar urls
  are the awkward exception: MagicMirror wants them inside `config.js`, so the
  mirror's copy is authoritative and deploys merge them forward.
- **Do not lower `pollIntervalMs` below 60s.** Every poll opens a fresh IMAP
  session per account; `node_helper.js` clamps anything faster, because the
  alternative is getting the account throttled.
- **Mail is never marked read.** Mailboxes are opened read-only, so a
  notification stays on the wall until it is read for real.

## Docs

- [docs/MODULES.md](docs/MODULES.md) — what each module puts on the wall and
  why: the NowPlaying card's three sources, the two freeze levels and the three
  things that stop the card becoming wallpaper.
- [docs/HANDOFF.md](docs/HANDOFF.md) — the kiosk and X11 constraints. Read them
  before touching the clock or the display stack.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
