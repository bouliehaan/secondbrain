/* global Module */

/*
 * Holidays: the federal holidays and the fun days, as feeds for the wall's
 * calendar.
 *
 * Nothing is drawn here, so this module has no position in config.js. All the
 * work happens in node_helper.js, which serves the feeds that the "holidays"
 * and "fun" calendars read. MagicMirror only starts a helper for a module
 * listed in the config, and that is the only reason this file exists.
 */

Module.register("Holidays", {});
