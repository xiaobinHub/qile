const assert = require("node:assert/strict")

exports.exerciseGroupedSettings = async function ({
  page,
  fixture,
  editor,
  auto,
  tabs,
  internalTab,
  load,
  run: runCase,
  screenshot,
  frames,
  callCount,
  noOverflow,
  entryUrl,
}) {
  const run = async (name, fn) => {
    if (!process.env.MISON_SETTINGS_CASE || name.includes(process.env.MISON_SETTINGS_CASE))
      await runCase(name, fn)
  }
  const toggle = () => editor.getByRole("switch", { name: "Bark App", exact: true })
  const configure = () => editor.getByRole("button", { name: "配置 Bark App", exact: true })
  const drawer = () => page.getByRole("dialog", { name: "Bark App", exact: true })
  const key = (index) => drawer().getByLabel(`Bark Key ${index}`, { exact: true })
  const deviceName = (index) => drawer().getByLabel(`设备名称 ${index}`, { exact: true })
  const button = (name) => drawer().getByRole("button", { name, exact: true })
  const scene = () => drawer().getByRole("checkbox", { name: "约课成功", exact: true })
  const putCount = () => callCount("auto-booking/config", "PUT")
  const notifications = {
    enabled: true,
    barkKeys: ["fixture_key-001", "fixture_key-002"],
    barkKeyNames: ["爸爸的 iPhone", "客厅 iPad"],
    events: ["booked"],
  }
  async function open() {
    await configure().click()
    await drawer().waitFor()
  }
  async function done() {
    await button("保存").click()
    await drawer().waitFor({ state: "hidden" })
  }
  async function invalid(field) {
    await field.focus()
    await field.press("Tab")
    assert.equal(await field.getAttribute("aria-invalid"), "true")
    assert.equal(await button("保存").isDisabled(), true)
  }
  async function focusInside() {
    assert.equal(await drawer().evaluate((el) => el.contains(document.activeElement)), true)
  }
  async function focused(locator) {
    await page.waitForFunction(
      (el) => el === document.activeElement,
      await locator.elementHandle(),
      { timeout: 2000 },
    )
  }
  async function notice(value) {
    const slider = editor.getByRole("slider", { name: "最少提前预约", exact: true })
    const current = Number(await slider.getAttribute("aria-valuenow"))
    for (let i = 0; i < Math.abs(value - current); i++)
      await slider.press(value < current ? "ArrowLeft" : "ArrowRight")
    assert.equal(await slider.getAttribute("aria-valuenow"), String(value))
  }
  async function checkingTime(name, target) {
    const slider = editor.getByRole("slider", { name, exact: true })
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = Number(await slider.getAttribute("aria-valuenow"))
      if (current === target) return
      const key = current < target ? "ArrowRight" : "ArrowLeft"
      await slider.press(Math.abs(current - target) >= 10 ? `Shift+${key}` : key)
    }
    assert.fail("Checking time did not reach requested minute")
  }

  await run("three semantic groups retain defaults and interval controls", async () => {
    await load({ empty: true, legacy: true })
    for (const title of ["执行节奏", "预约规则", "消息提醒"])
      assert.equal(await editor.getByRole("heading", { name: title, exact: true }).count(), 1)
    assert.equal(await editor.getByRole("heading", { name: "执行规则", exact: true }).count(), 0)
    assert.equal(await editor.getByRole("button", { name: /执行节奏说明|预约规则说明/ }).count(), 0)
    assert.equal(await editor.getByRole("switch", { name: "消息提醒", exact: true }).count(), 0)
    assert.equal(await editor.getByText("尚未配置", { exact: true }).count(), 0)
    assert.equal(await editor.locator(".mison-auto-notification-summary").count(), 0)
    const channel = editor.getByRole("group", { name: "Bark App", exact: true })
    assert.equal(await channel.getByRole("switch", { name: "Bark App", exact: true }).count(), 1)
    assert.equal(
      await channel.getByRole("button", { name: "配置 Bark App", exact: true }).count(),
      1,
    )
    assert.equal(
      await editor.locator('.mison-auto-notifications-card input:not([type="checkbox"])').count(),
      0,
    )
    assert.equal(await editor.locator('[id$="check-description"]').count(), 0)
    assert.equal(await editor.locator(".mison-auto-check-limits").count(), 0)
    const rhythm = editor.getByRole("group", { name: "执行节奏", exact: true })
    const rules = editor.getByRole("group", { name: "预约规则", exact: true })
    assert.equal(await rhythm.getByRole("slider").count(), 4)
    assert.equal(await rules.getByRole("slider").count(), 2)
    assert.equal(await rhythm.getByRole("switch", { name: /休眠|检查时间/ }).count(), 0)
    assert.equal(
      await rhythm
        .getByRole("slider", { name: "检查开始", exact: true })
        .getAttribute("aria-valuetext"),
      "08:00",
    )
    assert.equal(
      await rhythm
        .getByRole("slider", { name: "检查结束", exact: true })
        .getAttribute("aria-valuetext"),
      "23:00",
    )
    const min = rhythm.getByRole("slider", { name: "最短检查间隔", exact: true })
    const before = Number(await min.getAttribute("aria-valuenow"))
    await min.focus()
    await min.press("ArrowRight")
    assert.equal(Number(await min.getAttribute("aria-valuenow")), before + 1)
    assert.equal(await toggle().isChecked(), false)
  })

  await run("weekday settings add and remove slots locally while compact teachers retain ordering", async () => {
    await load({ settings: true })
    await page.setViewportSize({ width: 1305, height: 889 })
    const before = putCount()
    const teachers = editor.locator(".mison-auto-teachers-card .mison-auto-priorities > li")
    const teacherNames = editor.locator(".mison-auto-teacher-copy > span:not(.mison-avatar)")
    await editor.getByRole("button", { name: "添加收藏老师", exact: true }).click()
    const favorites = page.getByRole("dialog", { name: "添加老师", exact: true })
    await favorites.getByRole("checkbox", { name: "Rina 老师", exact: true }).check()
    await favorites.getByRole("button", { name: "完成", exact: true }).click()
    await favorites.waitFor({ state: "hidden" })
    assert.deepEqual(await teacherNames.allTextContents(), ["Jenyy", "Sarah", "Rina"])
    await teachers.nth(2).press("ArrowLeft")
    assert.deepEqual(await teacherNames.allTextContents(), ["Jenyy", "Rina", "Sarah"])
    const teacherGeometry = await teachers.evaluateAll((nodes) => nodes.map((el) => {
      const name = el.querySelector(".mison-auto-teacher-copy > span:not(.mison-avatar)")
      const range = document.createRange()
      range.selectNodeContents(name)
      return { card: el.getBoundingClientRect().width, text: range.getBoundingClientRect().width }
    }))
    assert.ok(Math.max(...teacherGeometry.map((t) => t.card)) - Math.min(...teacherGeometry.map((t) => t.card)) > 3)
    const overhead = teacherGeometry.map((t) => t.card - t.text)
    assert.ok(Math.max(...overhead) - Math.min(...overhead) < 2, "teacher cards fit their name widths")
    const row = editor.getByRole("group", { name: "周三时段优先级", exact: true })
    const trigger = row.getByRole("button", { name: "周三设置时段", exact: true })
    const picker = row.getByRole("group", { name: "周三时段设置", exact: true })
    const times = () => row.locator(".mison-auto-priorities time").allTextContents()
    assert.equal(await trigger.getAttribute("data-variant"), "ghost")
    assert.equal(await row.getByRole("button", { name: /^移除/ }).count(), 0)
    assert.deepEqual(await times(), ["09:30", "10:00"])
    await trigger.click()
    const existing = picker.getByRole("button", { name: "10:00", exact: true })
    assert.equal(await existing.isEnabled(), true)
    assert.equal(await existing.getAttribute("aria-pressed"), "true")
    await existing.click()
    await picker.getByRole("button", { name: "10:30", exact: true }).click()
    assert.deepEqual(await times(), ["09:30", "10:00"])
    await picker.getByRole("button", { name: "取消", exact: true }).click()
    await focused(trigger)
    assert.deepEqual(await times(), ["09:30", "10:00"])
    await trigger.click()
    assert.equal(await existing.getAttribute("aria-pressed"), "true")
    assert.equal(await picker.getByRole("button", { name: "10:30", exact: true }).getAttribute("aria-pressed"), "false")
    await existing.click()
    await picker.getByRole("button", { name: "09:00", exact: true }).click()
    await picker.getByRole("button", { name: "保存", exact: true }).click()
    assert.deepEqual(await times(), ["09:30", "09:00"])
    const reordered = row.getByRole("listitem", { name: "拖动或按上下方向键调整周三 09:00优先级", exact: true })
    await reordered.press("ArrowUp")
    assert.deepEqual(await times(), ["09:00", "09:30"])
    assert.equal(putCount(), before)
    assert.deepEqual(fixture.config.weekdaySlots["3"], ["09:30", "10:00"])
    await trigger.click()
    for (const time of ["09:00", "09:30"])
      await picker.getByRole("button", { name: time, exact: true }).click()
    await picker.getByRole("button", { name: "保存", exact: true }).click()
    assert.deepEqual(await times(), [])
    await row.getByText("不预约", { exact: true }).waitFor()
    await trigger.click()
    for (const time of ["05:00", "05:30"])
      await picker.getByRole("button", { name: time, exact: true }).click()
    await picker.getByRole("button", { name: "保存", exact: true }).click()
    assert.deepEqual(await times(), ["05:00", "05:30"])
    await trigger.click()
    await picker.getByRole("button", { name: "06:00", exact: true }).click()
    await page.keyboard.press("Escape")
    await focused(trigger)
    assert.deepEqual(await times(), ["05:00", "05:30"])
    await editor.getByRole("button", { name: "保存设置", exact: true }).click()
    await page.getByText("设置已保存。", { exact: true }).waitFor()
    assert.equal(putCount(), before + 1)
    assert.deepEqual(fixture.config.weekdaySlots["3"], ["05:00", "05:30"])
    assert.deepEqual(fixture.config.teachers.map((t) => t.name), ["Jenyy", "Rina", "Sarah"])
    await editor.locator(".mison-auto-settings-scroll").evaluate((el) => { el.scrollTop = 0 })
    await screenshot("auto-settings-compact-teachers-weekdays")
    await noOverflow()
  })

  await run("live slot sorting previews before release and keeps settings beside wrapped rows", async () => {
    await load({ settings: true })
    await page.setViewportSize({ width: 1305, height: 889 })
    const before = putCount()
    const row = editor.getByRole("group", { name: "周一时段优先级", exact: true })
    const list = row.locator(".mison-auto-priorities")
    const times = () => list.locator("time").allTextContents()
    const trigger = row.getByRole("button", { name: "周一设置时段", exact: true })
    const picker = row.getByRole("group", { name: "周一时段设置", exact: true })
    const selected = ["19:30", "19:00", "20:00", "20:30", "21:00", "22:00", "21:30", "22:30", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"]
    await trigger.click()
    for (const time of selected)
      await picker.getByRole("button", { name: time, exact: true }).click()
    await picker.getByRole("button", { name: "保存", exact: true }).click()
    await row.scrollIntoViewIfNeeded()
    await frames()
    assert.deepEqual(await times(), selected)
    for (const width of [1305, 1034, 820, 390]) {
      await page.setViewportSize({ width, height: 889 })
      await row.scrollIntoViewIfNeeded()
      await frames()
      const geometry = await row.evaluate((el) => {
        const list = el.querySelector("ol").getBoundingClientRect()
        const button = el.querySelector(".mison-auto-weekday-actions button").getBoundingClientRect()
        const items = el.querySelectorAll("ol > li")
        return {
          listRight: list.right, listTop: list.top, listBottom: list.bottom,
          buttonLeft: button.left, buttonTop: button.top, buttonBottom: button.bottom,
          wrapped: items[0].getBoundingClientRect().top < items[items.length - 1].getBoundingClientRect().top,
        }
      })
      assert.equal(geometry.wrapped, true)
      assert.ok(geometry.buttonLeft >= geometry.listRight + 7)
      assert.ok(geometry.buttonTop >= geometry.listTop - 1 && geometry.buttonBottom <= geometry.listBottom + 1)
      await noOverflow()
      await screenshot(`auto-weekday-wrapped-${width}`)
    }
    await page.setViewportSize({ width: 1305, height: 889 })
    await row.scrollIntoViewIfNeeded()
    await frames()
    async function beginDrag(source, target, forward) {
      const sourceRect = await source.boundingBox()
      const targetRect = await target.boundingBox()
      await page.mouse.move(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2)
      await page.mouse.down()
      await page.mouse.move(sourceRect.x + sourceRect.width / 2 + 8, sourceRect.y + sourceRect.height / 2 + 2, { steps: 4 })
      const x = targetRect.x + targetRect.width * (forward ? 0.8 : 0.2)
      const y = targetRect.y + targetRect.height * (forward ? 0.8 : 0.2)
      await page.mouse.move(x, y, { steps: 12 })
      await page.mouse.move(x, y)
      return { x, y }
    }
    const source = list.getByRole("listitem", { name: "拖动或按上下方向键调整周一 16:00优先级", exact: true })
    const target = list.getByRole("listitem", { name: "拖动或按上下方向键调整周一 19:30优先级", exact: true })
    const pointer = await beginDrag(source, target, false)
    await page.waitForFunction((el) => el.dataset.sorting === "true", await list.elementHandle())
    await frames()
    const preview = await times()
    assert.ok(preview.indexOf("16:00") < selected.indexOf("16:00"), "slots visibly reorder before the mouse is released")
    assert.deepEqual([...preview].sort(), [...selected].sort())
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(pointer.x, pointer.y)
      await frames()
      assert.deepEqual(await times(), preview, "stationary drag does not oscillate")
    }
    assert.equal(putCount(), before)
    assert.deepEqual(fixture.config.weekdaySlots["1"], [])
    await screenshot("auto-weekday-live-drag")
    await page.mouse.up()
    await page.waitForFunction((el) => el.dataset.sorting === "false", await list.elementHandle())
    assert.deepEqual(await times(), preview, "drop retains the preview order")
    const cancelSource = list.getByRole("listitem", { name: "拖动或按上下方向键调整周一 16:00优先级", exact: true })
    const cancelTarget = list.getByRole("listitem", { name: "拖动或按上下方向键调整周一 18:30优先级", exact: true })
    await beginDrag(cancelSource, cancelTarget, true)
    await frames()
    assert.notDeepEqual(await times(), preview)
    await page.keyboard.press("Escape")
    await page.mouse.up()
    await page.waitForFunction((el) => el.dataset.sorting === "false", await list.elementHandle())
    assert.deepEqual(await times(), preview, "cancelled drag restores the previous draft order")
    const teacherList = editor.locator(".mison-auto-teachers-card ol")
    await teacherList.scrollIntoViewIfNeeded()
    const teacherLabels = () => teacherList.locator(".mison-auto-teacher-copy > span:not(.mison-avatar)").allTextContents()
    await beginDrag(
      teacherList.getByRole("listitem", { name: "拖动或按上下方向键调整Sarah优先级", exact: true }),
      teacherList.getByRole("listitem", { name: "拖动或按上下方向键调整Jenyy优先级", exact: true }),
      false,
    )
    await frames()
    assert.deepEqual(await teacherLabels(), ["Sarah", "Jenyy"], "teacher cards also preview their positions during dragging")
    await page.mouse.up()
    await page.waitForFunction((el) => el.dataset.sorting === "false", await teacherList.elementHandle())
    assert.deepEqual(await teacherLabels(), ["Sarah", "Jenyy"])
    assert.equal(putCount(), before)
    await editor.getByRole("button", { name: "保存设置", exact: true }).click()
    await page.getByText("设置已保存。", { exact: true }).waitFor()
    assert.equal(putCount(), before + 1)
    assert.deepEqual(fixture.config.weekdaySlots["1"], preview)
    assert.deepEqual(fixture.config.teachers.map((teacher) => teacher.name), ["Sarah", "Jenyy"])
  })

  await run(
    "checking window uses a midnight-centered day, full-day noon span and inverse saved interval",
    async () => {
      await load({ empty: true })
      const before = putCount()
      const start = editor.getByRole("slider", { name: "检查开始", exact: true })
      const end = editor.getByRole("slider", { name: "检查结束", exact: true })
      const field = editor.locator(".mison-auto-check-window")
      assert.deepEqual(await field.locator(".mison-auto-time-axis > span").allTextContents(), [
        "12:00",
        "00:00",
        "12:00",
      ])
      const centered = await field.evaluate((el) => {
        const track = el.querySelector(".mison-auto-time-track").getBoundingClientRect()
        const zero = el.querySelector(".mison-auto-midnight-tick").getBoundingClientRect()
        return Math.abs(zero.left - (track.left + track.width / 2)) < 1
      })
      assert.equal(centered, true)
      assert.equal(await field.getByRole("switch").count(), 0)
      assert.equal(await field.locator(".mison-auto-time-track .mison-auto-check-range").count(), 2)
      await start.press("Home")
      await end.press("End")
      await field.getByText("全天执行", { exact: true }).waitFor()
      assert.equal(await start.getAttribute("aria-valuenow"), "0")
      assert.equal(await end.getAttribute("aria-valuenow"), "1440")
      assert.equal(putCount(), before)
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.equal(fixture.config.sleep.enabled, false)
      assert.notEqual(fixture.config.sleep.start, fixture.config.sleep.end)
      await page.goto(entryUrl)
      await page.locator('[data-view="plugin:mison-booking"]').click()
      await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
      await internalTab("预约设置").click()
      await field.getByText("全天执行", { exact: true }).waitFor()
      await start.press("End")
      await end.press("Home")
      await field.getByText("全天执行", { exact: true }).waitFor()
      assert.equal(await start.getAttribute("aria-valuetext"), "12:00")
      assert.equal(await end.getAttribute("aria-valuetext"), "12:00")
      await checkingTime("检查开始", 660)
      await checkingTime("检查结束", 1200)
      await field.getByText("23:00～次日 08:00", { exact: true }).waitFor()
      assert.equal(await field.locator(".mison-auto-time-track .mison-auto-check-range").count(), 1)
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.deepEqual(fixture.config.sleep, { enabled: true, start: "08:00", end: "23:00" })
      await start.press("Home")
      await end.press("End")
      await checkingTime("检查开始", 1200)
      await checkingTime("检查结束", 660)
      await field.getByText("08:00～23:00", { exact: true }).waitFor()
      assert.equal(await field.locator(".mison-auto-time-track .mison-auto-check-range").count(), 2)
      const track = field.locator(".mison-auto-time-track")
      await track.scrollIntoViewIfNeeded()
      const rect = await track.boundingBox()
      const oldStart = await start.getAttribute("aria-valuenow")
      await page.mouse.move(rect.x + rect.width * 0.8, rect.y + rect.height / 2)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width * 0.9, rect.y + rect.height / 2, { steps: 6 })
      await page.mouse.up()
      assert.notEqual(await start.getAttribute("aria-valuenow"), oldStart)
      assert.equal(await end.getAttribute("aria-valuenow"), "660")
      const thumb = await start.boundingBox()
      await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
      await page.mouse.down()
      await page.mouse.move(rect.x + rect.width * 0.85, rect.y + rect.height / 2, { steps: 4 })
      await page.mouse.up()
      assert.equal(await end.getAttribute("aria-valuenow"), "660")
      assert.ok(Number(await start.getAttribute("aria-valuenow")) < 1300)
    },
  )

  await run(
    "booking rule sliders retain limits, drafts, saves and larger existing notice values",
    async () => {
      await load({ empty: true })
      const before = putCount()
      const advance = editor.getByRole("slider", { name: "最少提前预约", exact: true })
      const daily = editor.getByRole("slider", { name: "每天最多预约", exact: true })
      assert.equal(await advance.getAttribute("aria-valuenow"), "25")
      assert.equal(await advance.getAttribute("aria-valuemin"), "0")
      assert.equal(await advance.getAttribute("aria-valuemax"), "72")
      await advance.press("End")
      await advance.press("ArrowRight")
      assert.equal(await advance.getAttribute("aria-valuenow"), "72")
      await advance.press("Home")
      await advance.press("ArrowLeft")
      assert.equal(await advance.getAttribute("aria-valuenow"), "0")
      assert.equal(await daily.getAttribute("aria-valuemin"), "1")
      assert.equal(await daily.getAttribute("aria-valuemax"), "4")
      await daily.press("End")
      await daily.press("ArrowRight")
      assert.equal(await daily.getAttribute("aria-valuenow"), "4")
      await daily.press("Home")
      await daily.press("ArrowLeft")
      assert.equal(await daily.getAttribute("aria-valuenow"), "1")
      const track = editor
        .locator(".mison-auto-rule-slider-field")
        .filter({ has: page.getByRole("slider", { name: "每天最多预约", exact: true }) })
        .locator(".mison-auto-check-track")
      const bounds = await track.boundingBox()
      await page.mouse.click(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2)
      assert.equal(await daily.getAttribute("aria-valuenow"), "4")
      assert.equal(await daily.getAttribute("aria-valuetext"), "4 节")
      assert.equal(putCount(), before)
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.equal(putCount(), before + 1)
      assert.equal(fixture.config.minNoticeHours, 0)
      assert.equal(fixture.config.dailyLessons, 4)
      await load({ empty: true, minNoticeHours: 120 })
      assert.equal(await advance.getAttribute("aria-valuenow"), "120")
      assert.equal(await advance.getAttribute("aria-valuemax"), "120")
      await advance.press("ArrowLeft")
      assert.equal(await advance.getAttribute("aria-valuenow"), "119")
      assert.equal(await advance.getAttribute("aria-valuemax"), "120")
    },
  )

  await run(
    "incomplete enable validates locally and cancellation restores switch and focus",
    async () => {
      await load({ empty: true })
      const before = putCount()
      await toggle().click()
      await drawer().waitFor()
      assert.equal(await deviceName(1).inputValue(), "")
      assert.equal(await deviceName(1).getAttribute("placeholder"), "设备名称")
      assert.equal(await key(1).inputValue(), "")
      assert.equal(await button("保存").isDisabled(), true)
      for (const input of [deviceName(1), key(1)]) {
        assert.equal(await input.getAttribute("autocomplete"), "off")
        assert.equal(await input.getAttribute("required"), "")
      }
      assert.equal(await drawer().locator("form").getAttribute("autocomplete"), "off")
      assert.equal(await key(1).getAttribute("type"), "text")
      assert.equal(await drawer().getByRole("button", { name: /显示|隐藏/ }).count(), 0)
      await invalid(deviceName(1))
      await invalid(key(1))
      assert.ok(await drawer().getByRole("alert").count())
      await key(1).fill("bad key")
      await key(1).press("Enter")
      assert.equal(await drawer().isVisible(), true)
      assert.equal(putCount(), before)
      await key(1).fill("fixture_key-001")
      assert.equal(await button("保存").isDisabled(), true)
      await deviceName(1).fill("  ")
      await invalid(deviceName(1))
      await deviceName(1).fill("我的手机")
      assert.equal(await button("保存").isDisabled(), false)
      await scene().click()
      await invalid(scene())
      await button("取消").click()
      await drawer().waitFor({ state: "hidden" })
      assert.equal(await toggle().isChecked(), false)
      await focused(toggle())
      assert.equal(putCount(), before)
    },
  )

  await run(
    "drawer save trims multiple keys and page save submits every setting once",
    async () => {
      await load({ empty: true })
      const before = putCount()
      await notice(12)
      await toggle().click()
      await drawer().waitFor()
      await key(1).fill("  fixture_key-001  ")
      await deviceName(1).fill(notifications.barkKeyNames[0])
      await button("添加设备").click()
      await frames()
      assert.equal(await key(2).inputValue(), "")
      assert.equal(await deviceName(2).inputValue(), "")
      assert.equal(await button("保存").isDisabled(), true)
      await key(2).fill("fixture_key-001")
      await invalid(key(2))
      await key(2).fill("fixture_key-002")
      await deviceName(2).fill(notifications.barkKeyNames[1])
      assert.equal(await key(1).getAttribute("type"), "text")
      assert.equal(await key(2).getAttribute("type"), "text")
      assert.equal(await drawer().getByRole("button", { name: /显示|隐藏/ }).count(), 0)
      await button("添加设备").click()
      await button("移除 Bark Key 3").click()
      await done()
      assert.equal(await toggle().isChecked(), true)
      await editor.getByText("约课成功 · 2 个 Key", { exact: true }).waitFor()
      assert.equal(putCount(), before)
      assert.equal(fixture.config.notifications.enabled, false)
      await toggle().click()
      assert.equal(await drawer().count(), 0)
      assert.equal(await toggle().isChecked(), false)
      await toggle().click()
      assert.equal(await drawer().count(), 0)
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.equal(putCount(), before + 1)
      assert.deepEqual(fixture.config.notifications, notifications)
      assert.equal(fixture.config.minNoticeHours, 12)
      const body = fixture.calls
        .filter((c) => c.name === "auto-booking/config" && c.method === "PUT")
        .at(-1).body
      assert.deepEqual(body.notifications, notifications)
      assert.deepEqual(body.sleep, fixture.config.sleep)
      assert.deepEqual(body.checkInterval, fixture.config.checkInterval)
      // Reload the fixture page without resetting saved config.
      await page.goto(entryUrl)
      await page.locator('[data-view="plugin:mison-booking"]').click()
      await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
      await internalTab("预约设置").click()
      await open()
      assert.equal(await key(1).inputValue(), notifications.barkKeys[0])
      assert.equal(await key(2).inputValue(), notifications.barkKeys[1])
      await button("取消").click()
      await drawer().waitFor({ state: "hidden" })
      assert.equal(
        await editor.getByRole("button", { name: "保存设置", exact: true }).isDisabled(),
        true,
      )
    },
  )

  await run(
    "cancel, close, escape and backdrop discard drawer edits and restore focus",
    async () => {
      await load({ empty: true, notifications })
      const before = putCount()
      for (const method of ["取消", "关闭Bark App", "escape", "backdrop"]) {
        await open()
        await key(1).fill("unsaved_key-999")
        if (method === "escape") await page.keyboard.press("Escape")
        else if (method === "backdrop") await page.mouse.click(8, 400)
        else await button(method).click()
        await drawer().waitFor({ state: "hidden" })
        await focused(configure())
        await open()
        assert.equal(await key(1).inputValue(), notifications.barkKeys[0])
        await button("取消").click()
        await drawer().waitFor({ state: "hidden" })
      }
      await open()
      await key(1).focus()
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press("Tab")
        await focusInside()
      }
      await page.keyboard.press("Escape")
      assert.equal(putCount(), before)
    },
  )

  await run(
    "Bark device names remain paired through cancellation, removal and save/reload",
    async () => {
      await load({ empty: true, notifications })
      const before = putCount()
      await open()
      assert.equal(await deviceName(1).inputValue(), notifications.barkKeyNames[0])
      await deviceName(1).fill("尚未保存的设备")
      await button("取消").click()
      await drawer().waitFor({ state: "hidden" })
      await open()
      assert.equal(await deviceName(1).inputValue(), notifications.barkKeyNames[0])
      await deviceName(2).fill("  平板  ")
      await button("移除 Bark Key 1").click()
      assert.equal(await key(1).inputValue(), notifications.barkKeys[1])
      assert.equal(await deviceName(1).inputValue(), "  平板  ")
      await button("添加设备").click()
      await frames()
      await key(2).fill("fixture_key-003")
      assert.equal(await deviceName(2).inputValue(), "")
      await deviceName(2).fill("妈妈的手机")
      await screenshot("auto-bark-device-names")
      await done()
      assert.equal(putCount(), before)
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.deepEqual(fixture.config.notifications, {
        ...notifications,
        barkKeys: ["fixture_key-002", "fixture_key-003"],
        barkKeyNames: ["平板", "妈妈的手机"],
      })
      await page.goto(entryUrl)
      await page.locator('[data-view="plugin:mison-booking"]').click()
      await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
      await internalTab("预约设置").click()
      await open()
      assert.equal(await deviceName(1).inputValue(), "平板")
      assert.equal(await deviceName(2).inputValue(), "妈妈的手机")
      assert.equal(await key(1).inputValue(), "fixture_key-002")
      await deviceName(1).fill("我的 iPad")
      await deviceName(2).fill("   ")
      await invalid(deviceName(2))
      await deviceName(2).fill("客厅设备")
      await done()
      await editor.getByRole("button", { name: "保存设置", exact: true }).click()
      await page.getByText("设置已保存。", { exact: true }).waitFor()
      assert.equal(putCount(), before + 2)
      assert.deepEqual(fixture.config.notifications.barkKeys, [
        "fixture_key-002",
        "fixture_key-003",
      ])
      assert.deepEqual(fixture.config.notifications.barkKeyNames, ["我的 iPad", "客厅设备"])
      await open()
      assert.equal(await deviceName(2).inputValue(), "客厅设备")
      const fortyCharacters = "📱".repeat(40)
      await deviceName(1).fill(`  ${fortyCharacters}  `)
      await done()
      await open()
      assert.equal(await deviceName(1).inputValue(), fortyCharacters)
      await deviceName(1).fill(`${fortyCharacters}📱`)
      await invalid(deviceName(1))
      await drawer().getByText("设备名称最多40个字符。", { exact: true }).waitFor()
      assert.equal(await deviceName(1).getAttribute("aria-invalid"), "true")
      await button("取消").click()
      await drawer().waitFor({ state: "hidden" })
      assert.equal(putCount(), before + 2)
    },
  )

  await run(
    "off-state configuration allows empty scenes; enabling requests missing setup",
    async () => {
      await load({ empty: true })
      const before = putCount()
      await open()
      await key(1).fill("fixture_key-001")
      await deviceName(1).fill("手机")
      await button("添加设备").click()
      await frames()
      assert.equal(await button("保存").isDisabled(), true)
      await button("移除 Bark Key 2").click()
      await scene().click()
      await done()
      assert.equal(await toggle().isChecked(), false)
      await editor.getByText("未选择通知场景 · 1 个 Key", { exact: true }).waitFor()
      await toggle().click()
      await drawer().waitFor()
      assert.equal(await key(1).inputValue(), "fixture_key-001")
      await invalid(scene())
      await scene().click()
      await done()
      assert.equal(await toggle().isChecked(), true)
      assert.equal(putCount(), before)
    },
  )

  await run("key length boundaries and excess restored rows retain validation limits", async () => {
    await load({ empty: true })
    const before = putCount()
    await toggle().click()
    await drawer().waitFor()
    for (const value of ["a".repeat(7), "a".repeat(129), "密钥不是有效Key"]) {
      await key(1).fill(value)
      await invalid(key(1))
    }
    await button("移除 Bark Key 1").click()
    assert.equal(await key(1).count(), 0)
    assert.equal(await button("保存").isDisabled(), true)
    await button("取消").click()
    await drawer().waitFor({ state: "hidden" })
    const keys = Array.from({ length: 11 }, (_, i) => `fixture_key-${i}`)
    await load({ empty: true, notifications: { ...notifications, barkKeys: keys, barkKeyNames: keys.map((_, i) => `设备 ${i + 1}`) } })
    await open()
    await invalid(key(11))
    await button("移除 Bark Key 11").click()
    await done()
    await editor.getByText("约课成功 · 10 个 Key", { exact: true }).waitFor()
    assert.equal(putCount(), before)
  })

  await run("navigation discards drawer changes while preserving the page draft", async () => {
    await load({ empty: true, notifications })
    await notice(18)
    const before = putCount()
    for (const target of ["internal", "plugin", "host"]) {
      await open()
      await key(1).fill("unsaved_key-999")
      // Simulate host-driven navigation while the modal correctly blocks background input.
      if (target === "internal") {
        await auto
          .getByRole("tab", { name: "运行看板", exact: true, includeHidden: true })
          .evaluate((el) =>
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
          )
        await drawer().waitFor({ state: "hidden" })
        await internalTab("预约设置").click()
      } else if (target === "plugin") {
        await page
          .getByRole("tab", { name: "教师与约课", exact: true, includeHidden: true })
          .evaluate((el) =>
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
          )
        await drawer().waitFor({ state: "hidden" })
        await tabs.getByRole("tab", { name: "自动约课", exact: true }).click()
      } else {
        await page.locator('[data-view="calendar"]').evaluate((el) => el.click())
        await drawer().waitFor({ state: "hidden" })
        await page.locator('[data-view="plugin:mison-booking"]').click()
      }
      await open()
      assert.equal(await key(1).inputValue(), notifications.barkKeys[0])
      await button("取消").click()
      await drawer().waitFor({ state: "hidden" })
      assert.equal(
        await editor
          .getByRole("slider", { name: "最少提前预约", exact: true })
          .getAttribute("aria-valuenow"),
        "18",
      )
    }
    assert.equal(putCount(), before)
  })

  await run(
    "four responsive widths keep peer cards aligned and drawer actions visible",
    async () => {
      const keys = [
        "a".repeat(8),
        "z".repeat(128),
        ...Array.from({ length: 8 }, (_, i) => `fixture_key-${i}`),
      ]
      await load({ settings: true, notifications: { ...notifications, barkKeys: keys, barkKeyNames: keys.map((_, i) => `设备 ${i + 1}`) } })
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 1034, height: 889 },
        { width: 820, height: 1180 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport)
        await configure().scrollIntoViewIfNeeded()
        await editor.locator(".mison-auto-settings-scroll").evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        await frames()
        await noOverflow()
        const layout = await editor.evaluate((el) => {
          const rect = (s) => {
            const { x, y, width, height, right, bottom } = el
              .querySelector(s)
              .getBoundingClientRect()
            return { x, y, width, height, right, bottom }
          }
          return {
            dates: rect(".mison-auto-dates-card"),
            weekly: rect(".mison-auto-weekly-card"),
            rhythm: rect(".mison-auto-rhythm-card"),
            rules: rect(".mison-auto-rules-card"),
            notifications: rect(".mison-auto-notifications-card"),
            footer: rect(".mison-auto-settings-footer"),
          }
        })
        if (viewport.width >= 820) {
          assert.ok(Math.abs(layout.rhythm.width - layout.rules.width) < 2)
          assert.ok(Math.abs(layout.rhythm.y - layout.rules.y) < 2)
          assert.ok(Math.abs(layout.dates.width - layout.weekly.width) < 2)
          assert.ok(Math.abs(layout.dates.height - layout.weekly.height) < 2)
          assert.ok(Math.abs(layout.dates.x - layout.rhythm.x) < 2)
          assert.ok(Math.abs(layout.dates.width - layout.rhythm.width) < 2)
          assert.ok(Math.abs(layout.weekly.x - layout.rules.x) < 2)
          assert.ok(Math.abs(layout.rules.x - layout.rhythm.right - 16) < 2)
          assert.ok(Math.abs(layout.notifications.width - layout.rhythm.width) < 2)
          assert.ok(Math.abs(layout.notifications.x - layout.rhythm.x) < 2)
        } else {
          assert.ok(Math.abs(layout.rules.y - layout.rhythm.bottom - 16) < 2)
          assert.ok(Math.abs(layout.rules.width - layout.rhythm.width) < 2)
        }
        assert.ok(Math.abs(layout.notifications.y - layout.rules.bottom - 16) < 2)
        assert.ok(layout.notifications.bottom <= layout.footer.y + 1)
        const switches = await editor
          .locator('.mison-auto-execution-groups [data-slot="switch"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const track = node.getBoundingClientRect()
              const thumb = node.querySelector('[data-slot="switch-thumb"]').getBoundingClientRect()
              return {
                width: track.width,
                contained: thumb.left >= track.left - 1 && thumb.right <= track.right + 1,
              }
            }),
          )
        assert.ok(
          switches.every((control) => control.width >= 28 && control.contained),
          "switch tracks keep their shared dimensions",
        )
        const configRect = await configure().boundingBox()
        const switchRect = await toggle().boundingBox()
        assert.equal(await configure().getAttribute("data-variant"), "link")
        assert.ok(configRect.x + configRect.width <= switchRect.x)
        assert.ok(Math.abs(configRect.y + configRect.height / 2 - switchRect.y - switchRect.height / 2) < 2)
        await screenshot(`auto-settings-groups-${viewport.width}`)
        if (viewport.width === 1440) {
          await editor.locator(".mison-auto-settings-scroll").evaluate((el) => {
            const top = el.querySelector(".mison-auto-dates-card").getBoundingClientRect().top
            el.scrollTop += top - el.getBoundingClientRect().top
          })
          await screenshot("auto-settings-columns-aligned")
        }
        if (viewport.width === 390) {
          await editor.locator(".mison-auto-settings-scroll").evaluate((el) => { el.scrollTop = 0 })
          const teacherRects = await editor.locator(".mison-auto-teachers-card .mison-auto-priorities > li").evaluateAll((nodes) => nodes.map((el) => ({ width: el.getBoundingClientRect().width, container: el.parentElement.getBoundingClientRect().width })))
          assert.ok(teacherRects.every((r) => r.width < r.container - 8))
          await screenshot("auto-settings-compact-mobile")
          const settings = editor.getByRole("button", { name: "周三设置时段", exact: true })
          await settings.click()
          const mobilePicker = editor.getByRole("group", { name: "周三时段设置", exact: true })
          await mobilePicker.getByRole("button", { name: "10:00", exact: true }).click()
          await noOverflow()
          await mobilePicker.getByRole("button", { name: "取消", exact: true }).click()
        }
        await open()
        assert.equal(await button("添加设备").isDisabled(), true)
        const geometry = await drawer().evaluate((el) => {
          const rect = (node) => {
            const { x, y, width, right, bottom } = node.getBoundingClientRect()
            return { x, y, width, right, bottom }
          }
          const scroller = el.querySelector(".mison-overlay-scroll")
          return {
            panel: rect(el),
            header: rect(el.querySelector(".mison-overlay-header")),
            footer: rect(el.querySelector(".mison-overlay-footer")),
            overflow: el.scrollWidth > el.clientWidth + 1,
            scrolling: scroller.scrollHeight > scroller.clientHeight,
          }
        })
        assert.ok(
          Math.abs(geometry.panel.width - (viewport.width < 600 ? viewport.width : 440)) < 2,
        )
        assert.equal(geometry.overflow, false)
        assert.ok(geometry.header.y >= 0 && geometry.footer.bottom <= viewport.height)
        if (viewport.height <= 889) assert.equal(geometry.scrolling, true)
        await key(10).scrollIntoViewIfNeeded()
        assert.equal(await button("保存").isVisible(), true)
        await noOverflow()
        await screenshot(`auto-settings-drawer-${viewport.width}`)
        await button("取消").click()
        await drawer().waitFor({ state: "hidden" })
      }
    },
  )

  await run(
    "read-only members see counts and scenes without key fields or edit actions",
    async () => {
      await load({ empty: true, member: true, notifications })
      assert.equal(await toggle().isDisabled(), true)
      assert.equal(await editor.getByRole("button", { name: /设置时段/ }).count(), 0)
      for (const name of ["最少提前预约", "每天最多预约", "检查开始", "检查结束"]) {
        const slider = editor.getByRole("slider", { name, exact: true })
        assert.equal(await slider.getAttribute("aria-disabled"), "true")
        assert.notEqual(await slider.getAttribute("tabindex"), "0")
      }
      assert.equal(await editor.getByRole("button", { name: "保存设置", exact: true }).count(), 0)
      await editor.getByText("约课成功 · 2 个 Key", { exact: true }).waitFor()
      await editor.getByRole("button", { name: "查看 Bark App", exact: true }).click()
      await drawer().waitFor()
      await drawer().getByText("已配置 2 个 Bark Key", { exact: true }).waitFor()
      assert.equal(await scene().isChecked(), true)
      assert.equal(await scene().isDisabled(), true)
      assert.equal(await drawer().locator('input:not([type="checkbox"])').count(), 0)
      assert.equal(
        await drawer()
          .getByRole("button", { name: /添加|移除|显示|隐藏|保存/ })
          .count(),
        0,
      )
      const markup = (await drawer().innerHTML()) + (await editor.innerHTML())
      for (const secret of notifications.barkKeys) assert.equal(markup.includes(secret), false)
      for (const name of notifications.barkKeyNames) assert.equal(markup.includes(name), false)
      await screenshot("auto-settings-readonly")
      await button("关闭").click()
      await drawer().waitFor({ state: "hidden" })
    },
  )
}

if (require.main === module) {
  process.env.AUTO_BOOKING_ACCEPTANCE = "1"
  process.env.PLUGIN_DEV_ACCEPTANCE ??= "1"
  process.env.BARK_NOTIFICATIONS_ACCEPTANCE = "1"
  require("./mison_frontend_acceptance.cjs")
}
