const assert = require("node:assert/strict")
const path = require("node:path")
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function call(page, url, method = "GET", body) {
  return page.evaluate(
    async ({ url, method, body }) => {
      const auth = await (await fetch("/api/auth/me")).json()
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": auth.csrfToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, ...(await response.json()) }
    },
    { url, method, body },
  )
}
async function exerciseManualAdjustment({ browser, dad, origin, out, axe, stage }) {
  stage(
    "manual direction: positive magnitude, signed ledger, invalid input, retries and responsive form",
  )
  for (const [width, height, touch] of [
    [1135, 789, false],
    [820, 1180, true],
    [1180, 820, true],
    [390, 844, true],
  ]) {
    const created = await call(dad, "/api/children", "POST", { name: `积${width}`, gender: "boy", requestId: require('node:crypto').randomUUID() })
    assert.equal(created.status, 200)
    const base = `/api/children/${created.child.id}`
    const context = await browser.newContext({
      storageState: await dad.context().storageState(),
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const errors = [],
      requests = [],
      gate = deferred(),
      captured = deferred()
    let phase = "gate",
      failed = false,
      dropped = false
    page.on("pageerror", (error) => errors.push(error.message))
    await context.route(`**${base}/operations`, async (route) => {
      const body = route.request().postDataJSON()
      assert.equal(body.kind, "ledger.manual")
      requests.push(structuredClone(body))
      if (phase === "gate") {
        captured.resolve()
        await gate.promise
      }
      if (phase === "failure" && !failed) {
        failed = true
        return route.fulfill({ status: 400, json: { error: "隔离验收：提交失败，请重试。" } })
      }
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      if (phase === "unknown" && !dropped) {
        dropped = true
        return route.abort("failed")
      }
      return route.fulfill({ response })
    })
    const dialog = page.locator("#manualDialog"),
      amount = page.locator("#manualAmount")
    const save = () => dialog.getByRole("button", { name: "保存调整", exact: true })
    async function open() {
      await page.locator('[data-store-tab="ledger"]').click()
      await page.locator("#manualBtn").click()
      await dialog.waitFor()
      assert.equal(await page.locator("#manualDirection").innerText(), "增加")
      assert.equal(await amount.inputValue(), "")
      assert.equal(await page.locator("#manualDate-label").innerText(), "日期")
      assert.equal(await dialog.getByText("业务日期", { exact: true }).count(), 0)
      assert.equal(await dialog.getByText(/负数|10 或 -5/).count(), 0)
    }
    async function direction(label, keyboard = false) {
      await page.locator("#manualDirection").click()
      const option = page.getByRole("option", { name: label, exact: true })
      if (keyboard) {
        await option.focus()
        await option.press("Enter")
      } else await option.click()
      await page.getByRole("listbox").waitFor({ state: "hidden" })
    }
    async function stored(expected) {
      const result = await call(page, base + "/data")
      assert.equal(result.status, 200)
      assert.deepEqual(
        result.data.ledger.map((entry) => entry.amount),
        expected,
      )
      assert.ok(result.data.ledger.every((entry) => entry.kind === "manual"))
      return result
    }
    async function shot(name) {
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        )
      })
      await page.screenshot({ path: path.join(out, `manual-direction-${width}-${name}.png`) })
    }
    try {
      await page.goto(`${origin}/children/${created.child.id}`)
      await page.locator("#calendarTitle").waitFor()
      await page.locator('[data-view="store"]').click()
      await page.locator('[data-store-tab="ledger"]').click()
      await open()
      const geometry = await dialog.evaluate((element) => {
        const direction = element.querySelector("#manualDirection").getBoundingClientRect(),
          amount = element.querySelector("#manualAmount").getBoundingClientRect(),
          bounds = element.getBoundingClientRect()
        return {
          valid:
            direction.right <= amount.left &&
            amount.right <= bounds.right &&
            direction.top === amount.top,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }
      })
      assert.deepEqual(geometry, { valid: true, overflow: false })
      await page.locator("#manualReason").fill("  手动增加验收  ")
      for (const invalid of ["", "0", "-3", "1.5", "9007199254740992"]) {
        await amount.fill(invalid)
        assert.equal(await amount.evaluate((input) => input.checkValidity()), false)
        await save().click()
        assert.equal(requests.length, 0, "Invalid magnitudes never submit a write")
      }
      await amount.fill("10")
      await shot("increase")
      await axe(page, `manual-increase-${width}`)
      await save().evaluate((button) => {
        button.click()
        button.click()
      })
      await captured.promise
      assert.equal(requests.length, 1, "Duplicate submits share one write")
      assert.equal(await page.locator("#manualDirection").isDisabled(), true)
      assert.equal(await amount.isDisabled(), true)
      assert.equal(requests[0].payload.amount, 10)
      assert.equal(requests[0].payload.reason, "手动增加验收")
      assert.match(requests[0].payload.date, /^\d{4}-\d{2}-\d{2}$/)
      gate.resolve()
      await dialog.waitFor({ state: "hidden" })
      await stored([10])
      await open()
      await amount.fill("5")
      await direction("减少", width === 1135)
      await direction("增加")
      await direction("减少")
      assert.equal(await amount.inputValue(), "5", "Changing direction preserves the magnitude")
      await page.locator("#manualReason").fill("手动减少验收")
      await shot("decrease")
      await axe(page, `manual-decrease-${width}`)
      phase = "failure"
      await save().click()
      await page
        .locator("#manualError")
        .getByText("隔离验收：提交失败，请重试。", { exact: true })
        .waitFor()
      assert.equal(await amount.inputValue(), "5")
      assert.equal(await page.locator("#manualDirection").innerText(), "减少")
      assert.equal(requests.at(-1).payload.amount, -5)
      await stored([10])
      phase = "normal"
      await save().click()
      await dialog.waitFor({ state: "hidden" })
      await stored([10, -5])
      assert.equal(await page.locator(".stats b").first().innerText(), "5")
      if (width === 1135) {
        await open()
        await direction("减少")
        await amount.fill("3")
        await page.locator("#manualReason").fill("减少结果未知验收")
        phase = "unknown"
        await save().click()
        await dialog.getByRole("button", { name: "刷新检查", exact: true }).waitFor()
        const original = structuredClone(requests.at(-1)),
          count = requests.length
        assert.equal(original.payload.amount, -3)
        await dialog.getByRole("button", { name: "刷新检查", exact: true }).click()
        await page
          .getByText("已读取最新数据，请核对保存结果。原操作编号仍保留，可安全重试原操作。", {
            exact: true,
          })
          .waitFor()
        assert.equal(requests.length, count)
        await dialog.getByRole("button", { name: "重试原操作", exact: true }).click()
        await dialog.waitFor({ state: "hidden" })
        assert.deepEqual(
          requests.at(-1),
          original,
          "Recovery retains the original signed amount and operation ID",
        )
        await stored([10, -5, -3])
      }
      const count = requests.length
      await open()
      await direction("减少")
      await amount.fill("9")
      await dialog.getByRole("button", { name: "取消", exact: true }).click()
      await dialog.waitFor({ state: "hidden" })
      assert.equal(requests.length, count)
      assert.deepEqual(errors, [])
    } finally {
      gate.resolve()
      await context.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
      assert.equal((await call(dad, base, "DELETE", {})).status, 200)
    }
  }
}
module.exports = { exerciseManualAdjustment }
