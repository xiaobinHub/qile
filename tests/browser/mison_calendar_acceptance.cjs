const assert = require("node:assert/strict")
const path = require("node:path")
const AxeBuilder = require("@axe-core/playwright").default

exports.createCalendarFixture = function () {
  let mode = "normal"
  let resourceMode = "normal"
  const calls = []
  const resourceCalls = []
  const lesson = (key, date, time, status = "upcoming") => ({
    key,
    cid: key,
    teacher: {
      id: "calendar-teacher",
      name: "Jenyy",
      avatarUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    },
    courseware: {
      id: key,
      title:
        key === "calendar-0" ? "PU027 U3 Food shopping L7 故事与课堂练习" : `Power up 课程 ${key}`,
      categoryName: "英语",
    },
    status,
    startsAt: `${date}T${time}:00+08:00`,
    timeLabel: `${time}–${time.slice(0, 3)}${String(Number(time.slice(3)) + 25).padStart(2, "0")}`,
    snapshotVersion: "1",
    actions: {},
  })
  const records = Array.from({ length: 65 }, (_, i) =>
    lesson(
      `calendar-${i}`,
      `2026-11-${String(4 + (i % 23)).padStart(2, "0")}`,
      `${10 + Math.floor(i / 23)}:00`,
    ),
  )
  records.push(lesson("completed-same-day", "2026-11-04", "09:00", "completed"))
  records.push(lesson("completed-midnight", "2026-11-01", "00:15", "completed"))
  records.push(lesson("completed-previous-month", "2026-10-31", "23:30", "completed"))
  records.push(lesson("overlap", "2026-11-04", "10:10"))
  records.push(lesson("cancelled-hidden", "2026-11-04", "13:00", "cancelled"))
  return {
    calls,
    resourceCalls,
    setResourceMode(value) {
      resourceMode = value
    },
    async resources(relative) {
      const key = decodeURIComponent(relative.split("/")[1])
      const captured = resourceMode
      resourceCalls.push({ key, mode: captured })
      await new Promise((resolve) => setTimeout(resolve, captured === "slow" ? 800 : 180))
      const pdf = {
        id: key,
        title: `课程PDF-${key}`,
        action: "inline",
        mimeType: "application/pdf",
        url: "/api/children/a/plugins/mison-booking/media/fixture-pdf",
        instructions: null,
        reason: null,
      }
      if (captured === "failure")
        return {
          ok: false,
          error: { code: "UPSTREAM_UNAVAILABLE", message: "模拟课程PDF读取失败" },
        }
      const items =
        captured === "empty"
          ? []
          : captured === "multiple"
            ? [pdf, { ...pdf, id: key + "-extra", title: "补充课程PDF" }]
            : captured === "instructions"
              ? [
                  {
                    id: "instructions",
                    title: "课程资料",
                    action: "instructions",
                    mimeType: null,
                    url: null,
                    instructions: "该课程暂无可在PC预览的学生PDF。",
                    reason: null,
                  },
                ]
              : [pdf]
      return { ok: true, data: { items } }
    },
    setMode(value) {
      mode = value
    },
    async handle(relative) {
      const query = new URL(relative, "http://fixture").searchParams
      const status = query.get("status")
      const page = Number(query.get("page") || "1")
      assert.ok(page >= 1)
      const captured = mode
      calls.push({ status, page, mode: captured })
      if (captured === "stale") await new Promise((resolve) => setTimeout(resolve, 700))
      if (captured === "failure" && status === "completed")
        return {
          ok: false,
          error: { code: "UPSTREAM_UNAVAILABLE", message: "模拟历史课程读取失败" },
        }
      if (captured === "stalled") {
        const newer = lesson("stall-new", "2026-11-20", "19:00", status)
        const older = lesson("stall-old", "2026-11-10", "19:00", status)
        return {
          ok: true,
          data: {
            status,
            page,
            pageSize: 100,
            complete: false,
            items: status === "upcoming" ? [newer, older] : [older, newer],
          },
        }
      }
      const items =
        captured === "empty"
          ? []
          : records
              .filter((item) => item.status === status)
              .sort((left, right) =>
                status === "upcoming"
                  ? left.startsAt.localeCompare(right.startsAt)
                  : right.startsAt.localeCompare(left.startsAt),
              )
              .map((item) =>
                captured === "stale"
                  ? { ...item, courseware: { ...item.courseware, title: "过期响应" } }
                  : item,
              )
      return {
        ok: true,
        data: {
          status,
          page,
          pageSize: 100,
          complete: true,
          items,
        },
      }
    },
  }
}

exports.exerciseCalendar = async function ({ page, out, fixture }) {
  const tabs = page.getByRole("tablist", { name: "美森约课功能" })
  const calendar = page.getByRole("region", { name: "课程日历", exact: true })
  const ready = async () => {
    await page.locator('.mison-course-calendar[aria-busy="false"]').waitFor()
  }
  const screenshot = (name) =>
    page.screenshot({ path: path.join(out, name + ".png"), fullPage: false })
  const frame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
  await page.locator('[data-book-teacher="demo-0"]').click()
  const stage = page.getByRole("region", { name: "约课区" })
  await stage.getByRole("button", { name: "10:00", exact: true }).click()
  await tabs.getByRole("tab", { name: "课程日历", exact: true }).click()
  await calendar.waitFor()
  await ready()
  assert.equal(
    await calendar.locator('.mison-calendar-lesson[data-status="upcoming"]').count(),
    66,
    "reads all ready pages after building",
  )
  assert.equal(await calendar.locator('.mison-calendar-lesson[data-status="completed"]').count(), 3)
  assert.equal(await calendar.locator('[data-booking-key="cancelled-hidden"]').count(), 0)
  assert.equal(
    await calendar
      .locator('[data-cell-day="2026-11-01"] [data-booking-key="completed-midnight"]')
      .count(),
    1,
    "uses business date rather than UTC date",
  )
  const mixed = calendar.locator('[data-cell-day="2026-11-04"]')
  assert.equal(await mixed.locator('[data-status="completed"]').count(), 1)
  assert.ok((await mixed.locator('[data-status="upcoming"]').count()) > 0)
  assert.notEqual(
    await mixed
      .locator('[data-status="completed"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    await mixed
      .locator('[data-status="upcoming"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  )
  assert.deepEqual(
    fixture.calls.map((call) => `${call.status}:${call.page}`).sort(),
    ["completed:1", "upcoming:1"],
    "calendar loads one page of each visible status",
  )
  const sharedCalls = fixture.calls.length
  await page.getByRole("button", { name: /我的预约/ }).click()
  const sharedDrawer = page.getByRole("dialog", { name: "我的预约", exact: true })
  await sharedDrawer.locator(".mison-booking-card").first().waitFor()
  await sharedDrawer.getByRole("button", { name: "关闭我的预约", exact: true }).click()
  await sharedDrawer.waitFor({ state: "hidden" })
  assert.equal(fixture.calls.length, sharedCalls, "the bookings drawer reuses the calendar pages")
  await mixed.locator('[data-booking-key="calendar-0"]').scrollIntoViewIfNeeded()
  await mixed.locator('[data-booking-key="calendar-0"] img').waitFor()
  await screenshot("calendar-month-desktop")
  const completed = mixed.locator('[data-booking-key="completed-same-day"]')
  const upcoming = mixed.locator('[data-booking-key="calendar-0"]')
  const scrollBeforePdf = await calendar
    .locator(".mison-calendar-month-scroll")
    .evaluate((el) => el.scrollTop)
  await completed.click()
  const completedPdf = page.getByRole("dialog", { name: "课程PDF-completed-same-day", exact: true })
  await completedPdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
  assert.equal(fixture.resourceCalls.at(-1).key, "completed-same-day")
  await screenshot("calendar-completed-pdf")
  await completedPdf
    .getByRole("button", { name: "关闭课程PDF-completed-same-day", exact: true })
    .click()
  assert.equal(await completed.evaluate((el) => el === document.activeElement), true)
  assert.ok(
    Math.abs(
      (await calendar.locator(".mison-calendar-month-scroll").evaluate((el) => el.scrollTop)) -
        scrollBeforePdf,
    ) < 3,
  )
  await upcoming.focus()
  await page.keyboard.press("Enter")
  const upcomingPdf = page.getByRole("dialog", { name: "课程PDF-calendar-0", exact: true })
  await upcomingPdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
  await upcomingPdf.getByRole("button", { name: "关闭课程PDF-calendar-0", exact: true }).click()
  fixture.setResourceMode("failure")
  await upcoming.click()
  await calendar.getByText(/模拟课程PDF读取失败/).waitFor()
  fixture.setResourceMode("normal")
  const beforeDouble = fixture.resourceCalls.length
  await upcoming.dblclick()
  await upcomingPdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
  assert.equal(
    fixture.resourceCalls.length - beforeDouble,
    1,
    "double click opens a single PDF request",
  )
  await upcomingPdf.getByRole("button", { name: "关闭课程PDF-calendar-0", exact: true }).click()
  fixture.setResourceMode("multiple")
  await upcoming.click()
  const choices = page.getByRole("dialog", { name: "选择课程PDF", exact: true })
  await choices.getByRole("button", { name: "补充课程PDF", exact: true }).click()
  const extraPdf = page.getByRole("dialog", { name: "补充课程PDF", exact: true })
  await extraPdf.locator('[data-pdf-page="1"][data-rendered="true"]').waitFor()
  await extraPdf.getByRole("button", { name: "关闭补充课程PDF", exact: true }).click()
  await choices.getByRole("button", { name: "关闭选择课程PDF", exact: true }).click()
  fixture.setResourceMode("instructions")
  await upcoming.click()
  const instructions = page.getByRole("dialog", { name: "课程资料", exact: true })
  await instructions.getByText("该课程暂无可在PC预览的学生PDF。", { exact: true }).waitFor()
  await instructions.getByRole("button", { name: "关闭课程资料", exact: true }).click()
  fixture.setResourceMode("empty")
  await upcoming.click()
  await calendar.getByText("该课程暂无可预览的PDF。", { exact: true }).waitFor()
  fixture.setResourceMode("slow")
  await upcoming.click()
  await tabs.getByRole("tab", { name: "教师与约课", exact: true }).click()
  await page.waitForTimeout(900)
  assert.equal(await page.getByRole("dialog").count(), 0, "tab switch discards late PDF response")
  fixture.setResourceMode("normal")
  await tabs.getByRole("tab", { name: "课程日历", exact: true }).click()
  await ready()
  const scroll = calendar.locator(".mison-calendar-month-scroll")
  const saved = await scroll.evaluate((el) => el.scrollTop)
  await tabs.getByRole("tab", { name: "教师与约课", exact: true }).click()
  assert.equal(
    await stage.getByRole("button", { name: "10:00", exact: true }).getAttribute("aria-pressed"),
    "true",
    "tab switching preserves selected lesson",
  )
  await tabs.getByRole("tab", { name: "课程日历", exact: true }).click()
  await ready()
  await frame()
  assert.ok(
    Math.abs((await scroll.evaluate((el) => el.scrollTop)) - saved) < 3,
    "month scroll retained",
  )

  await calendar.getByRole("button", { name: "今天", exact: true }).click()
  await calendar.getByRole("button", { name: "下个月", exact: true }).click()
  await ready()
  await calendar.getByRole("heading", { name: "2026年12月", exact: true }).waitFor()
  await calendar.getByRole("button", { name: "上个月", exact: true }).click()
  await ready()
  await calendar.getByRole("heading", { name: "2026年11月", exact: true }).waitFor()
  assert.equal(await calendar.getByRole("radiogroup").count(), 0)

  fixture.setMode("failure")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await calendar.getByText(/模拟历史课程读取失败/).waitFor()
  await ready()
  assert.ok(
    (await calendar.locator('[data-status="upcoming"].mison-calendar-lesson').count()) > 50,
    "one failed source does not discard the other",
  )
  assert.equal(await calendar.getByText(/暂无已上课或已预约/).count(), 0)
  fixture.setMode("normal")
  await calendar.getByRole("button", { name: "重试已上课课程", exact: true }).click()
  await ready()
  assert.equal(await calendar.locator('[data-status="completed"].mison-calendar-lesson').count(), 3)

  fixture.setMode("stale")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await calendar.getByText("过期响应", { exact: true }).first().waitFor()
  fixture.setMode("normal")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await ready()
  assert.equal(await calendar.getByText("过期响应", { exact: true }).count(), 0)
  await calendar.getByRole("button", { name: "今天", exact: true }).click()
  await ready()

  fixture.setMode("stalled")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await calendar
    .getByText(/美森课程顺序已改变/)
    .first()
    .waitFor()
  fixture.setMode("empty")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await calendar.getByText("本月暂无已上课或已预约的课程。", { exact: true }).waitFor()
  assert.equal(await calendar.locator(".mison-calendar-lesson").count(), 0)
  await screenshot("calendar-empty")
  fixture.setMode("normal")
  await calendar.getByRole("button", { name: "刷新课程", exact: true }).click()
  await ready()
  for (const viewport of [
    { width: 1180, height: 820 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await frame()
    await calendar.getByRole("heading", { name: "2026年11月", exact: true }).waitFor()
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth + 1 &&
          document.documentElement.scrollHeight <= innerHeight + 1,
      ),
      "viewport stays contained",
    )
    const header = await tabs.boundingBox()
    const panel = await calendar.boundingBox()
    assert.ok(header.x >= 0 && header.x + header.width <= viewport.width)
    assert.ok(panel.height > 200 && panel.y + panel.height <= viewport.height + 1)
    assert.ok(
      await calendar.locator("h2").evaluate((el) => el.clientHeight < 30),
      "month heading stays on one line",
    )
    if (viewport.width === 390)
      await calendar.locator(".mison-calendar-month-scroll").evaluate((el) => {
        el.scrollLeft = 130
      })
    await screenshot(`calendar-month-${viewport.width}`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  const axe = await new AxeBuilder({ page })
    .include(".mison-course-calendar")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze()
  assert.deepEqual(
    axe.violations.map((v) => v.id),
    [],
  )
}
