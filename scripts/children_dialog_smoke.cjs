/* Child chooser checks use only browser_smoke.cjs's disposable local database. */
const assert=require('node:assert/strict');
const path=require('node:path');

async function exerciseChildrenDialog({browser,admin,dad,firstId,secondId,passwords,createParent,login,parentPassword,out,failures}){
  assert.equal(new URL(dad.url()).port,'18887');
  assert.equal(new URL(admin.url()).port,'18888');
  await createParent(admin,'qachooser','弹窗测试家长');
  const context=await browser.newContext({viewport:{width:1543,height:954}}),page=await context.newPage();
  page.on('pageerror',error=>failures.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  const dialog=page.locator('#childrenDialog'),trigger=page.locator('#openChildrenDialog');
  const waitChild=async id=>page.waitForFunction(child=>document.querySelector('#openChildrenDialog')?.dataset.childId===child,id);
  const closed=async()=>{await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#childrenDialogBody')?.childElementCount===0)};
  const focusReturned=async()=>page.waitForFunction(()=>document.querySelector('#openChildrenDialog')===document.activeElement);
  try{
    await login(page,18887,'qachooser',passwords.initial);
    await parentPassword(page,passwords.dad);
    await login(page,18887,'qachooser',passwords.dad);
    await page.locator('#newChildName').fill('弹窗测试孩子');
    await page.locator('#createChildForm button').click();
    await trigger.waitFor();
    const ownId=await trigger.getAttribute('data-child-id'),originalUrl=page.url(),calendarTitle=await page.locator('#calendarTitle').innerText();
    const position=await trigger.boundingBox();
    assert.ok(position.x>1543/2,'Child chooser is on the right of the header');
    assert.equal(await page.locator('#childSwitch').count(),0);
    assert.equal(await page.locator('.account-strip').count(),0);
    await trigger.click();
    await dialog.locator(`[data-open-child="${ownId}"]`).click();
    await closed();await focusReturned();
    assert.equal(page.url(),originalUrl);
    assert.equal(await page.locator('#calendarTitle').innerText(),calendarTitle);

    // Prepare pending invitations without granting access until the user accepts.
    const invites=await dad.evaluate(async ids=>{
      const me=await(await fetch('/api/auth/me')).json(),result=[];
      for(const id of ids){const response=await fetch(`/api/children/${id}/invitations`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:JSON.stringify({loginName:'qachooser'})});if(!response.ok)throw Error('Could not prepare isolated invitation');result.push((await response.json()).invitation.id)}
      return result;
    },[firstId,secondId]);
    assert.equal(await page.evaluate(async id=>(await fetch(`/api/children/${id}/data`)).status,firstId),403);
    await trigger.click();
    await dialog.locator(`[data-accept-invite="${invites[0]}"]`).waitFor();
    await page.screenshot({path:path.join(out,'parent-children-invitations.png'),fullPage:true});
    await dialog.locator(`[data-reject-invite="${invites[1]}"]`).click();
    await dialog.locator(`[data-reject-invite="${invites[1]}"]`).waitFor({state:'detached'});
    await dialog.locator(`[data-accept-invite="${invites[0]}"]`).click();
    await dialog.locator(`[data-open-child="${firstId}"]`).waitFor();
    assert.equal(await trigger.getAttribute('data-child-id'),ownId,'Accepting an invite preserves the current child');
    assert.equal(page.url(),originalUrl);
    await dialog.locator(`[data-open-child="${firstId}"]`).click();
    await waitChild(firstId);await closed();

    // A failed creation retains input; busy writes cannot be dismissed or duplicated.
    await trigger.click();
    await dialog.locator('#showCreateChild').click();
    await dialog.locator('#newChildName').fill('新建卡片孩子');
    let intercepted,releaseCreate;
    const captured=new Promise(resolve=>intercepted=resolve),release=new Promise(resolve=>releaseCreate=resolve);
    await page.route('**/api/children',async route=>{assert.equal(route.request().method(),'POST');intercepted();await release;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试连接暂不可用'})})},{times:1});
    await dialog.locator('#createChildForm button[type="submit"]').click();
    await captured;
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(),true,'Pending writes keep the dialog open');
    assert.equal(await dialog.locator('#closeChildrenDialog').isDisabled(),true);
    releaseCreate();
    await dialog.getByText('测试连接暂不可用 请先刷新列表核对结果，再继续操作。',{exact:true}).waitFor();
    assert.equal(await dialog.locator('#newChildName').inputValue(),'新建卡片孩子');
    assert.equal(await dialog.locator('#createChildForm button[type="submit"]').isDisabled(),true,'An uncertain creation result must be checked before retrying');
    await dialog.locator('#retryChildrenDialog').click();
    await dialog.locator(`[data-open-child="${firstId}"]`).waitFor();
    assert.equal(await dialog.locator('#newChildName').inputValue(),'新建卡片孩子');
    await dialog.locator('#createChildForm button[type="submit"]').click();
    const newCard=dialog.locator('[data-open-child]').filter({hasText:'新建卡片孩子'});
    await newCard.waitFor();
    const newId=await newCard.getAttribute('data-open-child');
    assert.equal(await trigger.getAttribute('data-child-id'),firstId,'Creating a child preserves the selected child until Enter is clicked');
    await page.screenshot({path:path.join(out,'parent-children-desktop.png'),fullPage:true});
    await newCard.click();await waitChild(newId);await closed();
    await page.setViewportSize({width:815,height:954});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.setViewportSize({width:390,height:844});
    await trigger.click();await dialog.locator(`[data-open-child="${newId}"]`).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const box=await dialog.boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=391&&box.y>=0&&box.y+box.height<=845,'Dialog fits the phone viewport');
    await page.screenshot({path:path.join(out,'parent-children-mobile.png'),fullPage:true});
    await page.keyboard.press('Escape');await closed();await focusReturned();

    await page.route('**/api/children',async route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试列表暂不可用'})}),{times:1});
    await trigger.click();
    await dialog.getByText('测试列表暂不可用',{exact:true}).waitFor();
    await dialog.locator('#retryChildrenDialog').click();
    await dialog.locator(`[data-open-child="${newId}"]`).waitFor();
    await page.keyboard.press('Escape');await closed();

    // A late closed-dialog response may not repopulate hidden names or reopen UI.
    let capturedRead,releaseRead;
    const capturedList=new Promise(resolve=>capturedRead=resolve),readRelease=new Promise(resolve=>releaseRead=resolve);
    await page.route('**/api/children',async route=>{const response=await route.fetch();capturedRead();await readRelease;await route.fulfill({response})},{times:1});
    await trigger.click();await capturedList;
    await page.locator('#closeChildrenDialog').click();await closed();
    const arrived=page.waitForResponse(response=>response.url().endsWith('/api/children'));
    releaseRead();await(await arrived).finished();
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await page.locator('#childrenDialogBody').innerHTML(),'');
    assert.equal(await trigger.getAttribute('data-child-id'),newId);

    // Logout in another tab clears an open chooser before its old read returns.
    const other=await context.newPage();other.on('pageerror',error=>failures.push(error.message));
    await other.goto(page.url());await other.locator('#openChildrenDialog').waitFor();
    let capturedLogout,releaseLogout;
    const waiting=new Promise(resolve=>capturedLogout=resolve),allow=new Promise(resolve=>releaseLogout=resolve);
    await page.route('**/api/children',async route=>{const response=await route.fetch();capturedLogout();await allow;await route.fulfill({response})},{times:1});
    await trigger.click();await waiting;
    await other.getByRole('button',{name:'设置',exact:true}).click();
    await other.locator('#openAccountManagement').click();
    await other.locator('#accountLogout').click();
    await page.locator('#loginForm').waitFor();
    const logoutArrived=page.waitForResponse(response=>response.url().endsWith('/api/children'));
    releaseLogout();await(await logoutArrived).finished();
    assert.equal(await dialog.isVisible(),false);
    assert.equal(await page.locator('#childrenDialogBody').innerHTML(),'');
    assert.equal(await page.locator('#main').count(),0);
  }catch(error){await page.screenshot({path:path.join(out,'children-dialog-failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,2500));throw error}
  finally{await context.close()}
}

module.exports={exerciseChildrenDialog};
