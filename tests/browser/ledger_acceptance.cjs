const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseLedger({
  browser,
  dad,
  origin,
  firstId,
  out,
  axe,
  stage,
  layoutOnly = false,
}) {
  stage(
    "ledger: final earnings, filtered deductions, detailed scenes and compact responsive filters",
  )
  for (const [width, height, touch] of [
    [1135, 789, false],
    [1218, 789, false],
    [1920, 1028, false],
    [1218, 480, false],
    [897, 789, false],
    [820, 1180, true],
    [768, 1024, true],
    [700, 1000, true],
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
    const month = new Date().toLocaleDateString("en-CA").slice(0, 7)
    const row = (id, kind, amount, day, occurrenceKey) => ({
      id,
      kind,
      amount,
      occurrenceKey,
      date: `${month}-0${day}`,
      createdAt: `${month}-0${day}T12:00:00Z`,
      source: `验收记录-${id}`,
      reason: "隔离页面验收数据",
    })
    const ledger = [
      row("cancelled", "task-complete", 10, 5, "a"),
      row("old-completion", "task-complete", 20, 5, "b"),
      row("still-complete", "task-complete", 30, 5, "c"),
      row("bonus", "manual", 50, 5),
      row("undo-a", "task-reversal", -10, 6, "a"),
      row("undo-b", "task-reversal", -20, 6, "b"),
      row("deduction", "manual", -7, 6),
      row("redeem", "gift-redeem", -15, 6),
      row("new-completion", "task-complete", 20, 7, "b"),
      { ...row("refund", "gift-reversal", 15, 7), relatedLedgerId: "redeem" },
    ]
    await context.route("**/api/**", async (route) => {
      assert.equal(route.request().method(), "GET", "Ledger filters never write business data")
      if (new URL(route.request().url()).pathname !== `/api/children/${firstId}/data`)
        return route.continue()
      const response = await route.fetch()
      const pkg = await response.json()
      pkg.data.ledger = ledger
      return route.fulfill({ json: pkg })
    })
    const panel = page.locator(".store-ledger")
    const tableRows = () =>
      width > 680 ? panel.locator(".ledger-desktop tbody tr") : panel.locator(".ledger-mobile-card")
    async function check(earned, deducted, count) {
      assert.deepEqual(await panel.locator(".stats b").allTextContents(), [
        "93",
        `+${earned}`,
        String(deducted),
      ])
      assert.equal(await tableRows().count(), count)
    }
    async function choose(id, label, keyboard = false) {
      if (id === "filterDirection") return scenes([label], keyboard)
      await page.locator(`#${id}`).click()
      const option = page.getByRole("option", { name: label, exact: true })
      if (keyboard) {
        await option.focus()
        await option.press("Enter")
      } else await option.click()
      await page.getByRole("listbox").waitFor({ state: "hidden" })
    }
    async function scenes(labels, keyboard = false) {
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await page.locator("#filterDirection").click()
      await page.getByRole("menu").waitFor({ state: "visible" })
      await page.getByRole("menuitemcheckbox", { name: "全部场景", exact: true }).click()
      for (const label of labels) {
        const option = page.getByRole("menuitemcheckbox", { name: label, exact: true })
        if (keyboard) {
          await option.focus()
          await option.press("Space")
        } else await option.click()
        assert.equal(await option.getAttribute("aria-checked"), "true")
        assert.equal(
          await page.getByRole("menu").isVisible(),
          true,
          "Selecting scenes keeps the panel open",
        )
      }
      await page.keyboard.press("Escape")
      await page.getByRole("menu").waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.id === "filterDirection")
    }
    async function sceneOptions(expected) {
      await page.locator("#filterDirection").click()
      assert.deepEqual(await page.getByRole("menuitemcheckbox").allTextContents(), [
        "全部场景",
        ...expected,
      ])
      await page.keyboard.press("Escape")
      await page.getByRole("menu").waitFor({ state: "hidden" })
    }
    async function dateRange(from, to) {
      await page.locator("#ledgerRange").click()
      const calendar = page.locator(".shared-calendar")
      await calendar.locator(`[data-day="${month}-0${from}"] button`).click()
      await calendar.locator(`[data-day="${month}-0${to}"] button`).click()
      await calendar.waitFor({ state: "hidden" })
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
      await page.screenshot({
        path: path.join(out, `ledger-${width}${layoutOnly ? `-${height}` : ""}-${name}.png`),
      })
    }
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#calendarTitle").waitFor()
      await page.locator('[data-view="store"]').click()
      await page.locator('[data-store-tab="ledger"]').click()
      assert.equal(new URL(page.url()).pathname, `/children/${firstId}`)
      assert.ok(await page.title())
      assert.deepEqual(await panel.locator(".stats span").allTextContents(), [
        "当前积分",
        "获得积分",
        "扣减积分",
      ])
      assert.equal(await panel.getByText("积分概览", { exact: true }).count(), 0)
      const filterBox = await panel.locator(".ledger-filters").boundingBox()
      const statsBox = await panel.locator(".stats").boundingBox()
      assert.ok(filterBox.y + filterBox.height <= statsBox.y, "Filters precede the metric cards")
      const manualBox = await page.locator("#manualBtn").boundingBox()
      assert.ok(
        Math.abs(manualBox.x + manualBox.width - filterBox.x - filterBox.width) <= 1,
        "Manual adjustment aligns to the right edge",
      )
      if (width >= 1000) {
        const clearBox = await page.locator("#clearFilters").boundingBox()
        assert.ok(
          manualBox.x - clearBox.x - clearBox.width >= 80,
          "Manual adjustment is separated from the left filters",
        )
      }
      async function checkViewport() {
        const geometry = await page.evaluate(() => {
          const container = document.querySelector('.ledger-desktop [data-slot="table-container"]')
          const controls = [...document.querySelectorAll(".ledger-filters button")].map((button) =>
            button.getBoundingClientRect(),
          )
          return {
            pageBottom:
              document.querySelector(".store-page").getBoundingClientRect().bottom + scrollY,
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
            tableBottom: container.getBoundingClientRect().bottom,
            tableHeight: container.clientHeight,
            overlappingControls: controls.some((a, i) =>
              controls
                .slice(i + 1)
                .some(
                  (b) =>
                    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
                ),
            ),
          }
        })
        assert.equal(geometry.overlappingControls, false, "Toolbar controls never overlap")
        assert.ok(
          Math.abs(geometry.pageBottom - geometry.documentHeight) <= 1,
          "No gray gap after the store page",
        )
        if (width > 680 && height >= 600) {
          assert.ok(
            Math.abs(geometry.tableBottom - height) <= 1,
            "Table extends to viewport bottom",
          )
          assert.ok(
            geometry.documentHeight <= height + 1,
            "Desktop table scrolls without a second page scrollbar",
          )
          assert.ok(geometry.tableHeight > 120)
        }
      }
      await checkViewport()
      await check(50, -22, 10)
      const geometry = await panel.locator(".ledger-filters").evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const controls = [...element.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect()
          return {
            id: button.id,
            x: box.x,
            y: box.y,
            right: box.right,
            width: box.width,
            height: box.height,
          }
        })
        return {
          background: getComputedStyle(element).backgroundColor,
          height: rect.height,
          controls,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }
      })
      assert.equal(geometry.background, "rgba(0, 0, 0, 0)")
      assert.equal(geometry.overflow, false)
      assert.ok(
        geometry.controls.every(
          (control) => control.x >= 0 && control.right <= width + 1 && control.height >= 40,
        ),
      )
      if (width > 760) {
        assert.ok(geometry.height < 100)
        assert.ok(
          new Set(geometry.controls.map((control) => Math.round(control.y + control.height)))
            .size === 1,
          "All desktop filters share one row",
        )
        assert.ok(geometry.controls.find((control) => control.id === "ledgerRange").width <= 301)
      }
      await axe(page, `ledger-overview-${width}`)
      await shot("overview")
      await page.locator("#manualBtn").click()
      await page.locator("#manualDialog").waitFor()
      await page
        .locator("#manualDialog")
        .getByRole("button", { name: /^(Close|关闭)$/ })
        .click()
      await page.locator("#manualDialog").waitFor({ state: "hidden" })
      await check(50, -22, 10)
      if (layoutOnly) {
        if (width > 680 && height >= 600) {
          const scroll = panel.locator('.ledger-desktop [data-slot="table-container"]')
          const geometry = await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight
            const header = element.querySelector("thead").getBoundingClientRect()
            return {
              scrollTop: element.scrollTop,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
              top: element.getBoundingClientRect().top,
              headerTop: header.top,
            }
          })
          if (geometry.scrollHeight > geometry.clientHeight) {
            assert.ok(geometry.scrollTop > 0)
            assert.ok(
              Math.abs(geometry.headerTop - geometry.top) <= 1,
              "Column headings stay pinned while scrolling",
            )
          }
          await scroll.evaluate((element) => {
            element.scrollTop = 0
          })
        }
        await choose("filterSource", "手动调整")
        await check(0, -7, 2)
        await checkViewport()
        await shot("sparse")
        await page.locator("#clearFilters").click()
        await page.locator('[data-store-tab="gifts"]').click()
        await page.locator("#giftManageBtn").waitFor()
        assert.equal(
          await page.locator(".app").evaluate((element) => getComputedStyle(element).display),
          "block",
          "Gifts keep the original page layout",
        )
        await page.locator('[data-store-tab="ledger"]').click()
        await check(50, -22, 10)
        await checkViewport()
        assert.deepEqual(errors, [])
        continue
      }
      await page.locator("#filterDirection").click()
      assert.deepEqual(await page.getByRole("menuitemcheckbox").allTextContents(), [
        "全部场景",
        "完成任务",
        "撤销完成",
        "兑换礼品",
        "撤销兑换",
        "手动扣减",
        "手动增加",
      ])
      await page.getByRole("menuitemcheckbox", { name: "全部场景", exact: true }).focus()
      // Radix hides the background with aria-hidden and traps focus. Axe's modal
      // heuristic only recognizes dialogs, so scan this menu directly and
      // independently prove that background controls cannot receive focus.
      await page.locator("#manualBtn").evaluate((button) => button.focus())
      assert.equal(
        await page.getByRole("menu").evaluate((list) => list.contains(document.activeElement)),
        true,
      )
      for (const key of ["Tab", "Shift+Tab"]) {
        await page.keyboard.press(key)
        assert.equal(
          await page.getByRole("menu").evaluate((list) => list.contains(document.activeElement)),
          true,
        )
      }
      await axe(page, `ledger-scenes-${width}`, '[role="menu"]')
      await shot("scenes")
      await page.keyboard.press("Escape")
      for (const [label, earned, deducted, count] of [
        ["完成任务", 50, 0, 4],
        ["撤销完成", 0, 0, 2],
        ["兑换礼品", 0, -15, 1],
        ["手动扣减", 0, -7, 1],
        ["手动增加", 0, 0, 1],
        ["撤销兑换", 0, 0, 1],
      ]) {
        await choose("filterDirection", label, width === 1135)
        await check(earned, deducted, count)
        assert.ok((await tableRows().first().innerText()).includes(label))
      }
      await page.locator("#clearFilters").click()
      for (const [label, earned, deducted, count] of [
        ["任务", 50, 0, 6],
        ["礼品兑换", 0, -15, 2],
        ["手动调整", 0, -7, 2],
      ]) {
        await choose("filterSource", label)
        await check(earned, deducted, count)
      }
      await sceneOptions(["手动扣减", "手动增加"])
      await scenes(["手动扣减", "手动增加"], width === 1135)
      await check(0, -7, 2)
      assert.equal(await page.locator("#filterDirection").innerText(), "已选 2 项")
      await choose("filterSource", "任务")
      await check(50, 0, 6)
      assert.equal(await page.locator("#filterDirection").innerText(), "全部场景")
      await sceneOptions(["完成任务", "撤销完成"])
      await scenes(["完成任务", "撤销完成"], width === 1135)
      await check(50, 0, 6)
      await page.locator("#filterDirection").click()
      await page.getByRole("menuitemcheckbox", { name: "完成任务", exact: true }).click()
      await check(0, 0, 2)
      await page.getByRole("menuitemcheckbox", { name: "撤销完成", exact: true }).click()
      await check(50, 0, 6)
      assert.equal(
        await page
          .getByRole("menuitemcheckbox", { name: "全部场景", exact: true })
          .getAttribute("aria-checked"),
        "true",
      )
      await page.keyboard.press("Escape")
      await scenes(["完成任务"])
      await choose("filterSource", "全部来源")
      await check(50, 0, 4)
      await scenes(["完成任务", "手动扣减"], width === 1135)
      await check(50, -7, 5)
      await page.locator("#filterDirection").click()
      assert.equal(
        await page
          .getByRole("menuitemcheckbox", { name: "完成任务", exact: true })
          .getAttribute("aria-checked"),
        "true",
      )
      assert.equal(
        await page
          .getByRole("menuitemcheckbox", { name: "手动扣减", exact: true })
          .getAttribute("aria-checked"),
        "true",
      )
      await shot("multiselected")
      await page.keyboard.press("Escape")
      await choose("filterSource", "手动调整")
      await check(0, -7, 1)
      assert.equal(await page.locator("#filterDirection").innerText(), "手动扣减")
      await choose("filterSource", "礼品兑换")
      await check(0, -15, 2)
      await sceneOptions(["兑换礼品", "撤销兑换"])
      await scenes(["兑换礼品", "撤销兑换"])
      await check(0, -15, 2)
      await page.locator("#clearFilters").click()
      await dateRange(5, 5)
      await check(30, 0, 4)
      await choose("filterSource", "任务")
      await scenes(["完成任务", "撤销完成"])
      await check(30, 0, 3)
      if (width > 680)
        assert.equal(await tableRows().first().locator("td").last().innerText(), "60")
      await shot("filtered")
      await page.locator("#clearFilters").click()
      await dateRange(6, 6)
      await check(0, -22, 4)
      await page.locator("#clearFilters").click()
      await dateRange(7, 7)
      await check(20, 0, 2)
      await page.locator("#clearFilters").click()
      await dateRange(8, 8)
      await check(0, 0, 0)
      await page.getByText("还没有符合条件的积分流水", { exact: true }).waitFor()
      await page.locator("#clearFilters").click()
      await check(50, -22, 10)
      assert.equal(await page.locator("#filterDirection").innerText(), "全部场景")
      assert.equal(await page.locator("#filterSource").innerText(), "全部来源")
      assert.equal(await page.locator("#ledgerRange").innerText(), "选择日期范围")
      assert.deepEqual(errors, [])
    } finally {
      await context.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
    }
  }
}

module.exports = { exerciseLedger }
