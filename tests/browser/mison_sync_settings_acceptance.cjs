const assert = require("node:assert/strict")
const { selectNumber } = require("./picker_actions.cjs")

exports.exerciseSyncSettings = async function ({ page, dialog, api, requests, dropNext, out }) {
  await page.setViewportSize({ width: 1280, height: 900 })
  const toggle = dialog.getByRole("switch", { name: "自动同步课程到任务" })
  await toggle.waitFor()
  await toggle.click()
  await selectNumber(page, "mison-sync-points", 10)
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  const confirmation = page.getByRole("alertdialog", { name: "按新的起始日同步？" })
  await confirmation.waitFor()
  dropNext()
  await confirmation.getByRole("button", { name: "确认同步", exact: true }).click()
  await dialog.getByText("保存结果暂未确认，请核对并重试原保存。", { exact: true }).waitFor()
  assert.equal(await toggle.isDisabled(), true)
  const first = structuredClone(requests.at(-1))
  assert.equal(first.expectedRevision, 0)
  assert.equal(first.bindingRevision, 1)
  await dialog.getByRole("button", { name: "核对并重试原保存", exact: true }).click()
  await dialog.getByText("原保存结果已核对，已读取最新同步设置。", { exact: true }).waitFor()
  assert.deepEqual(requests.at(-1), first, "Unknown save retries reuse the entire original request")
  assert.equal((await api("course-sync")).data.revision, 1)

  // Another browser changes settings after this dialog has read revision 1.
  await api("course-sync", {
    method: "POST",
    body: {
      operationId: "concurrent-fixture",
      expectedRevision: 1,
      bindingRevision: 1,
      enabled: true,
      points: 20,
      startDate: "2026-11-02",
    },
  })
  await selectNumber(page, "mison-sync-points", 15)
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await dialog.getByText("同步设置已改变，请重新核对后保存。", { exact: true }).waitFor()
  const stale = structuredClone(requests.at(-1))
  assert.equal(stale.expectedRevision, 1)
  assert.equal(
    (await api("course-sync")).data.points,
    20,
    "A stale request never overwrites newer settings",
  )
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await dialog.getByText("发放 15 积分", { exact: false }).waitFor()
  const corrected = requests.at(-1)
  assert.equal(corrected.expectedRevision, 2)
  assert.notEqual(
    corrected.operationId,
    stale.operationId,
    "A confirmed conflict starts a new operation",
  )
  assert.equal((await api("course-sync")).data.points, 15)
  await page.screenshot({ path: require("node:path").join(out, "sync-settings-confirmed.png") })

  await toggle.click()
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await page
    .getByRole("alertdialog", { name: "关闭课程同步？" })
    .getByRole("button", { name: "关闭同步", exact: true })
    .click()
  await dialog.getByText("已关闭同步，并删除 1 节未完成课程。", { exact: true }).waitFor()
  assert.equal(requests.at(-1).expectedRevision, 3)
  assert.equal((await api("course-sync")).data.enabled, false)
}
