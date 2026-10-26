const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseInvitationAcceptance({
  dad,
  mom,
  reject,
  firstId,
  origin,
  out,
  api,
  axe,
  stage,
  login,
  passwordSetup,
  passwords,
}) {
  const invite = async (childId, loginName) => {
    const result = await api(dad, `/api/children/${childId}/invitations`, "POST", { loginName })
    assert.equal(result.status, 200, JSON.stringify(result))
    return result.invitation
  }
  for (const [page, name, key] of [
    [mom, "qamom", "mom"],
    [reject, "qareject", "reject"],
  ]) {
    await login(page, name, passwords.initial)
    await passwordSetup(page, passwords[key])
    await login(page, name, passwords[key])
    await page.locator("#onboarding").waitFor()
  }
  stage("single invitation accepts and immediately enters the child")
  const single = await invite(firstId, "qareject")
  await reject.reload()
  await reject.locator(`[data-accept-invite="${single.id}"]`).click()
  await reject.locator("#calendarTitle").waitFor()
  assert.equal(new URL(reject.url()).pathname, `/children/${firstId}`)

  stage("multiple invitations stay on onboarding; each accepted card becomes Enter")
  const second = (await api(dad, "/api/children", "POST", { name: "邀请妹妹" })).child
  const firstInvite = await invite(firstId, "qamom"),
    secondInvite = await invite(second.id, "qamom")
  await mom.reload()
  const firstCard = mom.locator(`[data-invitation-card="${firstInvite.id}"]`)
  const secondCard = mom.locator(`[data-invitation-card="${secondInvite.id}"]`)
  await mom.route(
    `**/api/invitations/${firstInvite.id}/accept`,
    (route) => route.fulfill({ status: 503, json: { error: "邀请处理暂时失败" } }),
    { times: 1 },
  )
  await firstCard.getByRole("button", { name: "接受邀请", exact: true }).click()
  await mom.locator("#invitationError").getByText("邀请处理暂时失败", { exact: true }).waitFor()
  assert.equal(
    await firstCard.getByRole("button", { name: "接受邀请", exact: true }).isVisible(),
    true,
  )
  assert.equal((await api(mom, "/api/children")).children.length, 0)
  await firstCard.getByRole("button", { name: "接受邀请", exact: true }).click()
  await firstCard.getByRole("button", { name: "进入", exact: true }).waitFor()
  assert.equal(new URL(mom.url()).pathname, "/")
  assert.equal(await mom.locator("#onboarding").isVisible(), true)
  assert.equal(
    await secondCard.getByRole("button", { name: "接受邀请", exact: true }).isEnabled(),
    true,
  )
  assert.equal(await firstCard.getByRole("button", { name: "拒绝邀请", exact: true }).count(), 0)
  await secondCard.getByRole("button", { name: "接受邀请", exact: true }).click()
  await secondCard.getByRole("button", { name: "进入", exact: true }).waitFor()
  assert.equal(new URL(mom.url()).pathname, "/")
  assert.equal(await mom.locator("[data-enter-invited-child]").count(), 2)
  assert.equal((await api(mom, "/api/children")).children.length, 2)
  for (const [width, height] of [
    [1273, 890],
    [820, 1180],
    [390, 844],
  ]) {
    await mom.setViewportSize({ width, height })
    assert.equal(
      await mom.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    )
    await axe(mom, `accepted-invitations-${width}`)
    await mom.screenshot({
      path: path.join(out, `accepted-invitations-${width}.png`),
      fullPage: true,
    })
  }
  await secondCard.getByRole("button", { name: "进入", exact: true }).click()
  await mom.locator("#calendarTitle").waitFor()
  assert.equal(new URL(mom.url()).pathname, `/children/${second.id}`)

  stage("existing child plus new invitation stays in settings and enters only on request")
  const added = await invite(second.id, "qareject")
  await reject.locator('[data-view="settings"]').click()
  await reject.locator("#openMyInvitationsSettings").click()
  const addedCard = reject.locator(`[data-invitation-card="${added.id}"]`)
  await addedCard.getByRole("button", { name: "接受邀请", exact: true }).click()
  await addedCard.getByRole("button", { name: "进入", exact: true }).waitFor()
  assert.equal(new URL(reject.url()).pathname, `/children/${firstId}`)
  assert.equal(await reject.locator("#settingsDetailTitle").innerText(), "邀请我的")
  await addedCard.getByRole("button", { name: "进入", exact: true }).click()
  await reject.locator("#calendarTitle").waitFor()
  assert.equal(new URL(reject.url()).pathname, `/children/${second.id}`)
}
module.exports = { exerciseInvitationAcceptance }
