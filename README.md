# secondbrain

A wall-mounted dashboard for a headless Linux box. It turns a display and a
spare machine into a calendar wall you never log into: month grid, agenda,
weather, and a column of the things you would otherwise pull out a phone to
check.

- **Calendar and weather**, from as many feeds as you care to add.
- **Messages and mail** — Google Voice texts and the mail you actually want
  interrupted for, without marking anything read.
- **Deliveries** — package tracking parsed out of shipping mail, plus
  Transmission downloads.
- **Now playing**, if you run [samo-radio](https://github.com/bouliehaan/samo-radio) —
  when the episode on air was posted, and what comes next: your channel's
  next booked show, the end of the one on air, the covers of the episodes it
  owes you in the order it means to play them, the next item in a cast queue,
  a BBC station's next programme.
- **Freeze warnings**, so you know when to drip the faucets.
- **A status line** under the calendar: whether each feed and account
  answered, when the last poll ran, whether the clock is locked to NTP.

It comes back on its own after a power cut, and it will not draw the clock until
the machine's time is actually synchronised.

## Install

```bash
curl -fsSLo /tmp/secondbrain.deb https://github.com/bouliehaan/secondbrain/releases/latest/download/secondbrain_$(dpkg --print-architecture).deb && sudo apt install -y /tmp/secondbrain.deb
```

That is the whole install. MagicMirror, the calendar modules and the Node
runtime they need are bundled, so there is nothing to clone, no build step and
nothing to install first. The package creates the `calendar-display` account
the wall runs as, writes a starting config with the weather set from your
timezone, installs and starts the service, sets up autologin into a
full-screen browser session, points the system clock at NIST, and tells you the
address the dashboard is answering on.

Reboot, and the display comes up on its own.

Upgrading is the same line. `apt remove` leaves your settings and credentials
alone; `apt purge` deletes them.

## Requirements

| | |
|---|---|
| OS | Debian, Ubuntu or Raspberry Pi OS — x86-64, 64-bit ARM or 32-bit ARM |
| Display | anything X11 can drive; the box runs headless otherwise |
| Disk | about 240 MB installed |

Node comes with the package: most distributions' own `nodejs` is older than
MagicMirror accepts. To run a different one, see [Settings](#settings).

## Add your accounts

Credentials live in `/etc/magicmirror-secondbrain/`, which the installer creates
and nothing else writes to. Each source is optional — leave a file out and that
part of the dashboard simply does not appear.

Templates for all of them are in `/usr/share/secondbrain/examples/`.

**Mail and texts** (`gmail/accounts/personal.json`) — an app password, not your
real one. Google Voice texts arrive as mail, which is how they reach the wall.

```bash
sudo install -m 600 -o calendar-display -g calendar-display /dev/stdin \
  /etc/magicmirror-secondbrain/gmail/accounts/personal.json <<'JSON'
{ "user": "you@gmail.com", "pass": "your-app-password" }
JSON
```

**Now playing** (`samo.json`) — a samo API token:

```bash
sudo install -m 600 -o calendar-display -g calendar-display /dev/stdin \
  /etc/magicmirror-secondbrain/samo.json <<'JSON'
{ "baseUrl": "http://your-samo-host:6969", "token": "your-samo-api-token" }
JSON
```

BBC stations get their schedule with nothing more; an NPR member station on
Composer needs its `ucs` id under `schedules` — see
[samo.example.json](config/secondbrain/samo.example.json).

**Downloads** (`transmission.json`) and **contacts**
(`nextcloud-contacts.json`) follow the same shape as their templates.

Restart after adding any of them:

```bash
sudo systemctl restart magicmirror
```

Your tokens stay on the machine. Cover art and message bodies are fetched
server-side and handed to the browser already rendered, so nothing with a
credential in it reaches the page — which matters, because the page is served to
anything on your network that asks for it.

## Choose what is on the wall

The dashboard layout lives in `/opt/MagicMirror/config/config.js`: which
calendars to fetch, where each panel sits, what the weather is for. The install
writes it for you — a public holiday calendar, and the weather for your
timezone's city — so the wall works before you change anything. Add your own
calendars in its `calendars` list; the comment there shows the shape. If the
weather city is wrong, change the two `lat`/`lon` pairs and the `header` above
them.

```bash
sudo nano /opt/MagicMirror/config/config.js
```

The original is at `/usr/share/secondbrain/config.example.js` if you want to
start again.

**Upgrades never touch this file.** It is yours, it is the only copy, and
private calendar URLs — a Nextcloud share link, a booking-system feed — live
inside it in plain text. Back it up somewhere. If you lose it, those feeds are
gone with it.

After editing it, restart the service:

```bash
sudo systemctl restart magicmirror
```

The service reloads the kiosk browser whenever it starts, and that is not a
nicety. The calendar registers its feeds when the page loads and never again, so
a server that comes back under a browser that did not reload has a month grid
frozen at whatever it last drew — no errors, no empty screen, just a wall
quietly showing last week. That is what `apt upgrade` does when `needrestart`
bounces the service, and why the reload lives in the unit rather than in a
command you have to remember. If you are running a unit of your own, add it as
a drop-in:

```bash
sudo mkdir -p /etc/systemd/system/magicmirror.service.d
printf '[Service]\nExecStartPost=-/usr/bin/pkill -u calendar-display -f magicmirror-kiosk\n' |
  sudo tee /etc/systemd/system/magicmirror.service.d/20-reload-kiosk.conf
sudo systemctl daemon-reload
```

## Settings

`/etc/default/secondbrain`. Your edits survive upgrades.

| | |
|---|---|
| `SECONDBRAIN_NODE` | a node to run the dashboard with instead of the bundled one |
| `SECONDBRAIN_MM_ROOT` | where MagicMirror lives (default `/opt/MagicMirror`) |
| `SECONDBRAIN_CHROMIUM` | which browser to run full-screen |
| `SECONDBRAIN_TZ` | the display's timezone |
| `SECONDBRAIN_PORT` | the port the dashboard serves on (default `43761`) |

## Troubleshooting

```bash
systemctl status magicmirror
journalctl -u magicmirror -f
```

**Nothing on the display.** The browser deliberately waits for the system clock
to be synchronised before it starts, so a machine that cannot reach a time
server will sit dark on purpose. `chronyc tracking` tells you whether that is
what is happening.

**The service will not start.** The journal says why. If you have pointed
`SECONDBRAIN_NODE` at your own node, it has to be 22.21.1 or newer and not the
23.x line; remove the setting to go back to the bundled one.

**Calendars are stale, or Now Playing is stuck on one song.** The server
restarted and the browser did not reload — see above. Reload it now with
`sudo pkill -u calendar-display -f magicmirror-kiosk`, then make sure the unit
carries the `ExecStartPost` line so it does not happen again.

**A panel is missing.** Its credential file is absent or unreadable. Check the
journal, and that the file is owned by `calendar-display` and mode `600`.

**Nothing plays in Now Playing.** Idle, stopped, unreachable and unconfigured
all render as nothing on purpose, because on a wall across the room they mean
the same thing.

## Uninstalling

```bash
sudo apt remove secondbrain     # keeps your config and credentials
sudo apt purge secondbrain      # removes them too
```

## Development

Build the package, or run the offline checks — they stand up their own fakes and
need no display, accounts or credentials:

```bash
make check      # the test suites
make deb        # dist/secondbrain_{amd64,arm64,armhf}.deb
```

- [docs/MODULES.md](docs/MODULES.md) — what each panel shows and why
- [docs/HANDOFF.md](docs/HANDOFF.md) — display, X11 and clock constraints
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
