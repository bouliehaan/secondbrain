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

        calendars: [
          {
            name: "personal",
            color: "#4EA1FF",
            symbol: [],
            url: "https://cloud.example.com/REDACTED_PRIVATE_PATH"
          },

          {
            name: "holidays",
            color: "#FF5D73",
            symbol: [],
            url: "https://www.officeholidays.com/ics-fed/usa"
          },

          {
            name: "ufc",
            color: "#FFB84D",
            symbol: [],
            url: "https://raw.githubusercontent.com/clarencechaan/ufc-cal/ics/UFC.ics"
          },

          {
            name: "appointments",
            color: "#A879FF",
            symbol: [],
            url: "https://butterflytherapeutics.janeapp.com/REDACTED_PRIVATE_PATH"
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
        firstDayOfWeek: 0,
        minimalDaysOfNewYear: 1,
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

        fontSize: "16px",
        eventHeight: "21px",

        maxEventLines: {
          0: 6,
          4: 10,
          5: 7,
          6: 6
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
    {
      module: "clock",
      position: "top_right",
      classes: "side-clock clock",

      config: {
        displaySeconds: true,
        showPeriod: true,
        showDate: true
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
      header: "FLORISSANT",
      classes: "side-current-weather",

      config: {
        weatherProvider: "openmeteo",
        type: "current",

        lat: 38.9458249,
        lon: -105.2897,

        units: "imperial",
        roundTemp: true,
        degreeLabel: true,

        showHumidity: "below",
        showFeelsLike: true,
        showWindDirectionAsArrow: true,
        showSun: true,

        appendLocationNameToHeader: false,

        updateInterval: 900000,
        animationSpeed: 0,
        themeDir: "../../../modules/MMT-CalmCurrentWeather"
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

        lat: 38.9458249,
        lon: -105.2897,

        units: "imperial",
        roundTemp: true,
        degreeLabel: true,

        maxNumberOfDays: 5,
        showPrecipitationProbability: true,
        fade: false,

        appendLocationNameToHeader: false,

        updateInterval: 900000,
        initialLoadDelay: 1000,
        animationSpeed: 0
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
        maxItems: 3,
        maxPackageItems: 3,

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
      header: "UPCOMING",
      classes: "side-agenda",

      config: {
        instanceId: "upcomingAgenda",

        eventFilter: (ev) => {
          if (ev.isPassed) return false;
          return true;
        },

        locale: "en-US",
        firstDayOfWeek: 0,
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

        eventTimeOptions: {
          hour: "numeric",
          minute: "2-digit"
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
    {
      module: "MMM-SolarTheme",
      config: {
        lightAfterSunriseMinutes: 30,
        darkBeforeSunsetMinutes: 20,
        fallbackLightTime: "07:00",
        fallbackDarkTime: "19:00"
      }
    },
    {
      module: "MMM-CalendarLiveHeader",
      config: {
        name: "Jake",
        lookAheadHours: 12
      }
    },
  ]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") {
  module.exports = config;
}
