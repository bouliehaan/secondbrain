#!/usr/bin/env python3
"""
The wall's clock.

This is the household reference clock: a GTK popup kept above the kiosk
browser, drawing the kernel's time -- which chrony keeps against NIST -- on a
100 ms tick so the seconds flip on the boundary. It lives outside the browser
because the browser's clock drifted, and nothing about how it keeps time has
changed since it went in. Only how it looks has.

What it draws, top right of the wall, in Orbitron with a slashed zero
and Rajdhani supporting labels to match the page:

    03:42:07 PM
    FRI SEP 11 // SUNSET 7:14 PM

Colours and the sun line come from a small JSON file MMM-SolarTheme's helper
writes (/tmp/magicmirror-clock-state), so the clock inverts with the page at
sunrise and sunset and says when the next one is. The file is read every tick;
it is tiny, and it is the only channel between the page and this window.
"""
import gi
import json
import time
import os
import signal

# Force Mountain Time
os.environ['TZ'] = 'America/Denver'
time.tzset()

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib, Pango

# Orbitron supplies the wide, square numerals and slashed zero naturally.
# Fit one font size at startup; keep it unchanged for every displayed time.
TIME_FAMILY = "Orbitron Medium"
FONT_PERIOD = "Rajdhani SemiBold 20"
FONT_DATE = "Rajdhani SemiBold 13"
TIME_PX = 84
DATE_PX = 17.3

# Keep the supporting labels' original Rajdhani metrics and date gap.
# The time's own font padding is measured once at construction.
FONT_ASCENT = 0.930
FONT_CAP = 0.643
DATE_GAP = 10       # from the numerals' baseline to the top of the date line
WINDOW_WIDTH = 420  # custom.css --dashboard-sidebar

# Orbitron is proportional. Reserve its widest digit's natural advance for
# each numeral so narrow digits do not move their neighbours. Colons retain
# their own natural advance. There is no extra tracking or glyph stretching.
PERIOD_PX = 26.7
PERIOD_W = 40       # "AM" is 39.1px and "PM" 38.5px at 20pt, tracked
PERIOD_GAP = 2      # the last digit's cell already carries its own side bearing
TIME_CELLS = ("d", "d", ":", "d", "d", ":", "d", "d")
TIME_WIDTH = WINDOW_WIDTH - PERIOD_W - PERIOD_GAP
TIME_HEIGHT = round(FONT_CAP * TIME_PX)


def fit_time_font(widget):
    """Choose the largest unchanged Orbitron face that fits every time."""
    layout = widget.create_pango_layout("")
    font = Pango.FontDescription(TIME_FAMILY)
    # Measure actual Pango allocations, including pixel rounding. This runs
    # only at construction, never on a tick or an hour/AM/PM transition.
    for pixels in range(TIME_HEIGHT * 2, 0, -1):
        font.set_absolute_size(pixels * Pango.SCALE)
        layout.set_font_description(font)
        digit_width = 0
        for digit in "0123456789":
            layout.set_text(digit, -1)
            _, logical = layout.get_pixel_extents()
            digit_width = max(digit_width, logical.width)
        layout.set_text(":", -1)
        _, logical = layout.get_pixel_extents()
        colon_width = logical.width
        layout.set_text("0123456789", -1)
        ink, _ = layout.get_pixel_extents()
        if 6 * digit_width + 2 * colon_width <= TIME_WIDTH and ink.height <= TIME_HEIGHT:
            return font.to_string(), -ink.y, digit_width, colon_width
    raise RuntimeError("Clock font cannot fit the reserved time row")


# Dark values, matching custom.css; the state file overrides them by daylight.
DEFAULT_INK = "#eeeff0"
DEFAULT_INK2 = "#9d9ea0"

STATE_FILE = "/tmp/magicmirror-clock-state"
LEGACY_COLOR_FILE = "/tmp/magicmirror-clock-color"


def read_state():
    """
    What the page wants the clock to look like right now.

    Returns (ink, ink2, sun_line). Falls back to the dark defaults and no sun
    line when the file is missing or unreadable -- the wall boots dark. The
    old colour file is honoured too, so a helper that has not been updated
    still inverts the clock by day.
    """
    try:
        with open(STATE_FILE, "r") as f:
            state = json.load(f)
        ink = str(state.get("ink") or DEFAULT_INK)
        ink2 = str(state.get("ink2") or DEFAULT_INK2)
        sun = str(state.get("sun") or "")
        return ink, ink2, sun
    except Exception:
        pass

    try:
        with open(LEGACY_COLOR_FILE, "r") as f:
            if "000000" in f.read():
                return "#0c0c0d", "#5a5a5c", ""
    except Exception:
        pass

    return DEFAULT_INK, DEFAULT_INK2, ""


class ClockWindow(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.POPUP)
        self.set_title("MagicMirror Python Clock")

        self.set_keep_above(True)

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual and screen.is_composited():
            self.set_visual(visual)

        self.set_app_paintable(True)

        # Keep the existing 54px time row and date placement so the dashboard
        # below the clock does not move. Place the time by its measured ink.
        caps = FONT_CAP * TIME_PX
        self.time_font, self.time_y, digit_width, colon_width = fit_time_font(self)
        self.date_y = round(caps + DATE_GAP - (FONT_ASCENT - FONT_CAP) * DATE_PX)
        self.win_width = WINDOW_WIDTH
        self.win_height = round(caps + DATE_GAP + FONT_CAP * DATE_PX) + 2

        self.canvas = Gtk.Fixed()

        # Digit positions and font size stay fixed, including when a "1"
        # replaces a wider numeral. The whole row fits the 420px rail.
        self.period_y = round(caps - FONT_ASCENT * PERIOD_PX)
        self.cells = []
        block_width = 6 * digit_width + 2 * colon_width
        x = TIME_WIDTH - block_width
        for kind in TIME_CELLS:
            width = colon_width if kind == ":" else digit_width
            cell = Gtk.Label()
            cell.set_size_request(width, -1)
            cell.set_xalign(0.5)
            cell.set_yalign(0.0)
            self.canvas.put(cell, x, self.time_y)
            self.cells.append(cell)
            x += width

        # AM/PM hugs the time: left-aligned in its cell, so the gap after the
        # seconds is the same whichever of the two it is.
        self.period_label = Gtk.Label()
        self.period_label.set_size_request(PERIOD_W, -1)
        self.period_label.set_xalign(0.0)
        self.period_label.set_yalign(0.0)
        self.canvas.put(self.period_label, self.win_width - PERIOD_W, self.period_y)

        self.date_label = Gtk.Label()
        self.date_label.set_xalign(1.0)
        self.date_label.set_yalign(0.0)
        self.canvas.put(self.date_label, 0, self.date_y)

        # Overlay children do not contribute their font line boxes to the
        # window's preferred size. Only the reserved clock rectangle does;
        # the labels' invisible descenders must not extend over the rail.
        face = Gtk.DrawingArea()
        face.set_size_request(self.win_width, self.win_height)
        overlay = Gtk.Overlay()
        overlay.add(face)
        overlay.add_overlay(self.canvas)
        self.add(overlay)

        # What each label last showed, so a tick only touches what changed.
        self.cell_markup = [None] * len(self.cells)
        self.period_markup = None

        # The page's edge is 12px and the rail's text sits flush to it; the
        # labels are right-aligned to the window's edge, so the window's edge
        # is the rail's edge.
        self.gap_x = 12
        self.gap_y = 12

        self.last_markup = None

        # The window is app-paintable on an RGBA visual, so GTK paints no
        # background and the page shows through around the ink. (A "draw"
        # handler that painted transparent explicitly needed the cairo
        # bindings, which the wall does not have -- it raised on every frame
        # and did nothing.)
        self.set_default_size(self.win_width, self.win_height)

        # We place the top-left corner so the window exactly touches the right margin.
        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor()
        if monitor:
            geom = monitor.get_geometry()
            self.move(geom.width - self.win_width - self.gap_x, self.gap_y)
        else:
            self.move(1920 - self.win_width - self.gap_x, self.gap_y)

        # Poll every 100ms to ensure the second flips almost exactly on the system boundary
        GLib.timeout_add(100, self.update_time)
        self.update_time()

    def place(self, label, y):
        """
        Right-align a label to the window's edge, at the row it belongs on.
        Returns False before the window is shown, when a label has no width
        yet, so the caller knows to try again on the next tick.
        """
        _, natural = label.get_preferred_width()
        if natural <= 0:
            return False
        self.canvas.move(label, max(0, self.win_width - natural), y)
        return True

    def update_time(self):
        ink, ink2, sun = read_state()

        # time.strftime queries the OS kernel time directly, which chrony keeps perfectly synced.
        # Seconds at full size and weight, so the reference clock reads as one number;
        # AM/PM small and tracked after it, the way the page's tags are set.
        clock_str = time.strftime("%I:%M:%S")
        period = time.strftime("%p")
        date_str = time.strftime("%a %b ") + str(int(time.strftime("%d")))
        date_str = date_str.upper()

        if sun:
            date_line = (
                f'{GLib.markup_escape_text(date_str)}'
                f'<span alpha="55%"> // </span>'
                f'{GLib.markup_escape_text(sun.upper())}'
            )
        else:
            date_line = GLib.markup_escape_text(date_str)

        # A fixed HH:MM:SS face: changing digits never resizes the row.
        for index, char in enumerate(clock_str):
            markup = f'<span font="{self.time_font}" foreground="{ink}">{char}</span>'
            if markup != self.cell_markup[index]:
                self.cells[index].set_markup(markup)
                self.cell_markup[index] = markup

        # letter_spacing is in 1024ths of a point: 0.1em of 20pt for the period,
        # 0.18em of 13pt for the date line, as on the page.
        period_markup = (
            f'<span font="{FONT_PERIOD}" foreground="{ink}" letter_spacing="2048">{period}</span>'
        )
        if period_markup != self.period_markup:
            self.period_label.set_markup(period_markup)
            self.period_markup = period_markup

        date_markup = (
            f'<span font="{FONT_DATE}" foreground="{ink2}" letter_spacing="2400">{date_line}</span>'
        )

        # The date line is right-aligned by its own width, which changes with
        # the sun line; until the window is shown it has no width, so leave
        # the markup unrecorded and the next tick places it.
        if date_markup != self.last_markup:
            self.date_label.set_markup(date_markup)
            placed = self.place(self.date_label, self.date_y)
            self.last_markup = date_markup if placed else None

        return True


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)

    win = ClockWindow()
    win.show_all()
    Gtk.main()
