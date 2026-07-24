let config = {
  address: "127.0.0.1",
  port: 43761,
  basePath: "/",

  ipWhitelist: [
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "::1"
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

        fetchInterval: 15000,
        updateOnFetch: false,

        animationSpeed: 0,
        fade: false,
        displaySymbol: false,

        calendars: [
          {
            name: "personal",
            color: "#4EA1FF",
            symbol: [],
            url: "https://cloud.turgonomics.com/REDACTED_PRIVATE_PATH"
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
        refreshInterval: 15000,
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

    {
      module: "MMM-SecondBrain",
      position: "top_right",
      config: {
        pollIntervalMs: 3000,
        maxItems: 3,
        configDir: "/etc/magicmirror-secondbrain"
      }
    },
    {
      module: "MMM-CalendarExt3Agenda",
      position: "top_right",
      header: "UPCOMING",
      classes: "side-agenda",

      config: {
        instanceId: "upcomingAgenda",

        eventFilter: (ev) => { return ev.endDate > Date.now(); },

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
        refreshInterval: 15000,
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
