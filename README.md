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
- **Now playing**, if you run [samo-radio](https://github.com/bouliehaan/samo-radio).
- **Freeze warnings**, so you know when to drip the faucets.

It comes back on its own after a power cut, and it will not draw the clock until
the machine's time is actually synchronised.

## Install

```bash
curl -fsSLO https://github.com/bouliehaan/secondbrain/releases/latest/download/secondbrain_all.deb
sudo apt install ./secondbrain_all.deb
```

That is the whole install. MagicMirror and the calendar modules are bundled, so
there is nothing to clone and no build step. The package creates the
`calendar-display` account the wall runs as, installs and starts the service,
sets up autologin into a full-screen browser session, and points the system
clock at NIST.

Reboot, and the display comes up on its own.

Upgrading is the same two commands. `apt remove` leaves your settings and
credentials alone; `apt purge` deletes them.

## Requirements

| | |
|---|---|
| OS | Debian or Ubuntu, x86-64 or arm64 |
| Display | anything X11 can drive; the box runs headless otherwise |
| Node | 22.21.1 or newer, excluding the 23.x line |
| Disk | about 110 MB installed |

Node is the one to check before you start. Ubuntu's own `nodejs` package is
older than the minimum, so you will likely want a current build from
[NodeSource](https://github.com/nodesource/distributions) or a tarball in
`/opt`. Any node works as long as you point the service at it — see
[Settings](#settings).

## Add your accounts

Credentials live in `/etc/magicmirror-secondbrain/`, which the installer creates
and nothing else writes to. Each source is optional — leave a file out and that
part of the dashboard simply does not appear.

Templates for all of them are in `/usr/share/doc/secondbrain/examples/`.

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
calendars to fetch, where each panel sits, what the weather is for. A worked
example is at `/usr/share/doc/secondbrain/config.example.js` — copy it and edit.

```bash
sudo cp /usr/share/doc/secondbrain/config.example.js \
        /opt/MagicMirror/config/config.js
sudo chown calendar-display:calendar-display /opt/MagicMirror/config/config.js
sudo systemctl restart magicmirror
```

**Upgrades never touch this file.** It is yours, it is the only copy, and
private calendar URLs — a Nextcloud share link, a booking-system feed — live
inside it in plain text. Back it up somewhere. If you lose it, those feeds are
gone with it.

After editing it, reload the browser as well as the service:

```bash
sudo systemctl restart magicmirror
sudo pkill -u calendar-display -f magicmirror-kiosk
```

Both, every time. The calendar registers its feeds when the page loads and never
again, so a service restart on its own leaves you with a month grid frozen at
whatever it last drew — no errors, no empty screen, just a wall quietly showing
last week.

## Settings

`/etc/default/secondbrain`. Your edits survive upgrades.

| | |
|---|---|
| `SECONDBRAIN_NODE` | which node runs the dashboard, if the one on `PATH` is not the one you want |
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

**The service will not start.** Almost always node. The dashboard needs 22.21.1
or newer and refuses the 23.x line; the journal names the version it found. Set
`SECONDBRAIN_NODE` to a suitable one.

**Calendars are stale.** Reload the browser as well as the service — see above.

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
make deb        # dist/secondbrain_all.deb
```

- [docs/MODULES.md](docs/MODULES.md) — what each panel shows and why
- [docs/HANDOFF.md](docs/HANDOFF.md) — display, X11 and clock constraints
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
