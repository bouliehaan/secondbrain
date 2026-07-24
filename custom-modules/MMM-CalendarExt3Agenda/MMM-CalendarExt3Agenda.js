/* global config Module Log */

function normalizeNotifications(options, defaultNotifications = {}) {
  return {
    weatherNotification: options.weatherNotification ?? defaultNotifications.weatherNotification,
    weatherPayload: (typeof options.weatherPayload === 'function') ? options.weatherPayload : defaultNotifications.weatherPayload,
    eventNotification: options.eventNotification ?? defaultNotifications.eventNotification,
    eventPayload: (typeof options.eventPayload === 'function') ? options.eventPayload : defaultNotifications.eventPayload,
  }
}

function isSameDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  )
}

function isEventOverlapping(ev, startTime, endTime) {
  return !(ev.endDate <= startTime || ev.startDate >= endTime)
}

function getDisplayDayTimeForEvent(ev, showMultidayEventsOnce, viewStartTime) {
  if (!(showMultidayEventsOnce && ev.isMultiday)) return null
  const startDay = new Date(+ev.startDate)
  const normalizedStartDay = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate()).getTime()
  if (viewStartTime === null) return normalizedStartDay
  // When the event started before the current view window, pin it to the first visible day.
  return Math.max(normalizedStartDay, viewStartTime)
}

function splitVisibleEventsByType(visibleEvents, showMultidayEventsOnce) {
  return visibleEvents.reduce((result, ev) => {
    const target = (showMultidayEventsOnce && ev.isMultiday)
      ? result.mvs
      : ((ev.isFullday) ? result.fevs : result.sevs)
    target.push(ev)
    return result
  }, { mvs: [], fevs: [], sevs: [] })
}

function getDateKey(dateInput) {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput
  }

  const d = new Date(dateInput)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getEventsByDate({ events, startTime, dayCounts }) {
  const groupedByDate = events.reduce((days, ev) => {
    let st = new Date(+ev.startDate)
    const et = new Date(+ev.endDate)
    if (et.getTime() <= startTime) return days

    while (st.getTime() < et.getTime()) {
      const day = new Date(st.getFullYear(), st.getMonth(), st.getDate(), 0, 0, 0, 0).getTime()
      if (!days.has(day)) days.set(day, [])
      days.get(day).push(ev)
      st.setDate(st.getDate() + 1)
    }
    return days
  }, new Map())

  const startDay = new Date(+startTime).setHours(0, 0, 0, 0)
  const days = Array.from(groupedByDate.keys()).sort()
  const position = days.findIndex((d) => d >= startDay)

  return days.slice(position, position + dayCounts).map((d) => {
    return {
      date: d,
      events: groupedByDate.get(d)
    }
  })
}

Module.register('MMM-CalendarExt3Agenda', {
  requiresVersion: '2.36.0',
  defaults: {
    locale: null, // 'de' or 'en-US' or prefer array like ['en-CA', 'en-US', 'en']
    calendarSet: [],
    startDayIndex: 0,
    endDayIndex: 10,
    onlyEventDays: 0, // 0: show all days regardless of events, n: show only n days which have events.
    instanceId: null,
    firstDayOfWeek: null, // 0: Sunday, 1: Monday
    minimalDaysOfNewYear: null, // When the first week of new year starts in your country.
    cellDateOptions: {
      month: 'short',
      day: 'numeric',
      weekday: 'long'
    },
    eventTimeOptions: {
      timeStyle: 'short'
    },
    eventFilter: () => { return true },
    eventTransformer: (ev) => { return ev },
    displayRepeatingCountTitle: true,
    refreshInterval: 1000 * 60 * 30,
    waitFetch: 1000 *  5,
    animationSpeed: 1000,
    useSymbol: true,
    useWeather: true,
    weatherLocationName: null,
    showMiniMonthCalendar: true,
    showMiniMonthCalendarMonths: 1,
    miniMonthTitleOptions: {
      month: 'long',
      year: 'numeric'
    },
    miniMonthWeekdayOptions: {
      weekday: 'short'
    },
    //notification: 'CALENDAR_EVENTS',
    weatherNotification: 'WEATHER_UPDATED',
    weatherPayload: (payload) => { return payload },
    eventNotification: 'CALENDAR_EVENTS',
    eventPayload: (payload) => { return payload },
    useIconify: false,
    weekends: [],

    skipDuplicated: true,
    relativeNamedDayStyle: "narrow", // "narrow" or "short" or "long"
    showMultidayEventsOnce: false,
    multidayRangeLabelOptions: {
      month: 'short',
      day: 'numeric'
    },
  },

  defaultNotifications: {
    weatherNotification: 'WEATHER_UPDATED',
    weatherPayload: (payload) => { return payload },
    eventNotification: 'CALENDAR_EVENTS',
    eventPayload: (payload) => { return payload },
  },

  getStyles: function () {
    return ['MMM-CalendarExt3Agenda.css']
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "CX3A_FUNCTIONS_RESTORED") return
    if (payload.identifier !== this.identifier) return

    const configKeys = ["preProcessor", "eventTransformer", "eventFilter", "eventSorter"]
    const notificationKeys = ["eventPayload", "weatherPayload"]
    const preamble = payload.variablePreamble || ""

    for (const key of [...configKeys, ...notificationKeys]) {
      if (!payload.functions[key]) continue
      try {
        // Create a function factory that first evaluates the variable preamble
        // (declaring all variables in its scope), then returns the callback function.
        // The callback function now has access to those variables through closure.
        const fnFactory = new Function(preamble + "\nreturn " + payload.functions[key])
        const fn = fnFactory()

        if (typeof fn !== "function") continue
        if (configKeys.includes(key)) {
          this.activeConfig[key] = fn
          this.originalConfig[key] = fn
        }
        if (notificationKeys.includes(key)) {
          this.notifications[key] = fn
        }
      } catch (error) {
        Log.warn(`[CX3A] Could not restore config function "${key}":`, error.message)
      }
    }

    this._functionsReady()
  },

  regularizeConfig: function (options) {
    const fallbackWeekInfo = {
      firstDay: 1,
      minimalDays: 4,
      weekend: [6, 7]
    }

    options.locale = Intl.getCanonicalLocales(options.locale ?? config?.locale ?? config?.language)?.[ 0 ] ?? ''
    const weekInfo = {
      ...fallbackWeekInfo,
      ...(new Intl.Locale(options.locale).weekInfo ?? {})
    }
    const weekends = (Array.isArray(options.weekends) && options.weekends.length)
      ? options.weekends
      : weekInfo.weekend

    options.firstDayOfWeek = options.firstDayOfWeek ?? weekInfo.firstDay
    options.minimalDaysOfNewYear = options.minimalDaysOfNewYear ?? weekInfo.minimalDays
    options.weekends = weekends.map(day => day % 7)

    options.instanceId = options.instanceId ?? this.identifier
    options.showMiniMonthCalendarMonths = Math.max(1, Math.min(options.showMiniMonthCalendarMonths ?? 1, 6))
    this.notifications = normalizeNotifications(options, this.defaultNotifications)

    return options
  },

  start: function () {
    this.activeConfig = this.regularizeConfig({ ...this.config })
    this.originalConfig = { ...this.activeConfig }

    this.eventPool = new Map() // All the events
    //this.storedEvents = [] // regularized active events
    this.forecast = []

    this.refreshTimer = null

    this._ready = false
    const _functionsRestored = new Promise((resolve) => {
      this._functionsReady = resolve
      setTimeout(resolve, 5000)
    })
    this.sendSocketNotification("CX3A_REGISTER", { identifier: this.identifier })

    let _moduleLoaded = new Promise((resolve, reject) => {
      import('/' + this.file('CX3_Shared/CX3_shared.mjs')).then((m) => {
        this.library = m
        //this.library.initModule(this)
        if (this.activeConfig.useIconify) this.library.prepareIconify()
        resolve()
      }).catch((err) => {
        console.error(err)
        reject(err)
      })
    })

    let _domCreated = new Promise((resolve) => {
      this._domReady = resolve
    })

    Promise.allSettled([_moduleLoaded, _domCreated, _functionsRestored]).then (() => {
      this._ready = true
      this.library.prepareMagic()
      //let {payload, sender} = result[1].value
      //this.fetch(payload, sender)
      setTimeout(() => {
        this.updateDom(this.activeConfig.animationSpeed)
      }, this.activeConfig.waitFetch)
    })
  },

  _applyWeatherUpdate: function (payload) {
    const convertedPayload = this.notifications.weatherPayload(payload)
    const locationMatches = this.activeConfig.weatherLocationName
      ? convertedPayload.locationName.includes(this.activeConfig.weatherLocationName)
      : true
    const hasForecast = Array.isArray(convertedPayload?.forecastArray) && convertedPayload.forecastArray.length

    if (this.activeConfig.useWeather && locationMatches && hasForecast) {
      this.forecast = [...convertedPayload.forecastArray].map((o) => {
        o.dateId = getDateKey(o.date)
        return o
      })
      return
    }

    if (this.activeConfig.weatherLocationName && !locationMatches) {
      Log.warn(`"weatherLocationName: '${this.activeConfig.weatherLocationName}'" doesn't match with location of weather module ('${convertedPayload.locationName}')`)
    }
  },

  _replyCurrentConfig: function (payload) {
    if (typeof payload?.callback === 'function') payload.callback(this.activeConfig)
  },

  _handleConfigNotification: function (notification, payload) {
    if (payload?.instanceId && payload.instanceId !== this.activeConfig?.instanceId) return

    if (notification === 'CX3A_GET_CONFIG') {
      this._replyCurrentConfig(payload)
      return
    }

    if (notification === 'CX3A_SET_CONFIG') {
      this.activeConfig = this.regularizeConfig({ ...this.activeConfig, ...payload })
      this.updateDom(this.activeConfig.animationSpeed)
      this._replyCurrentConfig(payload)
      return
    }

    if (notification === 'CX3A_RESET') {
      this.activeConfig = this.regularizeConfig({ ...this.originalConfig })
      this.updateDom(this.activeConfig.animationSpeed)
      this._replyCurrentConfig(payload)
    }
  },

  notificationReceived: function(notification, payload, sender) {
    if (notification === this.notifications.eventNotification) {
      const convertedPayload = this.notifications.eventPayload(payload)
      this.eventPool.set(sender.identifier, JSON.parse(JSON.stringify(convertedPayload)))
    }

    if (notification === 'MODULE_DOM_CREATED') {
      this._domReady()
    }

    if (notification === this.notifications.weatherNotification) {
      this._applyWeatherUpdate(payload)
    }

    this._handleConfigNotification(notification, payload)
  },

  getDom: function() {
    let dom = document.createElement('div')
    dom.innerHTML = ""
    dom.classList.add('bodice', 'CX3A_' + this.instanceId, 'CX3A')
    if (this.activeConfig.displayRepeatingCountTitle) dom.classList.add('displayRepeatingCountTitle')
    if (this.activeConfig.fontSize) dom.style.setProperty('--fontsize', this.activeConfig.fontSize)
    if (!this.library?.loaded || !this._ready) {
      Log.warn('[CX3A] Module is not prepared yet, wait a while.')
      return dom
    }
    dom = this.draw(dom, this.activeConfig)

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    this.refreshTimer = setTimeout(() => {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
      this.updateDom(this.activeConfig.animationSpeed)
    }, this.activeConfig.refreshInterval)
    return dom
  },

  _prepareAgenda: function (targetEvents, options, baseDate, getRelativeDate) {
    let events
    const boc = getRelativeDate(baseDate, options.startDayIndex).valueOf()
    const eoc = getRelativeDate(baseDate, options.endDayIndex + 1).valueOf()
    let dateIndex = []

    if (options.onlyEventDays >= 1) {
      const ebd = getEventsByDate({
        events: targetEvents,
        startTime: boc,
        dayCounts: options.onlyEventDays
      })
      dateIndex = ebd.map((e) => e.date)
      events = [...ebd.reduce((reduced, cur) => {
        for (const e of cur.events) reduced.add(e)
        return reduced
      }, new Set())]
    } else {
      events = targetEvents.filter((ev) => !(ev.endDate <= boc || ev.startDate >= eoc))
      for (let i = options.startDayIndex; i <= options.endDayIndex; i++) {
        dateIndex.push(getRelativeDate(baseDate, i).getTime())
      }
    }

    return { events, dateIndex }
  },

  _makeCellDom: function (d, seq, options, helpers) {
    const { isToday, isThisMonth, isThisYear, getWeekNo, gapFromToday, makeWeatherDOM } = helpers
    const tm = new Date(d.valueOf())
    const cell = document.createElement('div')
    cell.classList.add('cell')
    if (isToday(tm)) cell.classList.add('today')
    if (isThisMonth(tm)) cell.classList.add('thisMonth')
    if (isThisYear(tm)) cell.classList.add('thisYear')
    cell.classList.add(
      'year_' + tm.getFullYear(),
      'month_' + (tm.getMonth() + 1),
      'date_' + tm.getDate(),
      'weekday_' + tm.getDay(),
      'seq_' + seq,
      'week_' + getWeekNo(tm, options)
    )
    options.weekends.forEach((w, i) => {
      if (tm.getDay() % 7 === w % 7) cell.classList.add('weekend', 'weekend_' + (i + 1))
    })

    const h = document.createElement('div')
    h.classList.add('cellHeader')
    const m = document.createElement('div')
    m.classList.add('cellHeaderMain')
    const dayDom = document.createElement('div')
    dayDom.classList.add('cellDay')
    const gap = gapFromToday(tm, options)
    const relativeDayStyle = options.relativeNamedDayStyle ?? 'narrow'
    const p = new Intl.RelativeTimeFormat(options.locale, { style: relativeDayStyle, numeric: 'auto' })
    const pv = new Intl.RelativeTimeFormat(options.locale, { style: relativeDayStyle, numeric: 'always' })
    if (p.format(gap, "day") !== pv.format(gap, "day")) {
      dayDom.classList.add('relativeDay', 'relativeNamedDay')
    } else {
      dayDom.classList.add('relativeDay')
    }
    dayDom.classList.add('relativeDayGap_' + gap)
    dayDom.innerHTML = p.formatToParts(gap, "day").reduce((prev, cur, curIndex) => {
      return prev + `<span class="dateParts ${cur.type} seq_${curIndex} unit_${cur?.unit ?? 'none'}">${cur.value}</span>`
    }, '')
    m.appendChild(dayDom)

    const dateDom = document.createElement('div')
    dateDom.classList.add('cellDate')
    const dParts = new Intl.DateTimeFormat(options.locale, options.cellDateOptions).formatToParts(tm)
    dateDom.innerHTML = dParts.reduce((prev, cur, curIndex) => {
      return prev + `<span class="dateParts ${cur.type} seq_${curIndex}">${cur.value}</span>`
    }, '')
    m.appendChild(dateDom)

    const cwDom = document.createElement('div')
    cwDom.innerHTML = String(getWeekNo(tm, options))
    cwDom.classList.add('cw')
    m.appendChild(cwDom)
    h.appendChild(m)

    const s = document.createElement('div')
    s.classList.add('cellHeaderSub')
    const forecasted = this.forecast.find((e) => getDateKey(tm) === e.dateId)
    makeWeatherDOM(s, forecasted)
    h.appendChild(s)

    const b = document.createElement('div')
    b.classList.add('cellBody')
    const f = document.createElement('div')
    f.classList.add('cellFooter')
    cell.appendChild(h)
    cell.appendChild(b)
    cell.appendChild(f)
    return cell
  },

  _drawAgenda: function (dom, agendaInput, options, helpers) {
    const { renderEventAgenda } = helpers
    const { events } = agendaInput
    const dateIndex = [...agendaInput.dateIndex].sort((a, b) => a - b)
    const agenda = document.createElement('div')
    agenda.classList.add('agenda')
    const viewStartTime = dateIndex[0] ?? null

    for (const [i, date] of dateIndex.entries()) {
      const tm = new Date(date)
      const eotm = new Date(tm.getFullYear(), tm.getMonth(), tm.getDate(), 23, 59, 59, 999)
      const dayDom = this._makeCellDom(tm, i, options, helpers)
      const body = dayDom.getElementsByClassName('cellBody')[0]
      const visibleEvents = events.filter((ev) => isEventOverlapping(ev, tm.getTime(), eotm.getTime())).filter((ev) => {
        const displayDayTime = getDisplayDayTimeForEvent(ev, options.showMultidayEventsOnce, viewStartTime)
        if (displayDayTime === null) return true
        return isSameDate(new Date(displayDayTime), tm)
      })
      const { mvs, fevs, sevs } = splitVisibleEventsByType(visibleEvents, options.showMultidayEventsOnce)
      const eventCounts = mvs.length + fevs.length + sevs.length
      dayDom.dataset.eventsCounts = eventCounts
      if (eventCounts === 0 && options.onlyEventDays >= 1) continue
      if (eventCounts === 0) dayDom.classList.add('noEvents')

      for (const [ key, value ] of Object.entries({ multiday: mvs, fullday: fevs, single: sevs })) {
        const tDom = document.createElement('div')
        tDom.classList.add(key)
        for (const e of value) {
          if (e?.skip) continue
          const ev = renderEventAgenda(e, {
            useSymbol: options.useSymbol,
            eventTimeOptions: options.eventTimeOptions,
            locale: options.locale,
            useIconify: options.useIconify,
            showMultidayEventsOnce: options.showMultidayEventsOnce,
            multidayRangeLabelOptions: options.multidayRangeLabelOptions,
          }, tm)
          tDom.appendChild(ev)
        }
        body.appendChild(tDom)
      }
      agenda.appendChild(dayDom)
    }
    dom.appendChild(agenda)
    return dom
  },

  _drawMiniMonth: function (dom, events, monthOffset, options, baseDate, helpers) {
    if (!options.showMiniMonthCalendar) return dom
    const { getBeginOfWeek, getWeekNo } = helpers
    const cm = new Date(baseDate.getFullYear(), baseDate.getMonth() + monthOffset, monthOffset === 0 ? baseDate.getDate() + options.startDayIndex : 1)
    const bwoc = getBeginOfWeek(new Date(cm.getFullYear(), cm.getMonth(), 1), options)
    const ewoc = getBeginOfWeek(new Date(cm.getFullYear(), cm.getMonth() + 1, 0), options)
    const im = new Date(bwoc.getTime())
    const today = new Date(Date.now())
    const view = document.createElement('table')
    view.classList.add('miniMonth')

    const caption = document.createElement('caption')
    caption.innerHTML = new Intl.DateTimeFormat(options.locale, options.miniMonthTitleOptions).formatToParts(cm).reduce((prev, cur, curIndex) => {
      return prev + `<span class="calendarTimeParts ${cur.type} seq_${curIndex}">${cur.value}</span>`
    }, '')
    view.appendChild(caption)

    const head = document.createElement('thead')
    const weekname = document.createElement('tr')
    const cwh = document.createElement('th')
    cwh.classList.add('cw', 'cell')
    weekname.appendChild(cwh)
    const wm = new Date(im.getTime())
    for (let i = 0; i < 7; i++) {
      const wn = document.createElement('th')
      wn.innerHTML = new Intl.DateTimeFormat(options.locale, options.miniMonthWeekdayOptions).format(wm)
      wn.classList.add('cell', 'weekname', 'weekday_' + wm.getDay())
      wn.scope = 'col'
      weekname.appendChild(wn)
      options.weekends.forEach((w, ix) => {
        if (wm.getDay() % 7 === w % 7) wn.classList.add('weekend', 'weekend_' + (ix + 1))
      })
      wm.setDate(wm.getDate() + 1)
    }
    head.appendChild(weekname)
    view.appendChild(head)

    const body = document.createElement('tbody')
    while (im.getTime() <= ewoc.getTime()) {
      const weekline = document.createElement('tr')
      const cw = getWeekNo(im, options)
      const cwc = document.createElement('td')
      const thisWeek = (im.getTime() === getBeginOfWeek(new Date(Date.now()), options).getTime()) ? ['thisWeek'] : []
      cwc.classList.add('cw', 'cell')
      cwc.scope = 'row'
      cwc.innerHTML = cw
      weekline.classList.add('weeks', 'week_' + cw, ...thisWeek)
      weekline.appendChild(cwc)

      const dm = new Date(im.getTime())
      for (let i = 1; i <= 7; i++) {
        const dc = document.createElement('td')
        dc.classList.add(
          'cell',
          'day_' + dm.getDate(),
          'month_' + (dm.getMonth() + 1),
          'year_' + dm.getFullYear(),
          'weekday_' + dm.getDay(),
          (dm.getFullYear() === today.getFullYear()) ? 'thisYear' : null,
          (dm.getMonth() === today.getMonth()) ? 'thisMonth' : null,
          ...thisWeek,
          (dm.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) ? 'today' : null
        )
        options.weekends.forEach((w, ix) => {
          if (dm.getDay() % 7 === w % 7) dc.classList.add('weekend', 'weekend_' + (ix + 1))
        })

        const content = document.createElement('div')
        content.classList.add('dayContent')
        const date = document.createElement('div')
        date.classList.add('date')
        date.innerHTML = dm.getDate()
        const evs = document.createElement('div')
        evs.classList.add('events')
        const edm = new Date(dm.getFullYear(), dm.getMonth(), dm.getDate(), 23, 59, 59, 999)
        events.filter((ev) => isEventOverlapping(ev, dm.getTime(), edm.getTime())).sort((a, b) => {
          return ((a.endDate - a.startDate) === (b.endDate - b.startDate))
            ? (a.startDate === b.startDate) ? a.endDate - b.endDate : a.startDate - b.startDate
            : (b.endDate - b.startDate) - (a.endDate - a.startDate)
        }).forEach((ev) => {
          const dot = document.createElement('div')
          dot.classList.add('eventDot')
          dot.style.setProperty('--calendarColor', ev.color)
          dot.innerHTML = '⬤'
          evs.appendChild(dot)
        })
        content.appendChild(date)
        content.appendChild(evs)
        dc.appendChild(content)
        weekline.appendChild(dc)
        dm.setDate(dm.getDate() + 1)
      }
      body.appendChild(weekline)
      im.setDate(im.getDate() + 7)
    }
    view.appendChild(body)
    dom.appendChild(view)
    return dom
  },

  draw: function (dom, options) {
    if (!this.library?.loaded) return dom

    const t = new Date(Date.now())
    const baseDate = new Date(t.getFullYear(), t.getMonth(), t.getDate())
    const {
      isToday, isThisMonth, isThisYear, getWeekNo, makeWeatherDOM,
      getRelativeDate, prepareEvents, getBeginOfWeek,
      gapFromToday, renderEventAgenda, regularizeEvents
    } = this.library

    const helpers = {
      isToday, isThisMonth, isThisYear, getWeekNo, makeWeatherDOM,
      getBeginOfWeek, gapFromToday, renderEventAgenda,
    }

    dom.innerHTML = ''
    const sm = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + options.startDayIndex)
    const em = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + options.endDayIndex)
    const tempPool = new Map()
    this.eventPool.forEach((v, k) => {
      tempPool.set(k, JSON.parse(JSON.stringify(v)))
    })

    const targetEvents = prepareEvents({
      targetEvents: regularizeEvents({
        eventPool: tempPool,
        config: options,
      }),
      config: options,
      range: [
        new Date(sm.getFullYear(), sm.getMonth() - 1, 1).getTime(),
        new Date(em.getFullYear(), em.getMonth() + 2, 1).getTime()
      ]
    })

    const copied = JSON.parse(JSON.stringify(targetEvents))
    for (let i = 0; i < options.showMiniMonthCalendarMonths; i++) {
      dom = this._drawMiniMonth(dom, [...copied], i, options, baseDate, helpers)
    }

    const agenda = this._prepareAgenda([...copied], options, baseDate, getRelativeDate)
    dom = this._drawAgenda(dom, agenda, options, helpers)
    return dom
  },
})
