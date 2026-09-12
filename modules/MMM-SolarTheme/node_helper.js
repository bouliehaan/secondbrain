const NodeHelper = require("node_helper");
const fs = require("fs");

/*
 * Hands the page's theme to the native clock.
 *
 * The clock (clock/magicmirror-python-clock.py) is a GTK window above the
 * browser and cannot see the page, so the page tells it what to look like
 * through a file it reads on every tick: the ink colours of the theme in
 * force and the next sun event for its date line. The old one-colour file is
 * still written, so a clock that has not been updated keeps inverting by day.
 */
const STATE_FILE = "/tmp/magicmirror-clock-state";
const LEGACY_COLOR_FILE = "/tmp/magicmirror-clock-color";

module.exports = NodeHelper.create({
  start () {
    this.lastState = null;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "THEME_CHANGED") {
      const isLight = payload === "light";
      const colorHex = isLight ? "#000000" : "#FFFFFF";
      const colorOutput = `\${color ${colorHex}}`;

      fs.writeFile(LEGACY_COLOR_FILE, colorOutput, (err) => {
        if (err) {
          console.error("[MMM-SolarTheme] Error writing clock color to " + LEGACY_COLOR_FILE, err);
        }
      });

      return;
    }

    if (notification === "CLOCK_STATE" && payload) {
      const state = JSON.stringify({
        theme: payload.theme === "light" ? "light" : "dark",
        ink: String(payload.ink || "#eeeff0"),
        ink2: String(payload.ink2 || "#9d9ea0"),
        sun: String(payload.sun || "")
      });

      /* The clock re-reads this ten times a second; only rewrite on change. */
      if (state === this.lastState) {
        return;
      }

      this.lastState = state;

      fs.writeFile(STATE_FILE, state, (err) => {
        if (err) {
          console.error("[MMM-SolarTheme] Error writing clock state to " + STATE_FILE, err);
        }
      });
    }
  }
});
