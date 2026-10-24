/* Real wheel interactions, using only isolated test accounts and rejected writes. */
const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseTimePicker({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("cyclic time wheels: fixed center, native scroll, touch, keyboard and exact minutes")
  const state = await dad.context().storageState()
  for (const [width, height, touch] of [
    [1305, 954, false],
    [820, 1180, true],
    [1180, 820, true],
    [390, 844, true],
    [509, 954, true],
  ]) {
    const context = await browser.newContext({
      storageState: state,
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    const page = await context.newPage()
    const errors = []
    let writes = 0
    page.on("pageerror", (error) => errors.push(error.message))
    page.setDefaultTimeout(15000)
    await context.route("**/api/**", (route) => {
      if (route.request().method() === "GET") return route.continue()
      writes++
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "时间组件验收禁止写入。" }),
      })
    })
    const panel = page.getByRole("dialog", { name: "选择时间", exact: true })
    const hours = panel.getByRole("spinbutton", { name: "小时", exact: true })
    const minutes = panel.getByRole("spinbutton", { name: "分钟", exact: true })
    const number = async (wheel) => Number(await wheel.getAttribute("aria-valuenow"))
    async function keyboardValue(wheel, next) {
      await wheel.press("Home")
      for (let index = 0; index < Math.floor(next / 5); index++) await wheel.press("PageDown")
      for (let index = 0; index < next % 5; index++) await wheel.press("ArrowDown")
      assert.equal(await number(wheel), next)
    }
    async function centered(wheel) {
      await page.waitForFunction(
        (label) => {
          const el = Array.from(document.querySelectorAll('[role="spinbutton"]')).find(
            (node) => node.getAttribute("aria-label") === label,
          )
          if (!el) return false
          const rect = el.getBoundingClientRect()
          const row = document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest("[data-wheel-index]")
          if (!row) return false
          const bounds = row.getBoundingClientRect()
          return (
            Number(row.textContent) === Number(el.getAttribute("aria-valuenow")) &&
            Math.abs(bounds.y + bounds.height / 2 - rect.y - rect.height / 2) < 1
          )
        },
        await wheel.getAttribute("aria-label"),
      )
    }
    async function close() {
      await panel.getByRole("button", { name: "完成", exact: true }).click()
      await panel.waitFor({ state: "hidden" })
    }
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#newTaskBtn").click()
      const start = page.locator("#taskStart"),
        end = page.locator("#taskDuration")
      assert.equal(await start.getAttribute("readonly"), "")
      assert.equal(await end.getAttribute("readonly"), "")
      assert.equal(await start.getAttribute("inputmode"), "none")
      const initial = await start.inputValue()
      await start.pressSequentially("11:59")
      await start.press("Backspace")
      assert.equal(await start.inputValue(), initial)
      await start.click()
      await panel.waitFor()
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        )
      })
      assert.equal(await hours.getAttribute("aria-valuemax"), "23")
      assert.equal(await minutes.getAttribute("aria-valuemax"), "59")
      assert.doesNotMatch(await panel.innerText(), /24小时|每5分钟|可直接输入|方向键/)
      await centered(hours)
      await centered(minutes)
      const fixedFrame = await hours.locator("..").locator(".time-wheel-selection").boundingBox()
      assert.equal(
        await hours
          .locator("..")
          .locator(".time-wheel-selection")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(255, 240, 179)",
      )

      // A visible neighboring number is selectable by click, and does not close the panel.
      const beforeClick = await number(hours)
      const hourBox = await hours.boundingBox()
      await hours.click({ position: { x: hourBox.width / 2, y: hourBox.height / 2 + 44 } })
      await page.waitForFunction(
        ({ before }) =>
          Number(
            document
              .querySelector('[role="spinbutton"][aria-label="小时"]')
              ?.getAttribute("aria-valuenow"),
          ) ===
          (before + 1) % 24,
        { before: beforeClick },
      )
      await centered(hours)
      assert.equal(await panel.isVisible(), true)
      const frameAfter = await hours.locator("..").locator(".time-wheel-selection").boundingBox()
      assert.ok(Math.abs(frameAfter.y - fixedFrame.y) < 1, "Yellow selection frame stays fixed")

      // Both boundaries wrap in both directions, without carrying into the other wheel.
      for (const [wheel, max] of [
        [hours, 23],
        [minutes, 59],
      ]) {
        await wheel.press("End")
        assert.equal(await number(wheel), max)
        await wheel.press("ArrowDown")
        assert.equal(await number(wheel), 0)
        await wheel.press("ArrowUp")
        assert.equal(await number(wheel), max)
        await wheel.press("Home")
        await centered(wheel)
      }
      // Real mouse-wheel events cross 59 -> 00 and retain the containing task form.
      await minutes.press("End")
      await centered(minutes)
      await minutes.hover()
      await page.mouse.wheel(0, 88)
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector('[role="spinbutton"][aria-label="分钟"]')
              ?.getAttribute("aria-valuenow"),
          ) < 5,
      )
      await centered(minutes)
      assert.equal(await panel.isVisible(), true)
      assert.equal(await page.locator("#taskDialog").isVisible(), true)

      // Large and repeated scrolls must never expose a finite list end.
      for (let index = 0; index < 4; index++) {
        await minutes.evaluate((el) => {
          el.scrollTop += 5280
        })
        await centered(minutes)
        await page.waitForFunction(() => {
          const el = document.querySelector('[role="spinbutton"][aria-label="分钟"]')
          return el.scrollTop > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight
        })
      }
      assert.ok(
        await minutes.evaluate(
          (el) =>
            el.scrollTop > el.clientHeight && el.scrollTop + el.clientHeight < el.scrollHeight,
        ),
        "Loop rebases away from either end",
      )

      if (touch) {
        const cdp = await context.newCDPSession(page)
        const box = await hours.boundingBox(),
          before = await number(hours)
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2 + 60
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
        for (let step = 1; step <= 8; step++) {
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
                .querySelector('[role="spinbutton"][aria-label="小时"]')
                ?.getAttribute("aria-valuenow"),
            ) !== before,
          before,
        )
        // Let the native touch fling and its snap finish before beginning a
        // separate keyboard interaction (a transient exact row is not idle).
        await hours.evaluate(
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
        await centered(hours)
        await cdp.detach()
      }
      await keyboardValue(hours, 8)
      await keyboardValue(minutes, 17)
      await centered(hours)
      await centered(minutes)
      assert.equal(await start.inputValue(), "08:17", "Arbitrary minute precision is preserved")
      await close()
      await page.waitForFunction(() => document.activeElement?.id === "taskStart")
      await start.press("Enter")
      assert.equal(await number(hours), 8)
      assert.equal(await number(minutes), 17)
      await centered(hours)
      await centered(minutes)
      const box = await panel.boundingBox()
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= height + 1,
        "Wheel panel stays inside the viewport",
      )
      if (width === 1305 || width === 820) await axe(page, `time-wheel-${width}`)
      await page.screenshot({ path: path.join(out, `time-wheel-${width}.png`) })
      await minutes.press("ArrowDown")
      await minutes.press("Enter")
      await panel.waitFor({ state: "hidden" })
      assert.equal(await start.inputValue(), "08:18")
      await page.waitForFunction(() => document.activeElement?.id === "taskStart")
      await start.press("Tab")
      await page.waitForFunction(() => document.activeElement?.id === "taskDuration")
      await end.click()
      const durationPanel = page.getByRole("dialog", { name: "选择持续时长", exact: true })
      await keyboardValue(durationPanel.getByRole("spinbutton", { name: "小时", exact: true }), 9)
      await keyboardValue(durationPanel.getByRole("spinbutton", { name: "分钟", exact: true }), 3)
      await page.keyboard.press("Escape")
      await durationPanel.waitFor({ state: "hidden" })
      assert.equal(await end.inputValue(), "9小时3分钟")
      assert.equal(await page.locator("#taskDuration-help").count(), 0)
      assert.equal(await start.inputValue(), "08:18")
      assert.equal(await page.locator("#taskDialog").isVisible(), true)
      await page.waitForFunction(() => document.activeElement?.id === "taskDuration")
      await page.keyboard.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })

      if (width === 1305) {
        await page.locator('[data-view="settings"]').click()
        await page.locator("#openTaskPresetsSettings").click()
        await page.locator("#settingsAddPreset").click()
        const preset = page.locator("#presetStart")
        assert.equal(await preset.getAttribute("readonly"), "")
        await preset.click()
        await minutes.press("End")
        await close()
        assert.match(await preset.inputValue(), /:59$/)
        await page.keyboard.press("Escape")
      }
      assert.equal(writes, 0, "Wheel interactions never submit the form")
      assert.deepEqual(errors, [])
    } catch (error) {
      await page.screenshot({ path: path.join(out, `time-wheel-failure-${width}.png`) })
      throw error
    } finally {
      await context.close()
    }
  }
}
module.exports = { exerciseTimePicker }
