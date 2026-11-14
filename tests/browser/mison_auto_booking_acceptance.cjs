const assert = require("node:assert/strict")
const path = require("node:path")
const AxeBuilder = require("@axe-core/playwright").default

const today = "2026-11-02"
const addDays = (day, amount) => {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}
const weekdays = () => Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i + 1), []]))
const teachers = ["Jenyy", "Lewis", "Rina", "Sarah", "David", "Emma"].map((name, i) => ({
  id: `demo-${i}`,
  name,
  avatarUrl: null,
  intro: `收藏老师 ${name}`,
  labels: [],
  favorite: true,
  recommended: false,
  nextAvailable: null,
  lessonMinutes: 25,
}))
const teacherDTO = ({ id, name, avatarUrl }) => ({ id, name, avatarUrl })

exports.createAutoBookingFixture = function () {
  const calls = []
  const unexpected = []
  const receipts = new Map()
  let config
  let status
  let scheduleError = false
  let dayError = false
  let canManage = true
  let pendingReceipt = false
  let visualMode = false
  const scheduleDays = new Map()
  const envelope = (data) => ({
    ok: true,
    data: structuredClone(data),
    requestId: "auto-fixture",
    serverTime: `${today}T08:00:00+08:00`,
  })
  const failure = (code, message) => ({ ok: false, error: { code, message } })
  function reset({ empty = false, member = false, failSchedule = false, visual = false } = {}) {
    canManage = !member
    scheduleError = failSchedule
    dayError = false
    pendingReceipt = false
    visualMode = visual
    scheduleDays.clear()
    receipts.clear()
    config = {
      revision: empty ? 0 : 3,
      bindingRevision: 1,
      canManage,
      teachers: empty ? [] : [teacherDTO(teachers[0]), teacherDTO(teachers[3])],
      dates: empty ? [] : ["2026-11-04", "2026-11-05"],
      weekdaySlots: { ...weekdays(), ...(empty ? {} : { 3: ["09:30", "10:00"], 4: ["18:00"] }) },
      minNoticeHours: 25,
      dailyLessons: 1,
      rebookCancelled: true,
      sleep: { enabled: true, start: "23:00", end: "08:00" },
    }
    status = {
      state: "stopped",
      phase: "stopped",
      message: "任务已停止。",
      enabled: false,
      checks: 42,
      totalBooked: 3,
      nextCheckAt: null,
      lastCheckAt: `${today}T07:00:00+08:00`,
      fulfilledDates: empty ? [] : ["2026-11-04"],
      targetDates: [...config.dates],
      latestEvent: {
        id: "latest",
        at: `${today}T07:00:00+08:00`,
        kind: "checked",
        message: "已完成本轮检查。",
      },
      canManage,
    }
    if (visual) {
      config.teachers = [teachers[0], teachers[3], teachers[5]].map(teacherDTO)
      config.dates = [16, 17, 19, 20, 23, 24, 26, 27].map((day) => `2026-11-${day}`)
      config.weekdaySlots = {
        ...weekdays(),
        1: ["19:30", "19:00"],
        2: ["19:00", "19:30"],
        4: ["19:30", "20:00"],
        5: ["19:30", "20:00"],
      }
      Object.assign(status, {
        state: "running",
        phase: "waiting",
        enabled: true,
        message: "等待下一轮检查。",
        checks: 138,
        totalBooked: 12,
        targetDates: [...config.dates],
        fulfilledDates: config.dates.slice(0, 4),
        nextCheckAt: `${today}T08:42:00+08:00`,
        lastCheckAt: `${today}T08:37:00+08:00`,
        latestEvent: {
          id: "visual-booked",
          at: `${today}T08:37:00+08:00`,
          kind: "booked",
          message: "预约成功。",
          date: "2026-11-16",
          teacherName: "Jenyy",
          time: "19:30",
        },
      })
    }
  }
  reset({ empty: true })
  return {
    calls,
    unexpected,
    reset,
    get config() {
      return structuredClone(config)
    },
    get status() {
      return structuredClone(status)
    },
    getScheduleDays(teacherId, from = today, to = addDays(from, 13)) {
      return structuredClone(
        [...scheduleDays.values()].filter(
          (day) => day.teacherId === teacherId && day.date >= from && day.date <= to,
        ),
      )
    },
    setScheduleError(value) {
      scheduleError = value
    },
    setDayError(value) {
      dayError = value
    },
    reconcile(enabled) {
      pendingReceipt = true
      Object.assign(status, {
        enabled,
        state: "stopped",
        phase: "reconciling",
        message: "预约结果待核对，期间只读核验，不会发送新预约。",
      })
    },
    async handle(relative, options) {
      const url = new URL(relative, "https://fixture.invalid/")
      const name = url.pathname.slice(1)
      const { method, body } = options
      if (name === "teachers" && url.searchParams.get("favoritesOnly") === "1") {
        const offset = Number(url.searchParams.get("cursor") || "0")
        calls.push({ name: "favorites", offset, method })
        assert.ok([0, 2, 4].includes(offset))
        return envelope({
          queryId: "favorite-pages",
          items: teachers.slice(offset, offset + 2),
          nextCursor: offset < 4 ? String(offset + 2) : null,
          complete: offset === 4,
          total: 6,
          fetchedAt: `${today}T08:00:00+08:00`,
        })
      }
      if (!name.startsWith("auto-booking/")) {
        const safeRead =
          method === "GET" && /^(?:bootstrap|teachers|teacher-filters|bookings\/pages)$/.test(name)
        const safeWrite =
          method === "POST" && ["connection/login", "course-sync/run"].includes(name)
        if (safeRead || safeWrite) return null
        unexpected.push(`${method} ${relative}`)
        return failure("FIXTURE_ONLY", "未声明的业务接口已阻止。")
      }
      calls.push({
        name,
        method,
        query: Object.fromEntries(url.searchParams),
        body: body ? structuredClone(body) : null,
      })
      if (name === "auto-booking/config" && method === "GET") return envelope(config)
      if (name === "auto-booking/status" && method === "GET") return envelope(status)
      if (name === "auto-booking/schedules" && method === "GET") {
        const from = url.searchParams.get("from")
        const to = url.searchParams.get("to")
        const teacherId = url.searchParams.get("teacherId")
        const offset = Number(url.searchParams.get("cursor") || "0")
        assert.equal(to, addDays(from, 13))
        assert.ok(config.teachers.some((teacher) => teacher.id === teacherId))
        assert.ok(offset >= 0 && offset <= 12 && offset % 2 === 0)
        await new Promise((resolve) => setTimeout(resolve, 45))
        if (scheduleError && offset === 2)
          return failure("UPSTREAM_UNAVAILABLE", "模拟自动排班第二页失败")
        const days = [offset, offset + 1].map((index) => {
          const date = addDays(from, index)
          const unopened = date >= addDays(visualMode ? "2026-11-12" : today, 10)
          const booked = status.fulfilledDates.includes(date)
          const target = config.dates.includes(date)
          const failed = dayError && index === 4
          const result = {
            date,
            state: failed ? "error" : unopened ? "unopened" : "ready",
            target,
            booked,
            ...(failed
              ? { message: "模拟单日排班读取失败" }
              : unopened
                ? { message: "该日期尚未开放排班。" }
                : {}),
            slots:
              unopened || failed || (visualMode && date === "2026-11-14")
                ? []
                : Array.from(
                    { length: visualMode ? (date === "2026-11-12" ? 10 : 20) : 24 },
                    (_, i) => {
                      const visualStarts =
                        date === "2026-11-12"
                          ? [
                              "10:30",
                              "16:30",
                              "17:00",
                              "17:30",
                              "18:00",
                              "18:30",
                              "21:00",
                              "21:30",
                              "22:00",
                              "22:30",
                            ]
                          : [
                              "09:00",
                              "09:30",
                              "10:00",
                              "10:30",
                              "11:00",
                              "11:30",
                              "16:00",
                              "16:30",
                              "17:00",
                              "17:30",
                              "18:00",
                              "18:30",
                              "19:00",
                              "19:30",
                              "20:00",
                              "20:30",
                              "21:00",
                              "21:30",
                              "22:00",
                              "22:30",
                            ]
                      const start = visualMode
                        ? visualStarts[i]
                        : `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`
                      const end = `${start.slice(0, 3)}${start.endsWith("30") ? "55" : "25"}`
                      const state = visualMode
                        ? date === "2026-11-16" && start === "19:30"
                          ? "mine"
                          : [
                                date === "2026-11-12" ? 7 : 6,
                                ...(date === "2026-11-16" ? [0, 1, 4, 5, 7, 8] : []),
                              ].includes(i)
                            ? "available"
                            : "occupied"
                        : i === 1
                          ? "mine"
                          : i === 2
                            ? "occupied"
                            : i === 3
                              ? "unscheduled"
                              : "available"
                      const matches = target && !booked && state === "available"
                      return {
                        start,
                        end,
                        state,
                        matches,
                        reason: matches
                          ? null
                          : `${config.teachers.find((teacher) => teacher.id === teacherId).name}：${state === "available" ? "未命中日期或当天已有课程" : "该时段不可约"}，仅展示排班，不会提交预约。`,
                      }
                    },
                  ),
          }
          scheduleDays.set(`${teacherId}:${date}`, { ...structuredClone(result), teacherId })
          return result
        })
        assert.equal(days.length, 2)
        return envelope({
          teacherId,
          days,
          nextCursor: offset < 12 ? String(offset + 2) : null,
          updatedAt: `${today}T08:00:00+08:00`,
        })
      }
      if (name === "auto-booking/logs" && method === "GET") {
        const cursor = "event-3|2026-11-12T08:30:00+08:00"
        const value = url.searchParams.get("cursor")
        assert.ok(!value || value === cursor, "cursor preserves its plus sign and timezone")
        const offset = value ? 3 : 0
        return envelope({
          items: Array.from({ length: 3 }, (_, i) => ({
            id: `event-${offset + i}`,
            at: `${today}T08:${String(offset + i).padStart(2, "0")}:00+08:00`,
            kind: "checked",
            message: `自动约课记录 ${offset + i + 1}`,
            date: "2026-11-05",
            teacherName: "Jenyy",
            time: "18:00",
          })),
          nextCursor: value ? null : cursor,
        })
      }
      if (
        ["auto-booking/config", "auto-booking/start", "auto-booking/stop"].includes(name) &&
        method !== "GET"
      ) {
        if (!canManage) return failure("OWNER_REQUIRED", "只有儿童负责人可以配置和启停自动约课。")
        assert.equal(body.bindingRevision, 1)
        assert.match(body.operationId, /^[0-9a-f-]{36}$/i)
        const digest = JSON.stringify({ name, body })
        if (receipts.has(body.operationId)) assert.equal(receipts.get(body.operationId), digest)
        else {
          if (name !== "auto-booking/stop") assert.equal(body.expectedRevision, config.revision)
          if (name === "auto-booking/config") {
            assert.equal(method, "PUT")
            assert.deepEqual(
              Object.keys(body).sort(),
              [
                "operationId",
                "bindingRevision",
                "expectedRevision",
                "teachers",
                "dates",
                "weekdaySlots",
                "minNoticeHours",
                "dailyLessons",
                "rebookCancelled",
                "sleep",
              ].sort(),
            )
            const { operationId, expectedRevision, ...editable } = body
            config = { ...structuredClone(editable), revision: config.revision + 1, canManage }
            status.targetDates = [...config.dates]
          } else {
            assert.equal(method, "POST")
            if (name.endsWith("/start")) {
              if (pendingReceipt)
                return failure("RESULT_UNCERTAIN", "预约结果待核对，期间只读核验。")
              assert.ok(config.teachers.length && config.dates.length)
              Object.assign(status, {
                state: "running",
                phase: "waiting",
                enabled: true,
                message: "等待下一轮检查。",
                nextCheckAt: `${today}T08:05:00+08:00`,
              })
            } else
              Object.assign(status, {
                state: "stopped",
                phase: pendingReceipt ? "reconciling" : "stopped",
                enabled: false,
                message: pendingReceipt
                  ? "预约结果待核对，期间只读核验，不会发送新预约。"
                  : "任务已停止。",
              })
          }
          receipts.set(body.operationId, digest)
        }
        return envelope(name === "auto-booking/config" ? config : status)
      }
      unexpected.push(`${method} ${relative}`)
      return failure("FIXTURE_ONLY", "未声明的自动约课接口已阻止。")
    },
  }
}

exports.exerciseAutoBooking = async function ({
  page,
  out,
  fixture,
  child,
  entryUrl,
  hostStyle,
  originalHostStyle,
}) {
  const checks = []
  const findings = []
  const screenshots = []
  const visualLayouts = []
  page.setDefaultTimeout(10000)
  const tabs = page.getByRole("tablist", { name: "美森约课功能", exact: true })
  const auto = page.locator(".mison-auto-booking")
  const editor = auto.getByRole("form", { name: "自动约课设置", exact: true })
  const internalTab = (name) =>
    auto
      .getByRole("tablist", { name: "自动约课页面", exact: true })
      .getByRole("tab", { name, exact: true })
  const callCount = (name, method) =>
    fixture.calls.filter((call) => call.name === name && (!method || call.method === method)).length
  const screenshot = async (name) => {
    const file = path.join(out, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" })
    screenshots.push(file)
  }
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  const ready = () =>
    auto
      .locator(".mison-auto-schedule-progress")
      .getByText(/^已读取 14\/14 天/)
      .waitFor()
  const weekdayRow = (day) => editor.getByRole("group", { name: `${day}时段优先级`, exact: true })
  async function selectedDates(expected, { disabled = false } = {}) {
    const cells = editor.locator('.shared-calendar [data-day][aria-selected="true"]')
    assert.deepEqual(
      (await cells.evaluateAll((items) => items.map((el) => el.getAttribute("data-day")))).sort(),
      [...expected].sort(),
      "calendar selection matches every selected date",
    )
    for (const date of expected) {
      const cell = editor.locator(`.shared-calendar [data-day="${date}"]`)
      assert.equal(await cell.getAttribute("aria-selected"), "true")
      if (disabled) assert.equal(await cell.getByRole("button").isDisabled(), true)
    }
  }
  async function dateRange() {
    const popup = page.getByRole("dialog", { name: "排班日期范围", exact: true })
    if (!(await popup.isVisible()))
      await auto.getByRole("button", { name: "选择排班日期范围", exact: true }).click()
    await popup.waitFor()
    await frames()
    return popup
  }
  async function assertSlotFilter(value, teacherId = "demo-0", from = today) {
    const filter = auto.getByRole("combobox", { name: "排班时段筛选", exact: true })
    await filter.selectOption(value)
    assert.equal(await filter.inputValue(), value)
    const expected = fixture
      .getScheduleDays(teacherId, from)
      .flatMap((day) =>
        day.slots
          .filter(
            (slot) =>
              value === "all" ||
              (value === "available" ? slot.state === "available" : slot.matches),
          )
          .map((slot) => `${day.date}|${slot.start}|${slot.state}`),
      )
      .sort()
    const actual = await auto.locator(".mison-auto-day").evaluateAll((days) =>
      days
        .flatMap((day) => {
          const date = day.querySelector("h3 time").getAttribute("datetime")
          return [...day.querySelectorAll(".mison-auto-slot")].map(
            (slot) =>
              `${date}|${slot.querySelector("time").textContent}|${slot.getAttribute("data-state")}`,
          )
        })
        .sort(),
    )
    assert.deepEqual(actual, expected, `${value} renders precisely the matching loaded slots`)
    return actual.length
  }
  async function blueMine() {
    const mine = auto.locator('.mison-auto-slot[data-state="mine"]').first()
    const colors = await mine.evaluate((el) => {
      const style = getComputedStyle(el)
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext("2d")
      const rgb = (color) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      return {
        text: rgb(style.color),
        border: rgb(style.borderTopColor),
        background: rgb(style.backgroundColor),
      }
    })
    for (const [part, [red, green, blue]] of Object.entries(colors))
      assert.ok(
        blue > red + (part === "text" ? 30 : 3) && blue > green + (part === "text" ? 10 : 1),
        `mine ${part} is blue, not yellow: ${JSON.stringify(colors)}`,
      )
  }
  async function settingsLayout(viewport) {
    assert.equal(await editor.locator(".mison-auto-settings-card").count(), 4)
    assert.equal(
      await editor.getByRole("tablist").count(),
      0,
      "all weekdays are rows, with no weekday tabs",
    )
    const labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    const rows = []
    for (const day of labels) {
      const row = weekdayRow(day)
      assert.equal(await row.isVisible(), true, `${day} stays expanded`)
      rows.push(await row.boundingBox())
    }
    assert.ok(
      rows.every((row, i) => !i || row.y >= rows[i - 1].y + rows[i - 1].height - 1),
      "all seven weekdays occupy distinct ordered rows",
    )
    const layout = await editor.evaluate((el) => {
      const rect = (selector) => {
        const { x, y, width, height, bottom, right } = el
          .querySelector(selector)
          .getBoundingClientRect()
        return { x, y, width, height, bottom, right }
      }
      return {
        grid: rect(".mison-auto-settings-grid"),
        teachers: rect(".mison-auto-teachers-card"),
        execution: rect(".mison-auto-execution-card"),
        dates: rect(".mison-auto-dates-card"),
        weekly: rect(".mison-auto-weekly-card"),
        calendar: rect(".mison-auto-calendar-grid"),
        footer: rect(".mison-auto-settings-footer"),
        weekdays: [...el.querySelectorAll(".mison-auto-calendar-weekdays > *")].length,
        calendarRows: el.querySelectorAll(".mison-auto-calendar-week").length,
      }
    })
    assert.equal(layout.weekdays, 7)
    assert.ok(layout.calendarRows >= 4 && layout.calendarRows <= 6)
    assert.ok(
      layout.calendar.width >= layout.dates.width - 54,
      "month calendar spans the date card content width",
    )
    if (viewport.width >= 1400) {
      const ratio = layout.teachers.width / layout.grid.width
      assert.ok(
        ratio >= 0.3 && ratio <= 0.36,
        `desktop left column follows the 34/66 reference: ${ratio}`,
      )
      assert.ok(
        layout.dates.width > layout.teachers.width * 1.7,
        "calendar column is distinctly wider",
      )
      assert.ok(Math.abs(layout.teachers.y - layout.dates.y) <= 3, "top cards align")
      assert.ok(
        Math.abs(layout.teachers.x - layout.execution.x) <= 2 &&
          Math.abs(layout.dates.x - layout.weekly.x) <= 2,
        "teacher/execution and calendar/weekdays form stable columns",
      )
      assert.ok(
        layout.execution.y >= layout.teachers.bottom && layout.weekly.y >= layout.dates.bottom,
        "execution and weekdays sit below their top cards",
      )
      assert.ok(
        Math.abs(layout.dates.x - layout.teachers.right - 20) <= 3,
        "desktop columns keep the reference 20px gap",
      )
      assert.ok(
        layout.calendar.width >= 500,
        "calendar uses a wide month grid, not a compact date picker",
      )
    } else if (viewport.width <= 400) {
      assert.ok(
        Math.abs(layout.teachers.x - layout.dates.x) <= 2 &&
          Math.abs(layout.teachers.width - layout.dates.width) <= 2,
        "narrow settings cards stack at equal width",
      )
    }
    await noOverflow()
    return layout
  }
  async function captureVisuals() {
    await load({ visual: true })
    assert.equal(fixture.config.teachers.length, 3)
    assert.equal(fixture.config.dates.length, 8)
    await auto.getByText("运行中", { exact: true }).waitFor()
    assert.deepEqual(await auto.locator(".mison-auto-metric > strong").allTextContents(), [
      "12",
      "138",
      "4 / 8",
    ])
    const before = fixture.calls.filter(
      (call) => call.method !== "GET" && call.name.startsWith("auto-booking/"),
    ).length
    const range = await dateRange()
    await range.getByRole("button", { name: "排班起始日期", exact: true }).click()
    const calendar = page
      .locator('[data-slot="popover-content"][data-state="open"]')
      .filter({ has: page.locator('.shared-calendar [data-day="2026-11-12"]') })
    await calendar.locator('.shared-calendar [data-day="2026-11-12"] button').click()
    await page.keyboard.press("Escape")
    await ready()
    assert.equal(
      await auto.locator(".mison-auto-day h3 time").first().getAttribute("datetime"),
      "2026-11-12",
    )
    assert.equal(
      await auto
        .getByRole("tablist", { name: "切换排班老师", exact: true })
        .getByRole("tab")
        .count(),
      3,
    )
    const scroller = auto.locator(".mison-auto-schedule-scroll")
    const mineDay = auto
      .locator(".mison-auto-day")
      .filter({ has: page.locator('h3 time[datetime="2026-11-16"]') })
    await mineDay.scrollIntoViewIfNeeded()
    await blueMine()
    await scroller.evaluate((el) => {
      el.scrollTop = 0
    })
    if (await range.isVisible()) await page.keyboard.press("Escape")
    await range.waitFor({ state: "hidden" })
    await page.locator(".mison-auto-schedule-toolbar h2").click()
    await frames()
    await noOverflow()
    await screenshot("auto-reference-dashboard-1440x1000")
    await page.setViewportSize({ width: 1516, height: 1037 })
    await frames()
    await screenshot("auto-reference-dashboard-1516x1037")
    visualLayouts.push({
      viewport: "1516x1037",
      dashboard: await auto.evaluate((el) => ({
        dayRows: [...el.querySelectorAll(".mison-auto-day")].slice(0, 5).map((row) => ({
          height: row.getBoundingClientRect().height,
          chipRows: new Set(
            [...row.querySelectorAll(".mison-auto-slot")].map((slot) =>
              Math.round(slot.getBoundingClientRect().top),
            ),
          ).size,
        })),
      })),
    })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await internalTab("预约设置").click()
    await editor.locator(".mison-auto-settings-notice").click()
    await selectedDates(fixture.config.dates)
    await editor.locator(".mison-auto-settings-scroll").evaluate((el) => {
      el.scrollTop = 0
    })
    await frames()
    visualLayouts.push({
      viewport: "1440x1000",
      settings: await settingsLayout({ width: 1440, height: 1000 }),
    })
    await screenshot("auto-reference-settings-1440x1000")
    await page.setViewportSize({ width: 1448, height: 1086 })
    await frames()
    const reference = await settingsLayout({ width: 1448, height: 1086 })
    visualLayouts.push({ viewport: "1448x1086", settings: reference })
    await screenshot("auto-reference-settings-1448x1086")
    const settingsScroll = editor.locator(".mison-auto-settings-scroll")
    const referenceScroll = await settingsScroll.evaluate((el) => ({
      height: el.scrollHeight,
      client: el.clientHeight,
    }))
    const fullHeight = 1086 + Math.max(0, referenceScroll.height - referenceScroll.client) + 4
    await page.setViewportSize({ width: 1448, height: fullHeight })
    await settingsScroll.evaluate((el) => {
      el.scrollTop = 0
    })
    await frames()
    const full = await settingsLayout({ width: 1448, height: fullHeight })
    const complete = await settingsScroll.evaluate((el) => ({
      height: el.scrollHeight,
      client: el.clientHeight,
    }))
    assert.ok(
      complete.height <= complete.client + 2,
      `reference-size capture includes the complete settings: ${JSON.stringify(complete)}`,
    )
    assert.ok(
      full.grid.bottom <= full.footer.y + 2 && full.footer.bottom <= fullHeight,
      "all four cards and save footer fit in the full settings capture",
    )
    visualLayouts.push({ viewport: `1448x${fullHeight}`, settings: full, referenceScroll })
    await screenshot(`auto-reference-settings-complete-1448x${fullHeight}`)
    assert.equal(
      fixture.calls.filter((call) => call.method !== "GET" && call.name.startsWith("auto-booking/"))
        .length,
      before,
      "visual fixture captures never start or modify a strategy",
    )
  }
  async function load(options = {}) {
    fixture.reset(options)
    child.role = options.member ? "member" : "owner"
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(entryUrl)
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await page.getByRole("heading", { name: "可约老师 · 6", exact: true }).waitFor()
    assert.deepEqual(await tabs.getByRole("tab").allTextContents(), [
      "教师与约课",
      "课程日历",
      "自动约课",
    ])
    await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
    await auto.waitFor()
    await (
      options.empty
        ? editor.getByRole("button", { name: "保存设置", exact: true })
        : auto.getByRole("button", { name: "刷新排班", exact: true })
    ).waitFor()
    if (!options.empty && !options.failSchedule) await ready()
  }
  async function run(name, fn) {
    try {
      await fn()
      checks.push(name)
    } catch (error) {
      const file = path.join(out, `auto-failure-${findings.length + 1}.png`)
      await page.screenshot({ path: file, fullPage: true }).catch(() => {})
      findings.push({ name, message: error.message, screenshot: file })
      console.error(
        JSON.stringify({ autoBookingFinding: name, error: error.stack, screenshot: file }),
      )
    }
  }
  async function time(label, hour, minute, { opened = false, confirm = "完成" } = {}) {
    if (!opened) await editor.getByRole("combobox", { name: label, exact: true }).click()
    const popup = page.locator('[data-slot="popover-content"][data-state="open"]').filter({
      has: page.getByRole("spinbutton", { name: `${label}小时`, exact: true }),
    })
    const hours = popup.getByRole("spinbutton", { name: `${label}小时`, exact: true })
    await hours.press(hour <= 12 ? "Home" : "End")
    for (let i = 0; i < (hour <= 12 ? hour : 23 - hour); i++)
      await hours.press(hour <= 12 ? "ArrowDown" : "ArrowUp")
    const minutes = popup.getByRole("spinbutton", { name: `${label}分钟`, exact: true })
    await minutes.press(minute ? "End" : "Home")
    await popup.getByRole("button", { name: confirm, exact: true }).click()
  }
  async function addSlot(day, hour, minute = 0) {
    await addSlots(day, [[hour, minute]])
  }
  async function addSlots(day, times) {
    const panel = weekdayRow(day)
    await panel.getByRole("button", { name: `${day}添加时段`, exact: true }).click()
    const picker = page.getByRole("group", { name: `${day}可添加时段`, exact: true })
    await picker.waitFor()
    for (const [hour, minute = 0] of times) {
      const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      await picker.getByRole("button", { name: label, exact: true }).click()
    }
    await picker.getByRole("button", { name: new RegExp(`^确认添加 · ${times.length}$`) }).click()
    await picker.waitFor({ state: "hidden" })
  }
  async function noOverflow() {
    assert.deepEqual(
      await page.evaluate(() => ({
        x: document.documentElement.scrollWidth <= innerWidth + 1,
        y: document.documentElement.scrollHeight <= innerHeight + 1,
      })),
      { x: true, y: true },
      "document stays within the viewport",
    )
  }
  async function nativeScroll(locator) {
    const before = await locator.evaluate((el) => ({
      top: el.scrollTop,
      client: el.clientHeight,
      height: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
      y: window.scrollY,
    }))
    assert.ok(before.height > before.client + 50 && before.client > 60, JSON.stringify(before))
    assert.ok(["auto", "scroll"].includes(before.overflow))
    await locator.hover()
    await page.mouse.wheel(0, 380)
    await page.waitForFunction(
      (selector) => document.querySelector(selector).scrollTop > 50,
      await locator.evaluate((el) => `.${el.classList[0]}`),
    )
    assert.equal(
      await page.evaluate(() => window.scrollY),
      before.y,
      "wheel scroll does not move the document",
    )
    await noOverflow()
  }

  if (process.env.AUTO_BOOKING_VISUAL_ONLY === "1") {
    await captureVisuals()
    return {
      passed: true,
      checks: ["reference visual capture"],
      findings: [],
      screenshots,
      visualLayouts,
      businessFixtureOnly: fixture.unexpected.length === 0,
    }
  }

  await run("first empty config, defaults, empty save and disabled start", async () => {
    await load({ empty: true })
    assert.equal(await internalTab("预约设置").getAttribute("aria-selected"), "true")
    assert.equal(await editor.getByLabel("最少提前预约", { exact: true }).inputValue(), "25")
    assert.equal(await editor.getByLabel("休眠开始", { exact: true }).inputValue(), "23:00")
    assert.equal(await editor.getByLabel("休眠结束", { exact: true }).inputValue(), "08:00")
    assert.equal(
      await editor.getByRole("switch", { name: "启用休眠", exact: true }).isChecked(),
      true,
    )
    assert.equal(await editor.locator(".mison-auto-priorities li").count(), 0)
    assert.equal(
      await auto.getByRole("button", { name: "开启任务", exact: true }).isDisabled(),
      true,
    )
    await editor.getByRole("button", { name: "保存设置", exact: true }).click()
    await auto.getByText("设置已保存。", { exact: true }).waitFor()
    assert.equal(await internalTab("运行看板").getAttribute("aria-selected"), "true")
    assert.equal(fixture.config.revision, 1)
    assert.equal(
      await auto.getByRole("button", { name: "开启任务", exact: true }).isDisabled(),
      true,
    )
  })

  await run(
    "favorites pagination, keyboard priorities, multi dates, ordered slots, notice/sleep and draft retention",
    async () => {
      await load({ empty: true })
      const favoritesBefore = callCount("favorites")
      await editor.getByRole("button", { name: "添加收藏老师", exact: true }).click()
      const chooser = page.getByRole("dialog", { name: "从收藏添加老师", exact: true })
      await chooser.getByRole("checkbox", { name: "Emma 老师", exact: true }).waitFor()
      assert.equal(callCount("favorites") - favoritesBefore, 3)
      for (const name of ["Jenyy", "Sarah", "Lewis"])
        await chooser.getByRole("checkbox", { name: `${name} 老师`, exact: true }).check()
      await chooser.getByRole("button", { name: "完成 · 已选 3 位", exact: true }).click()
      await editor.getByRole("button", { name: "前移Lewis", exact: true }).focus()
      await page.keyboard.press("Enter")
      await editor.getByRole("status").filter({ hasText: "Lewis已移到第2优先" }).waitFor()
      assert.deepEqual(
        await editor
          .locator(".mison-auto-teacher-copy > span:not(.mison-avatar)")
          .allTextContents(),
        ["Jenyy 老师", "Lewis 老师", "Sarah 老师"],
      )
      assert.equal(
        await editor.getByRole("button", { name: /拖动调整Lewis/ }).getAttribute("draggable"),
        "true",
      )
      for (const date of ["2026-11-04", "2026-11-05"])
        await editor.locator(`.shared-calendar [data-day="${date}"] button`).click()
      await selectedDates(["2026-11-04", "2026-11-05"])
      await addSlots("周三", [
        [10, 0],
        [9, 30],
      ])
      await editor.getByRole("button", { name: "前移周三 09:30", exact: true }).focus()
      await page.keyboard.press("Enter")
      assert.deepEqual(
        await weekdayRow("周三").locator(".mison-auto-priorities time").allTextContents(),
        ["09:30", "10:00"],
      )
      const wednesday = weekdayRow("周三")
      await wednesday.getByRole("button", { name: "周三添加时段", exact: true }).click()
      const picker = page.getByRole("group", { name: "周三可添加时段", exact: true })
      assert.equal(
        await picker.getByRole("button", { name: "10:00", exact: true }).isDisabled(),
        true,
        "slots already in the list stay disabled",
      )
      await picker.getByRole("button", { name: "10:30", exact: true }).click()
      await picker.getByRole("button", { name: "取消", exact: true }).click()
      await picker.waitFor({ state: "hidden" })
      assert.deepEqual(
        await wednesday.locator(".mison-auto-priorities time").allTextContents(),
        ["09:30", "10:00"],
        "cancelling the picker adds nothing",
      )
      await wednesday.getByRole("button", { name: "清空周三", exact: true }).click()
      assert.equal(await wednesday.locator(".mison-auto-priorities time").count(), 0)
      await addSlots("周三", [
        [9, 30],
        [10, 0],
      ])
      await addSlot("周四", 18)
      const daily = editor.getByLabel("每天最多预约", { exact: true })
      await daily.evaluate((el) => el.scrollIntoView({ block: "center" }))
      await daily.click()
      await page
        .getByRole("spinbutton", { name: "每天最多预约节数", exact: true })
        .press("ArrowDown")
      await page.getByRole("spinbutton", { name: "每天最多预约节数", exact: true }).press("Enter")
      assert.equal(await daily.inputValue(), "2")
      const rebook = editor.getByRole("checkbox", { name: "取消课程后自动补约", exact: true })
      await rebook.click()
      assert.equal(await rebook.isChecked(), false)
      await editor.getByLabel("最少提前预约", { exact: true }).click()
      await page.getByRole("spinbutton", { name: "最少提前小时数", exact: true }).press("ArrowDown")
      await page.getByRole("spinbutton", { name: "最少提前小时数", exact: true }).press("Enter")
      assert.equal(await editor.getByLabel("最少提前预约", { exact: true }).inputValue(), "26")
      const sleep = editor.getByRole("switch", { name: "启用休眠", exact: true })
      await sleep.click()
      assert.equal(await editor.getByLabel("休眠开始", { exact: true }).isDisabled(), true)
      await sleep.click()
      await time("休眠开始", 22, 0)
      await time("休眠结束", 7, 0)
      await screenshot("auto-settings-configured-1440")
      assert.deepEqual(
        fixture.config.teachers,
        [],
        "unsaved changes do not mutate fixture configuration",
      )
      await internalTab("运行看板").click()
      assert.equal(
        await auto.getByRole("button", { name: "开启任务", exact: true }).isDisabled(),
        true,
      )
      await tabs.getByRole("tab", { name: "教师与约课", exact: true }).click()
      await tabs.getByRole("tab", { name: "课程日历", exact: true }).click()
      await page.locator(".mison-course-calendar").waitFor()
      await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
      await internalTab("预约设置").click()
      await page.locator('[data-view="settings"]').click()
      await page.locator('[data-view="plugin:mison-booking"]').click()
      await editor.waitFor()
      assert.deepEqual(
        await editor
          .locator(".mison-auto-teacher-copy > span:not(.mison-avatar)")
          .allTextContents(),
        ["Jenyy 老师", "Lewis 老师", "Sarah 老师"],
      )
      assert.equal(await editor.getByLabel("最少提前预约", { exact: true }).inputValue(), "26")
      await selectedDates(["2026-11-04", "2026-11-05"])
      await editor.getByRole("status").filter({ hasText: "有未保存的修改" }).waitFor()
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await auto.getByText("设置已保存。", { exact: true }).waitFor()
      assert.deepEqual(
        fixture.config.teachers.map((teacher) => teacher.id),
        ["demo-0", "demo-1", "demo-3"],
      )
      assert.deepEqual(fixture.config.dates, ["2026-11-04", "2026-11-05"])
      assert.deepEqual(fixture.config.weekdaySlots["3"], ["09:30", "10:00"])
      assert.deepEqual(fixture.config.weekdaySlots["4"], ["18:00"])
      assert.equal(fixture.config.minNoticeHours, 26)
      assert.equal(fixture.config.dailyLessons, 2)
      assert.equal(fixture.config.rebookCancelled, false)
      assert.deepEqual(fixture.config.sleep, { enabled: true, start: "22:00", end: "07:00" })
      await ready()
      const start = auto.getByRole("button", { name: "开启任务", exact: true })
      assert.equal(await start.isEnabled(), true)
    },
  )

  await run(
    "saved dashboard, one full-width teacher, wrapping compact slots and scoped details popover",
    async () => {
      await load()
      assert.equal(await internalTab("运行看板").getAttribute("aria-selected"), "true")
      assert.equal(await auto.locator(".mison-auto-schedule:visible").count(), 1)
      const panel = await auto.locator(".mison-auto-teacher-panel:visible").boundingBox()
      const schedule = await auto.locator(".mison-auto-schedule-scroll").boundingBox()
      assert.equal(await auto.locator(".mison-auto-teacher-panel:visible").count(), 1)
      assert.ok(
        schedule.width >= panel.width - 44,
        "selected teacher fills the content width after 20px side margins",
      )
      assert.ok(
        Math.abs(schedule.x - panel.x - 20) <= 2 &&
          Math.abs(panel.x + panel.width - schedule.x - schedule.width - 20) <= 3,
        "schedule content keeps equal 20px side margins",
      )
      const firstDay = auto.locator(".mison-auto-day").first()
      const firstSlot = firstDay.locator(".mison-auto-slot").first()
      assert.match(await firstSlot.innerText(), /08:00.*可约/s)
      assert.doesNotMatch(await firstSlot.innerText(), /08:25|仅展示|未命中/)
      const rows = await firstDay
        .locator(".mison-auto-slot")
        .evaluateAll(
          (items) => new Set(items.map((el) => Math.round(el.getBoundingClientRect().top))).size,
        )
      assert.ok(rows > 1, "time chips wrap onto multiple rows")
      for (const state of ["available", "mine", "occupied", "unscheduled"])
        assert.ok(await auto.locator(`.mison-auto-slot[data-state="${state}"]`).count())
      assert.ok(await auto.locator('.mison-auto-slot[data-matches="true"]').count())
      const navigation = auto.getByRole("tablist", { name: "切换排班老师", exact: true })
      const availableCount = fixture
        .getScheduleDays("demo-0")
        .reduce(
          (count, day) => count + day.slots.filter((slot) => slot.state === "available").length,
          0,
        )
      assert.equal(
        await navigation
          .getByRole("tab", { name: "1. Jenyy 老师", exact: true })
          .locator(".mison-auto-teacher-count")
          .innerText(),
        String(availableCount),
      )
      assert.equal(
        await navigation
          .getByRole("tab", { name: "2. Sarah 老师", exact: true })
          .locator(".mison-auto-teacher-count")
          .innerText(),
        "—",
      )
      await blueMine()
      const allCount = await assertSlotFilter("all")
      const available = await assertSlotFilter("available")
      const matches = await assertSlotFilter("matches")
      assert.ok(
        allCount > available && available > matches && matches > 0,
        "each filter narrows the fixture to a distinct nonempty subset",
      )
      await assertSlotFilter("all")
      await firstSlot.click()
      const details = page.locator('.plugin-overlay [data-slot="popover-content"]:visible')
      assert.equal(await details.getAttribute("aria-label"), "08:00时段详情")
      assert.equal(await details.getAttribute("role"), "dialog")
      await details.getByText("08:00–08:25 · 可约", { exact: true }).waitFor()
      await details.getByText(/Jenyy：未命中日期或当天已有课程/).waitFor()
      assert.equal(await page.locator('body > [data-slot="popover-content"]').count(), 0)
      await screenshot("auto-slot-details-1440")
      await page.keyboard.press("Escape")
      await details.waitFor({ state: "hidden" })
      assert.equal(await firstSlot.evaluate((el) => document.activeElement === el), true)
      await screenshot("auto-dashboard-1440")
      await auto
        .getByRole("tablist", { name: "切换排班老师", exact: true })
        .getByRole("tab", { name: "2. Sarah 老师", exact: true })
        .click()
      await ready()
      assert.equal(await auto.locator(".mison-auto-schedule:visible").count(), 1)
      assert.match(await auto.locator(".mison-auto-schedule").getAttribute("aria-label"), /Sarah/)
      assert.ok(
        fixture.calls.filter(
          (call) => call.name === "auto-booking/schedules" && call.query.teacherId === "demo-3",
        ).length >= 7,
      )
      const axe = await new AxeBuilder({ page })
        .include(".mison-auto-booking")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
      assert.deepEqual(
        axe.violations.map((violation) => ({
          id: violation.id,
          targets: violation.nodes.map((node) => node.target),
        })),
        [],
      )
    },
  )

  await run("start confirmation, immediate stop and reconciliation uses enabled", async () => {
    await load()
    const beforeStart = callCount("auto-booking/start")
    await auto.getByRole("button", { name: "开启任务", exact: true }).click()
    const confirmation = page.getByRole("alertdialog", { name: "开启自动约课", exact: true })
    await confirmation.getByText(/自动向美森提交预约/).waitFor()
    assert.equal(callCount("auto-booking/start"), beforeStart)
    await confirmation.getByRole("button", { name: "暂不开启", exact: true }).click()
    assert.equal(callCount("auto-booking/start"), beforeStart)
    await auto.getByRole("button", { name: "开启任务", exact: true }).click()
    await confirmation.getByRole("button", { name: "确认开启并自动提交预约", exact: true }).click()
    await auto.getByText("运行中", { exact: true }).waitFor()
    assert.equal(callCount("auto-booking/start"), beforeStart + 1)
    const stopBefore = callCount("auto-booking/stop")
    await auto.getByRole("button", { name: "停止任务", exact: true }).click()
    await auto.getByText("已停止", { exact: true }).waitFor()
    assert.equal(callCount("auto-booking/stop"), stopBefore + 1)
    assert.equal(await page.getByRole("alertdialog").count(), 0)
    fixture.reconcile(true)
    await auto.getByRole("button", { name: "刷新自动约课状态", exact: true }).click()
    await auto.getByText("核对中", { exact: true }).waitFor()
    assert.equal(
      await auto.getByRole("button", { name: "停止任务", exact: true }).isEnabled(),
      true,
    )
    assert.equal(await auto.getByRole("button", { name: "开启任务", exact: true }).count(), 0)
    await auto.getByRole("button", { name: "停止任务", exact: true }).click()
    const start = auto.getByRole("button", { name: "开启任务", exact: true })
    await start.waitFor()
    assert.equal(await start.isDisabled(), true, "pending receipt remains read-only after stop")
    await auto.getByText(/只读核验/).waitFor()
    assert.equal(callCount("auto-booking/start"), beforeStart + 1)
  })

  await run(
    "logs paginate encoded timezone cursor and preserve drawer across host visibility",
    async () => {
      await load()
      const before = callCount("auto-booking/logs")
      await auto.getByRole("button", { name: "运行记录", exact: true }).click()
      const logs = page.getByRole("dialog", { name: "自动约课记录", exact: true })
      await logs.getByText("自动约课记录 3", { exact: true }).waitFor()
      assert.equal(await logs.locator(".mison-auto-logs li").count(), 3)
      await logs.getByRole("button", { name: "加载更多", exact: true }).click()
      await logs.getByText("自动约课记录 6", { exact: true }).waitFor()
      assert.equal(await logs.locator(".mison-auto-logs li").count(), 6)
      assert.equal(await logs.getByRole("button", { name: "加载更多", exact: true }).count(), 0)
      await page.evaluate(() => document.querySelector('[data-view="settings"]').click())
      await page.locator(".plugin-overlay[hidden]").waitFor({ state: "attached" })
      await page.locator('[data-view="plugin:mison-booking"]').click()
      await logs.waitFor()
      await frames()
      assert.equal(await logs.locator(".mison-auto-logs li").count(), 6)
      assert.equal(
        callCount("auto-booking/logs") - before,
        2,
        "visibility does not refetch a settled log page",
      )
      await screenshot("auto-logs-pagination")
      await logs.getByRole("button", { name: "关闭自动约课记录", exact: true }).click()
    },
  )

  await run(
    "two-date schedule pages retain earlier slots after errors, retry and navigate",
    async () => {
      const before = callCount("auto-booking/schedules")
      await load({ failSchedule: true })
      await auto.getByText(/模拟自动排班第二页失败/).waitFor()
      const firstSlot = await auto
        .locator(".mison-auto-day")
        .first()
        .locator(".mison-auto-slot")
        .first()
        .elementHandle()
      assert.equal(await auto.locator(".mison-auto-slot").count(), 48)
      await screenshot("auto-schedule-error")
      fixture.setScheduleError(false)
      await auto.getByRole("button", { name: "继续加载", exact: true }).click()
      await ready()
      assert.equal(
        await firstSlot.evaluate((el) => el.isConnected),
        true,
        "retry preserves earlier page DOM",
      )
      assert.deepEqual(
        fixture.calls
          .filter((call) => call.name === "auto-booking/schedules")
          .slice(before)
          .map((call) => call.query.cursor || null),
        [null, "2", "2", "4", "6", "8", "10", "12"],
      )
      assert.equal(await auto.locator(".mison-auto-day").count(), 14)
      assert.equal(await auto.getByText("该日期尚未开放排班。", { exact: true }).count(), 4)
      fixture.setDayError(true)
      await auto.getByRole("button", { name: "刷新排班", exact: true }).click()
      await ready()
      await auto.getByText(/模拟单日排班读取失败/).waitFor()
      fixture.setDayError(false)
      await auto.getByRole("button", { name: "重试排班", exact: true }).click()
      await ready()
      await auto.getByText(/模拟单日排班读取失败/).waitFor({ state: "hidden" })
      await (await dateRange()).getByRole("button", { name: "后14天", exact: true }).click()
      await page.keyboard.press("Escape")
      await ready()
      assert.equal(
        await auto.locator(".mison-auto-day h3 time").first().getAttribute("dateTime"),
        "2026-11-16",
      )
      await (await dateRange()).getByRole("button", { name: "前14天", exact: true }).click()
      await page.keyboard.press("Escape")
      await ready()
      assert.equal(
        await auto.locator(".mison-auto-day h3 time").first().getAttribute("dateTime"),
        today,
      )
    },
  )

  await run("family member is read-only in dashboard and every settings field", async () => {
    await load({ member: true })
    await page.setViewportSize({ width: 820, height: 1180 })
    await auto.getByText("只读", { exact: true }).waitFor()
    assert.equal(await auto.getByRole("button", { name: /开启任务|停止任务/ }).count(), 0)
    const writesBefore = fixture.calls.filter(
      (call) => call.method !== "GET" && call.name.startsWith("auto-booking/"),
    ).length
    await internalTab("预约设置").click()
    await editor.getByText(/之后取消收藏不会移除本策略中的老师/).waitFor()
    assert.match(
      await editor.locator('.shared-calendar [data-day="2026-11-04"]').getAttribute("class"),
      /mison-auto-calendar-booked/,
      "fulfilled date has the booked calendar modifier",
    )
    assert.doesNotMatch(
      await editor.locator('.shared-calendar [data-day="2026-11-05"]').getAttribute("class"),
      /mison-auto-calendar-booked/,
      "unfulfilled target date has no booked marker",
    )
    assert.equal(
      await editor
        .getByRole("button", { name: /保存设置|添加收藏老师|前移|后移|添加时段/ })
        .count(),
      0,
    )
    for (const label of ["最少提前预约", "休眠开始", "休眠结束"])
      assert.equal(await editor.getByLabel(label, { exact: true }).isDisabled(), true)
    assert.equal(
      await editor.getByRole("switch", { name: "启用休眠", exact: true }).isDisabled(),
      true,
    )
    await selectedDates(fixture.config.dates, { disabled: true })
    assert.equal(
      fixture.calls.filter((call) => call.method !== "GET" && call.name.startsWith("auto-booking/"))
        .length,
      writesBefore,
    )
    await noOverflow()
    await screenshot("auto-readonly-820")
  })

  await run(
    "desktop, 820 and 390 native scrollers, wrapping, contained document and host theme isolation",
    async () => {
      await load()
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 820, height: 1180 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport)
        await frames()
        await internalTab("运行看板").click()
        const scroller = auto.locator(".mison-auto-schedule-scroll")
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        await noOverflow()
        const layout = await auto
          .locator(".mison-auto-day")
          .first()
          .evaluate((el) => {
            const heading = el.querySelector(".mison-auto-day-heading").getBoundingClientRect()
            const slots = el.querySelector(".mison-auto-slots").getBoundingClientRect()
            return {
              heading: { x: heading.x, y: heading.y, width: heading.width, bottom: heading.bottom },
              slots: { x: slots.x, y: slots.y },
              rows: new Set(
                [...el.querySelectorAll(".mison-auto-slot")].map((chip) =>
                  Math.round(chip.getBoundingClientRect().top),
                ),
              ).size,
              overflow:
                el.querySelector(".mison-auto-slots").scrollWidth >
                el.querySelector(".mison-auto-slots").clientWidth + 1,
            }
          })
        assert.ok(layout.rows > 1 && !layout.overflow, JSON.stringify(layout))
        if (viewport.width >= 820)
          assert.ok(
            layout.slots.x >= layout.heading.x + layout.heading.width - 1,
            "desktop date metadata stays left of slots",
          )
        else
          assert.ok(
            layout.slots.y >= layout.heading.bottom - 1,
            "mobile date metadata stacks above slots",
          )
        const summary = await auto.locator(".mison-auto-summary").boundingBox()
        const footer = await auto
          .locator(".mison-auto-dashboard > .mison-auto-footer")
          .boundingBox()
        await screenshot(`auto-dashboard-${viewport.width}`)
        await nativeScroll(scroller)
        assert.equal((await auto.locator(".mison-auto-summary").boundingBox()).y, summary.y)
        assert.equal(
          (await auto.locator(".mison-auto-dashboard > .mison-auto-footer").boundingBox()).y,
          footer.y,
        )
        await internalTab("预约设置").click()
        const settingsScroll = editor.locator(".mison-auto-settings-scroll")
        await settingsScroll.evaluate((el) => {
          el.scrollTop = 0
        })
        await settingsLayout(viewport)
        await screenshot(`auto-settings-${viewport.width}`)
        const settingsSize = await settingsScroll.evaluate((el) => ({
          height: el.scrollHeight,
          client: el.clientHeight,
        }))
        if (settingsSize.height <= settingsSize.client + 50) {
          assert.ok(viewport.width >= 820, "narrow settings retain a usable vertical scroller")
          await page.setViewportSize({
            width: viewport.width,
            height: Math.min(viewport.height, 720),
          })
          await frames()
        }
        await nativeScroll(settingsScroll)
        await page.setViewportSize(viewport)
        await frames()
        await internalTab("运行看板").click()
        assert.ok(
          await scroller.evaluate((el) => el.scrollTop > 50),
          "internal tab switches retain schedule scroll",
        )
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
      assert.deepEqual(await hostStyle(), originalHostStyle)
      assert.equal(await page.locator("vite-error-overlay").count(), 0)
      assert.equal(await page.locator("button button").count(), 0)
      assert.ok(await page.title())
      assert.match(page.url(), /127\.0\.0\.1/)
      await captureVisuals()
      assert.deepEqual(await hostStyle(), originalHostStyle)
    },
  )

  return {
    passed: findings.length === 0,
    checks,
    findings,
    screenshots: [...new Set(screenshots)],
    visualLayouts,
    url: page.url(),
    viewports: ["1440x1000", "820x1180", "390x844"],
    browserPath: "Browser plugin not available; existing Playwright host harness",
    autoRequests: fixture.calls.length,
    businessFixtureOnly: fixture.unexpected.length === 0,
  }
}
