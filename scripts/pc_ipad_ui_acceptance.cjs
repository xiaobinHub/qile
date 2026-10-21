/* Read-only visual/interaction acceptance inside the disposable unified UI database. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const viewports = [
  [1280,720,false], [1280,900,false], [1440,900,false],
  [820,1180,true], [1180,820,true], [1024,1366,true], [1366,1024,true],
];
async function exercisePCIPad({ browser, dad, admin, origin, adminOrigin, firstId, out, axe, stage }) {
  const evidence = [];
  const state = await dad.context().storageState(), adminState = await admin.context().storageState();
  async function shot(page, name) {
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth+1), false, name+' has no page overflow');
    await page.screenshot({path:path.join(out,name+'.png')});
  }
  stage('PC and iPad viewport, fixed actions, cards, settings, rewards and admin acceptance');
  for(const [width,height,touch] of viewports) {
    const tag=`${width}x${height}`, context=await browser.newContext({storageState:state,viewport:{width,height},hasTouch:touch,isMobile:touch});
    try {
      const page=await context.newPage();page.setDefaultTimeout(15000);
      // These windows inspect or deliberately reject writes; all genuine regression writes remain in the main test context.
      await page.route('**/api/**', route => route.request().method()==='GET' ? route.continue() : route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离验收：保存暂时失败，请保留输入重试。'})}));
      await page.goto(`${origin}/children/${firstId}`);await page.locator('#calendarTitle').waitFor();
      if(touch) {
        assert.equal(await page.locator('.touch-month').count(),1);
        const targets=await page.locator('.month-cell').first().locator('button').count();assert.equal(targets,1,'Touch day cell has a single entry');
        const day=await page.locator('.day-open').first().boundingBox();assert.ok(day.width>=44&&day.height>=44);
        for(const target of ['[data-mode="month"]','[data-mode="week"]','#todayBtn']) { const box=await page.locator(target).boundingBox();assert.ok(box.height>=44&&box.width>=44,target+' touch target'); }
      }
      await shot(page,`pc-ipad-${tag}-month`);
      await page.locator('#newTaskBtn').click();await page.locator('#taskTitle').fill('长表单布局验收');
      assert.equal(await page.locator('#taskNotePanel').isVisible(),false);
      await page.locator('[aria-controls="taskNotePanel"]').click();await page.locator('#taskNote').fill('备注保留检查。'.repeat(80));
      await page.locator('#taskRepeat').click();
      const footer=await page.locator('#taskDialog .ui-modal-footer').boundingBox(), header=await page.locator('#taskDialog .ui-modal-header').boundingBox();
      assert.ok(footer.y>=0&&footer.y+footer.height<=height&&header.y>=0,'Task header/footer fit viewport');
      assert.equal(await page.locator('#taskDialog button[type="submit"]').getAttribute('form'),'taskForm');
      const typeWidth=await page.locator('#taskCategory').evaluate(el=>({width:el.getBoundingClientRect().width,parent:el.parentElement.getBoundingClientRect().width}));
      assert.ok(typeWidth.width>=typeWidth.parent-2,'Task select fills its field');
      await page.locator('#taskDialog .ui-modal-body').evaluate(el=>el.scrollTop=el.scrollHeight);
      const footerAfter=await page.locator('#taskDialog .ui-modal-footer').boundingBox();assert.ok(Math.abs(footerAfter.y-footer.y)<1,'Only modal body scrolls');
      await shot(page,`pc-ipad-${tag}-repeat`);
      if(width===1280&&height===720) {
        await page.locator('#taskDialog button[type="submit"]').click();
        if(await page.locator('#taskNotice').isVisible())await page.locator('#taskDialog button[type="submit"]').click();
        await page.getByText('隔离验收：保存暂时失败，请保留输入重试。',{exact:true}).waitFor();
        assert.equal(await page.locator('#taskTitle').inputValue(),'长表单布局验收');
        await axe(page,'pc-ipad-task-error');
      }
      await page.keyboard.press('Escape');await page.locator('#taskDialog').waitFor({state:'hidden'});
      await page.locator('#openChildrenDialog').click();
      if(width===1280&&height===900){await axe(page,'pc-ipad-child-cards');await shot(page,'pc-ipad-child-cards');}
      await page.keyboard.press('Escape');await page.locator('#childrenDialog').waitFor({state:'hidden'});
      await page.waitForFunction(()=>document.activeElement===document.querySelector('#openChildrenDialog'));
      await page.locator('[data-mode="week"]').click();
      const before=await page.locator('.week-wrap').evaluate(el=>{el.scrollTop=680;el.scrollLeft=100;return {top:el.scrollTop,left:el.scrollLeft}});
      await page.locator('[data-view="settings"]').click();await page.locator('#openPasswordSettings').click();
      const full=await page.locator('#passwordNew').evaluate(el=>({input:el.parentElement.getBoundingClientRect().width,form:el.closest('form').getBoundingClientRect().width}));assert.ok(Math.abs(full.input-full.form)<2,'Password field spans available content');
      const sidebar=await page.locator('.settings-sidebar').boundingBox();assert.ok(Math.abs(sidebar.width-(width<=1000?184:224))<=2,'Settings split sidebar width');
      await shot(page,`pc-ipad-${tag}-settings`);
      await page.locator('[data-view="calendar"]').click();
      await page.waitForFunction(expected=>{const el=document.querySelector('.week-wrap');return el&&Math.abs(el.scrollTop-expected.top)<2&&Math.abs(el.scrollLeft-expected.left)<2},before);
      await shot(page,`pc-ipad-${tag}-week`);
      await page.locator('[data-view="store"]').click();await page.locator('[data-store-tab="gifts"]').waitFor();
      assert.equal(await page.locator('[aria-label="商城内容"] [role="tab"]').count(),2);
      assert.equal(await page.locator('#giftManageBtn').isVisible(),true);assert.equal(await page.locator('#manualBtn').count(),0);assert.equal(await page.getByText('当前积分',{exact:true}).count(),0);
      assert.equal(await page.locator('#giftHistoryToggle').getAttribute('aria-expanded'),'false');await page.locator('#giftHistoryToggle').press('Enter');assert.equal(await page.locator('#giftHistoryToggle').getAttribute('aria-expanded'),'true');await page.locator('#giftHistoryToggle').press('Space');assert.equal(await page.locator('#giftHistoryToggle').getAttribute('aria-expanded'),'false');
      if(width===820)await axe(page,'store-gifts-ipad');
      await shot(page,`pc-ipad-${tag}-store`);await page.locator('[data-store-tab="ledger"]').click();
      assert.equal(await page.locator('#giftManageBtn').count(),0);assert.equal(await page.locator('#manualBtn').isVisible(),true);
      assert.equal(await page.locator('.ledger-desktop td.ledger-number').first().evaluate(el=>getComputedStyle(el).textAlign),'right');
      await shot(page,`pc-ipad-${tag}-ledger`);
      if(width===820){await axe(page,'pc-ipad-settings-ledger');}
      // Menu -> confirmation must retain focus on cancellation; never execute deletions here.
      if(width===1280&&height===900){
        await page.locator('[data-view="settings"]').click();await page.locator('#openTaskPresetsSettings').click();
        await page.locator('[data-preset-menu]').first().click();await page.locator('[data-preset-delete]').first().click();
        await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
        await page.waitForFunction(()=>document.activeElement?.hasAttribute('data-preset-menu'));
        await page.locator('#openCategorySettings').click();await page.locator('[data-category-menu]').first().press('Enter');
        await page.locator('[data-cat-delete]').first().press('Enter');await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
        await page.waitForFunction(()=>document.activeElement?.hasAttribute('data-category-menu'));
        await axe(page,'pc-ipad-category-menus');
      }
      evidence.push({viewport:[width,height],touch,passed:true});
    } finally {await context.close();}
    const ac=await browser.newContext({storageState:adminState,viewport:{width,height},hasTouch:touch,isMobile:touch});
    try{const p=await ac.newPage();await p.goto(adminOrigin);await p.locator('#userRows tr[data-user-id]').first().waitFor();await shot(p,`pc-ipad-${tag}-admin`);if(width===1280&&height===900)await axe(p,'pc-ipad-admin');await p.locator('#openCreateUser').click();const rect=await p.getByRole('dialog').boundingBox();assert.ok(rect.y>=0&&rect.y+rect.height<=height);await shot(p,`pc-ipad-${tag}-admin-create`);if(width===820)await axe(p,'pc-ipad-admin-create');}finally{await ac.close();}
  }
  fs.writeFileSync(path.join(out,'pc-ipad-acceptance.json'),JSON.stringify({passed:true,viewports:evidence,physicalIPad:'Not tested: physical keyboard/PWA resume/system print still require device acceptance.'},null,2));
}
module.exports={exercisePCIPad};
