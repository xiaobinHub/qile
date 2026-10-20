/* All writes target the disposable lele_test_browser service, never lele_dev. */
const assert=require('node:assert/strict'),path=require('node:path');
async function exerciseChildDeletion({browser,admin,mom,passwords,createParent,createChildFixture,login,parentPassword,out,failures}){
  await createParent(admin,'qadelete','删除测试家长');
  const context=await browser.newContext({viewport:{width:1098,height:890}}),owner=await context.newPage(),ownerPeer=await context.newPage(),member=await mom.context().newPage();
  let nativeDialogs=0;
  for(const page of [owner,ownerPeer,member]){
    page.on('pageerror',error=>failures.push(error.message));
    page.on('dialog',dialog=>{nativeDialogs++;dialog.dismiss()});
  }
  const api=(page,url,method='GET',body)=>page.evaluate(async({url,method,body})=>{
    const me=await(await fetch('/api/auth/me')).json();
    const response=await fetch(url,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,value:await response.json()};
  },{url,method,body});
  async function openDelete(){
    await owner.getByRole('button',{name:'设置',exact:true}).click();
    await owner.locator('#openChildNicknameSettings').click();
    await owner.locator('.settings-more summary').click();
    await owner.locator('#deleteChild').click();await owner.locator('#deleteChildDialog').waitFor();
  }
  try{
    await login(owner,18887,'qadelete',passwords.initial);await parentPassword(owner,passwords.dad);await login(owner,18887,'qadelete',passwords.dad);
    await owner.locator('#onboarding').waitFor();
    const first=await createChildFixture(owner,'将删除的孩子'),second=await createChildFixture(owner,'保留的孩子');
    const root='/api/children/'+first.id;
    const invite=(await api(owner,root+'/invitations','POST',{loginName:'qamom'})).value.invitation;
    await member.goto('http://127.0.0.1:18887/');
    assert.equal((await api(member,'/api/invitations/'+invite.id+'/accept','POST',{})).status,200);
    await member.goto('http://127.0.0.1:18887/children/'+first.id);await member.locator('#calendarTitle').waitFor();
    await owner.goto('http://127.0.0.1:18887/children/'+first.id);await owner.locator('#calendarTitle').waitFor();
    await ownerPeer.goto('http://127.0.0.1:18887/children/'+first.id);await ownerPeer.locator('#calendarTitle').waitFor();
    await ownerPeer.getByRole('button',{name:'设置',exact:true}).click();
    await openDelete();
    assert.equal(await owner.getByRole('alertdialog').count(),1);
    await owner.screenshot({path:path.join(out,'parent-delete-child.png'),fullPage:true});
    await owner.setViewportSize({width:390,height:844});
    assert.equal(await owner.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await owner.screenshot({path:path.join(out,'parent-delete-child-mobile.png'),fullPage:true});
    await owner.setViewportSize({width:1098,height:890});
    await owner.locator('#cancelDeleteChild').click();assert.equal((await api(owner,root+'/data')).status,200);
    await owner.locator('#deleteChild').click();
    await owner.route('**'+root,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试连接失败，请重试。'})}),{times:1});
    await owner.locator('#confirmDeleteChild').click();await owner.locator('#deleteChildError').getByText('测试连接失败，请重试。',{exact:true}).waitFor();
    assert.equal(await owner.locator('#deleteChildDialog').isVisible(),true);
    assert.equal(await owner.locator('#confirmDeleteChild').isEnabled(),true);
    let release;const gate=new Promise(resolve=>release=resolve);let writes=0;
    const watch=request=>{if(request.method()==='DELETE'&&new URL(request.url()).pathname===root)writes++};owner.on('request',watch);
    await owner.route('**'+root,async route=>{await gate;await route.continue()},{times:1});
    await owner.locator('#confirmDeleteChild').click();
    await owner.waitForFunction(()=>document.querySelector('#confirmDeleteChild')?.disabled===true);
    assert.equal(await owner.locator('#cancelDeleteChild').isDisabled(),true);
    await owner.keyboard.press('Escape');assert.equal(await owner.locator('#deleteChildDialog').isVisible(),true);
    await owner.locator('#confirmDeleteChild').dispatchEvent('click');assert.equal(writes,1);
    release();await owner.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,second.id);
    owner.off('request',watch);
    assert.equal(await owner.locator('#calendarTitle').isVisible(),true);
    // A stale nickname PATCH at the child root must also clear the old context.
    await ownerPeer.locator('#renameChildForm button[type="submit"]').click();
    await ownerPeer.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,second.id);
    assert.equal((await api(owner,root+'/data')).status,403);
    assert.notEqual(await owner.evaluate(async()=>localStorage.getItem('lele-preferred-child:'+(await(await fetch('/api/auth/me')).json()).user.id)),first.id);
    await member.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await member.locator('#onboarding').waitFor();
    assert.deepEqual(await member.locator('.nav button').allTextContents(),['设置']);
    assert.equal(await member.locator('.task-chip,#openChildrenDialog').count(),0);
    assert.equal(await member.evaluate(async()=>localStorage.getItem('lele-preferred-child:'+(await(await fetch('/api/auth/me')).json()).user.id)),null);
    await openDelete();await owner.locator('#confirmDeleteChild').click();await owner.locator('#onboarding').waitFor();
    assert.deepEqual(await owner.locator('.nav button').allTextContents(),['设置']);
    await owner.getByRole('button',{name:'设置',exact:true}).click();
    assert.deepEqual(await owner.locator('[aria-label="设置导航"] h2').allTextContents(),['账号管理']);
    assert.equal(await owner.evaluate(async()=>localStorage.getItem('lele-preferred-child:'+(await(await fetch('/api/auth/me')).json()).user.id)),null);
    assert.equal(nativeDialogs,0);
  }finally{await member.close();await context.close()}
}
module.exports={exerciseChildDeletion};
