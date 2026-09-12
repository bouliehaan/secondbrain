# Kiosk and clock constraints

Carried over from the original handoff notes. These are hard-won operational
facts about the physical mirror, not preferences — the clock and kiosk layer is
the part most easily broken from a laptop, because none of it is visible from
here.

## Environment

| | |
|---|---|
| OS | Ubuntu Server 24.04.x |
| MagicMirror | 2.37.x at `/opt/MagicMirror` |
| Display stack | LightDM + Openbox, X11 on `DISPLAY=:0` |
| Browser | Chromium snap, kiosk mode |
| Kiosk user | `calendar-display` |
| Web port | 43761 (see `system/magicmirror-port`) |
| Time | Chrony synchronised against NIST |

Do not assume this is still exact. Read the live system before changing it:
diff the mirror's own files against this repo rather than trusting either side,
because a hand-edited mirror may be the one that is right.

## Constraints

- Do not redesign or reflow the dashboard layout.
- Do not remove Chromium kiosk mode to accommodate an overlay.
- Do not alter the working system clock / NTP configuration.
- Do not disable the current clock until a replacement is *visibly* proven.
- Preserve an automatic fallback to the native clock.
- Test against the real LightDM/Openbox session on `DISPLAY=:0`.
  An isolated Xvfb test is not production verification.

## Verification traps

These are the specific ways a clock change looks fine and is not:

- **A running process is not a visible window.** Check the X11 window tree.
- **A mapped window is not a window above Chromium.** Kiosk Chromium will
  happily cover it.
- Confirm on the physical display before believing any of it.

## Clock renderer defects (original goal)

The separate native clock fixed the time-accuracy problem but rendered badly:

- text always white, including on the light theme
- text visibly pixelated
- previous digits briefly ghosting during redraw
- seconds must stay accurate to the system clock
- seconds must match hour/minute size and weight
- a colon belongs between minutes and seconds

`clock/magicmirror-python-clock.py` is the current renderer. It draws
Rajdhani, 12-hour with a small AM/PM, seconds at full size, and reads its ink
colours and the next sun event from `/tmp/magicmirror-clock-state`, written by
`MMM-SolarTheme`'s helper. Rajdhani's line box is a quarter taller than its
Latin digits (it carries Devanagari), so the labels are placed by their ink
from the font's own metrics: the numerals' caps flush with the top of the
window at 12px, the date line 10px under the baseline. `config/custom.css`
reserves that same 75px for the hidden browser clock. Verified under Xvfb on
the mirror; the alignment against the live page can only be confirmed on the
physical display.

The file alone changes nothing on the wall: the clock that is drawing is a
process the X session started at login. `scripts/deploy.sh` starts the new
one beside it, waits for it to stay up, then kills the old one.

## Sanitisation note

This repo began as a sanitised export. Credentials, calendar share tokens, email
addresses and phone numbers were redacted from it. Real secrets live only on the
mirror at `/etc/magicmirror-secondbrain/` and are never committed —
`config/secondbrain/` holds `*.example.json` templates only.

Automated redaction is not a guarantee. Check before sharing anything from here
publicly.

It has already damaged three files, and none of it was caught for months because
nothing in the repo installed them — `system/` was a snapshot nobody read back:

- `system/systemd/magicmirror.service` lost a `Wants=`/`After=` unit name. A
  systemd template unit (`name@instance.service`) looks like an email address to
  a naive regex, so it was replaced with `<REDACTED_EMAIL>` — an invalid unit
  name — before the file was ever committed. Here the redaction was right about
  the content and wrong about the result: the name is host-specific and should
  stay out of the repo, but it left an uninstallable unit behind. It is a
  drop-in on the box now, not a committed line.
- `system/bin/calendar-kiosk` had a comment block replaced by the raw sed
  pattern meant to strip it (`[[:space:]]*#`), which bash then tried to run as a
  command on every pass of its supervising loop.

Both classes are invisible to `git status` and to review, and neither shows up
until something actually installs the file. The package is what closes that:
these paths now have an owner.
