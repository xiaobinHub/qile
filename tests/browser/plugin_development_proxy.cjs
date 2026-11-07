/* Run: node tests/browser/plugin_development_proxy.cjs [--no-source-edits]
 * Real FastAPI mount_proxy + CSP, built parent loader, actual plugin Vite source.
 * Only auth/business APIs are fixtures; no real account, worker, or database.
 * Bounded run, exclusive edit lock, finally restoration, retained /tmp evidence.
 */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawn, execFileSync } = require("node:child_process")
const { createHash, randomUUID, randomBytes } = require("node:crypto")
const { once } = require("node:events")
const { chromium } = require("playwright")
const http = require("node:http")
const root = path.resolve(__dirname, "../..")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (value) => createHash("sha256").update(value).digest("hex")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-development-proxy-"))
const runtime = path.join(out, "runtime")
const session = randomUUID()
const base = `/__plugin-dev/mison-booking/${session}/`
const token = "isolated-proxy-parent"
const sourceEdits = !process.argv.includes("--no-source-edits")
const checks = [],
  edited = [],
  errors = [],
  violations = [],
  blocked = [],
  sockets = []
let host, vite, browser, origin, lock, cleanupPromise, failure

function noConcurrentAcceptance() {
  const lines = execFileSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
      return (
        match &&
        Number(match[1]) !== process.pid &&
        /(?:^|\/)node$/.test(match[2]) &&
        /(?:mison_frontend_acceptance|plugin_development_proxy)\.cjs/.test(match[3])
      )
    })
  assert.deepEqual(lines, [], "Another acceptance run owns the source; retry after it finishes")
}

function edit(relative, transform) {
  noConcurrentAcceptance()
  const file = path.join(root, relative)
  const original = fs.readFileSync(file, "utf8")
  const changed = transform(original)
  assert.notEqual(changed, original, `HMR edit target missing: ${relative}`)
  const record = { file, original, changed, before: hash(original) }
  fs.writeFileSync(path.join(out, path.basename(file) + ".original"), original)
  edited.push(record)
  fs.writeFileSync(file, changed)
  return record
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    const problems = []
    for (const item of edited.reverse()) {
      try {
        const current = fs.readFileSync(item.file, "utf8")
        if (current === item.changed) fs.writeFileSync(item.file, item.original)
        else if (current !== item.original)
          throw Error(`Concurrent edit detected; backup retained: ${item.file}`)
        assert.equal(hash(fs.readFileSync(item.file)), item.before)
      } catch (error) {
        problems.push(error.message)
      }
    }
    for (const action of [() => browser?.close(), () => vite?.close()]) {
      try {
        await action()
      } catch (error) {
        problems.push(error.message)
      }
    }
    if (host && host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit")
      host.kill("SIGTERM")
      const killer = setTimeout(() => host.kill("SIGKILL"), 5000)
      await exited
      clearTimeout(killer)
    }
    if (fs.existsSync(path.join(runtime, "requests.jsonl")))
      fs.copyFileSync(path.join(runtime, "requests.jsonl"), path.join(out, "requests.jsonl"))
    fs.rmSync(runtime, { recursive: true, force: true })
    if (lock) fs.rmSync(lock, { recursive: true, force: true })
    assert.deepEqual(problems, [], "Cleanup must restore exact source bytes")
  })()
  return cleanupPromise
}

async function waitFor(check, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(100)
  }
  throw Error(`Timed out: ${description}`)
}

async function deniedSocket(url, headers) {
  await new Promise((resolve, reject) => {
    const req = http.request(url.replace(/^ws:/, "http:"), {
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": "vite-hmr",
      },
    })
    const timer = setTimeout(() => req.destroy(Error("WS denial timed out")), 5000)
    req.on("upgrade", (_response, socket) => {
      clearTimeout(timer)
      socket.destroy()
      reject(Error("Unauthorized websocket opened"))
    })
    req.on("response", (response) => {
      clearTimeout(timer)
      response.resume()
      try {
        assert.equal(response.statusCode, 403)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
}

async function main() {
  const lockPath = path.join(os.tmpdir(), `plugin-source-hmr-${hash(root).slice(0, 16)}.lock`)
  fs.mkdirSync(lockPath) // Fail closed on overlapping edits, including a stale crash lock.
  lock = lockPath
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, out }))
  fs.mkdirSync(runtime)
  fs.cpSync(path.join(root, "web/parent-dist"), path.join(runtime, "web/parent-dist"), {
    recursive: true,
  })
  const version = JSON.parse(
    fs.readFileSync(path.join(root, "plugins/mison-booking/plugin.json")),
  ).version
  const releaseId = `fixture-release-${version}`
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
  const api = {
    "auth/me": {
      user: { id: "test-parent", nickname: "测试家长", loginName: "test-parent" },
      csrfToken: "fixture-csrf",
    },
    children: { children: [child] },
    "child-avatars": { avatars: [] },
    "children/a/context": { child, revision: 1 },
    "children/a/data": {
      format: "lele-task-manager-store",
      version: 1,
      revision: 1,
      updatedAt: null,
      context: { childId: "a", membershipVersion: "1" },
      data: {
        schemaVersion: 2,
        settings: { childName: "乐乐", weekStartsOn: 1 },
        categories: [],
        series: [],
        exceptions: [],
        completions: [],
        ledger: [],
        gifts: [],
        taskPresets: [],
        operationLog: [],
      },
    },
    "children/a/plugins": { plugins: [plugin] },
    "children/a/plugins/status": { plugins: [plugin] },
    "children/a/plugins/mison-booking/entry": {
      entry: `/plugin-assets/mison-booking/${version}/frontend/entry.js`,
      styles: [],
      version,
      releaseId,
    },
    "children/a/plugins/mison-booking/runtime/bootstrap": {
      ok: true,
      data: {
        connection: {
          status: "unbound",
          bindingRevision: 0,
          maskedAccount: null,
          contract: null,
          canManageConnection: true,
          lastCheckedAt: null,
        },
        serverDate: "2026-11-03",
        upcomingCount: 0,
        bookingLimits: { maxContiguousLessons: 6 },
        features: {},
        unresolvedOperations: [],
      },
    },
  }
  fs.writeFileSync(path.join(runtime, "api.json"), JSON.stringify(api))
  host = spawn(
    path.join(root, ".venv/bin/python"),
    ["tests/fixtures/plugin_dev_proxy.py", "--root", runtime],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONPATH: path.join(root, "backend"),
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stdout = "",
    stderr = "",
    spawnError
  host.on("error", (error) => {
    spawnError = error
  })
  host.stdout.on("data", (data) => {
    stdout += data
    fs.appendFileSync(path.join(out, "host.log"), data)
  })
  host.stderr.on("data", (data) => {
    stderr += data
    fs.appendFileSync(path.join(out, "host.log"), data)
  })
  await waitFor(() => {
    if (spawnError) throw spawnError
    if (host.exitCode !== null) throw Error(`FastAPI exited: ${stderr}`)
    return stdout.includes("\n")
  }, "FastAPI startup")
  origin = JSON.parse(stdout.split("\n")[0]).origin
  await waitFor(async () => {
    try {
      return (await fetch(origin)).ok
    } catch {
      return false
    }
  }, "HTTP listener")
  vite = await (
    await import("../../scripts/plugin_dev.mjs")
  ).createPluginDevServer("mison-booking", session, {
    ws: { host: "127.0.0.1", clientPort: Number(new URL(origin).port), protocol: "ws" },
  })
  const vitePort = vite.httpServer.address().port
  const upstream = []
  vite.httpServer.on("request", (req) =>
    upstream.push({
      url: req.url,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    }),
  )
  fs.mkdirSync(path.join(runtime, "registry"), { mode: 0o700 })
  fs.writeFileSync(
    path.join(runtime, "registry/mison-booking.json"),
    JSON.stringify({
      pluginId: "mison-booking",
      sessionId: session,
      port: vitePort,
      pid: process.pid,
      sourceRoot: path.join(root, "plugins/mison-booking"),
      revision: 1,
      state: "ready",
      backend: false,
      version,
      releaseId,
    }),
    { mode: 0o600 },
  )
  const headers = {
    Cookie: `lele_parent=${token}`,
    Authorization: "Bearer fixture-must-not-forward",
  }
  const request = (resource, authenticated = true) =>
    fetch(origin + resource, {
      headers: authenticated ? headers : {},
      signal: AbortSignal.timeout(20000),
      redirect: "manual",
    })
  for (const resource of [
    "@plugin-entry",
    "@vite/client",
    "frontend/app.tsx",
    "frontend/style.css",
    "__dev_health",
  ]) {
    const before = upstream.length
    const response = await request(base + resource, false)
    assert.equal(response.status, 403, resource)
    assert.equal(upstream.length, before, "Denied source request must never reach Vite")
    assert.equal((await response.text()).includes("import "), false)
  }
  assert.equal(
    (await request(base.replace(session, "stale-session") + "@plugin-entry")).status,
    409,
  )
  checks.push("anonymous HTTP resources denied before Vite; stale session rejected")
  for (const resource of [
    "/plugins/mison-booking/frontend/app.tsx",
    "/frontend/parent/src/App.tsx",
    "/@fs/" + path.join(root, "plugins/mison-booking/frontend/app.tsx"),
    base + "backend/mison_booking/__init__.py",
    base + "plugin.json",
    base + "@fs/" + path.join(root, "backend/lele_growth/accounts_app.py"),
    base + "@fs/" + path.join(root, "package.json"),
  ]) {
    const response = await request(resource)
    assert.ok([400, 403, 404].includes(response.status), `${resource}: ${response.status}`)
    const body = await response.text()
    assert.ok(
      !body.includes('"manifestVersion"') &&
        !body.includes("def create_app(") &&
        !body.includes('"lele-growth"'),
    )
  }
  checks.push("source/config/backend paths cannot escape the Vite frontend allowlist")
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
  })
  await context.addCookies([
    { name: "lele_parent", value: token, url: origin, httpOnly: true, sameSite: "Strict" },
  ])
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      blocked.push(route.request().url())
      return route.abort()
    }
    return route.continue()
  })
  await context.addInitScript(() => {
    window.__proxyCspViolations = []
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__proxyCspViolations.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      })
    })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const frames = [],
    requests = []
  page.on("request", (req) => requests.push(req.url()))
  page.on("websocket", (ws) => {
    sockets.push(ws)
    ws.on("framereceived", ({ payload }) => {
      try {
        frames.push(JSON.parse(payload.toString()))
      } catch {}
    })
  })
  const documentResponse = await page.goto(origin)
  const csp = documentResponse.headers()["content-security-policy"]
  assert.match(csp, /script-src 'self';/)
  assert.match(csp, /connect-src 'self' https:\/\/file\.mison\.cn;/)
  assert.match(csp, /media-src 'self' https:\/\/mp\.mison\.cn https:\/\/file\.mison\.cn;/)
  assert.ok(!csp.includes("*"))
  assert.ok(!csp.includes("unsafe-eval"))
  await page.locator('[data-view="plugin:mison-booking"]').click()
  await page.getByRole("heading", { name: "请登录美森网课账号", exact: true }).waitFor()
  await page.getByRole("button", { name: "登录", exact: true }).waitFor()
  await waitFor(
    () => frames.some((frame) => frame.type === "connected"),
    "authenticated Vite WS connected",
  )
  assert.equal(sockets.length, 1, "No direct-port websocket fallback")
  const wsUrl = sockets[0].url()
  assert.equal(new URL(wsUrl).host, new URL(origin).host)
  assert.ok(new URL(wsUrl).pathname.startsWith(base))
  await deniedSocket(wsUrl, { Origin: origin })
  await deniedSocket(wsUrl, { Origin: "http://untrusted.invalid", Cookie: headers.Cookie })
  vite.ws.send({ type: "custom", event: "proxy-boundary-probe", data: session })
  await waitFor(
    () => frames.some((frame) => frame.event === "proxy-boundary-probe" && frame.data === session),
    "real Vite frame delivered through authenticated Python websocket",
  )
  checks.push(
    "built parent login renders under production CSP; authenticated WS uses FastAPI; anonymous/cross-origin WS denied",
  )
  await page.screenshot({ path: path.join(out, "login.png"), fullPage: true })
  if (sourceEdits) {
    const documentIdentity = randomUUID()
    await page.evaluate((value) => {
      window.__proxyDocumentIdentity = value
    }, documentIdentity)
    edit(
      "plugins/mison-booking/frontend/style.css",
      (text) =>
        text +
        "\n/* isolated FastAPI HMR probe */\n#mison-login-title { color: rgb(17, 83, 149) !important; }\n",
    )
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector("#mison-login-title")).color === "rgb(17, 83, 149)",
    )
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "update" &&
          frame.updates.some((update) => update.path.includes("style.css")),
      ),
    )
    checks.push("actual CSS file edit delivered by authenticated FastAPI WS and applied")
    const heading = "FastAPI proxy React HMR verified"
    edit("plugins/mison-booking/frontend/app.tsx", (text) =>
      text.replace("请登录美森网课账号", heading),
    )
    await page.getByRole("heading", { name: heading, exact: true }).waitFor()
    assert.ok(
      frames.some(
        (frame) =>
          frame.type === "update" &&
          frame.updates.some((update) => update.path.includes("app.tsx")),
      ),
    )
    assert.equal(
      await page.evaluate(() => window.__proxyDocumentIdentity),
      documentIdentity,
      "HMR must not reload parent document",
    )
    assert.equal(requests.filter((url) => url === origin + "/").length, 1)
    assert.equal(sockets.length, 1)
    assert.equal(await page.locator("vite-error-overlay").count(), 0)
    await page.screenshot({ path: path.join(out, "hmr.png"), fullPage: true })
    checks.push("actual React edit HMR without parent document reload")
  }
  const ownStyles = () => page.locator('style[data-vite-dev-id*="/plugins/mison-booking/"]').count()
  assert.ok((await ownStyles()) > 0)
  await page.locator('[data-view="calendar"]').click()
  await page.locator(".calendar-panel").waitFor()
  assert.ok((await ownStyles()) > 0, "development styles stay while the page plugin is suspended")
  assert.equal(await page.locator(".plugin-page[hidden]").count(), 1)
  await page.locator('[data-view="plugin:mison-booking"]').click()
  await page.locator("#mison-login-title").waitFor()
  assert.ok((await ownStyles()) > 0, "returning reuses the suspended development module")
  const registryFile = path.join(runtime, "registry/mison-booking.json")
  const descriptor = JSON.parse(fs.readFileSync(registryFile, "utf8"))
  fs.writeFileSync(registryFile, JSON.stringify({ ...descriptor, state: "draining" }))
  await page.getByText("开发模式 · 正在等待请求完成并重载…", { exact: true }).waitFor()
  fs.writeFileSync(registryFile, JSON.stringify({ ...descriptor, revision: 2 }))
  await waitFor(
    async () =>
      !(await page.getByText("开发模式 · 正在等待请求完成并重载…", { exact: true }).count()),
    "reload recovered without manual retry",
  )
  await page.locator("#mison-login-title").waitFor()
  assert.equal(sockets.length, 1, "backend reload keeps existing HMR client")
  checks.push("core navigation suspends the dev module; draining recovers automatically")
  violations.push(...(await page.evaluate(() => window.__proxyCspViolations)))
  assert.deepEqual(violations, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  assert.ok(upstream.length > 10)
  assert.ok(
    upstream.every((req) => !req.cookie && !req.authorization),
    "Parent credentials must never reach Vite",
  )
  await page.locator('[data-view="calendar"]').click()
  assert.ok((await ownStyles()) > 0, "styles remain suspended outside the plugin view")
  let oldSocketClosed = false
  sockets[0].on("close", () => {
    oldSocketClosed = true
  })
  fs.unlinkSync(registryFile)
  await waitFor(
    async () => (await ownStyles()) === 0,
    "session stop removes styles outside the plugin view",
  )
  await waitFor(() => oldSocketClosed, "old HMR connection closed on session stop")
  await page.locator('[data-view="calendar"]').waitFor()
  assert.equal(await ownStyles(), 0)
  checks.push("session stop disposes HMR connection and styles even outside plugin view")
  const calls = fs
    .readFileSync(path.join(runtime, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
  assert.ok(calls.some((call) => call.path.endsWith("/runtime/bootstrap")))
  assert.ok(calls.every((call) => call.method === "GET"))
  checks.push("no CSP/console errors, credential forwarding, external traffic or business writes")
  fs.writeFileSync(
    path.join(out, "transport.json"),
    JSON.stringify(
      {
        origin,
        vitePort,
        csp,
        websocket: wsUrl.replace(/\?.*/, "?token=REDACTED"),
        frames,
        requests,
        upstreamRequests: upstream.length,
      },
      null,
      2,
    ),
  )
}

const watchdog = setTimeout(() => {
  failure = Error("Integration exceeded 150 second bound")
  void cleanup().finally(() => {
    console.error(failure)
    process.exit(1)
  })
}, 150000)
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(1))
  })
main()
  .catch((error) => {
    failure = error
  })
  .finally(async () => {
    try {
      await cleanup()
    } catch (error) {
      failure = error
    }
    clearTimeout(watchdog)
    const report = {
      passed: !failure,
      mode: sourceEdits ? "http-ws-csp-and-source-hmr" : "http-ws-csp-without-source-edits",
      checks,
      evidence: out,
      sourceRestored: edited.map(({ file, before }) => ({
        file,
        sha256: before,
        restored: hash(fs.readFileSync(file)) === before,
      })),
      runtimeRemoved: !fs.existsSync(runtime),
      errors,
      violations,
      blocked,
      ...(failure ? { failure: failure.stack } : {}),
    }
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = failure ? 1 : 0
  })
