import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

let registeredModule

global.config = {
  locale: "en-US",
  language: "en",
}

global.Log = {
  warn: () => {},
  error: () => {},
  log: () => {},
}

global.Module = {
  register: (_name, definition) => {
    registeredModule = definition
  },
}

require("../../MMM-CalendarExt3Agenda.js")

const moduleDef = registeredModule

function makeRegularizeCtx(overrides = {}) {
  return {
    identifier: "module-1",
    config: { calendarSet: [] },
    defaultNotifications: moduleDef.defaultNotifications,
    ...overrides,
  }
}

function makeSocketRestoreCtx(overrides = {}) {
  return {
    identifier: "module-1",
    activeConfig: {},
    originalConfig: {},
    notifications: {},
    _functionsReady: () => {},
    ...overrides,
  }
}

function makeNotificationCtx(overrides = {}) {
  return {
    identifier: "module-1",
    defaultNotifications: moduleDef.defaultNotifications,
    notifications: {
      eventNotification: "CALENDAR_EVENTS",
      eventPayload: (p) => p,
      weatherNotification: "WEATHER_UPDATED",
      weatherPayload: (p) => p,
    },
    activeConfig: { instanceId: "module-1", animationSpeed: 123, showMiniMonthCalendarMonths: 1 },
    regularizeConfig: moduleDef.regularizeConfig,
    _applyWeatherUpdate: moduleDef._applyWeatherUpdate,
    _replyCurrentConfig: moduleDef._replyCurrentConfig,
    _handleConfigNotification: moduleDef._handleConfigNotification,
    updateDom: () => {},
    forecast: [],
    ...overrides,
  }
}

function makeFakeElement() {
  return {
    innerHTML: "",
    dataset: {},
    classList: {
      values: [],
      add(...classNames) {
        this.values.push(...classNames.filter(Boolean))
      },
      contains(className) {
        return this.values.includes(className)
      },
    },
    style: {
      setProperty() {},
    },
  }
}

function installFakeDocument() {
  const originalDocument = global.document
  global.document = {
    createElement: () => makeFakeElement(),
  }
  return () => {
    global.document = originalDocument
  }
}

describe("regularizeConfig", () => {
  test("should set default locale and instanceId when options are minimal", () => {
    const ctx = makeRegularizeCtx()

    const cfg = moduleDef.regularizeConfig.call(ctx, {
      calendarSet: [],
    })

    assert.equal(typeof cfg.locale, "string")
    assert.equal(cfg.instanceId, "module-1")
    // en-US has weekends [0, 6] (Sunday, Saturday)
    assert(Array.isArray(cfg.weekends))
  })

  test("should keep explicit calendarSet when provided", () => {
    const ctx = makeRegularizeCtx({ identifier: "module-2" })

    const calSet = ["cal-a", "cal-b"]
    const cfg = moduleDef.regularizeConfig.call(ctx, {
      calendarSet: calSet,
    })

    assert.deepEqual(cfg.calendarSet, calSet)
  })

  test("should clamp showMiniMonthCalendarMonths when value is out of range", () => {
    const ctx = makeRegularizeCtx()

    const low = moduleDef.regularizeConfig.call(ctx, {
      showMiniMonthCalendarMonths: 0,
    })
    const high = moduleDef.regularizeConfig.call(ctx, {
      showMiniMonthCalendarMonths: 99,
    })

    assert.equal(low.showMiniMonthCalendarMonths, 1)
    assert.equal(high.showMiniMonthCalendarMonths, 6)
  })

  test("should keep explicit week settings and normalize weekends when provided", () => {
    const ctx = makeRegularizeCtx()

    const cfg = moduleDef.regularizeConfig.call(ctx, {
      firstDayOfWeek: 0,
      minimalDaysOfNewYear: 1,
      weekends: [6, 7],
    })

    assert.equal(cfg.firstDayOfWeek, 0)
    assert.equal(cfg.minimalDaysOfNewYear, 1)
    assert.deepEqual(cfg.weekends, [6, 0])
  })

  test("should use default payload handlers when payload options are not functions", () => {
    const ctx = makeRegularizeCtx()

    moduleDef.regularizeConfig.call(ctx, {
      weatherPayload: "not-a-function",
      eventPayload: null,
    })

    assert.equal(ctx.notifications.weatherPayload, moduleDef.defaultNotifications.weatherPayload)
    assert.equal(ctx.notifications.eventPayload, moduleDef.defaultNotifications.eventPayload)
  })
})

describe("socketNotificationReceived", () => {
  test("should restore callback functions when payload belongs to current instance", () => {
    let readyCalls = 0
    const ctx = makeSocketRestoreCtx({
      _functionsReady: () => {
        readyCalls += 1
      },
    })

    // Contract test: all known config keys must be handled, including preProcessor.
    // If a key is added to node_helper but missing from configKeys here, the assertion fails.
    const allConfigKeys = ["preProcessor", "eventTransformer", "eventFilter", "eventSorter"]

    const functions = {}
    for (const key of allConfigKeys) {
      functions[key] = `() => "${key}"`
    }

    moduleDef.socketNotificationReceived.call(ctx, "CX3A_FUNCTIONS_RESTORED", {
      identifier: "module-1",
      variablePreamble: "",
      functions,
    })

    for (const key of allConfigKeys) {
      assert.equal(typeof ctx.activeConfig[key], "function", `${key} must be restored in activeConfig`)
      assert.equal(typeof ctx.originalConfig[key], "function", `${key} must be restored in originalConfig`)
    }
    assert.equal(readyCalls, 1)
  })

  test("should restore notification payload functions when provided", () => {
    let readyCalls = 0
    const ctx = makeSocketRestoreCtx({
      _functionsReady: () => {
        readyCalls += 1
      },
    })

    moduleDef.socketNotificationReceived.call(ctx, "CX3A_FUNCTIONS_RESTORED", {
      identifier: "module-1",
      variablePreamble: "",
      functions: {
        eventPayload: "(p) => ({ ...p, processed: true })",
        weatherPayload: "(p) => ({ ...p, weatherProcessed: true })",
      },
    })

    assert.equal(typeof ctx.notifications.eventPayload, "function")
    assert.equal(typeof ctx.notifications.weatherPayload, "function")
    assert.equal(ctx.notifications.eventPayload({ a: 1 }).processed, true)
    assert.equal(ctx.notifications.weatherPayload({ b: 2 }).weatherProcessed, true)
    assert.equal(readyCalls, 1)
  })

  test("should ignore restore payload when instance does not match", () => {
    let readyCalls = 0
    const ctx = makeSocketRestoreCtx({
      _functionsReady: () => {
        readyCalls += 1
      },
    })

    moduleDef.socketNotificationReceived.call(ctx, "CX3A_FUNCTIONS_RESTORED", {
      identifier: "module-2",
      variablePreamble: "",
      functions: {
        eventTransformer: "(ev) => ev",
      },
    })

    assert.equal(ctx.activeConfig.eventTransformer, undefined)
    assert.equal(ctx.originalConfig.eventTransformer, undefined)
    assert.equal(readyCalls, 0)
  })

  test("should restore functions with preamble closure context when provided", () => {
    let readyCalls = 0
    const ctx = makeSocketRestoreCtx({
      _functionsReady: () => {
        readyCalls += 1
      },
    })

    const preamble = `
let myVariable = { key: "test" };
const myHelper = (v) => v + "_modified";
  `

    moduleDef.socketNotificationReceived.call(ctx, "CX3A_FUNCTIONS_RESTORED", {
      identifier: "module-1",
      variablePreamble: preamble,
      functions: {
        eventFilter: "(ev) => ev.title === myVariable.key && myHelper(ev.title) === 'test_modified'",
      },
    })

    assert.equal(typeof ctx.activeConfig.eventFilter, "function")
    assert.equal(ctx.activeConfig.eventFilter({ title: "test" }), true)
    assert.equal(ctx.activeConfig.eventFilter({ title: "other" }), false)
    assert.equal(readyCalls, 1)
  })
})

describe("notificationReceived", () => {
  test("should ignore CX3A_SET_CONFIG when instanceId is mismatched", () => {
    let callbackCalls = 0
    let updateDomCalls = 0
    const ctx = makeNotificationCtx({
      activeConfig: { instanceId: "module-1", showMiniMonthCalendarMonths: 1 },
      updateDom: () => {
        updateDomCalls += 1
      },
    })

    moduleDef.notificationReceived.call(ctx, "CX3A_SET_CONFIG", {
      instanceId: "other-module",
      showMiniMonthCalendarMonths: 4,
      callback: () => {
        callbackCalls += 1
      },
    })

    assert.equal(ctx.activeConfig.showMiniMonthCalendarMonths, 1)
    assert.equal(updateDomCalls, 0)
    assert.equal(callbackCalls, 0)
  })

  test("should update config and return current config when receiving CX3A_SET_CONFIG", () => {
    let callbackArg = null
    let updateDomCalls = 0
    const ctx = makeNotificationCtx({
      activeConfig: { instanceId: "module-1", animationSpeed: 123, showMiniMonthCalendarMonths: 1 },
      updateDom: () => {
        updateDomCalls += 1
      },
    })

    moduleDef.notificationReceived.call(ctx, "CX3A_SET_CONFIG", {
      instanceId: "module-1",
      showMiniMonthCalendarMonths: 4,
      callback: (cfg) => {
        callbackArg = cfg
      },
    })

    assert.equal(ctx.activeConfig.showMiniMonthCalendarMonths, 4)
    assert.equal(updateDomCalls, 1)
    assert.equal(callbackArg, ctx.activeConfig)
  })

  test("should restore original config and call callback when receiving CX3A_RESET", () => {
    let callbackArg = null
    let updateDomCalls = 0
    const ctx = makeNotificationCtx({
      activeConfig: { instanceId: "module-1", animationSpeed: 123, showMiniMonthCalendarMonths: 4 },
      originalConfig: { instanceId: "module-1", animationSpeed: 123, showMiniMonthCalendarMonths: 2 },
      updateDom: () => {
        updateDomCalls += 1
      },
    })

    moduleDef.notificationReceived.call(ctx, "CX3A_RESET", {
      instanceId: "module-1",
      callback: (cfg) => {
        callbackArg = cfg
      },
    })

    assert.equal(ctx.activeConfig.showMiniMonthCalendarMonths, 2)
    assert.equal(updateDomCalls, 1)
    assert.equal(callbackArg, ctx.activeConfig)
  })

  test("should update forecast only when WEATHER_UPDATED location matches", () => {
    const ctx = makeNotificationCtx({
      activeConfig: {
        useWeather: true,
        weatherLocationName: "Berlin",
        instanceId: "module-1",
      },
    })

    moduleDef.notificationReceived.call(ctx, "WEATHER_UPDATED", {
      locationName: "Berlin, DE",
      forecastArray: [{ date: "2026-06-16T00:00:00.000Z", condition: "clear" }],
    })

    assert.equal(ctx.forecast.length, 1)
    assert.equal(typeof ctx.forecast[0].dateId, "string")

    moduleDef.notificationReceived.call(ctx, "WEATHER_UPDATED", {
      locationName: "Hamburg, DE",
      forecastArray: [{ date: "2026-06-17T00:00:00.000Z", condition: "rain" }],
    })

    assert.equal(ctx.forecast.length, 1)
    assert.equal(ctx.forecast[0].condition, "clear")
  })

  test("should convert forecast dates across month boundary when WEATHER_UPDATED matches", () => {
    const ctx = makeNotificationCtx({
      activeConfig: {
        useWeather: true,
        weatherLocationName: "Berlin",
        instanceId: "module-1",
      },
    })

    moduleDef.notificationReceived.call(ctx, "WEATHER_UPDATED", {
      locationName: "Berlin, DE",
      forecastArray: [
        { date: "2026-01-31T00:00:00.000Z", condition: "cold" },
        { date: "2026-02-01T00:00:00.000Z", condition: "sunny" },
      ],
    })

    assert.equal(ctx.forecast.length, 2)
    assert.match(ctx.forecast[0].dateId, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(ctx.forecast[1].dateId, /^\d{4}-\d{2}-\d{2}$/)
    assert.notEqual(ctx.forecast[0].dateId, ctx.forecast[1].dateId)
  })

  test("should preserve plain YYYY-MM-DD forecast dates without UTC day shifting", () => {
    const ctx = makeNotificationCtx({
      activeConfig: {
        useWeather: true,
        weatherLocationName: "Berlin",
        instanceId: "module-1",
      },
    })

    moduleDef.notificationReceived.call(ctx, "WEATHER_UPDATED", {
      locationName: "Berlin, DE",
      forecastArray: [{ date: "2026-02-01", condition: "sunny" }],
    })

    assert.equal(ctx.forecast.length, 1)
    assert.equal(ctx.forecast[0].dateId, "2026-02-01")
  })
})

describe("getDom", () => {
  test("should return minimal DOM and warn when module is not ready", () => {
    const restoreDocument = installFakeDocument()
    const originalWarn = global.Log.warn
    let warnCalls = 0
    global.Log.warn = () => {
      warnCalls += 1
    }

    try {
      const ctx = {
        instanceId: "module-1",
        activeConfig: { displayRepeatingCountTitle: true, fontSize: "16px" },
        library: { loaded: false },
        _ready: false,
      }

      const dom = moduleDef.getDom.call(ctx)

      assert.equal(dom.classList.contains("bodice"), true)
      assert.equal(dom.classList.contains("CX3A_module-1"), true)
      assert.equal(warnCalls, 1)
    } finally {
      global.Log.warn = originalWarn
      restoreDocument()
    }
  })

  test("should clear previous timer and schedule refresh when module is ready", () => {
    const restoreDocument = installFakeDocument()
    const originalSetTimeout = global.setTimeout
    const originalClearTimeout = global.clearTimeout
    const cleared = []
    let scheduledDelay = null
    let scheduledCallback = null

    global.clearTimeout = (id) => {
      cleared.push(id)
    }
    global.setTimeout = (callback, delay) => {
      scheduledCallback = callback
      scheduledDelay = delay
      return 99
    }

    try {
      let drawCalls = 0
      let updateDomCalls = 0
      const ctx = {
        instanceId: "module-1",
        activeConfig: {
          displayRepeatingCountTitle: false,
          refreshInterval: 555,
          animationSpeed: 123,
        },
        library: { loaded: true },
        _ready: true,
        refreshTimer: 42,
        draw: (dom) => {
          drawCalls += 1
          return dom
        },
        updateDom: () => {
          updateDomCalls += 1
        },
      }

      moduleDef.getDom.call(ctx)

      assert.equal(drawCalls, 1)
      assert.equal(cleared.includes(42), true)
      assert.equal(scheduledDelay, 555)
      assert.equal(ctx.refreshTimer, 99)

      scheduledCallback()
      assert.equal(updateDomCalls, 1)
      assert.equal(ctx.refreshTimer, null)
    } finally {
      global.setTimeout = originalSetTimeout
      global.clearTimeout = originalClearTimeout
      restoreDocument()
    }
  })
})
