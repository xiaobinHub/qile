/* Layout and computed-type acceptance. Sample data exists only in intercepted GETs. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { captureReferenceUI } = require("./reference_ui_capture.cjs")

async function exerciseTypography({
  browser,
  dad,
  admin,
  origin,
  adminOrigin,
  firstId,
  out,
  stage,
}) {
  stage("shared typography and compact layout across PC, iPad and narrow screens")
  const destination = path.join(out, "typography")
  fs.mkdirSync(destination, { recursive: true })
  const records = []
  const state = await dad.context().storageState()
  const adminState = await admin.context().storageState()
  const viewports = [
    [1280, 800, false],
    [1440, 900, false],
    [768, 1024, true],
    [820, 1180, true],
    [1024, 768, true],
    [1180, 820, true],
    [390, 844, true],
  ]
  const size = async (page, selector, expected, label) => {
    const result = await page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight }
      })
    assert.equal(parseFloat(result.fontSize), expected, label + ": " + selector)
    records.push({ viewport: page.viewportSize(), surface: label, selector, ...result })
  }
  const shot = async (page, name) => {
    await page.locator(".settings-loading").first().waitFor({ state: "hidden" })
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      )
    })
    assert.equal(
      await page.locator(".settings-load-error").count(),
      0,
      name + " loaded successfully",
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
      name + " page overflow",
    )
    await page.screenshot({ path: path.join(destination, name + ".png") })
  }
  for (const [width, height, touch] of viewports) {
    const tag = `${width}x${height}`
    await captureReferenceUI({
      browser,
      state,
      origin,
      firstId,
      out: destination,
      axe: async () => {},
      viewport: { width, height },
      touch,
      prefix: tag + "-",
      giftCount: 5,
      inspect: async (page) => {
        const columns = await page
          .locator(".gift-grid")
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)
        assert.equal(columns, width >= 1024 ? 4 : width >= 768 ? 3 : 2, tag + " gift columns")
        await size(page, ".gift-card h3", 15, "store")
        await size(page, ".gift-cost", 24, "store")
        await size(page, ".gift-shortage", 13, "store")
        await size(page, ".gift-card-actions button", 14, "store")
        assert.ok(await page.locator('[data-redeem="visual-gift-0"]').isEnabled())
        assert.ok(await page.locator('[data-redeem="visual-gift-3"]').isDisabled())
        const cardTops = await page
          .locator(".gift-card-actions")
          .evaluateAll((els) => els.slice(0, 2).map((el) => el.getBoundingClientRect().bottom))
        assert.ok(Math.abs(cardTops[0] - cardTops[1]) < 1, "gift actions align")
        if (touch)
          assert.ok(
            (await page.locator(".gift-card-actions button").first().boundingBox()).height >= 44,
          )

        await page.locator('[data-view="calendar"]').click()
        await size(page, "#calendarTitle", 22, "calendar")
        await size(page, "#todayBtn", 14, "calendar")
        await size(page, ".nav button", 14, "header")
        if (width >= 768) {
          assert.equal(
            (await page.locator(".topbar").boundingBox()).height,
            72,
            tag + " header height",
          )
          const title = await page.locator("#calendarTitle").boundingBox()
          const navigation = await page.locator(".calendar-navigation").boundingBox()
          assert.ok(
            title.x + title.width <= navigation.x + 1,
            "calendar title does not overlap date actions",
          )
          if (width < 1024) {
            const actions = await page.locator(".calendar-toolbar-actions").boundingBox()
            assert.ok(
              actions.y >= navigation.y + navigation.height,
              "portrait calendar uses two rows",
            )
          }
        }
        await page.locator("#newTaskBtn").click()
        await size(page, '#taskDialog [data-slot="dialog-title"]', 20, "task-dialog")
        await size(page, "#taskTitle", touch ? 16 : 14, "task-dialog")
        await page.keyboard.press("Escape")
        await page.locator('[data-view="settings"]').click()
        await size(page, ".settings-nav-item", 14, "settings")
        await size(page, ".settings-nav-group h2", 13, "settings")
        await size(page, ".settings-detail-heading h2", 20, "settings")
        await page.locator("#openPasswordSettings").click()
        await size(page, 'label[for="passwordNew"]', 14, "settings-password")
        await size(page, "#passwordNew", touch ? 16 : 14, "settings-password")
        await size(page, "#passwordNew-help", 13, "settings-password-help")
        await shot(page, tag + "-settings-password")
        if (width === 1440 || width === 820) {
          const ids = await page
            .locator(".settings-nav-item:not(#settingsLogout)")
            .evaluateAll((els) => els.map((el) => el.id))
          for (const id of ids) {
            await page.locator("#" + id).click()
            await size(page, ".settings-detail-heading h2", 20, id)
            await shot(page, tag + "-" + id)
            if (await page.locator(".settings-empty strong").count()) {
              await size(page, ".settings-empty strong", 14, id + "-empty-title")
              await size(page, ".settings-empty p", 13, id + "-empty-copy")
            }
          }
        }
        if (width === 1440) {
          await page.locator("#openPasswordSettings").click()
          await page.evaluate(() => (document.documentElement.style.fontSize = "200%"))
          await size(page, "#passwordNew", 28, "settings-text-200-percent")
          await shot(page, tag + "-text-200-percent")
          await size(page, ".settings-nav-item", 28, "settings-text-200-percent")
          await size(page, ".nav button", 28, "header-text-200-percent")
          await page.evaluate(() => document.documentElement.style.removeProperty("font-size"))
        }
      },
    })
    const context = await browser.newContext({
      storageState: adminState,
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    try {
      const page = await context.newPage()
      await page.route("**/api/**", (route) =>
        route.request().method() === "GET" ? route.continue() : route.abort(),
      )
      await page.goto(adminOrigin)
      await page.locator("#userRows tr[data-user-id]").first().waitFor()
      await size(page, ".ui-page-heading h1", 22, "admin-users")
      await size(page, "#userRows td", 14, "admin-table")
      await shot(page, tag + "-admin")
      await page.locator("#openCreateUser").click()
      await size(page, '[role="dialog"] [data-slot="dialog-title"]', 20, "admin-create")
      await size(page, "#createNickname", touch ? 16 : 14, "admin-create")
      await shot(page, tag + "-admin-create")
    } finally {
      await context.close()
    }
  }
  fs.writeFileSync(
    path.join(destination, "computed-type-audit.json"),
    JSON.stringify(
      {
        passed: true,
        records,
        browser: "Chromium / repository Playwright; Browser plugin not available",
        limits:
          "Touch and text scaling are emulated. Physical iPad, Safari and native browser zoom remain device acceptance.",
      },
      null,
      2,
    ),
  )
}
module.exports = { exerciseTypography }
