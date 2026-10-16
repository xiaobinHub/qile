/* Login UI checks run only against the disposable browser test service. */
const assert=require('node:assert/strict');
const path=require('node:path');

async function exerciseParentLoginUI({page,port,out}){
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#loginForm').waitFor();
  await page.locator('#loginPassword').fill('Abc123');
  let writes=0;
  const record=request=>{if(request.method()==='POST')writes++};
  page.on('request',record);
  await page.getByRole('button',{name:'显示密码',exact:true}).click();
  assert.equal(await page.locator('#loginPassword').getAttribute('type'),'text');
  assert.equal(await page.locator('#loginPassword').inputValue(),'Abc123');
  await page.getByRole('button',{name:'隐藏密码',exact:true}).click();
  assert.equal(await page.locator('#loginPassword').getAttribute('type'),'password');
  assert.equal(writes,0,'Password visibility does not submit the form');
  page.off('request',record);

  // Verify Enter, in-flight feedback, a real failed login, and recovery.
  let capturedLogin,releaseLogin;
  const captured=new Promise(resolve=>capturedLogin=resolve),release=new Promise(resolve=>releaseLogin=resolve);
  await page.route('**/api/auth/login',async route=>{capturedLogin();await release;await route.continue()},{times:1});
  await page.locator('#loginName').fill('login-ui-missing-user');
  await page.locator('#loginPassword').press('Enter');
  await captured;
  assert.equal(await page.locator('#loginSubmit').isDisabled(),true);
  assert.equal(await page.locator('#loginSubmit').getAttribute('aria-busy'),'true');
  assert.equal(await page.locator('#loginSubmitLabel').innerText(),'正在登录…');
  releaseLogin();
  await page.getByText('账号或密码不正确。',{exact:true}).waitFor();
  assert.equal(await page.locator('#loginError').getAttribute('role'),'alert');
  assert.equal(await page.locator('#loginSubmit').isEnabled(),true);

  await page.reload();
  await page.locator('#loginForm').waitFor();
  for(const [name,width,height] of [['desktop',815,954],['mobile',390,844]]){
    await page.setViewportSize({width,height});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false,'Login fits the viewport without unnecessary scrolling');
    assert.equal(await page.locator('#loginError').isVisible(),false);
    await page.screenshot({path:path.join(out,`parent-login-${name}.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:600});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.locator('#loginSubmit').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#loginSubmit').isVisible(),true);
  await page.setViewportSize({width:1280,height:720});
}

module.exports={exerciseParentLoginUI};
