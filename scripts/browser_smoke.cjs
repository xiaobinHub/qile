/* Browser regression against disposable local lele_test_browser only. */
const {chromium}=require('playwright');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {exerciseAdminUI}=require('./admin_ui_smoke.cjs');
const {exerciseParentLoginUI}=require('./parent_login_smoke.cjs');
const {exerciseChildrenDialog}=require('./children_dialog_smoke.cjs');
const {exerciseParentSettings}=require('./parent_settings_smoke.cjs');
const root=path.resolve(__dirname,'..'),python=path.join(root,'.venv/bin/python');
const runtime=path.join(root,'data/development'),out=path.join(root,'output/playwright');
// Exercise the minimum password length throughout the account flows.
const passwords=Object.fromEntries(['admin','adminNew','initial','dad','mom'].map((key,index)=>[key,String.fromCharCode(65+index)+'7'+crypto.randomBytes(2).toString('hex')]));
const setup=`
import json,sys,os
from pathlib import Path
import psycopg
from psycopg import sql
from child_service import initialize,bootstrap,load_config
root=Path.cwd();base=load_config(root/'data/development/config.json');assert base['environment']=='development'
params={**base['_connect'],'dbname':'postgres'}
with psycopg.connect(**params,autocommit=True) as c:
 if not c.execute('SELECT 1 FROM pg_database WHERE datname=%s',('lele_test_browser',)).fetchone():c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier('lele_test_browser')))
config={'environment':'development','database':{**base['database'],'dbname':'lele_test_browser'},'parent_origin':'http://127.0.0.1:18887','admin_origin':'http://127.0.0.1:18888'}
p=root/'data/development/browser-config.json';p.write_text(json.dumps(config));p.chmod(0o600)
params={**base['_connect'],'dbname':'lele_test_browser'}
with psycopg.connect(**params) as c:c.execute('DROP SCHEMA IF EXISTS lele CASCADE')
initialize(p);bootstrap(p,'qaadmin','测试管理员',json.load(sys.stdin)['admin'])
`;
fs.mkdirSync(out,{recursive:true});
execFileSync(python,['-c',setup],{cwd:root,input:JSON.stringify(passwords),stdio:['pipe','pipe','pipe']});
const children=[];
function start(surface,port){const fd=fs.openSync(path.join(runtime,'browser-'+surface+'.log'),'a');const proc=spawn(python,['-m','uvicorn','accounts_app:create_from_env','--factory','--host','127.0.0.1','--port',String(port),'--no-proxy-headers'],{cwd:root,env:{...process.env,LELE_ACCOUNTS_CONFIG:path.join(runtime,'browser-config.json'),LELE_SURFACE:surface},stdio:['ignore',fd,fd]});fs.closeSync(fd);children.push(proc)}
async function ready(port){for(let n=0;n<60;n++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,150))}throw Error('local QA service did not start')}
const failures=[];let browser;
async function login(page,port,name,password){await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#loginName').fill(name);await page.locator('#loginPassword').fill(password);await page.locator('#loginForm button:not([type="button"])').click()}
async function checkPasswordInput(page,selector){for(const [value,valid] of [['abc123',true],['abcdef',false],['123456',false],['ab123',false]]){await page.locator(selector).fill(value);assert.equal(await page.locator(selector).evaluate(el=>el.checkValidity()),valid,selector+' password policy')}}
async function parentPassword(page,newPassword){
 assert.equal(await page.locator('#passwordCurrent,#accountHome,#accountProfile').count(),0);
 await page.locator('.password-setup-card').waitFor();
 assert.equal(await page.locator('#requiredPasswordContent[data-slot="card"]').count(),1);
 assert.equal(await page.locator('#passwordForm input[data-slot="input"]').count(),2);
 assert.equal(await page.locator('#passwordForm label[data-slot="label"]').count(),2);
 assert.equal(await page.locator('#passwordForm button[type="submit"][data-slot="button"]').count(),1);
 for(const id of ['passwordNew','passwordRepeat']){
  const input=page.locator('#'+id),toggle=page.locator(`[data-password-toggle="${id}"]`);
  await input.fill('Abc123');assert.equal(await input.getAttribute('type'),'password');
  await toggle.click();assert.equal(await input.getAttribute('type'),'text');assert.equal(await input.inputValue(),'Abc123');assert.equal(await toggle.getAttribute('aria-pressed'),'true');
  await toggle.press('Space');assert.equal(await input.getAttribute('type'),'password');assert.equal(await input.inputValue(),'Abc123');assert.equal(await toggle.getAttribute('aria-pressed'),'false');
 }
 let logouts=0;const watch=request=>{if(new URL(request.url()).pathname==='/api/auth/logout')logouts++};page.on('request',watch);
 await page.locator('#accountLogout').click();await page.locator('#logoutDialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#cancelLogout').evaluate(el=>el===document.activeElement),true);
 await page.locator('#cancelLogout').click();assert.equal(await page.locator('#logoutDialog').isVisible(),false);assert.equal(logouts,0);
 await page.locator('#accountLogout').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#logoutDialog').isVisible(),false);assert.equal(logouts,0);
 page.off('request',watch);
 await checkPasswordInput(page,'#passwordNew');await checkPasswordInput(page,'#passwordRepeat');
 await page.locator('#passwordNew').fill('Abc123');await page.locator('#passwordRepeat').fill('Abc124');
 await page.locator('#passwordForm button[type="submit"]').click();await page.getByText('两次输入的新密码不一致。',{exact:true}).waitFor();
 assert.equal(await page.locator('#passwordRepeat').evaluate(el=>el===document.activeElement),true);
 await page.locator('#passwordNew').fill(passwords.initial);await page.locator('#passwordRepeat').fill(passwords.initial);
 await page.locator('#passwordForm button[type="submit"]').click();await page.getByText('新密码不能与当前密码相同。',{exact:true}).waitFor();
 assert.equal(await page.locator('#passwordForm fieldset').evaluate(el=>el.disabled),false);
 await page.locator('#passwordNew').fill(newPassword);await page.locator('#passwordRepeat').fill(newPassword);
 let releaseSave;const allowSave=new Promise(resolve=>releaseSave=resolve);
 await page.route('**/api/account/password',async route=>{await allowSave;await route.continue()},{times:1});
 let saves=0;const countSave=request=>{if(new URL(request.url()).pathname==='/api/account/password')saves++};page.on('request',countSave);
 const requested=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/account/password');
 await page.locator('#passwordForm button[type="submit"]').click();assert.deepEqual(Object.keys((await requested).postDataJSON()),['newPassword']);
 await page.waitForFunction(()=>document.querySelector('#passwordForm fieldset')?.disabled===true);
 assert.equal(await page.locator('#passwordForm button[type="submit"]').isDisabled(),true);
 assert.equal(await page.locator('[data-password-toggle="passwordNew"]').isDisabled(),true);
 await page.locator('#passwordForm').dispatchEvent('submit');assert.equal(saves,1);
 releaseSave();await page.locator('#loginName').waitFor();page.off('request',countSave);
}

async function waitForStore(page,id,predicate){for(let n=0;n<200;n++){const value=await page.evaluate(async child=>(await fetch(`/api/children/${child}/data`)).json(),id);if(predicate(value))return value;await page.waitForTimeout(50)}throw Error('Persisted business result not reached')}
async function createChildFixture(page,name){assert.equal(new URL(page.url()).port,'18887');return page.evaluate(async name=>{const me=await(await fetch('/api/auth/me')).json();const response=await fetch('/api/children',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:JSON.stringify({name})});if(!response.ok)throw Error('Isolated child fixture creation failed');return(await response.json()).child},name)}
async function createParent(admin,loginName,nickname){await admin.locator('#openCreateUser').click();await admin.locator('#createLogin').fill(loginName);await admin.locator('#createNickname').fill(nickname);await admin.locator('#createPassword').fill(passwords.initial);await admin.locator('#createUser button[type="submit"]').click();await admin.getByRole('dialog').waitFor({state:'hidden'});await admin.getByText(nickname,{exact:true}).waitFor()}
(async()=>{try{
 start('parent',18887);start('admin',18888);await Promise.all([ready(18887),ready(18888)]);
 browser=await chromium.launch({headless:true});
 const ac=await browser.newContext(),dc=await browser.newContext(),mc=await browser.newContext();
 const admin=await ac.newPage(),dad=await dc.newPage(),mom=await mc.newPage();
 for(const page of [admin,dad,mom]){page.on('pageerror',e=>failures.push(e.message));page.on('dialog',d=>d.accept())}
 if(!process.argv.includes('--admin-only'))await exerciseParentLoginUI({page:dad,port:18887,out});
 await login(admin,18888,'qaadmin',passwords.admin);
 await checkPasswordInput(admin,'#newPassword');await checkPasswordInput(admin,'#repeatPassword');
 await admin.locator('#currentPassword').fill(passwords.admin);await admin.locator('#newPassword').fill(passwords.adminNew);await admin.locator('#repeatPassword').fill(passwords.adminNew);await admin.locator('#changePassword button[type="submit"]').click();await admin.locator('#loginName').waitFor();
 await login(admin,18888,'qaadmin',passwords.adminNew);await admin.locator('#openCreateUser').waitFor();
 await admin.locator('#openCreateUser').click();
 await checkPasswordInput(admin,'#createPassword');
 await admin.locator('#cancelCreate').click();
 await admin.getByRole('dialog').waitFor({state:'hidden'});
 await admin.waitForFunction(()=>document.querySelector('#openCreateUser')===document.activeElement);
 await createParent(admin,'qadad','测试爸爸');await createParent(admin,'qamom','测试妈妈');
 await admin.locator('[data-actions]').first().click();await admin.locator('[data-reset]').first().click();await checkPasswordInput(admin,'#resetValue');await admin.locator('#cancelReset').click();
 await admin.screenshot({path:path.join(out,'admin-accounts.png'),fullPage:true});
 if(!process.argv.includes('--admin-only')){
 await login(dad,18887,'qadad',passwords.initial);
 await dad.locator('.password-setup-card').waitFor();await dad.setViewportSize({width:1098,height:890});
 const setupCard=await dad.locator('.password-setup-card').boundingBox();assert.ok(Math.abs(setupCard.x+setupCard.width/2-1098/2)<12);assert.ok(setupCard.y>=0&&setupCard.y+setupCard.height<=890);
 await dad.screenshot({path:path.join(out,'parent-password-setup-desktop.png')});
 await dad.locator('#accountLogout').click();await dad.screenshot({path:path.join(out,'parent-logout-confirmation.png')});await dad.locator('#cancelLogout').click();
 await dad.setViewportSize({width:390,height:844});assert.equal(await dad.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await dad.screenshot({path:path.join(out,'parent-password-setup-mobile.png')});await dad.setViewportSize({width:1280,height:940});
 await parentPassword(dad,passwords.dad);await login(dad,18887,'qadad',passwords.dad);await dad.locator('#onboarding').waitFor();assert.deepEqual(await dad.locator('.nav button').allTextContents(),['设置']);await dad.screenshot({path:path.join(out,'parent-unbound-home.png'),fullPage:true});await dad.locator('#newChildName').fill('测试哥哥');await dad.locator('#createChildForm button').click();await dad.locator('#openChildrenDialog').waitFor();
 const firstId=await dad.locator('#openChildrenDialog').getAttribute('data-child-id');
 // Create a task using the existing calendar editor.
 await dad.getByRole('button',{name:'新建任务',exact:true}).click();await dad.locator('#taskTitle').fill('浏览器阅读任务');await dad.locator('#taskDate').click();await dad.locator('[data-picker-today]').click();await dad.locator('#taskStart').click();await dad.locator('[data-picker-hour="18"]').click();await dad.locator('[data-picker-minute="00"]').click();await dad.locator('#taskEnd').click();await dad.locator('[data-picker-hour="18"]').click();await dad.locator('[data-picker-minute="30"]').click();await dad.locator('#taskPoints').fill('10');await dad.locator('#taskForm button[type="submit"]').click();await dad.locator('#taskDialog').waitFor({state:'hidden'});
 let store=await dad.evaluate(async(id)=>(await fetch(`/api/children/${id}/data`)).json(),firstId);assert.equal(store.data.series.length,1);const key=store.data.series[0].id+'@'+store.data.series[0].startDate;
 // Open own child management and send a specific-child invitation.
 await dad.getByRole('button',{name:'设置',exact:true}).click();await dad.locator('#openFamilySettings').click();await dad.locator('#inviteLogin').fill('qamom');await dad.locator('#inviteParentForm button').click();await dad.locator('[data-revoke]').waitFor();
 await login(mom,18887,'qamom',passwords.initial);await parentPassword(mom,passwords.mom);await login(mom,18887,'qamom',passwords.mom);await mom.locator('#onboarding [data-accept-invite]').click();await mom.locator('#openChildrenDialog').waitFor();await mom.locator('#openChildrenDialog').click();await mom.locator('#childrenDialog [data-open-child]').waitFor();assert.equal(await mom.locator('#childrenDialog [data-open-child]').count(),1);await mom.locator('#closeChildrenDialog').click();await mom.locator('#childrenDialog').waitFor({state:'hidden'});
 // Prepare a second child through the isolated API; the removed management page stays absent.
 const secondId=(await createChildFixture(dad,'测试妹妹')).id;
 await dad.locator('#openChildrenDialog').click();await dad.locator(`#childrenDialog [data-open-child="${secondId}"]`).click();await dad.locator('#childrenDialog').waitFor({state:'hidden'});await dad.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,secondId);
 await dad.goto('http://127.0.0.1:18887/');await dad.locator('#calendarTitle').waitFor();assert.equal(await dad.locator('#openChildrenDialog').getAttribute('data-child-id'),secondId);
 assert.equal(await dad.locator('.account-panel,.child-cards').count(),0,'The root is the task calendar, not the old children page');
 await dad.evaluate(async()=>{const me=await(await fetch('/api/auth/me')).json();localStorage.setItem('lele-preferred-child:'+me.user.id,'no-longer-authorized')});
 await dad.goto('http://127.0.0.1:18887/');await dad.locator('#calendarTitle').waitFor();assert.equal(await dad.locator('#openChildrenDialog').getAttribute('data-child-id'),firstId,'Invalid preferences fall back to an authorized child');
 await dad.locator('#openChildrenDialog').click();await dad.locator(`#childrenDialog [data-open-child="${secondId}"]`).click();await dad.locator('#childrenDialog').waitFor({state:'hidden'});await dad.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,secondId);
 const second=await dad.evaluate(async(id)=>(await fetch(`/api/children/${id}/data`)).json(),secondId);assert.equal(second.data.series.length,0);
 const forbidden=await mom.evaluate(async(id)=>(await fetch(`/api/children/${id}/data`)).status,secondId);assert.equal(forbidden,403);
 // Two tabs retain their selected child; changing one does not alter the other.
 const other=await dc.newPage();other.on('pageerror',e=>failures.push(e.message));other.on('dialog',d=>d.accept());await other.goto(`http://127.0.0.1:18887/children/${firstId}`);await other.locator('#openChildrenDialog').waitFor();assert.equal(await other.locator('#openChildrenDialog').getAttribute('data-child-id'),firstId);assert.equal(await dad.locator('#openChildrenDialog').getAttribute('data-child-id'),secondId);
 // Browser history invalidates the previous child immediately, even on a slow list response.
 await dad.route('**/api/children',async route=>{await new Promise(r=>setTimeout(r,600));await route.continue()});await dad.evaluate(()=>history.back());await dad.waitForFunction(()=>!document.querySelector('#openChildrenDialog'));assert.equal(await dad.locator('.task-chip').count(),0);await dad.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,firstId);await dad.unroute('**/api/children');await dad.locator('#openChildrenDialog').click();await dad.locator(`#childrenDialog [data-open-child="${secondId}"]`).click();await dad.locator('#childrenDialog').waitFor({state:'hidden'});await dad.waitForFunction(id=>document.querySelector('#openChildrenDialog')?.dataset.childId===id,secondId);
 await exerciseChildrenDialog({browser,admin,dad,firstId,secondId,passwords,createParent,createChildFixture,login,parentPassword,out,failures});
 await exerciseParentSettings({browser,admin,dad,mom,firstId,secondId,passwords,createParent,login,parentPassword,out,failures});
 await other.locator('#refreshData').click();await other.getByText('已读取最新数据',{exact:true}).waitFor();
 // Complete via actual card control in the first child's page.
 await other.locator(`[data-month-occ="${key}"]`).first().click();await other.locator(`[data-toggle-occ="${key}"]`).first().click();await other.locator('#closeDrawer').click();await waitForStore(other,firstId,p=>p.data.ledger.reduce((s,x)=>s+x.amount,0)===10);
 store=await other.evaluate(async(id)=>(await fetch(`/api/children/${id}/data`)).json(),firstId);assert.equal(store.data.ledger.length,1);
 // Deliver an old read after a newer successful command; the rendered state must not regress.
 let releaseRead,capturedRead;const captured=new Promise(r=>capturedRead=r),release=new Promise(r=>releaseRead=r);
 await other.route(`**/api/children/${firstId}/data`,async route=>{const response=await route.fetch();capturedRead();await release;await route.fulfill({response})},{times:1});
 await other.locator('#refreshData').click();await captured;
 await other.locator(`[data-month-occ="${key}"]`).first().click();await other.locator(`[data-toggle-occ="${key}"]`).first().click();
 await other.waitForFunction(k=>!document.querySelector(`[data-month-occ="${k}"]`).classList.contains('done'),key);await other.locator('#closeDrawer').click();releaseRead();
 await other.getByText('已读取最新数据',{exact:true}).waitFor();assert.equal(await other.locator(`[data-month-occ="${key}"]`).evaluate(e=>e.classList.contains('done')),false);
 await other.locator(`[data-month-occ="${key}"]`).first().click();await other.locator(`[data-toggle-occ="${key}"]`).first().click();
 await other.waitForFunction(k=>document.querySelector(`[data-month-occ="${k}"]`).classList.contains('done'),key);await other.locator('#closeDrawer').click();
 await other.getByRole('button',{name:'积分商城',exact:true}).click();await other.locator('#manageGifts').click();await other.locator('#addGiftBtn').click();await other.locator('#giftName').fill('测试绘本');await other.locator('#giftPoints').fill('5');await other.locator('#saveGiftBtn').click();await other.locator('#giftEditorDialog').waitFor({state:'hidden'});await other.locator('#giftManagerDialog [data-close]').click();await other.locator('[data-redeem-gift]').click();await other.locator('#confirmGiftRedeem').click();await other.locator('#giftRedeemDialog').waitFor({state:'hidden'});await other.locator('[data-store-tab="redeemed"]').click();await other.locator('[data-undo-gift]').click();await waitForStore(other,firstId,p=>p.data.gifts[0]?.status==='available'&&p.data.ledger.reduce((s,x)=>s+x.amount,0)===10&&p.data.ledger.some(x=>x.kind==='gift-reversal'));
 // Legacy backup images are untrusted display data, including malformed attribute content.
 const restored=await other.evaluate(async id=>{const pkg=await(await fetch(`/api/children/${id}/data`)).json(),me=await(await fetch('/api/auth/me')).json();pkg.data.gifts[0].imageData='data:image/png;base64,x"><div id="injected-ui">untrusted</div><img src="';return(await fetch(`/api/children/${id}/data/restore`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:JSON.stringify({expectedRevision:pkg.revision,membershipVersion:pkg.context.membershipVersion,operationId:crypto.randomUUID(),data:pkg.data})})).status},firstId);assert.equal(restored,200);
 await other.locator('#refreshData').click();await other.locator('[data-store-tab="available"]').click();await other.locator('[data-redeem-gift]').waitFor();assert.equal(await other.locator('#injected-ui').count(),0);
 await other.locator('#manageGifts').click();await other.locator('[data-edit-gift]').click();assert.equal(await other.locator('#injected-ui').count(),0);await other.locator('#giftEditorDialog [data-close]').first().click();await other.locator('#giftManagerDialog [data-close]').click();
 await other.getByRole('button',{name:'设置',exact:true}).click();await other.locator('#openBackupSettings').click();assert.equal(await other.locator('#settingsImportBtn').isEnabled(),true);
 await mom.getByRole('button',{name:'设置',exact:true}).click();await mom.locator('#openBackupSettings').click();assert.equal(await mom.locator('#settingsImportBtn').isDisabled(),true);
 await other.getByRole('button',{name:'日历',exact:true}).click();await other.locator('#printBtn').click();await other.evaluate(()=>{window.print=()=>{}});await other.locator('#printConfirmBtn').click();assert.match(await other.locator('#printPages h1').first().innerText(),/测试哥哥/);await other.screenshot({path:path.join(out,'parent-calendar.png'),fullPage:true});await other.setViewportSize({width:390,height:844});await other.screenshot({path:path.join(out,'parent-mobile.png'),fullPage:true});
 const overflow=await other.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
 // Leave and confirm the old child URL no longer exposes data.
 await mom.locator('#openChildNicknameSettings').click();await mom.locator('.settings-more summary').click();await mom.locator('#leaveChild').click();await mom.locator('#onboarding').waitFor();assert.deepEqual(await mom.locator('.nav button').allTextContents(),['设置']);assert.equal(await mom.locator('[data-open-child]').count(),0);
 const denied=await mom.evaluate(async(id)=>(await fetch(`/api/children/${id}/data`)).status,firstId);assert.equal(denied,403);
 // Logout also clears the page before the delayed server response completes.
 await dad.getByRole('button',{name:'设置',exact:true}).click();await dad.locator('#openAccountManagement').click();await dad.locator('#settingsLogout').waitFor();await dad.route('**/api/auth/logout',async route=>{await new Promise(r=>setTimeout(r,600));await route.continue()});await dad.locator('#settingsLogout').click();await dad.locator('#confirmLogout').click();assert.equal(await dad.locator('[data-open-child]').count(),0);await dad.locator('#loginName').waitFor();
 }
 await exerciseAdminUI({admin,browser,port:18888,passwords,out,createParent});
 assert.deepEqual(failures,[]);
 const scenarios=['unbound onboarding/create/invitations/account-only settings','calendar home/recent child/permission fallback','invitation sent time/revoked visibility','parent settings layout/nickname/immutable login','parent settings presets/categories/backup','parent settings invitations/roles/archive','parent settings stale reads/logout cancel','admin login/password/create','parent login responsive/feedback','parent forced password/no current/centered responsive card/visibility/logout dialog','task create/complete','gift redeem/reverse','specific-child invite','multiple child isolation','two-tab context','slow history/logout invalidation','out-of-order read monotonicity','legacy image HTML escaping','child print title','restore permissions','member self-leave','mobile layout','child portrait cards / keyboard / responsive','child switch only / existing management','child dialog stale response/logout','admin search/status/refresh','admin disable/enable/cancel','admin password reset','admin dialog keyboard/focus','admin mobile layout','admin profile/logout/stale save'];
 console.log(JSON.stringify({passed:true,scenarios:process.argv.includes('--admin-only')?scenarios.filter(s=>s.startsWith('admin ')):scenarios,pageErrors:failures,screenshots:process.argv.includes('--admin-only')?4:23}));
 }catch(error){console.error(error.stack);if(browser){for(const [i,context] of browser.contexts().entries()){const page=context.pages().at(-1);if(page){await page.screenshot({path:path.join(out,`failure-${i}.png`),fullPage:true});console.error(`Context ${i}: `+(await page.locator('body').innerText()).slice(0,2000))}}}process.exitCode=1}
 finally{if(browser)await browser.close();for(const child of children)child.kill('SIGTERM')}
})();
