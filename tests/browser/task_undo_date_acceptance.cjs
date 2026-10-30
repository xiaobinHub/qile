const assert=require('node:assert/strict')
const path=require('node:path')
async function exerciseUndoDate({browser,dad,origin,api,axe,stage,out}) {
 stage('task dates and undo confirmation: cancel, retry, duplicate guard, focus, week/month and responsive ledger')
 const child=(await api(dad,'/api/children','POST',{name:'撤销验收'})).child
 const base=`/api/children/${child.id}`
 async function op(kind,payload) {
  const current=await api(dad,base+'/data')
  const result=await api(dad,base+'/operations','POST',{kind,payload,expectedRevision:current.revision,membershipVersion:current.context.membershipVersion,operationId:crypto.randomUUID()})
  assert.equal(result.status,200);return result
 }
 const day=await dad.evaluate(()=>{const d=new Date();d.setDate(d.getDate()-2);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`})
 const current=await api(dad,base+'/data')
 const created=await op('task.create',{task:{title:'跨日阅读',startDate:day,startTime:'18:00',endTime:'18:30',categoryId:current.data.categories.find(c=>c.active).id,points:7,note:'',recurrence:null}})
 const key=created.data.series.at(-1).id+'@'+day
 await op('completion.set',{occurrenceKey:key,completed:true})
 for(const [width,height] of [[1305,890],[820,1180],[1180,820],[390,844]]) {
  const context=await browser.newContext({storageState:await dad.context().storageState(),viewport:{width,height}})
  const page=await context.newPage();page.setDefaultTimeout(12000)
  const writes=[];page.on('request',r=>{if(r.url().endsWith('/operations')&&r.method()==='POST')writes.push(r.postDataJSON())})
  try {
   await page.goto(`${origin}/children/${child.id}`)
   let button=page.locator(`[data-task-complete="${key}"]`)
   await button.click()
   const dialog=page.locator('#undoTaskCompletionDialog')
   await dialog.getByRole('heading',{name:'撤销完成任务？',exact:true}).waitFor()
   assert.match(await dialog.innerText(),/跨日阅读/);assert.match(await dialog.innerText(),/7 积分/)
   const before=await api(dad,base+'/data')
   await axe(page,`undo-confirm-month-${width}`)
   await page.screenshot({path:path.join(out,`undo-confirm-month-${width}.png`)})
   assert.equal(writes.length,0)
   await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'})
   const afterCancel=await api(dad,base+'/data');assert.equal(afterCancel.revision,before.revision)
   await page.waitForFunction(key=>document.activeElement?.getAttribute('data-task-complete')===key,key)
   await page.locator('[data-mode="week"]').click()
   await page.locator('#weekCalendar').waitFor()
   // A continuous month may anchor the week before or after the task's date.
   for(let attempt=0;attempt<4&&!await button.count();attempt++) {
    const first=await page.locator('[data-week-day]').first().getAttribute('data-week-day')
    await page.locator(day<first?'#prevPeriod':'#nextPeriod').click()
   }
   await button.press('Enter');await dialog.waitFor()
   await axe(page,`undo-confirm-week-${width}`)
   await page.route('**/operations',route=>route.fulfill({status:400,json:{error:'测试：撤销暂时失败'}}),{times:1})
   await dialog.getByRole('button',{name:'确认撤销',exact:true}).click()
   await dialog.getByText('测试：撤销暂时失败',{exact:true}).waitFor()
   assert.equal((await api(dad,base+'/data')).revision,before.revision)
   let release;const gate=new Promise(r=>release=r)
   await page.route('**/operations',async route=>{await gate;const response=await route.fetch();await route.fulfill({response})},{times:1})
   const confirm=dialog.getByRole('button',{name:'确认撤销',exact:true})
   await confirm.click();await page.waitForFunction(()=>document.querySelector('#undoTaskCompletionDialog button')?.disabled===true)
   const count=writes.length;await dialog.getByRole('button').last().dispatchEvent('click');assert.equal(writes.length,count)
   release();await dialog.waitFor({state:'hidden'});assert.equal(writes.length,2)
   const saved=await api(dad,base+'/data');assert.equal(saved.revision,before.revision+1)
   assert.equal(saved.data.ledger.length,before.data.ledger.length+1)
   assert.equal(saved.data.ledger.at(-1).kind,'task-reversal');assert.equal(saved.data.ledger.at(-1).taskDate,day)
   assert.notEqual(saved.data.ledger.at(-1).date,day)
   assert.equal(await button.getAttribute('aria-pressed'),'false')
   await page.locator('[data-view="store"]').click();await page.locator('[data-store-tab="ledger"]').click()
   if(width>680) {
    await page.getByRole('columnheader',{name:'操作日期',exact:true}).waitFor()
    await page.getByRole('columnheader',{name:'任务日期',exact:true}).waitFor()
    assert.equal(await page.locator(`[data-ledger-id="${saved.data.ledger.at(-1).id}"] [data-ledger-task-date]`).innerText(),day)
   } else assert.match(await page.locator('.ledger-mobile-card').first().innerText(),new RegExp('任务日期：'+day))
   await axe(page,`ledger-task-dates-${width}`)
   await page.screenshot({path:path.join(out,`ledger-task-dates-${width}.png`)})
   await op('completion.set',{occurrenceKey:key,completed:true})
  } finally {await context.close()}
 }
 await api(dad,base,'DELETE',{})
}
module.exports={exerciseUndoDate}
