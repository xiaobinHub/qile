const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseEmptyPresets({ browser, dad, origin, firstId, out, axe, stage }) {
  stage("empty preset shortcut: click/keyboard navigation, cancel focus, preset save and reuse")
  for (const [width, height, touch] of [
    [1135, 789, false],
    [820, 1180, true],
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
    const errors = [],
      writes = []
    let pkg
    page.on("pageerror", (error) => errors.push(error.message))
    await context.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url())
      if (request.method() === "GET") {
        if (url.pathname !== `/api/children/${firstId}/data`) return route.continue()
        if (!pkg) {
          const response = await route.fetch()
          pkg = await response.json()
          pkg.data.taskPresets = []
        }
        return route.fulfill({ json: pkg })
      }
      const body = request.postDataJSON()
      writes.push(body)
      assert.equal(body.kind, "preset.save", "Shortcut never creates a task or other operation")
      pkg = {
        ...pkg,
        revision: pkg.revision + 1,
        data: { ...pkg.data, taskPresets: [{ ...body.payload.preset, id: "shortcut-preset" }] },
      }
      return route.fulfill({ json: pkg })
    })
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
      await page.screenshot({ path: path.join(out, `empty-presets-${width}-${name}.png`) })
    }
    try {
      await page.goto(`${origin}/children/${firstId}`)
      await page.locator("#newTaskBtn").click()
      await page.locator("#taskPresetToggle").click()
      const shortcut = page.getByRole("option", { name: /暂无常用任务，.*去添加。/ })
      await shortcut.waitFor()
      assert.equal(await shortcut.textContent(), "暂无常用任务，去添加。")
      await shot("entry")
      if (width === 1135 || width === 820) await axe(page, `empty-presets-entry-${width}`)
      await shortcut.click()
      const editor = page.locator("#taskPresetEditorDialog")
      await editor.waitFor()
      assert.equal(await page.locator("#taskDialog").count(), 0)
      assert.equal(await page.locator("#settingsDetailTitle").innerText(), "常用任务配置")
      assert.equal(
        await page.locator("#openTaskPresetsSettings").getAttribute("aria-current"),
        "page",
      )
      assert.equal(new URL(page.url()).pathname, `/children/${firstId}`)
      assert.equal(writes.length, 0)
      await page.waitForFunction(() =>
        document.querySelector("#taskPresetEditorDialog")?.contains(document.activeElement),
      )
      await shot("add")
      if (width === 1135 || width === 820) await axe(page, `empty-presets-add-${width}`)
      await editor.getByRole("button", { name: "取消", exact: true }).click()
      await editor.waitFor({ state: "hidden" })
      await page.waitForFunction(() => document.activeElement?.id === "settingsAddPreset")
      assert.equal(writes.length, 0)

      await page.locator('[data-view="calendar"]').click()
      await page.locator("#newTaskBtn").click()
      const title = page.locator("#taskTitle")
      await title.press("ArrowDown")
      await title.press("Enter")
      await editor.waitFor()
      assert.equal(await page.locator("#settingsDetailTitle").innerText(), "常用任务配置")
      await page.locator("#presetTitle").fill("快捷添加常用任务")
      await editor.getByRole("button", { name: "保存配置", exact: true }).click()
      await editor.waitFor({ state: "hidden" })
      await page
        .locator("#settingsTaskPresetsList")
        .getByText("快捷添加常用任务", { exact: true })
        .waitFor()
      assert.equal(writes.length, 1)
      assert.equal(writes[0].payload.preset.title, "快捷添加常用任务")

      await page.locator('[data-view="calendar"]').click()
      await page.locator("#newTaskBtn").click()
      await page.locator("#taskPresetToggle").click()
      await page.getByRole("option").filter({ hasText: "快捷添加常用任务" }).click()
      assert.equal(await title.inputValue(), "快捷添加常用任务")
      await title.fill("不存在的常用任务")
      await page.getByText("没有匹配的常用任务，可继续手动输入", { exact: true }).waitFor()
      assert.equal(await shortcut.count(), 0)
      await title.press("Escape")
      await page
        .getByText("没有匹配的常用任务，可继续手动输入", { exact: true })
        .waitFor({ state: "hidden" })
      await title.press("Escape")
      await page.locator("#taskDialog").waitFor({ state: "hidden" })
      await page.locator('[data-view="settings"]').click()
      assert.equal(
        await page.locator("#settingsDetailTitle").innerText(),
        "孩子昵称",
        "Normal settings entry keeps its existing landing pane",
      )
      assert.equal(writes.length, 1)
      assert.deepEqual(errors, [])
    } finally {
      await context.close()
    }
  }
}
module.exports = { exerciseEmptyPresets }
