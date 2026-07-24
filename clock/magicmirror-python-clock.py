#!/usr/bin/env python3
import gi
import time
import os
import signal

# Force Mountain Time
os.environ['TZ'] = 'America/Denver'
time.tzset()

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib, Pango

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
        
        self.label = Gtk.Label()
        # The base font is applied, but markup overrides it specifically
        font_desc = Pango.FontDescription("Ubuntu 32")
        self.label.modify_font(font_desc)
        self.label.set_justify(Gtk.Justification.RIGHT)
        self.label.set_halign(Gtk.Align.END)
        self.label.set_valign(Gtk.Align.START)
        
        # 30px margin precisely matches the MagicMirror UI padding
        self.gap_x = 30
        self.gap_y = 30
        self.win_width = 400
        self.win_height = 120
        
        self.add(self.label)
        self.connect("draw", self.on_draw)
        
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

    def on_draw(self, widget, cr):
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(1)
        cr.paint()
        return False

    def update_time(self):
        color_hex = "#FFFFFF"
        try:
            with open("/tmp/magicmirror-clock-color", "r") as f:
                if "000000" in f.read():
                    color_hex = "#000000"
        except Exception:
            pass
            
        # time.strftime queries the OS kernel time directly, which chrony keeps perfectly synced.
        date_str = time.strftime("%A, %b %d").upper()
        hour_min = time.strftime("%I:%M").lstrip('0')
        sec = time.strftime("%S")
        pm = time.strftime("%p")
        
        display_str = (f'<span font="Ubuntu 16" weight="normal">{date_str}</span>\n'
                       f'<span font="Ubuntu Bold 32">{hour_min}:<span size="smaller">{sec}</span> <span size="smaller">{pm}</span></span>')
        
        # Only trigger a GTK redraw if the time has actually ticked to the next second
        # or if the color changed.
        full_markup = f'<span foreground="{color_hex}">{display_str}</span>'
        if not hasattr(self, 'last_markup') or self.last_markup != full_markup:
            self.label.set_markup(full_markup)
            self.last_markup = full_markup
            
        return True

if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    
    win = ClockWindow()
    win.show_all()
    Gtk.main()
