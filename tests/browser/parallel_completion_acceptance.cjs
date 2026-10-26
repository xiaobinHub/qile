const assert = require("node:assert/strict")
const path = require("node:path")
const deferred = () => {
  let resolve
  const promise = new Promise((done) => (resolve = done))
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
async function exerciseParallelCompletions({ browser, dad, origin, out, axe, stage }) {
  stage(
    "parallel completion and confirmed undo: spinners, conflicts, failures, recovery and exact ledger entries",
  )
  for (const [width, height, touch] of [
    [1135, 789, false],
    [820, 1180, true],
    [1180, 820, true],
    [390, 844, true],
  ]) {
    const created = await call(dad, "/api/children", "POST", { name: `并${width}`, gender: "boy", requestId: require('node:crypto').randomUUID() })
    assert.equal(created.status, 200)
    const child = created.child,
      base = `/api/children/${child.id}`
    const date = new Date().toLocaleDateString("en-CA")
    const keys = []
    async function operation(kind, payload) {
      const current = await call(dad, base + "/data")
      const result = await call(dad, base + "/operations", "POST", {
        kind,
        payload,
        expectedRevision: current.revision,
        membershipVersion: current.context.membershipVersion,
        operationId: crypto.randomUUID(),
      })
      assert.equal(result.status, 200)
      return result
    }
    for (let index = 0; index < 4; index++) {
      const result = await operation("task.create", {
        task: {
          title: ["阅读", "练字", "运动", "家务"][index],
          startDate: date,
          startTime: `${17 + index}:00`,
          endTime: `${17 + index}:30`,
          categoryId: (await call(dad, base + "/data")).data.categories.find((c) => c.active).id,
          points: (index + 1) * 5,
          note: "",
          recurrence: null,
        },
      })
      keys.push(result.data.series.at(-1).id + "@" + date)
    }
    await operation("completion.set", { occurrenceKey: keys[2], completed: true })
    const context = await browser.newContext({
      storageState: await dad.context().storageState(),
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    const page = await context.newPage(),
      errors = [],
      requests = [],
      responses = []
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    let phase = "parallel"
    const gates = new Map(keys.map((key) => [key, deferred()]))
    const allInitial = deferred(),
      unknownCaptured = deferred(),
      unknownGates = new Map(keys.slice(0, 2).map((key) => [key, deferred()]))
    let failedOnce = false,
      dropped = false
    await context.route("**/operations", async (route) => {
      const body = route.request().postDataJSON(),
        key = body.payload.occurrenceKey
      requests.push(structuredClone(body))
      assert.equal(body.kind, "completion.set")
      if (phase === "parallel") {
        if (new Set(requests.map((r) => r.payload.occurrenceKey)).size === 3) allInitial.resolve()
        await gates.get(key).promise
      }
      if (phase === "failure" && key === keys[3] && !failedOnce) {
        failedOnce = true
        return route.fulfill({ status: 400, json: { error: "隔离验收：该任务提交失败，请重试。" } })
      }
      if (phase === "unknown") {
        if (
          requests.filter(
            (r) => unknownGates.has(r.payload.occurrenceKey) && r.payload.completed === false,
          ).length >= 1
        )
          unknownCaptured.resolve()
        await unknownGates.get(key).promise
      }
      const response = await route.fetch()
      responses.push({ key, status: response.status(), phase })
      if (phase === "unknown" && key === keys[0] && response.ok() && !dropped) {
        dropped = true
        return route.abort("failed")
      }
      await route.fulfill({ response })
    })
    const button = (key) => page.locator(`[data-task-complete="${key}"]`)
    async function idle(key, completed) {
      await page.waitForFunction(
        ({ key, completed }) => {
          const button = document.querySelector(`[data-task-complete="${key}"]`)
          return (
            button &&
            button.getAttribute("aria-pressed") === String(completed) &&
            !button.disabled &&
            !button.hasAttribute("aria-busy")
          )
        },
        { key, completed },
      )
    }
    async function shot(name) {
      await page.evaluate(async () => {
        await document.fonts.ready
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        )
      })
      await page.screenshot({ path: path.join(out, `parallel-completion-${width}-${name}.png`) })
    }
    try {
      await page.goto(`${origin}/children/${child.id}`)
      await button(keys[0]).scrollIntoViewIfNeeded()
      const before = await button(keys[0]).boundingBox()
      await button(keys[0]).evaluate((button) => {
        button.click()
        button.click()
      })
      assert.equal(await button(keys[1]).isEnabled(), true)
      await button(keys[1]).click()
      await button(keys[2]).click()
      await page.locator("#undoTaskCompletionDialog").getByRole("button",{name:"确认撤销",exact:true}).click()
      await allInitial.promise
      assert.equal(requests.length, 3, "All three requests are in flight before any response")
      for (const key of keys.slice(0, 3)) {
        assert.equal(await button(key).getAttribute("aria-busy"), "true")
        assert.equal(await button(key).locator("svg.animate-spin").count(), 1)
        assert.equal(await button(key).isDisabled(), true)
      }
      assert.equal(await button(keys[3]).isEnabled(), true)
      assert.equal(await button(keys[3]).getAttribute("aria-busy"), null)
      const after = await button(keys[0]).boundingBox()
      assert.equal(after.width, before.width)
      assert.equal(after.height, before.height)
      await shot("month-pending")
      if (width === 1135 || width === 820) await axe(page, `parallel-month-pending-${width}`)
      gates.get(keys[2]).resolve()
      await page.locator("#undoTaskCompletionDialog").waitFor({state:"hidden"})
      await idle(keys[2],false)
      await page.locator("[data-mode=week]").click()
      await page.locator("#todayBtn").click()
      await button(keys[0]).scrollIntoViewIfNeeded()
      for (const key of keys.slice(0, 2))
        assert.equal(await button(key).locator("svg.animate-spin").count(), 1)
      await shot("week-pending")
      await page.locator("[data-mode=month]").click()
      gates.get(keys[1]).resolve()
      await idle(keys[1], true)
      assert.equal(await button(keys[0]).getAttribute("aria-busy"), "true")
      gates.get(keys[0]).resolve()
      gates.get(keys[2]).resolve()
      await Promise.all([idle(keys[0], true), idle(keys[2], false)])
      assert.ok(
        responses.filter((r) => r.status === 409).length >= 2,
        "Concurrent stale revisions really exercised the conflict handler",
      )
      let stored = await call(dad, base + "/data")
      assert.equal(stored.data.ledger.length, 4)
      assert.equal(
        stored.data.ledger.reduce((n, r) => n + r.amount, 0),
        15,
      )
      assert.equal(
        requests
          .filter((r) => r.payload.occurrenceKey === keys[0])
          .every((r) => r.operationId === requests[0].operationId),
        true,
      )
      phase = "failure"
      await button(keys[3]).click()
      await page.getByText("隔离验收：该任务提交失败，请重试。", { exact: true }).waitFor()
      await idle(keys[3], false)
      assert.equal(await button(keys[1]).getAttribute("aria-pressed"), "true")
      phase = "retry"
      await button(keys[3]).click()
      await idle(keys[3], true)
      stored = await call(dad, base + "/data")
      assert.equal(stored.data.ledger.length, 5)
      phase = "unknown"
      await button(keys[0]).click()
      await page.locator("#undoTaskCompletionDialog").getByRole("button",{name:"确认撤销",exact:true}).click()
      await unknownCaptured.promise
      const original = requests.find(
        (r) => r.payload.occurrenceKey === keys[0] && r.payload.completed === false,
      )
      unknownGates.get(keys[0]).resolve()
      await page.getByText("保存结果暂未确认，请刷新检查。", { exact: true }).first().waitFor()
      await page.locator("#undoTaskCompletionDialog").getByRole("button",{name:"取消",exact:true}).click()
      await page.locator("#undoTaskCompletionDialog").waitFor({state:"hidden"})
      await page.getByRole("button", { name: "重试原操作", exact: true }).first().waitFor()
      const prior = requests.length
      await page.getByRole("button", { name: "刷新检查", exact: true }).first().click()
      await page
        .getByText("已读取最新数据，请核对保存结果。原操作编号仍保留，可安全重试原操作。", {
          exact: true,
        })
        .waitFor()
      assert.equal(requests.length, prior, "Refresh never sends a completion request")
      phase = "recovery"
      await page.getByRole("button", { name: "重试原操作", exact: true }).first().click()
      await page
        .getByRole("button", { name: "重试原操作", exact: true })
        .first()
        .waitFor({ state: "hidden" })
      await idle(keys[0], false)
      assert.deepEqual(
        requests.at(-1),
        original,
        "Recovery sends the exact original request and operation ID",
      )
      await button(keys[1]).click()
      await page.locator("#undoTaskCompletionDialog").getByRole("button",{name:"确认撤销",exact:true}).click()
      await page.locator("#undoTaskCompletionDialog").waitFor({state:"hidden"})
      await idle(keys[1],false)
      assert.equal(
        await page.getByText("保存结果暂未确认，请刷新检查。", { exact: true }).count(),
        0,
      )
      stored = await call(dad, base + "/data")
      assert.equal(stored.data.ledger.length, 7)
      assert.equal(
        stored.data.ledger.reduce((n, r) => n + r.amount, 0),
        20,
      )
      for (const key of keys.slice(0, 3)) {
        assert.equal(
          stored.data.ledger.filter((r) => r.occurrenceKey === key && r.kind === "task-complete")
            .length,
          1,
        )
        assert.equal(
          stored.data.ledger.filter((r) => r.occurrenceKey === key && r.kind === "task-reversal")
            .length,
          1,
        )
      }
      assert.deepEqual(errors, [])
    } catch (error) {
      await shot("failure")
      console.error(error.stack)
      throw error
    } finally {
      for (const gate of [...gates.values(), ...unknownGates.values()]) gate.resolve()
      await context.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
      assert.equal((await call(dad, base, "DELETE", {})).status, 200)
    }
  }
}
module.exports = { exerciseParallelCompletions }
