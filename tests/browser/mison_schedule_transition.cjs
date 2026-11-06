const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

module.exports = async function exerciseScheduleTransition({ page, stage, out, setMode }) {
  const evidence = []
  const loading = stage.getByText("正在加载时段…", { exact: true })
  const skeleton = stage.locator("[data-schedule-loading]")
  const choose = (id) => page.locator(`[data-book-teacher="demo-${id}"]`).click()
  const settled = async () => {
    await loading.waitFor({ state: "hidden" })
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  }
  const startProbe = () =>
    page.evaluate(() => {
      const selectors = [".mison-stage-body", ".mison-dates", ".mison-slots", ".mison-stage-footer"]
      const nodes = selectors.map((selector) => document.querySelector(selector))
      const scrollport = document.querySelector(".mison-stage-scroll")
      scrollport.scrollTop = Math.min(48, scrollport.scrollHeight - scrollport.clientHeight)
      const measure = () => ({
        rects: nodes.map((node) => {
          const { x, y, width, height } = node.getBoundingClientRect()
          return [x, y, width, height]
        }),
        scroll: scrollport.scrollTop,
        documentScroll: scrollY,
        sameNodes: selectors.every(
          (selector, index) => document.querySelector(selector) === nodes[index],
        ),
      })
      const probe = { running: true, before: measure(), frames: [] }
      window.__scheduleTransition = probe
      const sample = () => {
        if (!probe.running) return
        probe.frames.push(measure())
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
  const finishProbe = async (name) => {
    const result = await page.evaluate(() => {
      window.__scheduleTransition.running = false
      return window.__scheduleTransition
    })
    assert.ok(result.frames.length >= 3, `${name}: sampled the transition`)
    for (const frame of result.frames) {
      assert.equal(frame.sameNodes, true, `${name}: schedule nodes stay mounted`)
      assert.equal(frame.scroll, result.before.scroll, `${name}: content scroll stays stable`)
      assert.equal(frame.documentScroll, result.before.documentScroll)
      frame.rects.forEach((rect, index) =>
        rect.forEach((value, dimension) =>
          assert.ok(
            Math.abs(value - result.before.rects[index][dimension]) <= 1,
            `${name}: region ${index}, dimension ${dimension}: ${value} vs ${result.before.rects[index][dimension]}`,
          ),
        ),
      )
    }
    evidence.push({ name, ...result })
  }

  for (const [width, height] of [
    [1440, 1000],
    [1180, 820],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height })
    await settled()
    await startProbe()
    setMode("slow")
    await choose(1)
    await skeleton.waitFor()
    assert.ok((await skeleton.locator('[data-slot="skeleton"]').count()) > 20)
    assert.equal(
      await skeleton
        .locator('[data-slot="toggle-group-item"]')
        .evaluateAll((items) => items.every((item) => getComputedStyle(item).opacity === "1")),
      true,
      "Skeletons do not expose the previous teacher's availability through opacity",
    )
    assert.equal(await stage.getByRole("switch", { name: "只看可约日期/时段" }).isDisabled(), true)
    assert.equal(await stage.getByRole("button", { name: "下一组日期" }).isDisabled(), true)
    assert.equal(await stage.getByRole("button", { name: "10:00", exact: true }).isDisabled(), true)
    await page.screenshot({ path: path.join(out, `schedule-loading-${width}.png`) })
    await settled()
    await finishProbe(`teacher switch ${width}x${height}`)
    await skeleton.waitFor({ state: "hidden" })
    setMode("normal")
    await choose(0)
    await settled()
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  await settled()
  await startProbe()
  setMode("race")
  await choose(1)
  await skeleton.waitFor()
  await choose(2)
  await settled()
  // The older teacher's slow response must not replace the newest selection.
  await page.waitForTimeout(850)
  assert.match(await stage.locator("h2").innerText(), /Rina/)
  assert.equal(await stage.getByRole("button", { name: "10:00", exact: true }).isEnabled(), true)
  await finishProbe("rapid teacher switching with out-of-order responses")

  await startProbe()
  setMode("failure")
  await choose(1)
  await stage.getByText("模拟时段查询失败", { exact: true }).waitFor()
  assert.equal(await skeleton.count(), 1, "Failed new teacher never exposes the old schedule")
  assert.equal(await stage.getByRole("button", { name: "下一步：确认课件" }).isDisabled(), true)
  setMode("normal")
  await stage.getByRole("button", { name: "重试", exact: true }).click()
  await settled()
  await skeleton.waitFor({ state: "hidden" })
  await finishProbe("teacher switch failure and retry")
  await page.screenshot({ path: path.join(out, "schedule-ready.png") })
  await choose(0)
  await settled()
  await stage.locator(".mison-stage-scroll").evaluate((element) => {
    element.scrollTop = 0
  })
  fs.writeFileSync(path.join(out, "schedule-transition.json"), JSON.stringify(evidence, null, 2))
}
