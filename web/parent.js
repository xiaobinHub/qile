
  (()=>{'use strict';
    const KEY='lele-task-manager.v1',APP_VERSION=2,BACKUP_VERSION=1,FORMAT='lele-task-manager-backup';
    const SELFTEST=new URLSearchParams(location.search).get('selftest')==='1';
    const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
    const APP_ICON=$('#appIcon')?.href||'';
    const uid=()=>globalThis.crypto?.randomUUID?.()||'id-'+Date.now().toString(36)+Math.random().toString(36).slice(2);
    const pad=n=>String(n).padStart(2,'0');
    function parseDate(s){const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d,12)}
    function dateStr(d){return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}
    function addDays(s,n){const d=parseDate(s);d.setDate(d.getDate()+n);return dateStr(d)}
    function startWeek(s){const d=parseDate(s),day=(d.getDay()+6)%7;return addDays(s,-day)}
    function monthStart(s){return s.slice(0,7)+'-01'}
    function monthEnd(s){const d=parseDate(monthStart(s));d.setMonth(d.getMonth()+1);return addDays(dateStr(d),-1)}
    function shiftMonth(s,n){const d=parseDate(monthStart(s));d.setMonth(d.getMonth()+n);return dateStr(d).slice(0,7)}
    function daysInMonth(y,m){return new Date(y,m,0,12).getDate()}
    function cmp(a,b){return a<b?-1:a>b?1:0}
    function rangeDates(a,b){const out=[];for(let d=a;cmp(d,b)<=0;d=addDays(d,1))out.push(d);return out}
    function fmtDate(s){const d=parseDate(s);return `${d.getMonth()+1}月${d.getDate()}日`}
    function fmtFull(s){const d=parseDate(s),w='日一二三四五六'[d.getDay()];return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 周${w}`}
    function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
    const DAY_MINUTES=24*60,WEEK_INITIAL_SCROLL=9*60,WEEK_EVENT_TOP_GAP=8;
    function minutes(t){const [h,m]=t.split(':').map(Number);return h*60+m}
    function timeAt(min){return `${pad(Math.floor(min/60))}:${pad(min%60)}`}
    function weekSlotAt(y){return Math.max(0,Math.min(DAY_MINUTES-30,Math.round(y/30)*30))}
    function weekInitialScroll(items){const earliest=items.reduce((min,o)=>Math.min(min,minutes(o.startTime)),Infinity);return Number.isFinite(earliest)?Math.max(0,earliest-WEEK_EVENT_TOP_GAP):WEEK_INITIAL_SCROLL}
    function layoutWeekEvents(events){const sorted=events.map((event,index)=>({event,index,start:minutes(event.startTime),end:minutes(event.endTime)})).sort((a,b)=>a.start-b.start||b.end-a.end||a.event.occurrenceKey.localeCompare(b.event.occurrenceKey)),result=[];let group=[],groupEnd=-1;const placeGroup=()=>{if(!group.length)return;const active=[],placed=[];for(const item of group){for(let i=active.length-1;i>=0;i--)if(active[i].end<=item.start)active.splice(i,1);let depth=0;while(active.some(x=>x.depth===depth))depth++;const placedItem={...item,depth};active.push(placedItem);placed.push(placedItem)}const stacked=placed.length>1;result.push(...placed.map(item=>({...item,stacked})));group=[];groupEnd=-1};for(const item of sorted){if(group.length&&item.start>=groupEnd)placeGroup();group.push(item);groupEnd=Math.max(groupEnd,item.end)}placeGroup();return result.sort((a,b)=>a.index-b.index)}
    function validId(s){return typeof s==='string'&&/^[A-Za-z0-9._:-]{1,100}$/.test(s)}
    function validColor(s){return typeof s==='string'&&/^#[0-9a-fA-F]{6}$/.test(s)}
    function validDate(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&dateStr(parseDate(s))===s}
    function validTime(s){return typeof s==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(s)}
    function validRule(r,start){if(r==null)return true;if(!r||!['daily','weekly','monthly'].includes(r.freq)||!Number.isInteger(Number(r.interval))||Number(r.interval)<1||Number(r.interval)>99||!['never','until','count'].includes(r.endType))return false;if(r.freq==='weekly'&&(!Array.isArray(r.weekdays)||!r.weekdays.length||r.weekdays.some(x=>!Number.isInteger(Number(x))||Number(x)<0||Number(x)>6)))return false;if(r.freq==='monthly'&&(!Number.isInteger(Number(r.monthDay))||Number(r.monthDay)<1||Number(r.monthDay)>31))return false;if(r.endType==='until'&&(!validDate(r.until)||cmp(r.until,start)<0))return false;if(r.endType==='count'&&(!Number.isInteger(Number(r.count))||Number(r.count)<1||Number(r.count)>10000))return false;return true}
    function validTaskRecord(s,dateKey='startDate'){return !!s&&validId(s.id||s.seriesId)&&typeof s.title==='string'&&!!s.title.trim()&&validDate(s[dateKey])&&validTime(s.startTime)&&validTime(s.endTime)&&minutes(s.endTime)>minutes(s.startTime)&&validId(s.categoryId)&&Number.isInteger(Number(s.points))&&Number(s.points)>=0}
    function validIso(value){return typeof value==='string'&&!Number.isNaN(Date.parse(value))}
    function validGiftImage(value){return value==null||value===''||(typeof value==='string'&&value.length<=260000&&/^data:image\/(?:webp|jpeg|png);base64,/i.test(value))}
    function migrateData(input){
      if(!input||typeof input!=='object')return input;
      const migrated=JSON.parse(JSON.stringify(input));
      if(migrated.schemaVersion===1){migrated.schemaVersion=2;migrated.gifts=[]}
      // 旧版本曾允许“截止日期早于开始日期”的重复任务写入。保留任务本身，
      // 将截止日收敛到开始日，避免一条异常记录阻止整份计划加载。
      const legacyRepairIds=new Set(['8abda68e-b07d-4e39-9046-6257f82611ed','84a95435-c539-4255-a26f-a3ffb6aceed0']);
      migrated.series=(migrated.series||[]).filter(task=>!legacyRepairIds.has(task?.id));
      migrated.exceptions=(migrated.exceptions||[]).filter(ex=>!legacyRepairIds.has(ex?.seriesId));
      const emptySplitIds=new Set(['d5e2a558-956c-43d3-8670-dccf44a9c372']);
      migrated.series=(migrated.series||[]).filter(task=>!emptySplitIds.has(task?.id));
      migrated.exceptions=(migrated.exceptions||[]).filter(ex=>!emptySplitIds.has(ex?.seriesId));
      for(const task of migrated.series||[]){
        const rule=task?.recurrence;
        if(rule?.endType==='until'&&validDate(task.startDate)&&validDate(rule.until)&&cmp(rule.until,task.startDate)<0)rule.until=task.startDate;
        if(!Array.isArray(task.revisions)||!task.revisions.length){
          task.revisions=[{id:`${task.id}:v1`,effectiveFrom:task.startDate,title:task.title,note:task.note||'',startTime:task.startTime,endTime:task.endTime,categoryId:task.categoryId,points:Number(task.points)||0,recurrence:task.recurrence?JSON.parse(JSON.stringify(task.recurrence)):null}];
        }
      }
      if(!Array.isArray(migrated.operationLog))migrated.operationLog=[];
      if(!Object.hasOwn(migrated,'taskPresets'))migrated.taskPresets=[];
      return migrated
    }
    function defaults(){return {schemaVersion:APP_VERSION,settings:{childName:'乐乐',weekStartsOn:1},categories:[['作业','#e56b6f'],['学习','#5b8def'],['阅读','#8e7dbe'],['锻炼','#52a675'],['家务','#e6a23c'],['其他','#7a8b99']].map(([name,color])=>({id:uid(),name,color,active:true})),series:[],exceptions:[],completions:[],ledger:[],gifts:[],operationLog:[],taskPresets:[]}}
    function validateData(d){
      if(!d||d.schemaVersion!==APP_VERSION)throw Error(d?.schemaVersion>APP_VERSION?'备份来自更高版本，当前工具无法读取':'数据版本不受支持');
      for(const k of ['settings','categories','series','exceptions','completions','ledger','gifts','operationLog'])if(!(k in d))throw Error(`缺少数据项：${k}`);
      for(const k of ['categories','series','exceptions','completions','ledger','gifts','operationLog'])if(!Array.isArray(d[k]))throw Error(`数据项 ${k} 格式不正确`);
      if(!d.settings||typeof d.settings!=='object')throw Error('设置数据格式不正确');
      if(!Array.isArray(d.taskPresets)||new Set(d.taskPresets.map(x=>x?.id)).size!==d.taskPresets.length||d.taskPresets.some(x=>!x||!validId(x.id)||validateTaskPreset(x)))throw Error('常用任务配置不完整或存在重复标识');
      const ids=new Set(d.categories.map(x=>x?.id));
      if(ids.size!==d.categories.length||d.categories.some(x=>!x||!validId(x.id)||typeof x.name!=='string'||!x.name.trim()||!validColor(x.color)||typeof x.active!=='boolean'))throw Error('任务类型数据不完整或存在重复标识');
      for(const preset of d.taskPresets)if(preset.categoryId&&!ids.has(preset.categoryId))throw Error(`常用任务“${preset.title}”引用了不存在的类型`);
      const seriesIds=new Set(d.series.map(x=>x?.id));
      if(seriesIds.size!==d.series.length)throw Error('任务系列存在重复标识');
      for(const s of d.series){if(!validTaskRecord(s)||!validRule(s.recurrence,s.startDate))throw Error(`任务“${s?.title||''}”数据不完整`);if(!ids.has(s.categoryId))throw Error(`任务“${s.title||''}”引用了不存在的类型`);if(s.revisions!=null){if(!Array.isArray(s.revisions)||!s.revisions.length)throw Error(`任务“${s.title||''}”规则版本不完整`);for(const rev of s.revisions){const version={...s,...rev,startDate:rev.effectiveFrom};if(!validId(rev.id)||!validDate(rev.effectiveFrom)||!validTaskRecord(version)||!validRule(version.recurrence,version.startDate))throw Error(`任务“${s.title||''}”规则版本不完整`);if(!ids.has(version.categoryId))throw Error(`任务“${s.title||''}”规则版本引用了不存在的类型`)}}}
      for(const ex of d.exceptions){if(!ex||!validId(ex.id||'legacy')||!seriesIds.has(ex.seriesId)||!validDate(ex.originalDate)||!['cancel','override'].includes(ex.action))throw Error('重复任务例外数据不完整');if(ex.action==='override'&&(!validTaskRecord(ex.data,'date')||!ids.has(ex.data.categoryId)))throw Error('重复任务覆盖内容不完整')}
      for(const c of d.completions)if(!c||typeof c.occurrenceKey!=='string'||typeof c.completed!=='boolean'||!validTaskRecord(c.snapshot,'date')||!ids.has(c.snapshot.categoryId))throw Error('完成记录快照不完整');
      const ledgerById=new Map(d.ledger.map(x=>[x?.id,x]));
      for(const x of d.ledger){
        if(!x||!validId(x.id)||!['task-complete','task-reversal','manual','gift-redeem','gift-reversal'].includes(x.kind)||!Number.isInteger(Number(x.amount))||!validDate(x.date)||!validIso(x.createdAt))throw Error('积分流水记录不完整');
        if(x.kind==='manual'&&(!x.reason||typeof x.reason!=='string'))throw Error('手动积分记录缺少原因');
        if(x.kind==='gift-redeem'&&(!(Number(x.amount)<0)||!validId(x.giftId)||!x.giftSnapshot||typeof x.giftSnapshot.name!=='string'||!x.giftSnapshot.name.trim()||!Number.isInteger(Number(x.giftSnapshot.points))||Number(x.giftSnapshot.points)!==-Number(x.amount)))throw Error('礼品兑换流水不完整');
        if(x.kind==='gift-reversal'){const original=ledgerById.get(x.relatedLedgerId);if(!(Number(x.amount)>0)||!validId(x.giftId)||!validId(x.relatedLedgerId)||original?.kind!=='gift-redeem'||original.giftId!==x.giftId||Number(x.amount)!==-Number(original.amount))throw Error('礼品撤销流水不完整')}
      }
      const giftIds=new Set(d.gifts.map(x=>x?.id));
      if(giftIds.size!==d.gifts.length)throw Error('礼品存在重复标识');
      for(const gift of d.gifts){
        if(!gift||!validId(gift.id)||typeof gift.name!=='string'||!gift.name.trim()||gift.name.trim().length>40||!Number.isInteger(Number(gift.points))||Number(gift.points)<1||Number(gift.points)>99999||!validGiftImage(gift.imageData)||!['available','redeemed'].includes(gift.status)||!validIso(gift.createdAt)||!validIso(gift.updatedAt))throw Error('礼品数据不完整');
        if(gift.status==='redeemed'){const entry=ledgerById.get(gift.redemptionLedgerId);if(!validIso(gift.redeemedAt)||entry?.kind!=='gift-redeem'||entry.giftId!==gift.id)throw Error(`礼品“${gift.name}”兑换状态不完整`)}
      }
      return d
    }
    class StoreError extends Error{constructor(message,kind='connection'){super(message);this.kind=kind}}
    let corruptRaw=null,storageIssue='',data=null,persistedData=null,saveBusy=false,refreshBusy=false,giftEditorId=null,giftDraftImage='',redeemingGiftId=null,giftBusy=false;
    const storageMeta={revision:0,updatedAt:null};
    async function readResponse(res){let body={};try{body=await res.json()}catch{}if(!res.ok)throw new StoreError(body.error||'无法连接数据服务。',res.status===401?'unauthorized':res.status===409?'conflict':res.status===422?'corrupt':'connection');return body}
    function jsonClone(value){return JSON.parse(JSON.stringify(value))}
    function jsonEqual(a,b){return JSON.stringify(a)===JSON.stringify(b)}
    function isRecord(value){return !!value&&typeof value==='object'&&!Array.isArray(value)}
    function mergeChanged(base,local,remote){if(jsonEqual(local,base))return jsonClone(remote);if(!isRecord(local)||!isRecord(base)||!isRecord(remote))return jsonClone(local);const merged={...remote},keys=new Set([...Object.keys(base),...Object.keys(local),...Object.keys(remote)]);for(const key of keys){if(!(key in local)){if(key in base)delete merged[key];continue}if(!(key in base)){merged[key]=jsonClone(local[key]);continue}merged[key]=mergeChanged(base[key],local[key],remote[key])}return merged}
    function mergeCollection(base=[],local=[],remote=[],key='id'){const baseMap=new Map(base.map(item=>[item?.[key],item])),localMap=new Map(local.map(item=>[item?.[key],item])),remoteMap=new Map(remote.map(item=>[item?.[key],item]));for(const [id,previous] of baseMap){const changed=localMap.get(id);if(!changed){remoteMap.delete(id);continue}if(!jsonEqual(changed,previous))remoteMap.set(id,mergeChanged(previous,changed,remoteMap.get(id)||{}))}for(const [id,item] of localMap)if(!baseMap.has(id))remoteMap.set(id,jsonClone(item));const order=[...remote.map(item=>item?.[key]),...local.map(item=>item?.[key])];return [...new Map(order.filter(id=>remoteMap.has(id)).map(id=>[id,remoteMap.get(id)])).values()]}
    function mergeAppData(base,local,remote){const merged={...remote};merged.settings=mergeChanged(base.settings||{},local.settings||{},remote.settings||{});for(const key of ['categories','series','exceptions','ledger','gifts','operationLog','taskPresets'])merged[key]=mergeCollection(base[key],local[key],remote[key],'id');merged.completions=mergeCollection(base.completions,local.completions,remote.completions,'occurrenceKey');return merged}
    const Store={};
    const state={view:'calendar',mode:'month',cursor:dateStr(new Date()),selectedDate:null,editing:null,deletingCategoryId:null,monthWindow:null,monthScrollIntent:'today',taskPicker:null,rangePicker:null,storeTab:'available'};
    const calendarScroll={top:0,left:0,frame:0};
    function category(id){return data.categories.find(x=>x.id===id)||{name:'已停用类型',color:'#888'}}
    function endAllows(rule,date,index){if(!rule)return index===0;if(rule.endType==='until'&&cmp(date,rule.until)>0)return false;if(rule.endType==='count'&&index>=Number(rule.count))return false;return true}
    function seriesRevisions(s){return Array.isArray(s.revisions)&&s.revisions.length?s.revisions.slice().sort((a,b)=>cmp(a.effectiveFrom,b.effectiveFrom)): [{id:`${s.id}:v1`,effectiveFrom:s.startDate,title:s.title,note:s.note||'',startTime:s.startTime,endTime:s.endTime,categoryId:s.categoryId,points:Number(s.points)||0,recurrence:s.recurrence?JSON.parse(JSON.stringify(s.recurrence)):null}]}
    function revisionForDate(s,date){const revisions=seriesRevisions(s);return revisions.slice().reverse().find(rev=>cmp(rev.effectiveFrom,date)<=0)||revisions[0]}
    function expandRevision(task,from,to){if(!task.recurrence)return cmp(task.startDate,from)>=0&&cmp(task.startDate,to)<=0?[makeOcc(task,task.startDate)]:[];const r=task.recurrence,out=[],hardEnd=r.endType==='until'?r.until:to,limit=cmp(hardEnd,to)<0?hardEnd:to,maxCount=r.endType==='count'?Number(r.count):5000;let generated=0;
      if(r.freq==='daily'){for(let d=task.startDate;cmp(d,limit)<=0&&generated<maxCount;d=addDays(d,Number(r.interval))){if(endAllows(r,d,generated)&&cmp(d,from)>=0)out.push(makeOcc(task,d));generated++}}
      if(r.freq==='weekly'){const anchor=startWeek(task.startDate),days=(r.weekdays||[]).map(Number).sort((a,b)=>a-b);for(let w=0;generated<maxCount;w+=Number(r.interval)){const ws=addDays(anchor,w*7);if(cmp(ws,limit)>0)break;for(const wd of days){const d=addDays(ws,wd);if(cmp(d,task.startDate)<0||cmp(d,limit)>0)continue;if(!endAllows(r,d,generated))break;if(cmp(d,from)>=0)out.push(makeOcc(task,d));generated++;if(generated>=maxCount)break}}}
      if(r.freq==='monthly'){const a=parseDate(task.startDate),anchorDay=r.monthDay||a.getDate();for(let i=0;generated<maxCount;i+=Number(r.interval)){const rawMonth=a.getMonth()+i,y=a.getFullYear()+Math.floor(rawMonth/12),m=((rawMonth%12)+12)%12+1,d=`${y}-${pad(m)}-${pad(Math.min(anchorDay,daysInMonth(y,m)))}`;if(cmp(d,limit)>0)break;if(!endAllows(r,d,generated))break;if(cmp(d,task.startDate)>=0&&cmp(d,from)>=0)out.push(makeOcc(task,d));generated++}}
      return out}
    function baseOccurrences(s,from,to){if(!s.recurrence)return expandRevision(s,from,to);const revisions=seriesRevisions(s),out=[];for(let i=0;i<revisions.length;i++){const rev=revisions[i],next=revisions[i+1],segmentFrom=rev.effectiveFrom,segmentTo=next?addDays(next.effectiveFrom,-1):to;if(cmp(segmentTo,from)<0||cmp(segmentFrom,to)>0)continue;const task={...s,...rev,id:s.id,startDate:segmentFrom};out.push(...expandRevision(task,from,cmp(segmentTo,to)<0?segmentTo:to))}const seen=new Set();return out.filter(item=>{if(seen.has(item.occurrenceKey))return false;seen.add(item.occurrenceKey);return true})}
    function makeOcc(s,date,originalDate=date){return {seriesId:s.id,occurrenceKey:`${s.id}@${originalDate}`,date,originalDate,title:s.title,note:s.note||'',startTime:s.startTime,endTime:s.endTime,categoryId:s.categoryId,points:Number(s.points)||0,recurring:!!s.recurrence}}
    function occurrences(from,to){let out=data.series.flatMap(s=>baseOccurrences(s,from,to));const byKey=new Map(out.map(o=>[o.occurrenceKey,o]));for(const ex of data.exceptions){const key=`${ex.seriesId}@${ex.originalDate}`;if(ex.action==='cancel')byKey.delete(key);else if(ex.action==='override'){byKey.delete(key);const o={...ex.data,seriesId:ex.seriesId,originalDate:ex.originalDate,occurrenceKey:key,recurring:true};if(cmp(o.date,from)>=0&&cmp(o.date,to)<=0)byKey.set(key,o)}}for(const c of data.completions.filter(x=>x.completed)){const o={...c.snapshot,occurrenceKey:c.occurrenceKey};if(cmp(o.date,from)>=0&&cmp(o.date,to)<=0)byKey.set(c.occurrenceKey,o)}out=[...byKey.values()];return out.sort((a,b)=>cmp(a.date,b.date)||cmp(a.startTime,b.startTime)||cmp(a.title,b.title))}
    function completion(key){return data.completions.find(x=>x.occurrenceKey===key)}
    function isDone(o){return !!completion(o.occurrenceKey)?.completed}
    function balance(){return data.ledger.reduce((n,x)=>n+Number(x.amount),0)}
    function cloneData(){return JSON.parse(JSON.stringify(data))}
    function taskSummary(task){if(!task)return null;return {title:task.title,date:task.startDate||task.date,startTime:task.startTime,endTime:task.endTime,points:Number(task.points)||0,categoryId:task.categoryId}}
    function recordOperation(action,meta,before){if(!data.operationLog)data.operationLog=[];const {beforeTask,afterTask,...rest}=meta;data.operationLog.push({id:uid(),at:new Date().toISOString(),action,...rest,before:taskSummary(beforeTask),after:taskSummary(afterTask),revision:storageMeta.revision+1});if(data.operationLog.length>500)data.operationLog.splice(0,data.operationLog.length-500)}
    function storageErrorMessage(error){if(error?.kind==='conflict')return'其他浏览器已更新数据，请刷新页面后再保存。';if(error?.kind==='unauthorized')return'访问口令已失效，请刷新页面后重新输入。';return error instanceof StoreError?error.message:'无法连接数据服务，当前修改已撤销。'}
    async function persist(msg,before,{renderPage=true,operation=null}={}){if(operation)recordOperation(operation.action,operation,before);try{await Store.save(data);if(renderPage)render();if(msg)toast(msg);return true}catch(error){data=before;toast(storageErrorMessage(error));return false}}
    function captureRefreshView(){const calendar=activeCalendarScroll();return calendar?{mode:state.mode,top:calendar.scrollTop,left:calendar.scrollLeft}:null}
    function restoreRefreshView(snapshot){if(!snapshot||state.view!=='calendar'||state.mode!==snapshot.mode)return;const calendar=activeCalendarScroll();if(!calendar)return;calendar.scrollTop=Math.max(0,Math.min(calendar.scrollHeight-calendar.clientHeight,snapshot.top));calendar.scrollLeft=Math.max(0,Math.min(calendar.scrollWidth-calendar.clientWidth,snapshot.left))}
    async function refreshPageData(){if(refreshBusy)return;const snapshot=captureRefreshView(),button=$('#refreshData');refreshBusy=true;if(button){button.disabled=true;button.classList.add('is-loading');button.setAttribute('aria-busy','true')}try{data=await Store.load();storageIssue='';render();requestAnimationFrame(()=>{restoreRefreshView(snapshot);toast('数据已刷新')})}catch(error){toast(storageErrorMessage(error))}finally{refreshBusy=false;const current=$('#refreshData');if(current){current.disabled=false;current.classList.remove('is-loading');current.removeAttribute('aria-busy')}}}
    let toastTimer;function toast(msg){const t=$('#toast');if(!t)return;t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400)}
    function appShell(){return `<div class="app"><header class="topbar"><div class="brand"><div class="brand-mark"><img src="${APP_ICON}" alt=""></div><div><strong>乐乐成长计划</strong><small>今天也向前一小步</small></div></div><nav class="nav" aria-label="主导航"><button data-view="calendar">日历</button><button data-view="store">积分商城</button><button data-view="settings">设置</button></nav><button id="refreshData" class="refresh-data-btn" type="button" aria-label="刷新数据" title="刷新数据"><span aria-hidden="true">↻</span></button></header><main id="main"></main></div>`}
    function render(){if(!data){renderRecovery();return}$('#root').innerHTML=appShell();$('#refreshData').onclick=refreshPageData;$$('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===state.view);b.onclick=()=>{state.view=b.dataset.view;render()}});if(state.view==='calendar')renderCalendar();if(state.view==='store')renderStore();if(state.view==='settings')renderSettings()}
    function calendarRange(){if(state.mode==='month'){const first=monthStart(state.cursor),start=startWeek(first),d=parseDate(first);d.setMonth(d.getMonth()+1);const last=addDays(dateStr(d),-1);return [start,addDays(startWeek(last),6)]}const start=startWeek(state.cursor);return[start,addDays(start,6)]}
    function renderCalendar(){const main=$('#main'),[from,to]=calendarRange(),items=state.mode==='week'?occurrences(from,to):[],cur=parseDate(state.cursor),title=state.mode==='month'?`${cur.getFullYear()}年${cur.getMonth()+1}月`:`${fmtDate(from)} — ${fmtDate(to)}`;main.innerHTML=`<section class="panel calendar-panel"><div class="toolbar"><div class="calendar-period ${state.mode==='week'?'week-period':''}"><h1 id="calendarTitle">${title}</h1></div><button class="btn icon-btn" id="prevPeriod" aria-label="上一期">‹</button><button class="btn" id="todayBtn">今天</button><button class="btn icon-btn" id="nextPeriod" aria-label="下一期">›</button><div class="toolbar-spacer"></div><div class="seg"><button data-mode="month">月</button><button data-mode="week">周</button></div><button class="btn" id="printBtn">打印</button><button class="btn primary" id="newTaskBtn">新建任务</button></div><div id="calendarBody"></div></section>`;
      $('#prevPeriod').onclick=()=>movePeriod(-1);$('#nextPeriod').onclick=()=>movePeriod(1);$('#todayBtn').onclick=()=>{state.cursor=dateStr(new Date());state.monthScrollIntent='today';render()};$('#newTaskBtn').onclick=()=>openTask({date:state.selectedDate||dateStr(new Date())});$('#printBtn').onclick=openPrint;$$('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===state.mode);b.onclick=()=>{state.mode=b.dataset.mode;if(state.mode==='month'){state.cursor=dateStr(new Date());state.monthScrollIntent='today'}render()}});state.mode==='month'?renderMonth():renderWeek(items,from)}
    function movePeriod(n){const d=parseDate(state.cursor);if(state.mode==='month'){d.setDate(1);d.setMonth(d.getMonth()+n);state.monthScrollIntent='cursor'}else d.setDate(d.getDate()+n*7);state.cursor=dateStr(d);render()}
    function monthWindowRange(){const start=startWeek(`${state.monthWindow.start}-01`),end=addDays(startWeek(monthEnd(state.monthWindow.end)),6);return[start,end]}
    function monthWindowFor(date){const month=date.slice(0,7);return {start:shiftMonth(month,-2),end:shiftMonth(month,3)}}
    function monthTitle(date){const d=parseDate(date);return `${d.getFullYear()}年${d.getMonth()+1}月`}
    function bindMonthDays(root){root.querySelectorAll('[data-day]').forEach(b=>b.onclick=()=>openDay(b.dataset.day))}
    function paintMonthGrid(){const scroll=$('#monthCalendar');if(!scroll||!state.monthWindow)return;const [from,to]=monthWindowRange(),today=dateStr(new Date()),by={};occurrences(from,to).forEach(o=>(by[o.date]??=[]).push(o));let html='<div class="month-grid">';for(const d of rangeDates(from,to)){const list=by[d]||[],day=parseDate(d),dayOfMonth=day.getDate(),cls=[d===today?'today':'',dayOfMonth===1?'month-start':''].join(' '),label=dayOfMonth===1?`${day.getMonth()+1}月1日`:dayOfMonth;html+=`<button class="day-cell ${cls}" data-day="${d}" data-month="${d.slice(0,7)}" aria-label="${fmtFull(d)}，${list.length}项任务"><span class="day-num ${dayOfMonth===1?'month-start':''}">${label}</span>${list.slice(0,3).map(o=>`<div class="task-chip ${isDone(o)?'done':''}" data-month-occ="${esc(o.occurrenceKey)}" style="--cat:${esc(category(o.categoryId).color)}">${esc(o.startTime)} ${esc(o.title)}</div>`).join('')}${list.length>3?`<div class="more">还有 ${list.length-3} 项</div>`:''}</button>`}html+='</div>';scroll.innerHTML=html;bindMonthDays(scroll)}
    function cellScrollTop(scroll,cell){return cell.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop}
    function syncMonthTitle(scroll){const cells=[...scroll.querySelectorAll('.day-cell')];if(!cells.length)return;const line=scroll.getBoundingClientRect().top+Math.min(scroll.clientHeight*.22,130),row=cells.filter(x=>{const r=x.getBoundingClientRect();return r.top<=line&&r.bottom>line}),cell=row.find(x=>parseDate(x.dataset.day).getDate()===1)||row[0]||cells.find(x=>x.getBoundingClientRect().bottom>line)||cells.at(-1),month=cell.dataset.month;if(month&&state.cursor.slice(0,7)!==month){state.cursor=`${month}-01`;const title=$('#calendarTitle');if(title)title.textContent=monthTitle(state.cursor)}}
    function positionMonthScroll(scroll,date,secondRow){const cell=scroll.querySelector(`[data-day="${date}"]`);if(!cell)return;const rowHeight=cell.getBoundingClientRect().height,top=cellScrollTop(scroll,cell);scroll.scrollTop=Math.max(0,top-(secondRow?rowHeight:8));syncMonthTitle(scroll)}
    let monthScrollFrame=0;
    function expandMonthWindow(direction){const scroll=$('#monthCalendar');if(!scroll||!state.monthWindow)return;const oldHeight=scroll.scrollHeight,oldTop=scroll.scrollTop;if(direction<0)state.monthWindow.start=shiftMonth(state.monthWindow.start,-1);else state.monthWindow.end=shiftMonth(state.monthWindow.end,1);paintMonthGrid();if(direction<0)scroll.scrollTop=oldTop+(scroll.scrollHeight-oldHeight);syncMonthTitle(scroll)}
    function onMonthScroll(){if(monthScrollFrame)return;monthScrollFrame=requestAnimationFrame(()=>{monthScrollFrame=0;const scroll=$('#monthCalendar');if(!scroll)return;syncMonthTitle(scroll);if(scroll.scrollTop<360)expandMonthWindow(-1);else if(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<360)expandMonthWindow(1)})}
    function renderMonth(){const today=dateStr(new Date()),intent=state.monthScrollIntent||'today',target=intent==='today'?today:state.cursor;state.monthWindow=monthWindowFor(target);$('#calendarBody').innerHTML=`<div class="month-calendar"><div class="weekday-row" aria-hidden="true">${['周一','周二','周三','周四','周五','周六','周日'].map(x=>`<div>${x}</div>`).join('')}</div><div class="month-scroll" id="monthCalendar" tabindex="0" aria-label="连续月历，滚动查看前后月份"></div></div>`;const scroll=$('#monthCalendar');paintMonthGrid();scroll.addEventListener('scroll',onMonthScroll,{passive:true});requestAnimationFrame(()=>{if(state.view!=='calendar'||state.mode!=='month')return;window.scrollTo(0,0);positionMonthScroll(scroll,target,intent==='today');state.monthScrollIntent='cursor'})}
    function refreshCalendarView(){if(state.view!=='calendar'){render();return}if(state.mode==='month'){const scroll=$('#monthCalendar'),top=scroll?.scrollTop||0;paintMonthGrid();if(scroll){scroll.scrollTop=top;syncMonthTitle(scroll)}}else{const week=$('#weekCalendar'),top=week?.scrollTop||0,left=week?.scrollLeft||0,[from,to]=calendarRange();renderWeek(occurrences(from,to),from);requestAnimationFrame(()=>{const next=$('#weekCalendar');if(next){next.scrollTop=top;next.scrollLeft=left}})}}
    function renderWeek(items,from){
      const dates=rangeDates(from,addDays(from,6)),today=dateStr(new Date()),by={};
      items.forEach(o=>(by[o.date]??=[]).push(o));
      let h=`<div class="week-wrap" id="weekCalendar"><div class="week-board"><div class="week-head"></div>${dates.map(d=>`<div class="week-head ${d===today?'today':''}">${fmtDate(d)}<br><small>周${'日一二三四五六'[parseDate(d).getDay()]}</small></div>`).join('')}<div class="time-axis">`;
      for(let hr=0;hr<=24;hr++)h+=`<span class="time-label" style="top:${hr*60}px">${pad(hr)}:00</span>`;
      h+='</div>';
      for(const d of dates){
        h+=`<div class="week-col" role="button" tabindex="0" aria-label="${fmtFull(d)}时间轴，按回车新建任务" data-week-day="${d}">`;
        for(const layout of layoutWeekEvents(by[d]||[])){
          const o=layout.event,top=Math.max(0,layout.start),height=Math.max(24,layout.end-layout.start),short=height<46,offset=Math.min(layout.depth,3)*9;
          h+=`<button class="week-event ${layout.stacked?'stacked':''} ${short?'short':''} ${isDone(o)?'done':''}" data-occ="${esc(o.occurrenceKey)}" title="${esc(`${o.title} · ${o.startTime}–${o.endTime}`)}" aria-label="${esc(`${o.title}，${o.startTime}至${o.endTime}`)}" style="top:${top}px;height:${height}px;--event-offset:${offset}px;--event-z:${2+layout.depth};--cat:${esc(category(o.categoryId).color)}"><span class="week-event-title">${esc(o.title)}</span>${short?'':`<span class="week-event-time">${esc(o.startTime)}–${esc(o.endTime)}</span>`}</button>`;
        }
        h+='</div>';
      }
      h+='</div></div>';
      $('#calendarBody').innerHTML=h;
      requestAnimationFrame(()=>{const week=$('#weekCalendar');if(week&&state.view==='calendar'&&state.mode==='week')week.scrollTop=weekInitialScroll(items)});
      $$('[data-week-day]').forEach(c=>{
        c.onclick=e=>{if(e.target.closest('.week-event'))return;const y=e.clientY-c.getBoundingClientRect().top,min=weekSlotAt(y),endMin=Math.min(DAY_MINUTES-1,min+30);openTask({date:c.dataset.weekDay,startTime:timeAt(min),endTime:timeAt(endMin)})};
        c.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target===c){e.preventDefault();openTask({date:c.dataset.weekDay,startTime:'17:00',endTime:'17:30'})}};
      });
      $$('[data-occ]').forEach(b=>b.onclick=e=>{e.stopPropagation();const o=items.find(x=>x.occurrenceKey===b.dataset.occ);openTask({occurrence:o})});
    }
    function openDay(date){state.selectedDate=date;const list=occurrences(date,date);document.body.insertAdjacentHTML('beforeend',`<div class="drawer-backdrop" id="drawerBackdrop"></div><aside class="drawer" id="dayDrawer" aria-label="当天任务"><div class="drawer-head"><h2>${fmtFull(date)}</h2><button class="btn icon-btn" id="closeDrawer" aria-label="关闭当天任务">✕</button></div><button class="btn primary" id="drawerNew" style="width:100%;margin:15px 0">添加当天任务</button><div>${list.length?list.map(dayCard).join(''):`<div class="empty">这一天还没有任务</div>`}</div></aside>`);const close=()=>{$('#dayDrawer')?.remove();$('#drawerBackdrop')?.remove()};$('#closeDrawer').onclick=close;$('#drawerBackdrop').onclick=close;$('#drawerNew').onclick=()=>{close();openTask({date})};$('#dayDrawer').querySelectorAll('[data-day-occ]').forEach(card=>{const o=list.find(x=>x.occurrenceKey===card.dataset.dayOcc);if(o)bindDayTaskCard(card,o,close)})}
    function dayCard(o){const c=category(o.categoryId),done=isDone(o);return `<article class="day-task ${done?'done':''}" data-day-occ="${esc(o.occurrenceKey)}" style="--cat:${esc(c.color)}"><div class="day-task-top"><div class="day-task-title">${esc(o.title)}</div><b>+${o.points}</b></div><div class="meta">${esc(o.startTime)}–${esc(o.endTime)} · ${esc(c.name)}${o.recurring?' · 重复':''}</div>${o.note?`<div class="meta">${esc(o.note)}</div>`:''}<div class="day-actions"><button class="btn" data-toggle-occ="${esc(o.occurrenceKey)}">${done?'↩ 撤销完成':'✓ 确认完成'}</button>${done?'':`<button class="btn" data-edit-occ="${esc(o.occurrenceKey)}">编辑</button>`}</div></article>`}
    function bindDayTaskCard(card,o,close){card.querySelector('[data-edit-occ]')?.addEventListener('click',()=>{close();openTask({occurrence:o})});card.querySelector('[data-toggle-occ]')?.addEventListener('click',async()=>{if(await toggleComplete(o))refreshDayTaskCard(o,close)})}
    function refreshDayTaskCard(o,close){const current=$$('[data-day-occ]').find(card=>card.dataset.dayOcc===o.occurrenceKey);if(!current)return;const template=document.createElement('template');template.innerHTML=dayCard(o);const next=template.content.firstElementChild;current.replaceWith(next);bindDayTaskCard(next,o,close)}
    function validateTaskPreset(preset){
      if(typeof preset.title!=='string'||!preset.title.trim()||preset.title.length>80)return '请填写 80 字以内的任务名称';
      if(!validTime(preset.startTime)||!validTime(preset.endTime))return '请选择开始和结束时间';
      if(minutes(preset.endTime)<=minutes(preset.startTime))return '结束时间必须晚于开始时间';
      if(!Number.isInteger(preset.points)||preset.points<0||preset.points>9999)return '积分必须为 0–9999 的整数';
      if(preset.categoryId!==undefined&&(typeof preset.categoryId!=='string'||(preset.categoryId&&!validId(preset.categoryId))))return '任务类型格式不正确';
      return ''
    }
    function matchingTaskPresets(query){const key=String(query||'').trim().normalize('NFKC').toLocaleLowerCase();return (data.taskPresets||[]).filter(preset=>preset.title.normalize('NFKC').toLocaleLowerCase().includes(key))}
    function taskPresetTypeName(preset){const type=data.categories.find(item=>item.id===preset.categoryId);return type?type.name+(type.active?'':'（已停用）'):'未配置类型'}
    function fillTaskPreset(preset){
      $('#taskTitle').value=preset.title;$('#taskStart').value=preset.startTime;$('#taskEnd').value=preset.endTime;$('#taskPoints').value=preset.points;
      $('#taskError').textContent='';$('#taskNotice').classList.add('hidden');delete $('#taskNotice').dataset.confirmed;
      const type=data.categories.find(item=>item.id===preset.categoryId);
      if(type?.active)$('#taskCategory').value=type.id;else if(preset.categoryId)$('#taskCategory').value='';
      $('#taskPresetHint').textContent=type&&!type.active?'原任务类型已停用，请重新选择任务类型':'已填入常用任务，可继续修改';
    }
    let presetEditorId=null,presetSaveBusy=false,presetComposing=false,presetOptionsState=null;
    function renderTaskPresets(){
      const list=$('#settingsTaskPresetsList')||$('#taskPresetsList');
      list.innerHTML=data.taskPresets.length?data.taskPresets.map(preset=>{const type=data.categories.find(item=>item.id===preset.categoryId);return `<article class="task-preset-card"><div class="task-preset-card-main"><strong>${esc(preset.title)}</strong><div class="task-preset-card-meta"><span class="task-preset-category" style="--preset-cat:${esc(type?.active?type.color:'#9ba59e')}"><i aria-hidden="true"></i>${esc(taskPresetTypeName(preset))}</span><span class="task-preset-time"><svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>${esc(preset.startTime)}–${esc(preset.endTime)}</span></div></div><div class="task-preset-side"><span class="task-preset-reward">+${preset.points}<small>分</small></span><div class="task-preset-actions"><button class="btn" type="button" data-preset-edit="${preset.id}" ${currentChild?.archived?'disabled':''}>编辑</button><button class="btn danger" type="button" data-preset-delete="${preset.id}" ${presetSaveBusy||currentChild?.archived?'disabled':''}>删除</button></div></div></article>`}).join(''):'<div class="empty">暂无常用任务，点击右上角“添加”开始配置。</div>';
      if($('#settingsPresetCount'))$('#settingsPresetCount').textContent=`共 ${data.taskPresets.length} 项配置`;
      list.onclick=event=>{if(currentChild?.archived)return;const edit=event.target.closest('[data-preset-edit]'),remove=event.target.closest('[data-preset-delete]');if(edit)openTaskPresetEditor(edit.dataset.presetEdit);if(remove)deleteTaskPreset(remove.dataset.presetDelete)};
    }
    function openTaskPresetEditor(id=null){
      if(presetSaveBusy||currentChild?.archived)return;const preset=id?data.taskPresets.find(item=>item.id===id):null;if(id&&!preset)return;
      presetEditorId=id;$('#taskPresetEditorTitle').textContent=id?'编辑常用任务':'添加常用任务';
      $('#presetTitle').value=preset?.title||'';$('#presetStart').value=preset?.startTime||'19:30';$('#presetEnd').value=preset?.endTime||'20:00';$('#presetPoints').value=preset?.points??30;
      const types=data.categories.filter(item=>item.active),previousType=data.categories.find(item=>item.id===preset?.categoryId);
      $('#presetCategory').innerHTML=`<option value="" disabled>${previousType&&!previousType.active?'原类型已停用，请重新选择':'请选择任务类型'}</option>`+types.map(item=>`<option value="${item.id}">${esc(item.name)}</option>`).join('');$('#presetCategory').value=previousType?.active?previousType.id:'';
      $('#taskPresetEditorError').textContent=types.length?'':'暂无可用类型，请先在设置中添加任务类型';$('#taskPresetEditorDialog').showModal();$('#presetTitle').focus();
    }
    function setPresetBusy(busy){presetSaveBusy=busy;$$('#taskPresetForm button').forEach(button=>button.disabled=busy);$('#addTaskPreset').disabled=busy;$$('[data-preset-delete]').forEach(button=>button.disabled=busy)}
    async function saveTaskPreset(event){
      event.preventDefault();if(presetSaveBusy)return;
      const preset={id:presetEditorId||uid(),title:$('#presetTitle').value.trim(),categoryId:$('#presetCategory').value,startTime:$('#presetStart').value,endTime:$('#presetEnd').value,points:$('#presetPoints').value===''?NaN:Number($('#presetPoints').value)},error=validateTaskPreset(preset);
      if(error){$('#taskPresetEditorError').textContent=error;return}
      if(!data.categories.some(type=>type.id===preset.categoryId&&type.active)){$('#taskPresetEditorError').textContent='请选择可用的任务类型';return}
      const index=data.taskPresets.findIndex(item=>item.id===preset.id);
      if(presetEditorId&&index<0){$('#taskPresetEditorError').textContent='该配置已被删除，请重新添加';return}
      const before=cloneData();setPresetBusy(true);closeTaskPicker();
      if(index<0)data.taskPresets.push(preset);else data.taskPresets[index]=preset;
      try{await Store.save(data)}catch(saveError){data=persistedData?jsonClone(persistedData):before;$('#taskPresetEditorError').textContent=storageErrorMessage(saveError);return}finally{setPresetBusy(false)}
      $('#taskPresetEditorDialog').close();renderTaskPresets();toast('常用任务配置已保存');
    }
    async function deleteTaskPreset(id){
      if(presetSaveBusy)return;const preset=data.taskPresets.find(item=>item.id===id);if(!preset||!confirm(`确认删除“${preset.title}”（${preset.startTime}–${preset.endTime}）的常用配置吗？已创建的任务不会受到影响。`))return;
      const before=cloneData();setPresetBusy(true);$('#taskPresetsError').textContent='';data.taskPresets=data.taskPresets.filter(item=>item.id!==id);
      try{await Store.save(data)}catch(error){data=persistedData?jsonClone(persistedData):before;$('#taskPresetsError').textContent=storageErrorMessage(error);return}finally{setPresetBusy(false)}
      renderTaskPresets();toast('常用任务配置已删除');
    }
    function closeTaskPresetOptions(){
      presetOptionsState=null;$('#taskPresetOptions').classList.add('hidden');$('#taskTitle').setAttribute('aria-expanded','false');$('#taskTitle').removeAttribute('aria-activedescendant');$('#taskPresetToggle').setAttribute('aria-expanded','false');
    }
    function positionTaskPresetOptions(){
      if(!presetOptionsState)return;
      const anchor=$('.task-title-combo'),dialog=$('#taskDialog'),body=$('#taskDialog .modal-body'),popover=$('#taskPresetOptions'),a=anchor.getBoundingClientRect(),d=dialog.getBoundingClientRect(),b=body.getBoundingClientRect();
      if(a.bottom<=b.top||a.top>=b.bottom){closeTaskPresetOptions();return}
      const gap=6,edge=12,below=d.bottom-edge-a.bottom-gap,above=a.top-d.top-edge-gap,up=below<150&&above>below,available=up?above:below;
      if(available<50){closeTaskPresetOptions();return}
      popover.style.width=`${Math.min(a.width,d.width-edge*2)}px`;popover.style.maxHeight=`${Math.min(300,available)}px`;
      popover.style.left=`${Math.max(edge,Math.min(a.left-d.left,d.width-popover.offsetWidth-edge))}px`;popover.style.top=`${up?a.top-d.top-gap-popover.offsetHeight:a.bottom-d.top+gap}px`;
    }
    function renderTaskPresetOptions(){
      if(!presetOptionsState)return;const picker=presetOptionsState,items=matchingTaskPresets(picker.query),popover=$('#taskPresetOptions');picker.ids=items.map(preset=>preset.id);
      popover.innerHTML=items.length?items.map((preset,index)=>`<div id="taskPresetOption-${index}" class="task-preset-option" role="option" aria-selected="false" data-task-preset-id="${preset.id}"><strong>${esc(preset.title)}</strong><small>${esc(taskPresetTypeName(preset))} · ${esc(preset.startTime)}–${esc(preset.endTime)} · 奖励 ${preset.points} 分</small></div>`).join(''):`<div class="task-preset-empty" role="status">${data.taskPresets.length?'没有匹配的常用任务，可继续手动输入':'暂无常用任务，可在设置中配置'}</div>`;
      popover.classList.remove('hidden');$('#taskTitle').setAttribute('aria-expanded','true');$('#taskPresetToggle').setAttribute('aria-expanded','true');$('#taskTitle').removeAttribute('aria-activedescendant');positionTaskPresetOptions();
    }
    function openTaskPresetOptions(showAll=false){if(state.editing)return;closeTaskPicker();presetOptionsState={query:showAll?'':$('#taskTitle').value,active:-1,ids:[]};renderTaskPresetOptions()}
    function highlightTaskPreset(index){
      if(!presetOptionsState)return;presetOptionsState.active=index;
      const options=$$('#taskPresetOptions [role=option]');options.forEach((option,i)=>{option.classList.toggle('active',i===index);option.setAttribute('aria-selected',String(i===index))});
      const active=options[index];if(active){$('#taskTitle').setAttribute('aria-activedescendant',active.id);active.scrollIntoView({block:'nearest'})}
    }
    function chooseTaskPreset(id){const preset=data.taskPresets.find(item=>item.id===id);if(!preset||state.editing)return;fillTaskPreset(preset);closeTaskPresetOptions();$('#taskTitle').focus({preventScroll:true})}
    function taskPresetKeydown(event){
      if(state.editing)return;
      if(presetComposing||event.isComposing||event.keyCode===229){if(event.key==='Enter')event.stopPropagation();return}
      if(event.key==='Tab'){closeTaskPresetOptions();return}
      if(event.key==='Escape'&&presetOptionsState){event.preventDefault();event.stopPropagation();closeTaskPresetOptions();return}
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();if(!presetOptionsState)openTaskPresetOptions();const picker=presetOptionsState;if(!picker?.ids.length)return;
        highlightTaskPreset((picker.active+(event.key==='ArrowDown'?1:picker.active<0?0:-1)+picker.ids.length)%picker.ids.length);return
      }
      if(event.key==='Enter'&&presetOptionsState){event.preventDefault();event.stopPropagation();const id=presetOptionsState.ids[presetOptionsState.active];if(id)chooseTaskPreset(id)}
    }
    function wireTaskPresetControls(){
      const input=$('#taskTitle'),toggle=$('#taskPresetToggle'),options=$('#taskPresetOptions');
      input.addEventListener('click',()=>openTaskPresetOptions());input.addEventListener('input',event=>{$('#taskPresetHint').textContent='';if(!event.isComposing&&!presetComposing)openTaskPresetOptions()});
      input.addEventListener('compositionstart',()=>presetComposing=true);input.addEventListener('compositionend',()=>{presetComposing=false;openTaskPresetOptions()});input.addEventListener('keydown',taskPresetKeydown);
      toggle.onclick=()=>{if(presetOptionsState)closeTaskPresetOptions();else openTaskPresetOptions(true);input.focus({preventScroll:true})};toggle.addEventListener('keydown',taskPresetKeydown);
      options.addEventListener('mousedown',event=>{if(event.target.closest('[data-task-preset-id]'))event.preventDefault()});options.onclick=event=>{const option=event.target.closest('[data-task-preset-id]');if(option)chooseTaskPreset(option.dataset.taskPresetId)};
      document.addEventListener('click',event=>{if(!event.target.closest('.task-title-combo,#taskPresetOptions'))closeTaskPresetOptions()});
      $('#taskDialog .modal-body').addEventListener('scroll',positionTaskPresetOptions,{passive:true});window.addEventListener('resize',positionTaskPresetOptions);
      $('#taskDialog').addEventListener('close',()=>{closeTaskPresetOptions();presetComposing=false});
      $('#taskPresetForm').addEventListener('submit',saveTaskPreset);$('#addTaskPreset').onclick=()=>openTaskPresetEditor();
      $('#taskPresetsList').onclick=event=>{const edit=event.target.closest('[data-preset-edit]'),remove=event.target.closest('[data-preset-delete]');if(edit)openTaskPresetEditor(edit.dataset.presetEdit);if(remove)deleteTaskPreset(remove.dataset.presetDelete)};
      $('#taskPresetEditorDialog .modal-body').addEventListener('scroll',positionTaskPicker,{passive:true});$('#taskPresetEditorDialog').addEventListener('close',closeTaskPicker);
      $('#taskPresetEditorDialog').addEventListener('cancel',event=>{if(presetSaveBusy)event.preventDefault()},{capture:true});
    }
    function taskPickerKind(field){return ['taskStart','taskEnd','presetStart','presetEnd'].includes(field)?'time':'date'}
    function taskPickerPopover(){return $(state.taskPicker?.field?.startsWith('preset')?'#presetTimePopover':'#taskPickerPopover')}
    function taskPickerMinDate(field){return field==='repeatUntil'?$('#taskDate')?.value||null:null}
    function taskPickerDates(month){const start=startWeek(monthStart(month));return Array.from({length:42},(_,i)=>addDays(start,i))}
    function defaultTaskEndTime(start){const next=minutes(start)+60;return next>=DAY_MINUTES?'23:59':timeAt(next)}
    function syncTaskPickerAria(){$$('[data-picker-field]').forEach(control=>{const field=control.dataset.pickerField,input=control.querySelector('input');if(input)input.setAttribute('aria-expanded',String(state.taskPicker?.field===field))})}
    function closeTaskPicker(){state.taskPicker=null;for(const popover of [$('#taskPickerPopover'),$('#presetTimePopover')]){popover.classList.add('hidden');popover.innerHTML=''}syncTaskPickerAria()}
    function pickerMinuteValue(value){return pad(Math.min(55,Math.round(Number(value)/5)*5))}
    function positionTaskTimeColumns(picker=state.taskPicker){if(!picker||picker.kind!=='time')return;const input=$('#'+picker.field),current=validTime(input?.value)?input.value:'00:00',hour=Number(current.slice(0,2)),minute=pickerMinuteValue(current.slice(3)),columns=[...taskPickerPopover().querySelectorAll('.picker-time-column')];if(columns.length<2)return;const values=[[...columns[0].querySelectorAll('[data-picker-hour]')].find(option=>Number(option.dataset.pickerHour)===hour),[...columns[1].querySelectorAll('[data-picker-minute]')].find(option=>option.dataset.pickerMinute===minute)];columns.forEach((column,index)=>{const option=values[index];if(!option)return;const max=Math.max(0,column.scrollHeight-column.clientHeight),center=option.offsetTop-(column.clientHeight-option.offsetHeight)/2;column.scrollTop=Math.max(0,Math.min(max,center))})}
    function positionTaskPicker(){const picker=state.taskPicker,popover=taskPickerPopover(),anchor=picker&&document.querySelector(`[data-picker-field="${picker.field}"]`),dialog=anchor?.closest('dialog');if(!picker||!popover||popover.classList.contains('hidden')||!dialog||!anchor)return;const dialogRect=dialog.getBoundingClientRect(),anchorRect=anchor.getBoundingClientRect(),gap=8,edge=12,width=popover.offsetWidth,height=popover.offsetHeight;let left=Math.max(edge,Math.min(anchorRect.left-dialogRect.left,dialogRect.width-width-edge)),top=anchorRect.bottom-dialogRect.top+gap,placement='down';const above=anchorRect.top-dialogRect.top-height-gap;if(top+height>dialogRect.height-edge&&above>=edge){top=above;placement='up'}else top=Math.max(edge,Math.min(top,dialogRect.height-height-edge));popover.style.left=`${Math.round(left)}px`;popover.style.top=`${Math.round(top)}px`;popover.dataset.placement=placement}
    function renderTaskPicker(){const picker=state.taskPicker,popover=taskPickerPopover();if(!picker||!popover)return;const input=$('#'+picker.field),today=dateStr(new Date());if(picker.kind==='date'){const selected=input.value,minimum=taskPickerMinDate(picker.field),month=picker.month,cells=taskPickerDates(month);popover.innerHTML=`<div class="picker-popover-head"><button class="picker-nav" type="button" data-picker-nav="-1" aria-label="上个月">‹</button><strong>${parseDate(monthStart(month)).getFullYear()}年${parseDate(monthStart(month)).getMonth()+1}月</strong><button class="picker-nav" type="button" data-picker-nav="1" aria-label="下个月">›</button></div><div class="picker-weekdays" aria-hidden="true">${['一','二','三','四','五','六','日'].map(x=>`<span>${x}</span>`).join('')}</div><div class="picker-date-grid">${cells.map(day=>{const current=parseDate(day),disabled=minimum&&cmp(day,minimum)<0,classes=[day.slice(0,7)!==month?'other':'',day===today?'today':'',day===selected?'selected':''].filter(Boolean).join(' ');return `<button class="picker-day ${classes}" type="button" data-picker-date="${day}" ${disabled?'disabled':''} aria-label="${fmtFull(day)}">${current.getDate()}</button>`}).join('')}</div><div class="picker-popover-foot"><button class="picker-today" type="button" data-picker-today="1" ${minimum&&cmp(today,minimum)<0?'disabled':''}>今天</button></div>`}else{const current=validTime(input.value)?input.value:'00:00',hour=Number.isInteger(picker.hour)?picker.hour:Number(current.slice(0,2)),minute=pickerMinuteValue(current.slice(3));popover.innerHTML=`<div class="picker-time"><div><span class="picker-time-label">小时</span><div class="picker-time-column">${Array.from({length:24},(_,h)=>`<button class="picker-time-option ${h===hour?'selected':''}" type="button" data-picker-hour="${h}">${pad(h)}</button>`).join('')}</div></div><div><span class="picker-time-label">分钟</span><div class="picker-time-column">${Array.from({length:12},(_,i)=>pad(i*5)).map(m=>`<button class="picker-time-option ${m===minute?'selected':''}" type="button" data-picker-minute="${m}">${m}</button>`).join('')}</div></div></div>`}popover.classList.remove('hidden');syncTaskPickerAria();requestAnimationFrame(()=>{positionTaskPicker();positionTaskTimeColumns(picker)})}
    function openTaskPicker(field){closeTaskPresetOptions();const input=$('#'+field);if(!input||input.closest('.hidden'))return;const kind=taskPickerKind(field);if(state.taskPicker?.field===field){closeTaskPicker();return}state.taskPicker=kind==='date'?{field,kind,month:(validDate(input.value)?input.value:dateStr(new Date())).slice(0,7)}:{field,kind,hour:validTime(input.value)?Number(input.value.slice(0,2)):0};renderTaskPicker()}
    function setTaskPickerDate(field,value){const min=taskPickerMinDate(field);if(min&&cmp(value,min)<0)return;$('#'+field).value=value;if(field==='taskDate'){const until=$('#repeatUntil');if(validDate(until.value)&&cmp(until.value,value)<0)until.value=value;buildWeekdays()}closeTaskPicker()}
    function setTaskPickerTime(field,value){$('#'+field).value=value;if(field==='taskStart')$('#taskEnd').value=defaultTaskEndTime(value);if(field==='presetStart')$('#presetEnd').value=defaultTaskEndTime(value);closeTaskPicker()}
    function handleTaskPickerAction(target){const picker=state.taskPicker;if(!picker)return false;const action=target.closest('[data-picker-nav],[data-picker-date],[data-picker-today],[data-picker-hour],[data-picker-minute]');if(!action)return false;if(action.dataset.pickerNav){picker.month=shiftMonth(picker.month,Number(action.dataset.pickerNav));renderTaskPicker();return true}if(action.dataset.pickerDate){setTaskPickerDate(picker.field,action.dataset.pickerDate);return true}if(action.dataset.pickerToday){setTaskPickerDate(picker.field,dateStr(new Date()));return true}if(action.dataset.pickerHour!==undefined){picker.hour=Number(action.dataset.pickerHour);[...taskPickerPopover().querySelectorAll('[data-picker-hour]')].forEach(option=>option.classList.toggle('selected',option===action));return true}if(action.dataset.pickerMinute!==undefined){setTaskPickerTime(picker.field,`${pad(picker.hour)}:${action.dataset.pickerMinute}`);return true}return false}
    function rangeFields(target){return target==='print'?['printStart','printEnd']:['filterFrom','filterTo']}
    function rangeValues(target){const[start,end]=rangeFields(target).map(id=>$('#'+id)?.value||'');return{start,end}}
    function rangeId(target,part){return `${target}Range${part}`}
    function syncRangePickerControls(){for(const target of ['print','ledger']){const control=$('#'+rangeId(target,'Control')),startEl=$('#'+rangeId(target,'Start')),endEl=$('#'+rangeId(target,'End')),clear=$('#'+rangeId(target,'Clear'));if(!control||!startEl||!endEl)continue;const{start,end}=rangeValues(target);startEl.textContent=start||'开始日期';endEl.textContent=end||'结束日期';startEl.classList.toggle('placeholder',!start);endEl.classList.toggle('placeholder',!end);clear?.classList.toggle('hidden',!start&&!end);const open=state.rangePicker?.target===target;control.classList.toggle('open',open);control.setAttribute('aria-expanded',String(open))}}
    function closeRangePicker(){state.rangePicker=null;const popover=$('#rangePickerPopover');if(popover){popover.classList.add('hidden');popover.innerHTML='';popover.classList.remove('in-dialog')}syncRangePickerControls()}
    function rangeDateClass(day,picker,values,month){const classes=[day.slice(0,7)!==month?'other':'',day===dateStr(new Date())?'today':''];if(values.start&&values.end&&cmp(day,values.start)>=0&&cmp(day,values.end)<=0)classes.push('in-range');if(day===values.start)classes.push('range-start');if(day===values.end)classes.push('range-end');return classes.filter(Boolean).join(' ')}
    function rangeMonthMarkup(month,picker,values){return `<section class="range-picker-month"><strong class="range-picker-month-title">${parseDate(monthStart(month)).getFullYear()}年 ${parseDate(monthStart(month)).getMonth()+1}月</strong><div class="range-picker-weekdays" aria-hidden="true">${['一','二','三','四','五','六','日'].map(day=>`<span>${day}</span>`).join('')}</div><div class="range-picker-days">${taskPickerDates(month).map(day=>`<button class="range-picker-day ${rangeDateClass(day,picker,values,month)}" type="button" data-range-date="${day}" aria-label="${fmtFull(day)}">${parseDate(day).getDate()}</button>`).join('')}</div></section>`}
    function positionRangePicker(){const picker=state.rangePicker,popover=$('#rangePickerPopover');if(!picker||!popover||popover.classList.contains('hidden'))return;const control=$('#'+rangeId(picker.target,'Control'));if(!control)return;const gap=8,edge=12,width=popover.offsetWidth,height=popover.offsetHeight,anchor=control.getBoundingClientRect();if(picker.target==='print'){const dialog=$('#printDialog');if(!dialog)return;const dialogRect=dialog.getBoundingClientRect();popover.classList.add('in-dialog');let left=Math.max(edge,Math.min(anchor.left-dialogRect.left,dialogRect.width-width-edge)),top=anchor.bottom-dialogRect.top+gap;const above=anchor.top-dialogRect.top-height-gap;if(top+height>dialogRect.height-edge&&above>=edge)top=above;else top=Math.max(edge,Math.min(top,dialogRect.height-height-edge));popover.style.left=`${Math.round(left)}px`;popover.style.top=`${Math.round(top)}px`;return}popover.classList.remove('in-dialog');let left=Math.max(edge,Math.min(anchor.left,window.innerWidth-width-edge)),top=anchor.bottom+gap;if(top+height>window.innerHeight-edge&&anchor.top-height-gap>=edge)top=anchor.top-height-gap;else top=Math.max(edge,Math.min(top,window.innerHeight-height-edge));popover.style.left=`${Math.round(left)}px`;popover.style.top=`${Math.round(top)}px`}
    function renderRangePicker(){const picker=state.rangePicker,popover=$('#rangePickerPopover');if(!picker||!popover)return;const values=rangeValues(picker.target),rightMonth=shiftMonth(picker.month,1);popover.innerHTML=`<div class="range-picker-nav"><div class="range-picker-nav-group"><button type="button" data-range-nav="-1" aria-label="上个月">‹</button></div><div class="range-picker-nav-group"><button type="button" data-range-nav="1" aria-label="下个月">›</button></div></div><div class="range-picker-months">${rangeMonthMarkup(picker.month,picker,values)}${rangeMonthMarkup(rightMonth,picker,values)}</div><p class="range-picker-hint">${picker.phase==='end'?'请选择结束日期':'请选择开始日期'}</p>`;popover.classList.remove('hidden');syncRangePickerControls();requestAnimationFrame(positionRangePicker)}
    function openRangePicker(target){const control=$('#'+rangeId(target,'Control')),popover=$('#rangePickerPopover');if(!control||!popover)return;if(state.rangePicker?.target===target){closeRangePicker();return}const host=target==='print'?$('#printDialog'):document.body;if(popover.parentElement!==host)host.append(popover);const{start,end}=rangeValues(target),reference=validDate(start)?start:validDate(end)?end:dateStr(new Date());state.rangePicker={target,month:reference.slice(0,7),phase:start&&!end?'end':'start'};renderRangePicker()}
    function applyRangeChange(target){syncRangePickerControls();if(target==='print')updatePrintPreview();else renderLedger()}
    function setRangeDate(value){const picker=state.rangePicker;if(!picker)return;const[startId,endId]=rangeFields(picker.target),start=$('#'+startId),end=$('#'+endId);if(picker.phase==='start'||!validDate(start.value)){start.value=value;end.value='';picker.phase='end';applyRangeChange(picker.target);renderRangePicker();return}if(cmp(value,start.value)<0){start.value=value;end.value='';applyRangeChange(picker.target);renderRangePicker();return}end.value=value;applyRangeChange(picker.target);closeRangePicker()}
    function clearRange(target){const[start,end]=rangeFields(target);$('#'+start).value='';$('#'+end).value='';applyRangeChange(target);closeRangePicker()}
    function handleRangePickerAction(target){const clear=target.closest('[data-range-clear]');if(clear){clearRange(clear.dataset.rangeClear);return true}const picker=state.rangePicker;if(!picker)return false;const action=target.closest('[data-range-nav],[data-range-date]');if(!action)return false;if(action.dataset.rangeNav){picker.month=shiftMonth(picker.month,Number(action.dataset.rangeNav));renderRangePicker();return true}if(action.dataset.rangeDate){setRangeDate(action.dataset.rangeDate);return true}return false}
    function fillCategories(selected){$('#taskCategory').innerHTML=data.categories.filter(c=>c.active||c.id===selected).map(c=>`<option value="${esc(c.id)}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join('')}
    function openTask({date,startTime='17:00',endTime='17:30',occurrence=null}){if(occurrence&&isDone(occurrence)){toast('已完成任务已冻结；请先撤销完成再编辑');return}closeTaskPicker();closeTaskPresetOptions();state.editing=occurrence;$('#taskPresetToggle').classList.toggle('hidden',!!occurrence);$('#taskTitle').setAttribute('role',occurrence?'textbox':'combobox');$('#taskTitle').setAttribute('aria-autocomplete',occurrence?'none':'list');$('#taskTitle').placeholder=occurrence?'例如：朗读语文课文':'输入任务内容，或选择常用任务';$('#taskPresetHint').textContent='';const s=occurrence?data.series.find(x=>x.id===occurrence.seriesId):null,rec=occurrence&&s?revisionForDate(s,occurrence.date)?.recurrence:s?.recurrence;if(occurrence&&!s){toast('这是一条已归档的历史任务');return}const initialStart=occurrence?.startTime||startTime,initialEnd=occurrence?.endTime||defaultTaskEndTime(initialStart);$('#taskDialogTitle').textContent=occurrence?'编辑任务':'新建任务';$('#taskTitle').value=occurrence?.title||'';$('#taskNote').value=occurrence?.note||'';$('#taskDate').value=occurrence?.date||date;$('#taskStart').value=initialStart;$('#taskEnd').value=initialEnd;$('#taskPoints').value=occurrence?.points??5;fillCategories(occurrence?.categoryId||data.categories.find(c=>c.active)?.id);$('#taskRepeat').checked=!!rec;$('#repeatFreq').value=rec?.freq||'daily';$('#repeatInterval').value=rec?.interval||1;$('#repeatEndType').value=rec?.endType||'never';$('#repeatUntil').value=rec?.until||addDays($('#taskDate').value,30);$('#repeatCount').value=rec?.count||10;const scope=$('#taskScope');scope.value=occurrence?.recurring?'':'only';$('#scopeField').classList.toggle('hidden',!occurrence?.recurring);$('#deleteTaskBtn').classList.toggle('hidden',!occurrence);$('#taskNotice').classList.add('hidden');$('#taskError').textContent='';buildWeekdays(rec?.weekdays);updateRepeatUI();$('#taskDialog').showModal();setTimeout(()=>$('#taskTitle').focus(),0)}
    function buildWeekdays(selected){const day=(parseDate($('#taskDate').value||dateStr(new Date())).getDay()+6)%7,sel=new Set((selected||[day]).map(Number));$('#weekdayPicks').innerHTML=['一','二','三','四','五','六','日'].map((x,i)=>`<label class="weekday-option"><input type="checkbox" name="repeatWeekday" value="${i}" ${sel.has(i)?'checked':''}><span>周${x}</span></label>`).join('')}
    function updateRepeatUI(){$('#repeatFields').classList.toggle('hidden',!$('#taskRepeat').checked);const freq=$('#repeatFreq').value;$('#weeklyFields').classList.toggle('hidden',freq!=='weekly');$('#intervalUnit').textContent={daily:' 天',weekly:' 周',monthly:' 月'}[freq];const t=$('#repeatEndType').value,showUntil=t==='until';$('#repeatUntilControl').classList.toggle('hidden',!showUntil);$('#repeatCount').classList.toggle('hidden',t!=='count');$('#repeatNever').classList.toggle('hidden',t!=='never');if(state.taskPicker?.field==='repeatUntil'&&(!showUntil||!$('#taskRepeat').checked))closeTaskPicker()}
    function taskFromForm(){const date=$('#taskDate').value,freq=$('#repeatFreq').value,endType=$('#repeatEndType').value;const obj={title:$('#taskTitle').value.trim(),note:$('#taskNote').value.trim(),startDate:date,startTime:$('#taskStart').value,endTime:$('#taskEnd').value,categoryId:$('#taskCategory').value,points:Number($('#taskPoints').value),recurrence:null};if($('#taskRepeat').checked)obj.recurrence={freq,interval:Number($('#repeatInterval').value),weekdays:freq==='weekly'?$$('[name=repeatWeekday]:checked').map(x=>Number(x.value)):undefined,monthDay:freq==='monthly'?parseDate(date).getDate():undefined,endType,until:endType==='until'?$('#repeatUntil').value:undefined,count:endType==='count'?Number($('#repeatCount').value):undefined};return obj}
    function validateTask(t){if(!t.title)return'请填写任务内容';if(!validId(t.categoryId))return'请选择任务类型';if(!t.startDate||!t.startTime||!t.endTime)return'请填写日期和时间';if(minutes(t.endTime)<=minutes(t.startTime))return'结束时间必须晚于开始时间';if(!Number.isInteger(t.points)||t.points<0)return'积分必须是非负整数';if(t.recurrence){if(!Number.isInteger(t.recurrence.interval)||t.recurrence.interval<1)return'重复间隔至少为 1';if(t.recurrence.freq==='weekly'&&!t.recurrence.weekdays.length)return'请至少选择一个星期';if(t.recurrence.endType==='until'&&cmp(t.recurrence.until,t.startDate)<0)return'结束日期不能早于开始日期';if(t.recurrence.endType==='count'&&(!Number.isInteger(t.recurrence.count)||t.recurrence.count<1))return'重复次数至少为 1'}return''}
    function overlapWarning(t,exclude){return occurrences(t.startDate,t.startDate).some(o=>o.occurrenceKey!==exclude&&Math.max(minutes(t.startTime),minutes(o.startTime))<Math.min(minutes(t.endTime),minutes(o.endTime)))}
    async function saveTask(e){e.preventDefault();if(presetComposing||presetOptionsState)return;const t=taskFromForm(),err=validateTask(t),old=state.editing,scope=old?.recurring?$('#taskScope').value:'';if(err){$('#taskError').textContent=err;return}if(old?.recurring&&!scope){$('#taskError').textContent='请选择修改范围';return}if(overlapWarning(t,old?.occurrenceKey)&&!$('#taskNotice').dataset.confirmed){$('#taskNotice').textContent='这个时段已有其他任务。再次点击“保存任务”仍可保存。';$('#taskNotice').classList.remove('hidden');$('#taskNotice').dataset.confirmed='1';return}delete $('#taskNotice').dataset.confirmed;const before=cloneData();if(!old){data.series.push({id:uid(),...t,revisions:[revisionFromTask(t,t.startDate,`${uid()}:v1`)],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}else applyEdit(old,t,scope);recordOperation(old?'task.edit':'task.create',{scope:scope||'all',seriesId:old?.seriesId||data.series.at(-1)?.id,occurrenceKey:old?.occurrenceKey||null,effectiveFrom:t.startDate,beforeTask:old,afterTask:t},before);try{await Store.save(data)}catch(error){data=error?.latestData||before;$('#taskError').textContent=error?.kind==='conflict'?'数据仍在被其他设备更新；已保留本次填写内容，请再次保存。':storageErrorMessage(error);return}$('#taskDialog').close();if(!old)state.selectedDate=t.startDate;if(state.view==='calendar')refreshCalendarView();else render();toast(old?'任务已更新':'任务已创建')}
    function snapshotFrom(t,old){return {...makeOcc({id:old.seriesId,...t},t.startDate,old.originalDate),date:t.startDate,occurrenceKey:old.occurrenceKey,originalDate:old.originalDate,seriesId:old.seriesId,recurring:true}}
    function cleanRecurrence(rule){if(!rule)return null;const clean={freq:rule.freq,interval:Number(rule.interval),endType:rule.endType};if(rule.freq==='weekly')clean.weekdays=(rule.weekdays||[]).map(Number).sort((a,b)=>a-b);if(rule.freq==='monthly')clean.monthDay=Number(rule.monthDay);if(rule.endType==='until')clean.until=rule.until;if(rule.endType==='count')clean.count=Number(rule.count);return clean}
    function revisionFromTask(t,effectiveFrom,id=`${uid()}:v`){return {id,effectiveFrom,title:t.title,note:t.note||'',startTime:t.startTime,endTime:t.endTime,categoryId:t.categoryId,points:Number(t.points)||0,recurrence:cleanRecurrence(t.recurrence)}}
    function syncSeriesFields(s){const revisions=seriesRevisions(s),latest=revisions[revisions.length-1];Object.assign(s,{title:latest.title,note:latest.note,startDate:latest.effectiveFrom,startTime:latest.startTime,endTime:latest.endTime,categoryId:latest.categoryId,points:latest.points,recurrence:latest.recurrence,revisions})}
    function coalesceRevisions(revisions){const sorted=revisions.slice().sort((a,b)=>cmp(a.effectiveFrom,b.effectiveFrom)),out=[];for(const rev of sorted){const prev=out.at(-1),same=prev&&JSON.stringify({...prev,id:'',effectiveFrom:''})===JSON.stringify({...rev,id:'',effectiveFrom:''});if(same)continue;out.push({...rev,recurrence:cleanRecurrence(rev.recurrence)})}return out}
    function remainingCountForRevision(s,source,pivot){if(source?.recurrence?.endType!=='count')return null;const task={...s,...source,startDate:source.effectiveFrom};const used=expandRevision(task,source.effectiveFrom,addDays(pivot,-1)).length;return Math.max(1,Number(source.recurrence.count)-used)}
    function applyEdit(old,t,scope){const s=data.series.find(x=>x.id===old.seriesId);if(!s)return;if(!old.recurring){Object.assign(s,t,{updatedAt:new Date().toISOString()});if(Array.isArray(s.revisions)&&s.revisions.length)s.revisions=[revisionFromTask(s,s.startDate,s.revisions[0].id)];return}const now=new Date().toISOString();if(scope==='all'){const dateChanged=t.startDate!==old.date,whole={...t,startDate:dateChanged?t.startDate:s.startDate};if(whole.recurrence?.freq==='monthly')whole.recurrence={...whole.recurrence,monthDay:dateChanged?parseDate(t.startDate).getDate():(s.recurrence?.monthDay||parseDate(s.startDate).getDate())};s.revisions=[revisionFromTask(whole,whole.startDate,`${s.id}:v${Date.now()}`)];data.exceptions=data.exceptions.filter(ex=>ex.seriesId!==s.id);syncSeriesFields(s);s.updatedAt=now;return}if(scope==='only'){data.exceptions=data.exceptions.filter(x=>!(x.seriesId===old.seriesId&&x.originalDate===old.originalDate));data.exceptions.push({id:uid(),seriesId:old.seriesId,originalDate:old.originalDate,action:'override',data:snapshotFrom(t,old)});return}const pivot=old.originalDate,revisions=seriesRevisions(s),first=revisions[0]?.effectiveFrom||s.startDate,source= revisions.slice().reverse().find(x=>cmp(x.effectiveFrom,pivot)<=0)||revisions[0],effectiveFrom=t.startDate||pivot,revisedTask={...t};if(t.recurrence?.endType==='count'){const remaining=remainingCountForRevision(s,source,pivot);if(remaining!=null)revisedTask.recurrence={...t.recurrence,count:remaining}}const nextRevision=revisionFromTask(revisedTask,effectiveFrom,`${s.id}:v${Date.now()}`);if(cmp(pivot,first)<=0||cmp(effectiveFrom,first)<=0){s.revisions=[nextRevision]}else{s.revisions=coalesceRevisions([...revisions.filter(x=>cmp(x.effectiveFrom,pivot)<0),nextRevision])}syncSeriesFields(s);s.updatedAt=now;}
    function removeRecurringArrangement(old,scope){if(!old?.recurring)return;if(scope==='only'){data.exceptions=data.exceptions.filter(x=>!(x.seriesId===old.seriesId&&x.originalDate===old.originalDate));data.exceptions.push({id:uid(),seriesId:old.seriesId,originalDate:old.originalDate,action:'cancel'});return}if(scope==='series'||scope==='all'){data.series=data.series.filter(x=>x.id!==old.seriesId);data.exceptions=data.exceptions.filter(x=>x.seriesId!==old.seriesId)}}
    async function finishRecurringDelete(scope){const old=state.editing;if(!old)return;const before=cloneData();removeRecurringArrangement(old,scope);recordOperation('task.delete',{scope,seriesId:old.seriesId,occurrenceKey:old.occurrenceKey,beforeTask:old,afterTask:null},before);try{await Store.save(data)}catch(error){data=before;$('#taskError').textContent=storageErrorMessage(error);$('#recurringDeleteDialog').close();return}$('#recurringDeleteDialog').close();$('#taskDialog').close();state.editing=null;refreshCalendarView();toast('未完成安排已删除，历史积分已保留')}
    async function deleteEditing(){const old=state.editing;if(!old)return;if(old.recurring&&!isDone(old)){$('#recurringDeleteDialog').showModal();return}const before=cloneData();if(old.recurring)removeRecurringArrangement(old,'series');else data.series=data.series.filter(x=>x.id!==old.seriesId);recordOperation('task.delete',{scope:old.recurring?'series':'single',seriesId:old.seriesId,occurrenceKey:old.occurrenceKey,beforeTask:old,afterTask:null},before);try{await Store.save(data)}catch(error){data=before;$('#taskError').textContent=storageErrorMessage(error);return}$('#taskDialog').close();state.editing=null;refreshCalendarView();toast('未完成安排已删除，历史积分已保留')}
    function refreshCompletionUI(o){const done=isDone(o);$$('[data-month-occ]').forEach(card=>{if(card.dataset.monthOcc===o.occurrenceKey)card.classList.toggle('done',done)});$$('.week-event[data-occ]').forEach(card=>{if(card.dataset.occ===o.occurrenceKey)card.classList.toggle('done',done)});const currentBalance=$('.balance-pill b');if(currentBalance)currentBalance.textContent=balance()}
    async function toggleComplete(o){const before=cloneData();let c=completion(o.occurrenceKey),now=new Date().toISOString(),completedNow;if(c?.completed){completedNow=false;c.completed=false;c.updatedAt=now;data.ledger.push({id:uid(),kind:'task-reversal',amount:-Number(c.snapshot.points),date:dateStr(new Date()),createdAt:now,occurrenceKey:o.occurrenceKey,source:c.snapshot.title,reason:'撤销任务完成'})}else{completedNow=true;const snap={...o};if(c){c.completed=true;c.snapshot=snap;c.updatedAt=now}else data.completions.push({occurrenceKey:o.occurrenceKey,completed:true,snapshot:snap,updatedAt:now});data.ledger.push({id:uid(),kind:'task-complete',amount:Number(o.points),date:dateStr(new Date()),createdAt:now,occurrenceKey:o.occurrenceKey,source:o.title,reason:'完成任务'})}const saved=await persist(completedNow?'已确认完成，积分已到账':'已撤销完成，积分已冲正',before,{renderPage:false,operation:{action:completedNow?'task.complete':'task.reversal',seriesId:o.seriesId,occurrenceKey:o.occurrenceKey,beforeTask:o,afterTask:o}});if(saved)refreshCompletionUI(o);return saved}
    function openManualDialog(){$('#manualAmount').value='';$('#manualReason').value='';$('#manualDate').value=dateStr(new Date());$('#manualError').textContent='';$('#manualDialog').showModal()}
    function renderStoreLedgerPanel(panel){const earned=data.ledger.filter(x=>x.amount>0).reduce((a,b)=>a+b.amount,0),spent=data.ledger.filter(x=>x.amount<0).reduce((a,b)=>a+Math.abs(b.amount),0);panel.innerHTML=`<div class="store-ledger"><div class="stats"><div class="stat"><span>当前积分</span><b>${balance()}</b></div><div class="stat"><span>累计获得</span><b class="positive">+${earned}</b></div><div class="stat"><span>累计扣减</span><b class="negative">-${spent}</b></div></div><div class="filters"><div id="ledgerRangeControl" class="range-picker-control" data-range-picker="ledger" tabindex="0" role="button" aria-label="筛选日期范围" aria-haspopup="dialog" aria-expanded="false"><span id="ledgerRangeStart" class="range-picker-value placeholder">开始日期</span><span class="range-picker-divider" aria-hidden="true">→</span><span id="ledgerRangeEnd" class="range-picker-value placeholder">结束日期</span><button id="ledgerRangeClear" class="range-picker-clear hidden" type="button" data-range-clear="ledger" aria-label="清除日期范围">×</button></div><input id="filterFrom" type="hidden"><input id="filterTo" type="hidden"><select id="filterSource"><option value="all">全部来源</option><option value="task">任务</option><option value="gift">礼品兑换</option><option value="manual">手动</option></select><select id="filterDirection"><option value="all">全部增减</option><option value="plus">增加</option><option value="minus">扣减</option></select><button class="btn" id="clearFilters">清除筛选</button></div><div id="ledgerTable"></div></div>`;['filterSource','filterDirection'].forEach(id=>$('#'+id).onchange=renderLedger);$('#clearFilters').onclick=()=>{clearRange('ledger');$('#filterSource').value=$('#filterDirection').value='all';renderLedger()};syncRangePickerControls();renderLedger()}
    function ledgerWithBalances(){let sum=0;return [...data.ledger].sort((a,b)=>cmp(a.createdAt,b.createdAt)).map(x=>({...x,balanceAfter:sum+=Number(x.amount)}))}
    function ledgerSourceType(entry){return entry.kind==='manual'?'manual':entry.kind.startsWith('gift-')?'gift':'task'}
    function ledgerSourceLabel(entry){return ledgerSourceType(entry)==='manual'?'手动调整':entry.kind==='gift-reversal'?'撤销兑换':ledgerSourceType(entry)==='gift'?'礼品兑换':'任务'}
    function renderLedger(){const from=$('#filterFrom').value,to=$('#filterTo').value,source=$('#filterSource').value,dir=$('#filterDirection').value;let rows=ledgerWithBalances().filter(x=>(!from||cmp(x.date,from)>=0)&&(!to||cmp(x.date,to)<=0)&&(source==='all'||ledgerSourceType(x)===source)&&(dir==='all'||(dir==='plus'?x.amount>0:x.amount<0))).reverse();$('#ledgerTable').innerHTML=rows.length?`<div class="table-wrap"><table class="ledger"><thead><tr><th>日期</th><th>来源</th><th>说明</th><th>变动</th><th>变动后</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.date)}</td><td>${ledgerSourceLabel(x)}</td><td><b>${esc(x.source||'')}</b><div class="muted">${esc(x.reason||'')}</div></td><td class="amount ${x.amount>0?'pos':'neg'}">${x.amount>0?'+':''}${x.amount}</td><td>${x.balanceAfter}</td></tr>`).join('')}</tbody></table></div>`:`<div class="empty">还没有符合条件的积分流水</div>`}
    async function saveManual(e){e.preventDefault();const amount=Number($('#manualAmount').value),reason=$('#manualReason').value.trim(),date=$('#manualDate').value;if(!Number.isInteger(amount)||amount===0||!reason||!date){$('#manualError').textContent='请输入非零整数积分、日期和原因';return}const before=cloneData();data.ledger.push({id:uid(),kind:'manual',amount,date,createdAt:new Date().toISOString(),source:'手动调整',reason});recordOperation('ledger.manual',{scope:'single',effectiveFrom:date,beforeTask:null,afterTask:null,amount,reason});try{await Store.save(data)}catch(error){data=before;$('#manualError').textContent=storageErrorMessage(error);return}$('#manualDialog').close();render();toast('积分调整已记录')}
    function giftById(id){return data.gifts.find(gift=>gift.id===id)}
    function giftImageHtml(gift,className='gift-image'){const tag=className==='gift-image'?'span':'div';return `<${tag} class="${className}">${gift.imageData?`<img src="${esc(gift.imageData)}" alt="">`:'🎁'}</${tag}>`}
    function formatSavedTime(value){try{return new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch{return value||''}}
    const STORE_TABS=['available','redeemed','ledger'];
    function normalizeStoreTab(tab){return STORE_TABS.includes(tab)?tab:'available'}
    function storeTabItems(tab,available,redeemed){return tab==='redeemed'?redeemed:available}
    function bindStoreTabContent(){$$('[data-redeem-gift]').forEach(button=>button.onclick=()=>openGiftRedeem(button.dataset.redeemGift));$$('[data-undo-gift]').forEach(button=>button.onclick=()=>undoGiftRedemption(button.dataset.undoGift))}
    function renderStoreTabPanel(available,redeemed,current){
      const panel=$('#storeTabPanel');
      if(state.storeTab==='ledger'){renderStoreLedgerPanel(panel);return}
      const gifts=storeTabItems(state.storeTab,available,redeemed);
      if(state.storeTab==='redeemed')panel.innerHTML=gifts.length?`<div class="gift-grid">${gifts.map(g=>`<article class="gift-card redeemed-card">${giftImageHtml(g)}<div class="gift-card-body"><span class="gift-name">${esc(g.name)}</span><span class="gift-price">${g.points} 积分</span><span class="redeemed-meta">${esc(formatSavedTime(g.redeemedAt))}</span><div class="gift-card-actions"><button class="btn" type="button" data-undo-gift="${g.id}">撤销兑换</button></div></div></article>`).join('')}</div>`:'<div class="empty">还没有兑换记录</div>';
      else panel.innerHTML=gifts.length?`<div class="gift-grid">${gifts.map(g=>{const enough=current>=g.points;return `<button class="gift-card" type="button" data-redeem-gift="${g.id}" ${enough?'':'disabled'}>${giftImageHtml(g)}<span class="gift-card-body"><span class="gift-name">${esc(g.name)}</span><span class="gift-price">${g.points} 积分</span><span class="gift-availability ${enough?'':'short'}">${enough?'点击兑换':`还差 ${g.points-current} 积分`}</span></span></button>`}).join('')}</div>`:'<div class="empty">还没有可兑换礼品，可从“管理礼品”中创建。</div>';
      bindStoreTabContent();
    }
    function syncStoreActions(){const ledger=state.storeTab==='ledger';$('#manageGifts').classList.toggle('hidden',ledger);$('#manualBtn').classList.toggle('hidden',!ledger)}
    function selectStoreTab(tab,available,redeemed,current){
      state.storeTab=normalizeStoreTab(tab);
      $$('[data-store-tab]').forEach(button=>{const active=button.dataset.storeTab===state.storeTab;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1});
      $('#storeTabPanel').setAttribute('aria-labelledby',`storeTab-${state.storeTab}`);
      syncStoreActions();
      renderStoreTabPanel(available,redeemed,current);
    }
    function renderStore(){
      const available=data.gifts.filter(g=>g.status==='available').sort((a,b)=>cmp(b.createdAt,a.createdAt)),redeemed=data.gifts.filter(g=>g.status==='redeemed').sort((a,b)=>cmp(b.redeemedAt,a.redeemedAt)),current=balance();
      state.storeTab=normalizeStoreTab(state.storeTab);
      $('#main').innerHTML=`<section class="panel"><div class="toolbar store-toolbar"><div class="store-heading"><h1>积分商城</h1><span class="store-inline-balance">可用积分 <strong>${current}</strong></span></div><div class="toolbar-spacer"></div><button class="btn ${state.storeTab==='ledger'?'hidden':''}" id="manageGifts" type="button">管理礼品</button><button class="btn primary ${state.storeTab==='ledger'?'':'hidden'}" id="manualBtn" type="button">＋ 手动调整</button></div><div class="store-tabs" role="tablist" aria-label="商城内容"><button class="store-tab ${state.storeTab==='available'?'active':''}" id="storeTab-available" type="button" role="tab" aria-selected="${state.storeTab==='available'}" tabindex="${state.storeTab==='available'?0:-1}" data-store-tab="available">可兑换礼品<span class="store-tab-count">${available.length}</span></button><button class="store-tab ${state.storeTab==='redeemed'?'active':''}" id="storeTab-redeemed" type="button" role="tab" aria-selected="${state.storeTab==='redeemed'}" tabindex="${state.storeTab==='redeemed'?0:-1}" data-store-tab="redeemed">已兑换礼品<span class="store-tab-count">${redeemed.length}</span></button><button class="store-tab ${state.storeTab==='ledger'?'active':''}" id="storeTab-ledger" type="button" role="tab" aria-selected="${state.storeTab==='ledger'}" tabindex="${state.storeTab==='ledger'?0:-1}" data-store-tab="ledger">积分流水</button></div><div class="store-tab-panel" id="storeTabPanel" role="tabpanel" aria-labelledby="storeTab-${state.storeTab}"></div></section>`;
      $('#manageGifts').onclick=openGiftManager;
      $('#manualBtn').onclick=openManualDialog;
      $$('[data-store-tab]').forEach(button=>{button.onclick=()=>selectStoreTab(button.dataset.storeTab,available,redeemed,current);button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const currentIndex=STORE_TABS.indexOf(state.storeTab),next=event.key==='Home'?0:event.key==='End'?STORE_TABS.length-1:(currentIndex+(event.key==='ArrowRight'?1:-1)+STORE_TABS.length)%STORE_TABS.length;selectStoreTab(STORE_TABS[next],available,redeemed,current);$(`#storeTab-${state.storeTab}`).focus()}});
      renderStoreTabPanel(available,redeemed,current);
    }
    function renderGiftManagerList(){const root=$('#giftManagerList'),gifts=data.gifts.filter(g=>g.status==='available').sort((a,b)=>cmp(b.createdAt,a.createdAt));root.innerHTML=gifts.length?gifts.map(g=>`<article class="gift-manager-row">${giftImageHtml(g,'gift-manager-thumb')}<div class="gift-manager-copy"><strong>${esc(g.name)}</strong><span class="gift-manager-points">${g.points} 积分</span></div><div class="gift-manager-row-actions"><button class="btn gift-manager-edit" type="button" data-edit-gift="${g.id}">编辑</button><button class="text-btn gift-manager-delete" type="button" data-delete-gift="${g.id}">删除</button></div></article>`).join(''):'<div class="gift-manager-empty"><div><strong>还没有可兑换礼品</strong><span>点击右上角“创建礼品”添加第一件礼物。</span></div></div>';$$('[data-edit-gift]').forEach(button=>button.onclick=()=>openGiftEditor(button.dataset.editGift));$$('[data-delete-gift]').forEach(button=>button.onclick=()=>deleteGift(button.dataset.deleteGift))}
    function openGiftManager(){renderGiftManagerList();$('#giftManagerDialog').showModal()}
    function updateGiftImagePreview(){$('#giftImagePreview').innerHTML=giftDraftImage?`<img src="${esc(giftDraftImage)}" alt="礼品图片预览">`:'🎁';$('#removeGiftImage').classList.toggle('hidden',!giftDraftImage)}
    function openGiftEditor(id=null){const gift=id?giftById(id):null;if(id&&(!gift||gift.status!=='available'))return;giftEditorId=gift?.id||null;giftDraftImage=gift?.imageData||'';$('#giftEditorTitle').textContent=gift?'编辑礼品':'创建礼品';$('#giftName').value=gift?.name||'';$('#giftPoints').value=gift?.points||'';$('#giftImageInput').value='';$('#giftEditorError').textContent='';updateGiftImagePreview();$('#giftEditorDialog').showModal();setTimeout(()=>$('#giftName').focus(),0)}
    function canvasBlob(canvas,type,quality){return new Promise(resolve=>canvas.toBlob(resolve,type,quality))}
    function blobDataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(blob)})}
    async function loadGiftImage(file){if('createImageBitmap'in globalThis)return {image:await createImageBitmap(file),cleanup(image){image.close?.()}};const url=URL.createObjectURL(file),image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('无法识别这张图片'));image.src=url});return {image,cleanup(){URL.revokeObjectURL(url)}}}
    async function compressGiftImage(file){if(!/^image\/(jpeg|png|webp)$/i.test(file.type))throw Error('请选择 JPEG、PNG 或 WebP 图片');if(file.size>10*1024*1024)throw Error('原始图片不能超过 10MB');const loaded=await loadGiftImage(file),source=loaded.image,sourceWidth=source.width||source.naturalWidth,sourceHeight=source.height||source.naturalHeight,target=180*1024,canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');try{let maxSide=640,quality=.82,lastBlob=null;for(let attempt=0;attempt<14;attempt++){const scale=Math.min(1,maxSide/Math.max(sourceWidth,sourceHeight)),width=Math.max(1,Math.round(sourceWidth*scale)),height=Math.max(1,Math.round(sourceHeight*scale));canvas.width=width;canvas.height=height;ctx.clearRect(0,0,width,height);ctx.drawImage(source,0,0,width,height);let blob=await canvasBlob(canvas,'image/webp',quality);if(!blob){ctx.save();ctx.globalCompositeOperation='destination-over';ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.restore();blob=await canvasBlob(canvas,'image/jpeg',quality)}if(!blob)throw Error('当前浏览器无法压缩这张图片');lastBlob=blob;if(blob.size<=target){const result=await blobDataUrl(blob);if(validGiftImage(result))return result}if(quality>.56)quality=Math.max(.55,quality-.08);else if(maxSide>320){maxSide=Math.max(320,Math.round(maxSide*.82));quality=.76}else break}if(lastBlob?.size<=target){const result=await blobDataUrl(lastBlob);if(validGiftImage(result))return result}throw Error('图片内容过于复杂，压缩后仍超过 180KB，请换一张图片')}finally{loaded.cleanup(source)}}
    async function handleGiftImage(){const file=$('#giftImageInput').files?.[0];if(!file)return;const choose=$('#chooseGiftImage'),save=$('#saveGiftBtn');choose.disabled=save.disabled=true;$('#giftEditorError').textContent='正在处理图片…';try{giftDraftImage=await compressGiftImage(file);updateGiftImagePreview();$('#giftEditorError').textContent=''}catch(error){$('#giftEditorError').textContent=error.message||'图片处理失败'}finally{choose.disabled=save.disabled=false;$('#giftImageInput').value=''}}
    async function saveGift(event){event.preventDefault();const name=$('#giftName').value.trim(),points=Number($('#giftPoints').value),error=$('#giftEditorError');if(!name){error.textContent='请填写礼品名称';return}if(!Number.isInteger(points)||points<1||points>99999){error.textContent='所需积分必须是 1–99999 的整数';return}const before=cloneData(),now=new Date().toISOString(),gift=giftEditorId?giftById(giftEditorId):null;if(giftEditorId&&(!gift||gift.status!=='available')){error.textContent='这个礼品当前不可编辑';return}if(gift)Object.assign(gift,{name,points,imageData:giftDraftImage||null,updatedAt:now});else data.gifts.push({id:uid(),name,points,imageData:giftDraftImage||null,status:'available',createdAt:now,updatedAt:now,redeemedAt:null,redemptionLedgerId:null});try{await Store.save(data)}catch(saveError){data=before;error.textContent=storageErrorMessage(saveError);return}$('#giftEditorDialog').close();renderGiftManagerList();if(state.view==='store')render();toast(gift?'礼品已更新':'礼品已创建')}
    async function deleteGift(id){const gift=giftById(id);if(!gift||gift.status!=='available'||!confirm(`确认删除“${gift.name}”吗？`))return;const before=cloneData();data.gifts=data.gifts.filter(g=>g.id!==id);try{await Store.save(data)}catch(error){data=before;toast(storageErrorMessage(error));return}renderGiftManagerList();if(state.view==='store')render();toast('礼品已删除')}
    function applyGiftRedemption(gift,now=new Date().toISOString()){if(!gift||gift.status!=='available')throw Error('这个礼品已不可兑换');if(balance()<gift.points)throw Error('当前积分不足，暂时不能兑换');const entry={id:uid(),kind:'gift-redeem',amount:-gift.points,date:dateStr(new Date()),createdAt:now,giftId:gift.id,giftSnapshot:{name:gift.name,points:gift.points},source:`兑换礼品：${gift.name}`,reason:'积分商城兑换'};data.ledger.push(entry);Object.assign(gift,{status:'redeemed',redeemedAt:now,redemptionLedgerId:entry.id,updatedAt:now});return entry}
    function applyGiftReversal(gift,now=new Date().toISOString()){if(!gift||gift.status!=='redeemed')throw Error('这个礼品没有可撤销的兑换');const original=data.ledger.find(entry=>entry.id===gift.redemptionLedgerId&&entry.kind==='gift-redeem');if(!original)throw Error('找不到原兑换流水，无法撤销');const entry={id:uid(),kind:'gift-reversal',amount:-original.amount,date:dateStr(new Date()),createdAt:now,giftId:gift.id,relatedLedgerId:original.id,giftSnapshot:{...original.giftSnapshot},source:`撤销兑换：${original.giftSnapshot.name}`,reason:'撤销礼品兑换'};data.ledger.push(entry);Object.assign(gift,{status:'available',redeemedAt:null,redemptionLedgerId:null,updatedAt:now});return entry}
    function openGiftRedeem(id){const gift=giftById(id);if(!gift||gift.status!=='available')return;const current=balance();redeemingGiftId=id;$('#giftRedeemName').textContent=`确认兑换“${gift.name}”吗？`;$('#giftRedeemBalance').textContent=current;$('#giftRedeemCost').textContent=`-${gift.points}`;$('#giftRedeemRemaining').textContent=current-gift.points;$('#giftRedeemError').textContent=current>=gift.points?'':'当前积分不足';$('#confirmGiftRedeem').disabled=current<gift.points;$('#giftRedeemDialog').showModal()}
    async function confirmGiftRedemption(){if(giftBusy)return;const gift=giftById(redeemingGiftId),before=cloneData(),error=$('#giftRedeemError');giftBusy=true;$('#confirmGiftRedeem').disabled=true;try{applyGiftRedemption(gift);await Store.save(data)}catch(saveError){data=before;error.textContent=saveError instanceof StoreError?storageErrorMessage(saveError):saveError.message;giftBusy=false;$('#confirmGiftRedeem').disabled=false;return}giftBusy=false;$('#giftRedeemDialog').close();redeemingGiftId=null;render();toast('兑换成功，积分已扣除')}
    async function undoGiftRedemption(id){const gift=giftById(id);if(!gift||gift.status!=='redeemed'||!confirm(`确认撤销“${gift.name}”的兑换吗？积分会返还。`))return;const before=cloneData();try{applyGiftReversal(gift);await Store.save(data)}catch(error){data=before;toast(error instanceof StoreError?storageErrorMessage(error):error.message);return}render();toast('兑换已撤销，积分已返还')}
    function renderSettings(){settingsUI.render()}

    function categoryIsReferenced(id){return data.taskPresets.some(preset=>preset.categoryId===id)||data.series.some(x=>x.categoryId===id)||data.exceptions.some(x=>x.action==='override'&&x.data?.categoryId===id)||data.completions.some(x=>x.snapshot?.categoryId===id)}
    function openCategoryDelete(id){const c=data.categories.find(x=>x.id===id);if(!c)return;state.deletingCategoryId=id;const used=categoryIsReferenced(id);$('#categoryDeleteMessage').textContent=used?`“${c.name}”已被任务或常用配置使用。确认后会从新建任务中移除，历史记录和配置会保留；使用相关常用任务时需重新选择类型。`:`确认删除“${c.name}”吗？删除后无法恢复。`;$('#categoryDeleteDialog').showModal()}
    function categoryNameKey(name){return String(name||'').trim().normalize('NFKC').toLocaleLowerCase()}
    function categoryNameExists(name){const key=categoryNameKey(name);return !!key&&data.categories.some(c=>categoryNameKey(c.name)===key)}
    function openCategoryCreate(){$('#newCategoryName').value='';$('#newCategoryColor').value='#6d9f71';$('#newCategoryError').textContent='';$('#categoryCreateDialog').showModal();setTimeout(()=>$('#newCategoryName').focus(),0)}
    async function saveNewCategory(e){e.preventDefault();const name=$('#newCategoryName').value.trim(),color=$('#newCategoryColor').value;if(!name){$('#newCategoryError').textContent='请填写类型名称';return}if(categoryNameExists(name)){$('#newCategoryError').textContent='类型名称不能重复';return}const before=cloneData();data.categories.push({id:uid(),name,color,active:true});try{await Store.save(data)}catch(error){data=before;$('#newCategoryError').textContent=storageErrorMessage(error);return}$('#categoryCreateDialog').close();render();toast('任务类型已添加')}
    function removeCategoryRecord(id){const c=data.categories.find(x=>x.id===id);if(!c)return null;const used=categoryIsReferenced(id);if(used)c.active=false;else data.categories=data.categories.filter(x=>x.id!==id);return used}
    async function deleteCategory(){const id=state.deletingCategoryId,c=data.categories.find(x=>x.id===id);if(!c)return;const before=cloneData(),used=removeCategoryRecord(id);try{await Store.save(data)}catch(error){data=before;toast(storageErrorMessage(error));return}state.deletingCategoryId=null;$('#categoryDeleteDialog').close();render();toast(used?'类型已停用，历史和常用配置已保留':'任务类型已删除')}
    function reorderCategories(dragId,targetId,after=false){if(!dragId||dragId===targetId)return false;const from=data.categories.findIndex(c=>c.id===dragId);if(from<0)return false;const [moved]=data.categories.splice(from,1),target=data.categories.findIndex(c=>c.id===targetId);if(target<0){data.categories.splice(from,0,moved);return false}data.categories.splice(target+(after?1:0),0,moved);return true}
    let categoryDragId=null;
    function clearCategoryDropIndicators(){$$('.category-row.drag-over').forEach(row=>row.classList.remove('drag-over'))}
    function clearCategoryDragState(){categoryDragId=null;clearCategoryDropIndicators()}
    async function saveCategoryOrder(targetId,after){const before=cloneData();if(!reorderCategories(categoryDragId,targetId,after))return;try{await Store.save(data);renderCategories();toast('任务类型排序已保存')}catch(error){data=before;renderCategories();toast(storageErrorMessage(error))}}
    function renderCategories(){($('#settingsCategoryList')||$('#categoryList')).innerHTML=data.categories.map(c=>`<div class="category-row" data-category-row="${esc(c.id)}"><button class="drag-handle" type="button" draggable="true" data-drag-category="${esc(c.id)}" aria-label="拖动排序 ${esc(c.name)}" title="拖动调整排序">⠿</button><input type="color" value="${esc(c.color)}" data-cat-color="${esc(c.id)}" aria-label="${esc(c.name)}颜色"><input type="text" value="${esc(c.name)}" maxlength="20" data-cat-name="${esc(c.id)}" aria-label="类型名称"><button class="text-btn" data-cat-delete="${esc(c.id)}">删除</button></div>`).join('');$$('[data-cat-color]').forEach(x=>x.onchange=async()=>{const before=cloneData();data.categories.find(c=>c.id===x.dataset.catColor).color=x.value;if(!await persist(null,before))render()});$$('[data-cat-name]').forEach(x=>x.onchange=async()=>{const before=cloneData(),c=data.categories.find(c=>c.id===x.dataset.catName),v=x.value.trim();if(v)c.name=v;else x.value=c.name;if(!await persist(null,before))render()});$$('[data-cat-delete]').forEach(x=>x.onclick=()=>openCategoryDelete(x.dataset.catDelete));$$('[data-drag-category]').forEach(handle=>{handle.ondragstart=e=>{categoryDragId=handle.dataset.dragCategory;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',categoryDragId)};handle.ondragend=clearCategoryDragState});$$('[data-category-row]').forEach(row=>{row.ondragover=e=>{if(!categoryDragId||categoryDragId===row.dataset.categoryRow)return;e.preventDefault();clearCategoryDropIndicators();row.classList.add('drag-over')};row.ondrop=async e=>{e.preventDefault();const id=categoryDragId;if(!id)return;const box=row.getBoundingClientRect(),after=e.clientY>box.top+box.height/2;try{await saveCategoryOrder(row.dataset.categoryRow,after)}finally{clearCategoryDragState()}}})}
    function backup(){return {format:FORMAT,version:BACKUP_VERSION,exportedAt:new Date().toISOString(),data}}
    function download(obj,name){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([typeof obj==='string'?obj:JSON.stringify(obj,null,2)],{type:'application/json'}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
    function downloadBackup(){download(backup(),`乐乐成长备份-${dateStr(new Date())}.json`);toast('备份已导出')}
    function validateBackup(obj){if(!obj||obj.format!==FORMAT||obj.version!==BACKUP_VERSION||!obj.data)throw Error('不是有效的乐乐成长备份');return validateData(migrateData(obj.data))}
    async function importFile(file){try{const pkg=JSON.parse(await file.text()),next=validateBackup(pkg);const detail=`备份时间：${new Date(pkg.exportedAt).toLocaleString()}\n任务系列：${next.series.length}\n积分流水：${next.ledger.length}\n礼品：${next.gifts.length}\n常用任务：${next.taskPresets.length}`;if(!confirm(`${detail}\n\n导入将整体替换当前数据，是否继续？`))return;if(data&&storageMeta.revision>0)downloadBackup();await Store.save(next,{repair:!data});data=next;corruptRaw=null;storageIssue='';render();toast('备份恢复成功')}catch(error){alert('导入失败：'+storageErrorMessage(error))}finally{$('#importInput').value=''}}
    function printWeekRange(day,offset=0){const start=addDays(startWeek(day),offset*7);return[start,addDays(start,6)]}
    function setPrintWeek(offset=0){const[start,end]=printWeekRange(dateStr(new Date()),offset);$('#printStart').value=start;$('#printEnd').value=end;$('#printError').textContent='';syncRangePickerControls();updatePrintPreview()}
    function openPrint(){resetPrintPdf();$('#printDialog').showModal();setPrintWeek(0)}
    function isoWeek(date){const local=parseDate(date),d=new Date(Date.UTC(local.getFullYear(),local.getMonth(),local.getDate())),day=d.getUTCDay()||7;d.setUTCDate(d.getUTCDate()+4-day);const year=d.getUTCFullYear(),yearStart=new Date(Date.UTC(year,0,1));return {year,week:Math.ceil((((d-yearStart)/86400000)+1)/7)}}
    function printTaskUnits(task){return 2+Math.ceil([...task.title].length/10)}
    function printDensity(list){const units=list.reduce((sum,task)=>sum+printTaskUnits(task),0);return units<=18?'normal':units<=30?'compact':units<=42?'dense':'overflow'}
    function printWeeks(from,to){const pages=[];for(let ws=startWeek(from);cmp(ws,to)<=0;ws=addDays(ws,7)){const dates=rangeDates(ws,addDays(ws,6)),items=occurrences(ws,addDays(ws,6)).filter(o=>cmp(o.date,from)>=0&&cmp(o.date,to)<=0),daily=dates.map(d=>items.filter(o=>o.date===d)),levels=daily.map(printDensity),density=levels.includes('overflow')?'overflow':levels.includes('dense')?'dense':levels.includes('compact')?'compact':'normal';pages.push({ws,dates,items,density})}return pages}
    function buildPrint(from,to){return printWeeks(from,to).map(p=>{const week=isoWeek(p.ws);return `<section class="print-page ${p.density}"><h1>${esc(data.settings.childName)} · 成长计划 ${week.year}年 ${week.week}周</h1><div class="print-grid">${p.dates.map(d=>{const list=p.items.filter(o=>o.date===d),weekday='日一二三四五六'[parseDate(d).getDay()];return `<div class="print-day" style="${cmp(d,from)<0||cmp(d,to)>0?'color:#aaa':''}"><h3><span class="print-weekday">周${weekday}</span><small class="print-date">${fmtDate(d)}</small></h3>${list.map(o=>`<div class="paper-task"><span class="paper-check ${isDone(o)?'checked':''}"></span><div><span class="paper-title">${esc(o.title)}</span><span class="paper-details">${esc(o.startTime)}–${esc(o.endTime)} · ${o.points} 分</span></div></div>`).join('')}</div>`}).join('')}</div><div class="print-footer"><div>本周获得积分：________</div><div>家长签字：________</div><div>备注：________________________</div></div></section>`}).join('')}
    function updatePrintPreview(){
      const from=$('#printStart').value,to=$('#printEnd').value,pdfMode=isIPadWebApp();
      if(printPdfKey&&printPdfKey!==from+'|'+to)resetPrintPdf();
      $('#printPdfOutput').classList.toggle('hidden',!pdfMode);
      if(!from||!to||cmp(from,to)>0){$('#printPreview').innerHTML='';$('#printError').textContent='请选择正确的起止日期';if(pdfMode)$('#printConfirmBtn').disabled=true;return false}
      const pages=printWeeks(from,to),overflow=pages.find(p=>p.density==='overflow');
      if(overflow){$('#printPreview').innerHTML='';$('#printError').textContent=`${fmtFull(overflow.ws)} 所在周任务过多，无法完整放入一张 A4 纸，请调整该周安排后再打印。`;if(pdfMode)$('#printConfirmBtn').disabled=true;return false}
      $('#printError').textContent='';const count=occurrences(from,to).length;
      $('#printPreview').innerHTML=`<div class="print-preview-card">将打印 <strong>${pages.length}</strong> 页自然周计划，共 <strong>${count}</strong> 项任务。</div>`;
      if(pdfMode&&$('#printDialog').open&&!printPdfReady&&!printPdfBusy)preparePrintPdf(pages,from,to);
      return true;
    }
    function isIPadWebApp(){
      const ipad=/iPad/.test(navigator.userAgent)||((navigator.platform==='MacIntel'||/Macintosh/.test(navigator.userAgent))&&navigator.maxTouchPoints>1);
      return ipad&&(navigator.standalone===true||matchMedia('(display-mode: standalone)').matches);
    }
    let printPdfJob=0,printPdfKey='',printPdfReady=null,printPdfBusy=false;
    function resetPrintPdf(){
      printPdfJob++;printPdfKey='';printPdfBusy=false;
      if(printPdfReady){const url=printPdfReady.url;setTimeout(()=>URL.revokeObjectURL(url),60000)}
      printPdfReady=null;$('#printPdfOutput').classList.add('hidden');$('#printPdfLink').removeAttribute('href');
      $('#printPdfHint').textContent='PDF 按 A4 横向排版，打开后可通过分享菜单打印。';
      const button=$('#printConfirmBtn');button.disabled=isIPadWebApp();button.removeAttribute('aria-busy');button.textContent=isIPadWebApp()?'打开 PDF 文件':'打印 A4 横向计划';
    }
    function wrapPrintText(ctx,text,width){const lines=[];let line='';for(const char of String(text)){if(char==='\n'){lines.push(line);line='';continue}if(line&&ctx.measureText(line+char).width>width){lines.push(line);line=''}line+=char}lines.push(line);return lines}
    function renderPrintCanvas(page,from,to){
      const canvas=document.createElement('canvas');canvas.width=2526;canvas.height=1785;
      const ctx=canvas.getContext('2d');if(!ctx)throw Error('此设备无法生成打印文件，请在 Safari 中打开项目后打印');
      ctx.scale(3,3);ctx.fillStyle='#fff';ctx.fillRect(0,0,842,595);
      const font='"PingFang SC","Microsoft YaHei",sans-serif',margin=23,top=54,bottom=524,col=796/7,week=isoWeek(page.ws);
      ctx.fillStyle='#111';ctx.textBaseline='top';ctx.textAlign='center';ctx.font=`700 15px ${font}`;ctx.fillText(`${data.settings.childName} · 成长计划 ${week.year}年 ${week.week}周`,421,25);
      let size=page.density==='dense'?7.2:page.density==='compact'?8.5:9.8,rows;
      // Measure all lines first; never silently truncate titles or omit tasks.
      for(;;){
        rows=page.dates.map(d=>page.items.filter(o=>o.date===d).map(o=>{
          ctx.font=`700 ${size}px ${font}`;const title=wrapPrintText(ctx,o.title,col-29);
          ctx.font=`400 ${size*.74}px ${font}`;const meta=wrapPrintText(ctx,`${o.startTime}–${o.endTime} · ${o.points} 分`,col-29);
          return {title,meta,done:isDone(o),height:10+title.length*size*1.25+meta.length*size*.9};
        }));
        if(rows.every(day=>day.reduce((sum,row)=>sum+row.height,0)<=bottom-top-42))break;
        size-=.3;if(size<6)throw Error('这周的任务文字过多，无法完整放入一页，请缩短任务文字后重试');
      }
      ctx.strokeStyle='#333';ctx.lineWidth=.7;ctx.strokeRect(margin,top,796,bottom-top);
      page.dates.forEach((d,i)=>{
        const x=margin+i*col,out=cmp(d,from)<0||cmp(d,to)>0;
        if(i){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke()}
        ctx.fillStyle=out?'#888':'#111';ctx.textAlign='center';ctx.font=`700 11px ${font}`;ctx.fillText('周'+'日一二三四五六'[parseDate(d).getDay()],x+col/2,top+7);
        ctx.fillStyle='#68716c';ctx.font=`400 7px ${font}`;ctx.fillText(fmtDate(d),x+col/2,top+22);
        ctx.beginPath();ctx.moveTo(x+6,top+34);ctx.lineTo(x+col-6,top+34);ctx.stroke();
        let y=top+40;ctx.textAlign='left';
        for(const row of rows[i]){
          ctx.strokeStyle='#333';ctx.strokeRect(x+6,y+2,10,10);
          if(row.done){
            ctx.save();ctx.strokeStyle='#111';ctx.lineWidth=1.6;ctx.lineCap='round';ctx.lineJoin='round';
            ctx.beginPath();ctx.moveTo(x+8,y+7);ctx.lineTo(x+10.5,y+9.5);ctx.lineTo(x+14,y+4.5);ctx.stroke();
            ctx.restore();
          }
          let ty=y+2;ctx.fillStyle='#111';ctx.font=`700 ${size}px ${font}`;
          for(const line of row.title){ctx.fillText(line,x+21,ty);ty+=size*1.25}
          ctx.fillStyle='#68716c';ctx.font=`400 ${size*.74}px ${font}`;
          for(const line of row.meta){ctx.fillText(line,x+21,ty);ty+=size*.9}
          y+=row.height;ctx.strokeStyle='#aaa';ctx.setLineDash([1,2]);ctx.beginPath();ctx.moveTo(x+6,y-3);ctx.lineTo(x+col-6,y-3);ctx.stroke();ctx.setLineDash([]);
        }
        ctx.strokeStyle='#333';
      });
      ctx.fillStyle='#111';ctx.font=`400 8.5px ${font}`;ctx.textAlign='left';
      ['本周获得积分：________','家长签字：________','备注：________________________'].forEach((text,i)=>ctx.fillText(text,margin+i*796/3,550));
      return canvas;
    }
    function packPrintPdf(images){
      const chunks=[];let length=0;const offsets=[0],push=value=>{const bytes=typeof value==='string'?new TextEncoder().encode(value):value;chunks.push(bytes);length+=bytes.length},obj=(id,body)=>{offsets[id]=length;push(`${id} 0 obj\n`);push(body);push('\nendobj\n')};
      push('%PDF-1.4\n');obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,`<< /Type /Pages /Kids [${images.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] /Count ${images.length} >>`);
      images.forEach((bytes,i)=>{const id=3+i*3;
        obj(id,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
        offsets[id+1]=length;push(`${id+1} 0 obj\n<< /Type /XObject /Subtype /Image /Width 2526 /Height 1785 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);push(bytes);push('\nendstream\nendobj\n');
        const content='q 841.89 0 0 595.28 0 0 cm /Im0 Do Q\n';obj(id+2,`<< /Length ${content.length} >>\nstream\n${content}endstream`);
      });
      const xref=length;push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);for(const offset of offsets.slice(1))push(`${String(offset).padStart(10,'0')} 00000 n \n`);
      push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);return new Blob(chunks,{type:'application/pdf'});
    }
    async function buildPrintPdf(pages,from,to,job){
      const images=[];
      for(const page of pages){if(job!==printPdfJob)throw new DOMException('已取消','AbortError');const canvas=renderPrintCanvas(page,from,to);try{
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(Error('无法生成打印图片')),'image/jpeg',.95));
        images.push(new Uint8Array(await blob.arrayBuffer()));
      }finally{canvas.width=canvas.height=1}}
      return packPrintPdf(images);
    }
    async function preparePrintPdf(pages,from,to){
      const button=$('#printConfirmBtn'),job=++printPdfJob;
      printPdfKey=from+'|'+to;printPdfBusy=true;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='打开 PDF 文件';
      $('#printPdfHint').textContent='正在准备 PDF 文件…';
      try{
        const blob=await buildPrintPdf(pages,from,to,job);if(job!==printPdfJob||!$('#printDialog').open)return;
        printPdfReady={url:URL.createObjectURL(blob)};$('#printPdfLink').href=printPdfReady.url;
        $('#printPdfHint').textContent='PDF 已就绪，打开后可通过分享菜单打印。';
      }catch(error){if(job===printPdfJob){$('#printError').textContent='PDF 准备失败：'+(error?.message||error);$('#printPdfHint').textContent='请点击“重试”重新准备文件。';button.textContent='重试'}}
      finally{if(job===printPdfJob){printPdfBusy=false;button.disabled=false;button.removeAttribute('aria-busy')}}
    }
    function doPrint(e){
      e.preventDefault();
      if(isIPadWebApp()){
        // The PDF is prepared when the range changes, so opening stays in this click.
        const key=$('#printStart').value+'|'+$('#printEnd').value;
        if(printPdfReady&&printPdfKey===key)$('#printPdfLink').click();else updatePrintPreview();
        return;
      }
      if(!updatePrintPreview())return;
      const pages=$('#printPages');pages.innerHTML=buildPrint($('#printStart').value,$('#printEnd').value);$('#printDialog').close();void pages.offsetHeight;window.print();
    }
    function renderRecovery(){$('#root').innerHTML=`<section class="recovery"><h1>数据需要恢复</h1><p>${esc(storageIssue||'本机数据无法解析。为避免误删，工具没有自动清空它。')}</p><div class="notice">你可以先下载原始数据，再导入此前导出的有效备份。</div><p><button class="btn" id="rawDownload">下载原始数据</button> <button class="btn primary" id="recoverImport">导入备份</button> <button class="btn danger" id="recoverReset">确认重置</button></p></section>`;$('#rawDownload').onclick=async()=>{try{download(await Store.raw(),`乐乐成长-损坏数据-${dateStr(new Date())}.json`)}catch(error){alert(storageErrorMessage(error))}};$('#recoverImport').onclick=()=>$('#importInput').click();$('#recoverReset').onclick=async()=>{if(confirm('确定放弃当前损坏数据并重置吗？')){const next=defaults();try{await Store.save(next,{repair:true});data=next;corruptRaw=null;storageIssue='';render();toast('数据已重置')}catch(error){alert(storageErrorMessage(error))}}}}
    function renderFileLaunch(){let legacy=null,raw=null;try{raw=localStorage.getItem(KEY);legacy=raw?validateData(migrateData(JSON.parse(raw))):defaults()}catch(error){corruptRaw=raw}$('#root').innerHTML=`<section class="recovery"><h1>请从本机服务打开</h1><p>直接打开 HTML 文件会让每个浏览器保存各自的数据，无法共享。</p><div class="notice">请双击项目目录中的“启动乐乐成长.command”，再在打开的页面中导入备份。</div><p><button class="btn primary" id="legacyExport">导出当前浏览器旧数据</button></p></section>`;$('#legacyExport').onclick=()=>{if(legacy)download({format:FORMAT,version:BACKUP_VERSION,exportedAt:new Date().toISOString(),data:legacy},`乐乐成长旧数据-${dateStr(new Date())}.json`);else download(corruptRaw||'',`乐乐成长-损坏旧数据-${dateStr(new Date())}.json`)}}
    function renderConnectionError(){ $('#root').innerHTML=`<section class="recovery"><h1>无法连接数据服务</h1><p>${esc(storageIssue||'请双击“启动乐乐成长.command”后重试。')}</p><div class="notice">请检查后台服务与网络连接；连接恢复前，页面不会进入可编辑状态。</div><p><button class="btn primary" id="retryConnection">重新连接</button></p></section>`;$('#retryConnection').onclick=()=>location.reload()}
    function renderAccessGate(){ $('#root').innerHTML=`<section class="recovery"><h1>输入访问口令</h1><p>这是乐乐成长计划的局域网访问页面。请在运行此工具的 Mac 上，从“设置 → 局域网共享”查看口令。</p><form id="accessLoginForm"><div class="field"><label for="accessLoginCode">访问口令</label><input id="accessLoginCode" maxlength="11" autocomplete="one-time-code" autocapitalize="characters" placeholder="例如 ABCDE-FGHIJ" required autofocus></div><div id="accessLoginError" class="error" role="alert"></div><p><button class="btn primary" type="submit">进入乐乐成长计划</button></p></form></section>`;$('#accessLoginForm').onsubmit=async event=>{event.preventDefault();const button=$('#accessLoginForm button');const error=$('#accessLoginError');const code=$('#accessLoginCode').value;button.disabled=true;error.textContent='';try{await Store.login(code);data=await Store.load();render()}catch(loginError){error.textContent=storageErrorMessage(loginError);button.disabled=false}}}
    function showLanAccessInfo(info){const urls=Array.isArray(info.lanUrls)&&info.lanUrls.length?info.lanUrls.map(url=>`<div>${esc(url)}</div>`).join(''):'暂未检测到局域网地址，请确认 Mac 已连接 Wi‑Fi。';$('#lanAccessUrls').innerHTML=urls;$('#lanAccessCode').textContent=info.code||'仅可在本机查看';$('#lanAccessHint').textContent=info.canRefresh?'口令会一直有效；刷新后，其他设备需要重新输入新口令。':'访问口令仅可在运行此工具的 Mac 上查看和刷新。';$('#refreshLanAccess').classList.toggle('hidden',!info.canRefresh)}
    async function openLanAccessSettings(){const dialog=$('#lanAccessDialog'),error=$('#lanAccessError');error.textContent='';$('#lanAccessUrls').textContent='正在获取…';$('#lanAccessCode').textContent='正在获取…';dialog.showModal();try{showLanAccessInfo(await Store.accessStatus())}catch(accessError){error.textContent=storageErrorMessage(accessError)}}
    async function refreshLanAccess(){if(!confirm('刷新后，所有局域网设备都需要重新输入新口令。确定刷新吗？'))return;const button=$('#refreshLanAccess'),error=$('#lanAccessError');button.disabled=true;error.textContent='';try{showLanAccessInfo(await Store.refreshAccess());toast('访问口令已刷新')}catch(accessError){error.textContent=storageErrorMessage(accessError)}finally{button.disabled=false}}
    function runSelfTests(){const tests=[];function test(name,fn){try{fn();tests.push([name,true])}catch(e){tests.push([name,false,e.message])}}function eq(a,b){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`)}const d=defaults(),cat=d.categories[0].id;data=d;
      test('本地日期跨年',()=>eq(addDays('2026-12-31',1),'2027-01-01'));
      test('任务开始时间默认延后一小时',()=>eq(['08:00','22:55','23:00','23:30','23:55'].map(defaultTaskEndTime),['09:00','23:55','23:59','23:59','23:59']));
      test('日期选择器覆盖完整六周与闰日',()=>{const days=taskPickerDates('2024-02');eq([days.length,days[0],days.at(-1),days.includes('2024-02-29')],[42,'2024-01-29','2024-03-10',true])});
      test('连续月历窗口覆盖完整自然周',()=>{state.monthWindow={start:'2026-07',end:'2026-09'};eq(monthWindowRange(),['2026-06-29','2026-10-04']);eq(monthWindowFor('2026-08-27'),{start:'2026-06',end:'2026-11'})});
      test('连续月历可向前后扩展月份',()=>eq([shiftMonth('2026-01',-1),shiftMonth('2026-12',1)],['2025-12','2027-01']));
      test('常用任务迁移兼容旧备份并保留错误检测',()=>{const legacy=defaults();delete legacy.taskPresets;const migrated=validateData(migrateData(legacy));eq(migrated.taskPresets,[]);const invalid={...legacy,taskPresets:null};let rejected=false;try{validateData(migrateData(invalid))}catch{rejected=true}eq(rejected,true)});
      test('常用任务名称时间积分边界',()=>{const preset={id:'english',title:'外教英语课',startTime:'19:30',endTime:'20:00',points:30};eq(validateTaskPreset(preset),'');eq(validateTaskPreset({...preset,points:0}),'');for(const changes of [{title:' '},{title:'课'.repeat(81)},{startTime:'24:00'},{endTime:'19:30'},{points:-1},{points:0.5},{points:10000}])if(!validateTaskPreset({...preset,...changes}))throw Error('接受了无效常用任务');const sample=defaults();sample.taskPresets=[preset,{...preset}];let rejected=false;try{validateData(sample)}catch{rejected=true}eq(rejected,true)});
      test('常用任务筛选支持同名不同时段和自由输入',()=>{const before=data;try{data=defaults();data.taskPresets=[{id:'early',title:'外教英语课',startTime:'19:30',endTime:'20:00',points:30},{id:'late',title:'外教英语课',startTime:'20:00',endTime:'20:30',points:40},{id:'reading',title:'阅读',startTime:'18:00',endTime:'18:30',points:10}];eq(matchingTaskPresets(' 英语 ').map(x=>x.id),['early','late']);eq(matchingTaskPresets('').length,3);eq(matchingTaskPresets('其他自由内容'),[])}finally{data=before}});
      test('常用任务填充保留日期类型备注重复规则',()=>{const before=data;try{data=defaults();openTask({date:'2026-10-09'});$('#taskNote').value='保留备注';$('#taskRepeat').checked=true;$('#repeatFreq').value='weekly';updateRepeatUI();const previous=taskFromForm(),preset={id:'english',title:'外教英语课',startTime:'19:30',endTime:'20:00',points:30};fillTaskPreset(preset);const next=taskFromForm();eq([next.title,next.startTime,next.endTime,next.points],['外教英语课','19:30','20:00',30]);eq([next.startDate,next.categoryId,next.note,next.recurrence],[previous.startDate,previous.categoryId,previous.note,previous.recurrence]);$('#taskPoints').value='35';eq(taskFromForm().points,35);eq(preset.points,30)}finally{$('#taskDialog').close();data=before}});
      test('常用任务类型填入及旧配置停用兼容',()=>{const before=data;try{data=defaults();openTask({date:'2026-10-09'});const preset={id:'english',title:'外教英语课',categoryId:data.categories[1].id,startTime:'19:30',endTime:'20:00',points:30};fillTaskPreset(preset);eq(taskFromForm().categoryId,preset.categoryId);const legacy={...preset};delete legacy.categoryId;fillTaskPreset(legacy);eq(taskFromForm().categoryId,preset.categoryId);data.categories[1].active=false;fillTaskPreset(preset);eq(taskFromForm().categoryId,'');eq(validateTask(taskFromForm()),'请选择任务类型')}finally{$('#taskDialog').close();data=before}});
      test('常用配置引用的类型删除后保留并校验无效引用',()=>{const before=data;try{data=defaults();const type=data.categories[1],preset={id:'english',title:'外教英语课',categoryId:type.id,startTime:'19:30',endTime:'20:00',points:30};data.taskPresets=[preset];eq(removeCategoryRecord(type.id),true);eq([data.categories.some(item=>item.id===type.id),type.active],[true,false]);validateData(data);data.taskPresets[0].categoryId='missing-type';let rejected=false;try{validateData(data)}catch{rejected=true}eq(rejected,true)}finally{data=before}});
      test('跨设备常用任务新增和不同字段编辑合并',()=>{const base=defaults(),preset={id:'english',title:'外教英语课',startTime:'19:30',endTime:'20:00',points:30};base.taskPresets=[preset];const local=jsonClone(base),remote=jsonClone(base);local.taskPresets[0].points=35;local.taskPresets.push({...preset,id:'local'});remote.taskPresets[0].title='英语课';remote.taskPresets.push({...preset,id:'remote'});const merged=mergeAppData(base,local,remote);eq([merged.taskPresets[0].title,merged.taskPresets[0].points],['英语课',35]);eq(merged.taskPresets.map(x=>x.id),['english','remote','local'])});
      test('周一是一周起点',()=>eq(startWeek('2026-08-25'),'2026-08-24'));
      test('每日间隔与次数结束',()=>{d.series=[{id:'a',title:'A',startDate:'2026-01-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:2,endType:'count',count:3}}];eq(occurrences('2026-01-01','2026-01-10').map(x=>x.date),['2026-01-01','2026-01-03','2026-01-05'])});
      test('非重复任务以顶层字段展开',()=>{const s={id:'single-source',title:'顶层任务',startDate:'2026-09-22',startTime:'19:30',endTime:'20:00',categoryId:cat,points:30,recurrence:null,revisions:[{id:'legacy-v1',effectiveFrom:'2026-09-22',title:'旧版本',startTime:'19:30',endTime:'20:00',categoryId:cat,points:10,recurrence:null}]};d.series=[s];d.exceptions=[];d.completions=[];eq(occurrences('2026-09-22','2026-09-22').map(x=>[x.title,x.points]),[['顶层任务',30]])});
      test('跨浏览器保存合并不同字段',()=>{const base=defaults(),s={id:'merge-task',title:'原名称',startDate:'2026-09-22',startTime:'19:30',endTime:'20:00',categoryId:base.categories[0].id,points:10,recurrence:null};base.series=[s];const local=jsonClone(base),remote=jsonClone(base);local.series[0].points=30;remote.series[0].title='另一浏览器改名';const merged=mergeAppData(base,local,remote);eq([merged.series[0].title,merged.series[0].points],['另一浏览器改名',30])});
      test('发生任务保留显示日期与稳定发生键',()=>{const s={id:'occurrence-shape',title:'结构',startDate:'2026-09-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'never'}};const o=makeOcc(s,'2026-08-30','2026-09-03');eq([o.date,o.originalDate,o.occurrenceKey],['2026-08-30','2026-09-03','occurrence-shape@2026-09-03'])});
      test('整系列改期会更新日重复的开始日期',()=>{const s={id:'move-daily',title:'改期',startDate:'2026-09-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'until',until:'2026-09-30'}};d.series=[s];d.exceptions=[];d.completions=[];const old=makeOcc(s,'2026-09-01'),next={...s,startDate:'2026-08-30',recurrence:{...s.recurrence}};applyEdit(old,next,'all');eq([s.startDate,occurrences('2026-08-30','2026-09-03').map(x=>x.date)],['2026-08-30',['2026-08-30','2026-08-31','2026-09-01','2026-09-02','2026-09-03']])});
      test('整系列重编排会恢复未完成单次例外',()=>{const s={id:'reset-series',title:'重编排',startDate:'2026-09-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'until',until:'2026-09-30'}},completed=[{occurrenceKey:s.id+'@2026-09-01',completed:true,snapshot:makeOcc(s,'2026-09-01')}],ledger=[{id:'reset-ledger',kind:'task-complete',amount:1,date:'2026-09-01',createdAt:'2026-09-01T08:30:00Z'}],completedBefore=JSON.parse(JSON.stringify(completed)),ledgerBefore=JSON.parse(JSON.stringify(ledger));d.series=[s];d.exceptions=[{id:'reset-cancel',seriesId:s.id,originalDate:'2026-08-31',action:'cancel'},{id:'reset-override',seriesId:s.id,originalDate:'2026-09-03',action:'override',data:snapshotFrom({...s,startDate:'2026-08-30'},makeOcc(s,'2026-09-03'))}];d.completions=completed;d.ledger=ledger;const old=makeOcc(s,'2026-09-01'),next={...s,startDate:'2026-08-30',recurrence:{...s.recurrence}};applyEdit(old,next,'all');eq([d.exceptions,occurrences('2026-08-30','2026-09-04').map(x=>x.date)],[[],['2026-08-30','2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04']]);eq(data.completions,completedBefore);eq(data.ledger,ledgerBefore)});
      test('单次覆盖在移动后日期显示',()=>{const s={id:'move-only',title:'单次移动',startDate:'2026-09-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'count',count:4}},old=makeOcc(s,'2026-09-03'),moved=snapshotFrom({...s,startDate:'2026-08-30'},old);d.series=[s];d.exceptions=[{id:'move-only-exception',seriesId:s.id,originalDate:old.originalDate,action:'override',data:moved}];d.completions=[];eq(occurrences('2026-08-30','2026-09-04').map(x=>[x.date,x.occurrenceKey]),[['2026-08-30','move-only@2026-09-03'],['2026-09-01','move-only@2026-09-01'],['2026-09-02','move-only@2026-09-02'],['2026-09-04','move-only@2026-09-04']])});
      test('每周多个星期',()=>{d.series=[{id:'b',title:'B',startDate:'2026-08-24',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'weekly',interval:1,weekdays:[0,2,4],endType:'count',count:4}}];d.exceptions=[];d.completions=[];eq(occurrences('2026-08-24','2026-09-06').map(x=>x.date),['2026-08-24','2026-08-26','2026-08-28','2026-08-31'])});
      test('月末回退后重新锚定',()=>{d.series=[{id:'c',title:'C',startDate:'2024-01-31',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'monthly',interval:1,monthDay:31,endType:'count',count:3}}];eq(occurrences('2024-01-01','2024-04-01').map(x=>x.date),['2024-01-31','2024-02-29','2024-03-31'])});
      test('单次取消例外',()=>{d.series=[{id:'d',title:'D',startDate:'2026-01-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'count',count:2}}];d.exceptions=[{seriesId:'d',originalDate:'2026-01-01',action:'cancel'}];eq(occurrences('2026-01-01','2026-01-02').map(x=>x.date),['2026-01-02'])});
      test('仅删除重复任务本次安排',()=>{const s={id:'delete-only',title:'仅删一次',startDate:'2026-01-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'count',count:3}},snap=makeOcc(s,'2026-01-01'),completed=[{occurrenceKey:s.id+'@2026-01-01',completed:true,snapshot:snap}],ledger=[{id:'keep-only-ledger',kind:'task-complete',amount:1,date:'2026-01-01',createdAt:'2026-01-01T08:30:00Z'}],completedBefore=JSON.parse(JSON.stringify(completed)),ledgerBefore=JSON.parse(JSON.stringify(ledger));d.series=[s];d.exceptions=[];d.completions=completed;d.ledger=ledger;removeRecurringArrangement(makeOcc(s,'2026-01-02'),'only');eq(occurrences('2026-01-01','2026-01-03').map(x=>x.date),['2026-01-01','2026-01-03']);eq(data.completions,completedBefore);eq(data.ledger,ledgerBefore)});
      test('删除重复系列保留完成与流水',()=>{const s={id:'delete-series',title:'删系列',startDate:'2026-01-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:1,endType:'count',count:3}},snap=makeOcc(s,'2026-01-01'),completions=[{occurrenceKey:s.id+'@2026-01-01',completed:true,snapshot:snap}],ledger=[{id:'keep-ledger',kind:'task-complete',amount:1,date:'2026-01-01',createdAt:'2026-01-01T08:30:00Z'}],completionsBefore=JSON.parse(JSON.stringify(completions)),ledgerBefore=JSON.parse(JSON.stringify(ledger));d.series=[s];d.exceptions=[];d.completions=completions;d.ledger=ledger;removeRecurringArrangement(makeOcc(s,'2026-01-02'),'series');eq(occurrences('2026-01-01','2026-01-03').map(x=>x.date),['2026-01-01']);eq(data.completions,completionsBefore);eq(data.ledger,ledgerBefore)});
      test('按次数系列从中间拆分不增加总次数',()=>{const s={id:'split',title:'拆分',startDate:'2026-01-01',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'daily',interval:2,endType:'count',count:3}};d.series=[s];d.exceptions=[];d.completions=[];const old=makeOcc(s,'2026-01-03'),next={title:'拆分后',note:'',startDate:'2026-01-03',startTime:'09:00',endTime:'09:30',categoryId:cat,points:2,recurrence:{...s.recurrence}};applyEdit(old,next,'future');eq(occurrences('2026-01-01','2026-01-10').map(x=>x.date),['2026-01-01','2026-01-03','2026-01-05'])});
      test('整系列改期会更新月度锚点',()=>{const s={id:'move-monthly',title:'月度改期',startDate:'2024-01-31',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'monthly',interval:1,monthDay:31,endType:'count',count:3}};d.series=[s];d.exceptions=[];d.completions=[];const old=makeOcc(s,'2024-01-31'),next={...s,startDate:'2024-01-30',recurrence:{...s.recurrence,monthDay:30}};applyEdit(old,next,'all');eq([s.startDate,s.recurrence.monthDay,occurrences('2024-01-01','2024-04-01').map(x=>x.date)],['2024-01-30',30,['2024-01-30','2024-02-29','2024-03-30']])});
      test('整系列未改日期时保留原始月度锚点',()=>{const s={id:'whole',title:'整系列',startDate:'2024-01-31',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:{freq:'monthly',interval:1,monthDay:31,endType:'count',count:3}};d.series=[s];const old=makeOcc(s,'2024-02-29'),next={title:'整系列新标题',note:'',startDate:'2024-02-29',startTime:'09:00',endTime:'09:30',categoryId:cat,points:2,recurrence:{freq:'monthly',interval:1,monthDay:29,endType:'count',count:3}};applyEdit(old,next,'all');eq([s.startDate,s.recurrence.monthDay],['2024-01-31',31])});
      test('积分余额与冲正',()=>{d.ledger=[{id:'l1',kind:'task-complete',amount:5,date:'2026-01-01',createdAt:'2026-01-01T08:00:00Z'},{id:'l2',kind:'task-reversal',amount:-5,date:'2026-01-01',createdAt:'2026-01-01T09:00:00Z'},{id:'l3',kind:'task-complete',amount:3,date:'2026-01-02',createdAt:'2026-01-02T08:00:00Z'}];eq(balance(),3)});
      test('旧版数据迁移会补充礼品列表',()=>{const legacy={...defaults(),schemaVersion:1};delete legacy.gifts;const migrated=migrateData(legacy);eq([migrated.schemaVersion,migrated.gifts],[2,[]])});
      test('积分商城横向 Tab 包含礼品与流水',()=>{const available=[{id:'available'}],redeemed=[{id:'redeemed'}];eq([STORE_TABS,normalizeStoreTab('ledger'),normalizeStoreTab('unknown'),storeTabItems('available',available,redeemed),storeTabItems('redeemed',available,redeemed)],[['available','redeemed','ledger'],'ledger','available',available,redeemed])});
      test('礼品兑换扣分且防重复，并可追加流水撤销',()=>{const sample=defaults(),gift={id:'gift-test',name:'积木',points:120,imageData:null,status:'available',createdAt:'2026-09-15T08:00:00Z',updatedAt:'2026-09-15T08:00:00Z',redeemedAt:null,redemptionLedgerId:null};sample.gifts=[gift];sample.ledger=[{id:'gift-credit',kind:'manual',amount:200,date:'2026-09-15',createdAt:'2026-09-15T08:00:00Z',source:'测试',reason:'测试积分'}];data=sample;try{const redeem=applyGiftRedemption(gift,'2026-09-15T09:00:00Z');eq([balance(),gift.status,redeem.amount,redeem.giftSnapshot.name],[80,'redeemed',-120,'积木']);let duplicateRejected=false;try{applyGiftRedemption(gift,'2026-09-15T09:01:00Z')}catch{duplicateRejected=true}eq([duplicateRejected,sample.ledger.length],[true,2]);gift.name='新名称';const reversal=applyGiftReversal(gift,'2026-09-15T10:00:00Z');eq([balance(),gift.status,reversal.amount,reversal.giftSnapshot.name],[200,'available',120,'积木']);validateData(sample)}finally{data=d}});
      test('积分不足时礼品和流水保持不变',()=>{const sample=defaults(),gift={id:'gift-short',name:'大礼物',points:50,imageData:null,status:'available',createdAt:'2026-09-15T08:00:00Z',updatedAt:'2026-09-15T08:00:00Z',redeemedAt:null,redemptionLedgerId:null};sample.gifts=[gift];data=sample;const before=JSON.stringify(sample);try{let rejected=false;try{applyGiftRedemption(gift,'2026-09-15T09:00:00Z')}catch{rejected=true}if(!rejected)throw Error('积分不足仍可兑换');eq(JSON.stringify(sample),before)}finally{data=d}});
      test('有效备份通过校验',()=>eq(validateBackup({format:FORMAT,version:1,data:d}),d));
      test('损坏流水会被备份校验拒绝',()=>{let rejected=false;try{validateBackup({format:FORMAT,version:1,data:{...d,ledger:[null]}})}catch{rejected=true}if(!rejected)throw Error('损坏流水未被拒绝')});
      test('ISO 周序号与跨年周',()=>{eq(isoWeek('2026-08-24'),{year:2026,week:35});eq(isoWeek('2027-01-01'),{year:2026,week:53})});
      test('每个自然周只生成一张打印页',()=>{d.series=Array.from({length:4},(_,i)=>({id:`print-${i}`,title:'练习',startDate:'2026-08-24',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:null}));d.exceptions=[];d.completions=[];const pages=printWeeks('2026-08-24','2026-08-30');eq(pages.length,1);eq(pages[0].density,'normal')});
      test('超量任务不会拆分为续页',()=>{d.series=Array.from({length:6},(_,i)=>({id:`dense-${i}`,title:`${i}一段很长的任务内容`.repeat(6),startDate:'2026-08-24',startTime:'08:00',endTime:'08:30',categoryId:cat,points:1,recurrence:null}));const pages=printWeeks('2026-08-24','2026-08-30');eq(pages.length,1);eq(pages[0].density,'overflow')});
      test('周视图全天时间换算',()=>{eq([weekSlotAt(-1),weekSlotAt(541),weekSlotAt(1439),timeAt(0),timeAt(1410),timeAt(1439)],[0,540,1410,'00:00','23:30','23:59'])});
      test('周视图首屏定位最早任务',()=>eq([weekInitialScroll([]),weekInitialScroll([{startTime:'09:00'},{startTime:'14:00'}]),weekInitialScroll([{startTime:'00:00'}]),weekInitialScroll([{startTime:'23:00'}])],[540,532,0,1372]));
      test('重叠任务自动层叠内缩',()=>{const p=layoutWeekEvents([{occurrenceKey:'a',startTime:'09:00',endTime:'10:00'},{occurrenceKey:'b',startTime:'09:30',endTime:'10:30'}]);eq(p.map(x=>[x.event.occurrenceKey,x.depth,x.stacked]),[['a',0,true],['b',1,true]])});
      test('链式重叠复用浅层',()=>{const p=layoutWeekEvents([{occurrenceKey:'a',startTime:'09:00',endTime:'10:00'},{occurrenceKey:'b',startTime:'09:30',endTime:'10:30'},{occurrenceKey:'c',startTime:'10:00',endTime:'11:00'}]);eq(p.map(x=>[x.event.occurrenceKey,x.depth,x.stacked]),[['a',0,true],['b',1,true],['c',0,true]])});
      test('相邻任务不叠加且多任务递进内缩',()=>{const adjacent=layoutWeekEvents([{occurrenceKey:'a',startTime:'09:00',endTime:'10:00'},{occurrenceKey:'b',startTime:'10:00',endTime:'11:00'}]),nested=layoutWeekEvents([{occurrenceKey:'a',startTime:'09:00',endTime:'12:00'},{occurrenceKey:'b',startTime:'09:00',endTime:'10:00'},{occurrenceKey:'c',startTime:'09:00',endTime:'09:30'}]);eq(adjacent.map(x=>[x.depth,x.stacked]),[[0,false],[0,false]]);eq(nested.map(x=>x.depth),[0,1,2])});
      test('原生选择器安全回退',()=>{let focus=0,picker=0;openNativePicker({focus(){focus++},showPicker(){picker++;throw Error('blocked')}});openNativePicker({focus(){focus++}});eq([focus,picker],[2,1])});
      test('打印快捷周范围',()=>{eq(printWeekRange('2026-12-31'),['2026-12-28','2027-01-03']);eq(printWeekRange('2026-12-31',1),['2027-01-04','2027-01-10'])});
      test('任务类型拖动排序',()=>{const a={id:'cat-a',name:'甲',color:'#123456',active:true},b={id:'cat-b',name:'乙',color:'#234567',active:true},c={id:'cat-c',name:'丙',color:'#345678',active:true};d.categories=[a,b,c];data=d;if(!reorderCategories('cat-a','cat-c',true))throw Error('未调整排序');eq(data.categories.map(x=>x.id),['cat-b','cat-c','cat-a'])});
      test('任务类型删除保留历史引用',()=>{const unused={id:'unused-cat',name:'未使用',color:'#123456',active:true},used={id:'used-cat',name:'已使用',color:'#654321',active:true};d.categories=[unused,used];d.series=[];d.exceptions=[];d.completions=[];data=d;eq(removeCategoryRecord(unused.id),false);eq(data.categories.map(x=>x.id),['used-cat']);data.series=[{categoryId:'used-cat'}];eq(removeCategoryRecord('used-cat'),true);eq(data.categories[0].active,false)});
      $('#root').innerHTML=`<main class="selftests"><h1>乐乐成长计划 · 自检</h1><p>测试模式不会读取或写入正式本地数据。</p><h2>${tests.filter(x=>x[1]).length}/${tests.length} 通过</h2>${tests.map(x=>`<p class="${x[1]?'test-pass':'test-fail'}">${x[1]?'✓':'✗'} ${esc(x[0])}${x[2]?` — ${esc(x[2])}`:''}</p>`).join('')}</main>`;document.title=`${tests.every(x=>x[1])?'PASS':'FAIL'} · 乐乐成长自检`}
    function openNativePicker(input){input.focus({preventScroll:true});if(typeof input.showPicker!=='function')return;try{input.showPicker()}catch{}}
    function activeCalendarScroll(){if(state.view!=='calendar')return null;return state.mode==='week'?$('#weekCalendar'):$('#monthCalendar')}
    function wheelPixels(e,calendar){const unit=e.deltaMode===1?16:e.deltaMode===2?calendar.clientHeight:1;return {top:e.deltaY*unit,left:e.deltaX*unit}}
    function flushCalendarScroll(){const top=calendarScroll.top,left=calendarScroll.left;calendarScroll.frame=0;calendarScroll.top=0;calendarScroll.left=0;const calendar=activeCalendarScroll();if(!calendar)return;calendar.scrollTop=Math.max(0,Math.min(calendar.scrollHeight-calendar.clientHeight,calendar.scrollTop+top));if(state.mode==='week')calendar.scrollLeft=Math.max(0,Math.min(calendar.scrollWidth-calendar.clientWidth,calendar.scrollLeft+left))}
    function redirectCalendarScroll(e){const calendar=activeCalendarScroll(),target=e.target;if(!calendar||target?.closest?.('dialog[open],.drawer,input,textarea,select,[contenteditable="true"]'))return;const delta=wheelPixels(e,calendar);if(!delta.top&&!delta.left)return;e.preventDefault();calendarScroll.top+=delta.top;calendarScroll.left+=delta.left;if(!calendarScroll.frame)calendarScroll.frame=requestAnimationFrame(flushCalendarScroll)}
    function wire(){document.addEventListener('click',e=>{if(handleRangePickerAction(e.target)){e.preventDefault();return}const rangeControl=e.target.closest('[data-range-picker]');if(rangeControl){e.preventDefault();openRangePicker(rangeControl.dataset.rangePicker);return}if(state.rangePicker&&!e.target.closest('#rangePickerPopover'))closeRangePicker();if(handleTaskPickerAction(e.target)){e.preventDefault();return}const control=e.target.closest('[data-picker-field]');if(control){e.preventDefault();openTaskPicker(control.dataset.pickerField);return}if(state.taskPicker&&!e.target.closest('#taskPickerPopover,#presetTimePopover'))closeTaskPicker();const input=e.target.closest('input[type="date"],input[type="time"]');if(input)openNativePicker(input);const id=e.target.closest('[data-close]')?.dataset.close;if(id){closeRangePicker();closeTaskPicker();$('#'+id).close()}});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.rangePicker){e.preventDefault();e.stopPropagation();closeRangePicker();return}if(e.key==='Escape'&&state.taskPicker){e.preventDefault();e.stopPropagation();closeTaskPicker();return}if((e.key==='Enter'||e.key===' ')&&e.target.closest?.('[data-range-picker]')){e.preventDefault();openRangePicker(e.target.closest('[data-range-picker]').dataset.rangePicker)}});document.addEventListener('wheel',redirectCalendarScroll,{passive:false});$('#taskDialog .modal-body').addEventListener('scroll',positionTaskPicker,{passive:true});$('#printDialog .modal-body').addEventListener('scroll',positionRangePicker,{passive:true});window.addEventListener('resize',()=>{positionTaskPicker();positionRangePicker()});$('#taskDialog').addEventListener('close',closeTaskPicker);$('#printDialog').addEventListener('close',()=>{resetPrintPdf();if(state.rangePicker?.target==='print')closeRangePicker()});$('#taskForm').addEventListener('submit',saveTask);$('#deleteTaskBtn').onclick=deleteEditing;$('#deleteOnlyOccurrence').onclick=()=>finishRecurringDelete('only');$('#deleteSeriesUnfinished').onclick=()=>finishRecurringDelete('series');$('#confirmDeleteCategory').onclick=deleteCategory;$('#categoryCreateForm').addEventListener('submit',saveNewCategory);$('#taskRepeat').onchange=updateRepeatUI;$('#repeatFreq').onchange=updateRepeatUI;$('#repeatEndType').onchange=updateRepeatUI;$('#taskDate').onchange=()=>{if(!state.editing)buildWeekdays()};$('#manualForm').addEventListener('submit',saveManual);$('#printForm').addEventListener('submit',doPrint);$('#printConfirmBtn').onclick=doPrint;$('#printThisWeek').onclick=()=>setPrintWeek(0);$('#printNextWeek').onclick=()=>setPrintWeek(1);$('#refreshLanAccess').onclick=refreshLanAccess;$('#importInput').onchange=e=>e.target.files[0]&&importFile(e.target.files[0]);$$('dialog').forEach(d=>d.addEventListener('cancel',e=>{if(!e.defaultPrevented)d.close()}))}
    function wireGiftControls(){$('#giftEditorForm').addEventListener('submit',saveGift);$('#addGiftBtn').onclick=()=>openGiftEditor();$('#chooseGiftImage').onclick=()=>$('#giftImageInput').click();$('#removeGiftImage').onclick=()=>{giftDraftImage='';updateGiftImagePreview()};$('#giftImageInput').onchange=handleGiftImage;$('#confirmGiftRedeem').onclick=confirmGiftRedemption;$('#giftEditorDialog').addEventListener('close',()=>{$('#giftImageInput').value='';$('#giftEditorError').textContent=''})}
    async function boot(){wire();wireGiftControls();wireTaskPresetControls();if(SELFTEST){data=defaults();runSelfTests();return}if(location.protocol==='file:'){renderFileLaunch();return}$('#root').innerHTML='<section class="recovery"><h1>正在连接数据服务…</h1></section>';try{data=await Store.load();render()}catch(error){data=null;storageIssue=storageErrorMessage(error);if(error.kind==='unauthorized')renderAccessGate();else if(error.kind==='corrupt')renderRecovery();else renderConnectionError()}}
    // Account and child context. Every in-flight request is tied to this generation.
    let authUser=null,csrfToken='',childList=[],currentChild=null,uiGeneration=0,pendingOperation=null,childrenDialogSession=null,settingsUI=null;
    const parentApi=async(path,method='GET',body,requestCsrf=csrfToken)=>{
      const generation=uiGeneration,headers={};
      if(body!==undefined)headers['Content-Type']='application/json';
      if(method!=='GET')headers['X-CSRF-Token']=requestCsrf;
      let response;
      try{response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'})}
      catch{throw new StoreError('连接中断，请刷新核对保存结果。','connection')}
      let result={};try{result=await response.json()}catch{}
      if(generation!==uiGeneration)throw new StoreError('页面已切换，已忽略原页面的响应。','stale');
      if(!response.ok){
        const error=new StoreError(result.error||'操作失败，请重试。',response.status===401?'unauthorized':response.status===409?'conflict':response.status===403?'forbidden':'connection');
        error.status=response.status;
        if(response.status===401&&authUser){clearContext(true);renderLogin('登录已失效，请重新登录。')}
        throw error;
      }
      return result;
    };
    function clearContext(signout=false){
      settingsUI?.reset();
      uiGeneration++;currentChild=null;pendingOperation=null;data=null;persistedData=null;saveBusy=false;refreshBusy=false;
      storageMeta.revision=0;storageMeta.updatedAt=null;
      closeChildrenDialog();
      document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      $('#dayDrawer')?.remove();$('#drawerBackdrop')?.remove();
      resetPrintPdf();const pages=$('#printPages');if(pages)pages.innerHTML='';
      for(const id of ['taskTitle','taskNote','giftName','manualReason','presetTitle'])if($('#'+id))$('#'+id).value='';
      for(const id of ['categoryList','giftManagerList','taskPresetsList','giftImagePreview','printPreview','dayDrawerContent'])if($('#'+id))$('#'+id).innerHTML='';
      $$('dialog img').forEach(image=>image.remove());
      $$('dialog button').forEach(button=>button.disabled=false);
      giftDraftImage='';giftEditorId=null;redeemingGiftId=null;giftBusy=false;presetEditorId=null;presetSaveBusy=false;
      state.editing=null;state.selectedDate=null;state.monthWindow=null;state.taskPicker=null;state.rangePicker=null;
      closeTaskPicker();closeRangePicker();closeTaskPresetOptions();
      if(signout){authUser=null;csrfToken='';childList=[]}
      $('#root').innerHTML='<section class="auth-screen"><h1>正在读取…</h1></section>';
    }
    function accountShell(title,content){return `<div class="account-panel"><div class="toolbar"><h1>${esc(title)}</h1><span class="toolbar-spacer"></span><button class="btn" id="accountHome">我的孩子</button><button class="btn" id="accountProfile">账号管理</button><button class="btn" id="accountLogout">退出登录</button></div>${content}</div>`}
    function bindAccountNav(){
      if($('#accountHome'))$('#accountHome').onclick=()=>showChildren();
      if($('#accountProfile'))$('#accountProfile').onclick=()=>showProfile();
      if($('#accountLogout'))$('#accountLogout').onclick=confirmLogout;
    }
    function renderLogin(message=''){
      const eye='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      const eyeOff='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18M10.6 5.1A12 12 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3 3.9M6.2 6.2A19 19 0 0 0 2 12s3.6 7 10 7a12 12 0 0 0 5.8-1.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
      $('#root').innerHTML=`<section class="auth-screen parent-login" aria-labelledby="loginTitle">
        <div class="login-card"><div class="login-card-body">
          <div class="login-heading"><h1 id="loginTitle">欢迎回来</h1><p>陪伴成长，记录每一份努力</p></div>
          <form class="account-form login-form" id="loginForm" aria-describedby="loginHelp">
            <div class="field login-field"><label for="loginName">登录名</label><div class="login-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg><input id="loginName" name="loginName" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32" placeholder="请输入登录名"></div></div>
            <div class="field login-field"><label for="loginPassword">密码</label><div class="login-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2"/></svg><input id="loginPassword" name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"><button id="toggleLoginPassword" class="login-password-toggle" type="button" aria-label="显示密码" aria-pressed="false" aria-controls="loginPassword">${eye}</button></div></div>
            <div class="account-error login-feedback" id="loginError" role="status" aria-live="polite">${esc(message)}</div>
            <button class="btn primary login-submit" id="loginSubmit" type="submit"><svg class="login-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 12a8 8 0 1 1-8-8"/></svg><span id="loginSubmitLabel">登录</span><svg class="login-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button>
          </form>
        </div><div class="login-help"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v5c0 5 8 10 8 10s8-5 8-10V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg><p id="loginHelp">账号由管理员开通。<br>忘记密码？请联系管理员协助重置。</p></div></div>
      </section>`;
      $('#toggleLoginPassword').onclick=()=>{const input=$('#loginPassword'),toggle=$('#toggleLoginPassword'),visible=input.type==='password';input.type=visible?'text':'password';toggle.setAttribute('aria-label',visible?'隐藏密码':'显示密码');toggle.setAttribute('aria-pressed',String(visible));toggle.innerHTML=visible?eyeOff:eye};
      $('#loginForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=e.submitter||$('#loginSubmit');if(button.disabled)return;button.disabled=true;button.classList.add('is-loading');button.setAttribute('aria-busy','true');$('#loginError').textContent='';$('#loginSubmitLabel').textContent='正在登录…';try{const session=await parentApi('/api/auth/login','POST',{loginName:$('#loginName').value,password:$('#loginPassword').value});authUser=session.user;csrfToken=session.csrfToken;$('#loginPassword').value='';await enterAccount()}catch(error){if(form.isConnected&&$('#loginError')){$('#loginError').classList.add('is-error');$('#loginError').setAttribute('role','alert');$('#loginError').textContent=error.message}}finally{if(button.isConnected){button.disabled=false;button.classList.remove('is-loading');button.removeAttribute('aria-busy');$('#loginSubmitLabel').textContent='登录'}}};
    }
    function confirmLogout(){if(confirm('确认退出当前账号？'))logout()}
    async function logout(){const token=csrfToken;clearContext(true);history.replaceState(null,'','/');try{await parentApi('/api/auth/logout','POST',{},token);authBroadcast?.postMessage('logout');renderLogin()}catch(error){authBroadcast?.postMessage('logout');if(error.kind!=='stale')renderLogin(error.kind==='unauthorized'?'':'退出请求未完成，请重新登录后重试。')}}
    async function enterAccount(){
      if(!authUser){renderLogin();return}
      if(authUser.mustChangePassword){showProfile(true);return}
      clearContext();
      const requested=location.pathname.match(/^\/children\/([^/]+)/)?.[1];
      try{
      const result=await parentApi('/api/children');childList=result.children;
      if(requested){const child=childList.find(c=>c.id===requested);if(child){await selectChild(child.id,false);return}}
      const active=childList.filter(c=>!c.archived);
      if(active.length===1){await selectChild(active[0].id);return}await showChildren();
      }catch(error){if(error.kind!=='stale'&&error.kind!=='unauthorized'){$('#root').innerHTML=accountShell('暂时无法读取',`<p>${esc(error.message)}</p>`);bindAccountNav()}}
    }
    async function showChildren(){
      clearContext();history.replaceState(null,'','/');
      try{
        const [listed,invites]=await Promise.all([parentApi('/api/children'),parentApi('/api/invitations')]);childList=listed.children;
        $('#root').innerHTML=accountShell('我的孩子',`<p class="account-note">每个孩子拥有独立的任务、积分和礼品。共同管理权限按孩子分别邀请。</p><form class="account-form" id="createChildForm"><label>添加孩子<input id="newChildName" placeholder="孩子姓名或昵称" maxlength="40" required></label><button class="btn primary">创建孩子</button><div id="childrenError" class="account-error"></div></form><div class="child-cards">${childList.map(c=>`<article class="child-card"><h2>${esc(c.name)}</h2><p>${c.role==='owner'?'我是负责人':'共同管理'}${c.archived?' · 已归档':''}</p><button class="btn" data-open-child="${esc(c.id)}">${c.archived?'查看归档':'进入'}</button></article>`).join('')||'<p>还没有孩子，可以创建孩子或接受下面的邀请。</p>'}</div><h2>待处理邀请</h2><div>${(invites.invitations||[]).map(inv=>`<div class="child-member"><span>${esc(inv.childName||inv.child_name||'孩子')} · ${esc(inv.inviterNickname||inv.inviterName||'家长邀请')}</span><button class="btn primary" data-accept-invite="${esc(inv.id)}">接受</button><button class="btn" data-reject-invite="${esc(inv.id)}">拒绝</button></div>`).join('')||'<p class="account-note">暂无待处理邀请</p>'}</div>`);
        bindAccountNav();
        $('#createChildForm').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await parentApi('/api/children','POST',{name:$('#newChildName').value});await enterAccount()}catch(error){if($('#childrenError'))$('#childrenError').textContent=error.message}finally{if(e.submitter.isConnected)e.submitter.disabled=false}};
        $$('[data-open-child]').forEach(b=>b.onclick=()=>selectChild(b.dataset.openChild));
        for(const action of ['accept','reject'])$$(`[data-${action}-invite]`).forEach(b=>b.onclick=async()=>{try{await parentApi(`/api/invitations/${b.dataset[action+'Invite']}/${action}`,'POST',{});await showChildren()}catch(error){toast(error.message)}});
      }catch(error){if(error.kind!=='unauthorized'&&error.kind!=='stale')$('#root').innerHTML=accountShell('连接未完成',`<p>${esc(error.message)}</p>`);bindAccountNav()}
    }
    function childInitial(name){return Array.from(String(name||'').trim())[0]||'孩'}
    function childrenDialogActive(session){return !!session&&childrenDialogSession===session&&$('#childrenDialog').open&&session.generation===uiGeneration&&session.childId===currentChild?.id&&!!authUser}
    function childContextBusy(){
      if(saveBusy||refreshBusy){toast('正在保存或刷新，请稍候。');return true}
      if(pendingOperation){toast('上一项保存结果尚未确认，请先刷新核对。');return true}
      return false;
    }
    function closeChildrenDialog(restoreFocus=false){
      const session=childrenDialogSession,dialog=$('#childrenDialog');childrenDialogSession=null;
      document.documentElement.classList.remove('children-dialog-open');
      $('#childrenDialogBody').replaceChildren();$('#closeChildrenDialog').disabled=false;dialog.removeAttribute('aria-busy');
      const trigger=$('#openChildrenDialog');trigger?.setAttribute('aria-expanded','false');
      if(dialog.open)dialog.close();
      if(restoreFocus&&session&&session.generation===uiGeneration&&session.childId===currentChild?.id&&trigger?.dataset.childId===session.childId)trigger.focus();
    }
    function syncChildrenDialogBusy(session){
      if(!childrenDialogActive(session))return;
      const busy=session.loading;
      $('#childrenDialog').setAttribute('aria-busy',String(busy));
      $$('#childrenDialogBody button').forEach(control=>{control.disabled=busy||(session.needsRefresh&&control.matches('[data-open-child]'))});
    }
    function renderChildrenDialog(session){
      if(!childrenDialogActive(session))return;
      const body=$('#childrenDialogBody');
      if(session.loading&&!session.ready){body.innerHTML='<div class="children-dialog-state" role="status">正在读取孩子列表…</div>';syncChildrenDialogBusy(session);return}
      const error=session.error?`<div class="children-dialog-feedback"><p class="account-error" id="childrenDialogError" role="alert">${esc(session.error)}</p><button class="btn" type="button" id="retryChildrenDialog">刷新列表</button></div>`:'<p id="childrenDialogError" class="account-error" role="alert"></p>';
      body.innerHTML=`${error}${session.ready?`
        <div class="children-dialog-cards" role="group" aria-label="选择孩子">${session.children.map(child=>{const active=child.id===session.childId;return `<button type="button" class="children-dialog-card${active?' is-current':''}" data-open-child="${esc(child.id)}"${active?' aria-current="true"':''} aria-label="${esc(child.name)}，${active?'当前孩子':child.archived?'查看归档':'进入孩子页面'}"><span class="children-card-status">${child.archived?'<span class="children-archived-status">已归档 · 只读</span>':''}</span><span class="children-card-avatar" aria-hidden="true">${esc(childInitial(child.name))}</span><span class="children-dialog-card-copy"><strong>${esc(child.name)}</strong></span><span class="children-card-enter">${active?'正在查看':child.archived?'查看成长记录':'进入成长计划'}<span aria-hidden="true">${active?'✓':'↗'}</span></span></button>`}).join('')||'<p class="children-dialog-empty">暂无可切换的孩子。</p>'}</div>${session.children.length>1?'<p class="children-switch-hint">点击卡牌切换 · 滑动或滚轮查看更多</p>':''}`:''}`;
      $('#retryChildrenDialog')?.addEventListener('click',()=>{if(!session.loading)loadChildrenDialog(session)});
      $$('#childrenDialogBody [data-open-child]').forEach(button=>button.onclick=()=>{
        if(!childrenDialogActive(session)||session.loading||session.needsRefresh||childContextBusy())return;
        if(button.dataset.openChild===currentChild.id){closeChildrenDialog(true);return}
        closeChildrenDialog();selectChild(button.dataset.openChild);
      });
      const cards=$('#childrenDialogBody .children-dialog-cards');
      if(cards){
        cards.onkeydown=event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          const buttons=$$('#childrenDialogBody [data-open-child]:not(:disabled)'),index=buttons.indexOf(event.target);if(index<0)return;
          event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowRight'?1:-1)));
          buttons[next].focus({preventScroll:true});buttons[next].scrollIntoView({block:'nearest',inline:'center'});
        };
        cards.addEventListener('wheel',event=>{
          if(Math.abs(event.deltaY)<=Math.abs(event.deltaX))return;
          event.preventDefault();cards.scrollLeft+=event.deltaY;
        },{passive:false});
        const current=cards.querySelector('.is-current');if(current)cards.scrollLeft=current.offsetLeft-(cards.clientWidth-current.offsetWidth)/2;
      }
      syncChildrenDialogBusy(session);
    }
    async function loadChildrenDialog(session){
      if(!childrenDialogActive(session))return;
      const request=++session.readSequence;session.loading=true;session.error='';renderChildrenDialog(session);
      try{
        const listed=await parentApi('/api/children');
        if(!childrenDialogActive(session)||request!==session.readSequence)return;
        childList=listed.children;session.children=listed.children;session.ready=true;session.needsRefresh=false;
      }catch(error){
        if(childrenDialogActive(session)&&request===session.readSequence&&error.kind!=='stale'&&error.kind!=='unauthorized'){session.error=error.message;session.needsRefresh=true}
      }finally{
        if(childrenDialogActive(session)&&request===session.readSequence){session.loading=false;renderChildrenDialog(session)}
      }
    }
    function openChildrenDialog(){
      if(!currentChild||!data||!authUser||childrenDialogSession||childContextBusy())return;
      const session={generation:uiGeneration,childId:currentChild.id,readSequence:0,ready:false,loading:false,needsRefresh:false,error:'',children:[]};
      childrenDialogSession=session;document.documentElement.classList.add('children-dialog-open');$('#childrenDialog').showModal();$('#openChildrenDialog')?.setAttribute('aria-expanded','true');loadChildrenDialog(session);
    }
    function wireChildrenDialog(){
      const dialog=$('#childrenDialog');
      $('#closeChildrenDialog').onclick=()=>closeChildrenDialog(true);
      dialog.addEventListener('cancel',event=>{event.preventDefault();closeChildrenDialog(true)},true);
      dialog.addEventListener('click',event=>{if(!event.target.closest('button'))closeChildrenDialog(true)});
      dialog.addEventListener('close',()=>{if(!dialog.open)closeChildrenDialog()});
      const blockWhenNotCards=event=>{
        if(event.target.closest?.('.children-dialog-cards'))return;
        event.preventDefault();
      };
      dialog.addEventListener('wheel',blockWhenNotCards,{passive:false});
      dialog.addEventListener('touchmove',blockWhenNotCards,{passive:false});
    }
    async function selectChild(id,replace=true){
      const selected=childList.find(c=>c.id===id);if(!selected)return;
      clearContext();currentChild=selected;state.view='calendar';
      if(replace)history.pushState(null,'',`/children/${id}`);
      $('#root').innerHTML='<section class="auth-screen"><h1>正在读取孩子数据…</h1></section>';
      try{data=await Store.load();render()}catch(error){if(error.kind!=='unauthorized'&&error.kind!=='stale'){await showChildren();toast(error.message)}}
    }
    function loadPackage(pkg){
      if(!currentChild||pkg.context?.childId!==currentChild.id)throw new StoreError('孩子数据上下文不一致。','stale');
      if(pkg.format!=='lele-task-manager-store'||pkg.version!==1||!Number.isInteger(pkg.revision)||pkg.revision<0)throw new StoreError('数据包版本不正确。','corrupt');
      if(pkg.revision<storageMeta.revision)return data;
      const next=validateData(migrateData(pkg.data));
      storageMeta.revision=pkg.revision;storageMeta.updatedAt=pkg.updatedAt;
      currentChild.membershipVersion=pkg.context.membershipVersion;
      data=next;persistedData=jsonClone(next);return next;
    }
    Store.load=async()=>{if(SELFTEST)return defaults();const id=currentChild?.id;if(!id)throw new StoreError('请先选择孩子。','stale');return loadPackage(await parentApi(`/api/children/${id}/data`))};
    Store.save=async()=>{throw new StoreError('整包保存已关闭，请使用业务操作。','unsupported')};
    Store.raw=async()=>JSON.stringify(await parentApi(`/api/children/${currentChild.id}/data/export`));
    async function command(kind,payload){
      if(saveBusy)throw new StoreError('上一项操作正在保存，请稍候。','busy');
      if(!currentChild||currentChild.archived)throw new StoreError('该孩子已归档，只能查看。','forbidden');
      const signature=JSON.stringify({child:currentChild.id,kind,payload});
      if(pendingOperation&&pendingOperation.signature!==signature)throw new StoreError('上一项保存结果尚未确认，请先刷新核对。','connection');
      const request=pendingOperation?.body||{expectedRevision:storageMeta.revision,membershipVersion:currentChild.membershipVersion,operationId:uid(),kind,payload};
      pendingOperation={signature,body:request};saveBusy=true;const generation=uiGeneration,id=currentChild.id;
      try{const pkg=await parentApi(`/api/children/${id}/operations`,'POST',request);const result=loadPackage(pkg);pendingOperation=null;return result}
      catch(error){if(error.status&&error.status<500)pendingOperation=null;if(error.kind==='forbidden'){await showChildren()}throw error}
      finally{if(generation===uiGeneration)saveBusy=false}
    }
    const oldRender=render;
    render=function(){settingsUI?.invalidate();oldRender();if(!data||!currentChild)return;const trigger=document.createElement('button');trigger.id='openChildrenDialog';trigger.type='button';trigger.className='child-profile';trigger.dataset.childId=currentChild.id;trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded',String(!!childrenDialogSession));trigger.setAttribute('aria-controls','childrenDialog');trigger.setAttribute('aria-label',`${currentChild.name}，打开我的孩子${currentChild.archived?'，已归档，只读':''}`);trigger.innerHTML=`<span class="child-avatar" aria-hidden="true">${esc(childInitial(currentChild.name))}</span><span class="child-profile-copy"><strong>${esc(currentChild.name)}</strong>${currentChild.archived?'<span class="child-profile-meta"><span class="children-archived-status">已归档 · 只读</span></span>':''}</span><span class="child-profile-chevron" aria-hidden="true">⌄</span>`;$('.topbar').append(trigger);trigger.onclick=openChildrenDialog;};
    storageErrorMessage=function(error){return error?.message||'连接暂时中断，请刷新核对。'};
    refreshPageData=async function(){if(saveBusy||refreshBusy)return;refreshBusy=true;try{data=await Store.load();pendingOperation=null;render();toast('已读取最新数据')}catch(error){if(error.kind==='forbidden'){await showChildren()}if(error.kind!=='stale')toast(error.message)}finally{refreshBusy=false}};
    function showProfile(forced=false){
      if(!forced){settingsUI.open('account/profile');return}
      clearContext();
      $('#root').innerHTML=accountShell('请设置自己的密码','<div id="requiredPasswordContent"></div>');
      bindAccountNav();$('#accountHome').disabled=true;$('#accountProfile').disabled=true;
      settingsUI.requiredPassword($('#requiredPasswordContent'));
    }
    settingsUI=window.LeleParentSettings.create({
      context:()=>({child:currentChild,user:authUser,data,updatedAt:storageMeta.updatedAt}),
      api:parentApi,toast,
      show:()=>{
        if(childContextBusy())return;
        state.view='settings';
        if(currentChild&&data)render();
        else{uiGeneration++;$('#root').innerHTML=appShell();$('.nav').innerHTML='<button type="button" id="accountHome">我的孩子</button>';$('#refreshData').remove();bindAccountNav();renderSettings()}
      },
      home:()=>showChildren(),selectChild,
      sync:async reloadData=>{
        const id=currentChild?.id;
        const result=await parentApi('/api/children');childList=result.children;
        if(id){currentChild=childList.find(child=>child.id===id)||null;if(!currentChild){data=null;return false}if(reloadData)data=await Store.load()}
        return true;
      },
      repaint:()=>render(),updateUser:user=>authUser=user,
      renderPresets:()=>renderTaskPresets(),editPreset:()=>openTaskPresetEditor(),
      renderCategories:()=>renderCategories(),addCategory:()=>openCategoryCreate(),
      exportBackup:()=>downloadBackup(),importBackup:()=>$('#importInput').click(),
      logout:confirmLogout,
      changePassword:async values=>{
        await parentApi('/api/account/password','POST',values);
        authBroadcast?.postMessage('logout');clearContext(true);history.replaceState(null,'','/');renderLogin('密码已修改，请重新登录。');
      }
    });
    // All server writes are explicit commands. Existing client helpers remain only for rendering/selftests.
    saveTask=async function(e){e.preventDefault();if(presetComposing||presetOptionsState)return;const task=taskFromForm(),error=validateTask(task),old=state.editing,scope=old?.recurring?$('#taskScope').value:'only';if(error){$('#taskError').textContent=error;return}if(old?.recurring&&!scope){$('#taskError').textContent='请选择修改范围';return}if(overlapWarning(task,old?.occurrenceKey)&&!$('#taskNotice').dataset.confirmed){$('#taskNotice').textContent='这个时段已有其他任务。再次点击保存仍可保存。';$('#taskNotice').classList.remove('hidden');$('#taskNotice').dataset.confirmed='1';return}try{await command(old?'task.edit':'task.create',old?{occurrenceKey:old.occurrenceKey,task,scope}:{task});$('#taskDialog').close();state.editing=null;render();toast('任务已保存')}catch(error){$('#taskError').textContent=error.message}};
    finishRecurringDelete=async function(scope){const old=state.editing;if(!old)return;try{await command('task.delete',{occurrenceKey:old.occurrenceKey,scope:scope==='only'?'only':'series'});$('#recurringDeleteDialog').close();$('#taskDialog').close();state.editing=null;render();toast('未完成安排已删除，历史记录已保留')}catch(error){$('#taskError').textContent=error.message;$('#recurringDeleteDialog').close()}};
    deleteEditing=async function(){const old=state.editing;if(!old)return;if(old.recurring&&!isDone(old)){$('#recurringDeleteDialog').showModal();return}await finishRecurringDelete('series')};
    toggleComplete=async function(o){try{await command('completion.set',{occurrenceKey:o.occurrenceKey,completed:!isDone(o)});refreshCompletionUI(o);toast('完成状态已保存');return true}catch(error){toast(error.message);return false}};
    saveManual=async function(e){e.preventDefault();try{await command('ledger.manual',{amount:Number($('#manualAmount').value),reason:$('#manualReason').value.trim(),date:$('#manualDate').value});$('#manualDialog').close();render();toast('积分调整已记录')}catch(error){$('#manualError').textContent=error.message}};
    saveGift=async function(e){e.preventDefault();try{await command('gift.save',{gift:{...(giftEditorId?{id:giftEditorId}:{}),name:$('#giftName').value.trim(),points:Number($('#giftPoints').value),imageData:giftDraftImage||null}});$('#giftEditorDialog').close();renderGiftManagerList();if(state.view==='store')render();toast('礼品已保存')}catch(error){$('#giftEditorError').textContent=error.message}};
    handleGiftImage=async function(){const file=$('#giftImageInput').files?.[0];if(!file)return;const generation=uiGeneration;$('#chooseGiftImage').disabled=$('#saveGiftBtn').disabled=true;$('#giftEditorError').textContent='正在处理图片…';try{const image=await compressGiftImage(file);if(generation!==uiGeneration)return;giftDraftImage=image;updateGiftImagePreview();$('#giftEditorError').textContent=''}catch(error){if(generation===uiGeneration)$('#giftEditorError').textContent=error.message}finally{if(generation===uiGeneration){$('#chooseGiftImage').disabled=$('#saveGiftBtn').disabled=false;$('#giftImageInput').value=''}}};
    deleteGift=async function(id){const gift=giftById(id);if(!gift||!confirm(`确认删除“${gift.name}”？`))return;try{await command('gift.delete',{id});renderGiftManagerList();if(state.view==='store')render()}catch(error){toast(error.message)}};
    confirmGiftRedemption=async function(){if(giftBusy)return;giftBusy=true;$('#confirmGiftRedeem').disabled=true;try{await command('gift.redeem',{id:redeemingGiftId});$('#giftRedeemDialog').close();render();toast('兑换成功')}catch(error){$('#giftRedeemError').textContent=error.message}finally{giftBusy=false;$('#confirmGiftRedeem').disabled=false}};
    undoGiftRedemption=async function(id){if(!confirm('确认撤销兑换并返还积分？'))return;try{await command('gift.reverse',{id});render();toast('已撤销兑换')}catch(error){toast(error.message)}};
    saveTaskPreset=async function(e){e.preventDefault();if(presetSaveBusy)return;const preset={...(presetEditorId?{id:presetEditorId}:{}),title:$('#presetTitle').value.trim(),categoryId:$('#presetCategory').value,startTime:$('#presetStart').value,endTime:$('#presetEnd').value,points:Number($('#presetPoints').value)};const error=validateTaskPreset(preset);if(error){$('#taskPresetEditorError').textContent=error;return}setPresetBusy(true);try{await command('preset.save',{preset});$('#taskPresetEditorDialog').close();renderTaskPresets();toast('常用任务已保存')}catch(error){$('#taskPresetEditorError').textContent=error.message}finally{setPresetBusy(false)}};
    deleteTaskPreset=async function(id){if(!confirm('确认删除此常用配置？已创建的任务不受影响。'))return;try{await command('preset.delete',{id});renderTaskPresets()}catch(error){($('#settingsTaskPresetsError')||$('#taskPresetsError')).textContent=error.message}};
    saveNewCategory=async function(e){e.preventDefault();try{await command('category.save',{category:{name:$('#newCategoryName').value.trim(),color:$('#newCategoryColor').value}});$('#categoryCreateDialog').close();renderCategories();toast('类型已添加')}catch(error){$('#newCategoryError').textContent=error.message}};
    deleteCategory=async function(){try{await command('category.delete',{id:state.deletingCategoryId});$('#categoryDeleteDialog').close();renderCategories();toast('类型已更新，历史记录已保留')}catch(error){toast(error.message)}};
    saveCategoryOrder=async function(targetId,after){const order=data.categories.map(c=>c.id),from=order.indexOf(categoryDragId);if(from<0)return;const [id]=order.splice(from,1),target=order.indexOf(targetId);if(target<0)return;order.splice(target+(after?1:0),0,id);try{await command('category.reorder',{ids:order});renderCategories()}catch(error){toast(error.message)}};
    const oldCategories=renderCategories;
    renderCategories=function(){oldCategories();if(currentChild?.archived){$$('#settingsCategoryList input,#settingsCategoryList button').forEach(control=>{control.disabled=true;control.draggable=false});return}$$('[data-cat-color],[data-cat-name]').forEach(input=>input.onchange=async()=>{const id=input.dataset.catColor||input.dataset.catName,c=data.categories.find(c=>c.id===id);const payload={id,name:input.dataset.catName?input.value.trim():c.name,color:input.dataset.catColor?input.value:c.color};try{await command('category.save',{category:payload});renderCategories()}catch(error){toast(error.message);renderCategories()}})};
    downloadBackup=function(){download({...backup(),sourceChild:{id:currentChild.id,name:currentChild.name}},`${currentChild.name}-成长备份-${dateStr(new Date())}.json`);toast('当前孩子备份已导出')};
    importFile=async function(file){const target=currentChild,generation=uiGeneration;try{if(!target||target.role!=='owner'||target.archived)throw new Error('只有未归档孩子的负责人可以恢复数据。');const pkg=JSON.parse(await file.text());if(generation!==uiGeneration)return;const next=pkg.format==='lele-task-manager-store'?validateData(migrateData(pkg.data)):validateBackup(pkg);if(!confirm(`将此备份恢复到“${target.name}”。\n任务系列：${next.series.length}\n积分流水：${next.ledger.length}\n当前业务数据将被替换，孩子姓名和家长权限保持不变。确认恢复？`))return;if(saveBusy)throw new Error('请等待当前操作保存完成。');saveBusy=true;const result=await parentApi(`/api/children/${target.id}/data/restore`,'POST',{expectedRevision:storageMeta.revision,membershipVersion:target.membershipVersion,operationId:uid(),data:next});loadPackage(result);render();toast('当前孩子数据已恢复')}catch(error){if(error.kind!=='stale')alert('导入失败：'+error.message)}finally{if(generation===uiGeneration)saveBusy=false;$('#importInput').value=''}};
    renderAccessGate=renderLogin;
    boot=async function(){wire();wireGiftControls();wireTaskPresetControls();wireChildrenDialog();if(SELFTEST){data=defaults();runSelfTests();return}$('#root').innerHTML='<section class="auth-screen"><h1>正在连接…</h1></section>';try{const session=await parentApi('/api/auth/me');authUser=session.user;csrfToken=session.csrfToken;await enterAccount()}catch(error){if(error.kind==='unauthorized')renderLogin();else renderLogin(error.message)}};
    window.addEventListener('popstate',()=>{if(authUser)enterAccount()});
    const authBroadcast=typeof BroadcastChannel==='function'?new BroadcastChannel('lele-parent-auth'):null;
    if(authBroadcast)authBroadcast.onmessage=event=>{if(event.data==='logout'){clearContext(true);history.replaceState(null,'','/');renderLogin('账号已在其他页面退出或修改密码，请重新登录。')}};
    let checkingContext=false,notifiedRevision=null;
    async function checkChildContext(){
      if(document.hidden||!authUser||!currentChild||!$('#main')||saveBusy||refreshBusy||checkingContext)return;
      checkingContext=true;const generation=uiGeneration;
      try{
        const status=await parentApi(`/api/children/${currentChild.id}/context`);
        if(generation!==uiGeneration||!$('#main')||saveBusy||refreshBusy)return;
        if(status.child.membershipVersion!==currentChild.membershipVersion){await showChildren();toast('管理权限已变化，请重新打开孩子。');return}
        const changed=status.revision!==storageMeta.revision||status.child.archived!==currentChild.archived||status.child.role!==currentChild.role;
        if(changed){
          currentChild={...currentChild,...status.child};childList=childList.map(c=>c.id===currentChild.id?currentChild:c);
          if(document.querySelector('dialog[open]')||pendingOperation){if(notifiedRevision!==status.revision){notifiedRevision=status.revision;toast('其他家长已更新数据，请完成当前编辑后刷新。')}}
          else{data=await Store.load();notifiedRevision=null;render()}
        }
      }catch(error){if(error.kind==='forbidden'){await showChildren();toast('你已不再拥有该孩子的管理权限。')}}
      finally{checkingContext=false}
    }
    if(!SELFTEST){setInterval(checkChildContext,30000);window.addEventListener('focus',checkChildContext);document.addEventListener('visibilitychange',checkChildContext)}

    boot();
  })();
