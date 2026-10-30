const assert = require("node:assert/strict")
const path = require("node:path")

async function exerciseChildManagement({
  dad,
  mom,
  reject,
  firstId,
  origin,
  out,
  api,
  axe,
  stage,
}) {
  stage("unified child management, nickname/invitation dialogs and member permissions")
  const open = async (page) => {
    await page.locator('[data-view="settings"]').click()
    await page.locator("#openChildManagementSettings").click()
    await page.locator(".child-family-row").first().waitFor()
  }
  const invite = async (name) => {
    await dad.locator("#openInviteFamily").click()
    await dad.locator("#inviteLogin").fill(name)
    await dad.locator('#inviteParentForm button[type="submit"]').click()
    await dad.locator("#inviteFamilyDialog").waitFor({ state: "hidden" })
    await dad.locator("[data-pending-invitation]").waitFor()
  }
  const accept = async (page) => {
    await page.reload()
    await page.locator("[data-accept-invite]").click()
    await page.waitForFunction(() =>
      document.querySelector("#calendarTitle") ||
      Array.from(document.querySelectorAll("[data-enter-invited-child]")).some(button => !button.disabled),
    )
    if (await page.locator("[data-enter-invited-child]").isVisible())
      await page.locator("[data-enter-invited-child]").click()
    await page.locator("#calendarTitle").waitFor()
  }
  await open(dad)
  assert.equal(await dad.locator("#settingsDetailTitle").innerText(), "儿童管理")
  assert.equal(await dad.locator("#openChildNicknameSettings,#openFamilySettings").count(), 0)
  assert.equal(await dad.locator('.child-management-profile [data-slot="badge"]').count(), 1)
  assert.equal(await dad.locator('[data-child-gender]').innerText(), '男孩')
  assert.equal(await dad.locator(".child-family-list").getByText("我", { exact: true }).count(), 0)
  stage("child avatar grouped selection, cancel, retry and persistence")
  const avatarId = async () => (await api(dad, "/api/children")).children.find((c) => c.id === firstId).avatarId
  assert.equal(await avatarId(), "boy-04")
  await dad.locator("#changeChildAvatar").click()
  const avatarDialog = dad.locator("#childAvatarDialog")
  await avatarDialog.locator('input[type="radio"]').last().waitFor({state:"attached"})
  assert.equal(await avatarDialog.locator('input[type="radio"]').count(),20)
  assert.equal(await avatarDialog.locator('input[value="boy-04"]').isChecked(),true)
  await avatarDialog.getByRole("radio",{name:"女孩头像 02",exact:true}).check()
  await avatarDialog.getByRole("button",{name:"取消",exact:true}).click()
  await avatarDialog.waitFor({state:"hidden"})
  assert.equal(await avatarId(),"boy-04")
  await dad.waitForFunction(()=>document.activeElement?.id==="changeChildAvatar")
  await dad.locator("#changeChildAvatar").click()
  await avatarDialog.getByRole("radio",{name:"女孩头像 02",exact:true}).check()
  await dad.route(`**/api/children/${firstId}`, route=>route.request().method()==="PATCH" ? route.fulfill({status:503,json:{error:"头像保存暂时失败"}}):route.continue(), {times:1})
  await dad.locator("#saveChildAvatar").click()
  await dad.locator("#childAvatarError").getByText("头像保存暂时失败",{exact:true}).waitFor()
  assert.equal(await avatarDialog.locator('input[value="girl-02"]').isChecked(),true)
  await dad.locator("#saveChildAvatar").click()
  await avatarDialog.waitFor({state:"hidden"})
  assert.equal(await avatarId(),"girl-02")
  await dad.reload()
  await open(dad)
  await dad.locator('#changeChildAvatar img').waitFor()
  assert.match(await dad.locator('#changeChildAvatar img').getAttribute('src'),/girl-02/)
  for(const [width,height] of [[1626,954],[820,1180],[390,844]]) {
    await dad.setViewportSize({width,height})
    await dad.locator("#changeChildAvatar").click()
    await avatarDialog.locator('img').last().waitFor()
    await dad.waitForFunction(()=>Array.from(document.querySelectorAll('#childAvatarDialog img')).every(i=>i.complete&&i.naturalWidth===500))
    const bounds=await avatarDialog.boundingBox()
    assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=width && bounds.y+bounds.height<=height)
    await axe(dad,`child-avatar-${width}`)
    await dad.screenshot({path:path.join(out,`child-avatar-${width}.png`)})
    await dad.keyboard.press("Escape")
    await avatarDialog.waitFor({state:"hidden"})
  }
  await dad.setViewportSize({width:1135,height:789})
  await dad.locator("#changeChildAvatar").click()
  await avatarDialog.getByRole("radio",{name:"男孩头像 04",exact:true}).check()
  await dad.locator("#saveChildAvatar").click()
  await avatarDialog.waitFor({state:"hidden"})
  await dad.locator("#editChildNickname").click()
  assert.equal(await dad.locator("#renameChild").inputValue(), "测试哥哥")
  await dad.locator("#renameChild").fill("取消昵称")
  await dad.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
  await dad.waitForFunction(() => document.activeElement?.id === "editChildNickname")
  assert.equal(await dad.locator(".child-management-profile strong").innerText(), "测试哥哥")
  await dad.locator("#editChildNickname").click()
  await dad.locator("#renameChild").fill(" 新昵称 ")
  await dad.route(
    `**/api/children/${firstId}`,
    (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "暂时无法保存昵称" }),
          })
        : route.continue(),
    { times: 1 },
  )
  await dad.locator('#renameChildForm button[type="submit"]').click()
  await dad.locator("#renameChildError").getByText("暂时无法保存昵称", { exact: true }).waitFor()
  assert.equal(await dad.locator("#renameChild").inputValue(), " 新昵称 ")
  await axe(dad, "child-nickname-dialog-error")
  await dad.locator('#renameChildForm button[type="submit"]').click()
  await dad.locator("#childNicknameDialog").waitFor({ state: "hidden" })
  assert.equal(
    (await api(dad, "/api/children")).children.find((c) => c.id === firstId).name,
    "新昵称",
  )
  assert.equal(await dad.locator(".child-management-profile strong").innerText(), "新昵称")
  await dad.locator("#openChildrenDialog").click()
  await dad
    .locator(`[data-child-card="${firstId}"]`)
    .getByText("新昵称", { exact: true })
    .waitFor()
  await dad.keyboard.press("Escape")
  await dad.locator("#childrenDialog").waitFor({ state: "hidden" })
  await dad.locator("#editChildNickname").click()
  await dad.locator("#renameChild").fill("测试哥哥")
  await dad.locator('#renameChildForm button[type="submit"]').click()
  await dad.locator("#childNicknameDialog").waitFor({ state: "hidden" })
  await dad.locator("#openInviteFamily").click()
  await dad.locator("#inviteLogin").fill("missingaccount")
  await dad.locator('#inviteParentForm button[type="submit"]').click()
  await dad
    .locator("#inviteFamilyError")
    .getByText("未找到可邀请的账号。", { exact: true })
    .waitFor()
  assert.equal(await dad.locator("#inviteLogin").inputValue(), "missingaccount")
  await axe(dad, "child-invite-dialog-error")
  await dad.screenshot({ path: path.join(out, "child-management-invite-dialog.png") })
  await dad.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click()
  await invite("qareject")
  await reject.reload()
  await reject.locator("[data-reject-invite]").click()
  await reject.getByText("已拒绝这份邀请。", { exact: true }).waitFor()
  await open(dad)
  assert.equal(await dad.locator("[data-pending-invitation]").count(), 0)
  assert.equal(await dad.locator("[data-delete-invitation]").count(), 0)
  await invite("qamom")
  await accept(mom)
  await open(mom)
  assert.equal(
    await mom
      .locator(
        "#openInviteFamily,#editChildNickname,[data-invitation-menu],[data-revoke],[data-transfer],[data-remove]",
      )
      .count(),
    0,
  )
  await open(dad)
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).waitFor()
  await invite("qareject")
  const invitation = (await api(dad, `/api/children/${firstId}/invitations`)).invitations.find(
    (i) => i.status === "pending",
  )
  await open(mom)
  await mom.locator(`[data-pending-invitation="${invitation.id}"]`).waitFor()
  assert.equal(await mom.locator("[data-revoke]").count(), 0)
  assert.equal(
    (await api(mom, `/api/children/${firstId}/invitations`, "POST", { loginName: "qareject" }))
      .status,
    403,
  )
  assert.equal(
    (await api(mom, `/api/children/${firstId}/invitations/${invitation.id}`, "DELETE")).status,
    403,
  )
  await dad.reload()
  await open(dad)
  await dad.locator(`[data-pending-invitation="${invitation.id}"]`).waitFor()
  await dad.locator("#settingsDetailTitle").click()
  for (const viewport of [
    { width: 1626, height: 954 },
    { width: 1440, height: 900 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
  ]) {
    await dad.setViewportSize(viewport)
    await dad.evaluate(async () => {
      await document.fonts.ready
    })
    assert.equal(
      await dad.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    )
    const type = await dad
      .locator(".child-family-name strong")
      .first()
      .evaluate((el) => getComputedStyle(el).fontSize)
    assert.equal(type, "14px")
    assert.equal(
      await dad
        .locator(".child-family-name .settings-status")
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
      "12px",
    )
    const nearby = await dad
      .locator(".child-family-name")
      .first()
      .evaluate((el) => {
        const name = el.querySelector("strong").getBoundingClientRect(),
          badge = el.querySelector('[data-slot="badge"]').getBoundingClientRect()
        return Math.abs(badge.left - name.right - 8) < 1 && Math.abs(badge.top - name.top) < 4
      })
    assert.ok(nearby, "Role badge sits beside nickname")
    assert.ok((await dad.locator("#openInviteFamily").boundingBox()).height >= 44)
    const columns = await dad
      .locator(".child-family-list")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)
    assert.equal(columns, viewport.width >= 1200 ? 3 : viewport.width > 680 ? 2 : 1)
    const memberCard = dad.locator("[data-member]").filter({ hasText: "测试妈妈" })
    assert.match(await memberCard.innerText(), /账号 ID：qamom/)
    assert.match(await memberCard.locator("[data-member-family-role]").innerText(), /角色：爸爸/)
    const avatarBox=await memberCard.locator(".settings-mini-avatar").boundingBox()
    assert.equal(avatarBox.width,64); assert.equal(avatarBox.height,64)
    const cardBox = await memberCard.boundingBox()
    assert.ok(cardBox.width <= 260, "Member cards have a maximum width of 260px")
    assert.ok(cardBox.height <= 128, "Member cards avoid excessive vertical whitespace")
    const heights = await dad
      .locator(".child-family-row")
      .evaluateAll((nodes) => nodes.map((el) => el.getBoundingClientRect().height))
    assert.ok(
      Math.max(...heights) - Math.min(...heights) <= 1,
      "All member and invitation cards have equal height",
    )
    const pendingCard = dad.locator(`[data-pending-invitation="${invitation.id}"]`)
    const accountBox = await pendingCard.locator(".child-family-identity > p").first().boundingBox()
    const validityBox = await pendingCard.locator(".child-member-validity").boundingBox()
    assert.ok(
      Math.abs(accountBox.x - validityBox.x) <= 1,
      "Invitation validity aligns with account text, not the avatar",
    )
    const menuBox = await memberCard
      .getByRole("button", { name: "管理 测试妈妈", exact: true })
      .boundingBox()
    assert.ok(
      cardBox.x + cardBox.width - menuBox.x - menuBox.width <= 20,
      "Member menu is at the card's right edge",
    )
    assert.ok(menuBox.y - cardBox.y <= 12, "Member menu is at the card's top edge")
    const contentBox = await memberCard.locator(".child-member-header").boundingBox()
    assert.ok(
      contentBox.x + contentBox.width <= menuBox.x + 1,
      "Top-right menu does not overlap member information",
    )
    await dad.locator(".child-management-more summary").click()
    const deleteBox = await dad.locator("#deleteChild").boundingBox()
    const warningBox = await dad.locator(".child-management-more > div > p").boundingBox()
    assert.ok(
      warningBox.y >= deleteBox.y + deleteBox.height,
      "Deletion warning appears below its button",
    )
    await axe(dad, `child-management-${viewport.width}`)
    await dad.screenshot({
      path: path.join(out, `child-management-${viewport.width}.png`),
      fullPage: true,
    })
    await dad.locator("#editChildNickname").click()
    await axe(dad, `child-nickname-dialog-${viewport.width}`)
    await dad.screenshot({ path: path.join(out, `child-nickname-dialog-${viewport.width}.png`) })
    await dad.keyboard.press("Escape")
    await dad.locator("#childNicknameDialog").waitFor({ state: "hidden" })
    await dad.locator(".child-management-more summary").click()
  }
  await dad.setViewportSize({ width: 1200, height: 900 })
  await dad.locator(`[data-invitation-menu="${invitation.id}"]`).click()
  await dad.locator(`[data-revoke="${invitation.id}"]`).click()
  await dad.locator("[data-pending-invitation]").waitFor({ state: "hidden" })
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).click()
  await dad.getByRole("menuitem", { name: "移出家庭", exact: true }).click()
  await dad.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click()
  await dad.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "管理 测试妈妈",
  )
  assert.equal((await api(dad, `/api/children/${firstId}/members`)).members.length, 2)
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).click()
  await dad.getByRole("menuitem", { name: "转让管理员身份", exact: true }).click()
  await dad.getByRole("alertdialog").getByRole("button", { name: "确认转让", exact: true }).click()
  await dad.getByRole("alertdialog").waitFor({ state: "hidden" })
  await dad.locator("#openInviteFamily").waitFor({ state: "hidden" })
  await mom.reload()
  await open(mom)
  await mom.getByRole("button", { name: "管理 测试爸爸更新", exact: true }).click()
  await mom.getByRole("menuitem", { name: "转让管理员身份", exact: true }).click()
  await mom.getByRole("alertdialog").getByRole("button", { name: "确认转让", exact: true }).click()
  await mom.getByRole("alertdialog").waitFor({ state: "hidden" })
  await dad.reload()
  await open(dad)
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).click()
  await dad.getByRole("menuitem", { name: "移出家庭", exact: true }).click()
  await dad.getByRole("alertdialog").getByRole("button", { name: "移出家庭", exact: true }).click()
  await dad.getByRole("alertdialog").waitFor({ state: "hidden" })
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).waitFor({ state: "hidden" })
  assert.equal((await api(mom, `/api/children/${firstId}/invitations`)).status, 403)
  await invite("qamom")
  await mom.goto(origin)
  await accept(mom)
  await open(dad)
  await dad.getByRole("button", { name: "管理 测试妈妈", exact: true }).waitFor()
  stage("add child dialog cancel, failed save, retry and automatic selection")
  const beforeChildren = (await api(dad,"/api/children")).children.length
  await dad.locator("#openCreateChild").click()
  const createDialog = dad.locator("#createChildDialog")
  await createDialog.getByRole("heading",{name:"新增儿童",exact:true}).waitFor()
  assert.equal(await dad.locator("#addChildName").getAttribute("maxlength"),"5")
  await dad.locator("#addChildName").fill("取消新增")
  await createDialog.getByRole("button",{name:"取消",exact:true}).click()
  await createDialog.waitFor({state:"hidden"})
  assert.equal((await api(dad,"/api/children")).children.length,beforeChildren)
  await dad.waitForFunction(()=>document.activeElement?.id==="openCreateChild")
  for (const [width,height] of [[1305,890],[820,1180],[390,844]]) {
    await dad.setViewportSize({width,height})
    await dad.locator("#openCreateChild").click()
    await axe(dad,`create-child-${width}`)
    await dad.screenshot({path:path.join(out,`create-child-${width}.png`)})
    await createDialog.getByRole("button",{name:"取消",exact:true}).click()
    await createDialog.waitFor({state:"hidden"})
    assert.equal(await dad.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
    if(width>680){
      const box=await dad.locator('.settings-sidebar').boundingBox()
      assert.ok(Math.abs(box.y+box.height-(height-24))<2,'Sidebar reaches the bottom page padding')
    }
  }
  await dad.setViewportSize({width:1135,height:789})
  await dad.locator("#openCreateChild").click()
  await dad.locator("#addChildName").fill("新儿童")
  await createDialog.getByRole("radio",{name:"男孩",exact:true}).check()
  await dad.route("**/api/children",route=>route.request().method()==="POST"?route.fulfill({status:503,json:{error:"暂时无法添加儿童"}}):route.continue(),{times:1})
  await createDialog.getByRole("button",{name:"添加儿童",exact:true}).click()
  await dad.locator("#addChildError").getByText("暂时无法添加儿童",{exact:true}).waitFor()
  assert.equal(await dad.locator("#addChildName").inputValue(),"新儿童")
  await createDialog.getByRole("button",{name:"添加儿童",exact:true}).click()
  await createDialog.waitFor({state:"hidden"})
  await dad.locator("#calendarTitle").waitFor()
  const children=(await api(dad,"/api/children")).children
  assert.equal(children.length,beforeChildren+1)
  const created=children.find(c=>c.name==="新儿童")
  assert.equal(new URL(dad.url()).pathname,`/children/${created.id}`)
  assert.equal(created.role,"owner")
  assert.equal(created.avatarId,"boy-04")
  await dad.locator("#openChildrenDialog").click()
  await dad.locator(`[data-child-card="${firstId}"]`).click()
  await dad.locator("#calendarTitle").waitFor()
  // Remove only the isolated test child so the rest of the browser regression retains its fixture count.
  await api(dad,`/api/children/${created.id}`,"DELETE")
  await open(dad)

}
module.exports = { exerciseChildManagement }
