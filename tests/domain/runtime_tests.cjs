const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,f);
global.BroadcastChannel=undefined;global.history={replaceState(){},pushState(){}};global.location={pathname:'/'};global.window={scrollTo(){}};global.document={hidden:false};
const {Runtime,operationId}=require('../../frontend/parent/src/lib/runtime.ts');
const child={id:'child1',name:'甲',role:'owner',archived:false,membershipVersion:3},other={...child,id:'child2',name:'乙'},user={id:'u',nickname:'家长',loginName:'parent'};
const pkg=(id='child1',revision=2)=>({format:'lele-task-manager-store',version:1,revision,updatedAt:null,context:{childId:id,membershipVersion:3},data:{schemaVersion:2,settings:{childName:'甲',weekStartsOn:1},series:[],categories:[],completions:[],exceptions:[],ledger:[],gifts:[],taskPresets:[],operationLog:[]}});
const setup=()=>{const r=new Runtime();r.patch({child,user,children:[child,other],revision:1,data:pkg().data,loading:false});return r};
(async()=>{
 const r=setup(),bodies=[];global.fetch=async(path,options)=>{bodies.push(JSON.parse(options.body));throw Error('network lost')};
 await assert.rejects(()=>r.command('ledger.manual',{amount:5}),/未确认/);assert.equal(bodies.length,1);const id=bodies[0].operationId;
 await assert.rejects(()=>r.command('ledger.manual',{amount:6}),/上一项保存结果/);assert.equal(bodies.length,1);
 await assert.rejects(()=>r.selectChild(other.id),/刷新核对/);assert.equal(r.getSnapshot().child.id,child.id);
 global.fetch=async(path,options)=>{bodies.push(JSON.parse(options.body));return Response.json(pkg())};await r.command('ledger.manual',{amount:5});assert.equal(bodies[1].operationId,id);assert.equal(r.getSnapshot().revision,2);
 let release;global.fetch=async()=>new Promise(resolve=>release=resolve);const old=r.refresh();await Promise.resolve();r.patch({revision:4});release(Response.json(pkg('child1',3)));await old;assert.equal(r.getSnapshot().revision,4);
 const second=setup();let resolveRead;global.fetch=async()=>new Promise(resolve=>resolveRead=resolve);const read=second.api('/slow');await Promise.resolve();second.reset();resolveRead(Response.json({private:'甲'}));await assert.rejects(()=>read,e=>e.kind==='stale');assert.equal(second.getSnapshot().data,null);
 // Unknown-result operation id also survives browser-history navigation attempts.
 const third=setup();global.fetch=async()=>{throw Error('connection')};await assert.rejects(()=>third.command('task.create',{task:{title:'甲'}}));await third.enter();assert.equal(third.getSnapshot().child.id,child.id);assert.equal(third.getSnapshot().epoch,0);
 // A read-only refresh must not discard an operation id whose committed response was lost.
 const uncertain=setup(),written=[],ids=new Set();let entries=0,drop=true;
 global.fetch=async(path,options)=>{if(options.method==='GET')return Response.json(pkg('child1',2));const body=JSON.parse(options.body);written.push(body.operationId);if(!ids.has(body.operationId)){ids.add(body.operationId);entries++}if(drop){drop=false;throw Error('committed response lost')}return Response.json(pkg('child1',2))};
 await assert.rejects(()=>uncertain.command('ledger.manual',{amount:5}));assert.equal(uncertain.getSnapshot().unconfirmed,true);await uncertain.refresh();assert.equal(uncertain.getSnapshot().unconfirmed,true);await uncertain.retryPending();assert.equal(written[0],written[1]);assert.equal(entries,1);assert.equal(uncertain.getSnapshot().unconfirmed,false);
 // Confirmed deletion/revocation must override the pending-save navigation guard.
 const removed=setup();global.fetch=async()=>{throw Error('connection')};await assert.rejects(()=>removed.command('ledger.manual',{amount:7}));removed.forgetChild(child.id);assert.equal(removed.getSnapshot().child,null);assert.equal(removed.getSnapshot().data,null);assert.equal(removed.getSnapshot().unconfirmed,false);assert.equal(removed.getSnapshot().user.id,user.id);assert.deepEqual(removed.getSnapshot().children.map(c=>c.id),[other.id]);
 // A draft keeps its entry revision even after a newer read; retry preserves the same body.
 const batch=setup(),batchBodies=[];batch.patch({revision:9});
 global.fetch=async(path,options)=>{batchBodies.push(JSON.parse(options.body));throw Error('lost')};
 await assert.rejects(()=>batch.command('task.batch',{operations:[{kind:'task.create',payload:{task:{title:'草稿'}}}]},2));
 assert.equal(batchBodies[0].expectedRevision,2);
 global.fetch=async(path,options)=>{batchBodies.push(JSON.parse(options.body));return Response.json(pkg('child1',10))};
 await batch.retryPending();assert.deepEqual(batchBodies[1],batchBodies[0]);
 const guarded=setup();let guards=0;const unguard=guarded.guardNavigation(()=>{guards++;return false});
 guarded.setView('settings');assert.equal(guarded.getSnapshot().view,'calendar');
 await guarded.selectChild(other.id);assert.equal(guarded.getSnapshot().child.id,child.id);
 await guarded.enter();assert.equal(guarded.getSnapshot().child.id,child.id);assert.equal(guards,3);
 unguard();guarded.setView('settings');assert.equal(guarded.getSnapshot().view,'settings');
 guarded.patch({quickEditing:true});guarded.reset();assert.equal(guarded.getSnapshot().quickEditing,false);
 // Legacy HTTP LAN browsers lack randomUUID; getRandomValues still supplies an id.
 const original=Object.getOwnPropertyDescriptor(global,'crypto');Object.defineProperty(global,'crypto',{configurable:true,value:{getRandomValues:b=>{for(let i=0;i<b.length;i++)b[i]=i;return b}}});assert.equal(operationId().length,32);if(original)Object.defineProperty(global,'crypto',original);
 console.log(JSON.stringify({passed:true,checks:['uncertain operation id reuse','different operation blocked','pending child switch blocked','pending history blocked','monotonic reads','cross-context stale response discarded','refresh keeps uncertain id and retry commits once','deleted context clears uncertain save','HTTP LAN id fallback']}));
})().catch(e=>{console.error(e);process.exitCode=1});
