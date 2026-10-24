const {selectNumber,selectMonthDay}=require('./picker_actions.cjs');
/* Independent recurrence regressions on a temporary child in the isolated UI DB. */
const assert = require('node:assert/strict')
const path = require('node:path')

async function exerciseRecurrence({dad, origin, firstId, api, data, choose, persisted, out, axe, stage}) {
  stage('recurrence history survives stop and single-tail reedit; explicit monthly day and repeat count persist')
  const child = (await api(dad, '/api/children', 'POST', {name:'规则修复隔离验收'})).child
  assert.ok(child?.id)
  const dates = await dad.evaluate(() => {
    const date = new Date(), format = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const shift = n => {const next=new Date(date);next.setDate(date.getDate()+n);return format(next)}
    return {today:shift(0), previous:shift(-4), countStart:shift(-2), monthly:format(new Date(date.getFullYear(),date.getMonth(),15))}
  })
  let state = await data(dad, child.id)
  const task = {title:'历史规则保留',note:'',startDate:dates.previous,startTime:'07:00',endTime:'07:20',categoryId:state.data.categories[0].id,points:2,recurrence:{freq:'daily',interval:1,endType:'never'}}
  async function command(kind,payload) {
    state = await data(dad,child.id)
    const result = await api(dad,`/api/children/${child.id}/operations`,'POST',{
      kind,payload,expectedRevision:state.revision,membershipVersion:state.context.membershipVersion,operationId:require('node:crypto').randomUUID(),
    })
    assert.equal(result.status,200,JSON.stringify(result))
    state=result
    return result
  }
  async function save() {
    await dad.locator('#taskDialog button[type="submit"]').click()
    if(await dad.locator('#taskNotice').isVisible())await dad.locator('#taskDialog button[type="submit"]').click()
    await dad.locator('#taskDialog').waitFor({state:'hidden'})
  }
  try {
    await command('task.create',{task})
    const sid=state.data.series[0].id,key=`${sid}@${dates.previous}`,tail=`${sid}@${dates.today}`
    await command('task.edit',{occurrenceKey:tail,scope:'future',task:{...task,startDate:dates.today,recurrence:null}})
    await dad.goto(`${origin}/children/${child.id}`)
    await dad.locator('#calendarTitle').waitFor()
    const old=dad.locator(`[data-month-occ="${key}"]`)
    await old.locator('[data-task-complete]').click()
    await persisted(dad,child.id,p=>p.data.completions.some(c=>c.occurrenceKey===key&&c.completed))
    await old.locator('[data-task-complete]').click()
    await persisted(dad,child.id,p=>p.data.ledger.length===2&&p.data.ledger.reduce((n,l)=>n+l.amount,0)===0)
    await dad.locator(`[data-month-occ="${tail}"] [data-task-edit]`).click()
    assert.equal(await dad.locator('#taskRepeat').getAttribute('data-state'),'unchecked')
    await dad.locator('#taskTitle').fill('单次尾段再编辑')
    await choose(dad,'taskScope','本次及以后')
    await save()
    await old.waitFor()
    assert.equal((await data(dad,child.id)).data.series[0].revisions.length,2)
    await command('task.create',{task:{...task,title:'每月规则',startDate:dates.monthly,startTime:'08:00',endTime:'08:20',recurrence:{freq:'monthly',interval:1,monthDay:15,endType:'never'}}})
    await command('task.create',{task:{...task,title:'次数规则',startDate:dates.countStart,startTime:'09:00',endTime:'09:20',recurrence:{freq:'daily',interval:1,endType:'count',count:5}}})
    const monthlyId=state.data.series.find(s=>s.title==='每月规则').id,countId=state.data.series.find(s=>s.title==='次数规则').id
    await dad.reload()
    await dad.locator('#calendarTitle').waitFor()
    await dad.locator(`[data-month-occ="${monthlyId}@${dates.monthly}"] [data-task-edit]`).click()
    await selectMonthDay(dad,20)
    await choose(dad,'taskScope','整个任务系列')
    await save()
    assert.equal((await data(dad,child.id)).data.series.find(s=>s.id===monthlyId).recurrence.monthDay,20)
    await dad.locator(`[data-month-occ="${countId}@${dates.today}"] [data-task-edit]`).click()
    await selectNumber(dad,'repeatCount',10)
    await choose(dad,'taskScope','本次及以后')
    await axe(dad,'recurrence-fixed-count-help')
    await dad.screenshot({path:path.join(out,'recurrence-fixed-editor.png')})
    await save()
    assert.equal((await data(dad,child.id)).data.series.find(s=>s.id===countId).recurrence.count,10)
  } finally {
    await api(dad,`/api/children/${child.id}`,'DELETE',{})
    await dad.goto(`${origin}/children/${firstId}`)
    await dad.locator('#calendarTitle').waitFor()
  }
}
module.exports={exerciseRecurrence}
