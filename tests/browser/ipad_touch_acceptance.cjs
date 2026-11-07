/* Runs against the real parent/plugin with HTTP fixtures. Chromium uses native
   input gestures; WebKit verifies layout and native wheel scrolling. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  const pages = []
  for (let i = 1; i <= 8; i++) {
    const page = objects.length + 1
    pages.push(`${page} 0 R`)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`,
    )
    const content = `0.95 0.85 0.3 rg 30 450 540 270 re f 0 0 0 rg BT /F1 36 Tf 55 650 Td (Courseware - Page ${i}) Tj ET BT /F1 20 Tf 55 380 Td (Swipe to read the next page.) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count 8 >>`
  let data = "%PDF-1.4\n"
  const offsets = [0]
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(data))
    data += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const start = Buffer.byteLength(data)
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  data += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(data)
}

async function exerciseMisonTouch({ page, browserContext, origin, entryUrl, out, engine }) {
  const cdp = engine === "chromium" ? await browserContext.newCDPSession(page) : null
  const checks = []
  async function gesture(locator, { reverse = false, horizontal = false, start } = {}) {
    const box = await locator.boundingBox()
    assert.ok(box && box.height > 100 && box.width > 40, "Scrollport is visible and usable")
    const distance = Math.min(200, (horizontal ? box.width : box.height) - 64)
    // Start inside a card/control, rather than a grid's empty center gutter.
    const x = start?.x ?? box.x + (horizontal ? box.width - 32 : Math.min(80, box.width / 2))
    const y = start?.y ?? box.y + (reverse ? 32 : box.height - 32)
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
      for (let i = 1; i <= 16; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: x - (horizontal ? (distance * i) / 16 : 0),
              y: y + (horizontal ? 0 : ((reverse ? 1 : -1) * distance * i) / 16),
            },
          ],
        })
        await page.waitForTimeout(16)
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    } else {
      await page.mouse.move(x, y)
      await page.mouse.wheel(
        horizontal ? distance : 0,
        horizontal ? 0 : reverse ? -distance : distance,
      )
    }
    await page.waitForTimeout(400)
  }
  async function scrolls(locator, label) {
    await locator.evaluate((element) => element.scrollTo(0, 0))
    const fixed = await page
      .locator(".app, #main, .plugin-page, .plugin-host, .plugin-mount")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          bounds: element.getBoundingClientRect().toJSON(),
          top: element.scrollTop,
        })),
      )
    await gesture(locator)
    const top = await locator.evaluate((element) => element.scrollTop)
    assert.ok(top > 60, `${label} moves through native input, got ${top}`)
    assert.equal(await page.evaluate(() => scrollY), 0, `${label} never moves document`)
    const after = await page
      .locator(".app, #main, .plugin-page, .plugin-host, .plugin-mount")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          bounds: element.getBoundingClientRect().toJSON(),
          top: element.scrollTop,
        })),
      )
    assert.deepEqual(after, fixed, `${label} never moves or resizes the shell or plugin ancestors`)
    checks.push(`${label}: ${Math.round(top)}px native scroll`)
  }
  async function screenshot(name) {
    await page.screenshot({ path: path.join(out, `${engine}-${name}.png`) })
  }
  async function load() {
    await page.goto(entryUrl || `${origin}/parent-assets/`)
    await page.locator('[data-view="plugin:mison-booking"]').waitFor()
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await page.getByRole("heading", { name: "可约老师 · 60" }).waitFor()
  }
  if (process.env.IPAD_CORE_ONLY !== "1") {
    for (const [width, height] of [
      [1180, 820],
      [820, 1180],
      [1366, 1024],
      [1024, 1366],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height })
      await load()
      assert.equal(await page.title(), "成长计划")
      assert.equal(await page.locator("vite-error-overlay").count(), 0)
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).position), "fixed")
      assert.equal(
        await page.locator(".app").evaluate((element) => getComputedStyle(element).position),
        "fixed",
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      )
      const gallery = page.locator(".mison-teacher-scroll")
      assert.equal(
        await gallery.locator('[data-slot="scroll-area-viewport"]').count(),
        0,
        "Teacher list uses one native scrollport",
      )
      assert.equal(
        await page.locator("#main").evaluate((element) => getComputedStyle(element).overflowY),
        "hidden",
      )
      assert.equal(
        await page
          .locator(".mison-booking")
          .evaluate((element) => element.style.getPropertyValue("--mison-viewport-height")),
        "",
        "Plugin doesn't measure its own height",
      )
      await scrolls(gallery, `gallery ${width}x${height}`)
      const toolbar = await page.locator(".mison-filters").boundingBox()
      await gallery.evaluate((element) => (element.scrollTop = element.scrollHeight))
      await gesture(gallery)
      assert.equal(
        await page.evaluate(() => scrollY),
        0,
        "Bottom boundary cannot scroll the document",
      )
      assert.ok(Math.abs((await page.locator(".mison-filters").boundingBox()).y - toolbar.y) < 1)
      await gallery.evaluate((element) => element.scrollTo(0, 0))
      await gesture(gallery, { reverse: true })
      assert.equal(await page.evaluate(() => scrollY), 0, "Top boundary cannot pull the document")
      const heading = await page.locator(".mison-list-heading").boundingBox()
      await gesture(gallery, { reverse: true, start: { x: heading.x + 80, y: heading.y + 8 } })
      assert.equal(
        await gallery.evaluate((element) => element.scrollTop),
        0,
        "Swiping the fixed heading cannot drag the list or page",
      )
      await gallery.evaluate((element) => (element.scrollTop = 80))
      await page.locator('[data-book-teacher="demo-0"]').click()
      await page.getByRole("region", { name: "约课区" }).waitFor()
      if (width > 740) {
        const stage = page.locator(".mison-stage-scroll")
        const before = await stage.evaluate((element) => element.scrollTop)
        await scrolls(gallery, `sidebar ${width}x${height}`)
        assert.equal(
          await stage.evaluate((element) => element.scrollTop),
          before,
          "Sidebar doesn't scroll schedule",
        )
        const sidebarTop = await gallery.evaluate((element) => element.scrollTop)
        await page.getByRole("button", { name: "收起约课区" }).click()
        assert.ok(
          Math.abs((await gallery.evaluate((element) => element.scrollTop)) - 80) < 2,
          "Gallery restores its own scroll position",
        )
        await page.locator('[data-book-teacher="demo-0"]').click()
        assert.ok(
          Math.abs((await gallery.evaluate((element) => element.scrollTop)) - sidebarTop) < 2,
          "Sidebar restores its own scroll position",
        )
        await stage.evaluate((element) => (element.scrollTop = 0))
        if (await stage.evaluate((element) => element.scrollHeight > element.clientHeight + 70)) {
          const sidebarBefore = await gallery.evaluate((element) => element.scrollTop)
          await scrolls(stage, `schedule ${width}x${height}`)
          assert.equal(
            await gallery.evaluate((element) => element.scrollTop),
            sidebarBefore,
            "Schedule doesn't scroll sidebar",
          )
        }
      } else assert.equal(await page.locator(".mison-teachers").isVisible(), false)
      await screenshot(`sidebar-${width}`)
    }
    await page.setViewportSize({ width: 1180, height: 820 })
    await load()
    await page.getByRole("searchbox", { name: "搜索老师姓名" }).fill("Jenyy")
    await page.getByRole("button", { name: "搜索", exact: true }).click()
    await page.getByRole("heading", { name: "可约老师 · 1", exact: true }).waitFor()
    const shortList = page.locator(".mison-teacher-scroll")
    assert.equal(
      await shortList.evaluate((element) => element.scrollHeight <= element.clientHeight),
      true,
    )
    await gesture(shortList)
    await gesture(shortList, { reverse: true })
    assert.equal(
      await page.evaluate(() => scrollY),
      0,
      "A short list cannot hand a gesture to the page",
    )
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    await page.getByRole("heading", { name: "可约老师 · 60", exact: true }).waitFor()
    checks.push(
      "fixed heading, independent mode positions, short-list boundaries and unchanged ancestor geometry",
    )
    await page.locator('[data-book-teacher="demo-0"]').click()
    await page.getByRole("button", { name: "10:00", exact: true }).click()
    await page.getByRole("button", { name: "下一步：确认课件" }).click()
    await page.getByRole("button", { name: "更换课件", exact: true }).first().click()
    const picker = page.getByRole("dialog", { name: "更换课件", exact: true })
    await picker.getByRole("radio").nth(3).waitFor()
    await scrolls(picker.getByRole("navigation", { name: "课件分类" }), "courseware categories")
    await scrolls(picker.locator("section[aria-label='选择课件']"), "courseware choices")
    await picker.getByRole("button", { name: "取消", exact: true }).click()
    await page.getByRole("tab", { name: "课程日历", exact: true }).click()
    await page.getByRole("button", { name: /我的预约/ }).click()
    const bookings = page.getByRole("dialog", {
      name: "我的预约",
      exact: true,
      includeHidden: true,
    })
    await bookings.locator(".mison-booking-card").first().waitFor()
    const tabs = await bookings.getByRole("tablist").boundingBox()
    const list = bookings.locator(".mison-booking-list")
    await scrolls(list, "bookings drawer")
    assert.ok(Math.abs((await bookings.getByRole("tablist").boundingBox()).y - tabs.y) < 1)
    await list.evaluate((element) => (element.scrollTop = 0))
    await bookings.getByRole("button", { name: "课程资料", exact: true }).first().click()
    const pdf = page.getByRole("dialog", { name: "触控课件", exact: true })
    await pdf.getByText("共 8 页", { exact: true }).waitFor()
    await pdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
    assert.equal(await pdf.locator("iframe").count(), 0)
    const pdfScroll = pdf.locator(".pdf-preview-scroll")
    const listTop = await list.evaluate((element) => element.scrollTop)
    await scrolls(pdfScroll, "PDF pages")
    assert.equal(
      await list.evaluate((element) => element.scrollTop),
      listTop,
      "PDF doesn't scroll underlying sheet",
    )
    await pdf.locator(".mison-overlay-header").getByText("共 8 页", { exact: true }).waitFor()
    assert.equal(await pdf.locator(".pdf-preview-tools").count(), 0)
    assert.equal(await pdf.getByRole("button", { name: "放大 PDF" }).count(), 0)
    const downloadPromise = page.waitForEvent("download")
    await pdf.getByRole("button", { name: "下载", exact: true }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), "触控课件.pdf")
    assert.equal(await download.failure(), null, "PDF download completes without cancellation")
    const downloadedPdf = path.join(out, `${engine}-courseware.pdf`)
    await download.saveAs(downloadedPdf)
    assert.deepEqual(
      fs.readFileSync(downloadedPdf),
      pdfFixture(),
      "Downloaded PDF bytes are complete",
    )
    await download.delete()
    await page.setViewportSize({ width: 820, height: 1180 })
    await pdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
    await scrolls(pdfScroll, "PDF portrait after rotation")
    await pdfScroll.evaluate((element) => (element.scrollTop = element.scrollHeight))
    await pdf.locator('[data-pdf-page="8"][data-rendered="true"]').waitFor()
    await page.waitForFunction(
      () => document.querySelectorAll(".pdf-preview-page canvas").length < 8,
    )
    assert.ok((await pdf.locator("canvas").count()) < 8, "Only nearby PDF canvases are allocated")
    await screenshot("pdf-last-page")
    await pdf.getByRole("button", { name: "关闭触控课件", exact: true }).click()
    await pdf.waitFor({ state: "hidden" })
    assert.equal(await bookings.isVisible(), true)
    await scrolls(list, "bookings after closing PDF")
    // The first direct CDN response is invalid; retry loads the fixture again.
    let invalidPdf = true
    await page.route("https://file.mison.cn/fixtures/touch-courseware.pdf", async (route) => {
      const request = route.request()
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "Range",
          },
        })
      }
      if (!invalidPdf) return route.fallback()
      invalidPdf = false
      return route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: { "access-control-allow-origin": "*" },
        body: "invalid PDF",
      })
    })
    await list.evaluate((element) => (element.scrollTop = 0))
    await bookings.getByRole("button", { name: "课程资料", exact: true }).first().click()
    await pdf.getByRole("alert").waitFor()
    await pdf.getByRole("button", { name: "重试", exact: true }).click()
    await pdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
    await pdf.getByRole("button", { name: "关闭触控课件", exact: true }).click()
    await bookings.getByRole("button", { name: "关闭我的预约", exact: true }).click()
    await bookings.waitFor({ state: "hidden" })
    assert.equal(await page.locator(".pdf-preview").count(), 0)
    await page.waitForFunction(() => !document.body.hasAttribute("data-scroll-locked"))
    const retainedPage = await page.locator(".plugin-page").elementHandle()
    const retainedMount = await page.locator('[data-plugin-root="mison-booking"]').elementHandle()
    const retainedOverlay = await page
      .locator('[data-plugin-overlay="mison-booking"]')
      .elementHandle()
    const retainedRoots = await page.locator(".mison-ui").count()
    assert.ok(retainedRoots > 0, "Mison is mounted before leaving")
    const galleryTop = await page.locator(".mison-teacher-scroll").evaluate(async (element) => {
      element.scrollTop = 120
      await new Promise(requestAnimationFrame)
      return element.scrollTop
    })
    await page.locator('[data-view="settings"]').click()
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector("#main")).overflowY === "auto",
    )
    assert.equal(await page.locator(".mison-ui").count(), retainedRoots)
    for (const [label, element] of [
      ["page", retainedPage],
      ["overlay", retainedOverlay],
    ]) {
      assert.deepEqual(
        await element.evaluate((node) => ({
          connected: node.isConnected,
          hidden: node.hidden,
          inert: node.inert,
        })),
        { connected: true, hidden: true, inert: true },
        `Retained Mison ${label} is hidden and inert`,
      )
      assert.equal(await element.isVisible(), false)
    }
    assert.equal(await retainedMount.evaluate((node) => node.isConnected), true)
    await page
      .locator('[data-plugin-root="mison-booking"] button')
      .first()
      .evaluate((button) => button.focus())
    await page.keyboard.press("Tab")
    assert.equal(
      await page.evaluate(() => !!document.activeElement?.closest(".mison-ui")),
      false,
      "Hidden plugin cannot take programmatic or keyboard focus",
    )
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0)
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked")), false)
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.body).pointerEvents),
      "none",
    )
    await page.locator("#openChildManagementSettings").click()
    const sidebar = await page.locator(".settings-sidebar").boundingBox()
    assert.ok(
      Math.abs(sidebar.y + sidebar.height - (page.viewportSize().height - 16)) < 2,
      "Settings sidebar fills the available content height",
    )
    await page.locator("#openCategorySettings").click()
    const content = page.locator("#main")
    const header = await page.locator(".topbar").boundingBox()
    await gesture(content)
    assert.ok(
      (await content.evaluate((element) => element.scrollTop)) > 60,
      "Settings long page scrolls inside main",
    )
    assert.equal(await page.evaluate(() => scrollY), 0)
    assert.deepEqual(
      await page.locator(".topbar").boundingBox(),
      header,
      "Long settings page leaves navigation fixed",
    )
    checks.push("settings long content scrolls within main and navigation stays fixed")
    await page.locator('[data-view="plugin:mison-booking"]').click()
    const calendarTab = page.getByRole("tab", { name: "课程日历", exact: true })
    await calendarTab.waitFor()
    assert.equal(
      await calendarTab.getAttribute("data-state"),
      "active",
      "Returning to Mison restores the calendar tab",
    )
    assert.equal(
      await retainedMount.evaluate(
        (node) => node === document.querySelector('[data-plugin-root="mison-booking"]'),
      ),
      true,
      "Returning to Mison reuses its existing mount and selection",
    )
    for (const element of [retainedPage, retainedOverlay]) {
      assert.deepEqual(
        await element.evaluate((node) => ({ hidden: node.hidden, inert: node.inert })),
        { hidden: false, inert: false },
      )
    }
    assert.ok(
      Math.abs(
        (await page.locator(".mison-teacher-scroll").evaluate((element) => element.scrollTop)) -
          galleryTop,
      ) < 2,
      "Returning to Mison restores its scroll position",
    )
    await page.getByRole("tab", { name: "教师与约课", exact: true }).click()
    await page.getByRole("region", { name: "约课区" }).waitFor()
    assert.equal(await page.locator('[role="dialog"]:visible').count(), 0)
    await screenshot("retained-plugin-restored")
    checks.push(
      "navigation retains hidden/inert plugin, releases focus and scroll locks, and restores the same instance",
    )
  }
  for (const [width, height] of [
    [1180, 820],
    [820, 1180],
  ]) {
    await page.setViewportSize({ width, height })
    await page.locator('[data-view="calendar"]').click()
    const month = page.locator("#monthCalendar")
    await month.waitFor()
    await scrolls(month, `month calendar ${width}`)
    await page.locator('[data-mode="week"]').click()
    const week = page.locator(".week-wrap")
    await week.waitFor()
    await scrolls(week, `week calendar ${width}`)
    await page.locator("#newTaskBtn").click()
    const task = page.locator("#taskDialog")
    await task.waitFor()
    await page.locator("#taskTitle").fill("触控滚动验收")
    await page.locator("#taskRepeat").click()
    await page.locator('[aria-controls="taskNotePanel"]').click()
    await page.locator("#taskStart").click()
    const time = page.getByRole("dialog", { name: "选择时间", exact: true })
    const hours = time.getByRole("spinbutton", { name: "小时", exact: true })
    const before = await hours.getAttribute("aria-valuenow")
    await gesture(hours)
    await page.waitForFunction(
      (before) =>
        document
          .querySelector('[role="spinbutton"][aria-label="小时"]')
          ?.getAttribute("aria-valuenow") !== before,
      before,
    )
    await time.getByRole("button", { name: "完成", exact: true }).click()
    await time.waitFor({ state: "hidden" })
    const body = task.locator(".ui-modal-body")
    const dimensions = await body.evaluate((element) => ({
      total: element.scrollHeight,
      height: element.clientHeight,
    }))
    if (dimensions.total > dimensions.height + 70) {
      const footer = await task.locator(".ui-modal-footer").boundingBox()
      await scrolls(body, `task form ${width}`)
      assert.ok(Math.abs((await task.locator(".ui-modal-footer").boundingBox()).y - footer.y) < 1)
    }
    await task.getByRole("button", { name: "取消", exact: true }).click()
    await task.waitFor({ state: "hidden" })
    assert.equal(await page.locator("#taskTitle").count(), 0)
    await page.locator('[data-mode="month"]').click()
    await screenshot(`calendar-${width}`)
  }
  checks.push(
    "PDF complete-file download, rotation, last page, lazy canvas release, invalid-file retry, nested overlay cleanup and navigation unlock",
  )
  await page.emulateMedia({ media: "print" })
  assert.notEqual(
    await page.evaluate(() => getComputedStyle(document.body).position),
    "fixed",
    "Screen scroll lock never clips printed pages",
  )
  await page.emulateMedia({ media: "screen" })
  fs.writeFileSync(
    path.join(out, "ipad-touch.json"),
    JSON.stringify(
      {
        passed: true,
        engine,
        nativeTouch: !!cdp,
        checks,
        physicalIPadPWA:
          "Requires physical device acceptance; WebKit wheel input is not a finger gesture.",
      },
      null,
      2,
    ),
  )
}
module.exports = { exerciseMisonTouch, pdfFixture }
