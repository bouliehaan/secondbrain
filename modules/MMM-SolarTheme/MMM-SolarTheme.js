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
    }
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
  },

  getDom() {
    const wrapper = document.createElement("div");

    wrapper.style.display = "none";
    wrapper.setAttribute("aria-hidden", "true");

    return wrapper;
  }
});
