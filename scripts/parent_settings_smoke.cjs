/* These UI writes only run inside browser_smoke.cjs's lele_test_browser fixture. */
const assert=require('node:assert/strict');
const path=require('node:path');

async function exerciseParentSettings({browser,admin,dad,mom,firstId,secondId,passwords,createParent,login,parentPassword,out,failures}){
  assert.equal(new URL(dad.url()).port,'18887');
  const open=async(page,key)=>page.locator(`[data-settings-page="${key}"]`).click();
  const store=async(page,id)=>page.evaluate(async child=>(await fetch(`/api/children/${child}/data`)).json(),id);
  await dad.goto(`http://127.0.0.1:18887/children/${firstId}`);
  await dad.locator('#openChildrenDialog').waitFor();
  await dad.setViewportSize({width:1280,height:940});
  await dad.getByRole('button',{name:'设置',exact:true}).click();
  assert.equal(await dad.locator('[aria-label="设置导航"] h2').allTextContents().then(items=>items.join('/')),'孩子管理/任务设置/账号管理');
  assert.equal(await dad.locator('[data-settings-page]').count(),9);
  assert.equal(await dad.locator('.settings-sidebar[data-slot="card"],.settings-detail[data-slot="card"]').count(),2);
  assert.equal(await dad.locator('[data-settings-page][data-slot="button"]').count(),9);
  assert.equal(await dad.locator('#renameChild[data-slot="input"]').count(),1);
  assert.equal(await dad.locator('#openLanAccessSettings,#accountHome,.settings-heading-actions,.settings-detail-heading>p').count(),0);
  const left=await dad.locator('.settings-sidebar').boundingBox(),right=await dad.locator('.settings-detail').boundingBox();
  assert.ok(right.x>left.x+left.width,'Settings use two distinct columns on desktop');
  await dad.screenshot({path:path.join(out,'parent-settings-child.png'),fullPage:true});
  const originalName=(await dad.locator('#renameChild').inputValue());
  await dad.locator('#renameChild').fill('测试哥哥新昵称');
  await dad.locator('#renameChildForm button[type="submit"]').click();
  await dad.locator('#openChildrenDialog strong').getByText('测试哥哥新昵称',{exact:true}).waitFor();
  assert.equal((await store(dad,firstId)).data.settings.childName,'测试哥哥新昵称');
  await dad.locator('#renameChild').fill(originalName);
  await dad.locator('#renameChildForm button[type="submit"]').click();
  await dad.locator('#openChildrenDialog strong').getByText(originalName,{exact:true}).waitFor();

  await open(dad,'account/profile');
  assert.equal(await dad.locator('#profileLogin').getAttribute('readonly'),'');
  assert.equal(await dad.locator('#profileCurrent').count(),0);
  await dad.locator('#profileNickname').fill('测试爸爸更新');
  await dad.locator('#profileForm button[type="submit"]').click();
  await dad.getByText('账号昵称已更新。',{exact:true}).waitFor();
  const user=await dad.evaluate(async()=>(await(await fetch('/api/auth/me')).json()).user);
  assert.equal(user.loginName,'qadad');assert.equal(user.nickname,'测试爸爸更新');
  await dad.screenshot({path:path.join(out,'parent-settings-account.png'),fullPage:true});
  await open(dad,'account/password');
  await dad.locator('#passwordCurrent').fill(passwords.dad);
  await dad.locator('[data-password-toggle="passwordCurrent"]').click();assert.equal(await dad.locator('#passwordCurrent').getAttribute('type'),'text');
  await dad.locator('[data-password-toggle="passwordCurrent"]').click();assert.equal(await dad.locator('#passwordCurrent').getAttribute('type'),'password');
  await dad.locator('#passwordNew').fill('abc123');
  await dad.locator('#passwordRepeat').fill('abc124');
  let passwordRequests=0;
  const watch=request=>{if(new URL(request.url()).pathname==='/api/account/password')passwordRequests++};
  dad.on('request',watch);
  await dad.locator('#passwordForm button[type="submit"]').click();
  await dad.getByText('两次输入的新密码不一致。',{exact:true}).waitFor();
  assert.equal(passwordRequests,0);dad.off('request',watch);

  await open(dad,'tasks/presets');
  await dad.locator('#settingsAddPreset').click();
  await dad.locator('#presetTitle').fill('设置页阅读配置');
  const type=await dad.locator('#presetCategory option:not([disabled])').first().getAttribute('value');
  await dad.locator('#presetCategory').selectOption(type);
  await dad.locator('#taskPresetForm button[type="submit"]').click();
  await dad.locator('#taskPresetEditorDialog').waitFor({state:'hidden'});
  await dad.locator('#settingsTaskPresetsList').getByText('设置页阅读配置',{exact:true}).waitFor();
  assert.equal((await store(dad,firstId)).data.taskPresets.length,1);
  await dad.screenshot({path:path.join(out,'parent-settings-presets.png'),fullPage:true});
  await open(dad,'tasks/categories');
  await dad.locator('#settingsAddCategory').click();
  await dad.locator('#newCategoryName').fill('界面测试类型');
  await dad.locator('#categoryCreateForm button[type="submit"]').click();
  await dad.locator('#categoryCreateDialog').waitFor({state:'hidden'});
  await dad.locator('#settingsCategoryList input[type="text"]').last().waitFor();
  assert.equal((await store(dad,firstId)).data.categories.at(-1).name,'界面测试类型');
  const testCategory=(await store(dad,firstId)).data.categories.at(-1);
  await dad.locator(`[data-cat-name="${testCategory.id}"]`).fill('类型编辑验证');
  await dad.locator(`[data-cat-name="${testCategory.id}"]`).press('Tab');
  await dad.waitForFunction(async({child,id})=>(await(await fetch(`/api/children/${child}/data`)).json()).data.categories.find(item=>item.id===id).name==='类型编辑验证',{child:firstId,id:testCategory.id});
  await dad.locator(`[data-cat-color="${testCategory.id}"]`).evaluate(input=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#336699');
    input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await dad.waitForFunction(async({child,id})=>(await(await fetch(`/api/children/${child}/data`)).json()).data.categories.find(item=>item.id===id).color==='#336699',{child:firstId,id:testCategory.id});
  const target=dad.locator('[data-category-row]').first();
  await dad.locator(`[data-drag-category="${testCategory.id}"]`).dragTo(target,{targetPosition:{x:10,y:3}});
  await dad.waitForFunction(async({child,id})=>(await(await fetch(`/api/children/${child}/data`)).json()).data.categories[0].id===id,{child:firstId,id:testCategory.id});
  assert.equal(await dad.locator('#settingsCategoryList input[data-slot="input"]').count(),(await store(dad,firstId)).data.categories.length*2);
  await dad.screenshot({path:path.join(out,'parent-settings-categories.png'),fullPage:true});
  await open(dad,'tasks/backup');assert.equal(await dad.locator('#settingsImportBtn').isEnabled(),true);
  const downloaded=dad.waitForEvent('download');await dad.locator('#settingsExportBtn').click();
  assert.match((await downloaded).suggestedFilename(),/成长备份.*json$/);

  // The former archive entry is replaced by an accessible custom confirmation.
  await open(dad,'child/profile');await dad.locator('.settings-more summary').click();
  assert.equal(await dad.locator('#archiveChild').count(),0);
  await dad.locator('#deleteChild').click();await dad.locator('#deleteChildDialog').waitFor();
  assert.equal(await dad.locator('#deleteChildDialog[data-slot="alert-dialog-content"]').count(),1);
  assert.equal(await dad.locator('#cancelDeleteChild').evaluate(el=>el===document.activeElement),true);
  await dad.locator('#cancelDeleteChild').click();await dad.locator('#deleteChildDialog').waitFor({state:'hidden'});
  await dad.locator('#deleteChild').click();await dad.keyboard.press('Escape');
  await dad.locator('#deleteChildDialog').waitFor({state:'hidden'});

  await mom.goto(`http://127.0.0.1:18887/children/${firstId}`);await mom.locator('#openChildrenDialog').waitFor();
  await mom.getByRole('button',{name:'设置',exact:true}).click();
  assert.equal(await mom.locator('#renameChild').isDisabled(),true);
  await open(mom,'child/family');await mom.getByText('共同管理家长',{exact:true}).waitFor();
  assert.equal(await mom.locator('#inviteParentForm,[data-remove],[data-transfer],[data-revoke]').count(),0);

  await createParent(admin,'qasettings','设置测试家长');
  await open(dad,'child/family');
  await dad.locator('#inviteLogin').fill('qasettings');await dad.locator('#inviteParentForm button').click();
  const sentRow=dad.locator('.settings-person-row').filter({has:dad.locator('[data-revoke]')}).filter({hasText:'qasettings'});
  const revokedId=await sentRow.locator('[data-revoke]').getAttribute('data-revoke');
  const sent=await dad.evaluate(async id=>(await(await fetch(`/api/children/${id}/invitations`)).json()).invitations,firstId);
  assert.equal(await sentRow.locator('time').getAttribute('datetime'),sent.find(inv=>inv.id===revokedId).createdAt);
  assert.match(await sentRow.locator('.settings-invitation-sent-at').innerText(),/发出于/);
  await sentRow.locator('[data-revoke]').click();
  await dad.locator(`[data-revoke="${revokedId}"]`).waitFor({state:'detached'});
  assert.equal(await dad.getByText('已撤销',{exact:true}).count(),0);
  await dad.locator('#inviteLogin').fill('qasettings');await dad.locator('#inviteParentForm button').click();
  await sentRow.locator('[data-revoke]').waitFor();
  await dad.screenshot({path:path.join(out,'parent-settings-family.png'),fullPage:true});
  await dad.goto(`http://127.0.0.1:18887/children/${secondId}`);await dad.locator('#openChildrenDialog').waitFor();
  await dad.getByRole('button',{name:'设置',exact:true}).click();await open(dad,'child/family');
  await dad.locator('#inviteLogin').fill('qasettings');await dad.locator('#inviteParentForm button').click();
  await dad.locator('[data-revoke]').waitFor();

  const ownContext=await browser.newContext({viewport:{width:1280,height:940}}),page=await ownContext.newPage();
  let logoutRequests=0,nativeDialogs=0;
  page.on('pageerror',error=>failures.push(error.message));
  page.on('dialog',dialog=>{nativeDialogs++;dialog.accept()});
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/logout')logoutRequests++});
  try{
    await login(page,18887,'qasettings',passwords.initial);await parentPassword(page,passwords.mom);await login(page,18887,'qasettings',passwords.mom);
    await page.locator('#onboarding').waitFor();
    assert.deepEqual(await page.locator('.nav button').allTextContents(),['设置']);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    assert.deepEqual(await page.locator('[aria-label="设置导航"] h2').allTextContents(),['账号管理']);
    assert.equal(await page.locator('[data-settings-page]').count(),3);
    assert.equal(await page.locator('#createChildForm,[data-accept-invite],[data-reject-invite]').count(),0);
    assert.equal(await page.locator('#settingsDetailTitle').innerText(),'修改账号昵称');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:path.join(out,'parent-unbound-settings.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:940});
    await page.locator('#backToOnboarding').click();
    await page.locator('#onboarding').waitFor();
    await page.locator('.settings-invitation-card').nth(1).waitFor();
    await page.screenshot({path:path.join(out,'parent-settings-invitations.png'),fullPage:true});
    const firstCard=page.locator('.settings-invitation-card').filter({hasText:originalName});
    await firstCard.locator('[data-reject-invite]').click();await firstCard.waitFor({state:'detached'});
    // The sender can clear a rejected invitation without changing child members.
    await dad.goto(`http://127.0.0.1:18887/children/${firstId}`);await dad.locator('#openChildrenDialog').waitFor();
    await dad.getByRole('button',{name:'设置',exact:true}).click();await open(dad,'child/family');
    const rejectedRow=dad.locator('.settings-person-row').filter({has:dad.locator('[data-delete-invitation]')}).filter({hasText:'qasettings'});
    await rejectedRow.waitFor();assert.equal(await rejectedRow.getByText('已拒绝',{exact:true}).count(),1);
    assert.equal(await dad.locator('.settings-status.is-owner').innerText(),'管理员');
    assert.equal(await dad.locator('.settings-person-row').filter({hasText:'qamom'}).locator('.settings-status').innerText(),'成员');
    assert.equal(await dad.getByText('已接受',{exact:true}).count(),0);
    const deleteId=await rejectedRow.locator('[data-delete-invitation]').getAttribute('data-delete-invitation');
    await dad.screenshot({path:path.join(out,'parent-settings-rejected-invitation.png'),fullPage:true});
    await dad.setViewportSize({width:390,height:844});assert.equal(await dad.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await dad.screenshot({path:path.join(out,'parent-settings-rejected-invitation-mobile.png'),fullPage:true});await dad.setViewportSize({width:1280,height:940});
    await rejectedRow.locator('[data-delete-invitation]').click();await dad.locator(`[data-delete-invitation="${deleteId}"]`).waitFor({state:'detached'});
    await open(dad,'account/profile');await open(dad,'child/family');await dad.getByText('共同管理家长',{exact:true}).waitFor();
    assert.equal(await dad.locator(`[data-delete-invitation="${deleteId}"]`).count(),0);
    assert.equal(await dad.getByText('已接受',{exact:true}).count(),0);
    await page.locator('[data-accept-invite]').click();
    await page.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,secondId);
    assert.deepEqual(await page.locator('.nav button').allTextContents(),['日历','积分商城','设置']);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    assert.deepEqual(await page.locator('[aria-label="设置导航"] h2').allTextContents(),['孩子管理','任务设置','账号管理']);
    assert.equal(await page.evaluate(async id=>(await fetch(`/api/children/${id}/data`)).status,firstId),403);

    // A bound parent handles incoming invitations in the React settings pane.
    await dad.locator('#inviteLogin').fill('qasettings');await dad.locator('#inviteParentForm button').click();await dad.locator('[data-revoke]').waitFor();
    await open(page,'child/invitations');await page.locator('[data-reject-invite]').click();
    await page.getByText('已拒绝这份邀请。',{exact:true}).waitFor();await page.getByText('暂无待处理邀请',{exact:true}).waitFor();
    await open(dad,'account/profile');await open(dad,'child/family');await dad.locator('[data-delete-invitation]').waitFor();
    await dad.locator('#inviteLogin').fill('qasettings');await dad.locator('#inviteParentForm button').click();await dad.locator('[data-revoke]').waitFor();
    await open(page,'account/profile');await open(page,'child/invitations');await page.locator('[data-accept-invite]').click();
    await page.locator('[data-enter-invited-child]').waitFor();assert.equal(await page.locator('#openChildrenDialog').getAttribute('data-child-id'),secondId);
    await page.locator('[data-enter-invited-child]').click();await page.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,firstId);
    await page.getByRole('button',{name:'设置',exact:true}).click();

    let captured,release;
    const waiting=new Promise(resolve=>captured=resolve),allow=new Promise(resolve=>release=resolve);
    await page.route('**/api/invitations',async route=>{const response=await route.fetch();captured();await allow;await route.fulfill({response})},{times:1});
    await open(page,'child/invitations');await waiting;await open(page,'account/profile');release();
    await page.locator('#profileNickname').waitFor();assert.equal(await page.locator('#settingsDetailTitle').innerText(),'修改账号昵称');
    await page.setViewportSize({width:390,height:844});
    for(const key of ['child/profile','child/family','child/invitations','tasks/presets','tasks/categories','tasks/backup','account/profile','account/password']){
      await open(page,key);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`No mobile overflow: ${key}`);
    }
    await page.screenshot({path:path.join(out,'parent-settings-mobile.png'),fullPage:true});
    const nativeBefore=nativeDialogs;
    await page.locator('#settingsLogout').click();await page.locator('#logoutDialog').waitFor({state:'visible'});
    await page.locator('#cancelLogout').click();assert.equal(logoutRequests,0);assert.equal(await page.locator('#loginForm').count(),0);
    assert.equal(await page.locator('#settingsLogout').evaluate(el=>el===document.activeElement),true);
    await page.locator('#settingsLogout').click();await page.locator('#confirmLogout').click();await page.locator('#loginName').waitFor();assert.equal(logoutRequests,1);assert.equal(nativeDialogs,nativeBefore);
  }finally{await ownContext.close()}
  await dad.goto(`http://127.0.0.1:18887/children/${secondId}`);await dad.locator('#openChildrenDialog').waitFor();
}
module.exports={exerciseParentSettings};
