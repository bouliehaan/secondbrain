let config = {
  address: "0.0.0.0",
  port: 43761,
  basePath: "/",

  ipWhitelist: [
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "::1",
    "192.168.1.0/24",
    "::ffff:192.168.1.0/24"
  ],

  language: "en",
  locale: "en-US",

  /*
   * 12-hour with AM/PM throughout: the native clock, the schedule, the header
   * status, the status line. The reference clock reads 3:42:07 PM and
   * everything else agrees with it.
   */
  timeFormat: 12,
  units: "imperial",

  modules: [
    /*
     * Hidden data source for both the month grid and upcoming agenda.
     * With no position assigned, it runs without displaying its own list.
     */
    {
      module: "calendar",

      config: {
        broadcastEvents: true,
        broadcastPastEvents: true,
        pastDaysCount: 45,

        maximumEntries: 100,
        maximumNumberOfDays: 365,

        fetchInterval: 900000,
        updateOnFetch: false,

        animationSpeed: 0,
        fade: false,
        displaySymbol: false,

        /*
         * The one place the wall's chrome lets colour in: each event carries
         * its calendar's colour as a 4px edge, and nothing else. The busiest
         * calendar gets the neutral grey on purpose -- six routine events a
         * day in any colour is a wall of that colour -- so a coloured edge
         * marks the things that are not routine. The two colours are dusty
         * and warm, mission control rather than school planner, picked
         * against the dark ground; custom.css deepens them a shade by day.
         */
        calendars: [
          {
            name: "personal",
            color: "#9d9ea0",   /* neutral: the routine, in secondary ink */
            symbol: [],
            url: "https://cloud.example.com/REDACTED_PRIVATE_PATH"
          },

          {
            name: "holidays",
            color: "#C4AD86",   /* sand */
            symbol: [],
            url: "https://www.officeholidays.com/ics-fed/usa"
          },

          {
            name: "ufc",
            color: "#CF7A3E",   /* dusty orange */
            symbol: [],
            url: "https://raw.githubusercontent.com/clarencechaan/ufc-cal/ics/UFC.ics"
          },

          {
            name: "appointments",
            color: "#D9B54A",   /* dusty yellow */
            symbol: [],
            url: "https://booking.example.com/REDACTED_PRIVATE_PATH"
          }
        ]
      }
    },

    /*
     * Large month calendar occupying the left three quarters.
     */
    {
      module: "MMM-CalendarExt3",
      position: "bottom_bar",
      classes: "main-month-calendar",
      title: "",

      config: {
        mode: "month",
        instanceId: "wallCalendar",

        locale: "en-US",

        /*
         * Monday first, against the en-US locale: the week the wall shows is
         * the one the household keeps, and each row is then an ISO week.
         */
        firstDayOfWeek: 1,

        /*
         * The ISO week number in each row is written by MMM-CalendarLiveHeader
         * from the Monday cell's date. With Monday first and four minimal days
         * CalendarExt3's own numbering would agree, but it stays switched off
         * so the number is written once, in one place.
         */
        minimalDaysOfNewYear: 4,
        showWeekNumber: false,

        customHeader: true,

        headerTitleOptions: {
          month: "long",
          year: "numeric"
        },

        headerWeekDayOptions: {
          weekday: "short"
        },

        cellDateOptions: {
          day: "numeric"
        },

        eventTimeOptions: {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        },

        fontSize: "18px",
        eventHeight: "24px",

        /*
         * Rows share a week's height equally, so this is how many 24px lines
         * fit under a 38px cell header in a four-, five- or six-row month at
         * 1080p. This calendar runs to six events a day.
         */
        maxEventLines: {
          0: 6,
          4: 8,
          5: 6,
          6: 5
        },

        dynamicWeekHeight: false,

        useSymbol: false,
        useIconify: false,
        useWeather: false,
        useMarquee: false,

        displayLegend: false,
        displayEndTime: false,
        showMore: true,
        skipDuplicated: true,

        calendarSet: [
          "personal",
          "holidays",
          "ufc",
          "appointments"
        ],

        waitFetch: 3000,
        refreshInterval: 60000,
        animationSpeed: 0
      }
    },

    /*
     * Right-hand information rail.
     * Modules appear in this same order from top to bottom.
     */
    /*
     * Kept for its layout space and hidden by custom.css. The visible clock
     * is the native GTK overlay (clock/magicmirror-python-clock.py), which
     * draws the same format at the same size, so what this reserves is what
     * that fills.
     */
    {
      module: "clock",
      position: "top_right",
      classes: "side-clock clock",

      config: {
        displaySeconds: true,
        showPeriod: true,
        showPeriodUpper: true,
        showDate: true,
        dateFormat: "ddd MMM D"
      }
    },

    /*
     * Drip-the-faucets alert. Reads the two weather modules below rather than
     * fetching anything of its own, so it can never disagree with the numbers
     * shown further down the rail.
     *
     * It sits directly under the clock because when it has something to say it
     * is the most important thing in the rail, and because it is absent for
     * most of the year -- nothing is displaced by a card that is not there.
     */
    {
      module: "FreezeWatch",
      position: "top_right",
      classes: "side-freezewatch",

      config: {
        /*
         * Degrees Fahrenheit. Below this the wall says something: a quiet
         * watch when the forecast low is coming, a louder warning when it is
         * already this cold outside. Raise it for more margin -- the common
         * advice for exposed pipes is nearer 20.
         */
        thresholdF: 15,

        /*
         * It has to warm up this much before the card comes down. Without it a
         * temperature parked on the threshold blinks the card on and off all
         * night, which on a wall is a light flickering in the corner of the
         * room.
         */
        clearMarginF: 2,

        /*
         * How far ahead a forecast low may raise a watch. 36 hours covers
         * tonight and, late in the evening, tomorrow night. Raising it puts
         * the card up days early and leaves it up for the whole cold snap,
         * which is the fastest way to make it stop being read.
         */
        lookaheadHours: 36,

        /*
         * A stale reading keeps its card and says how old it is, because
         * failing to drip costs more than dripping needlessly. Past
         * giveUpAfterHours it stops claiming to know the weather at all.
         */
        staleAfterMinutes: 90,
        giveUpAfterHours: 6
      }
    },

    {
      module: "weather",
      position: "top_right",
      header: "WEATHER",
      classes: "side-current-weather",

      config: {
        weatherProvider: "openmeteo",
        type: "current",

        lat: 40.7128,
        lon: -74.006,

        units: "imperial",
        roundTemp: true,
        degreeLabel: false,

        showHumidity: "below",
        showFeelsLike: true,
        showWindDirection: true,
        showSun: true,
        showPeriod: false,

        appendLocationNameToHeader: false,

        updateInterval: 900000,
        animationSpeed: 0,

        /*
         * The card's DOM and its stylesheet live in modules/WeatherTheme, in
         * this repo. The stock weather module resolves this as a URL from its
         * own directory, and the browser clamps ".." at the site root, so
         * three levels up lands on /modules/ whether the module lives at
         * defaultmodules/weather (2.37) or modules/default/weather (older).
         */
        themeDir: "../../../modules/WeatherTheme"
      }
    },

    {
      module: "weather",
      position: "top_right",
      header: "FORECAST",
      classes: "side-forecast",

      config: {
        weatherProvider: "openmeteo",
        type: "forecast",

        lat: 40.7128,
        lon: -74.006,

        units: "imperial",
        roundTemp: true,
        degreeLabel: false,

        /* Offer a full week; Rail shows only the whole rows that fit. */
        maxNumberOfDays: 7,
        showPrecipitationProbability: true,
        fade: false,

        appendLocationNameToHeader: false,

        updateInterval: 900000,
        initialLoadDelay: 1000,
        animationSpeed: 0,

        themeDir: "../../../modules/WeatherTheme"
      }
    },

    /*
     * What samo-radio is playing, if anything. The card hides itself whenever
     * the device is idle, unreachable or unconfigured, so it costs nothing in
     * the rail when the room is quiet.
     *
     * It sits with the other ambient status above, rather than below the
     * notifications, so that a card appearing does not shove unread mail down
     * the wall every time the radio comes on.
     */
    {
      module: "NowPlaying",
      position: "top_right",
      classes: "side-nowplaying",

      config: {
        /*
         * The samo-radio daemon refreshes its own channel metadata every 10s,
         * so this is as fresh as the answer can be. It is a loopback call to
         * samo-server on this same box and shares nothing with the mail poll --
         * a stalled IMAP session cannot freeze this card, and this card cannot
         * delay a text message.
         */
        pollIntervalMs: 10000,

        showAlbum: true,
        showArtwork: true,

        /*
         * The rows under the card: when this gives way and to what. The
         * channel's next booked block ("NEXT 4:00 PM All Things Considered"),
         * the end of the block it is in ("UNTIL 9:00 AM"), the next item of
         * a cast queue, the station the radio returns to when a queue runs
         * out, a station's next programme where one is published (the BBC's
         * is, from the stream URL alone; NPR Composer stations by id, see
         * samo.example.json), and a row of small covers for the episodes the
         * channel owes, in the order it means to play them. Never the next
         * track on a channel: the scheduler does not pick it until the
         * current one ends. The rail drops all of this before anything else,
         * so it never costs an event or a card.
         */
        showUpNext: true,

        configDir: "/etc/magicmirror-secondbrain"
      }
    },

    {
      module: "MMM-SecondBrain",
      position: "top_right",
      config: {
        /*
         * Each poll opens a fresh IMAP session per account. The node helper
         * clamps anything below 60s, so do not lower this to chase latency --
         * it only earns a throttle from Gmail.
         */
        pollIntervalMs: 60000,

        /*
         * How many of each kind the module offers the rail: texts and mail,
         * packages, downloads. The rail keeps one of each on the wall and
         * gives the rest whatever room is left, in its ladder's order --
         * extra downloads last of the cards, so a second torrent is on the
         * wall only when every other card and the week's weather already
         * are, and only tomorrow's schedule waits behind it.
         */
        maxItems: 3,
        maxPackageItems: 3,
        maxDownloadItems: 3,

        /*
         * How long a shipment stays on the wall after the last mail about it.
         * The mail itself lingers in All Mail for a week, so this -- not the
         * scan window -- is what decides when a package card goes away. Lower
         * it if shipments outstay their welcome.
         */
        packageStaleAfterHours: 36,

        configDir: "/etc/magicmirror-secondbrain",
        stateDir: "/var/lib/magicmirror-secondbrain"
      }
    },
    {
      module: "MMM-CalendarExt3Agenda",
      position: "top_right",
      header: "SCHEDULE",
      classes: "side-agenda",

      config: {
        instanceId: "upcomingAgenda",

        eventFilter: (ev) => {
          if (ev.isPassed) return false;
          return true;
        },

        locale: "en-US",
        firstDayOfWeek: 1,
        minimalDaysOfNewYear: 1,

        startDayIndex: 0,
        endDayIndex: 30,

        /*
         * Show the next six days that actually contain events,
         * rather than wasting room on empty days.
         */
        onlyEventDays: 0,

        showMiniMonthCalendar: false,
        showMultidayEventsOnce: true,

        useSymbol: false,
        useWeather: false,

        skipDuplicated: true,
        relativeNamedDayStyle: "short",

        /*
         * The weekday is in here so custom.css can show it at the left of
         * days that are not today or tomorrow; the agenda itself would only
         * count ("in 2 days").
         */
        cellDateOptions: {
          weekday: "short",
          month: "short",
          day: "numeric"
        },

        eventTimeOptions: {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        },

        calendarSet: [
          "personal",
          "holidays",
          "ufc",
          "appointments"
        ],

        waitFetch: 3000,
        refreshInterval: 60000,
        animationSpeed: 0
      }
    },

    /*
     * The line under the month grid: each source's last result, the last
     * poll and how long it took, NTP lock, uptime. It reads what the other
     * modules already know and probes the calendar feeds itself, because a
     * calendar that 404s is otherwise invisible -- the grid just stops
     * changing. See docs/MODULES.md.
     */
    {
      module: "StatusLine",
      position: "bottom_left",

      config: {
        /* How often the calendar feeds are probed. Fifteen minutes, like the fetch. */
        probeIntervalMs: 900000
      }
    },

    /*
     * The rail's layout. Reads the rail after every change to it and hides
     * whole items -- forecast rows, cards, days, events, and when it comes
     * to it whole blocks -- so that the schedule always lists the rest of
     * today, whole, every card stack keeps a card, and nothing ends mid-row.
     * Today is the floor of the rail: nothing above it may cost it a row,
     * and only the clock is never moved for it. The order things are added
     * in, and the order they give way in when even that does not fit, are
     * the defaults in modules/Rail/lib/rail.js; override any of the three
     * here. See docs/MODULES.md.
     */
    {
      module: "Rail",
      config: {
        /*
         * Where the space left after the minimums goes, a rung at a time.
         * Today is the floor and tomorrow is the leftover: everything
         * between them goes up whole, in order, and the schedule beyond
         * today takes what that leaves. Every text there is, then the
         * week's weather, then what the radio does next and the covers of
         * the episodes the channel owes, then every package, the radio's
         * second row, every download, and only then tomorrow, the day
         * after, and on down. A rung that does not fit whole takes the
         * items that do and is closed. Texts are first because a text is
         * on the wall nowhere else and gone in an hour; tomorrow is last
         * because it is on the grid to the left, and the order that once
         * put it ahead of the forecast's second row cut the week's weather
         * to a row or two on any ordinary day.
         */
        ladder: [
          ["messages", "all"],
          ["forecast", "all"],
          ["upnext", 1],
          ["due", 1],
          ["inbound", "all"],
          ["upnext", "all"],
          ["transfers", "all"],
          ["schedule", "all"]
        ],

        /*
         * What goes, first to last, on a day so full that today's events and
         * one card of each kind do not fit together. The cards one at a
         * time, a text the last of them; then the radio card whole, then the
         * weather, then the freeze warning. Today's events are not on this
         * list and cannot be put on it: the rest of today is always listed
         * whole, and the only thing that never moves for it is the clock.
         */
        sacrifice: ["transfers", "inbound", "forecast", "nowplaying", "messages", "weather", "freeze"]
      }
    },

    {
      module: "MMM-SolarTheme",
      config: {
        lightAfterSunriseMinutes: 0,
        darkBeforeSunsetMinutes: 20,
        fallbackLightTime: "07:00",
        fallbackDarkTime: "19:00"
      }
    },
    {
      module: "MMM-CalendarLiveHeader",
      config: {
        lookAheadHours: 12
      }
    },
  ]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = config;
}
