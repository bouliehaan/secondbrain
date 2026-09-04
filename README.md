# secondbrain

A wall-mounted MagicMirror dashboard: calendar, weather, and the modules written
here — **MMM-SecondBrain** (Google Voice messages, important email, package
shipments, Transmission downloads), **NowPlaying** (what samo-radio is playing)
and **FreezeWatch** (when to drip the faucets).

Runs on a headless Ubuntu box driving a display through LightDM, Openbox and
Chromium in kiosk mode. The mirror is `jake@192.168.1.10`; override with
`SECONDBRAIN_REMOTE`.

## Installing the modules

These are ordinary MagicMirror modules. Into an existing MagicMirror:

```bash
cp -r modules/MMM-SecondBrain modules/NowPlaying modules/FreezeWatch \
      modules/MMM-SolarTheme modules/MMM-CalendarLiveHeader ~/MagicMirror/modules/
cd ~/MagicMirror/modules/MMM-SecondBrain && npm ci --omit=dev
```

`config/config.js` here is a worked example of how they are wired together;
`config/third-party-modules.json` pins the third-party modules this dashboard
also uses, which are deliberately **not** vendored.

Credentials go in `/etc/magicmirror-secondbrain/` on the machine running the
mirror, shaped like `config/secondbrain/*.example.json`. Nothing reads
credentials out of this repo.

For NowPlaying, that is a samo API token:

```bash
sudo install -m 600 /dev/stdin /etc/magicmirror-secondbrain/samo.json <<'EOF'
{ "baseUrl": "http://192.168.1.10:6969", "token": "your-samo-api-token" }
EOF
```

Without that file the module does not run, which is the supported way to leave
it off. The token is only ever used server-side: cover art is fetched by the
node helper and handed to the browser as a data URI, so no credential reaches
the kiosk page — which is served to anything on the LAN that asks.

`system/` carries the systemd unit, the LightDM/Openbox configuration and the
kiosk launchers for the display side, if you want the whole wall rather than the
modules.

## Checks

These need no mirror, no account and no credentials — they stand up fakes:

| | |
|---|---|
| `node scripts/check-nowplaying.js` | The NowPlaying display logic and fetch path |
| `node scripts/check-freeze-watch.js` | Both freeze levels, the thresholds, the payload it reads |
| `node scripts/check-packages.js` | The package parser |
| `node scripts/check-poll-resilience.js` | That one sick source cannot take the wall down (~30s; it waits out a real deadline) |
| `node scripts/dev-poll.js <config dir> --twice` | A real poll, diffed against itself — ids that churn mean duplicate cards |

`scripts/check-calendars.js` runs **on the mirror** and reads its live config:
it fetches every calendar, checks something is actually fetching them, and
prints today's events so you can compare the feeds against what the wall is
showing. It changes nothing and needs no sudo. Run it whenever the wall looks
stale — the calendar has failed silently twice, and neither failure showed up in
the log. Its times come out in the kiosk's timezone, set by `export TZ` in
`calendar-kiosk`; the box itself is `Etc/UTC`.

`dev-poll.js` needs a config dir with real credentials (`gmail/`, `proton/`,
`transmission.json`). On the mirror that is `/etc/magicmirror-secondbrain`;
`config/secondbrain/` here holds templates only.

## Restarting magicmirror is not enough

The stock calendar module registers its fetchers when the **page** loads and
never again. Restart the service without reloading the kiosk browser and you get
a server with no calendar fetchers at all: no fetches, no errors, and a month
grid frozen at whatever it last drew. It stayed that way for six days before
anyone noticed.

Reload it by hand after a restart:

```bash
ssh <mirror> "sudo pkill -u calendar-display -f magicmirror-kiosk"
```

`calendar-kiosk` supervises chromium in a loop, so killing it is the reload.

## Private calendar urls

Two of the four calendars are secrets: a Nextcloud public-share token and a Jane
booking token. Like every other credential they stay out of this repo, so
`config/config.js` carries `REDACTED_PRIVATE_PATH` where they belong.

**The mirror's own `config.js` is the only copy**, and anything that installs a
config must merge the live urls forward rather than overwrite them —
`scripts/merge-config-secrets.js` is what does that here.

That is a repair, not a design. For a week a deploy shipped the redacted file
verbatim; both private calendars answered 404, nothing logged it, and personal
events quietly stopped appearing. `scripts/restore-calendar-urls.js` recovers
them from `journalctl`, which logs them on every fetch — but journal retention
is finite, so keep a copy of the mirror's `config.js` backed up.

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
scripts/      offline checks and dev tools
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
