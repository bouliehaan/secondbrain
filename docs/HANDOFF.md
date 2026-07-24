MAGICMIRROR CLOCK / KIOSK HANDOFF
================================

PRIMARY GOAL
------------

Replace or improve only the external clock renderer while preserving the
existing MagicMirror dashboard and layout.

The current separate native clock solved the original time-accuracy problem,
but its rendering has these defects:

- Text is always white, including on the light theme.
- Text appears pixelated.
- Previous digits remain briefly visible during redraws.
- Seconds must remain accurately synchronized with the system clock.
- Seconds must use the same size and weight as the hour/minute text.
- A colon must appear between minutes and seconds.

NON-NEGOTIABLE CONSTRAINTS
--------------------------

- Do not redesign or reflow the MagicMirror layout.
- Do not remove Chromium kiosk mode merely to accommodate another overlay.
- Do not change calendar, weather, agenda, notification, or download modules.
- Do not alter the working system clock/NTP configuration.
- Do not disable the current native clock until a replacement is visibly proven.
- Preserve an automatic fallback to the current native clock.
- Test against the real LightDM/Openbox X11 session on DISPLAY=:0.
- A process existing is not proof that a window is visible.
- A window being mapped is not proof that it is above Chromium.
- Do not use an isolated Xvfb test as production verification.
- Terminal instructions must be one directly pasteable heredoc block.

EXPECTED ENVIRONMENT
--------------------

- Ubuntu Server 24.04.x
- MagicMirror 2.37.x
- LightDM
- Openbox
- Chromium snap
- X11 DISPLAY=:0
- Kiosk user: calendar-display
- MagicMirror installation: /opt/MagicMirror
- MagicMirror web port has previously been 43761
- Current clock has been launched separately from Chromium
- Chrony is synchronized against NIST

IMPORTANT
---------

Do not assume the expected environment above is still exact. Read the included
live diagnostics, process list, launchers, configuration files, logs, and X11
window tree before modifying anything.

The archive has been sanitized. Credentials, private calendar share tokens,
email addresses, phone numbers, and obvious authentication secrets have been
redacted.
