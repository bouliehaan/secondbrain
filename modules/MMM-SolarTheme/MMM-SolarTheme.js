Module.register("MMM-SolarTheme", {
  defaults: {
    lightAfterSunriseMinutes: 30,
    darkBeforeSunsetMinutes: 20,

    /*
     * These are used only during startup or if the weather provider
     * temporarily fails to return sunrise and sunset information.
     */
    fallbackLightTime: "07:00",
    fallbackDarkTime: "19:00",

    checkIntervalMilliseconds: 15 * 1000,
    transitionMilliseconds: 1400
  },

  start() {
    this.sunrise = null;
    this.sunset = null;
    this.currentTheme = null;

    const root = document.documentElement;

    root.classList.add("solar-theme-enabled");

    root.style.setProperty(
      "--solar-theme-transition",
      `${this.config.transitionMilliseconds}ms`
    );

    /*
     * Apply the fallback immediately so a daytime restart does not remain
     * dark while the weather module performs its first network request.
     */
    this.applyTheme();

    this.themeTimer = window.setInterval(
      () => this.applyTheme(),
      this.config.checkIntervalMilliseconds
    );
  },

  notificationReceived(notification, payload) {
    if (
      notification !== "WEATHER_UPDATED" ||
      !payload ||
      !payload.currentWeather
    ) {
      return;
    }

    const sunrise = this.parseTimestamp(
      payload.currentWeather.sunrise
    );

    const sunset = this.parseTimestamp(
      payload.currentWeather.sunset
    );

    if (
      Number.isFinite(sunrise) &&
      Number.isFinite(sunset) &&
      sunrise > 0 &&
      sunset > sunrise
    ) {
      this.sunrise = sunrise;
      this.sunset = sunset;

      this.applyTheme();
      this.sendClockState();
    }
  },

  /*
   * What the native clock should draw: the page's ink colours for the theme
   * in force, and the next sun event as a line of text. The helper writes it
   * to a file the clock reads on every tick, so the clock inverts with the
   * page and its date line says "SUNSET 7:14 PM" until the sun goes down, then
   * "SUNRISE 6:38 AM". Sent on every theme check (every fifteen seconds) and
   * every weather update; the helper only rewrites the file when the
   * contents differ.
   */
  sendClockState() {
    const light = this.currentTheme === "light";
    const now = Date.now();

    let sun = "";

    if (Number.isFinite(this.sunrise) && Number.isFinite(this.sunset)) {
      const time = (timestamp) =>
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true
        }).format(new Date(timestamp));

      if (now < this.sunrise) {
        sun = `Sunrise ${time(this.sunrise)}`;
      } else if (now < this.sunset) {
        sun = `Sunset ${time(this.sunset)}`;
      } else {
        /*
         * After sunset the provider still reports today's sunrise. Tomorrow's
         * is within a minute or two of it at this latitude, and the wall
         * would rather say "SUNRISE 6:38 AM" than nothing all evening.
         */
        sun = `Sunrise ${time(this.sunrise + 24 * 60 * 60 * 1000)}`;
      }
    }

    this.sendSocketNotification("CLOCK_STATE", {
      theme: light ? "light" : "dark",
      ink: light ? "#0c0c0d" : "#eeeff0",
      ink2: light ? "#5a5a5c" : "#9d9ea0",
      sun
    });
  },

  parseTimestamp(value) {
    if (value === null || value === undefined) {
      return null;
    }

    const numericValue = Number(value);

    if (
      Number.isFinite(numericValue) &&
      numericValue > 0
    ) {
      return numericValue;
    }

    const parsedValue = Date.parse(value);

    return Number.isFinite(parsedValue)
      ? parsedValue
      : null;
  },

  parseClockTime(value, referenceDate) {
    if (
      typeof value !== "string" ||
      !/^\d{1,2}:\d{2}$/.test(value)
    ) {
      return null;
    }

    const [hours, minutes] = value
      .split(":")
      .map(Number);

    if (
      !Number.isInteger(hours) ||
      !Number.isInteger(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return null;
    }

    const result = new Date(referenceDate);

    result.setHours(hours, minutes, 0, 0);

    return result.getTime();
  },

  fallbackThemeIsLight(now) {
    const currentDate = new Date(now);

    const lightAt = this.parseClockTime(
      this.config.fallbackLightTime,
      currentDate
    );

    const darkAt = this.parseClockTime(
      this.config.fallbackDarkTime,
      currentDate
    );

    if (
      !Number.isFinite(lightAt) ||
      !Number.isFinite(darkAt)
    ) {
      return false;
    }

    if (lightAt < darkAt) {
      return now >= lightAt && now < darkAt;
    }

    /*
     * Also supports an unusual daytime period that crosses midnight.
     */
    return now >= lightAt || now < darkAt;
  },

  themeIsLight(now) {
    if (
      Number.isFinite(this.sunrise) &&
      Number.isFinite(this.sunset)
    ) {
      const lightAt =
        this.sunrise +
        this.config.lightAfterSunriseMinutes * 60 * 1000;

      const darkAt =
        this.sunset -
        this.config.darkBeforeSunsetMinutes * 60 * 1000;

      if (darkAt > lightAt) {
        return now >= lightAt && now < darkAt;
      }
    }

    return this.fallbackThemeIsLight(now);
  },

  applyTheme() {
    const now = Date.now();
    const lightMode = this.themeIsLight(now);
    const nextTheme = lightMode ? "light" : "dark";

    const root = document.documentElement;

    root.classList.toggle(
      "solar-light",
      lightMode
    );

    root.classList.toggle(
      "solar-dark",
      !lightMode
    );

    root.dataset.solarTheme = nextTheme;

    if (this.currentTheme !== nextTheme) {
      this.currentTheme = nextTheme;

      Log.info(
        `[MMM-SolarTheme] Applied ${nextTheme} mode.`
      );
      this.sendSocketNotification("THEME_CHANGED", nextTheme);
    }

    /*
     * Every check, not just on a change: the sun line flips at sunset itself,
     * twenty minutes after the theme did. The helper ignores repeats.
     */
    this.sendClockState();
  },

  getDom() {
    const wrapper = document.createElement("div");

    wrapper.style.display = "none";
    wrapper.setAttribute("aria-hidden", "true");

    return wrapper;
  }
});
