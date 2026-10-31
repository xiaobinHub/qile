/* Browser plugin not available. Real Playwright + dedicated DB/runtime, no external messages.
 * Run after host build: node tests/browser/demo_plugins_acceptance.cjs
 * Only demo-page/demo-service are packaged; original minimal fixtures are never invoked.
 */
const { chromium } = require("playwright")
const AxeBuilder = require("@axe-core/playwright").default
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const net = require("node:net")
const crypto = require("node:crypto")
const assert = require("node:assert/strict")
const root = path.resolve(__dirname, "../..")
const python = path.join(root, ".venv/bin/python")
const fixture = path.join(root, "data/testing/demo-plugins")
const out = "/tmp/lele-demo-plugin-qa"
const ports = { parent: 19087, admin: 19088 }
const origin = `http://127.0.0.1:${ports.parent}`
const ids = ["demo-page", "demo-service"]
const passwords = Object.fromEntries(
  ["initial", "admin", "dad", "mom"].map((key) => [
    key,
    "A7" + crypto.randomBytes(16).toString("hex"),
  ]),
)
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, "backend"),
  LELE_ACCOUNTS_CONFIG: path.join(fixture, "config.json"),
  LELE_PLUGIN_ROOT: path.join(fixture, "runtime"),
  LELE_PLUGIN_SOCKET_ROOT: "/tmp/lele-demo-plugins-" + process.pid,
}
const processes = [],
  checks = [],
  pageErrors = [],
  evidence = {},
  traffic = []
let browser,
  state,
  admin,
  dad,
  mom,
  locked = false,
  current = "setup"
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clean = (text) =>
  Object.values(passwords).reduce(
    (value, password) => value.split(password).join("[redacted]"),
    String(text),
  )
async function eventually(label, fn, timeout = 30000) {
  const deadline = Date.now() + timeout
  do {
    if (await fn()) return
    await wait(150)
  } while (Date.now() < deadline)
  throw Error("Timed out: " + label)
}
function runPython(args, input, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "",
      stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(Error("Python probe timed out: " + args.join(" ")))
    }, timeout)
    child.stdout.on("data", (data) => (stdout += data))
    child.stderr.on("data", (data) => (stderr += data))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(Error(clean(stderr || stdout || `Python exit ${code}`)))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(Error(clean("Invalid fixture JSON: " + stdout + stderr)))
      }
    })
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}
const probe = (...args) => runPython(["tests/fixtures/plugins/demo_probe.py", ...args])
const snapshot = () => probe("snapshot")
function start(surface) {
  const fd = fs.openSync(path.join(fixture, surface + ".log"), "w", 0o600)
  const args =
    surface === "runtime"
      ? ["deploy/plugin_runtime.py", "--config", env.LELE_ACCOUNTS_CONFIG]
      : [
          "-m",
          "uvicorn",
          "lele_growth.accounts_app:create_from_env",
          "--factory",
          "--host",
          "127.0.0.1",
          "--port",
          String(ports[surface]),
        ]
  const child = spawn(python, args, {
    cwd: root,
    env: { ...env, LELE_SURFACE: surface },
    stdio: ["ignore", fd, fd],
  })
  fs.closeSync(fd)
  child.on("error", (error) => pageErrors.push(surface + ": " + error.message))
  processes.push(child)
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => server.close(resolve))
  })
}
async function api(page, url, method = "GET", body, headers = {}) {
  return page.evaluate(
    async ({ url, method, body, headers }) => {
      const me = await (await fetch("/api/auth/me")).json()
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": me.csrfToken, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { ...(await response.json()), status: response.status }
    },
    { url, method, body, headers },
  )
}
function ok(result, label = "API") {
  assert.equal(result.status, 200, label + ": " + JSON.stringify(result))
  return result
}
const pluginPath = (id, child = state.childId) => `/api/children/${child}/plugins/${id}`
async function plugin(id, child = state.childId) {
  const installed = ok(await api(dad, `/api/children/${child}/plugins/status`)).plugins
  return (
    installed.find((p) => p.id === id) ||
    ok(await api(dad, `/api/children/${child}/plugins`)).plugins.find((p) => p.id === id)
  )
}
async function runtime(id, endpoint, method = "GET", body, options = {}) {
  const child = options.child || state.childId
  const release = options.release || (await plugin(id, child)).releaseId
  return api(options.actor || dad, `${pluginPath(id, child)}/runtime/${endpoint}`, method, body, {
    "X-Plugin-Release": release,
  })
}
async function action(id, command, child = state.childId) {
  const p = await plugin(id, child)
  return ok(
    await api(
      dad,
      pluginPath(id, child) + "/" + command,
      command === "installation" ? "DELETE" : "POST",
      {
        operationId: crypto.randomUUID(),
        expectedRevision: p.revision,
      },
    ),
  ).plugin
}
async function catalogAction(id, command, fields = {}) {
  const p = ok(await api(admin, "/api/admin/plugins")).plugins.find((p) => p.id === id)
  return ok(
    await api(admin, `/api/admin/plugins/${id}/${command}`, command === "scope" ? "PUT" : "POST", {
      ...fields,
      expectedRevision: p.revision,
    }),
  ).plugin
}
async function config(id, changes) {
  const before = ok(await api(dad, pluginPath(id) + "/config"))
  if (!changes) return before
  return ok(
    await api(dad, pluginPath(id) + "/config", "PUT", {
      config: { ...before.config, ...changes },
      expectedRevision: before.revision,
      operationId: crypto.randomUUID(),
    }),
  )
}
async function login(page, name, password, surface = "parent", child = state.childId) {
  await page.goto(
    `http://127.0.0.1:${ports[surface]}/${surface === "parent" ? "children/" + child : ""}`,
  )
  await page.locator("#loginName").fill(name)
  await page.locator("#loginPassword").fill(password)
  await page.locator('#loginForm button[type="submit"]').click()
  await page.locator(surface === "parent" ? ".topbar" : "#pluginsNav").waitFor()
}
async function applications(page) {
  await page.locator('[data-view="settings"]').click()
  await page.getByRole("button", { name: "应用管理", exact: true }).click()
  await page.locator("#pluginSearch").waitFor()
}
async function quickEditNotice() {
  await dad.locator("#quickEditBtn").click()
  await dad.locator('[data-view="settings"]').click()
  const dialog = dad.locator("#quickEditNoticeDialog")
  await dialog.waitFor()
  assert.equal(await dialog.locator('[data-slot="dialog-close"]').count(), 0)
  assert.equal(await dialog.getByRole("button", { name: "关闭", exact: true }).count(), 0)
  await dialog.getByRole("button", { name: "知道了", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
  await dad.getByRole("button", { name: "取消", exact: true }).click()
  await dad.locator("#quickEditBtn").waitFor()
}
async function focus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
}
async function mount(page = dad, childName = state.childName) {
  await page.locator('[data-view="plugin:demo-page"]').click()
  await page.getByRole("heading", { name: childName + "的页面能力 Demo", exact: true }).waitFor()
  await eventually("runtime snapshot rendered", async () => {
    const text = await page.locator("[data-info]").textContent()
    return text.startsWith("{") && JSON.parse(text).pluginId === "demo-page"
  })
  await page.locator("[data-save]:not([disabled])").waitFor()
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name + ".png"), fullPage: true })
}
async function scenario(name, fn) {
  current = name
  console.log("RUN  " + name)
  await fn()
  checks.push(name)
  console.log("PASS " + name)
}
async function rows(id = "demo-page", collection = "entries", child) {
  return ok(
    await runtime(id, `records/${collection}?limit=200`, "GET", undefined, child ? { child } : {}),
  ).records
}
async function record(id) {
  return ok(await runtime("demo-page", "records/entries/" + id)).record
}
async function put(id, payload, revision, actor = dad, operationId = crypto.randomUUID()) {
  return runtime(
    "demo-page",
    "records/entries/" + id,
    "PUT",
    { payload, expectedRevision: revision, operationId },
    { actor },
  )
}
async function createUI(text) {
  await dad.getByLabel("Demo 记录内容", { exact: true }).fill(text)
  await dad.getByLabel("Demo 记录分类", { exact: true }).selectOption("日常")
  await dad.getByLabel("Demo 记录分值", { exact: true }).fill("7")
  const request = dad.waitForRequest(
    (request) => request.method() === "PUT" && request.url().includes("/runtime/records/entries/"),
  )
  await dad.getByRole("button", { name: "保存记录", exact: true }).click()
  const sent = await request
  const id = new URL(sent.url()).pathname.split("/").pop()
  await eventually("UI record committed", async () => (await record(id))?.payload.text === text)
  await dad.locator("[data-save]:not([disabled])").waitFor()
  return id
}
async function configurationDefaults(id) {
  const loaded = await config(id)
  const schema = state.schemas[id]
  assert.deepEqual(loaded.schema, schema)
  assert.deepEqual(
    loaded.config,
    Object.fromEntries(
      Object.entries(schema.properties).map(([key, field]) => [key, field.default]),
    ),
  )
  await dad.locator(`[data-plugin-config="${id}"]`).click()
  const form = dad.locator("#pluginConfigForm")
  await form.locator(".plugin-config-fields").waitFor()
  for (const [key, field] of Object.entries(schema.properties)) {
    const control = form.getByLabel(field.title, { exact: false })
    if (field.type === "array") {
      for (const option of field.items.enum)
        assert.equal(
          await form
            .getByRole("group", { name: new RegExp("^" + field.title) })
            .getByRole("checkbox", { name: option, exact: true })
            .getAttribute("aria-checked"),
          String(field.default.includes(option)),
          key + ": " + option,
        )
    } else if (field.type === "boolean")
      assert.equal(await control.getAttribute("aria-checked"), String(field.default), key)
    else if (field.enum) assert.ok((await control.innerText()).includes(String(field.default)), key)
    else assert.equal(await control.inputValue(), String(field.default), key)
  }
  const numberKey = id === "demo-page" ? "pageSize" : "batchSize"
  const numberControl = form.getByLabel(schema.properties[numberKey].title, { exact: false })
  await numberControl.fill(String(schema.properties[numberKey].maximum + 1))
  await form.getByRole("button", { name: "保存配置", exact: true }).click()
  await form.locator('[aria-invalid="true"]').first().waitFor()
  assert.equal(
    (await config(id)).revision,
    loaded.revision,
    "client range validation does not save",
  )
  await numberControl.fill(String(schema.properties[numberKey].default))
  if (id === "demo-page") {
    const arrayGroup = form.getByRole("group", {
      name: new RegExp("^" + schema.properties.categories.title),
    })
    for (let i = 0; i < schema.properties.categories.items.enum.length; i++) {
      const checkbox = arrayGroup.getByRole("checkbox", {
        name: schema.properties.categories.items.enum[i],
        exact: true,
      })
      if ((await checkbox.getAttribute("aria-checked")) === "true") await checkbox.click()
    }
    await form.getByRole("button", { name: "保存配置", exact: true }).click()
    await form.locator('[aria-invalid="true"]').first().waitFor()
    assert.equal(
      (await config(id)).revision,
      loaded.revision,
      "client multiselect validation does not save",
    )
  }
  await screenshot(dad, id + "-configuration")
  await form.getByRole("button", { name: "关闭", exact: true }).click()
  for (const [key, field] of Object.entries(schema.properties)) {
    const invalid = []
    if (field.minimum !== undefined) invalid.push(field.minimum - 1)
    if (field.maximum !== undefined) invalid.push(field.maximum + 1)
    if (field.type === "integer") invalid.push(1.25)
    if (field.type === "array") {
      invalid.push(["未定义选项"], [field.items.enum[0], field.items.enum[0]])
      if (field.minItems) invalid.push([])
    }
    if (field.format) invalid.push("invalid-format")
    for (const value of invalid) {
      const rejected = await api(dad, pluginPath(id) + "/config", "PUT", {
        config: { ...loaded.config, [key]: value },
        expectedRevision: loaded.revision,
        operationId: crypto.randomUUID(),
      })
      assert.equal(rejected.status, 400, key + " rejects " + JSON.stringify(value))
      assert.equal(rejected.kind, "plugin_invalid_config")
    }
  }
  assert.deepEqual((await config(id)).config, loaded.config)
  assert.equal((await config(id)).revision, loaded.revision)
}
async function uncertainResponse(page, pattern, perform, retryName) {
  const requests = []
  let dropped = false
  const intercept = async (route) => {
    if (!["PUT", "POST"].includes(route.request().method())) return route.continue()
    requests.push({
      url: route.request().url(),
      method: route.request().method(),
      body: route.request().postDataJSON(),
    })
    if (!dropped) {
      dropped = true
      // Commit through the real gateway/worker first, then lose only its HTTP response.
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      await route.abort("failed")
    } else await route.continue()
  }
  await page.route(pattern, intercept)
  try {
    await perform()
    await page.getByRole("button", { name: retryName, exact: true }).waitFor()
    await page.getByRole("button", { name: retryName, exact: true }).click()
    await eventually("retry request sent", () => requests.length === 2)
    assert.deepEqual(
      requests[1],
      requests[0],
      "uncertain retry must retain operationId AND exact original request",
    )
    await page.getByRole("button", { name: retryName, exact: true }).waitFor({ state: "hidden" })
    return requests[0]
  } finally {
    await page.unroute(pattern, intercept)
  }
}
async function coreOperation(kind, payload, operationId = crypto.randomUUID()) {
  const data = ok(await api(dad, `/api/children/${state.childId}/data`))
  const body = {
    expectedRevision: data.revision,
    membershipVersion: data.context.membershipVersion,
    operationId,
    kind,
    payload,
  }
  return {
    body,
    result: ok(await api(dad, `/api/children/${state.childId}/operations`, "POST", body)),
  }
}
function durableRecords(snap, id, collection) {
  return snap.records.filter(
    (row) => row.pluginId === id && row.childId === state.childId && row.collection === collection,
  )
}
async function retained(id, collection, expected) {
  const stored = durableRecords(await snapshot(), id, collection)
  assert.deepEqual(stored, expected, "revocation must preserve records and their revisions")
}
async function historicalRowsRemain(expected) {
  const after = await snapshot()
  for (const row of expected)
    assert.deepEqual(
      after.records.find(
        (next) =>
          next.pluginId === row.pluginId &&
          next.childId === row.childId &&
          next.collection === row.collection &&
          next.id === row.id,
      ),
      row,
    )
}
async function denied(id, release) {
  for (const [endpoint, method, body] of [
    ["info", "GET"],
    ["records/entries", "GET"],
    ["probe", "POST", { operationId: crypto.randomUUID(), message: "拒绝旧页面", value: 2 }],
  ]) {
    const result = await runtime(id, endpoint, method, body, { release })
    assert.equal(result.status, 409, "revoked " + endpoint)
    assert.ok(result.kind.startsWith("plugin_"))
  }
}
async function renderedQA(page, label, include) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
  ]) {
    await page.setViewportSize(viewport)
    await eventually(label + " fits " + viewport.width, () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    )
    if (include === ".demo-page") {
      const overflow = await page
        .locator(include)
        .evaluate((root) => root.scrollWidth > root.clientWidth + 1)
      assert.equal(overflow, false, "plugin container fits viewport")
    }
    const report = await new AxeBuilder({ page })
      .include(include)
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
    fs.writeFileSync(
      path.join(out, `${label}-${viewport.width}-axe.json`),
      JSON.stringify(report, null, 2),
    )
    assert.deepEqual(
      report.violations
        .filter((v) => ["critical", "serious"].includes(v.impact))
        .map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
      [],
      label + " serious accessibility issues",
    )
    await screenshot(page, label + "-" + viewport.width)
  }
  await page.setViewportSize({ width: 1280, height: 960 })
}
async function initialize() {
  await Promise.all(Object.values(ports).map(free))
  assert.equal(fs.realpathSync(root), root)
  for (let folder = fixture; folder !== root; folder = path.dirname(folder))
    if (fs.existsSync(folder))
      assert.equal(
        fs.lstatSync(folder).isSymbolicLink(),
        false,
        "fixture path cannot contain links",
      )
  fs.mkdirSync(fixture, { recursive: true, mode: 0o700 })
  assert.equal(fs.realpathSync(fixture), fixture, "test directory cannot traverse symlinks")
  fs.mkdirSync(path.join(fixture, ".acceptance.lock"))
  locked = true
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  state = await runPython(["tests/fixtures/plugins/demo_setup.py"], passwords)
  assert.equal(state.database, "lele_test_demo_plugins")
  start("parent")
  start("admin")
  start("runtime")
  for (const port of Object.values(ports))
    await eventually("HTTP ready " + port, async () => {
      try {
        return (
          await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
        ).ok
      } catch {
        return false
      }
    })
  await eventually("private runtime socket", () =>
    fs.existsSync(path.join(env.LELE_PLUGIN_SOCKET_ROOT, "control.sock")),
  )
  browser = await chromium.launch({ headless: true })
  async function page() {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 960 },
      reducedMotion: "reduce",
    })
    await context.route(/\/api\/(?:admin\/)?(?:account|child)-avatars$/, (route) =>
      route.fulfill({ json: { avatars: [], expiresIn: 3600 } }),
    )
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    return page
  }
  admin = await page()
  dad = await page()
  mom = await page()
  dad.on("request", (request) => {
    if (/\/plugin-assets\/demo-(?:page|service)\/.*\.(?:js|css)(?:\?|$)/.test(request.url()))
      traffic.push(request.url())
  })
  await login(admin, "demoadmin", passwords.admin, "admin")
  await login(dad, "demodad", passwords.dad)
  await login(mom, "demomom", passwords.mom)
}
async function publicationAndInstallation() {
  await admin.locator("#pluginsNav").click()
  const catalog = ok(await api(admin, "/api/admin/plugins")).plugins
  assert.deepEqual(
    catalog.map((p) => p.id).sort(),
    [...ids].sort(),
    "fixture registers only new demos",
  )
  for (const id of ids) {
    const p = catalog.find((p) => p.id === id),
      manifest = state.manifests[id]
    assert.equal(p.publicationStatus, "pending")
    assert.equal(p.version, "1.0.0")
    for (const key of ["name", "description", "instructions"]) assert.equal(p[key], manifest[key])
    assert.ok(p.icon.endsWith(".png") && p.icons.includes(p.icon))
    const icon = await admin.request.get(new URL(p.icon, `http://127.0.0.1:${ports.admin}`).href)
    assert.equal(icon.status(), 200)
    assert.deepEqual([...(await icon.body())].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10])
    await admin.locator(`#plugin-open-${id}`).click()
    const image = admin
      .locator(`img[src="${new URL(p.icon, `http://127.0.0.1:${ports.admin}`).href}"]`)
      .first()
    await image.scrollIntoViewIfNeeded()
    await eventually("real package icon rendered", () =>
      image.evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    await admin.getByRole("button", { name: "上架插件", exact: true }).click()
    await admin.getByRole("button", { name: "确认上架", exact: true }).click()
    await admin.getByRole("dialog").waitFor({ state: "hidden" })
    assert.equal(
      ok(await api(admin, "/api/admin/plugins")).plugins.find((p) => p.id === id).publicationStatus,
      "published",
    )
    await screenshot(admin, id + "-admin-published")
    await admin.getByRole("button", { name: "返回插件列表", exact: true }).click()
  }
  await applications(dad)
  for (const id of ids) {
    await dad.locator(`[data-plugin-install="${id}"]`).click()
    await eventually(id + " installed", async () => (await plugin(id))?.effectiveEnabled === true)
  }
  await dad.locator('[data-view="plugin:demo-page"]').waitFor()
  assert.equal(await dad.locator('[data-view="plugin:demo-service"]').count(), 0)
  assert.equal(traffic.length, 0, "install must not eagerly load JS/CSS")
  await focus(mom)
  await mom.locator('[data-view="plugin:demo-page"]').waitFor()
  assert.equal(await mom.locator('[data-view="plugin:demo-service"]').count(), 0)
  const memberDenied = await api(mom, pluginPath("demo-page") + "/disable", "POST", {
    operationId: crypto.randomUUID(),
    expectedRevision: (await plugin("demo-page")).revision,
  })
  assert.equal(memberDenied.status, 403, "only owner can manage shared installation")
  const serviceEntry = await api(dad, pluginPath("demo-service") + "/entry")
  assert.equal(serviceEntry.kind, "plugin_no_page")
  await renderedQA(dad, "applications", ".applications-workspace")
}
async function configurationAndLazyMount() {
  for (const id of ids) await configurationDefaults(id)
  assert.equal(traffic.length, 0, "configuration dialogs must not eagerly load assets")
  await config("demo-page", { pageSize: 2, multiplier: 2, autoRefresh: false })
  await config("demo-service", { batchSize: 2, multiplier: 1.5, channel: "执行日志" })
  for (const id of ids) {
    const current = await config(id),
      p = await plugin(id)
    const info = ok(await runtime(id, "info"))
    assert.equal(info.pluginId, id)
    assert.equal(info.childId, state.childId)
    assert.equal(info.version, "1.0.0")
    assert.equal(info.releaseId, p.releaseId)
    assert.equal(info.configRevision, current.revision)
    assert.deepEqual(info.config, current.config)
    for (const secret of ["scopeToken", "actorId", "expiresAt", "nonce"])
      assert.equal(Object.hasOwn(info, secret), false)
    const memberConfig = await api(mom, pluginPath(id) + "/config", "PUT", {
      operationId: crypto.randomUUID(),
      expectedRevision: current.revision,
      config: current.config,
    })
    assert.equal(memberConfig.status, 403)
  }
  // API writes above deliberately bypass the host store. Reload both sessions
  // before interacting so its required configRevision remount happens before
  // the record/pagination scenarios, rather than on the next five-second poll.
  for (const page of [dad, mom]) {
    await page.reload()
    await page.locator('[data-view="plugin:demo-page"]').waitFor()
  }
  await mount()
  assert.ok(traffic.some((url) => url.includes("demo-page") && url.endsWith(".js")))
  assert.ok(traffic.some((url) => url.includes("demo-page") && url.endsWith(".css")))
  assert.equal(
    traffic.some((url) => url.includes("demo-service")),
    false,
  )
  const info = JSON.parse(await dad.locator("[data-info]").textContent())
  assert.equal(info.config.pageSize, 2)
  await dad.getByRole("button", { name: "发送提示", exact: true }).click()
  await dad.getByText(state.childName + "：Demo 插件通知测试成功", { exact: true }).waitFor()
  await screenshot(dad, "demo-page-desktop")
}
async function recordLifecycle() {
  const id = await createUI("首条共享记录")
  await mount(mom)
  await mom.getByRole("button", { name: "编辑记录：首条共享记录", exact: true }).waitFor()
  await dad.locator(`[data-demo-edit="${id}"]`).click()
  await dad.getByLabel("Demo 记录内容", { exact: true }).fill("负责人草稿")
  const previous = await record(id)
  const changed = ok(
    await put(id, { ...previous.payload, text: "另一家长更新" }, previous.revision, mom),
  ).record
  await dad.getByRole("button", { name: "保存修改", exact: true }).click()
  await dad.getByRole("button", { name: "读取最新记录并核对", exact: true }).waitFor()
  assert.equal(await dad.getByLabel("Demo 记录内容", { exact: true }).inputValue(), "负责人草稿")
  await dad.getByRole("button", { name: "读取最新记录并核对", exact: true }).click()
  await dad
    .locator("[data-write-state]")
    .filter({ hasText: `最新记录：另一家长更新（修订 ${changed.revision}）` })
    .waitFor()
  assert.equal(await dad.getByLabel("Demo 记录内容", { exact: true }).inputValue(), "负责人草稿")
  await dad.getByRole("button", { name: "保存修改", exact: true }).click()
  await eventually(
    "conflict resolved with latest revision",
    async () => (await record(id)).payload.text === "负责人草稿",
  )
  await dad.locator(`[data-demo-archive="${id}"]`).click()
  await eventually("archived", async () => (await record(id)).payload.archived === true)
  await dad.locator(`[data-demo-archive="${id}"]`).filter({ hasText: "恢复" }).click()
  await eventually("restored", async () => (await record(id)).payload.archived === false)
  const before = await record(id),
    op = crypto.randomUUID()
  const body = { ...before.payload, text: "幂等保存" }
  const first = ok(await put(id, body, before.revision, dad, op))
  const replay = ok(await put(id, body, before.revision, dad, op))
  assert.deepEqual(replay, first)
  const collision = await put(id, { ...body, text: "禁止复用" }, before.revision, dad, op)
  assert.equal(collision.kind, "plugin_operation_conflict")
  assert.equal((await record(id)).revision, first.record.revision)
  const uncertain = await uncertainResponse(
    dad,
    /\/runtime\/records\/entries\/[^/]+$/,
    async () => {
      await dad.getByLabel("Demo 记录内容", { exact: true }).fill("响应丢失仍只保存一次")
      await dad.getByRole("button", { name: "保存记录", exact: true }).click()
    },
    "重试原请求",
  )
  const uncertainId = new URL(uncertain.url).pathname.split("/").pop()
  await dad.locator("[data-save]:not([disabled])").waitFor()
  assert.equal((await record(uncertainId)).revision, 1)
  assert.equal(
    (await rows()).filter((row) => row.payload.text === "响应丢失仍只保存一次").length,
    1,
  )
  await createUI("第三条用于分页")
  await createUI("第四条用于分页")
  await dad.getByRole("button", { name: "刷新记录", exact: true }).click()
  await eventually(
    "page size honored",
    async () => (await dad.locator("[data-records] article").count()) === 2,
  )
  const firstPage = await dad
    .locator("[data-demo-edit]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.demoEdit))
  const firstContents = await dad.locator("[data-records]").innerText()
  const failedPage = /\/plugins\/demo-page\/runtime\/records\/entries\?.*[?&]after=/
  const rejectNext = (route) =>
    route.fulfill({
      status: 503,
      json: { error: "分页验收临时不可用", kind: "demo_qa_unavailable" },
    })
  await dad.route(failedPage, rejectNext)
  try {
    await dad.getByRole("button", { name: "下一页", exact: true }).click()
    await dad
      .locator('[data-status][data-failed="true"]')
      .filter({ hasText: "分页验收临时不可用" })
      .waitFor()
    assert.ok(
      (await dad.locator("[data-page]").innerText()).includes("第 1 页"),
      "failed next request retains current page",
    )
    assert.equal(
      await dad.locator("[data-records]").innerText(),
      firstContents,
      "failed next request retains rendered records",
    )
  } finally {
    await dad.unroute(failedPage, rejectNext)
  }
  await dad.getByRole("button", { name: "下一页", exact: true }).click()
  await dad.locator("[data-page]").filter({ hasText: "第 2 页" }).waitFor()
  const secondPage = await dad
    .locator("[data-demo-edit]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.demoEdit))
  assert.equal(
    secondPage.some((id) => firstPage.includes(id)),
    false,
  )
  await dad.getByRole("button", { name: "上一页", exact: true }).click()
  await dad.locator("[data-page]").filter({ hasText: "第 1 页" }).waitFor()
  assert.deepEqual(
    await dad
      .locator("[data-demo-edit]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.demoEdit)),
    firstPage,
  )
  evidence.recordId = id
}
async function backendAndRetry() {
  for (const id of ids) {
    const collection = id === "demo-page" ? "activity" : "executions",
      op = crypto.randomUUID()
    const body = { operationId: op, message: id + " 真实 worker 探测", value: 4 }
    const first = ok(await runtime(id, "probe", "POST", body))
    assert.equal(first.weightedValue, 4 * (await config(id)).config.multiplier)
    assert.equal(Object.hasOwn(first, "effects"), false)
    assert.deepEqual(ok(await runtime(id, "probe", "POST", body)), first)
    const effects = (await rows(id, collection)).filter((row) => row.payload.operationId === op)
    assert.equal(effects.length, 1)
    assert.equal(effects[0].revision, 1)
    assert.equal(effects[0].payload.kind, "manual")
    // A non-namespace-safe operation and its literal SHA256 hex are distinct
    // operations. They must never map to the same persisted record identity.
    const rawOperation = "demo/op1"
    assert.equal(rawOperation.length, 8)
    const digestOperation = crypto.createHash("sha256").update(rawOperation).digest("hex")
    const collisionBodies = [
      { operationId: rawOperation, message: id + " 原始操作", value: 1 },
      { operationId: digestOperation, message: id + " 摘要文本操作", value: 3 },
    ]
    ok(await runtime(id, "probe", "POST", collisionBodies[0]))
    const original = (await rows(id, collection)).filter(
      (row) => row.payload.operationId === rawOperation,
    )
    assert.equal(original.length, 1)
    assert.equal(original[0].revision, 1)
    ok(await runtime(id, "probe", "POST", collisionBodies[1]))
    const collisionRows = (await rows(id, collection)).filter((row) =>
      collisionBodies.some((body) => row.payload.operationId === body.operationId),
    )
    assert.equal(
      collisionRows.length,
      2,
      "raw operation and literal digest each retain an independent effect",
    )
    assert.equal(new Set(collisionRows.map((row) => row.id)).size, 2)
    for (const body of collisionBodies) {
      const stored = collisionRows.find((row) => row.payload.operationId === body.operationId)
      assert.ok(stored, "original operationId is preserved verbatim")
      assert.equal(stored.revision, 1)
      assert.equal(stored.payload.message, body.message)
      assert.equal(stored.payload.value, body.value)
    }
    assert.deepEqual(
      collisionRows.find((row) => row.payload.operationId === rawOperation),
      original[0],
      "second operation cannot overwrite first record or its revision",
    )
    evidence[id + "-identity-collision"] = collisionRows
    const failed = await runtime(id, "fail", "POST", { operationId: crypto.randomUUID() })
    assert.ok(failed.status >= 400)
    assert.equal(
      ok(await runtime(id, "info")).pluginId,
      id,
      "worker recovers after controlled failure",
    )
  }
  await dad.getByRole("button", { name: "模拟接口错误", exact: true }).click()
  await dad.locator("[data-response]").filter({ hasText: "已捕获模拟错误" }).waitFor()
  const sent = await uncertainResponse(
    dad,
    /\/plugins\/demo-page\/runtime\/probe$/,
    async () => {
      await dad.getByLabel("Demo 测试消息", { exact: true }).fill("接口响应丢失")
      await dad.getByRole("button", { name: "调用后端", exact: true }).click()
    },
    "重试接口请求",
  )
  await eventually("probe retry response shown", async () =>
    (await dad.locator("[data-response]").textContent()).includes('"weightedValue": 4'),
  )
  const effects = (await rows("demo-page", "activity")).filter(
    (row) => row.payload.operationId === sent.body.operationId,
  )
  assert.equal(effects.length, 1)
  assert.equal(effects[0].revision, 1)
  await dad.getByRole("button", { name: "读取活动", exact: true }).click()
  await dad.locator("[data-activity]").filter({ hasText: "接口响应丢失" }).waitFor()
  // Hold only delivery of a real two-second response, so probe definitely wins
  // before the old slow request is delivered, even on a busy test machine.
  const slowPattern = /\/plugins\/demo-page\/runtime\/slow$/
  let releaseSlow,
    slowStatus,
    slowFinished = false
  const hold = new Promise((resolve) => (releaseSlow = resolve))
  const slowRoute = async (route) => {
    try {
      const response = await route.fetch()
      slowStatus = response.status()
      await hold
      await route.fulfill({ response })
    } finally {
      slowFinished = true
    }
  }
  await dad.route(slowPattern, slowRoute)
  try {
    const started = dad.waitForRequest(slowPattern)
    await dad.getByRole("button", { name: "测试慢请求", exact: true }).click()
    await started
    const later = dad.waitForResponse(
      (response) =>
        response.url().endsWith("/demo-page/runtime/probe") &&
        response.request().method() === "POST",
    )
    await dad.getByLabel("Demo 测试消息", { exact: true }).fill("后发 probe 必须保留")
    await dad.getByRole("button", { name: "调用后端", exact: true }).click()
    const latest = await (await later).json()
    assert.ok(latest.operationId)
    await eventually("newer probe result displayed", async () =>
      (await dad.locator("[data-response]").textContent()).includes(latest.operationId),
    )
    await eventually(
      "older real slow request completed upstream",
      () => slowStatus !== undefined,
      15000,
    )
    assert.equal(slowStatus, 200)
    const delivered = dad.waitForResponse(slowPattern)
    releaseSlow()
    await (await delivered).finished()
    await eventually("slow route fulfilled", () => slowFinished)
    await dad.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    const shown = JSON.parse(await dad.locator("[data-response]").textContent())
    assert.equal(
      shown.operationId,
      latest.operationId,
      "older slow response must not overwrite newer probe result",
    )
    assert.equal(shown.message, "后发 probe 必须保留")
  } finally {
    releaseSlow()
    await dad.unroute(slowPattern, slowRoute)
  }
}
async function jobsAndEvents() {
  const pageJob = await probe("enqueue", "demo-page", "heartbeat", "demo-qa-" + crypto.randomUUID())
  const serviceJob = await probe(
    "enqueue",
    "demo-service",
    "heartbeat",
    "demo-qa-" + crypto.randomUUID(),
  )
  // A past scheduled ISO occurrence runs immediately without waiting for wall clock 20:00.
  // It exercises the actual time/timezone schedule too: the natural daily job is checked below.
  const dailyKey = new Date(Date.now() - 500).toISOString()
  const dailyJob = await probe("enqueue", "demo-service", "daily-reminder", dailyKey)
  const duplicate = await probe("enqueue", "demo-service", "daily-reminder", dailyKey)
  assert.equal(duplicate.jobId, dailyJob.jobId)
  const wanted = [pageJob.jobId, serviceJob.jobId, dailyJob.jobId]
  await eventually(
    "real handle_job persisted all due jobs",
    async () => {
      const snap = await snapshot()
      return wanted.every((id) =>
        snap.jobs.some((job) => job.id === id && job.status === "succeeded"),
      )
    },
    45000,
  )
  const today = new Date().toISOString().slice(0, 10)
  const baseline = ok(await api(dad, `/api/children/${state.childId}/data`))
  const task = {
    title: "Demo 真实核心完成事件",
    note: "",
    startDate: today,
    startTime: "09:00",
    endTime: "09:10",
    categoryId: baseline.data.categories[0].id,
    points: 7,
    recurrence: null,
  }
  const created = await coreOperation("task.create", { task })
  const series = created.result.data.series.find((series) => series.title === task.title)
  assert.ok(series)
  const key = series.id + "@" + today
  const completed = await coreOperation("completion.set", { occurrenceKey: key, completed: true })
  ok(await api(dad, `/api/children/${state.childId}/operations`, "POST", completed.body))
  await eventually(
    "core outbox delivered to both real workers",
    async () => {
      const snap = await snapshot()
      const event = snap.events.find((event) => event.payload.occurrenceKey === key)
      return (
        event &&
        ids.every((id) =>
          snap.deliveries.some(
            (delivery) =>
              delivery.eventId === event.id &&
              delivery.pluginId === id &&
              delivery.status === "succeeded",
          ),
        )
      )
    },
    45000,
  )
  const snap = await snapshot()
  const events = snap.events.filter((event) => event.payload.occurrenceKey === key)
  assert.equal(events.length, 1, "completion replay emits one event")
  for (const id of ids) {
    const records = durableRecords(snap, id, id === "demo-page" ? "activity" : "executions")
    const eventRecords = records.filter(
      (record) =>
        record.payload.kind === "task.completed" && record.payload.occurrenceKey === events[0].id,
    )
    assert.equal(eventRecords.length, id === "demo-page" ? 1 : 2)
    assert.ok(eventRecords.every((record) => record.revision === 1))
    assert.ok(records.some((record) => record.payload.kind === "heartbeat"))
    if (id === "demo-service") {
      assert.ok(
        eventRecords.every(
          (record) => record.payload.points === 7 && record.payload.weightedPoints === 10.5,
        ),
      )
      const daily = records.filter(
        (record) =>
          record.payload.kind === "daily-reminder" && record.payload.occurrenceKey === dailyKey,
      )
      assert.equal(daily.length, 2)
      assert.ok(
        daily.every(
          (record) =>
            record.payload.time === "20:00" && record.payload.timezone === "Asia/Shanghai",
        ),
      )
      assert.ok(
        snap.jobs.some(
          (job) =>
            job.pluginId === id &&
            job.taskId === "daily-reminder" &&
            /T20:00:00\+08:00$/.test(job.occurrenceKey),
        ),
        "scheduler uses configured time/timezone",
      )
    }
  }
  evidence.background = snap
}
async function namespaceIsolation() {
  const release = (await plugin("demo-page")).releaseId
  assert.equal(
    (await runtime("demo-page", "info", "GET", undefined, { child: state.otherChildId, release }))
      .kind,
    "plugin_not_installed",
  )
  await action("demo-page", "install", state.otherChildId)
  await action("demo-service", "install", state.otherChildId)
  const id = "shared-namespace-id",
    op = crypto.randomUUID()
  for (const pluginId of ids)
    for (const child of [state.childId, state.otherChildId]) {
      ok(
        await runtime(
          pluginId,
          "records/isolation/" + id,
          "PUT",
          {
            operationId: op,
            expectedRevision: 0,
            payload: { marker: pluginId + ":" + child },
          },
          { child },
        ),
      )
    }
  for (const pluginId of ids)
    for (const child of [state.childId, state.otherChildId]) {
      const stored = ok(
        await runtime(pluginId, "records/isolation/" + id, "GET", undefined, { child }),
      ).record
      assert.equal(stored.payload.marker, pluginId + ":" + child)
    }
  await dad.goto(origin + "/children/" + state.otherChildId)
  await dad.locator('[data-view="plugin:demo-page"]').waitFor()
  await mount(dad, state.otherChildName)
  assert.equal(
    JSON.parse(await dad.locator("[data-info]").textContent()).childId,
    state.otherChildId,
  )
  assert.equal((await rows("demo-page", "entries", state.otherChildId)).length, 0)
  await dad.goto(origin + "/children/" + state.childId)
  await dad.locator('[data-view="plugin:demo-page"]').waitFor()
  await mount()
}
async function disposalAndResponsive() {
  await renderedQA(dad, "demo-page", ".demo-page")
  // Retain a detached node + observe it: a late slow result must not mutate old DOM.
  await dad.evaluate(() => {
    window.__demoDetached = document.querySelector(".demo-page")
    window.__demoLateMutations = 0
    window.__demoObserver = new MutationObserver(() => {
      if (!window.__demoDetached.isConnected) window.__demoLateMutations++
    })
    window.__demoObserver.observe(window.__demoDetached, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })
  const slowPattern = /\/plugins\/demo-page\/runtime\/slow$/
  let releaseSlow, committed, finished
  const upstreamDone = new Promise((resolve) => (committed = resolve))
  const routeDone = new Promise((resolve) => (finished = resolve))
  const hold = new Promise((resolve) => (releaseSlow = resolve))
  const slowRoute = async (route) => {
    try {
      const result = await route.fetch()
      committed(result.status())
      await hold
      await route.fulfill({ response: result }).catch(() => {})
    } catch {
      committed(0)
    } finally {
      finished()
    }
  }
  await dad.route(slowPattern, slowRoute)
  const slowStarted = dad.waitForRequest(slowPattern)
  await dad.getByRole("button", { name: "测试慢请求", exact: true }).click()
  await slowStarted
  await dad.getByRole("button", { name: "返回日历", exact: true }).click()
  await dad.locator(".demo-page").waitFor({ state: "detached" })
  let slowStatus
  void upstreamDone.then((status) => {
    slowStatus = status
  })
  try {
    await eventually("real slow handler completes", () => slowStatus !== undefined, 15000)
    assert.equal(slowStatus, 200, "slow handler really executes before late delivery")
  } finally {
    releaseSlow()
  }
  await routeDone
  await dad.unroute(slowPattern, slowRoute)
  await dad.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  assert.equal(
    await dad.locator('link[rel="stylesheet"][href*="/plugin-assets/demo-page/"]').count(),
    0,
  )
  assert.equal(await dad.locator("[data-response], [data-info], .demo-page").count(), 0)
  assert.equal(await dad.evaluate(() => window.__demoLateMutations), 0)
  await dad.evaluate(() => {
    window.__demoObserver.disconnect()
    delete window.__demoDetached
    delete window.__demoObserver
  })
  await mount()
  await dad.getByRole("button", { name: "应用配置", exact: true }).click()
  await dad.locator(".demo-page").waitFor({ state: "detached" })
  await applications(dad)
}
async function independentDeployments() {
  const pids = processes.map((child) => child.pid)
  for (const id of ids) {
    const other = ids.find((value) => value !== id)
    const prior = await plugin(id),
      otherPrior = await plugin(other)
    const originalWorker = await probe("health", id, "1.0.0")
    const otherWorker = await probe("health", other, "1.0.0")
    assert.ok(originalWorker.ok && Number.isInteger(originalWorker.pid))
    let oldRelease = prior.releaseId
    const before = await snapshot()
    const ownCollection = id === "demo-page" ? "entries" : "isolation"
    const ownData = durableRecords(before, id, ownCollection)
    const beforeConfig = (await config(id)).config
    for (const mode of ["update", "rollback"]) {
      const deploying = probe(mode, id)
      // Attach the rejection immediately while host/other-plugin requests are in flight.
      void deploying.catch(() => {})
      ok(await api(dad, `/api/children/${state.childId}/data`), "core while " + mode)
      assert.equal(ok(await runtime(other, "info")).releaseId, otherPrior.releaseId)
      const result = await deploying
      assert.equal(result.status, "succeeded", JSON.stringify(result))
      const expected = mode === "update" ? "1.0.1" : "1.0.0"
      assert.equal((await plugin(id)).version, expected)
      const info = ok(await runtime(id, "info"))
      assert.equal(info.version, expected)
      assert.deepEqual(info.config, beforeConfig)
      const old = await runtime(id, "info", "GET", undefined, { release: oldRelease })
      assert.equal(old.kind, "plugin_version_changed")
      oldRelease = info.releaseId
      const worker = await probe("health", id, expected)
      assert.ok(worker.ok && Number.isInteger(worker.pid))
      if (mode === "update") assert.notEqual(worker.pid, originalWorker.pid)
      assert.equal(
        (await probe("health", other, "1.0.0")).pid,
        otherWorker.pid,
        "another plugin's worker is not restarted",
      )
      await retained(id, ownCollection, ownData)
      // All pre-existing rows must survive; natural heartbeats may add rows meanwhile.
      const after = await snapshot()
      for (const row of before.records.filter((row) => row.pluginId === id))
        assert.deepEqual(
          after.records.find(
            (next) =>
              next.pluginId === id &&
              next.childId === row.childId &&
              next.collection === row.collection &&
              next.id === row.id,
          ),
          row,
        )
      assert.deepEqual(
        processes.map((child) => child.pid),
        pids,
      )
      assert.ok(processes.every((child) => child.exitCode === null && !child.killed))
      evidence[id + "-" + mode] = { deployment: result, worker, corePids: pids }
      if (id === "demo-page") {
        await dad.reload()
        await dad.locator('[data-view="plugin:demo-page"]').waitFor()
        await mount()
        assert.equal(JSON.parse(await dad.locator("[data-info]").textContent()).version, expected)
        await applications(dad)
      }
    }
  }
}
async function revocations() {
  for (const id of ids) {
    const collection = id === "demo-page" ? "entries" : "isolation"
    const initialSnapshot = await snapshot()
    const initial = durableRecords(initialSnapshot, id, collection)
    const history = initialSnapshot.records.filter((row) => row.pluginId === id)
    const savedConfig = (await config(id)).config
    const release = (await plugin(id)).releaseId
    await applications(dad)
    if (id === "demo-page") {
      await mount(mom)
      await mount()
    }
    // Owner uses the actual host control; shared menu must disappear in both sessions.
    await applications(dad)
    await dad.locator(`[data-plugin-more="${id}"]`).click()
    await dad.locator(`[data-plugin-disable="${id}"]`).click()
    await eventually("disabled " + id, async () => !(await plugin(id)).effectiveEnabled)
    await denied(id, release)
    if (id === "demo-page") {
      await focus(mom)
      await mom.locator('[data-view="plugin:demo-page"]').waitFor({ state: "hidden" })
      await mom.locator(".demo-page").waitFor({ state: "detached" })
      assert.equal(await mom.locator('link[href*="/plugin-assets/demo-page/"]').count(), 0)
    }
    await retained(id, collection, initial)
    await historicalRowsRemain(history)
    await action(id, "enable")
    await catalogAction(id, "scope", { scopeMode: "children", childIds: [state.otherChildId] })
    await denied(id, release)
    assert.equal((await plugin(id)).requiresReenable, true)
    await retained(id, collection, initial)
    await historicalRowsRemain(history)
    await catalogAction(id, "scope", { scopeMode: "all", childIds: [] })
    assert.equal(
      (await plugin(id)).effectiveEnabled,
      false,
      "scope restoration requires explicit enable",
    )
    await action(id, "enable")
    await catalogAction(id, "unpublish")
    await denied(id, release)
    await retained(id, collection, initial)
    await historicalRowsRemain(history)
    await focus(dad)
    await applications(dad)
    await dad.getByRole("tab", { name: "已安装", exact: true }).click()
    await dad.locator(`[data-plugin-id="${id}"]`).getByText("已下架", { exact: true }).waitFor()
    await screenshot(dad, id + "-unpublished-retained")
    await catalogAction(id, "publish")
    assert.equal((await plugin(id)).effectiveEnabled, false)
    await action(id, "enable")
    await action(id, "installation")
    await denied(id, release)
    await retained(id, collection, initial)
    await historicalRowsRemain(history)
    assert.deepEqual((await config(id)).config, savedConfig)
    await action(id, "install")
    assert.equal(
      (await plugin(id)).effectiveEnabled,
      false,
      "reinstall retains data and requires enable",
    )
    await action(id, "enable")
    assert.deepEqual((await config(id)).config, savedConfig)
    await retained(id, collection, initial)
    await historicalRowsRemain(history)
  }
}
async function cleanup() {
  if (browser) await browser.close().catch(() => {})
  for (const child of [...processes].reverse()) if (child.exitCode === null) child.kill("SIGTERM")
  await eventually(
    "test services terminate",
    () => processes.every((child) => child.exitCode !== null || child.signalCode !== null),
    8000,
  ).catch(() => {
    for (const child of processes)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  })
  if (locked) {
    fs.rmdirSync(path.join(fixture, ".acceptance.lock"))
    locked = false
  }
}
const scenarios = [
  [
    "quick edit navigation notice has only the acknowledgement action and closes cleanly",
    quickEditNotice,
  ],
  [
    "Chinese pending manifests, PNG icons, real admin publish, owner install/shared menu, lazy assets/no service tab",
    publicationAndInstallation,
  ],
  [
    "all config defaults, grouped controls, client/server ranges and multiselect validation, runtime info/config snapshot",
    configurationAndLazyMount,
  ],
  [
    "record CRUD/archive, pagination 503 retains page then retries page 2, revision conflict/latest comparison, exact-body idempotency + uncertain UI retry",
    recordLifecycle,
  ],
  [
    "both workers probe/fail/recovery, independent raw/digest identity effects, uncertain interface retry; older slow response cannot overwrite later probe",
    backendAndRetry,
  ],
  [
    "real heartbeat/daily workers, deterministic due occurrence dedupe, task.create + completion.set durable outbox/events",
    jobsAndEvents,
  ],
  [
    "same record/op IDs isolated by plugin AND child, real child page switching",
    namespaceIsolation,
  ],
  [
    "390 phone/820 tablet overflow + scoped axe, slow disposal without stale DOM/CSS, notify/core navigation",
    disposalAndResponsive,
  ],
  [
    "each plugin independently updates 1.0.0→1.0.1 and rolls back, unchanged data/schema/config/core PIDs, stale release denied",
    independentDeployments,
  ],
  [
    "disable/scope revoke/unpublish/uninstall deny old calls and retain records/config, explicit reenable/reinstall",
    revocations,
  ],
]
;(async () => {
  try {
    scenarios.forEach(([name], index) => console.log(`SCENARIO ${index + 1}: ${name}`))
    await initialize()
    for (const [name, run] of scenarios) await scenario(name, run)
    assert.deepEqual(pageErrors, [])
    evidence.final = await snapshot()
    console.log(`Demo acceptance passed (${checks.length} scenario groups). Evidence: ${out}`)
  } catch (error) {
    process.exitCode = 1
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, "failure.txt"), clean(current + "\n" + (error.stack || error)))
    if (browser)
      for (const [index, page] of browser
        .contexts()
        .flatMap((context) => context.pages())
        .entries()) {
        await screenshot(page, "failure-" + index).catch(() => {})
        fs.writeFileSync(
          path.join(out, "failure-" + index + ".txt"),
          clean(
            await page
              .locator("body")
              .innerText()
              .catch(() => ""),
          ),
        )
      }
    console.error(clean(error.stack || error))
  } finally {
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(
        {
          status: process.exitCode ? "failed" : "passed",
          current,
          planned: scenarios.map(([name]) => name),
          checks,
          pageErrors,
          evidence,
          viewports: ["1280x960", "390x844", "820x1180"],
          database: "lele_test_demo_plugins",
          ports,
          browser: "Playwright (Browser plugin not available)",
        },
        null,
        2,
      ),
    )
    await cleanup()
  }
})()
