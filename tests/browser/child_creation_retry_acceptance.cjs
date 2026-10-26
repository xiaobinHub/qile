const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')

async function exerciseChildCreationRetry({ browser, admin, origin, api, login, passwordSetup, passwords, axe, stage }) {
  stage('child creation retry: settings/onboarding, failed write, failed refresh and committed response loss')
  const account = await api(admin, '/api/admin/users', 'POST', {
    loginName: 'qacreationretry', nickname: '创建重试', password: passwords.initial,
  })
  assert.equal(account.status, 200)
  const context = await browser.newContext({ viewport: { width: 1305, height: 890 } })
  const page = await context.newPage(), errors = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  try {
    await login(page, 'qacreationretry', passwords.initial)
    await passwordSetup(page, passwords.dad)
    await login(page, 'qacreationretry', passwords.dad)
    assert.equal(new URL(page.url()).origin, origin)
    assert.ok((await page.title()).length)
    for (const failure of ['write-failed', 'refresh-failed', 'response-lost']) {
      for (const mode of ['onboarding', 'settings']) {
        const before = (await api(page, '/api/children')).children.length
        if (mode === 'settings') {
          await page.setViewportSize({ width: 390, height: 844 })
          await page.locator('[data-view="settings"]').click()
          await page.locator('#openCreateChild').click()
        } else {
          await page.setViewportSize({ width: 1305, height: 890 })
          await page.locator('#onboarding').waitFor()
        }
        const form = page.locator(mode === 'settings' ? '#createChildDialog' : '#createChildForm')
        const input = form.locator(mode === 'settings' ? '#addChildName' : '#newChildName')
        const name = mode === 'settings' ? '重试女孩' : '重试男孩'
        await input.fill(name)
        await form.getByRole('radio', { name: mode === 'settings' ? '女孩' : '男孩', exact: true }).check()
        const writes = []
        const watch = request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/children') writes.push(request.postDataJSON())
        }
        page.on('request', watch)
        let injected = false
        const routeFailure = async route => {
          const method = route.request().method()
          if (!injected && failure === 'refresh-failed' && method === 'GET') {
            injected = true
            return route.fulfill({ status: 503, json: { error: '模拟儿童列表读取失败' } })
          }
          if (!injected && method === 'POST' && failure !== 'refresh-failed') {
            injected = true
            if (failure === 'write-failed') return route.fulfill({ status: 503, json: { error: '模拟创建服务未写入' } })
            const committed = await route.fetch()
            assert.equal(committed.status(), 200)
            return route.abort('failed')
          }
          return route.continue()
        }
        await page.route('**/api/children', routeFailure)
        const submitName = mode === 'settings' ? '添加儿童' : '创建孩子'
        await form.getByRole('button', { name: submitName, exact: true }).click()
        const message = failure === 'refresh-failed'
          ? '儿童已添加，列表刷新失败，请重试刷新。'
          : failure === 'write-failed' ? '模拟创建服务未写入' : '保存结果暂未确认，请刷新检查。'
        await form.getByText(message, { exact: true }).waitFor()
        assert.equal(injected, true)
        assert.equal(writes.length, 1)
        assert.match(writes[0].requestId, /^[A-Za-z0-9._:-]{8,100}$/)
        assert.equal(await input.isDisabled(), true)
        assert.equal(await form.getByRole('radio', { name: '男孩', exact: true }).isDisabled(), true)
        const committed = (await api(page, '/api/children')).children
        assert.equal(committed.length, before + (failure === 'write-failed' ? 0 : 1))
        if (failure === 'refresh-failed') {
          await axe(page, `child-create-refresh-failed-${mode}`)
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          await page.screenshot({ path: path.join(os.tmpdir(), `lele-child-create-refresh-${mode}.png`), fullPage: true })
        }
        await form.getByRole('button', { name: failure === 'refresh-failed' ? '重试刷新' : submitName, exact: true }).click()
        await page.locator('#calendarTitle').waitFor()
        if (mode === 'settings') await form.waitFor({ state: 'hidden' })
        assert.equal(writes.length, failure === 'refresh-failed' ? 1 : 2)
        if (writes.length === 2) assert.deepEqual(writes[1], writes[0])
        const children = (await api(page, '/api/children')).children
        assert.equal(children.length, before + 1)
        const child = children.find(child => child.name === name)
        assert.equal(new URL(page.url()).pathname, `/children/${child.id}`)
        if (committed.length > before) assert.equal(child.id, committed.find(child => child.name === name).id)
        await page.unroute('**/api/children', routeFailure)
        page.off('request', watch)
      }
      for (const child of (await api(page, '/api/children')).children) {
        assert.equal((await api(page, `/api/children/${child.id}`, 'DELETE')).status, 200)
      }
      await page.reload()
      await page.locator('#onboarding').waitFor()
    }
    assert.deepEqual(errors, [])
  } finally { await context.close() }
}
module.exports = { exerciseChildCreationRetry }
