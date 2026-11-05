const assert = require("node:assert/strict")
const path = require("node:path")

module.exports = async function exerciseAvailability({ page, out, engine, setMode }) {
  const stage = page.getByRole("region", { name: "约课区" })
  const available = stage.getByRole("switch", { name: "只看可约日期/时段", exact: true })
  const settled = () =>
    page.waitForFunction(
      () => document.querySelector(".mison-stage")?.getAttribute("aria-busy") === "false",
    )
  const choose = async (id) => {
    await page.locator(`[data-book-teacher="demo-${id}"]`).tap()
    await stage.locator("h2").waitFor()
    await settled()
  }
  await choose(0)
  assert.equal(await available.isChecked(), true, "Availability filter starts enabled")
  assert.equal(await stage.locator('.mison-date-option[data-unavailable="true"]').count(), 0)
  assert.equal(await stage.locator('.mison-slots [data-unavailable="true"]').count(), 0)
  assert.ok((await stage.locator('.mison-slots [data-slot="toggle-group-item"]').count()) > 0)
  for (const time of ["09:00", "18:00 本人已约", "19:30"])
    assert.equal(await stage.getByRole("button", { name: time, exact: true }).count(), 0)
  await available.tap()
  assert.ok((await stage.locator('.mison-date-option[data-unavailable="true"]').count()) > 0)
  for (const time of ["09:00", "18:00 本人已约", "19:30"])
    assert.equal(await stage.getByRole("button", { name: time, exact: true }).isDisabled(), true)
  await available.focus()
  await page.keyboard.press("Space")
  assert.equal(await available.isChecked(), true)
  await stage.getByRole("button", { name: "10:00", exact: true }).tap()
  await available.tap()
  await available.tap()
  assert.equal(
    await stage.getByRole("button", { name: "10:00", exact: true }).getAttribute("aria-pressed"),
    "true",
  )
  await stage.getByRole("button", { name: "清空", exact: true }).tap()

  for (const [width, height] of [
    [1305, 984],
    [1180, 820],
    [820, 1180],
    [700, 1000],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const widths = await page
      .locator(".mison-search, .mison-date-picker, .mison-time-trigger")
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
    assert.equal(widths.length, 3)
    assert.ok(
      Math.max(...widths) - Math.min(...widths) <= 1,
      `${width}: equal filter widths ${widths}`,
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    if (width >= 768) {
      const geometry = await page.locator(".mison-teachers.is-sidebar").evaluate((element) => ({
        right: element.getBoundingClientRect().right,
        scrollRight: element.querySelector(".mison-teacher-scroll").getBoundingClientRect().right,
        scrollable:
          element.querySelector(".mison-teacher-scroll").scrollHeight >
          element.querySelector(".mison-teacher-scroll").clientHeight,
      }))
      assert.ok(Math.abs(geometry.right - geometry.scrollRight) <= 1, JSON.stringify(geometry))
      assert.equal(geometry.scrollable, true)
    }
    await page.screenshot({ path: path.join(out, `${engine}-availability-${width}.png`) })
  }

  await page.setViewportSize({ width: 1305, height: 984 })
  setMode("no-availability")
  await choose(1)
  await stage.getByText("暂无可约日期", { exact: true }).waitFor()
  await stage.getByText("当天暂无可约时段", { exact: true }).waitFor()
  assert.equal(await stage.getByRole("radio").count(), 0)
  assert.equal(await stage.locator('.mison-slots [data-slot="toggle-group-item"]').count(), 0)
  assert.equal(await stage.getByRole("button", { name: "下一步：确认课件" }).isDisabled(), true)
  await available.tap()
  assert.ok((await stage.getByRole("radio").count()) > 0)
  assert.ok((await stage.locator('.mison-slots [data-slot="toggle-group-item"]').count()) > 0)
  await available.tap()

  setMode("unavailable-first-date")
  const automaticDate = page.waitForRequest((request) =>
    /teachers\/demo-2\/schedule\?date=2026-11-02$/.test(request.url()),
  )
  await choose(2)
  await automaticDate
  await settled()
  assert.equal(
    await stage
      .getByRole("radio", { name: "11月2日 周一", exact: true })
      .getAttribute("aria-checked"),
    "true",
  )
  assert.equal(await stage.locator('.mison-slots [data-unavailable="true"]').count(), 0)
  assert.ok((await stage.locator('.mison-slots [data-slot="toggle-group-item"]').count()) > 0)
  setMode("normal")
}
