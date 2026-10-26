const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseChildSwitcher({ dad, firstId, out, api, axe, stage }) {
  stage("right child switcher: desktop, tablet, mobile, keyboard and focus return")
  const created = []
  for (const name of ["乐乐", "小雨", "安安", "朵朵", "小禾"]) {
    const r = await api(dad, "/api/children", "POST", { name })
    assert.equal(r.status, 200, JSON.stringify(r))
    created.push(r.child)
  }
  const open = async () => {
    await dad.locator("#openChildrenDialog").click()
    await dad.locator("#childrenDialog [data-child-card]").nth(5).waitFor()
    await dad.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      )
    })
  }
  for (const [width, height] of [
    [1273, 890],
    [820, 1180],
    [390, 844],
  ]) {
    await dad.setViewportSize({ width, height })
    await open()
    const sheet = dad.locator("#childrenDialog"),
      rows = sheet.locator("[data-child-card]")
    const bounds = await sheet.boundingBox()
    assert.ok(Math.abs(bounds.x + bounds.width - width) < 2, "Sheet touches right edge")
    assert.ok(bounds.width <= 400 && bounds.width <= width && Math.abs(bounds.height - height) < 2)
    assert.equal(await sheet.getByText("管理员", { exact: true }).count(), 0)
    assert.equal(await sheet.locator('[aria-current="true"]').count(), 1)
    assert.equal(await sheet.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
    await rows.first().focus()
    await dad.keyboard.press("ArrowDown")
    assert.equal(await rows.nth(1).evaluate((el) => el === document.activeElement), true)
    await dad.keyboard.press("End")
    assert.equal(await rows.last().evaluate((el) => el === document.activeElement), true)
    await dad.keyboard.press("Home")
    assert.equal(await rows.first().evaluate((el) => el === document.activeElement), true)
    await axe(dad, `child-sheet-${width}`)
    await dad.screenshot({ path: path.join(out, `child-sheet-${width}.png`) })
    await dad.keyboard.press("Escape")
    await sheet.waitFor({ state: "hidden" })
    await dad.waitForFunction(() => document.activeElement?.id === "openChildrenDialog")
  }
  await open()
  await dad.locator(`[data-child-card="${firstId}"]`).click()
  await dad.locator("#childrenDialog").waitFor({ state: "hidden" })
  assert.equal(new URL(dad.url()).pathname, `/children/${firstId}`)
  await open()
  await dad.locator(`[data-child-card="${created[0].id}"]`).click()
  await dad.locator("#calendarTitle").waitFor()
  assert.equal(new URL(dad.url()).pathname, `/children/${created[0].id}`)
  stage("child switcher long list scrolls vertically without role or archive labels")
  for (let n = 0; n < 8; n++)
    assert.equal((await api(dad, "/api/children", "POST", { name: `滚动${n}` })).status, 200)
  await open()
  await dad.locator("#childrenDialog [data-child-card]").nth(13).waitFor()
  const list = dad.locator(".children-dialog-cards")
  assert.equal(await list.evaluate((el) => el.scrollHeight > el.clientHeight), true)
  assert.equal(await list.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false)
  await dad.locator("[data-child-card]").first().focus()
  await dad.keyboard.press("End")
  assert.ok((await list.evaluate((el) => el.scrollTop)) > 0)
  await dad.keyboard.press("Escape")
  await dad.locator("#childrenDialog").waitFor({ state: "hidden" })
}
module.exports = { exerciseChildSwitcher }
