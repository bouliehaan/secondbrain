"use strict";

/*
 * Serves the holiday feeds as iCalendar on the wall's own server.
 *
 * The stock calendar module can only fetch a url, so this gives it two:
 *
 *   http://127.0.0.1:43761/holidays/us-federal.ics   the "holidays" calendar
 *   http://127.0.0.1:43761/holidays/fun-days.ics     the "fun" calendar
 *
 * Every date comes from lib/, so nothing here can hang, run out of years,
 * or go down. The routes are registered when the server starts, before the
 * kiosk's page loads and asks the calendar module to fetch them.
 */

const NodeHelper = require("node_helper");
const federal = require("./lib/federal");
const funDays = require("./lib/fun-days");

const FEEDS = [federal, funDays];

module.exports = NodeHelper.create({
  start () {
    if (!this.expressApp) {
      console.error("[Holidays] No web server to serve the feeds from; the holidays and fun calendars will 404.");
      return;
    }

    for (const feed of FEEDS) {
      this.expressApp.get(feed.FEED_PATH, (req, res) => {
        try {
          res.set("Content-Type", "text/calendar; charset=utf-8");
          res.set("Cache-Control", "no-cache");
          res.send(feed.calendar(new Date()));
        } catch (error) {
          console.error(`[Holidays] Could not build ${feed.FEED_PATH}: ${error.stack || error.message}`);
          res.status(500).send("holidays feed failed\n");
        }
      });
    }

    console.log(`[Holidays] Serving ${FEEDS.map((f) => f.FEED_PATH).join(" and ")}.`);
  }
});
