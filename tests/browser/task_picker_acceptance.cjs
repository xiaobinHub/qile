/* Task picker acceptance: authenticated isolated context, every write intercepted. */
const assert = require("node:assert/strict")
const path = require("node:path")
const { selectNumber, selectMonthDay, selectTime } = require("./picker_actions.cjs")

async function exerciseTaskPickers({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("task number wheels, derived duration and monthly day grid across PC and iPad")
  const state = await dad.context().storageState()
  for (const [width, height, touch] of [
    [1135, 789, false],
    [820, 1180, true],
    [1180, 820, true],
    [390, 844, true],
  ]) {
    const context = await browser.newContext({
      storageState: state,
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    const page = await context.newPage(),
      writes = [],
      errors = []
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await context.route("**/api/**", async (route) => {
      const request = route.request()
      if (request.method() === "GET") {
        const response = await route.fetch()
        if (!new URL(request.url()).pathname.endsWith(`/children/${firstId}/data`))
          return route.fulfill({ response })
        const body = await response.json()
        const date = new Date().toLocaleDateString("en-CA")
        body.data.series = [
          {
            id: "picker-existing",
            title: "旧任务时长",
            startDate: date,
            startTime: "08:17",
            endTime: "09:42",
            categoryId: body.data.categories.find((c) => c.active).id,
            points: 12345,
            note: "",
            recurrence: { freq: "daily", interval: 99, endType: "never" },
          },
        ]
        body.data.exceptions = []
        body.data.completions = []
        return route.fulfill({ response, json: body })
      }
      writes.push(request.postDataJSON())
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "选择组件隔离验收：保存被拦截。" }),
      })
    })
    async function settle() {
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        )
      })
    }
    async function screenshot(name) {
      await settle()
      await page.screenshot({ path: path.join(out, `task-pickers-${width}-${name}.png`) })
    }
    async function closePanel(panel) {
      await panel.getByRole("button", { name: "完成", exact: true }).click()
      await panel.waitFor({ state: "hidden" })
    }
    async function centered(wheel) {
      await page.waitForFunction(
        (label) => {
          const el = document.querySelector(`[role="spinbutton"][aria-label="${label}"]`)
          if (!el) return false
          const box = el.getBoundingClientRect(),
            row = document
              .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
              ?.closest("[data-number-value]")
          return (
            row &&
            Number(row.dataset.numberValue) === Number(el.getAttribute("aria-valuenow")) &&
            Math.abs(row.getBoundingClientRect().top + 22 - box.top - box.height / 2) < 1
          )
        },
        await wheel.getAttribute("aria-label"),
      )
    }
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#calendarTitle").waitFor()
      assert.match(await page.title(), /成长/)
      const existing = page.locator('[data-task-edit^="picker-existing@"]').first()
      await existing.click()
      assert.equal(await page.locator("#taskDuration").inputValue(), "1小时25分钟")
      assert.equal(await page.locator("#taskDuration-help").count(), 0)
      await page.locator("#taskPoints").click()
      const pointsPanel = page.getByRole("dialog", { name: "选择奖励积分", exact: true })
      const pointsWheel = pointsPanel.getByRole("spinbutton", { name: "奖励积分", exact: true })
      assert.equal(await pointsWheel.getAttribute("aria-valuenow"), "100")
      assert.equal(await pointsWheel.getAttribute("aria-valuemax"), "100")
      await closePanel(pointsPanel)
      assert.equal(
        await page.locator("#taskPoints").inputValue(),
        "12345",
        "Opening and closing does not rewrite legacy reward points",
      )
      await page.locator("#taskPoints").click()
      await centered(pointsWheel)
      const legacyBox = await pointsWheel.boundingBox()
      await pointsWheel.click({ position: { x: legacyBox.width / 2, y: legacyBox.height / 2 } })
      await closePanel(pointsPanel)
      assert.equal(
        await page.locator("#taskPoints").inputValue(),
        "100",
        "Explicitly choosing the centered row applies the new range",
      )
      await page.locator("#repeatInterval").click()
      const oldIntervalPanel = page.getByRole("dialog", { name: "选择间隔", exact: true })
      await closePanel(oldIntervalPanel)
      assert.equal(
        await page.locator("#repeatInterval").inputValue(),
        "99",
        "Opening and closing preserves a legacy interval",
      )
      await page.locator("#repeatInterval").click()
      const oldIntervalWheel = oldIntervalPanel.getByRole("spinbutton")
      await oldIntervalWheel.press("ArrowDown")
      await closePanel(oldIntervalPanel)
      assert.equal(
        await page.locator("#repeatInterval").inputValue(),
        "1",
        "New interval selections wrap into the supported range",
      )
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })

      await existing.click()
      assert.equal(await page.locator("#taskPoints").inputValue(), "12345")
      await page.locator("#taskPoints").click()
      await pointsWheel.press("End")
      await closePanel(pointsPanel)
      assert.equal(
        await page.locator("#taskPoints").inputValue(),
        "100",
        "Keyboard End explicitly selects the supported maximum",
      )
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })

      await page.locator("#newTaskBtn").click()
      await page.locator("#taskTitle").fill("滚轮表单验收")
      assert.equal(await page.locator("#taskEnd").count(), 0)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时30分钟")
      const points = page.locator("#taskPoints")
      assert.equal(await points.getAttribute("readonly"), "")
      assert.equal(await points.getAttribute("inputmode"), "none")
      await points.pressSequentially("123")
      assert.equal(
        await points.inputValue(),
        "0",
        "New rewards default to zero and remain selection-only",
      )
      await points.click()
      await centered(pointsWheel)
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("role")),
        "spinbutton",
      )
      const box = await pointsWheel.boundingBox()
      await pointsWheel.click({ position: { x: box.width / 2, y: box.height / 2 + 44 } })
      assert.equal(await pointsWheel.getAttribute("aria-valuenow"), "5")
      await centered(pointsWheel)
      await pointsWheel.hover()
      await page.mouse.wheel(0, 132)
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector('[role="spinbutton"][aria-label="奖励积分"]')
              .getAttribute("aria-valuenow"),
          ) > 5,
      )
      await centered(pointsWheel)
      for (let index = 0; index < 3; index++) {
        await pointsWheel.evaluate((el) => {
          el.scrollTop += 44 * 70
        })
        await centered(pointsWheel)
      }
      const scrolledPoints = Number(await pointsWheel.getAttribute("aria-valuenow"))
      assert.ok(scrolledPoints >= 0 && scrolledPoints <= 100 && scrolledPoints % 5 === 0)
      assert.deepEqual(
        [
          ...new Set(
            await pointsWheel
              .locator("[data-number-value]")
              .evaluateAll((rows) => rows.map((row) => Number(row.dataset.numberValue))),
          ),
        ].sort((a, b) => a - b),
        Array.from({ length: 21 }, (_, i) => i * 5),
      )
      if (touch) {
        const cdp = await context.newCDPSession(page),
          before = Number(await pointsWheel.getAttribute("aria-valuenow")),
          bounds = await pointsWheel.boundingBox()
        const x = bounds.x + bounds.width / 2,
          y = bounds.y + bounds.height / 2 + 50
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
        for (let step = 1; step <= 6; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: y - step * 15 }],
          })
          await page.waitForTimeout(16)
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
        await page.waitForFunction(
          (before) =>
            Number(
              document
                .querySelector('[role="spinbutton"][aria-label="奖励积分"]')
                .getAttribute("aria-valuenow"),
            ) !== before,
          before,
        )
        await pointsWheel.evaluate(
          (el) =>
            new Promise((resolve) => {
              let timer
              const done = () => {
                el.removeEventListener("scroll", schedule)
                resolve()
              }
              const schedule = () => {
                clearTimeout(timer)
                timer = setTimeout(done, 300)
              }
              el.addEventListener("scroll", schedule, { passive: true })
              schedule()
            }),
        )
        await centered(pointsWheel)
        await cdp.detach()
      }
      await pointsWheel.press("Home")
      await pointsWheel.press("ArrowUp")
      assert.equal(
        await pointsWheel.getAttribute("aria-valuenow"),
        "100",
        "Reward points wrap from zero to one hundred",
      )
      await pointsWheel.press("ArrowDown")
      assert.equal(
        await pointsWheel.getAttribute("aria-valuenow"),
        "0",
        "Reward points wrap from one hundred to zero",
      )
      await pointsWheel.evaluate((el) => {
        el.scrollTop -= 44
      })
      await centered(pointsWheel)
      assert.equal(
        await pointsWheel.getAttribute("aria-valuenow"),
        "100",
        "Native scroll wraps backwards",
      )
      await pointsWheel.evaluate((el) => {
        el.scrollTop += 44
      })
      await centered(pointsWheel)
      assert.equal(
        await pointsWheel.getAttribute("aria-valuenow"),
        "0",
        "Native scroll wraps forwards",
      )
      await pointsWheel.press("PageDown")
      await pointsWheel.press("ArrowDown")
      await screenshot("number")
      const numericPanelWidth = (await pointsPanel.boundingBox()).width
      assert.ok(
        numericPanelWidth <= 145,
        "Cyclic numeric panel is narrower than the previous 192px",
      )
      if (width === 1135 || width === 820) await axe(page, `task-number-wheel-${width}`)
      // Closing before the next scroll frame still commits the visible center.
      await pointsWheel.evaluate((el) => {
        el.scrollTop += 44
      })
      await page.keyboard.press("Escape")
      await pointsPanel.waitFor({ state: "hidden" })
      assert.equal(await points.inputValue(), "35")
      await page.waitForFunction(() => document.activeElement?.id === "taskPoints")
      await selectNumber(page, "taskPoints", 10)
      await page.locator("#taskRepeat").click()
      await selectNumber(page, "repeatInterval", 15)
      await page.locator("#repeatInterval").click()
      const intervalPanel = page.getByRole("dialog", { name: "选择间隔", exact: true }),
        intervalWheel = intervalPanel.getByRole("spinbutton")
      await intervalWheel.press("ArrowDown")
      assert.equal(await intervalWheel.getAttribute("aria-valuenow"), "1")
      await intervalWheel.press("Home")
      await intervalWheel.press("ArrowUp")
      assert.equal(await intervalWheel.getAttribute("aria-valuenow"), "15")
      const intervalRows = [
        ...new Set(
          await intervalWheel
            .locator("[data-number-value]")
            .evaluateAll((rows) => rows.map((row) => Number(row.dataset.numberValue))),
        ),
      ].sort((a, b) => a - b)
      assert.deepEqual(
        intervalRows,
        Array.from({ length: 15 }, (_, i) => i + 1),
      )
      await screenshot("interval")
      await intervalWheel.press("ArrowDown")
      assert.equal(await intervalWheel.getAttribute("aria-valuenow"), "1")
      await closePanel(intervalPanel)
      for (const id of ["repeatFreq", "repeatEndType"]) {
        await page.locator(`#${id}`).click()
        await page
          .getByRole("option", { name: id === "repeatFreq" ? "每月" : "重复次数", exact: true })
          .click()
      }
      await selectNumber(page, "repeatCount", 60)
      await page.locator("#repeatCount").click()
      const countPanel = page.getByRole("dialog", { name: "选择重复次数", exact: true }),
        countWheel = countPanel.getByRole("spinbutton")
      assert.equal(await countWheel.getAttribute("aria-valuenow"), "60")
      assert.equal(await countWheel.getAttribute("aria-valuemax"), "60")
      const countValues = [
        ...new Set(
          await countWheel
            .locator("[data-number-value]")
            .evaluateAll((rows) => rows.map((row) => Number(row.dataset.numberValue))),
        ),
      ].sort((a, b) => a - b)
      assert.deepEqual(
        countValues,
        Array.from({ length: 60 }, (_, index) => index + 1),
      )
      await centered(countWheel)
      await countWheel.press("ArrowDown")
      assert.equal(await countWheel.getAttribute("aria-valuenow"), "1", "Count wraps from 60 to 1")
      await countWheel.press("ArrowUp")
      assert.equal(await countWheel.getAttribute("aria-valuenow"), "60", "Count wraps from 1 to 60")
      await countWheel.evaluate((el) => {
        el.scrollTop += 44
      })
      await centered(countWheel)
      assert.equal(
        await countWheel.getAttribute("aria-valuenow"),
        "1",
        "Native scrolling wraps forwards",
      )
      await countWheel.evaluate((el) => {
        el.scrollTop -= 44
      })
      await centered(countWheel)
      assert.equal(
        await countWheel.getAttribute("aria-valuenow"),
        "60",
        "Native scrolling wraps backwards",
      )
      await screenshot("count")
      assert.equal(
        (await countPanel.boundingBox()).width,
        numericPanelWidth,
        "Count panel matches reward panel width",
      )
      if (width === 1135 || width === 820) await axe(page, `task-count-wheel-${width}`)
      await closePanel(countPanel)
      assert.equal(await page.locator("#repeatCount").inputValue(), "60")
      await page.waitForFunction(() => document.activeElement?.id === "repeatCount")
      for (const id of ["repeatInterval", "repeatCount"]) {
        assert.equal(await page.locator(`#${id}`).getAttribute("readonly"), "")
        assert.equal(await page.locator(`#${id}`).getAttribute("inputmode"), "none")
      }
      await page.locator("#repeatMonthDay").click()
      const monthPanel = page.getByRole("dialog", { name: "选择每月日期", exact: true })
      assert.equal(await monthPanel.getByRole("radio").count(), 31)
      await page.keyboard.press("End")
      await page.keyboard.press("Enter")
      await monthPanel.waitFor({ state: "hidden" })
      assert.match(await page.locator("#repeatMonthDay").innerText(), /31/)
      await page.waitForFunction(() => document.activeElement?.id === "repeatMonthDay")
      await selectMonthDay(page, 1)
      await page.locator("#repeatMonthDay").click()
      await settle()
      const dayBox = await monthPanel
        .getByRole("radio", { name: "31日", exact: true })
        .boundingBox()
      if (touch) assert.ok(dayBox.width >= 44 && dayBox.height >= 44)
      await screenshot("month-day")
      const panelBox = await monthPanel.boundingBox()
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= width + 1)
      if (width === 1135 || width === 820) await axe(page, `task-month-day-${width}`)
      await monthPanel.getByRole("radio", { name: "31日", exact: true }).click()
      const monthField = await page.locator("#repeatMonthDay").boundingBox(),
        freqField = await page.locator("#repeatFreq").boundingBox()
      assert.ok(
        Math.abs(monthField.width - freqField.width) < 2,
        "Monthly day field is the same half width as frequency",
      )

      await selectTime(page, "taskStart", 8, 17)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时30分钟")
      assert.equal(await page.locator("#taskDuration-help").count(), 0)
      await selectTime(page, "taskDuration", 1, 25)
      assert.equal(await page.locator("#taskDuration-help").count(), 0)
      await selectTime(page, "taskStart", 9, 18)
      assert.equal(await page.locator("#taskDuration").inputValue(), "1小时25分钟")
      await selectTime(page, "taskDuration", 0, 0)
      await page.locator("#taskDialog button[type='submit']").click()
      assert.equal(writes.length, 0)
      assert.equal(await page.locator("#taskDuration").getAttribute("aria-invalid"), "true")
      await selectTime(page, "taskDuration", 1, 25)
      await selectTime(page, "taskStart", 23, 40)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时19分钟")
      await page.locator("#taskDuration").click()
      const durationPanel = page.getByRole("dialog", { name: "选择持续时长", exact: true })
      const durationHours = durationPanel.getByRole("spinbutton", { name: "小时", exact: true })
      const durationMinutes = durationPanel.getByRole("spinbutton", { name: "分钟", exact: true })
      assert.equal(await durationHours.getAttribute("aria-valuemax"), "0")
      assert.equal(await durationMinutes.getAttribute("aria-valuemax"), "19")
      assert.ok(
        (await durationMinutes.locator("[data-wheel-index]").allTextContents()).every(
          (v) => Number(v) <= 19,
        ),
      )
      await durationMinutes.press("End")
      await closePanel(durationPanel)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时19分钟")
      assert.equal(await page.locator("#taskDuration-error").count(), 0)
      assert.equal(await page.locator("#taskError").count(), 0)
      assert.equal(writes.length, 0)

      // The minute limit changes with the chosen hour, and restores on a shorter hour.
      await selectTime(page, "taskStart", 17, 15)
      await selectTime(page, "taskDuration", 5, 55)
      await page.locator("#taskDuration").click()
      assert.equal(await durationHours.getAttribute("aria-valuemax"), "6")
      await durationHours.press("End")
      assert.equal(await durationMinutes.getAttribute("aria-valuemax"), "44")
      assert.equal(await durationMinutes.getAttribute("aria-valuenow"), "44")
      await durationMinutes.press("End")
      await closePanel(durationPanel)
      assert.equal(await page.locator("#taskDuration").inputValue(), "6小时44分钟")
      await page.locator("#taskDuration").click()
      await durationHours.press("ArrowUp")
      assert.equal(await durationMinutes.getAttribute("aria-valuemax"), "59")
      await durationMinutes.press("End")
      await closePanel(durationPanel)
      assert.equal(await page.locator("#taskDuration").inputValue(), "5小时59分钟")
      await selectTime(page, "taskStart", 23, 59)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时0分钟")
      await page.locator("#taskDuration").click()
      assert.equal(await durationHours.getAttribute("aria-valuemax"), "0")
      assert.equal(await durationMinutes.getAttribute("aria-valuemax"), "0")
      await durationHours.press("End")
      await durationMinutes.press("End")
      await closePanel(durationPanel)
      assert.equal(await page.locator("#taskDuration").inputValue(), "0小时0分钟")
      await selectTime(page, "taskStart", 0, 0)
      await selectTime(page, "taskDuration", 23, 59)
      assert.equal(await page.locator("#taskDuration").inputValue(), "23小时59分钟")
      await selectTime(page, "taskStart", 10, 7)
      await selectTime(page, "taskDuration", 1, 35)
      assert.equal(await page.locator("#taskDuration").inputValue(), "1小时35分钟")
      await screenshot("form")
      await page.locator("#taskDuration").click()
      await screenshot("duration")
      await page.keyboard.press("Escape")
      if (width === 1135 || width === 820) await axe(page, `task-selection-form-${width}`)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      )
      await page.locator("#taskDialog button[type='submit']").click()
      await page.getByText("选择组件隔离验收：保存被拦截。", { exact: true }).waitFor()
      assert.equal(writes.length, 1, "Only the explicit valid save attempts a write")
      const task = writes[0].payload.task
      assert.equal(task.startTime, "10:07")
      assert.equal(task.endTime, "11:42")
      assert.equal(task.points, 10)
      assert.equal(task.recurrence.monthDay, 31)
      assert.equal(task.recurrence.count, 60)
      assert.equal(task.recurrence.interval, 1)
      assert.equal(Object.hasOwn(task, "duration"), false, "Persist the established API contract")
      assert.deepEqual(errors, [])
    } catch (error) {
      await page.screenshot({ path: path.join(out, `task-pickers-failure-${width}.png`) })
      throw error
    } finally {
      await context.close()
    }
  }
}

module.exports = { exerciseTaskPickers }
