/* Child chooser checks use only browser_smoke.cjs's disposable local database. */
const assert=require('node:assert/strict');
const path=require('node:path');

async function exerciseChildrenDialog({browser,admin,dad,firstId,secondId,passwords,createParent,createChildFixture,login,parentPassword,out,failures}){
  assert.equal(new URL(dad.url()).port,'18887');
  assert.equal(new URL(admin.url()).port,'18888');
  await createParent(admin,'qachooser','弹窗测试家长');
  const context=await browser.newContext({viewport:{width:1543,height:954}}),page=await context.newPage();
  page.on('pageerror',error=>failures.push(error.message));
  let invitationReads=0;
  page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname==='/api/invitations')invitationReads++});
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
    const initialInvitationReads=invitationReads;
    await trigger.click();
    const singleCard=dialog.locator(`[data-open-child="${ownId}"]`);
    await singleCard.waitFor();
    const singleBox=await singleCard.boundingBox(),singleDialog=await dialog.boundingBox();
    assert.ok(Math.abs(singleBox.x+singleBox.width/2-singleDialog.x-singleDialog.width/2)<3,'A single child card is centered');
    assert.ok(singleBox.height>singleBox.width*1.25,'Children are shown as portrait cards');
    assert.equal(await dialog.locator('.modal,.modal-head').count(),0,'The switcher has no conventional modal frame');
    assert.ok(singleDialog.width>=1543*0.95,'The chooser uses the full viewport width');
    assert.ok(Math.abs((singleBox.y+singleBox.height/2)-(singleDialog.y+singleDialog.height/2))<954*0.18,'Chooser content is vertically centered in the viewport');
    assert.equal(await dialog.getByText('当前孩子',{exact:true}).count(),0,'The selected card has no current-child label');
    await page.screenshot({path:path.join(out,'parent-children-single.png')});
    await dialog.locator(`[data-open-child="${ownId}"]`).click();
    await closed();await focusReturned();
    assert.equal(invitationReads,initialInvitationReads,'Switching does not read invitations');
    assert.equal(page.url(),originalUrl);
    assert.equal(await page.locator('#calendarTitle').innerText(),calendarTitle);
    await trigger.click();await singleCard.waitFor();
    await page.mouse.click(10,10);await closed();await focusReturned();

    // Prepare pending invitations without granting access until the user accepts.
    const invites=await dad.evaluate(async ids=>{
      const me=await(await fetch('/api/auth/me')).json(),result=[];
      for(const id of ids){const response=await fetch(`/api/children/${id}/invitations`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:JSON.stringify({loginName:'qachooser'})});if(!response.ok)throw Error('Could not prepare isolated invitation');result.push((await response.json()).invitation.id)}
      return result;
    },[firstId,secondId]);
    assert.equal(await page.evaluate(async id=>(await fetch(`/api/children/${id}/data`)).status,firstId),403);
    const pendingInvitationReads=invitationReads;
    await trigger.click();
    await dialog.locator(`[data-open-child="${ownId}"]`).waitFor();
    assert.equal(invitationReads,pendingInvitationReads,'Pending invitations do not cause extra chooser requests');
    assert.equal(await dialog.locator('[data-accept-invite],[data-reject-invite],#showCreateChild,#createChildForm,input').count(),0,'The chooser only contains child switching controls');
    assert.equal(await dialog.getByText('待处理邀请',{exact:true}).count(),0);
    assert.equal(await dialog.locator('[data-open-child]').count(),1,'An unaccepted child is not offered for switching');
    await page.locator('#closeChildrenDialog').click();await closed();

    // Invitations are handled only in their dedicated settings pane.
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.locator('#openMyInvitationsSettings').click();
    await page.locator(`[data-accept-invite="${invites[0]}"]`).waitFor();
    await page.screenshot({path:path.join(out,'parent-children-management.png'),fullPage:true});
    await page.locator(`[data-reject-invite="${invites[1]}"]`).click();
    await page.locator(`[data-reject-invite="${invites[1]}"]`).waitFor({state:'detached'});
    await page.locator(`[data-accept-invite="${invites[0]}"]`).click();
    await page.locator('[data-enter-invited-child]').click();
    const newId=(await createChildFixture(page,'新建卡片孩子')).id;
    await waitChild(firstId);
    await trigger.click();
    await dialog.locator(`[data-open-child="${newId}"]`).waitFor();
    assert.equal(await dialog.locator('[data-open-child]').count(),3);
    assert.equal(await dialog.locator('[data-accept-invite],[data-reject-invite],#createChildForm').count(),0);
    const cards=dialog.locator('[data-open-child]'),firstBox=await cards.nth(0).boundingBox(),secondBox=await cards.nth(1).boundingBox();
    assert.ok(secondBox.x>firstBox.x+firstBox.width-5&&Math.abs(secondBox.y-firstBox.y)<30,'Desktop cards are side by side');
    assert.equal(await dialog.getByText('当前孩子',{exact:true}).count(),0,'The current card shows no current-child badge');
    assert.equal(await dialog.locator('.children-dialog-cards').evaluate(element=>getComputedStyle(element).scrollbarWidth),'none','Card scroller hides its scrollbar');
    assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('children-dialog-open')),true,'Page scroll is locked while the chooser is open');
    const pageScrollBefore=await page.evaluate(()=>({win:window.scrollY,month:document.querySelector('.month-scroll')?.scrollTop??-1,week:document.querySelector('.week-wrap')?.scrollTop??-1}));
    await page.mouse.move(36,360);await page.mouse.wheel(0,800);await page.waitForTimeout(120);
    const pageScrollAfter=await page.evaluate(()=>({win:window.scrollY,month:document.querySelector('.month-scroll')?.scrollTop??-1,week:document.querySelector('.week-wrap')?.scrollTop??-1}));
    assert.deepEqual(pageScrollAfter,pageScrollBefore,'Backdrop wheel must not scroll the calendar underneath');
    await page.screenshot({path:path.join(out,'parent-children-desktop.png')});
    await cards.first().focus();await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.openChild),await cards.nth(1).getAttribute('data-open-child'));
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.openChild),await cards.last().getAttribute('data-open-child'));
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.openChild),await cards.first().getAttribute('data-open-child'));
    assert.equal(await trigger.getAttribute('data-child-id'),firstId,'Moving card focus does not switch the child');
    await dialog.locator(`[data-open-child="${newId}"]`).click();await waitChild(newId);await closed();
    await page.setViewportSize({width:815,height:954});
    await trigger.click();await dialog.locator(`[data-open-child="${newId}"]`).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.keyboard.press('Escape');await closed();
    await page.setViewportSize({width:390,height:844});
    await trigger.click();await dialog.locator(`[data-open-child="${newId}"]`).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const box=await dialog.boundingBox();
    assert.ok(box.x>=0&&box.x+box.width<=391&&box.y>=0&&box.y+box.height<=845,'Dialog fits the phone viewport');
    const activeCard=await dialog.locator(`[data-open-child="${newId}"]`).boundingBox();
    assert.ok(activeCard.x>=box.x&&activeCard.x+activeCard.width<=box.x+box.width,'The current card is visible when the switcher opens');
    assert.equal(await dialog.locator('.children-dialog-cards').evaluate(element=>element.scrollWidth>element.clientWidth),true,'Multiple cards can scroll horizontally on phones');
    // A dialog is anchored to the viewport; a full-page capture temporarily resizes it.
    await page.screenshot({path:path.join(out,'parent-children-mobile.png')});
    const capturedCard=await dialog.locator(`[data-open-child="${newId}"]`).boundingBox();
    assert.ok(capturedCard.x>=box.x&&capturedCard.x+capturedCard.width<=box.x+box.width,'Capturing the phone view preserves the current card');
    const scrollBefore=await dialog.locator('.children-dialog-cards').evaluate(element=>element.scrollLeft);
    assert.ok(scrollBefore>0);
    await dialog.locator('.children-dialog-cards').hover();await page.mouse.wheel(-700,0);
    await page.waitForFunction(before=>document.querySelector('#childrenDialog .children-dialog-cards').scrollLeft<before,scrollBefore);
    assert.equal(await trigger.getAttribute('data-child-id'),newId,'Scrolling card choices does not change the current child');
    const scrollMid=await dialog.locator('.children-dialog-cards').evaluate(element=>element.scrollLeft);
    await dialog.locator('.children-dialog-cards').hover();await page.mouse.wheel(0,700);
    await page.waitForFunction(before=>document.querySelector('#childrenDialog .children-dialog-cards').scrollLeft!==before,scrollMid);
    assert.equal(await trigger.getAttribute('data-child-id'),newId,'Vertical wheel scrolling keeps the current child');
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
    const other=await context.newPage();other.on('dialog',dialog=>dialog.accept());other.on('pageerror',error=>failures.push(error.message));
    await other.goto(page.url());await other.locator('#openChildrenDialog').waitFor();
    let capturedLogout,releaseLogout;
    const waiting=new Promise(resolve=>capturedLogout=resolve),allow=new Promise(resolve=>releaseLogout=resolve);
    await page.route('**/api/children',async route=>{const response=await route.fetch();capturedLogout();await allow;await route.fulfill({response})},{times:1});
    await trigger.click();await waiting;
    await other.getByRole('button',{name:'设置',exact:true}).click();
    await other.locator('#openAccountManagement').click();
    await other.locator('#settingsLogout').click();await other.locator('#confirmLogout').click();
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
