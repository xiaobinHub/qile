/* Actual parent app + its plugin loader + built Mison entry. HTTP fixtures only; no separate frontend. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { chromium, webkit } = require("playwright")
const AxeBuilder = require("@axe-core/playwright").default
const root = path.resolve(__dirname, "../..")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mison-frontend-"))
async function main() {
  const touchAcceptance = process.env.IPAD_TOUCH_ACCEPTANCE === "1"
  const calendarAcceptance = process.env.CALENDAR_ACCEPTANCE === "1"
  const calendarFixture = calendarAcceptance
    ? require("./mison_calendar_acceptance.cjs").createCalendarFixture()
    : null
  const availabilityAcceptance = process.env.AVAILABILITY_ACCEPTANCE === "1"
  const installedBuild = process.env.PARENT_ACCEPTANCE_ORIGIN
  const engine = process.env.TOUCH_BROWSER === "webkit" ? webkit : chromium
  const { createServer } = await import("vite")
  const development = process.env.PLUGIN_DEV_ACCEPTANCE === "1"
  const session = "acceptance-dev-session"
  const base = `/__plugin-dev/mison-booking/${session}/`
  const sourceServer = development
    ? await (
        await import("../../scripts/plugin_dev.mjs")
      ).createPluginDevServer("mison-booking", session, {
        ws: { host: "127.0.0.1", clientPort: 18896 },
      })
    : null
  const server = await createServer({
    configFile: path.join(root, "frontend/parent/vite.config.mts"),
    cacheDir: path.join(out, "vite-cache"),
    plugins: [
      {
        name: "mison-test-media",
        configureServer(server) {
          // Chromium's native download bypasses Playwright request routing.
          // Serve the synthetic PDF over HTTP, including its attachment headers.
          server.middlewares.use((request, response, next) => {
            const url = new URL(request.url, "http://fixture.local")
            if (
              !(touchAcceptance || calendarAcceptance) ||
              url.pathname !== "/api/children/a/plugins/mison-booking/media/fixture-pdf"
            )
              return next()
            assert.ok(["GET", "HEAD"].includes(request.method), "Fixture PDF is read-only")
            const data = require("./ipad_touch_acceptance.cjs").pdfFixture()
            const filename = url.searchParams.get("filename")
            response.writeHead(200, {
              "Content-Type": "application/pdf",
              "Content-Length": String(data.length),
              "Content-Disposition": filename
                ? `attachment; filename="courseware.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`
                : "inline; filename=courseware.pdf",
            })
            response.end(request.method === "HEAD" ? undefined : data)
          })
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: development ? 18896 : 0,
      strictPort: true,
      open: false,
      proxy: {
        ...(sourceServer
          ? {
              [base]: {
                target: `http://127.0.0.1:${sourceServer.httpServer.address().port}`,
                ws: true,
              },
            }
          : {}),
        ...(installedBuild
          ? {
              // Keep media on the fixture origin while reading the actual installed
              // host assets. Never proxy API or plugin business requests upstream.
              "^/(?!api(?:/|$)|plugin-assets(?:/|$)|__plugin-dev(?:/|$))": {
                target: installedBuild,
                changeOrigin: true,
              },
            }
          : {}),
      },
    },
  })
  let browser
  const ts = require("typescript")
  const Module = require("node:module")
  const fixturePath = path.join(root, "tests/fixtures/mison/frontend-data.ts")
  const fixtureModule = new Module(fixturePath, module)
  fixtureModule._compile(
    ts.transpileModule(fs.readFileSync(fixturePath, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    fixturePath,
  )
  const fixture = fixtureModule.exports.createFixtureContext()
  const fixtureApi = fixture.api
  let slowSearch = false,
    failBooking = false,
    bootstrapFailure = false,
    bookingCalls = 0,
    misonLoggedIn = false,
    loginCalls = 0
  let scheduleMode = "normal"
  let avatarFailures = 2
  let paginationProbe = false,
    paginationCalls = 0
  let lastBookingOperationId = null,
    restoredPending = null
  let dropSyncResponse = false
  const syncRequests = []
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "plugins/mison-booking/plugin.json")),
  ).version
  const build = path.join(root, "output/plugin-releases/mison-booking", version, "build")
  const releaseId = "fixture-release-" + version
  const plugin = {
    id: "mison-booking",
    name: "美森约课",
    description: "",
    instructions: "",
    icon: "",
    type: "page",
    publicationStatus: "published",
    scopeMode: "all",
    childIds: [],
    version,
    releaseId,
    operationState: "ready",
    revision: 1,
    sortOrder: 1,
    installed: true,
    enabled: true,
    effectiveEnabled: true,
    requiresReenable: false,
    configRequired: false,
    configRevision: 1,
    reason: null,
    configSchema: { type: "object", properties: {} },
  }
  const child = { id: "a", name: "乐乐", role: "owner", archived: false, membershipVersion: "1" }
  const coreData = {
    format: "lele-task-manager-store",
    version: 1,
    revision: 1,
    updatedAt: null,
    context: { childId: "a", membershipVersion: "1" },
    data: {
      schemaVersion: 2,
      settings: { childName: "乐乐", weekStartsOn: 1 },
      categories: touchAcceptance
        ? Array.from({ length: 40 }, (_, i) => ({
            id: `touch-category-${i}`,
            name: `触控测试类型 ${i + 1}`,
            color: "#facc15",
            active: true,
          }))
        : [],
      series: [],
      exceptions: [],
      completions: [],
      ledger: [],
      gifts: [],
      taskPresets: [],
      operationLog: [],
    },
  }
  const errors = [],
    requests = [],
    knownWarnings = []
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    const entryUrl = `${origin}${installedBuild ? "/" : "/parent-assets/"}`
    browser = await engine.launch({ headless: true })
    const browserContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: "zh-CN",
      ...(touchAcceptance ? { hasTouch: true, isMobile: engine.name() !== "webkit" } : {}),
    })
    // HTTP custom domains do not expose randomUUID; exercise all plugin writes.
    await browserContext.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, "randomUUID", {
        value: undefined,
        configurable: true,
      })
    })
    const apiRoute = async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        json = (value) => route.fulfill({ json: value })
      if ((touchAcceptance || calendarAcceptance) && url.pathname.endsWith("/media/fixture-pdf")) {
        return route.continue()
      }
      if (url.pathname.endsWith("/media/fixture-video")) {
        const data = fs.readFileSync(path.join(root, "tests/fixtures/mison/teacher-intro.mp4"))
        const range = req.headers().range?.match(/^bytes=(\d+)-(\d*)$/)
        const start = range ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
        return route.fulfill({
          status: range ? 206 : 200,
          contentType: "video/mp4",
          headers: {
            "Accept-Ranges": "bytes",
            ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {}),
          },
          body: data.subarray(start, end + 1),
        })
      }
      if (url.pathname === "/api/auth/me")
        return json({
          user: { id: "test-parent", nickname: "测试家长", loginName: "test-parent" },
          csrfToken: "fixture-csrf",
        })
      if (url.pathname === "/api/children") return json({ children: [child] })
      if (url.pathname === "/api/children/a/data") return json(coreData)
      if (url.pathname === "/api/children/a/context") return json({ child, revision: 1 })
      if (/\/plugins(?:\/status)?$/.test(url.pathname)) return json({ plugins: [plugin] })
      if (url.pathname.endsWith("/entry"))
        return json({
          entry: development
            ? base + "@plugin-entry"
            : `/plugin-assets/mison-booking/${version}/frontend/entry.js`,
          ...(development
            ? { development: { sessionId: session, revision: 1, base, backend: false } }
            : {}),
          styles: development ? [] : [`/plugin-assets/mison-booking/${version}/frontend/style.css`],
          version,
          releaseId,
        })
      const prefix = "/api/children/a/plugins/mison-booking/runtime/"
      if (url.pathname.startsWith(prefix)) {
        assert.equal(req.headers()["x-plugin-release"], releaseId)
        assert.equal(req.headers()["x-plugin-frontend-api"], "1.1")
        if (development) {
          assert.equal(req.headers()["x-plugin-dev-session"], session)
          assert.equal(req.headers()["x-plugin-dev-revision"], "1")
        }
        const relative = url.pathname.slice(prefix.length) + url.search
        if (bootstrapFailure && relative === "bootstrap")
          return json({
            ok: false,
            error: { code: "UPSTREAM_UNAVAILABLE", message: "真实接口读取失败" },
          })
        if (slowSearch && relative.includes("nickname=Lewis"))
          await new Promise((r) => setTimeout(r, 600))
        const options = {
          method: req.method(),
          body: req.method() === "GET" ? undefined : req.postDataJSON(),
        }
        if (calendarFixture && /^bookings\/[^/]+\/resources$/.test(relative)) {
          assert.equal(options.method, "GET")
          return json(await calendarFixture.resources(relative))
        }
        if (calendarFixture && relative.startsWith("bookings/pages?"))
          return json(await calendarFixture.handle(relative))
        if (options.body?.operationId)
          assert.match(
            options.body.operationId,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          )
        if (relative === "connection/login") {
          loginCalls++
          assert.equal(options.method, "POST")
          assert.equal(typeof options.body.operationId, "string")
          await new Promise((r) => setTimeout(r, 120))
          if (options.body.password === "invalid-pass")
            return json({
              ok: false,
              error: { code: "UPSTREAM_REJECTED", message: "用户名或密码错误" },
            })
          if (options.body.password === "timeout-pass")
            return json({
              ok: false,
              error: {
                code: "RESULT_UNCERTAIN",
                operationId: options.body.operationId,
                message: "登录结果待确认",
              },
            })
          misonLoggedIn = true
          const bootstrap = await fixtureApi("bootstrap")
          return json({ ...bootstrap, data: bootstrap.data.connection })
        }
        if (relative === "connection" && options.method === "DELETE") {
          misonLoggedIn = false
          return json({
            ok: true,
            data: {
              status: "unbound",
              bindingRevision: 0,
              maskedAccount: null,
              contract: null,
              canManageConnection: true,
              lastCheckedAt: null,
            },
          })
        }
        const scheduleRequest = /^teachers\/[^/]+\/schedule(?:\?|$)/.test(relative)
        const scheduleRequestMode = scheduleMode
        if (scheduleRequest && scheduleRequestMode !== "normal") {
          const delay =
            scheduleRequestMode === "race"
              ? relative.startsWith("teachers/demo-1/")
                ? 800
                : 180
              : 500
          await new Promise((resolve) => setTimeout(resolve, delay))
          if (scheduleRequestMode === "failure")
            return json({
              ok: false,
              error: { code: "UPSTREAM_UNAVAILABLE", message: "模拟时段查询失败" },
            })
        }
        const response = await fixtureApi(relative, options)
        if (scheduleRequest && availabilityAcceptance) {
          const data = response.data
          if (scheduleRequestMode === "no-availability") {
            data.days.forEach((day) => {
              day.available = false
            })
            data.slots.forEach((slot) => {
              slot.state = "occupied"
            })
          } else if (
            scheduleRequestMode === "unavailable-first-date" &&
            !new URL(relative, "https://fixture.invalid/").searchParams.has("date")
          ) {
            data.date = "2026-11-05"
            data.slots.forEach((slot) => {
              slot.state = "occupied"
            })
          }
          data.slots.find((slot) => slot.start === "19:30").state = "unscheduled"
        }
        if (scheduleRequest && scheduleRequestMode === "race") {
          response.data.slots.find((slot) => slot.start === "10:00").state = relative.startsWith(
            "teachers/demo-1/",
          )
            ? "occupied"
            : "available"
        }
        if (touchAcceptance) {
          const name = relative.split("?")[0]
          if (name === "bookings/pages" && req.method() === "GET") {
            const items = response.data.items || []
            const status = new URLSearchParams(relative.split("?")[1] || "").get("status")
            const count = items.length ? 60 : 0
            response.data.items = Array.from({ length: count }, (_, index) => {
              const offset = status === "upcoming" ? index : 400 - index
              const day = 1 + Math.floor(offset / 2)
              const month = 9 + Math.floor((day - 1) / 28)
              const dayOfMonth = ((day - 1) % 28) + 1
              return {
                ...items[index % items.length],
                key: `touch-booking-${status}-${index}`,
                startsAt: `2026-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}T${index % 2 ? "10:30" : "10:00"}:00+08:00`,
              }
            })
            response.data.complete = true
          } else if (name === "teachers" || (name === "bookings" && req.method() === "GET")) {
            const items = response.data.items
            const count = !items.length
              ? 0
              : name === "teachers" &&
                  new URLSearchParams(relative.split("?")[1]).get("nickname") === "Jenyy"
                ? 1
                : 60
            response.data.items = Array.from({ length: count }, (_, i) => ({
              ...items[i % items.length],
              ...(name === "teachers"
                ? { id: i < items.length ? items[i].id : `touch-teacher-${i}`, avatarUrl: null }
                : { key: `touch-booking-${i}` }),
            }))
            response.data.total = count
          }
          if (name.endsWith("/resources"))
            response.data.items = [
              {
                id: "touch-pdf",
                title: "触控课件",
                action: "inline",
                url: "/api/children/a/plugins/mison-booking/media/fixture-pdf",
                mimeType: "application/pdf",
              },
            ]
          if (name === "courseware/categories")
            response.data.nodes.push(
              ...Array.from({ length: 40 }, (_, i) => ({
                id: `touch-category-${i}`,
                name: `课件分类 ${i + 1}`,
                children: [],
              })),
            )
        }
        if (paginationProbe && relative.split("?")[0] === "teachers") {
          paginationCalls++
          const cursor = new URLSearchParams(relative.split("?")[1]).get("cursor")
          const all = response.data.items
          response.data = {
            ...response.data,
            items: cursor ? all.slice(3) : all.slice(0, 3),
            nextCursor: cursor ? null : "fixture-auto-page-2",
            total: cursor ? all.length : null,
          }
          if (cursor) paginationProbe = false
        }

        if (relative.startsWith("resources/images/")) {
          if (avatarFailures > 0) {
            avatarFailures--
            return json({
              ok: false,
              error: { code: "RESOURCE_UNAVAILABLE", message: "模拟临时头像失败" },
            })
          }

          const original = response.data.dataUrl.split(",")[1]
          const encoded = Buffer.concat([
            Buffer.from(original, "base64"),
            Buffer.alloc(1500000),
          ]).toString("base64")
          const chunkIndex = Number(new URLSearchParams(relative.split("?")[1]).get("chunk") || "0")
          const size = 384 * 1024
          response.data = {
            chunk: encoded.slice(chunkIndex * size, (chunkIndex + 1) * size),
            chunkIndex,
            totalChunks: Math.ceil(encoded.length / size),
            mimeType: "image/png",
          }
        }
        if (relative === "bootstrap" && misonLoggedIn && restoredPending)
          response.data.unresolvedOperations = [
            {
              operationId: restoredPending,
              kind: "book",
              state: "uncertain",
              stageVersion: 1,
              message: "上次预约待核对",
              result: null,
            },
          ]
        if (restoredPending && relative === `operations/${restoredPending}`) restoredPending = null
        if (relative === "bootstrap" && !misonLoggedIn)
          response.data.connection = {
            ...response.data.connection,
            status: "unbound",
            bindingRevision: 0,
            maskedAccount: null,
            contract: null,
          }
        if (relative === "bookings" && options.method === "POST") {
          lastBookingOperationId = options.body.operationId
          bookingCalls++
          if (failBooking)
            return json({
              ok: false,
              error: {
                code: "RESULT_UNCERTAIN",
                operationId: options.body.operationId,
                message: "模拟预约已接受但响应结果不明",
              },
            })
        }
        if (relative === "course-sync" && options.method === "POST") {
          syncRequests.push(structuredClone(options.body))
          if (dropSyncResponse) {
            dropSyncResponse = false
            return json({
              ok: false,
              error: { code: "UPSTREAM_UNAVAILABLE", message: "Committed fixture response lost" },
            })
          }
        }
        return json(response)
      }
      assert.equal(req.method(), "GET", "test must not mutate parent application")
      return json({ avatars: [], members: [], invitations: [] })
    }
    await browserContext.route("**/api/**", apiRoute)
    await browserContext.route("**/plugin-assets/mison-booking/**", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/frontend/")[1]
      assert.ok(name && !name.includes("..") && /\.(js|css)$/.test(name))
      return route.fulfill({
        path: path.join(build, "frontend", name),
        contentType: name.endsWith(".css") ? "text/css" : "application/javascript",
      })
    })
    const page = await browserContext.newPage()
    page.setDefaultTimeout(20000)
    page.on("pageerror", (e) => errors.push(e.message))
    page.on("console", (msg) => {
      if (msg.type() !== "error") return
      // Radix Switch's hidden input dispatches a click in a passive effect;
      // an open Popover handles it with flushSync. Record this pre-existing
      // development warning separately from page exceptions/application errors.
      if (
        touchAcceptance &&
        msg.text().startsWith("flushSync was called from inside a lifecycle method.")
      )
        knownWarnings.push(msg.text())
      else errors.push(msg.text())
    })
    page.on("request", (req) => requests.push(req.url()))
    const ready = () =>
      page.getByRole("heading", { name: `可约老师 · ${touchAcceptance ? 60 : 6}` }).waitFor()
    const count = (n) =>
      page.waitForFunction((n) => document.querySelectorAll(".mison-teacher-card").length === n, n)
    const slot = (time) => page.getByRole("button", { name: time, exact: true })
    const screenshot = (name) =>
      page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
    const viewportPanel = async () => {
      await page.waitForFunction(() => {
        const panel = document.querySelector(".mison-booking")
        if (!panel) return false
        const gutter = parseFloat(getComputedStyle(document.querySelector("#main")).paddingBottom)
        return Math.abs(panel.getBoundingClientRect().bottom + gutter - innerHeight) < 2
      })
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
        "plugin content stays inside the browser viewport",
      )
      return page.locator(".mison-booking").boundingBox()
    }
    const hostStyle = () =>
      page.locator('[data-view="settings"]').evaluate((el) => {
        const style = getComputedStyle(el)
        return Object.fromEntries(
          [
            "color",
            "backgroundColor",
            "fontFamily",
            "fontSize",
            "lineHeight",
            "padding",
            "borderRadius",
            "boxShadow",
            "height",
          ].map((key) => [key, style[key]]),
        )
      })
    await page.goto(entryUrl)
    await page.locator('[data-view="settings"]').waitFor()
    await page.locator('[data-view="calendar"]').click()
    await page.locator(".calendar-panel").waitFor()
    const calendarBottomGap = await page
      .locator(".calendar-panel")
      .evaluate((element) => innerHeight - element.getBoundingClientRect().bottom)
    const originalHostStyle = await hostStyle()
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await page
      .getByRole("heading", { name: "请登录美森网课账号" })
      .waitFor()
      .catch(async (error) => {
        console.error(
          JSON.stringify(
            { errors, body: (await page.locator("body").innerText()).slice(0, 2000) },
            null,
            2,
          ),
        )
        throw error
      })
    assert.equal(await page.locator(".mison-header").count(), 0)
    assert.equal(await page.getByRole("button", { name: "我的预约" }).count(), 0)
    assert.equal(await page.locator(".mison-teacher-card").count(), 0)
    const loginForm = page.getByRole("form", { name: "美森账号登录" })
    if (development) {
      const appFile = path.join(root, "plugins/mison-booking/frontend/app.tsx")
      const cssFile = path.join(root, "plugins/mison-booking/frontend/style.css")
      const appBefore = fs.readFileSync(appFile, "utf8"),
        cssBefore = fs.readFileSync(cssFile, "utf8")
      await loginForm.getByLabel("账号", { exact: true }).fill("hmr-state-check")
      try {
        fs.writeFileSync(appFile, appBefore.replace("请登录美森网课账号", "热更新验收标题"))
        await page.getByRole("heading", { name: "热更新验收标题" }).waitFor()
        assert.equal(
          await loginForm.getByLabel("账号", { exact: true }).inputValue(),
          "hmr-state-check",
        )
        fs.writeFileSync(cssFile, cssBefore + "\n.mison-booking { --development-check: 17; }\n")
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector(".mison-booking"))
              .getPropertyValue("--development-check")
              .trim() === "17",
        )
        assert.deepEqual(await hostStyle(), originalHostStyle)
        assert.equal(loginCalls, 0)
        assert.equal(bookingCalls, 0)
      } finally {
        fs.writeFileSync(appFile, appBefore)
        fs.writeFileSync(cssFile, cssBefore)
      }
      await page.getByRole("heading", { name: "请登录美森网课账号" }).waitFor()
    }
    const loginButtonTop = (
      await loginForm.getByRole("button", { name: "登录", exact: true }).boundingBox()
    ).y
    const headingSize = await page
      .locator("#mison-login-title")
      .evaluate((el) => getComputedStyle(el).fontSize)
    assert.equal(
      headingSize,
      await page
        .locator("#mison-login-title")
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--text-page").trim().endsWith("rem")
            ? `${parseFloat(getComputedStyle(el).getPropertyValue("--text-page")) * parseFloat(getComputedStyle(document.documentElement).fontSize)}px`
            : getComputedStyle(el).getPropertyValue("--text-page").trim(),
        ),
    )
    await screenshot("00-login")
    await loginForm.getByLabel("账号", { exact: true }).fill("ui-test")
    await loginForm.getByLabel("密码", { exact: true }).fill("invalid-pass")
    await loginForm.getByRole("button", { name: "登录", exact: true }).click()
    await page.getByText("用户名或密码错误", { exact: true }).waitFor()
    assert.equal(
      (await loginForm.getByRole("button", { name: "登录", exact: true }).boundingBox()).y,
      loginButtonTop,
      "login button must stay fixed when error appears",
    )
    const loginError = loginForm.getByRole("alert")
    assert.equal(await loginError.evaluate((el) => getComputedStyle(el).whiteSpace), "nowrap")
    assert.equal(
      await loginError.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    )
    assert.equal(await loginForm.getByLabel("密码", { exact: true }).inputValue(), "invalid-pass")
    await loginForm.getByRole("button", { name: "显示密码", exact: true }).click()
    assert.equal(await loginForm.getByLabel("密码", { exact: true }).getAttribute("type"), "text")
    assert.equal(await loginForm.getByLabel("密码", { exact: true }).inputValue(), "invalid-pass")
    assert.equal(loginCalls, 1, "visibility toggle must not submit login")
    await loginForm.getByRole("button", { name: "隐藏密码", exact: true }).click()
    assert.equal(
      await loginForm.getByLabel("密码", { exact: true }).getAttribute("type"),
      "password",
    )
    assert.equal(await loginForm.getByLabel("账号", { exact: true }).inputValue(), "ui-test")
    assert.equal(await page.locator(".mison-header").count(), 0)
    await screenshot("00-login-error")
    const loginAxe = await new AxeBuilder({ page })
      .include(".mison-login")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
    assert.deepEqual(
      loginAxe.violations.map((v) => v.id),
      [],
    )
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    await screenshot("00-login-mobile")
    await page.setViewportSize({ width: 1440, height: 1000 })
    await loginForm.getByLabel("密码", { exact: true }).fill("valid-pass")
    await loginForm.getByRole("button", { name: "登录", exact: true }).dblclick()
    await ready()
    assert.equal(loginCalls, 2, "double click sends one request")
    if (calendarAcceptance) {
      await require("./mison_calendar_acceptance.cjs")
        .exerciseCalendar({
          page,
          out,
          fixture: calendarFixture,
        })
        .catch(async (error) => {
          await page.screenshot({ path: path.join(out, "calendar-failure.png") })
          console.error(
            JSON.stringify(
              {
                evidence: out,
                errors,
                body: (await page.locator("body").innerText()).slice(-1600),
                calls: calendarFixture.calls.slice(-8),
              },
              null,
              2,
            ),
          )
          throw error
        })
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          {
            passed: true,
            engine: engine.name(),
            evidence: out,
            pageErrors: errors,
            calendarRequests: calendarFixture.calls.length,
          },
          null,
          2,
        ),
      )
      return
    }
    if (availabilityAcceptance) {
      await require("./mison_availability_acceptance.cjs")({
        page,
        out,
        engine: engine.name(),
        setMode: (value) => {
          scheduleMode = value
        },
      })
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          { passed: true, engine: engine.name(), evidence: out, pageErrors: errors },
          null,
          2,
        ),
      )
      return
    }
    if (process.env.SCHEDULE_TRANSITION_ACCEPTANCE === "1") {
      await page.locator('[data-book-teacher="demo-0"]').click()
      await slot("10:00").waitFor()
      await require("./mison_schedule_transition.cjs")({
        page,
        stage: page.getByRole("region", { name: "约课区" }),
        out,
        setMode: (value) => {
          scheduleMode = value
        },
      })
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          { passed: true, engine: engine.name(), evidence: out, pageErrors: errors },
          null,
          2,
        ),
      )
      return
    }
    if (touchAcceptance) {
      await require("./ipad_touch_acceptance.cjs")
        .exerciseMisonTouch({
          page,
          browserContext,
          origin,
          entryUrl,
          out,
          engine: engine.name(),
        })
        .catch(async (error) => {
          await page.screenshot({ path: path.join(out, "touch-failure.png") })
          console.error({
            evidence: out,
            errors,
            body: (await page.locator("body").innerText()).slice(-600),
          })
          throw error
        })
      await require("./task_keyboard_acceptance.cjs").exerciseTaskKeyboard({
        browser: {
          newContext: async (options) => {
            const context = await browser.newContext(options)
            return {
              route: context.route.bind(context),
              close: context.close.bind(context),
              newPage: async () => {
                const target = await context.newPage()
                // Page routes take priority over the keyboard helper's context
                // routes: all GETs stay in fixtures, all writes stay rejected.
                await target.route("**/api/**", (route) =>
                  route.request().method() === "GET"
                    ? apiRoute(route)
                    : route.fulfill({ status: 503, json: { error: "隔离键盘验收禁止写入。" } }),
                )
                return target
              },
            }
          },
        },
        dad: page,
        origin: installedBuild ? origin : `${origin}/parent-assets`,
        firstId: "a",
        out,
        axe: async (target) => {
          const result = await new AxeBuilder({ page: target })
            .include("#taskDialog")
            .withTags(["wcag2a", "wcag2aa"])
            .analyze()
          assert.deepEqual(
            result.violations.map((item) => item.id),
            [],
          )
        },
        stage: console.log,
      })
      assert.deepEqual(errors, [])
      console.log(
        JSON.stringify(
          {
            passed: true,
            engine: engine.name(),
            evidence: out,
            pageErrors: errors,
            knownRadixDevelopmentWarnings: knownWarnings,
          },
          null,
          2,
        ),
      )
      return
    }
    assert.equal(await page.locator(".mison-header").count(), 1)
    await page.waitForTimeout(500)
    assert.equal(avatarFailures, 0, "read-only avatar uses one bounded retry")
    assert.equal(await page.locator(".mison-teacher-card .mison-avatar img").count(), 0)
    await page
      .locator(".mison-teacher-card")
      .first()
      .getByRole("button", { name: /^查看.*档案$/ })
      .first()
      .click()
    await page.getByRole("dialog", { name: "教师档案" }).locator(".mison-avatar img").waitFor()
    await page.locator(".mison-teacher-card .mison-avatar img").first().waitFor()
    await page.keyboard.press("Escape")
    await page.locator(".mison-teacher-card .mison-avatar img").first().waitFor()
    assert.equal(
      await page.locator('.mison-teacher-card [data-slot="card-description"]').count(),
      0,
    )
    assert.ok(
      (await page.locator(".mison-teacher-card .mison-avatar").first().boundingBox()).width >= 80,
    )
    assert.equal(await page.locator(".mison-connection").count(), 0)
    await page.getByRole("button", { name: "账号设置", exact: true }).waitFor()
    const favoriteStar = page
      .locator('.mison-teacher-card .mison-star[aria-pressed="true"]')
      .first()
    if (await favoriteStar.count()) {
      assert.equal(await favoriteStar.evaluate((el) => getComputedStyle(el).opacity), "1")
      assert.equal(await favoriteStar.locator("svg").getAttribute("fill"), "currentColor")
    }

    await page.waitForFunction(() => {
      const image = document.querySelector(".mison-teacher-card .mison-avatar img")
      return image?.complete && image.naturalWidth > 0
    })
    await page.goto(entryUrl)
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await ready()
    assert.equal(loginCalls, 2, "refresh reuses saved session")
    assert.equal(await page.title(), "成长计划")
    assert.equal(await page.locator(".plugin-page-heading").count(), 0)
    assert.equal(await page.getByRole("button", { name: "应用设置", exact: true }).count(), 0)
    assert.equal(await page.locator(".mison-stage").count(), 0, "entry must be full-width gallery")
    const galleryPanel = await viewportPanel()
    assert.ok(
      Math.abs(1000 - galleryPanel.y - galleryPanel.height - calendarBottomGap) < 2,
      "plugin bottom spacing matches the calendar",
    )
    assert.equal(await page.locator(".vite-error-overlay").count(), 0)
    assert.deepEqual(
      await hostStyle(),
      originalHostStyle,
      "plugin CSS must not restyle host navigation",
    )
    assert.equal(await page.locator('.mison-teacher-card[data-slot="card"]').count(), 6)
    assert.equal(
      await page.getByRole("switch", { name: "仅看收藏" }).getAttribute("data-slot"),
      "switch",
    )
    assert.equal(
      await page.locator(".mison-ui dialog, .mison-ui details, .mison-ui select").count(),
      0,
    )
    assert.ok(
      (await page
        .locator(".mison-teacher-grid")
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)) >= 4,
    )
    assert.ok(
      (await page
        .locator(".mison-teacher-card .mison-teacher-copy .mison-next-available")
        .count()) === 6,
    )
    const cardStar = page.locator(".mison-teacher-card").first().locator(".mison-star")
    assert.equal(await page.locator("[data-book-teacher] svg").count(), 0)
    const avatarTrigger = page.locator(".mison-avatar-trigger").first()
    await avatarTrigger.hover()
    assert.equal(
      await avatarTrigger.evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    )
    const favoriteRefresh = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith("/runtime/teachers"),
    )
    await cardStar.click()
    await favoriteRefresh
    await page.waitForFunction(
      () =>
        document.querySelector(".mison-teacher-card .mison-star")?.getAttribute("aria-pressed") ===
        "false",
    )
    const unfavoriteRefresh = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith("/runtime/teachers"),
    )
    await cardStar.click()
    await unfavoriteRefresh
    await page.waitForFunction(
      () =>
        document.querySelector(".mison-teacher-card .mison-star")?.getAttribute("aria-pressed") ===
        "true",
    )
    paginationProbe = true
    await page.getByRole("button", { name: "搜索", exact: true }).click()
    await page
      .locator(".mison-load-more")
      .scrollIntoViewIfNeeded()
      .catch(() => undefined)
    await count(6)
    assert.equal(paginationCalls, 2, "sentinel loads the next page once without a manual button")
    assert.equal(await page.getByRole("button", { name: "加载更多老师", exact: true }).count(), 0)
    await page.getByRole("button", { name: /^标签/ }).click()
    const labelPanel = page.getByRole("dialog", { name: "筛选教师标签" })
    await labelPanel.getByRole("checkbox").first().check()
    await labelPanel.getByRole("button", { name: "清空", exact: true }).click()
    assert.equal(await labelPanel.getByRole("checkbox", { checked: true }).count(), 0)
    await labelPanel.getByRole("button", { name: "完成", exact: true }).click()
    await count(6)
    await screenshot("01-gallery")
    await page.getByRole("button", { name: "筛选日期", exact: true }).click()
    await page.locator(".shared-calendar").waitFor()
    await page
      .locator(".shared-calendar")
      .getByRole("button", { name: /年.*月.*日/ })
      .first()
      .click()
    await page.waitForFunction(() => !document.querySelector(".shared-calendar"))
    assert.ok(
      requests.some(
        (url) => /runtime\/teachers\?/.test(url) && new URL(url).searchParams.has("date"),
      ),
    )
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    await page.getByRole("button", { name: "筛选时段", exact: true }).click()
    const timePanel = page.getByRole("dialog", { name: "选择上课时段" })
    await timePanel.getByRole("button", { name: "09:00", exact: true }).click()
    await timePanel.getByRole("button", { name: "09:30", exact: true }).click()
    const selectedColor = await timePanel
      .getByRole("button", { name: "09:00", exact: true })
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    const primaryColor = await page
      .getByRole("button", { name: "完成", exact: true })
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    assert.equal(selectedColor, primaryColor, "selected time uses the primary yellow")

    assert.equal(
      await timePanel
        .getByRole("button", { name: "09:00", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    )
    assert.equal(
      await timePanel
        .getByRole("button", { name: "09:30", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    )
    await timePanel.getByRole("button", { name: "完成", exact: true }).click()
    assert.ok(requests.some((url) => new URL(url).searchParams.get("times") === "09:00,09:30"))
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    await page.getByRole("searchbox", { name: "搜索老师姓名" }).fill("Lewis")
    await page.getByRole("button", { name: "搜索", exact: true }).click()
    await count(1)
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    await count(6)
    await page.getByRole("switch", { name: "仅看收藏" }).check()
    await count(2)
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    assert.equal(await page.getByRole("switch", { name: "仅看收藏" }).isChecked(), true)
    await page.getByRole("switch", { name: "仅看收藏" }).uncheck()
    await count(6)
    // Slow old search must not overwrite a newer result.
    slowSearch = true
    await page.getByRole("searchbox").fill("Lewis")
    await page.getByRole("button", { name: "搜索", exact: true }).click()
    await page.getByRole("searchbox").fill("Rina")
    await page.getByRole("button", { name: "搜索", exact: true }).click()
    await count(1)
    await page.waitForTimeout(850)
    assert.match(await page.locator(".mison-teacher-card").innerText(), /Rina/)
    await page.getByRole("button", { name: "清空筛选", exact: true }).click()
    await count(6)
    await page.locator('[data-book-teacher="demo-0"]').click()
    await slot("10:00").waitFor()
    const stage = page.getByRole("region", { name: "约课区" })
    assert.ok(Math.abs((await viewportPanel()).height - galleryPanel.height) < 2)
    const slotGrid = stage.locator(".mison-slots")
    assert.ok(
      (await slotGrid.evaluate(
        (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
      )) > 6,
      "compact slots fit more columns on desktop",
    )
    assert.ok((await slot("10:00").boundingBox()).width <= 128)
    assert.equal(await page.getByText("当前老师", { exact: true }).count(), 0)
    assert.equal(await stage.locator(".mison-steps").count(), 0)
    assert.equal(await stage.locator(".mison-stage-header .mison-star").count(), 0)
    assert.equal(await stage.getByRole("button", { name: "查看档案", exact: true }).count(), 0)
    assert.equal(await stage.getByText("点击时段逐档选择", { exact: true }).count(), 0)
    assert.notEqual(
      await page
        .locator('.mison-teacher-card[data-selected="true"]')
        .evaluate((el) => getComputedStyle(el).boxShadow),
      "none",
    )
    const dateOptions = stage.locator(".mison-date-option")
    await dateOptions.first().waitFor({ timeout: 5000 })
    assert.ok((await dateOptions.count()) > 7, "compact dates show more days at desktop width")
    assert.ok((await dateOptions.first().boundingBox()).height <= 60)
    assert.equal(await stage.getByText("北京时间", { exact: true }).count(), 0)
    const sidebar = page.locator(".mison-teachers.is-sidebar")
    assert.equal(await sidebar.locator(".mison-card-footer").count(), 0)
    assert.equal(await sidebar.getByRole("button", { name: "查看档期", exact: true }).count(), 0)
    assert.ok((await sidebar.locator(".mison-teacher-card").first().boundingBox()).height < 125)
    assert.ok(
      Math.abs(
        (await sidebar.locator(".mison-teacher-scroll").boundingBox()).y +
          (await sidebar.locator(".mison-teacher-scroll").boundingBox()).height -
          ((await stage.boundingBox()).y + (await stage.boundingBox()).height),
      ) < 2,
    )
    const stageHeightBeforeLongList = (await stage.boundingBox()).height
    const sidebarHeightBeforeLongList = (await sidebar.boundingBox()).height
    await sidebar.locator(".mison-teacher-grid").evaluate((grid) => {
      const sample = grid.firstElementChild
      for (let i = 0; i < 40; i++) {
        const clone = sample.cloneNode(true)
        clone.setAttribute("data-height-probe", "true")
        clone.setAttribute("aria-hidden", "true")
        grid.append(clone)
      }
    })
    assert.ok(
      Math.abs((await stage.boundingBox()).height - stageHeightBeforeLongList) < 2,
      "long teacher list cannot stretch schedule height",
    )
    assert.ok(
      Math.abs((await sidebar.boundingBox()).height - sidebarHeightBeforeLongList) < 2,
      "sidebar height independent of teacher count",
    )
    const sidebarViewport = sidebar.locator(".mison-teacher-scroll")
    assert.equal(await sidebarViewport.evaluate((el) => el.scrollHeight > el.clientHeight), true)
    const pageScrollBefore = await page.evaluate(() => scrollY)
    await sidebarViewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    assert.ok((await sidebarViewport.evaluate((el) => el.scrollTop)) > 0)
    assert.equal(await page.evaluate(() => scrollY), pageScrollBefore)
    await sidebar
      .locator(".mison-teacher-grid")
      .evaluate((grid) => grid.querySelectorAll("[data-height-probe]").forEach((el) => el.remove()))
    await sidebarViewport.evaluate((el) => {
      el.scrollTop = 0
    })
    const firstDateWidth = (await dateOptions.first().boundingBox()).width
    await stage.getByRole("button", { name: "下一组日期", exact: true }).click()
    assert.equal(
      (await dateOptions.first().boundingBox()).width,
      firstDateWidth,
      "partial final page keeps date width",
    )
    await stage.getByRole("button", { name: "上一组日期", exact: true }).click()

    const availableOnly = stage.getByRole("switch", { name: "只看可约日期/时段" })
    assert.equal(await availableOnly.isChecked(), true)
    await availableOnly.uncheck()
    const allDateCount = await dateOptions.count()
    await availableOnly.check()
    assert.equal(await stage.locator('.mison-date-option[data-unavailable="true"]').count(), 0)
    assert.ok(
      (await dateOptions.count()) < allDateCount ||
        (await stage.getByRole("button", { name: "下一组日期" }).isEnabled()),
    )
    await availableOnly.uncheck()
    await require("./mison_schedule_transition.cjs")({
      page,
      stage,
      out,
      setMode: (value) => {
        scheduleMode = value
      },
    })
    const unchangedStageHeight = (await stage.boundingBox()).height
    const unchangedSidebarHeight = (await sidebar.boundingBox()).height
    const teacherReadsBeforeDate = requests.filter((url) =>
      /runtime\/teachers(?:\?|$)/.test(new URL(url).pathname + new URL(url).search),
    ).length
    await page.evaluate(() => {
      window.__scheduleHeaderNode = document.querySelector(".mison-stage-header")
    })
    scheduleMode = "slow"
    await stage.getByRole("radio", { name: "11月3日 周二", exact: true }).click()
    await stage.getByText("正在加载时段…", { exact: true }).waitFor()
    assert.ok(Math.abs((await stage.boundingBox()).height - unchangedStageHeight) < 1)
    assert.ok(Math.abs((await sidebar.boundingBox()).height - unchangedSidebarHeight) < 1)
    assert.equal(await slot("10:00").isDisabled(), true)
    assert.equal(await dateOptions.count(), allDateCount)
    await stage.getByText("正在加载时段…", { exact: true }).waitFor({ state: "hidden" })
    assert.ok(Math.abs((await stage.boundingBox()).height - unchangedStageHeight) < 1)
    assert.equal(
      await page.evaluate(
        () => window.__scheduleHeaderNode === document.querySelector(".mison-stage-header"),
      ),
      true,
    )
    assert.equal(
      requests.filter((url) =>
        /runtime\/teachers(?:\?|$)/.test(new URL(url).pathname + new URL(url).search),
      ).length,
      teacherReadsBeforeDate,
    )
    scheduleMode = "failure"
    await stage.getByRole("radio", { name: "11月4日 周三", exact: true }).click()
    await stage.getByText("模拟时段查询失败", { exact: true }).waitFor()
    assert.ok(Math.abs((await stage.boundingBox()).height - unchangedStageHeight) < 1)
    assert.equal(await slot("10:00").isDisabled(), true)
    assert.equal(await stage.getByRole("button", { name: "下一步：确认课件" }).isDisabled(), true)
    scheduleMode = "normal"
    await stage.getByRole("button", { name: "重试", exact: true }).click()
    await stage.getByText("模拟时段查询失败", { exact: true }).waitFor({ state: "hidden" })
    await stage.getByText("正在加载时段…", { exact: true }).waitFor({ state: "hidden" })
    assert.ok(Math.abs((await stage.boundingBox()).height - unchangedStageHeight) < 1)

    const unavailableDate = stage.locator('.mison-date-option[data-unavailable="true"]').first()
    assert.equal(await unavailableDate.isDisabled(), true)
    assert.equal(await stage.getByText("暂无档期", { exact: true }).count(), 0)
    const unavailableColor = await slot("09:00").evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    )
    assert.notEqual(
      unavailableColor,
      await slot("10:00").evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    await slot("10:00").click()
    assert.equal(await slot("10:00").locator("svg").count(), 0)
    assert.notEqual(
      await slot("10:00").evaluate((el) => getComputedStyle(el).backgroundColor),
      unavailableColor,
    )

    assert.equal(await stage.locator(".mison-legend").count(), 0)
    const heightBeforeSlotWarning = (await stage.boundingBox()).height
    await slot("11:00").click()
    const slotWarning = page.getByRole("alertdialog", { name: "时段选择提示" })
    await slotWarning.waitFor()
    assert.equal(
      await slotWarning.getByText("不能选择不连续的时段，请调整。", { exact: true }).count(),
      1,
    )
    assert.equal((await page.locator(".mison-stage").boundingBox()).height, heightBeforeSlotWarning)
    assert.equal(await page.locator('.mison-stage [role="alert"]').count(), 0)
    await screenshot("02-slot-warning")
    assert.equal(
      await page.locator(".mison-stage-footer button").last().isDisabled(),
      true,
      "gapped slots rejected",
    )
    await slotWarning.getByRole("button", { name: "确定", exact: true }).click()
    await slotWarning.waitFor({ state: "hidden" })
    assert.equal(await slot("11:00").getAttribute("aria-pressed"), "false")
    assert.equal(await slot("10:00").getAttribute("aria-pressed"), "true")
    assert.equal((await stage.boundingBox()).height, heightBeforeSlotWarning)
    await slot("10:30").click()
    await screenshot("02-expanded")
    await page.getByRole("button", { name: "收起约课区" }).click()
    assert.equal(await page.locator(".mison-stage").count(), 0)
    await page.locator('[data-book-teacher="demo-0"]').click()
    assert.equal(
      await slot("10:00").getAttribute("aria-pressed"),
      "true",
      "collapse preserves slots",
    )
    await page.locator('[data-book-teacher="demo-2"]').click()
    await page.getByRole("alertdialog", { name: "切换预约对象" }).waitFor()
    assert.equal(
      await page.getByRole("alertdialog").getAttribute("data-slot"),
      "alert-dialog-content",
    )
    await page.getByRole("button", { name: "保留当前选择" }).click()
    assert.match(await page.locator(".mison-stage-header h2").innerText(), /Jenyy/)
    await page.getByRole("button", { name: "下一步：确认课件" }).click()
    await page.getByRole("button", { name: "确认预约", exact: true }).waitFor()
    assert.ok(Math.abs((await viewportPanel()).height - galleryPanel.height) < 2)
    for (const height of [720, 890, 1000]) {
      await page.setViewportSize({ width: 1440, height })
      await viewportPanel()
      const footer = await page.locator(".mison-stage-footer").boundingBox()
      assert.ok(footer.y + footer.height <= height, "booking actions stay visible after resize")
    }
    const confirmPanel = await viewportPanel()
    assert.ok(Math.abs(confirmPanel.height - galleryPanel.height) < 2)
    await stage.getByRole("button", { name: /^查看.*档案$/ }).click()
    const selectedTeacherProfile = page.getByRole("dialog", { name: "教师档案" })
    await selectedTeacherProfile.waitFor()
    assert.match(
      await selectedTeacherProfile.locator(".mison-profile-heading").innerText(),
      /Jenyy/,
    )
    await page.keyboard.press("Escape")
    await selectedTeacherProfile.waitFor({ state: "hidden" })
    assert.equal(await stage.locator(".mison-course-row").count(), 2)
    assert.equal(
      await page.getByRole("button", { name: "确认预约", exact: true }).isEnabled(),
      true,
    )
    await screenshot("03-confirm")
    await page.getByRole("button", { name: "更换课件", exact: true }).first().click()
    await page
      .getByRole("radiogroup", { name: "选择课件", exact: true })
      .getByRole("radio")
      .nth(3)
      .waitFor()
    assert.equal(await page.getByRole("button", { name: "加载更多课件" }).count(), 0)
    await page.getByRole("radio", { name: "待补学内容" }).click()
    assert.equal(await page.getByText("美森返回的待补学内容").count(), 0)
    await page.getByRole("radio", { name: "按分类选择" }).click()
    await page
      .getByRole("radiogroup", { name: "选择课件", exact: true })
      .getByRole("radio")
      .nth(3)
      .waitFor()
    assert.equal(
      await page
        .getByRole("radiogroup", { name: "选择课件", exact: true })
        .getByRole("radio")
        .nth(3)
        .getAttribute("data-slot"),
      "radio-group-item",
    )
    assert.equal(
      await page
        .getByRole("radiogroup", { name: "选择课件", exact: true })
        .getByRole("radio")
        .nth(1)
        .isDisabled(),
      true,
      "other slot's course disabled",
    )
    await page
      .getByRole("radiogroup", { name: "选择课件", exact: true })
      .getByRole("radio")
      .nth(3)
      .check()
    await page.getByRole("button", { name: "使用此课件" }).click()
    await page.getByRole("dialog", { name: "更换课件" }).waitFor({ state: "hidden" })
    assert.equal(
      await page
        .getByRole("button", { name: "更换课件", exact: true })
        .first()
        .evaluate((el) => el === document.activeElement),
      true,
      "dialog restores opener focus",
    )
    assert.equal(await page.getByText(/今日剩余预览/).count(), 0)
    assert.equal(
      await page.getByRole("button", { name: "预览", exact: true }).first().isEnabled(),
      true,
      "zero upstream quota does not block direct preview",
    )
    await page.getByRole("button", { name: "预览", exact: true }).first().click()
    await page.getByRole("dialog", { name: "课件预览" }).waitFor()
    await page.keyboard.press("Escape")
    // An upstream acceptance followed by dropped response must not cause a second POST.
    failBooking = true
    await page.getByRole("button", { name: "确认预约", exact: true }).click()
    await page.getByRole("button", { name: "核对预约结果" }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "确认预约", exact: true }).isDisabled(),
      true,
    )
    assert.equal(await page.getByRole("button", { name: "收起约课区" }).isDisabled(), true)
    await page.getByRole("button", { name: "核对预约结果" }).click()
    await page.getByRole("heading", { name: "预约成功" }).waitFor()
    assert.ok(Math.abs((await viewportPanel()).height - galleryPanel.height) < 2)
    assert.equal(bookingCalls, 1)
    await page.getByRole("button", { name: "查看我的预约" }).click()
    await page.locator(".mison-booking-card").first().waitFor()
    const bookingsSheet = page.getByRole("dialog", { name: "我的预约" })
    assert.equal(await bookingsSheet.getByText("关闭后保留当前约课选择").count(), 0)
    assert.equal(await bookingsSheet.getByRole("button", { name: "继续约课" }).count(), 0)
    assert.equal(await bookingsSheet.getByRole("button", { name: "去上课" }).count(), 0)
    assert.equal(await bookingsSheet.locator(".mison-booking-date").count(), 0)
    await bookingsSheet
      .getByText(/11月4日/)
      .first()
      .waitFor()
    const bookingActions = bookingsSheet.locator(".mison-booking-toolbar .mison-actions button")
    assert.equal(await bookingActions.nth(0).getAttribute("aria-label"), "预约日期筛选")
    assert.equal(await bookingActions.nth(1).getAttribute("aria-label"), "刷新预约")
    const bookingTabs = await bookingsSheet.getByRole("tablist", { name: "预约状态" }).boundingBox()
    await bookingsSheet.locator(".mison-booking-list").evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const bookingTabsAfter = await bookingsSheet
      .getByRole("tablist", { name: "预约状态" })
      .boundingBox()
    assert.ok(
      Math.abs(bookingTabsAfter.y - bookingTabs.y) < 1,
      "booking tabs stay fixed while the list scrolls",
    )
    assert.equal(await bookingsSheet.getAttribute("data-slot"), "sheet-content")
    await bookingsSheet.getByRole("button", { name: "预约日期筛选" }).click()
    await page.locator(".shared-calendar").waitFor()
    await page
      .locator(".shared-calendar")
      .getByRole("button", { name: /年.*月.*日/ })
      .first()
      .click()
    await page.waitForFunction(() => !document.querySelector(".shared-calendar"))
    assert.equal(await bookingsSheet.isVisible(), true, "nested calendar leaves sheet open")
    assert.equal(
      await bookingsSheet
        .getByRole("button", { name: "预约日期筛选" })
        .evaluate((el) => el === document.activeElement),
      true,
    )
    await bookingsSheet.getByRole("button", { name: "预约日期筛选" }).click()
    await page.locator('.shared-calendar [aria-selected="true"] button').click()
    await page.waitForFunction(() => !document.querySelector(".shared-calendar"))
    await screenshot("04-bookings")
    const axe = await new AxeBuilder({ page })
      .include('.mison-overlay[data-state="open"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
    assert.deepEqual(
      axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.length })),
      [],
    )
    await page.getByRole("tab", { name: "已上课" }).click()
    const completedCard = bookingsSheet.locator(".mison-booking-card").filter({ hasText: "已上课" })
    await completedCard.waitFor()
    assert.equal(await completedCard.getByRole("button", { name: "课程资料" }).count(), 1)
    assert.equal(await bookingsSheet.getByRole("button", { name: "观看课程" }).count(), 0)
    assert.equal(await bookingsSheet.getByRole("button", { name: "课后作业" }).count(), 0)
    assert.equal(await bookingsSheet.getByRole("button", { name: "取消预约" }).count(), 0)
    assert.equal(await bookingsSheet.getByRole("button", { name: "去上课" }).count(), 0)
    await page.keyboard.press("Escape")
    if (await page.locator(".mison-stage").count())
      await page.getByRole("button", { name: "收起约课区", exact: true }).click()

    await page
      .locator(".mison-teacher-card")
      .first()
      .getByRole("button", { name: /^查看.*档案$/ })
      .first()
      .click()
    const profileDialog = page.getByRole("dialog", { name: "教师档案" })
    await profileDialog.waitFor()
    assert.equal(await profileDialog.getAttribute("data-slot"), "sheet-content")
    if (development) {
      const uiFile = path.join(root, "plugins/mison-booking/frontend/ui.tsx")
      const before = fs.readFileSync(uiFile, "utf8")
      try {
        const updated = page.waitForResponse((r) => r.url().includes("/frontend/ui.tsx?t="))
        fs.writeFileSync(
          uiFile,
          before.replace(
            "export function Overlay(",
            "/* overlay HMR regression */\nexport function Overlay(",
          ),
        )
        await updated
        await page.waitForTimeout(500)
        if (!(await profileDialog.count()))
          await page
            .locator(".mison-teacher-card")
            .first()
            .getByRole("button", { name: /^查看.*档案$/ })
            .first()
            .click()
        await profileDialog.waitFor()
        assert.equal(await profileDialog.evaluate((el) => !!el.closest(".mison-ui")), true)
        assert.equal(
          await profileDialog
            .locator(".mison-overlay-header")
            .evaluate((el) => getComputedStyle(el).display),
          "flex",
        )
        assert.equal((await profileDialog.locator(".mison-avatar").boundingBox()).width, 80)
      } finally {
        fs.writeFileSync(uiFile, before)
      }
    }

    assert.equal(await profileDialog.getByRole("button", { name: "复制老师信息" }).count(), 0)
    assert.equal(await profileDialog.locator(".mison-profile-heading small").count(), 0)
    const profileStar = profileDialog.locator(".mison-profile-favorite")
    assert.ok((await profileStar.boundingBox()).width >= 48)
    await profileStar.click()
    await page.waitForFunction(
      () =>
        document.querySelector(".mison-profile-favorite")?.getAttribute("aria-pressed") === "false",
    )
    assert.equal(
      await page.locator(".mison-teacher-card .mison-star").first().getAttribute("aria-pressed"),
      "false",
    )
    await profileStar.click()
    await page.waitForFunction(
      () =>
        document.querySelector(".mison-profile-favorite")?.getAttribute("aria-pressed") === "true",
    )
    const mediaBox = profileDialog.locator(".mison-intro-media")
    const reserved = await mediaBox.boundingBox()
    assert.ok(Math.abs(reserved.width / reserved.height - 16 / 9) < 0.02)
    const video = profileDialog.locator("video")
    await video.waitFor()
    await video.evaluate((el) => el.play())
    await page.waitForFunction(
      () => document.querySelector(".mison-profile-section video")?.currentTime > 0.1,
    )
    await video.evaluate((el) => {
      el.currentTime = 1.5
    })
    await page.waitForFunction(() => {
      const el = document.querySelector(".mison-profile-section video")
      return el && !el.seeking && el.currentTime >= 1.5
    })
    await video.evaluate((el) => el.pause())
    assert.ok(
      Math.abs((await mediaBox.boundingBox()).height - reserved.height) < 1,
      "video metadata/playback never changes reserved height",
    )

    await page.keyboard.press("Tab")
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector('.mison-overlay[data-state="open"]')
          .contains(document.activeElement),
      ),
      true,
    )
    await screenshot("05-profile")
    await page.keyboard.press("Escape")
    assert.equal(await page.locator('.mison-overlay[data-state="open"]').count(), 0)
    for (const width of [1280, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await viewportPanel()
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `overflow at ${width}`,
      )
      await screenshot(`responsive-${width}`)
    }
    await page.getByRole("button", { name: "账号设置", exact: true }).click()
    const accountDialog = page.getByRole("dialog", { name: "美森约课设置" })
    assert.equal(await accountDialog.getByText(/家人共享使用/).count(), 0)
    assert.equal(
      await accountDialog.getByRole("button", { name: "更换账号 / 重新登录" }).count(),
      0,
    )
    assert.ok(
      (await accountDialog.getByRole("button", { name: "退出美森登录", exact: true }).boundingBox())
        .width <
        (await accountDialog.boundingBox()).width / 2,
    )
    await require("./mison_sync_settings_acceptance.cjs").exerciseSyncSettings({
      page,
      dialog: accountDialog,
      api: fixtureApi,
      requests: syncRequests,
      out,
      dropNext: () => {
        dropSyncResponse = true
      },
    })
    await page.getByRole("button", { name: "退出美森登录", exact: true }).click()
    await page.getByRole("heading", { name: "请登录美森网课账号" }).waitFor()
    await loginForm.getByLabel("账号", { exact: true }).fill("ui-test")
    await loginForm.getByLabel("密码", { exact: true }).fill("timeout-pass")
    await loginForm.getByRole("button", { name: "登录", exact: true }).click()
    await page.getByText("登录结果待确认", { exact: true }).waitFor()
    assert.equal(
      await loginForm.getByRole("button", { name: "登录", exact: true }).isDisabled(),
      true,
    )
    await page.getByRole("button", { name: "核对登录状态" }).click()
    await page.getByText("尚未登录成功。确认后可重新尝试登录。", { exact: true }).waitFor()
    assert.equal(loginCalls, 3, "checking session never resends password")
    await page.getByRole("button", { name: "重新尝试登录" }).click()
    await loginForm.getByLabel("密码", { exact: true }).fill("valid-pass")
    await loginForm.getByRole("button", { name: "登录", exact: true }).click()
    await ready()
    assert.equal(loginCalls, 4)
    restoredPending = lastBookingOperationId
    await page.goto(entryUrl)
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await ready()
    await page.getByRole("button", { name: "核对上次操作", exact: true }).click()
    await page.getByRole("dialog", { name: "我的预约" }).waitFor()
    assert.equal(bookingCalls, 1, "restoring an operation only reads its receipt")
    await page.evaluate(() => document.querySelector('[data-view="settings"]').click())
    await page.waitForFunction(
      () =>
        document.querySelector(".plugin-page")?.hasAttribute("hidden") &&
        document.querySelector(".plugin-overlay")?.hasAttribute("hidden"),
    )
    assert.equal(
      await page
        .locator(
          ".plugin-overlay:not([hidden]) [data-slot='sheet-overlay'], .plugin-overlay:not([hidden]) [data-slot='dialog-overlay']",
        )
        .count(),
      0,
    )
    await page.waitForFunction(
      () =>
        getComputedStyle(document.body).pointerEvents !== "none" &&
        !document.body.hasAttribute("data-scroll-locked"),
    )
    const stored = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))
    assert.equal(/valid-pass|timeout-pass|invalid-pass/.test(stored), false)
    // Reload the real parent route with a failed plugin API: never show fake connected data.
    bootstrapFailure = true
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(entryUrl)
    await page.locator('[data-view="plugin:mison-booking"]').click()
    await page.getByText("暂时无法连接美森约课", { exact: true }).waitFor()
    assert.equal(await page.locator(".mison-teacher-card").count(), 0)
    assert.equal(await page.locator(".plugin-page-heading").count(), 0)
    assert.equal(
      requests.some((url) => /mison\.cn/.test(url)),
      false,
      "no real Mison traffic",
    )
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify(
        {
          passed: true,
          evidence: out,
          checks: [
            ...(development
              ? [
                  "source component and CSS hot updates",
                  "HMR preserves input without login or booking",
                  "development session headers",
                ]
              : []),
            "inline login hides unbound header",
            "bad password reason and retained password",
            "password visibility toggle without submission",
            "lazy avatar through authenticated plugin JSON API",
            "login single submit and refresh without reauth",
            "uncertain login checks without resend",
            "login axe and mobile layout",
            "logout returns to login",
            "sync settings: exact uncertain retry, authoritative reread, revision conflict and explicit resave",
            "full-width entry",
            "shared calendar date picker",
            "multi-select time panel and CSV API query",
            "inline video playback and seeking",
            "profile duration and copy action removed",
            "search/favorites",
            "stale response",
            "expand/collapse and draft retention",
            "teacher switch confirmation",
            "teacher switch skeleton, stable geometry and scroll, failure retry, stale responses",
            "contiguous slots",
            "courseware selection and preview",
            "write timeout no resend",
            "reload restores unresolved booking without another POST",
            "bookings tabs",
            "shared shadcn primitives and scoped host styles",
            "nested calendar in sheet and restored opener focus",
            "plugin disposal removes portals and scroll lock",
            "profile and keyboard focus",
            "axe drawer",
            "1440/1280/1024/820/390 responsive",
            "real parent loader and release fence",
            "plugin shell title and settings shortcut removed",
            "plugin API errors never mocked",
            "no Mison calls",
            "clean console",
          ],
        },
        null,
        2,
      ),
    )
  } finally {
    await browser?.close()
    await server.close()
    await sourceServer?.close()
  }
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
