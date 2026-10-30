/* Long-list undo regression with a read-only projection of the isolated child. */
const assert = require('node:assert/strict')
const path = require('node:path')

async function exerciseStableTrashList({browser, storageState, origin, id, today, out, axe}) {
  for (const [width, height, hasTouch] of [[987, 890, false], [820, 1180, true]]) {
    const context = await browser.newContext({storageState, viewport:{width, height}, hasTouch, isMobile:hasTouch})
    const page = await context.newPage(), errors = [], writes = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/children/${id}/operations`) writes.push(request.url())
    })
    await context.route(`**/api/children/${id}/data`, async route => {
      const response = await route.fetch(), body = await response.json()
      const categoryId = body.data.categories.find(category => category.active).id
      body.data = {...body.data, exceptions:[], completions:[], series:Array.from({length:14}, (_, index) => ({
        id:`stable-trash-${index}`, title:`列表任务 ${String(index + 1).padStart(2, '0')}`, categoryId,
        startDate:today, startTime:'09:00', endTime:'09:30', points:5, note:'', recurrence:null,
      }))}
      await route.fulfill({response, json:body})
    })
    try {
      await page.goto(`${origin}/children/${id}`)
      await page.locator('#quickEditBtn').click()
      for (let index = 0; index < 14; index++) {
        await page.locator(`[data-quick-task="stable-trash-${index}@${today}"]`).press('Space')
        await page.keyboard.press('Delete')
      }
      await page.waitForFunction(() => document.querySelector('[data-quick-delete]')?.dataset.trashState === 'idle')
      await page.locator('.quick-trash-button').click()
      const list = page.locator('.quick-trash-list')
      await list.waitFor()
      await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
      const original = await list.locator('li').evaluateAll(rows => rows.map(row => row.dataset.trashKey))
      assert.equal(original.length, 14)
      for (const [name, index, top] of [['middle', 5, 190], ['last', 12, Infinity]]) {
        await list.evaluate((el, value) => el.scrollTop = value === null ? el.scrollHeight : value, Number.isFinite(top) ? top : null)
        const before = await list.evaluate(el => el.scrollTop)
        const keys = await list.locator('li').evaluateAll(rows => rows.map(row => row.dataset.trashKey))
        const key = keys[index], neighbor = keys[index + 1] || keys[index - 1]
        const undo = list.locator(`[data-trash-key="${key}"] button`)
        const bounds = await undo.boundingBox(), listBounds = await list.boundingBox()
        assert.ok(bounds.y >= listBounds.y && bounds.y + bounds.height <= listBounds.y + listBounds.height, 'Click a fully visible row without automation scrolling it into view')
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
        if (hasTouch) await page.touchscreen.tap(x, y)
        else await page.mouse.click(x, y)
        await page.waitForFunction(({before, neighbor}) => {
          const list = document.querySelector('.quick-trash-list')
          return list && Math.abs(list.scrollTop - Math.min(before, list.scrollHeight - list.clientHeight)) <= 1 &&
            document.activeElement?.closest('[data-trash-key]')?.getAttribute('data-trash-key') === neighbor
        }, {before, neighbor}, {timeout:3000}).catch(async error => {
          console.error('Stable trash state', JSON.stringify({width, name, before, neighbor, actual:await list.evaluate(el => ({top:el.scrollTop, height:el.clientHeight, scrollHeight:el.scrollHeight, focused:document.activeElement?.getAttribute('aria-label')}))}))
          await page.screenshot({path:path.join(out, `quick-trash-stable-failure-${width}.png`)})
          throw error
        })
        assert.deepEqual(await list.locator('li').evaluateAll(rows => rows.map(row => row.dataset.trashKey)), keys.filter(value => value !== key), 'Undo only removes its own row and retains list order')
        assert.ok(await list.evaluate(el => el.scrollTop) > 0, 'Undo never jumps to the first row')
        await page.screenshot({path:path.join(out, `quick-trash-stable-${name}-${width}.png`)})
      }
      await axe(page, `quick-trash-stable-${width}`)
      assert.equal(await page.locator('.quick-trash-total').textContent(), '12')
      assert.deepEqual(writes, [], 'List restoration stays local to the draft')
      assert.deepEqual(errors, [])
      await page.keyboard.press('Escape')
      await page.locator('#cancelQuickEditBtn').click()
    } finally { await context.close() }
  }
}

module.exports = {exerciseStableTrashList}
