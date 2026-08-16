# secondbrain

A wall-mounted MagicMirror dashboard: calendar, weather, and **MMM-SecondBrain**
— a notification module that surfaces Google Voice messages, important email,
package shipments and Transmission downloads.

Runs on a headless Ubuntu box driving a display through LightDM, Openbox and
Chromium in kiosk mode.

## Layout

```
modules/      the three modules written here
  MMM-SecondBrain/    notifications: Gmail, Proton, packages, Transmission
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

Checks syntax, runs the package parser checks, ships whole module directories,
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
