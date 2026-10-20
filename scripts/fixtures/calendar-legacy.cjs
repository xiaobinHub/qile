// Frozen pre-migration calculation reference for characterization tests only.
module.exports = function(data){
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
return {occurrences,baseOccurrences,expandRevision,seriesRevisions}
}
