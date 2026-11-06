/* Independent parent UI acceptance: Vite + in-memory API fixtures, no database or built output. */
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { chromium } = require("playwright")
const { default: AxeBuilder } = require("@axe-core/playwright")

const root = path.resolve(__dirname, "../..")
const out = fs.mkdtempSync(path.join(os.tmpdir(), "lele-plugin-parent-"))
const schema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      title: "提醒内容",
      description: "所有家人共享",
      default: "一起成长",
      group: "提醒设置",
    },
    count: {
      type: "integer",
      title: "每天次数",
      minimum: 1,
      maximum: 5,
      default: 2,
      group: "提醒设置",
    },
    active: { type: "boolean", title: "接收提醒", default: false, group: "投递设置" },
    channel: {
      type: "string",
      title: "提醒方式",
      enum: ["站内", "记录"],
      default: "站内",
      group: "投递设置",
    },
    zone: {
      type: "string",
      title: "时区",
      format: "timezone",
      default: "Asia/Shanghai",
      group: "投递设置",
    },
    weekdays: {
      type: "array",
      title: "提醒日期",
      items: { type: "string", enum: ["周一", "周二", "周三"] },
      default: [],
      group: "投递设置",
    },
  },
  required: ["title", "count", "active", "channel", "zone", "weekdays"],
}
const makePlugin = (id, name, extra = {}) => ({
  id,
  name,
  description: `${name}的介绍`,
  instructions: "配置由当前儿童的家人共享。",
  icon: "",
  type: "page",
  publicationStatus: "published",
  scopeMode: "all",
  childIds: [],
  version: "1.0.0",
  releaseId: `${id}-r1`,
  operationState: "ready",
  revision: 2,
  sortOrder: 1,
  installed: true,
  enabled: true,
  effectiveEnabled: true,
  requiresReenable: false,
  configRequired: false,
  configRevision: 4,
  reason: null,
  configSchema: schema,
  ...extra,
})
const boundedSchema = {
  ...schema,
  properties: {
    ...schema.properties,
    weekdays: {
      ...schema.properties.weekdays,
      minItems: 2,
      maxItems: 2,
      default: ["周一", "周三"],
      description: "选择每周提醒日期。",
    },
  },
}
const initial = [
  makePlugin("page-demo", "成长随记"),
  makePlugin("service-demo", "后台提醒", { type: "service", configSchema: boundedSchema }),
  makePlugin("disabled-demo", "停用示例", { enabled: false, effectiveEnabled: false }),
  makePlugin("new-demo", "新应用", { installed: false, enabled: false, effectiveEnabled: false }),
  makePlugin("slow-demo", "慢加载示例"),
  makePlugin("bad-demo", "错误示例"),
  makePlugin("unsafe-demo", "非法地址示例"),
]
const state = {
  plugins: { a: structuredClone(initial), b: [makePlugin("page-demo", "乙的随记")] },
  configs: new Map(),
  configCalls: [],
  writes: [],
  runtimeCalls: [],
  statusCalls: [],
  catalogCalls: [],
  assets: [],
  errors: [],
  consoleErrors: [],
  gates: new Map(),
  conflictNext: false,
  offlineStatus: false,
  failEnableNext: false,
}
const child = (id, role = "owner") => ({
  id,
  name: id === "a" ? "甲" : "乙",
  role,
  archived: false,
  membershipVersion: "1",
})
const fixture = (id) => ({
  format: "lele-task-manager-store",
  version: 1,
  revision: 1,
  updatedAt: null,
  context: { childId: id, membershipVersion: "1" },
  data: {
    schemaVersion: 2,
    settings: { childName: id, weekStartsOn: 1 },
    categories: [],
    series: [],
    exceptions: [],
    completions: [],
    ledger: [],
    gifts: [],
    taskPresets: [],
    operationLog: [],
  },
})
const getPlugin = (id, pluginId) => state.plugins[id].find((plugin) => plugin.id === pluginId)
const configFor = (id, pluginId) => {
  const key = `${id}:${pluginId}`
  if (!state.configs.has(key))
    state.configs.set(key, {
      title: id === "a" ? "甲的提醒" : "乙的提醒",
      count: 2,
      active: false,
      channel: "站内",
      zone: "Asia/Shanghai",
    })
  return state.configs.get(key)
}
function gate(key) {
  let release, capture
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const captured = new Promise((resolve) => {
    capture = resolve
  })
  state.gates.set(key, { wait, capture })
  return {
    captured,
    release: () => {
      state.gates.delete(key)
      release()
    },
  }
}
async function gated(key) {
  const value = state.gates.get(key)
  if (value) {
    value.capture()
    await value.wait
  }
}
async function mock(context, role) {
  await context.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method()
    const json = (value, status = 200) => route.fulfill({ status, json: value })
    if (url.pathname === "/api/auth/me")
      return json({
        user: { id: `user-${role}`, nickname: "测试家人", loginName: "test-parent" },
        csrfToken: "fixture-csrf",
      })
    if (url.pathname === "/api/children")
      return json({ children: [child("a", role), child("b", role)] })
    if (url.pathname.endsWith("/members")) return json({ members: [] })
    if (url.pathname.endsWith("/invitations")) return json({ invitations: [] })
    const match = url.pathname.match(/^\/api\/children\/([ab])\/(.*)$/)
    if (!match) return json({ avatars: [], invitations: [] })
    const [, id, tail] = match
    if (tail === "data") return json(fixture(id))
    if (tail === "context") return json({ child: child(id, role), revision: 1 })
    if (tail === "plugins/status") {
      state.statusCalls.push({ id, role, time: Date.now() })
      const response = structuredClone({ plugins: state.plugins[id] })
      await gated(`${id}:status`)
      return state.offlineStatus ? json({ error: "状态暂时离线" }, 503) : json(response)
    }
    if (tail === "plugins") {
      const query = url.searchParams.get("q") || ""
      const view = url.searchParams.get("view")
      state.catalogCalls.push({ id, role, view, query })
      await gated(`${id}:catalog:${view}`)
      return json({
        plugins: state.plugins[id].filter(
          (plugin) =>
            plugin.name.includes(query) &&
            (url.searchParams.get("view") !== "installed" || plugin.installed),
        ),
      })
    }
    const parts = tail.split("/"),
      pluginId = parts[1],
      action = parts[2]
    const plugin = getPlugin(id, pluginId)
    if (!plugin) return json({ error: "没有此应用" }, 404)
    if (action === "entry") {
      assert.equal(plugin.type, "page")
      assert.equal(plugin.effectiveEnabled, true)
      assert.equal(request.headers()["x-plugin-frontend-api"], "1.1")
      const response = {
        entry:
          pluginId === "unsafe-demo"
            ? "https://example.invalid/evil.js"
            : `/plugin-assets/${pluginId}/${plugin.version}/entry.js`,
        styles: [`/plugin-assets/${pluginId}/${plugin.version}/style.css`],
        version: plugin.version,
        releaseId: plugin.releaseId,
        frontendApi: plugin.frontendApi || { major: 1, minMinor: 0 },
      }
      await gated(`${id}:${pluginId}:entry`)
      return json(response)
    }
    if (action === "runtime") {
      assert.equal(request.headers()["x-plugin-frontend-api"], "1.1")
      state.runtimeCalls.push({
        id,
        pluginId,
        path: parts.slice(3).join("/"),
        release: request.headers()["x-plugin-release"],
      })
      await gated(`${id}:${pluginId}:runtime`)
      return json({ message: `响应-${id}` })
    }
    if (action === "config" && method === "GET") {
      state.configCalls.push({ id, pluginId, role })
      const response = structuredClone({
        config: configFor(id, pluginId),
        schema: plugin.configSchema,
        revision: plugin.configRevision,
        plugin,
      })
      await gated(`${id}:${pluginId}:config`)
      return json(response)
    }
    const body = request.postDataJSON()
    state.writes.push({ id, pluginId, action, method, body })
    assert.equal(role, "owner", "Member must never send a management write")
    assert.ok(body.operationId)
    if (action === "config") {
      if (state.conflictNext || body.expectedRevision !== plugin.configRevision) {
        state.conflictNext = false
        return json({ error: "配置冲突", kind: "plugin_config_conflict" }, 409)
      }
      state.configs.set(`${id}:${pluginId}`, body.config)
      plugin.configRevision++
      plugin.revision++
      plugin.configRequired = false
      return json({
        config: body.config,
        schema: plugin.configSchema,
        revision: plugin.configRevision,
        plugin,
      })
    }
    assert.equal(body.expectedRevision, plugin.revision)
    if (action === "enable" && state.failEnableNext) {
      state.failEnableNext = false
      return json({ error: "模拟启用失败" }, 503)
    }
    plugin.revision++
    if (action === "install") {
      plugin.installed = true
      plugin.enabled = false
      plugin.effectiveEnabled = false
    }
    if (action === "enable") {
      plugin.enabled = true
      plugin.effectiveEnabled = true
      plugin.requiresReenable = false
    }
    if (action === "disable") {
      plugin.enabled = false
      plugin.effectiveEnabled = false
    }
    if (action === "installation") {
      assert.equal(method, "DELETE")
      plugin.installed = false
      plugin.enabled = false
      plugin.effectiveEnabled = false
    }
    return json({ plugin })
  })
  await context.route("**/plugin-assets/**", async (route) => {
    const url = new URL(route.request().url()),
      [, , id, version, file] = url.pathname.split("/")
    state.assets.push(url.pathname)
    await gated(`asset:${id}:${version}:${file}`)
    if (file === "style.css")
      return route.fulfill({
        contentType: "text/css",
        body: `[data-plugin-root="${id}"] { padding: 16px; }`,
      })
    const body = `
      window.__moduleEvaluations = (window.__moduleEvaluations || []).concat(${JSON.stringify(id + ":" + version)});
      export function mount(container, context) {
        if (${JSON.stringify(id)} === 'bad-demo') throw new Error('fixture mount failure');
        window.__pluginEvents = (window.__pluginEvents || []);
        window.__pluginEvents.push('mount:' + context.child.id + ':${id}:${version}');
        window.__heldPluginApi = () => context.api('echo');
        container.innerHTML = '<p data-plugin-child></p><button data-plugin-api>调用应用</button>';
        container.querySelector('[data-plugin-child]').textContent = '应用儿童：' + context.child.name;
        container.querySelector('button').onclick = () => context.api('echo').then(r => {
          window.__pluginEvents.push('api:' + r.message);
        }).catch(() => window.__pluginEvents.push('api-aborted:' + context.child.id));
        context.signal.addEventListener('abort', () => window.__pluginEvents.push('abort:' + context.child.id + ':${id}'));
        return () => { window.__pluginEvents.push('dispose:' + context.child.id + ':${id}'); container.replaceChildren(); };
      }
    `
    return route.fulfill({ contentType: "application/javascript", body })
  })
}
async function settings(page) {
  await page.locator('[data-view="settings"]').click()
  if (await page.locator("#openApplicationSettings").isVisible())
    await page.locator("#openApplicationSettings").click()
  else {
    await page.getByRole("button", { name: "打开设置菜单", exact: true }).click()
    await page.locator("#mobileOpenApplicationSettings").click()
    await page.getByRole("dialog", { name: "设置菜单", exact: true }).waitFor({ state: "hidden" })
  }
  await page.locator('[data-plugin-id="service-demo"]').waitFor()
}
async function focus(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
}
async function switchChild(page, id) {
  await page.locator("#openChildrenDialog").click()
  await page.locator(`[data-child-card="${id}"]`).click()
  await page.waitForURL(`**/children/${id}`)
  await page.locator("#calendarTitle").waitFor()
}
async function checkA11y(page) {
  await page.locator("#pluginConfigDialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  assert.deepEqual(
    result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    [],
  )
}
async function run() {
  const { createServer } = await import("vite")
  const server = await createServer({
    configFile: path.join(root, "frontend/parent/vite.config.mts"),
    cacheDir: path.join(out, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null, hmr: false },
  })
  let browser
  const checks = []
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch({ headless: true })
    const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await mock(owner, "owner")
    const page = await owner.newPage()
    page.setDefaultTimeout(12000)
    page.on("pageerror", (error) => state.errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error" && !/status of (409|503)/.test(message.text()))
        state.consoleErrors.push(message.text())
    })
    await page.goto(`${origin}/parent-assets/`)
    await page.locator('[data-view="plugin:page-demo"]').waitFor()
    assert.equal(await page.title(), "成长计划")
    assert.equal(
      await page
        .locator('[data-view="plugin:service-demo"], [data-view="plugin:disabled-demo"]')
        .count(),
      0,
    )
    assert.equal(state.assets.length, 0)
    await settings(page)
    assert.equal(state.assets.length, 0)
    await page.locator("#pluginSearch").fill("不存在的应用")
    await page.getByText("没有找到匹配的应用", { exact: true }).waitFor()
    await page.getByRole("tab", { name: "已安装", exact: true }).click()
    await page.getByText("没有找到匹配的应用", { exact: true }).waitFor()
    const callsBeforeSwitch = state.catalogCalls.length
    await page.evaluate(() => {
      window.catalogFlashes = []
      window.catalogObserver = new MutationObserver(() => {
        if (document.querySelector('[aria-label="正在读取应用"]'))
          window.catalogFlashes.push("loading")
      })
      window.catalogObserver.observe(document.querySelector(".applications-content"), {
        childList: true,
        subtree: true,
      })
    })
    for (const name of ["发现应用", "已安装", "发现应用", "已安装"]) {
      await page.getByRole("tab", { name, exact: true }).click()
      assert.match(await page.getByRole("tabpanel").innerText(), /没有找到匹配的应用/)
    }
    assert.equal(state.catalogCalls.length, callsBeforeSwitch)
    const availableRefresh = gate("a:catalog:available")
    const installedRefresh = gate("a:catalog:installed")
    getPlugin("a", "page-demo").description = "后台刷新验证"
    await page.evaluate(async () => {
      const { pluginStore } = await import("/parent-assets/src/plugins/store.ts")
      await pluginStore.refresh()
    })
    await Promise.all([availableRefresh.captured, installedRefresh.captured])
    await page.getByRole("tab", { name: "发现应用", exact: true }).click()
    assert.match(await page.getByRole("tabpanel").innerText(), /没有找到匹配的应用/)
    assert.equal(await page.getByLabel("正在读取应用", { exact: true }).count(), 0)
    availableRefresh.release()
    installedRefresh.release()
    assert.deepEqual(await page.evaluate(() => window.catalogFlashes), [])
    await page.evaluate(() => window.catalogObserver.disconnect())
    checks.push(
      "cached empty tabs switch without requests or loading flashes, including delayed background refresh",
    )
    await page.locator("#pluginSearch").fill("后台")
    await page.waitForFunction(() => document.querySelectorAll(".application-card").length === 1)
    assert.match(await page.locator(".application-card").innerText(), /后台提醒/)
    await page.locator("#pluginSearch").fill("")
    await page.locator('[data-plugin-id="page-demo"]').waitFor()
    await page.getByRole("tab", { name: "已安装", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-plugin-id="new-demo"]'))
    await page.getByRole("tab", { name: "发现应用", exact: true }).click()
    await page.locator('[data-plugin-install="new-demo"]').click()
    await page.locator('[data-plugin-enable="new-demo"]').waitFor()
    assert.equal(state.assets.length, 0)
    checks.push(
      "discovery/search/installed views, owner installation, no eager assets or service tabs",
    )

    await page.locator('[data-plugin-config="service-demo"]').click()
    const dialog = page.locator("#pluginConfigDialog")
    await dialog.getByLabel("提醒内容", { exact: false }).fill("共享的新提醒")
    assert.equal(await dialog.getByRole("button", { name: "重新读取", exact: true }).count(), 0)
    await dialog.getByLabel("每天次数", { exact: false }).fill("8")
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog.getByText("不能大于 5。", { exact: true }).waitFor()
    assert.equal(state.writes.filter((w) => w.action === "config").length, 0)
    await dialog.getByLabel("每天次数", { exact: false }).fill("3")
    await dialog.getByText("选择每周提醒日期。 请选择 2 项。", { exact: true }).waitFor()
    await dialog.getByRole("checkbox", { name: "周一", exact: true }).uncheck()
    await dialog.getByRole("checkbox", { name: "周三", exact: true }).uncheck()
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog.getByText("至少选择 2 项。", { exact: true }).waitFor()
    assert.equal(state.writes.filter((write) => write.action === "config").length, 0)
    await dialog.getByRole("checkbox", { name: "周一", exact: true }).check()
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog.getByText("至少选择 2 项。", { exact: true }).waitFor()
    assert.equal(state.writes.filter((write) => write.action === "config").length, 0)
    assert.equal(
      await dialog.getByRole("checkbox", { name: "周一", exact: true }).isChecked(),
      true,
    )
    assert.equal(await dialog.getByLabel("提醒内容", { exact: false }).inputValue(), "共享的新提醒")
    await dialog.getByRole("checkbox", { name: "周二", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "周三", exact: true }).check()
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog.getByText("最多选择 2 项。", { exact: true }).waitFor()
    assert.equal(state.writes.filter((write) => write.action === "config").length, 0)
    assert.equal(
      await dialog
        .getByRole("checkbox")
        .evaluateAll(
          (options) =>
            options.filter((option) => option.getAttribute("aria-checked") === "true").length,
        ),
      3,
    )
    await dialog.getByRole("checkbox", { name: "周二", exact: true }).uncheck()
    await dialog.getByRole("switch").click()
    await dialog.getByRole("checkbox", { name: "周一", exact: true }).check()
    await dialog.getByRole("checkbox", { name: "周三", exact: true }).check()
    assert.equal(await dialog.getByRole("group", { name: "投递设置", exact: true }).count(), 1)
    assert.equal(await dialog.getByRole("group", { name: "提醒设置", exact: true }).count(), 1)
    await dialog.getByRole("combobox").click()
    await page.getByRole("option", { name: "记录", exact: true }).click()
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-plugin-config") === "service-demo",
    )
    await page
      .getByText("应用配置已保存，当前儿童的家人共享此配置。", { exact: true })
      .first()
      .waitFor()
    assert.equal(configFor("a", "service-demo").title, "共享的新提醒")
    assert.equal(configFor("a", "service-demo").active, true)
    assert.equal(configFor("a", "service-demo").channel, "记录")
    assert.deepEqual(configFor("a", "service-demo").weekdays, ["周一", "周三"])
    assert.equal(state.writes.find((w) => w.action === "config").body.expectedRevision, 4)
    assert.equal(state.assets.length, 0)
    await page.locator('[data-plugin-config="service-demo"]').click()
    await dialog.getByLabel("提醒内容", { exact: false }).waitFor()
    assert.equal(await dialog.getByLabel("提醒内容", { exact: false }).inputValue(), "共享的新提醒")
    await checkA11y(page)
    await page.screenshot({ path: path.join(out, "config-desktop.png") })
    state.conflictNext = true
    await dialog.getByLabel("提醒内容", { exact: false }).fill("冲突草稿")
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click()
    await dialog
      .getByText("配置或版本已更新。请重新读取，核对最新配置后再保存。", { exact: true })
      .waitFor()
    assert.equal(await dialog.getByLabel("提醒内容", { exact: false }).inputValue(), "冲突草稿")
    assert.equal(
      await dialog.getByRole("button", { name: "保存配置", exact: true }).isDisabled(),
      true,
    )
    await dialog.getByRole("button", { name: "重新读取", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector("#pluginConfigField-0")?.value === "共享的新提醒",
    )
    const configReadsBefore = state.configCalls.filter((call) => call.role === "owner").length
    await dialog.getByLabel("提醒内容", { exact: false }).fill("本地尚未保存的草稿")
    await page.evaluate(async () => {
      const { pluginStore } = await import("/parent-assets/src/plugins/store.ts")
      await pluginStore.refresh()
      await pluginStore.refresh()
      await pluginStore.refresh()
    })
    assert.equal(
      state.configCalls.filter((call) => call.role === "owner").length,
      configReadsBefore,
    )
    assert.equal(
      await dialog.getByLabel("提醒内容", { exact: false }).inputValue(),
      "本地尚未保存的草稿",
    )
    getPlugin("a", "service-demo").configRevision++
    configFor("a", "service-demo").count = 4
    await focus(page)
    await dialog
      .getByText("配置或版本已更新。请重新读取，核对最新配置后再保存。", { exact: true })
      .waitFor()
    assert.equal(
      await dialog.getByLabel("提醒内容", { exact: false }).inputValue(),
      "本地尚未保存的草稿",
    )
    assert.equal(
      await dialog.getByRole("button", { name: "保存配置", exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      state.configCalls.filter((call) => call.role === "owner").length,
      configReadsBefore,
    )
    await dialog.getByRole("button", { name: "重新读取", exact: true }).click()
    await page.waitForFunction(() => document.querySelector("#pluginConfigField-1")?.value === "4")
    assert.equal(await dialog.getByLabel("提醒内容", { exact: false }).inputValue(), "共享的新提醒")
    await dialog.getByRole("button", { name: "关闭", exact: true }).last().click()
    const arrayValidation = await page.evaluate(async () => {
      const { configDraft, validateConfig, schemaProblem } =
        await import("/parent-assets/src/plugins/config-schema.ts")
      const schema = {
        type: "object",
        properties: {
          days: {
            type: "array",
            items: { type: "string", enum: ["mon", "tue"] },
            default: [],
            group: "Schedule",
          },
        },
        required: ["days"],
      }
      const bounded = {
        ...schema,
        properties: {
          days: {
            ...schema.properties.days,
            items: { type: "string", enum: ["mon", "tue", "wed"] },
            minItems: 2,
            maxItems: 2,
          },
        },
      }
      return {
        countZero: validateConfig({ days: [] }, bounded).errors,
        countOne: validateConfig({ days: ["mon"] }, bounded).errors,
        countTwo: validateConfig({ days: ["mon", "tue"] }, bounded),
        countThree: validateConfig({ days: ["mon", "tue", "wed"] }, bounded).errors,
        defaults: configDraft({}, schema),
        empty: validateConfig({ days: [] }, schema),
        duplicate: validateConfig({ days: ["mon", "mon"] }, schema).errors,
        invalid: validateConfig({ days: ["wed"] }, schema).errors,
        wrongType: validateConfig({ days: "mon" }, schema).errors,
        defaultUniqueSchema: schemaProblem(schema),
        falseUniqueSchema: schemaProblem({
          ...schema,
          properties: { days: { ...schema.properties.days, uniqueItems: false } },
        }),
        unsupported: schemaProblem({
          ...schema,
          properties: {
            days: { type: "array", items: { type: "number", enum: [1] }, uniqueItems: true },
          },
        }),
      }
    })
    assert.deepEqual(arrayValidation.defaults, { days: [] })
    assert.equal(arrayValidation.countZero.days, "至少选择 2 项。")
    assert.equal(arrayValidation.countOne.days, "至少选择 2 项。")
    assert.equal(arrayValidation.countThree.days, "最多选择 2 项。")
    assert.deepEqual(arrayValidation.countTwo, { config: { days: ["mon", "tue"] }, errors: {} })
    assert.deepEqual(arrayValidation.empty, { config: { days: [] }, errors: {} })
    assert.equal(arrayValidation.defaultUniqueSchema, "")
    assert.ok(arrayValidation.falseUniqueSchema)
    assert.ok(
      arrayValidation.duplicate.days &&
        arrayValidation.invalid.days &&
        arrayValidation.wrongType.days &&
        arrayValidation.unsupported,
    )
    checks.push(
      "schema scalar fields, grouped enum-array checkboxes, array defaults/type/uniqueness/enum validation, configRevision, conflict retains draft",
    )
    checks.push(
      "array minItems/maxItems: 0/1/3 rejected per field with no API writes and drafts preserved; 2 accepted with checkbox range guidance",
    )

    const member = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await mock(member, "parent")
    const memberPage = await member.newPage()
    memberPage.on("pageerror", (error) => state.errors.push(error.message))
    await memberPage.goto(`${origin}/parent-assets/`)
    await memberPage.locator('[data-view="plugin:page-demo"]').waitFor()
    await settings(memberPage)
    assert.equal(
      await memberPage
        .locator(
          "[data-plugin-install], [data-plugin-enable], [data-plugin-disable], [data-plugin-uninstall]",
        )
        .count(),
      0,
    )
    await memberPage.locator('[data-plugin-config="service-demo"]').click()
    const memberDialog = memberPage.locator("#pluginConfigDialog")
    await memberPage.waitForFunction(
      () => document.querySelector("#pluginConfigField-0")?.value === "共享的新提醒",
    )
    assert.equal(await memberDialog.locator("#pluginConfigField-0").isDisabled(), true)
    assert.equal(
      await memberDialog.getByRole("checkbox", { name: "周一", exact: true }).isChecked(),
      true,
    )
    assert.equal(
      await memberDialog.getByRole("checkbox", { name: "周一", exact: true }).isDisabled(),
      true,
    )
    assert.equal(
      await memberDialog.getByRole("button", { name: "保存配置", exact: true }).count(),
      0,
    )
    await memberDialog.getByRole("button", { name: "关闭", exact: true }).last().click()
    await memberPage.locator('[data-view="plugin:page-demo"]').click()
    await memberPage.getByText("应用儿童：甲", { exact: true }).waitFor()
    await memberPage.locator('[data-view="calendar"]').click()
    checks.push("second family member reads shared config, uses pages, has no management controls")

    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.getByText("应用儿童：甲", { exact: true }).waitFor()
    await page.locator("[data-plugin-api]").click()
    await page.waitForFunction(() => window.__pluginEvents?.includes("api:响应-a"))
    assert.equal(state.runtimeCalls.at(-1).release, "page-demo-r1")
    const runtimeGate = gate("a:page-demo:runtime")
    await page.locator("[data-plugin-api]").click()
    await runtimeGate.captured
    const mountsBeforeLeave = await page.evaluate(
      () => window.__pluginEvents.filter((event) => event === "mount:a:page-demo:1.0.0").length,
    )
    await page.locator('[data-view="calendar"]').click()
    runtimeGate.release()
    await page.waitForFunction(
      () => window.__pluginEvents.filter((event) => event === "api:响应-a").length >= 2,
    )
    assert.equal(await page.locator("[data-plugin-root]").count(), 1)
    assert.equal(await page.locator(".plugin-page[hidden]").count(), 1)
    assert.equal(await page.locator(".plugin-overlay[hidden]").count(), 1)
    assert.ok((await page.locator('link[href*="/plugin-assets/"]').count()) > 0)
    assert.equal(
      await page.evaluate(() =>
        window.__pluginEvents.some(
          (event) => event.startsWith("dispose:") || event.startsWith("abort:"),
        ),
      ),
      false,
    )
    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.getByText("应用儿童：甲", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        () => window.__pluginEvents.filter((event) => event === "mount:a:page-demo:1.0.0").length,
      ),
      mountsBeforeLeave,
    )
    assert.equal(await page.locator(".plugin-page[hidden]").count(), 0)
    checks.push("core views keep the mounted page plugin, its request and styles")

    await page.locator('[data-view="plugin:slow-demo"]').click()
    await page.locator('[data-plugin-root="slow-demo"]').waitFor()
    const mountsAfterSecondPlugin = await page.evaluate(() => ({
      page: window.__pluginEvents.filter((event) => event === "mount:a:page-demo:1.0.0").length,
      slow: window.__pluginEvents.filter((event) => event === "mount:a:slow-demo:1.0.0").length,
    }))
    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.locator('[data-plugin-root="page-demo"]').waitFor()
    assert.equal(await page.locator("[data-plugin-root]").count(), 2)
    assert.equal(
      await page.locator('.plugin-page[hidden] [data-plugin-root="slow-demo"]').count(),
      1,
    )
    assert.equal(await page.locator(".plugin-overlay[hidden]").count(), 1)
    assert.equal(await page.locator(".plugin-overlay:not([hidden])").count(), 1)
    await page.locator('[data-view="plugin:slow-demo"]').click()
    await page.locator('[data-plugin-root="slow-demo"]').waitFor()
    assert.deepEqual(
      await page.evaluate(() => ({
        page: window.__pluginEvents.filter((event) => event === "mount:a:page-demo:1.0.0").length,
        slow: window.__pluginEvents.filter((event) => event === "mount:a:slow-demo:1.0.0").length,
      })),
      mountsAfterSecondPlugin,
    )
    await page.locator('[data-view="calendar"]').click()
    assert.equal(await page.locator("[data-plugin-root]").count(), 2)
    assert.equal(await page.locator(".plugin-page[hidden]").count(), 2)
    assert.equal(await page.locator(".plugin-overlay[hidden]").count(), 2)
    assert.equal(
      await page.evaluate(() =>
        window.__pluginEvents.some((event) => event.startsWith("dispose:")),
      ),
      false,
    )
    checks.push("switching page plugins keeps every visited plugin mounted")

    await page.locator('[data-view="plugin:page-demo"]').click()
    const switchGate = gate("a:page-demo:runtime")
    await page.locator('[data-plugin-root="page-demo"] [data-plugin-api]').click()
    await switchGate.captured
    await switchChild(page, "b")
    switchGate.release()
    await page.waitForFunction(
      () =>
        window.__pluginEvents?.includes("dispose:a:page-demo") &&
        window.__pluginEvents?.includes("dispose:a:slow-demo") &&
        window.__pluginEvents?.includes("api-aborted:a") &&
        window.__pluginEvents?.includes("abort:a:page-demo") &&
        window.__pluginEvents?.includes("abort:a:slow-demo"),
    )
    assert.equal(await page.locator("[data-plugin-root]").count(), 0)
    assert.equal(await page.locator('link[href*="/plugin-assets/"]').count(), 0)
    assert.equal(await page.locator(".plugin-overlay").count(), 0)
    await switchChild(page, "a")
    checks.push("child switch disposes every retained plugin and aborts its request")

    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.getByText("应用儿童：甲", { exact: true }).waitFor()
    getPlugin("a", "page-demo").operationState = "updating"
    getPlugin("a", "page-demo").effectiveEnabled = false
    await focus(page)
    await page.getByRole("heading", { name: "应用更新中", exact: true }).waitFor()
    assert.equal(await page.locator('[data-view="plugin:page-demo"]').count(), 1)
    assert.equal(await page.locator("[data-plugin-root]").count(), 0)
    Object.assign(getPlugin("a", "page-demo"), {
      operationState: "ready",
      effectiveEnabled: true,
      version: "1.1.0",
      releaseId: "page-demo-r2",
    })
    await focus(page)
    await page.getByText("应用儿童：甲", { exact: true }).waitFor()
    assert.ok(state.assets.includes("/plugin-assets/page-demo/1.1.0/entry.js"))
    await page.locator("[data-plugin-api]").click()
    await page.waitForFunction(
      () => window.__pluginEvents?.filter((e) => e === "api:响应-a").length >= 2,
    )
    assert.equal(state.runtimeCalls.at(-1).release, "page-demo-r2")
    checks.push(
      "updating tab placeholder survives, old instance disposed, new release mounts with new header",
    )

    await settings(page)
    await page.locator('[data-plugin-more="page-demo"]').click()
    await page.locator('[data-plugin-disable="page-demo"]').click()
    await page.waitForFunction(() => !document.querySelector('[data-view="plugin:page-demo"]'))
    await focus(memberPage)
    await memberPage.waitForFunction(
      () => !document.querySelector('[data-view="plugin:page-demo"]'),
    )
    await page.locator('[data-plugin-config="page-demo"]').click()
    await dialog.locator("#pluginConfigField-0").waitFor()
    assert.equal(await dialog.locator("#pluginConfigField-0").isDisabled(), false)
    await dialog.getByRole("button", { name: "关闭", exact: true }).last().click()
    await page.locator('[data-plugin-more="page-demo"]').click()
    await page.locator('[data-plugin-uninstall="page-demo"]').click()
    await page.getByRole("alertdialog").getByRole("button", { name: "卸载", exact: true }).click()
    await page.locator('[data-plugin-install="page-demo"]').waitFor()
    assert.ok(state.configs.has("a:page-demo"))
    assert.equal(state.writes.at(-1).method, "DELETE")
    await page.locator('[data-plugin-install="page-demo"]').click()
    await page.locator('[data-plugin-enable="page-demo"]').click()
    await page.locator('[data-view="plugin:page-demo"]').waitFor()
    checks.push(
      "shared disable removes tabs, disabled config remains editable, uninstall preserves config, reinstall/enable",
    )

    getPlugin("a", "slow-demo").version = "1.0.1"
    const slow = gate("asset:slow-demo:1.0.1:entry.js")
    await page.locator('[data-view="plugin:slow-demo"]').click()
    await slow.captured
    await switchChild(page, "b")
    slow.release()
    await page.waitForFunction(() => window.__moduleEvaluations?.includes("slow-demo:1.0.1"))
    assert.equal(await page.locator("[data-plugin-root]").count(), 0)
    assert.equal(
      await page.evaluate(() =>
        window.__pluginEvents.some((e) => e.includes("mount:a:slow-demo:1.0.1")),
      ),
      false,
    )
    assert.equal(await page.locator('[data-view="plugin:service-demo"]').count(), 0)
    checks.push("slow native import after child switch never mounts old child")

    await switchChild(page, "a")
    await settings(page)
    const slowConfig = gate("a:service-demo:config")
    await page.locator('[data-plugin-config="service-demo"]').click()
    await slowConfig.captured
    await page.evaluate(async () => {
      const { runtime } = await import("/parent-assets/src/lib/runtime.ts")
      await runtime.selectChild("b")
    })
    slowConfig.release()
    await page.locator("#calendarTitle").waitFor()
    assert.equal(await page.locator("#pluginConfigDialog").count(), 0)
    assert.equal(await page.getByText("共享的新提醒", { exact: true }).count(), 0)
    await switchChild(page, "a")
    const slowStatus = gate("a:status")
    await focus(page)
    await slowStatus.captured
    await switchChild(page, "b")
    slowStatus.release()
    await page.locator('[data-view="plugin:page-demo"]').waitFor()
    assert.equal(await page.locator('[data-view="plugin:bad-demo"]').count(), 0)
    checks.push("late config and status responses cannot expose previous child")

    await switchChild(page, "a")
    await page.locator('[data-view="plugin:bad-demo"]').click()
    await page.getByRole("heading", { name: "应用加载失败", exact: true }).waitFor()
    await page.locator('[data-view="calendar"]').click()
    await page.locator("#calendarTitle").waitFor()
    await page.locator('[data-view="plugin:unsafe-demo"]').click()
    await page.getByText("应用资源地址不受支持，请联系管理员。", { exact: true }).waitFor()
    assert.equal(
      state.assets.some((url) => url.includes("unsafe-demo")),
      false,
    )
    await page.locator('[data-view="calendar"]').click()
    const before = state.statusCalls.length
    await page.waitForFunction(() => document.visibilityState === "visible")
    await new Promise((resolve) => setTimeout(resolve, 5200))
    assert.ok(state.statusCalls.length > before)
    checks.push(
      "plugin mount failures isolated, external entry rejected before any resources, foreground 5-second polling",
    )

    await settings(page)
    await page.locator(".applications-content").waitFor()
    await page.waitForFunction(
      () => document.querySelector(".applications-content")?.getAttribute("aria-busy") === "false",
    )
    const catalogsBefore = state.catalogCalls.filter((call) => call.role === "owner").length
    await page.evaluate(async () => {
      const { pluginStore } = await import("/parent-assets/src/plugins/store.ts")
      await pluginStore.refresh()
      await pluginStore.refresh()
      await pluginStore.refresh()
    })
    assert.equal(
      state.catalogCalls.filter((call) => call.role === "owner").length,
      catalogsBefore,
      "Unchanged status refreshes must not refetch the catalog",
    )
    checks.push("unchanged status polling does not cause catalog or config network loops")

    // A response taking longer than the polling interval must complete once,
    // even when another interval and a focus event arrive while it is pending.
    const slowRead = gate("a:status")
    const statusBefore = state.statusCalls.filter((call) => call.role === "owner").length
    getPlugin("a", "page-demo").description = "六秒慢响应已完成"
    await focus(page)
    await slowRead.captured
    await new Promise((resolve) => setTimeout(resolve, 6100))
    await focus(page)
    assert.equal(state.statusCalls.filter((call) => call.role === "owner").length, statusBefore + 1)
    slowRead.release()
    await page.getByText("六秒慢响应已完成", { exact: true }).waitFor()
    checks.push(
      "6.1-second status response survives periodic/focus refresh with one coalesced request",
    )

    Object.assign(getPlugin("a", "page-demo"), {
      enabled: true,
      effectiveEnabled: false,
      requiresReenable: true,
    })
    await focus(page)
    const reenable = page.locator('[data-plugin-enable="page-demo"]')
    await reenable.waitFor()
    assert.equal(await reenable.innerText(), "重新启用")
    const beforeReenable = state.writes.length
    await reenable.click()
    await page.locator('[data-view="plugin:page-demo"]').waitFor()
    assert.deepEqual(
      state.writes.slice(beforeReenable).map((write) => write.action),
      ["enable"],
    )
    assert.equal(getPlugin("a", "page-demo").requiresReenable, false)
    checks.push(
      "enabled=true with requiresReenable offers direct owner re-enable without disable first",
    )

    await page.locator('[data-plugin-config="new-demo"]').click()
    await dialog.getByLabel("提醒内容", { exact: false }).fill("新应用配置后启用")
    const beforeCombined = state.writes.length
    const beforeCombinedRevision = getPlugin("a", "new-demo").revision
    await dialog.getByRole("button", { name: "保存并启用", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    const combined = state.writes.slice(beforeCombined)
    assert.deepEqual(
      combined.map((write) => write.action),
      ["config", "enable"],
    )
    assert.equal(combined[1].body.expectedRevision, beforeCombinedRevision + 1)
    assert.notEqual(combined[0].body.operationId, combined[1].body.operationId)
    assert.equal(getPlugin("a", "new-demo").effectiveEnabled, true)

    await page.locator('[data-plugin-config="disabled-demo"]').click()
    await dialog.getByLabel("提醒内容", { exact: false }).fill("启用失败也保留的草稿")
    state.failEnableNext = true
    await dialog.getByRole("button", { name: "保存并启用", exact: true }).click()
    await dialog.getByText("配置已保存，但启用失败：模拟启用失败", { exact: true }).waitFor()
    assert.equal(
      await dialog.getByLabel("提醒内容", { exact: false }).inputValue(),
      "启用失败也保留的草稿",
    )
    assert.equal(configFor("a", "disabled-demo").title, "启用失败也保留的草稿")
    assert.equal(getPlugin("a", "disabled-demo").enabled, false)
    await page.evaluate(async () => {
      const { pluginStore } = await import("/parent-assets/src/plugins/store.ts")
      await pluginStore.refresh()
    })
    assert.equal(
      await dialog.getByText("配置已保存，但启用失败：模拟启用失败", { exact: true }).isVisible(),
      true,
    )
    await dialog.getByRole("button", { name: "保存并启用", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(getPlugin("a", "disabled-demo").effectiveEnabled, true)
    checks.push(
      "save-and-enable sends config then enable with returned revision; failed enable preserves draft/error and retry succeeds",
    )

    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.getByText("应用儿童：甲", { exact: true }).waitFor()
    state.offlineStatus = true
    await focus(page)
    await page.getByRole("heading", { name: "应用状态未确认", exact: true }).waitFor()
    assert.equal(await page.locator("[data-plugin-root]").count(), 0)
    assert.equal(await page.locator('[data-view="plugin:page-demo"]').isDisabled(), true)
    const callsBeforeUnconfirmed = state.runtimeCalls.length
    const unconfirmedApi = await page.evaluate(async () => {
      try {
        await window.__heldPluginApi()
        return "unexpected-success"
      } catch (error) {
        return error.kind
      }
    })
    assert.equal(unconfirmedApi, "plugin_status_unconfirmed")
    assert.equal(state.runtimeCalls.length, callsBeforeUnconfirmed)
    await settings(page)
    for (const selector of [
      "[data-plugin-enable]",
      "[data-plugin-disable]",
      "[data-plugin-uninstall]",
      "[data-plugin-config]",
      "[data-plugin-open]",
      "[data-plugin-more]",
    ]) {
      assert.equal(
        await page
          .locator(selector)
          .evaluateAll((buttons) => buttons.every((button) => button.disabled)),
        true,
      )
    }
    const writesBeforeUnconfirmed = state.writes.length
    const rejected = await page.evaluate(async () => {
      const { pluginStore } = await import("/parent-assets/src/plugins/store.ts")
      const plugin = pluginStore.getSnapshot().plugins.find((item) => item.id === "page-demo")
      const results = await Promise.allSettled([
        pluginStore.manage("a", plugin, "disable"),
        pluginStore.saveConfig("a", plugin, {}, 0),
      ])
      return results.map((result) =>
        result.status === "rejected" ? result.reason.kind : "unexpected-success",
      )
    })
    assert.deepEqual(rejected, ["plugin_status_unconfirmed", "plugin_status_unconfirmed"])
    assert.equal(state.writes.length, writesBeforeUnconfirmed)
    state.offlineStatus = false
    await page.getByRole("button", { name: "刷新应用状态", exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector('[data-plugin-config="service-demo"]').disabled,
    )

    await page.locator('[data-plugin-config="service-demo"]').click()
    await dialog.getByLabel("提醒内容", { exact: false }).fill("状态未确认时保留的草稿")
    const readsBeforeUnconfirmed = state.configCalls.filter((call) => call.role === "owner").length
    state.offlineStatus = true
    await focus(page)
    await dialog
      .getByText("应用状态未确认，请刷新成功后再操作。配置草稿已保留。", { exact: true })
      .waitFor()
    assert.equal(
      await dialog.getByRole("button", { name: "保存配置", exact: true }).isDisabled(),
      true,
    )
    assert.equal(await dialog.getByRole("button", { name: "重新读取", exact: true }).count(), 0)
    assert.equal(
      await dialog.getByLabel("提醒内容", { exact: false }).inputValue(),
      "状态未确认时保留的草稿",
    )
    state.offlineStatus = false
    await dialog.getByRole("button", { name: "刷新状态", exact: true }).click()
    await page.waitForFunction(
      () => !document.querySelector('#pluginConfigDialog button[type="submit"]').disabled,
    )
    assert.equal(
      await dialog.getByLabel("提醒内容", { exact: false }).inputValue(),
      "状态未确认时保留的草稿",
    )
    assert.equal(
      state.configCalls.filter((call) => call.role === "owner").length,
      readsBeforeUnconfirmed,
    )
    await dialog.getByRole("button", { name: "关闭", exact: true }).last().click()
    checks.push(
      "unconfirmed status blocks management/config/open/business operations, disposes active code, and refresh recovers without clearing drafts or reloading config",
    )

    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    )
    await page.screenshot({ path: path.join(out, "applications-mobile.png"), fullPage: true })
    await page.locator('[data-plugin-config="service-demo"]').click()
    await dialog.locator("#pluginConfigField-0").waitFor()
    await checkA11y(page)
    const geometry = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect(),
        footer = element.querySelector('[data-slot="dialog-footer"]').getBoundingClientRect()
      return {
        bounded: box.top >= 0 && box.bottom <= innerHeight + 1,
        footerVisible: footer.bottom <= innerHeight + 1,
        bodyScrollable: element.querySelector(".plugin-config-body").clientHeight > 0,
      }
    })
    assert.deepEqual(geometry, { bounded: true, footerVisible: true, bodyScrollable: true })
    await page.screenshot({ path: path.join(out, "config-mobile.png") })
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-plugin-config") === "service-demo",
    )
    checks.push(
      "mobile width, bounded scrolling config dialog, keyboard dismissal/focus return, accessibility",
    )
    await page.setViewportSize({ width: 1280, height: 900 })
    const future = getPlugin("a", "page-demo")
    future.version = "1.0.99"
    future.releaseId = "page-demo-future"
    future.frontendApi = { major: 1, minMinor: 2 }
    await focus(page)
    await page.locator('[data-view="plugin:page-demo"]').click()
    await page.getByRole("heading", { name: "应用加载失败", exact: true }).waitFor()
    await page.getByText("此应用需要新版页面，请刷新整个页面后重试。", { exact: true }).waitFor()
    await page.getByRole("button", { name: "刷新页面", exact: true }).waitFor()
    assert.equal(
      state.assets.some((asset) => asset.includes("/page-demo/1.0.99/")),
      false,
    )
    await page.screenshot({ path: path.join(out, "frontend-protocol-refresh.png") })
    checks.push(
      "frontend API negotiation: 1.0 remains supported; incompatible requirements show whole-page refresh before importing code",
    )
    assert.deepEqual(state.errors, [])
    assert.deepEqual(state.consoleErrors, [])
    assert.equal(
      state.assets.some((asset) => /service-demo|disabled-demo|new-demo/.test(asset)),
      false,
    )
    console.log(JSON.stringify({ passed: true, checks, evidence: out }, null, 2))
  } catch (error) {
    if (browser)
      for (const [index, context] of browser.contexts().entries()) {
        const page = context.pages().at(-1)
        if (page) {
          await page.screenshot({ path: path.join(out, `failure-${index}.png`) }).catch(() => {})
          console.error((await page.locator("body").innerText()).slice(-4000))
        }
      }
    console.error({ evidence: out, pageErrors: state.errors, consoleErrors: state.consoleErrors })
    throw error
  } finally {
    if (browser) await browser.close()
    await server.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
