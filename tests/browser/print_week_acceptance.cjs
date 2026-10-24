const assert = require("node:assert/strict")
const path = require("node:path")

async function exercisePrintWeek({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("single-week printing: one click, full-week highlight, month/year boundaries and shortcuts")
  for (const [width, height, touch] of [
    [1135, 789, false],
    [820, 1180, true],
    [1180, 820, true],
    [390, 844, true],
  ]) {
    const context = await browser.newContext({
      storageState: await dad.context().storageState(),
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await context.route("**/api/**", (route) => {
      assert.equal(route.request().method(), "GET", "Printing never writes business data")
      return route.continue()
    })
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#printBtn").click()
      await page.locator("#printDialog").waitFor()
      const trigger = page.locator("#printRange")
      const calendar = page.locator(".shared-calendar")
      for (const [day, expected, keyboard] of [
        ["2026-10-01", "2026-09-28 — 2026-10-04", false],
        ["2026-10-25", "2026-10-19 — 2026-10-25", true],
        ["2026-12-31", "2026-12-28 — 2027-01-03", false],
        ["2027-01-03", "2026-12-28 — 2027-01-03", true],
      ]) {
        await trigger.click()
        for (let tries = 0; tries < 24; tries++) {
          const shown = (
            await calendar
              .locator("[data-day]:not([data-outside])")
              .first()
              .getAttribute("data-day")
          ).slice(0, 7)
          if (shown === day.slice(0, 7)) break
          await calendar
            .locator("nav button")
            .nth(shown < day.slice(0, 7) ? 1 : 0)
            .click()
        }
        const button = calendar.locator(`[data-day="${day}"] button`)
        if (keyboard) {
          await button.focus()
          await button.press("Enter")
        } else await button.click()
        await calendar.waitFor({ state: "hidden" })
        assert.equal(await trigger.innerText(), expected)
        await page.waitForFunction(() => document.activeElement?.id === "printRange")
        assert.match(await page.locator("#printPreview").innerText(), /将打印 1 页自然周计划/)
        await trigger.click()
        // A boundary week may straddle the visible month's outer days.
        assert.equal(await calendar.locator('[data-selected="true"]').count(), 7)
        if (day === "2026-10-25") {
          await page.evaluate(async () => {
            await document.fonts.ready
            await Promise.all(
              document
                .getAnimations()
                .filter(
                  (animation) => animation.effect?.getComputedTiming().iterations !== Infinity,
                )
                .map((animation) => animation.finished.catch(() => {})),
            )
          })
          await page.screenshot({ path: path.join(out, `print-week-${width}.png`) })
          if (width === 1135 || width === 820) await axe(page, `print-week-${width}`)
          const box = await calendar.boundingBox()
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1)
        }
        await page.keyboard.press("Escape")
        await calendar.waitFor({ state: "hidden" })
      }
      await page.getByRole("button", { name: "本周", exact: true }).click()
      const current = await trigger.innerText()
      await page.getByRole("button", { name: "下周", exact: true }).click()
      assert.notEqual(await trigger.innerText(), current)
      assert.match(await page.locator("#printPreview").innerText(), /将打印 1 页自然周计划/)
      await page.evaluate(() => {
        window.__printed = 0
        window.print = () => window.__printed++
      })
      await page.locator("#printConfirmBtn").click()
      await page.waitForFunction(() => window.__printed === 1)
      assert.equal(await page.locator(".print-page").count(), 1)
      assert.equal(await page.locator("#printPages .print-day").count(), 7)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
}
module.exports = { exercisePrintWeek }
