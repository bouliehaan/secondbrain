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
scripts/      deploy, pull, bootstrap, dev tools
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

## Working on the notification logic

Verify the package parser with no mail account and no mirror:

```bash
node scripts/check-packages.js
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
using `config/secondbrain/*.example.json` as the shape.

## Notes

- **Credentials never enter this repo.** They live at
  `/etc/magicmirror-secondbrain/` on the mirror and are gitignored here.
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
