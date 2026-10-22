/* Visual-only response fixture: authenticated test context, every write rejected.
 * Never persists sample children, tasks, points, or reference gift photographs. */
const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")

async function captureReferenceUI({
  browser,
  state,
  origin,
  firstId,
  out,
  axe,
  viewport = { width: 1487, height: 1058 },
  touch = false,
  prefix = "reference-final-",
  giftCount = 3,
  inspect,
}) {
  const context = await browser.newContext({
    storageState: state,
    viewport,
    hasTouch: touch,
    isMobile: touch,
  })
  const images = ["zoo", "blocks", "microscope"].map(
    (name) =>
      "data:image/jpeg;base64," +
      fs
        .readFileSync(path.join(__dirname, "../fixtures/ui-reference", name + ".jpg"))
        .toString("base64"),
  )
  let writes = 0
  await context.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") {
      writes++
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "视觉样例禁止写入。" }),
      })
    }
    const response = await route.fetch()
    if (!response.ok() || !response.headers()["content-type"]?.includes("application/json"))
      return route.fulfill({ response })
    const body = await response.json(),
      url = new URL(route.request().url())
    if (url.pathname === "/api/children") {
      body.children = body.children.map((child) =>
        child.id === firstId ? { ...child, name: "乐乐" } : child,
      )
    } else if (url.pathname === `/api/children/${firstId}/data`) {
      const categories = [
        { id: "visual-reading", name: "阅读", color: "#16834b", active: true },
        { id: "visual-math", name: "学习", color: "#2563eb", active: true },
        { id: "visual-outdoor", name: "运动", color: "#b77912", active: true },
      ]
      const task = (id, title, startTime, endTime, categoryId) => ({
        id,
        title,
        startDate: "2026-10-01",
        startTime,
        endTime,
        categoryId,
        points: 10,
        note: "",
        recurrence: { freq: "daily", interval: 1, endType: "until", until: "2026-10-31" },
      })
      const reading = task("visual-reading-task", "晨间阅读", "07:30", "08:00", categories[0].id)
      const math = task("visual-math-task", "数学练习", "18:00", "18:30", categories[1].id)
      const createdAt = "2026-10-01T00:00:00.000Z"
      body.data = {
        ...body.data,
        settings: { ...body.data.settings, childName: "乐乐" },
        categories,
        series: [reading, math],
        exceptions: [],
        completions: [1, 2, 5, 8, 12, 15, 20, 22].map((day) => ({
          occurrenceKey: `${reading.id}@2026-10-${String(day).padStart(2, "0")}`,
          completed: true,
          snapshot: {
            ...reading,
            seriesId: reading.id,
            date: `2026-10-${String(day).padStart(2, "0")}`,
            originalDate: `2026-10-${String(day).padStart(2, "0")}`,
            recurring: true,
          },
        })),
        ledger: [
          {
            id: "visual-balance",
            kind: "manual",
            amount: 500,
            date: "2026-10-01",
            createdAt,
            reason: "视觉测试余额",
          },
        ],
        gifts: [
          "动物园亲子日",
          "创意积木套装",
          "儿童显微镜",
          "东方112型内燃机车拼装套装与轨道拓展组合超长礼品名称",
          "亲子阅读奖励",
        ]
          .slice(0, giftCount)
          .map((name, i) => ({
            id: `visual-gift-${i}`,
            name,
            points: [100, 300, 800, 123456, 20][i],
            imageData: i === 4 ? "" : images[i % images.length],
            status: "available",
            createdAt,
            updatedAt: createdAt,
          })),
        taskPresets: [],
        operationLog: [],
      }
    }
    return route.fulfill({ response, json: body })
  })
  try {
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
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
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      )
      await page.screenshot({ path: path.join(out, prefix + name + ".png") })
    }
    await page.goto(`${origin}/children/${firstId}`)
    await page.locator("#calendarTitle").waitFor()
    const title = await page.locator("#calendarTitle").innerText()
    await page.locator("#prevPeriod").click()
    await page.waitForFunction(
      (previous) => document.querySelector("#calendarTitle").textContent !== previous,
      title,
    )
    await page.locator("#nextPeriod").click()
    await page.waitForFunction(
      (previous) => document.querySelector("#calendarTitle").textContent === previous,
      title,
    )
    await shot("calendar")
    await axe(page, "reference-month")
    await page.locator('[data-view="settings"]').click()
    await shot("settings")
    await axe(page, "reference-settings")
    await page.locator('[data-view="store"]').click()
    await page.locator('[data-store-tab="gifts"]').waitFor()
    assert.equal(await page.locator(".gift-card").count(), giftCount)
    assert.equal(await page.locator('[data-redeem="visual-gift-2"]').isDisabled(), true)
    await shot("store")
    await axe(page, "reference-store")
    if (inspect) await inspect(page)
    assert.equal(writes, 0)
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
}
module.exports = { captureReferenceUI }
