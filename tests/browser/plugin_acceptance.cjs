/* Browser plugin not available. Existing Playwright drives real isolated servers. */
const { chromium } = require("playwright")
const { spawn, execFileSync } = require("node:child_process")
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  net = require("node:net")
const assert = require("node:assert/strict")
const root = path.resolve(__dirname, "../.."),
  python = path.join(root, ".venv/bin/python")
const fixture = path.join(root, "data/testing/plugins-browser"),
  out = "/tmp/lele-plugin-qa"
const ports = { parent: 18987, admin: 18988 },
  origin = `http://127.0.0.1:${ports.parent}`
const passwords = Object.fromEntries(
  ["initial", "admin", "dad", "mom"].map((key) => [
    key,
    "A7" + crypto.randomBytes(8).toString("hex"),
  ]),
)
const env = {
  ...process.env,
  PYTHONPATH: path.join(root, "backend"),
  LELE_ACCOUNTS_CONFIG: path.join(fixture, "config.json"),
  LELE_PLUGIN_ROOT: path.join(fixture, "runtime"),
  LELE_PLUGIN_SOCKET_ROOT: "/tmp/lele-plugin-browser-" + process.pid,
}
const processes = [],
  errors = [],
  checks = []
let browser
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function free(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => server.close(resolve))
  })
}
function start(surface) {
  const fd = fs.openSync(path.join(fixture, `${surface}.log`), "w")
  const process = spawn(
    python,
    [
      "-m",
      "uvicorn",
      "lele_growth.accounts_app:create_from_env",
      "--factory",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports[surface]),
    ],
    { cwd: root, env: { ...env, LELE_SURFACE: surface }, stdio: ["ignore", fd, fd] },
  )
  fs.closeSync(fd)
  processes.push(process)
}
async function ready(port) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return
    } catch {}
    await wait(100)
  }
  throw Error("Service failed to start " + port)
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
      return { status: response.status, ...(await response.json()) }
    },
    { url, method, body, headers },
  )
}
async function login(page, name, password, surface = "parent", child) {
  await page.goto(`http://127.0.0.1:${ports[surface]}/${child ? "children/" + child : ""}`)
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
async function refresh(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await wait(200)
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name + ".png"), fullPage: true })
}
function check(name) {
  checks.push(name)
  console.log("PASS " + name)
}
function probe(mode) {
  return JSON.parse(
    execFileSync(python, ["tests/fixtures/plugins/deployment_probe.py", mode], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  )
}
function probeAsync(mode) {
  const child = spawn(python, ["tests/fixtures/plugins/deployment_probe.py", mode], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = "",
    error = ""
  child.stdout.on("data", (data) => (output += data))
  child.stderr.on("data", (data) => (error += data))
  return new Promise((resolve, reject) =>
    child.on("exit", (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(Error(error || "Deployment probe failed")),
    ),
  )
}
async function eventually(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return
    await wait(100)
  }
  throw Error("Expected plugin runtime state not reached")
}

;(async () => {
  try {
    await Promise.all(Object.values(ports).map(free))
    fs.mkdirSync(out, { recursive: true })
    const state = JSON.parse(
      execFileSync(python, ["tests/fixtures/plugins/browser_setup.py"], {
        cwd: root,
        env,
        input: JSON.stringify(passwords),
      }),
    )
    start("parent")
    start("admin")
    await Promise.all(Object.values(ports).map(ready))
    const runtimeLog = fs.openSync(path.join(fixture, "runtime.log"), "w")
    const runtimeProcess = spawn(
      python,
      ["deploy/plugin_runtime.py", "--config", path.join(fixture, "config.json")],
      { cwd: root, env, stdio: ["ignore", runtimeLog, runtimeLog] },
    )
    fs.closeSync(runtimeLog)
    processes.push(runtimeProcess)
    await eventually(() => fs.existsSync(path.join(env.LELE_PLUGIN_SOCKET_ROOT, "control.sock")))
    browser = await chromium.launch({ headless: true })
    const make = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.route(/\/api\/(?:admin\/)?(?:account|child)-avatars$/, (route) =>
        route.fulfill({ json: { avatars: [], expiresIn: 3600 } }),
      )
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      page.on("pageerror", (error) => errors.push(error.message))
      return page
    }
    const admin = await make(),
      dad = await make(),
      mom = await make()
    await login(admin, "pluginadmin", passwords.admin, "admin")
    await admin.locator("#pluginsNav").click()
    await admin.getByText("成长随记", { exact: true }).waitFor()
    assert.equal(
      (await api(admin, "/api/admin/plugins")).plugins.every(
        (p) => p.publicationStatus === "pending",
      ),
      true,
    )
    check("new plugins pending, metadata retained")
    await admin.locator("#plugin-open-growth-notes").click()
    await admin.getByRole("button", { name: "上架插件", exact: true }).click()
    await admin.getByRole("button", { name: "确认上架", exact: true }).click()
    await admin.getByRole("dialog").waitFor({ state: "hidden" })
    await screenshot(admin, "admin-plugin-detail")
    let service = (await api(admin, "/api/admin/plugins")).plugins.find(
      (p) => p.id === "reminder-demo",
    )
    let response = await api(admin, "/api/admin/plugins/reminder-demo/publish", "POST", {
      expectedRevision: service.revision,
    })
    assert.equal(response.status, 200)
    check("admin real UI publishes plugin")
    const scripts = []
    dad.on("request", (request) => {
      if (request.url().includes("/plugin-assets/") && request.url().endsWith(".js"))
        scripts.push(request.url())
    })
    await login(dad, "plugindad", passwords.dad, "parent", state.childId)
    await login(mom, "pluginmom", passwords.mom, "parent", state.childId)
    await applications(dad)
    await dad.locator('[data-plugin-install="growth-notes"]').click()
    await dad.locator('[data-view="plugin:growth-notes"]').waitFor()
    assert.equal(scripts.length, 0)
    check("installation enables shared tab without prefetching code")
    await refresh(mom)
    await mom.locator('[data-view="plugin:growth-notes"]').waitFor()
    check("second parent sees same child menu")
    await dad.locator('[data-plugin-config="growth-notes"]').click()
    await dad.locator("#pluginConfigDialog").waitFor()
    assert.equal(scripts.length, 0)
    await dad
      .locator("#pluginConfigForm")
      .getByRole("button", { name: "关闭", exact: true })
      .click()
    await dad.locator('[data-view="plugin:growth-notes"]').click()
    await dad.getByRole("heading", { name: "插件儿童的成长随记" }).waitFor()
    assert.ok(scripts.length > 0)
    await dad.getByLabel("成长记录内容").fill("今天自己完成了阅读计划。")
    await dad.getByRole("button", { name: "保存随记" }).click()
    await dad.getByText("今天自己完成了阅读计划。", { exact: true }).waitFor()
    await mom.locator('[data-view="plugin:growth-notes"]').click()
    await mom.getByText("今天自己完成了阅读计划。", { exact: true }).waitFor()
    check("lazy page mounted and records shared between parents")
    await screenshot(dad, "growth-notes-desktop")
    const other = await api(dad, `/api/children/${state.otherChildId}/plugins/growth-notes/entry`)
    assert.notEqual(other.status, 200)
    check("other child cannot use uninstalled plugin")
    await applications(dad)
    await dad.locator('[data-plugin-install="reminder-demo"]').click()
    assert.equal(await dad.locator('[data-view="plugin:reminder-demo"]').count(), 0)
    await dad.locator('[data-plugin-config="reminder-demo"]').click()
    await dad.locator("#pluginConfigDialog").waitFor()
    await screenshot(dad, "service-config-dialog")
    await dad
      .locator("#pluginConfigForm")
      .getByRole("button", { name: "关闭", exact: true })
      .click()
    check("background plugin has configuration dialog and no tab")
    await dad.setViewportSize({ width: 390, height: 844 })
    await screenshot(dad, "applications-mobile")
    assert.equal(
      await dad.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    )
    await dad.setViewportSize({ width: 820, height: 1180 })
    await screenshot(dad, "applications-tablet")
    check("mobile and tablet layouts fit viewport")
    probe("enqueue")
    await eventually(() => probe("records").records >= 1)
    const previousRecords = probe("records").records
    check("real independent worker executes persisted background job")
    const beforePids = processes.map((child) => child.pid)
    const updating = probeAsync("update")
    void updating.catch(() => {})
    await eventually(async () => {
      const list = (await api(admin, "/api/admin/plugins")).plugins
      return list.find((p) => p.id === "reminder-demo").operationState === "updating"
    })
    await refresh(dad)
    await dad
      .locator('[data-plugin-id="reminder-demo"]')
      .getByText("更新中", { exact: true })
      .waitFor()
    const baseline = await api(dad, `/api/children/${state.childId}/data`)
    assert.equal(baseline.status, 200)
    const created = await api(dad, `/api/children/${state.childId}/operations`, "POST", {
      expectedRevision: baseline.revision,
      membershipVersion: baseline.context.membershipVersion,
      operationId: crypto.randomUUID(),
      kind: "task.create",
      payload: {
        task: {
          title: "更新验收",
          note: "",
          startDate: new Date().toISOString().slice(0, 10),
          startTime: "09:00",
          endTime: "09:10",
          categoryId: baseline.data.categories[0].id,
          points: 1,
          recurrence: null,
        },
      },
    })
    assert.equal(created.status, 200)
    const notePlugin = (
      await api(dad, `/api/children/${state.childId}/plugins/status`)
    ).plugins.find((p) => p.id === "growth-notes")
    const notes = await api(
      dad,
      `/api/children/${state.childId}/plugins/growth-notes/runtime/records/notes`,
      "GET",
      undefined,
      { "X-Plugin-Release": notePlugin.releaseId },
    )
    assert.equal(notes.status, 200)
    assert.equal(notes.records.length, 1)
    await screenshot(dad, "target-plugin-updating")
    const updated = await updating
    assert.equal(updated.status, "succeeded")
    assert.deepEqual(
      processes.map((child) => child.pid),
      beforePids,
    )
    assert.ok(processes.every((child) => child.exitCode === null))
    assert.equal(
      (await api(admin, "/api/admin/plugins")).plugins.find((p) => p.id === "reminder-demo")
        .version,
      "1.0.1",
    )
    const rolled = await probeAsync("rollback")
    assert.equal(rolled.status, "succeeded")
    assert.equal(probe("records").records, previousRecords)
    assert.equal(
      (await api(admin, "/api/admin/plugins")).plugins.find((p) => p.id === "reminder-demo")
        .version,
      "1.0.0",
    )
    check(
      "single plugin update and rollback preserve data while core and another plugin stay available",
    )
    await dad.locator('[data-plugin-disable="growth-notes"]').click()
    await dad.locator('[data-view="plugin:growth-notes"]').waitFor({ state: "hidden" })
    await refresh(mom)
    await mom.locator('[data-view="plugin:growth-notes"]').waitFor({ state: "hidden" })
    const denied = await api(
      dad,
      `/api/children/${state.childId}/plugins/growth-notes/runtime/records/notes`,
      "GET",
      undefined,
      { "X-Plugin-Release": notePlugin.releaseId },
    )
    assert.equal(denied.status, 409)
    assert.equal(denied.kind, "plugin_disabled")
    check("disable revokes old page and backend data access")
    let pagePlugin = (await api(admin, "/api/admin/plugins")).plugins.find(
      (p) => p.id === "growth-notes",
    )
    response = await api(admin, "/api/admin/plugins/growth-notes/unpublish", "POST", {
      expectedRevision: pagePlugin.revision,
    })
    assert.equal(response.status, 200)
    await refresh(dad)
    await dad.getByRole("tab", { name: "已安装", exact: true }).click()
    await dad
      .locator('[data-plugin-id="growth-notes"]')
      .getByText("已下架", { exact: true })
      .waitFor()
    check("unpublished installed plugin remains explained")
    assert.deepEqual(errors, [])
    fs.writeFileSync(
      path.join(out, "results.json"),
      JSON.stringify(
        { checks, pageErrors: errors, viewports: ["1280x900", "820x1180", "390x844"] },
        null,
        2,
      ),
    )
    console.log("Plugin browser acceptance passed (" + checks.length + " scenarios).")
  } catch (error) {
    if (browser) {
      let index = 0
      for (const context of browser.contexts())
        for (const page of context.pages()) {
          await page
            .screenshot({ path: path.join(out, "failure-" + index + ".png"), fullPage: true })
            .catch(() => {})
          fs.writeFileSync(
            path.join(out, "failure-" + index + ".txt"),
            await page
              .locator("body")
              .innerText()
              .catch(() => ""),
          )
          index++
        }
    }
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, "failure.txt"), String(error.stack || error))
    console.error(error)
    process.exitCode = 1
  } finally {
    if (browser) await browser.close()
    for (const child of processes) child.kill("SIGTERM")
  }
})()
