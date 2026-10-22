/* Emulate software-keyboard visualViewport changes without resizing the layout
   viewport. All sessions/data come from the isolated browser regression. */
const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseTaskKeyboard({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("iPad keyboard: whole task dialog scroll, field visibility and layout restoration")
  const storageState = await dad.context().storageState()
  const results = []
  for (const [width, height, visibleHeight] of [
    [820, 1180, 660],
    [1180, 820, 380],
    [1366, 1024, 520],
  ]) {
    const context = await browser.newContext({
      storageState,
      viewport: { width, height },
      hasTouch: true,
      isMobile: true,
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const viewport = new EventTarget()
      Object.assign(viewport, {
        height: innerHeight,
        width: innerWidth,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      })
      Object.defineProperty(window, "visualViewport", { value: viewport })
      window.setTestViewport = (values, event = "resize") => {
        Object.assign(viewport, values)
        viewport.dispatchEvent(new Event(event))
      }
    })
    await context.route("**/api/**", (route) =>
      route.request().method() === "GET"
        ? route.continue()
        : route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "隔离验收：保留表单输入。" }),
          }),
    )
    const dialog = page.locator("#taskDialog")
    const body = dialog.locator(".ui-modal-body")
    const footer = dialog.locator(".ui-modal-footer")
    const setViewport = (values, event) =>
      page.evaluate(({ values, event }) => window.setTestViewport(values, event), { values, event })
    const insideVisibleArea = async (locator) => {
      const bounds = await locator.boundingBox()
      const top = await page.evaluate(() => visualViewport.offsetTop)
      assert.ok(
        bounds.y >= top && bounds.y + bounds.height <= top + visibleHeight + 1,
        JSON.stringify({ bounds, top, visibleHeight }),
      )
    }
    try {
      await page.goto(`${origin}/children/${firstId}`)
      assert.equal(await page.title(), "成长计划")
      await page.locator("#newTaskBtn").click()
      await page.locator("#taskTitle").fill("键盘弹出时保留完整表单")
      await page.locator('[aria-controls="taskNotePanel"]').click()
      await page.locator("#taskNote").fill("滚动后仍保留备注。".repeat(12))
      await page.locator("#taskRepeat").click()
      await page.locator("#taskTitle").focus()
      const background = await page.locator("#monthCalendar").evaluate((el) => el.scrollTop)
      await setViewport({ height: visibleHeight, offsetTop: 18 })
      await page.waitForFunction(() =>
        document.documentElement.hasAttribute("data-app-keyboard-open"),
      )
      await page.waitForFunction(() => {
        const el = document.querySelector("#taskTitle").getBoundingClientRect()
        return (
          el.top >= visualViewport.offsetTop &&
          el.bottom <= visualViewport.offsetTop + visualViewport.height
        )
      })
      const geometry = await dialog.evaluate((el) => {
        const body = el.querySelector(".ui-modal-body")
        return {
          height: el.clientHeight,
          total: el.scrollHeight,
          body: body.clientHeight,
          bodyTotal: body.scrollHeight,
          overflow: getComputedStyle(body).overflowY,
        }
      })
      assert.ok(geometry.total >= geometry.height, "Complete dialog keeps its natural height")
      assert.ok(Math.abs(geometry.bodyTotal - geometry.body) <= 1, "No nested scroll area")
      assert.equal(geometry.overflow, "visible")
      if (visibleHeight < 600) assert.ok(geometry.total > geometry.height, JSON.stringify(geometry))
      await page.locator("#taskNote").focus()
      await page.waitForFunction(() => {
        const el = document.querySelector("#taskNote").getBoundingClientRect()
        return (
          el.top >= visualViewport.offsetTop &&
          el.bottom <= visualViewport.offsetTop + visualViewport.height
        )
      })
      await insideVisibleArea(page.locator("#taskNote"))
      // Native focus can reveal the textarea before the app's scheduled focus
      // adjustment runs. Start manual-scroll assertions after that frame settles.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await dialog.evaluate((el) => {
        el.scrollTop = 0
      })
      await setViewport({ offsetTop: 18 }, "scroll")
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(
        await dialog.evaluate((el) => el.scrollTop),
        0,
        "Manual scrolling does not snap back to focused input",
      )
      await insideVisibleArea(dialog.locator(".ui-modal-header"))
      await dialog.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await insideVisibleArea(footer)
      assert.equal(await page.locator("#monthCalendar").evaluate((el) => el.scrollTop), background)
      assert.equal(await page.evaluate(() => scrollY), 0, "Background document stays locked")
      await page.locator("#taskTitle").focus()
      await page.waitForFunction(() => document.querySelector("#taskDialog").scrollTop < 100)
      if (width === 1180) await axe(page, "task-keyboard-landscape")
      // Clearly mark the emulated keyboard space in screenshot evidence.
      await page.evaluate(
        ({ top }) => {
          const marker = document.createElement("div")
          marker.id = "keyboard-evidence"
          marker.setAttribute("aria-hidden", "true")
          Object.assign(marker.style, {
            position: "fixed",
            top: `${top}px`,
            bottom: "0",
            left: "0",
            right: "0",
            zIndex: "999",
            background: "#d1d5db",
            display: "grid",
            placeItems: "center",
            color: "#374151",
            pointerEvents: "none",
          })
          marker.textContent = "模拟屏幕键盘占用区域"
          document.body.append(marker)
        },
        { top: visibleHeight + 18 },
      )
      await page.screenshot({ path: path.join(out, `task-keyboard-${width}.png`) })
      await page.locator("#keyboard-evidence").evaluate((el) => el.remove())

      await setViewport({ height, offsetTop: 0 })
      await page.waitForFunction(
        () => !document.documentElement.hasAttribute("data-app-keyboard-open"),
      )
      assert.equal(await dialog.evaluate((el) => el.scrollTop), 0)
      assert.equal(await body.evaluate((el) => getComputedStyle(el).overflowY), "auto")
      assert.equal(await page.locator("#taskTitle").inputValue(), "键盘弹出时保留完整表单")
      assert.equal(await page.locator("#taskNote").inputValue(), "滚动后仍保留备注。".repeat(12))
      const before = await footer.boundingBox()
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      assert.ok(
        Math.abs((await footer.boundingBox()).y - before.y) < 1,
        "After keyboard hides, ordinary fixed actions are restored",
      )

      // Zoom alone must not trigger the keyboard layout.
      await setViewport({ height: height / 2, scale: 2 })
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await page.locator("html[data-app-keyboard-open]").count(), 0)
      await setViewport({ height, scale: 1 })
      await page.keyboard.press("Escape")
      await dialog.waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.id === "newTaskBtn")
      assert.deepEqual(errors, [])
      results.push({ width, height, visibleHeight, passed: true })
    } finally {
      await context.close()
    }
  }
  require("node:fs").writeFileSync(
    path.join(out, "task-keyboard.json"),
    JSON.stringify(
      { results, physicalIPad: "Not tested; visualViewport geometry is simulated." },
      null,
      2,
    ),
  )
}
module.exports = { exerciseTaskKeyboard }
