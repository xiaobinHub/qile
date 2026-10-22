/* Direct calendar interaction regression, called only by the isolated UI harness. */
const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseDirectCalendar({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("direct calendar targets, touch, keyboard, pending and failed completion")
  const state = await dad.context().storageState()
  const date = await dad.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  })
  for (const [width, height, touch] of [
    [1305, 954, false],
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
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(15000)
    let release, captured
    const received = new Promise((resolve) => {
      captured = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let writes = 0
    await context.route("**/api/**", async (route) => {
      const request = route.request()
      if (request.method() !== "GET") {
        writes++
        assert.equal(request.postDataJSON().kind, "completion.set")
        captured()
        await gate
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "隔离验收：完成操作失败，请重试。" }),
        })
      }
      const response = await route.fetch()
      if (new URL(request.url()).pathname !== `/api/children/${firstId}/data`)
        return route.fulfill({ response })
      const body = await response.json()
      const categoryId = body.data.categories.find((category) => category.active).id
      const tasks = Array.from({ length: 8 }, (_, index) => ({
        id: `direct-calendar-${index}`,
        title: [
          "晨间阅读",
          "数学练习",
          "英语朗读",
          "科学实验",
          "户外活动",
          "整理书桌",
          "钢琴练习",
          "亲子阅读",
        ][index],
        startDate: date,
        startTime: `${String(index + 8).padStart(2, "0")}:00`,
        endTime: `${String(index + 8).padStart(2, "0")}:30`,
        categoryId,
        points: 5,
        note: "",
        recurrence: null,
      }))
      body.data = {
        ...body.data,
        series: tasks,
        exceptions: [],
        completions: [],
        operationLog: [],
      }
      return route.fulfill({ response, json: body })
    })
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#calendarTitle").waitFor()
      assert.match(await page.title(), /成长/)
      const cell = page.locator(`[data-cell-day="${date}"]`)
      await cell.evaluate((element) => {
        const scroll = element.closest(".month-scroll")
        scroll.scrollTop +=
          element.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          scroll.querySelector(".weekday-row").offsetHeight -
          4
      })
      assert.equal(await cell.locator("[data-month-occ]").count(), 8)
      assert.equal(await cell.locator("[data-task-complete]").count(), 8)
      assert.equal(await cell.locator("[data-task-edit]").count(), 8)
      assert.equal(await page.locator("#dayDrawer").count(), 0)
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      )

      // Click an actual blank area, not the day label or either task control.
      const emptyDate = await page
        .locator(".month-cell")
        .filter({ hasNot: page.locator("[data-month-occ]") })
        .first()
        .getAttribute("data-cell-day")
      const blank = page.locator(`[data-cell-day="${emptyDate}"]`)
      const selected = emptyDate
      await blank.scrollIntoViewIfNeeded()
      await blank.click({ position: { x: 10, y: 70 } })
      await page.locator("#taskDialog").waitFor()
      assert.equal((await page.locator("#taskDate").innerText()).trim(), selected)
      assert.equal(await page.locator("#taskTitle").inputValue(), "")
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })
      await page.waitForFunction(
        (selected) => document.activeElement?.getAttribute("data-day") === selected,
        selected,
      )

      const task = cell.locator("[data-month-occ]").first()
      await task.locator("[data-task-edit]").click()
      await page.locator("#taskDialog").waitFor()
      assert.equal(await page.locator("#taskTitle").inputValue(), "晨间阅读")
      assert.equal(await page.locator("#taskStart").inputValue(), "08:00")
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        )
      })
      if (width >= 768) {
        const fields = []
        for (const id of [
          "taskTitle",
          "taskCategory",
          "taskPoints",
          "taskDate",
          "taskStart",
          "taskEnd",
        ])
          fields.push(await page.locator("#" + id).boundingBox())
        assert.ok(
          Math.max(...fields.map((box) => box.width)) -
            Math.min(...fields.map((box) => box.width)) <
            2,
          "All six task controls share equal columns",
        )
      }
      await page.locator("#taskRepeat").click()
      await page.locator("#repeatEndType").click()
      await page.getByRole("option", { name: "截止日期", exact: true }).click()
      const endType = await page.locator("#repeatEndType").boundingBox()
      const until = await page.locator("#repeatUntil").boundingBox()
      assert.ok(
        Math.abs(endType.y - until.y) < 2 && Math.abs(endType.width - until.width) < 2,
        "End type and date share an equal-width row",
      )
      const section = page.locator(".recurrence-section")
      assert.equal(await section.locator("#taskRepeat,#repeatFreq,#repeatUntil").count(), 3)
      const backgrounds = await section.evaluate((element) => [
        getComputedStyle(element.querySelector(".switch-field")).backgroundColor,
        getComputedStyle(element.querySelector(".recurrence-fields")).backgroundColor,
      ])
      assert.notEqual(
        backgrounds[0],
        backgrounds[1],
        "Recurrence heading uses its own subtle background",
      )
      if (width === 1305 || width === 820)
        await page.screenshot({ path: path.join(out, `calendar-form-equal-columns-${width}.png`) })
      assert.equal(writes, 0, "Opening text and blank space never toggles completion")
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-task-edit"))
      if (touch && width >= 768) {
        for (const selector of ["[data-task-complete]", "[data-task-edit]"]) {
          const box = await task.locator(selector).boundingBox()
          assert.ok(box.height >= 44 && box.width >= 44, selector + " iPad touch target")
        }
      }
      if (width === 1305) await axe(page, "calendar-direct-month")
      await page.screenshot({ path: path.join(out, `calendar-direct-${width}-month.png`) })

      const complete = task.locator("[data-task-complete]")
      await cell.evaluate((element) => {
        const active = element.querySelector("[data-month-occ]")
        const other = element.querySelectorAll("[data-month-occ]")[1]
        window.__calendarTaskBefore = other
        window.__calendarScrollBefore = element.closest(".month-scroll").scrollTop
        window.__calendarOtherMutations = []
        window.__calendarObserver = new MutationObserver((records) => {
          window.__calendarOtherMutations.push(
            ...records.filter((record) => !active.contains(record.target)),
          )
        })
        window.__calendarObserver.observe(element, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        })
      })
      await complete.evaluate((button) => {
        button.click()
        button.click()
      })
      await received
      assert.equal(await complete.isDisabled(), true)
      assert.equal(await task.locator("[data-task-edit]").isDisabled(), true)
      assert.equal(
        await cell.locator("[data-month-occ]").nth(1).locator("[data-task-complete]").isDisabled(),
        false,
        "Unrelated task does not dim during submission",
      )
      assert.equal(
        await cell.locator(".day-open").isDisabled(),
        false,
        "Day background stays visually stable",
      )
      assert.equal(await page.locator("#taskDialog,#dayDrawer").count(), 0)
      assert.equal(writes, 1, "Repeated completion clicks send one operation")
      release()
      await page.getByText("隔离验收：完成操作失败，请重试。", { exact: true }).waitFor()
      assert.equal(await complete.getAttribute("aria-pressed"), "false")
      await page.waitForFunction(() => !document.querySelector("[data-task-complete]").disabled)
      assert.equal(await page.locator("#taskDialog,#dayDrawer").count(), 0)
      const stable = await cell.evaluate((element) => {
        window.__calendarObserver.disconnect()
        return {
          sameRow: element.querySelectorAll("[data-month-occ]")[1] === window.__calendarTaskBefore,
          scrollDelta: Math.abs(
            element.closest(".month-scroll").scrollTop - window.__calendarScrollBefore,
          ),
          otherMutations: window.__calendarOtherMutations.length,
        }
      })
      assert.equal(stable.sameRow, true)
      assert.equal(stable.otherMutations, 0, "Only the selected task changes DOM state")
      assert.ok(stable.scrollDelta < 2, "Calendar scroll position remains stable")

      await page.locator('[data-mode="week"]').click()
      await page.locator("#todayBtn").click()
      const weekTask = page.locator("[data-occ]").first()
      await weekTask.locator("[data-task-edit]").click()
      await page.locator("#taskDialog").waitFor()
      assert.equal(await page.locator("#taskTitle").inputValue(), "晨间阅读")
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })
      const header = page.locator("[data-week-day]").first()
      const weekDate = await header.getAttribute("data-week-day")
      await header.press("Enter")
      await page.locator("#taskDialog").waitFor()
      assert.equal((await page.locator("#taskDate").innerText()).trim(), weekDate)
      assert.equal(writes, 1)
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })
      if (width === 1305) await axe(page, "calendar-direct-week")
      await page.screenshot({ path: path.join(out, `calendar-direct-${width}-week.png`) })
      assert.deepEqual(errors, [])
    } finally {
      release()
      await context.close()
    }
  }
}

module.exports = { exerciseDirectCalendar }
