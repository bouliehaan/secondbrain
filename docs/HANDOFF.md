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

`clock/magicmirror-python-clock.py` is the current renderer.

## Sanitisation note

This repo began as a sanitised export. Credentials, calendar share tokens, email
addresses and phone numbers were redacted from it. Real secrets live only on the
mirror at `/etc/magicmirror-secondbrain/` and are never committed —
`config/secondbrain/` holds `*.example.json` templates only.

Automated redaction is not a guarantee. Check before sharing anything from here
publicly.
