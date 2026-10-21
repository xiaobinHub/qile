/* Real UI checks. Called only by browser_smoke.cjs against lele_test_browser. */
const assert = require('node:assert/strict');
const path = require('node:path');

async function exerciseAdminUI({admin, browser, port, passwords, out, createParent}) {
  const origin = `http://127.0.0.1:${port}`;
  const allUsers = async () => admin.evaluate(async () => (await fetch('/api/admin/users')).json());
  const account = async name => (await allUsers()).users.find(user => user.loginName === name);
  const openAction = async (id, action) => {
    await admin.locator(`[data-actions="${id}"]`).click();
    await admin.locator(`[data-${action}="${id}"]`).click();
  };
  const filter = async label => {
    await admin.locator('#statusFilter').click();
    await admin.getByRole('option', {name: label, exact: true}).click();
  };

  await createParent(admin, 'qaextra', '界面测试家长');
  let extra = await account('qaextra');
  assert.ok(extra);

  // Search, status filtering, empty state, and refresh preserve an active query.
  await admin.locator('#search').fill('does-not-match-any-user');
  await admin.getByText('没有匹配的账号', {exact: true}).waitFor();
  assert.equal(await admin.locator('#userRows tr[data-user-id]').count(), 0);
  await admin.locator('#search').fill('qaextra');
  assert.equal(await admin.locator('#userRows tr[data-user-id]').count(), 1);
  await admin.locator('#refreshUsers').click();
  await admin.locator('#refreshUsers').waitFor({state: 'visible'});
  assert.equal(await admin.locator('#search').inputValue(), 'qaextra');
  await filter('待改密');
  assert.equal(await admin.locator('#userRows tr[data-user-id]').count(), 1);
  await filter('已停用');
  await admin.getByText('没有匹配的账号', {exact: true}).waitFor();
  await filter('全部状态');
  await admin.locator('#search').fill('');

  // Canceling a status confirmation cannot submit a write.
  const writes=[];
  const record=request=>{if(request.method()==='PATCH'&&request.url().includes('/api/admin/users/'))writes.push(request.url())};
  admin.on('request',record);
  await openAction(extra.id,'status');
  await admin.getByRole('alertdialog').waitFor();
  await admin.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(writes.length,0);
  assert.notEqual((await account('qaextra')).status,'disabled');
  admin.off('request',record);

  await filter('待改密');
  await openAction(extra.id,'status');
  await admin.locator('#confirmStatus').click();
  await admin.getByRole('alertdialog').waitFor({state:'hidden'});
  await admin.waitForFunction(()=>document.querySelector('#statusFilter')===document.activeElement);
  assert.equal((await account('qaextra')).status,'disabled');
  await filter('已停用');
  assert.equal(await admin.locator('#userRows tr[data-user-id]').count(),1);
  await filter('全部状态');
  await openAction(extra.id,'status');
  await admin.locator('#confirmStatus').click();
  await admin.getByRole('alertdialog').waitFor({state:'hidden'});
  assert.equal((await account('qaextra')).status,'active');

  // Reset is a focused dialog; cancellation and keyboard dismissal remain safe.
  await openAction(extra.id,'reset');
  await admin.locator('#resetValue').fill('Q7test');
  await admin.locator('#resetValue').press('Escape');
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  await admin.waitForFunction(id=>document.querySelector(`[data-actions="${id}"]`)===document.activeElement,extra.id);
  await openAction(extra.id,'reset');
  await admin.locator('#resetValue').fill('Q7test');
  await admin.locator('button[form="resetPassword"][type="submit"]').click();
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  const context=await browser.newContext(),parent=await context.newPage();
  try {
    await parent.goto(`http://127.0.0.1:${port-1}/`);
    await parent.locator('#loginName').fill('qaextra');
    await parent.locator('#loginPassword').fill('Q7test');
    await parent.locator('#loginForm button[type="submit"]').click();
    await parent.locator('#passwordNew').waitFor();
  } finally {await context.close()}

  // Dialog semantics, escape and focus return for account creation.
  await admin.locator('#openCreateUser').click();
  await admin.getByRole('dialog').waitFor();
  assert.equal(await admin.locator('#createLogin').evaluate(el=>el===document.activeElement),true);
  await admin.locator('#createLogin').press('Escape');
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  await admin.waitForFunction(()=>document.querySelector('#openCreateUser')===document.activeElement);

  await admin.locator('#refreshUsers').click();
  await admin.waitForFunction(()=>!document.querySelector('#refreshUsers')?.disabled);
  await admin.setViewportSize({width:1059,height:954});
  await admin.evaluate(()=>window.scrollTo(0,0));
  await admin.screenshot({path:path.join(out,'admin-accounts.png'),fullPage:true});
  await admin.setViewportSize({width:815,height:954});
  assert.equal(await admin.locator('#usersNav').isVisible(),true);
  assert.equal(await admin.locator('#userRows').evaluate(el=>{const area=el.closest('table').parentElement;return area.scrollWidth<=area.clientWidth+1}),true,'Table fits medium window without horizontal scrolling');
  await admin.setViewportSize({width:767,height:954});
  await admin.getByRole('button',{name:'打开导航',exact:true}).click();
  await admin.locator('#mobileProfileNav').click();
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  await admin.waitForFunction(()=>document.querySelector('[aria-label="打开导航"]')===document.activeElement);
  await admin.locator('#profileLogin').waitFor();
  await admin.getByRole('button',{name:'打开导航',exact:true}).click();
  await admin.locator('#mobileUsersNav').click();
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  await admin.waitForFunction(()=>document.querySelector('[aria-label="打开导航"]')===document.activeElement);
  await admin.locator('#userRows tr[data-user-id]').first().waitFor();
  await admin.setViewportSize({width:390,height:844});
  await admin.evaluate(()=>window.scrollTo(0,0));
  assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await admin.screenshot({path:path.join(out,'admin-mobile.png'),fullPage:true});
  await admin.locator('#openCreateUser').click();
  const dialog=admin.getByRole('dialog');
  const box=await dialog.boundingBox();
  assert.ok(box.x>=0&&box.x+box.width<=391,'Dialog fits narrow viewport');
  await admin.screenshot({path:path.join(out,'admin-create-mobile.png'),fullPage:true});
  await admin.locator('#cancelCreate').click();
  await admin.getByRole('dialog').waitFor({state:'hidden'});
  await admin.waitForFunction(()=>document.querySelector('#openCreateUser')===document.activeElement);
  await admin.setViewportSize({width:1059,height:954});

  // Login names are immutable; only nicknames can be saved.
  await admin.locator('#profileNav').click();
  assert.equal(await admin.locator('#profileLogin').getAttribute('readonly'),'');
  await admin.locator('#profileName').fill('测试管理员更新');
  await admin.locator('#profileForm button[type="submit"]').click();
  await admin.getByText('账号资料已保存。',{exact:true}).waitFor();
  assert.equal((await account('qaadmin')).nickname,'测试管理员更新');

  // A profile save from an unmounted page cannot overwrite a newer saved name.
  let capturedProfile,releaseProfile;
  const profileCaptured=new Promise(resolve=>capturedProfile=resolve),profileRelease=new Promise(resolve=>releaseProfile=resolve);
  await admin.route('**/api/account/profile',async route=>{const response=await route.fetch();capturedProfile();await profileRelease;await route.fulfill({response})},{times:1});
  await admin.locator('#profileName').fill('过期的昵称');
  await admin.locator('#profileForm button[type="submit"]').click();
  await profileCaptured;
  await admin.locator('#usersNav').click();
  await admin.locator('#openCreateUser').waitFor();
  await admin.locator('#profileNav').click();
  await admin.locator('#profileName').fill('测试管理员更新');
  await admin.locator('#profileForm button[type="submit"]').click();
  await admin.getByText('账号资料已保存。',{exact:true}).waitFor();
  const oldProfileResponse=admin.waitForResponse(response=>response.url().endsWith('/api/account/profile'));
  releaseProfile();
  await (await oldProfileResponse).finished();
  await admin.locator('#usersNav').click();
  await admin.locator('#openCreateUser').waitFor();
  await admin.locator('#profileNav').click();
  assert.equal(await admin.locator('#profileName').inputValue(),'测试管理员更新');
  assert.equal((await account('qaadmin')).nickname,'测试管理员更新');
  await admin.evaluate(()=>window.scrollTo(0,0));
  await admin.screenshot({path:path.join(out,'admin-profile.png'),fullPage:true});
  await admin.locator('#logout').click();
  await admin.locator('#loginName').waitFor();
  assert.equal(await admin.locator('#userRows').count(),0);
  await admin.locator('#loginName').fill('qaadmin');
  await admin.locator('#loginPassword').fill(passwords.adminNew);
  await admin.locator('#loginForm button[type="submit"]').click();
  await admin.locator('#openCreateUser').waitFor();
  assert.equal(new URL(admin.url()).origin,origin);

  // An old list read cannot reappear after logout clears the authenticated view.
  let capturedRead,releaseRead,finishRead;
  const captured=new Promise(resolve=>capturedRead=resolve),release=new Promise(resolve=>releaseRead=resolve),drained=new Promise(resolve=>finishRead=resolve);
  await admin.route('**/api/admin/users',async route=>{const response=await route.fetch();capturedRead();await release;try{await route.fulfill({response})}catch(error){if(!/cancel|closed|disposed|abort/i.test(String(error)))throw error}finally{finishRead()}},{times:1});
  await admin.locator('#refreshUsers').click();
  await captured;
  await admin.locator('#logout').click();
  assert.equal(await admin.locator('#userRows').count(),0);
  await admin.locator('#loginName').waitFor();
  releaseRead();
  await drained;
  assert.equal(await admin.locator('#userRows').count(),0);
}

module.exports={exerciseAdminUI};
