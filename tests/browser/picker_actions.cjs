const assert = require("node:assert/strict")

async function selectNumber(page, id, value) {
  await page.locator(`#${id}`).click()
  const panel = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("spinbutton") })
    .last()
  const wheel = panel.getByRole("spinbutton")
  await wheel.press("Home")
  const minimum = Number(await wheel.getAttribute("aria-valuemin"))
  const maximum = await wheel.getAttribute("aria-valuemax")
  const values = [
    ...new Set(
      await wheel
        .locator("[data-number-value]")
        .evaluateAll((rows) => rows.map((row) => Number(row.dataset.numberValue))),
    ),
  ].sort((a, b) => a - b)
  const increment = values.length > 1 ? values[1] - values[0] : 1
  const steps = (value - minimum) / increment
  assert.ok(
    Number.isInteger(steps) && steps >= 0 && (maximum === null || value <= Number(maximum)),
    "Requested value is selectable",
  )
  if (maximum !== null && value === Number(maximum)) await wheel.press("End")
  else {
    for (let n = 0; n < Math.floor(steps / 5); n++) await wheel.press("PageDown")
    for (let n = 0; n < steps % 5; n++) await wheel.press("ArrowDown")
  }
  assert.equal(Number(await wheel.getAttribute("aria-valuenow")), value)
  await panel.getByRole("button", { name: "完成", exact: true }).click()
  await panel.waitFor({ state: "hidden" })
}

async function selectMonthDay(page, day) {
  await page.locator("#repeatMonthDay").click()
  const panel = page.getByRole("dialog", { name: "选择每月日期", exact: true })
  await panel.getByRole("radio", { name: `${day}日`, exact: true }).click()
  await panel.waitFor({ state: "hidden" })
}

async function selectTime(page, id, hour, minute) {
  await page.locator(`#${id}`).click()
  const panel = page.getByRole("dialog", {
    name: id === "taskDuration" ? "选择持续时长" : "选择时间",
    exact: true,
  })
  for (const [label, value] of [
    ["小时", hour],
    ["分钟", minute],
  ]) {
    const wheel = panel.getByRole("spinbutton", { name: label, exact: true })
    await wheel.press("Home")
    for (let n = 0; n < Math.floor(value / 5); n++) await wheel.press("PageDown")
    for (let n = 0; n < value % 5; n++) await wheel.press("ArrowDown")
    assert.equal(Number(await wheel.getAttribute("aria-valuenow")), value)
  }
  await panel.getByRole("button", { name: "完成", exact: true }).click()
  await panel.waitFor({ state: "hidden" })
}

module.exports = { selectNumber, selectMonthDay, selectTime }
