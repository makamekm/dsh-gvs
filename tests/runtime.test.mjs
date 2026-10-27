import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {apply} from '../v3/runtime.js';
function fixture(config={}){
 const files=new Map(),members=new Map(),tasks=new Map(),sent=[];let serial=0,spawns=0,source='initial source',nextSpawnError=null;
 const root={id:`mock-${randomUUID()}`,session:{header:{}},ctx:{}};const hooks={},definitions=new Map(),effects=[];let guard;
 const team={membership(agent){return {root,name:agent===root?'lead':members.get(agent.id).name,role:agent===root?'lead':'teammate'};},tryMembership(agent){return team.membership(agent);},
  listMembers:()=>[...members.values()],async spawnTeammate(_root,request){spawns++;assert.ok(request.description.length<=200,'Native description limit');if(nextSpawnError){const error=nextSpawnError;nextSpawnError=null;throw error;}const member={id:`member-${randomUUID()}`,name:request.name};members.set(member.id,member);return {member};},
  async createTask(_root,request){const task={id:`task-${++serial}`,revision:1,status:'pending',blockedBy:request.blockedBy??[],subject:request.subject};tasks.set(task.id,task);return {...task};},
  getTask(_root,id){return {...tasks.get(id)};},async updateTask(_root,request){const task=tasks.get(request.taskId);assert.equal(request.expectedRevision,task.revision);
   if(request.action==='reassign'){assert.ok(task.blockedBy.every(id=>tasks.get(id).status==='completed'));task.status='in_progress';task.ownerName=request.owner;}
   if(request.action==='complete')task.status='completed';if(['reopen','release'].includes(request.action))task.status='pending';if(request.action==='set_dependencies')task.blockedBy=request.blockedBy;task.revision++;return {...task};},
  async sendMessage(_agent,request){sent.push(request);return {messageId:randomUUID()};},async waitForChange(){return {timedOut:false};},interrupt(){return {previousStatus:'inactive'};}};
 const ctx={agentTeams:team,on:(name,fn)=>{hooks[name]=fn;},effect:fn=>effects.push(fn),jobs:{attachController:()=>()=>{}},tools:{register:definition=>definitions.set(definition.name,definition),guard:fn=>{guard=fn;}},
  workingDirectory:{ensure:async()=>path.resolve('work/in-memory-fixture')},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},
  fs:{resolve:async file=>({file}),contains:()=>true,listDir:async()=>[{name:'app.js',type:'file'}],lstat:async()=>({type:'file'}),readBytes:async()=>Buffer.from(source),readText:async target=>{if(!files.has(target.file))throw Object.assign(new Error('missing'),{code:'ENOENT'});return files.get(target.file);},writeText:async(target,value)=>{files.set(target.file,value);}}};
 apply(ctx,{requireCoordinatorPlan:false,...config});
 const actor=name=>{const member=[...members.values()].find(member=>member.name===name);return {id:member.id,session:{header:{parentSession:root.id}},ctx:{}};};
 async function call(name,args={},agent=root){const exec={agent,name,arguments:args,signal:new AbortController().signal};await hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}));const denied=guard(exec);if(denied)throw new Error(denied);return definitions.get(name).execute(args,exec);}
 const complete=async(id,agent,extra={})=>{const saved=JSON.parse([...files.values()][0]);if(saved.tasks.find(task=>task.id===id)?.kind==='brief'){
  if(saved.analysis?.state!=='ready')await call('gvs_analysis',{action:'plan',rationale:'Small code-only fixture: existing unit checks cover the goal; no additional visual analysis needed.',requirements:[]},agent);
  const goal=await call('gvs_goal',{action:'status'});await call('gvs_goal',{action:'plan',requirements:[{id:'human-goal',criterion:saved.task,sourceIds:goal.humanMessages.map(item=>item.id)}],assessedMessages:goal.humanMessages.map(item=>item.id),expertise:[],staffingRationale:'The fixture already has all needed capabilities.'},agent);
 }return call('gvs_task',{action:'complete',taskId:id,verdict:'pass',summary:'Observed result',findings:[],...extra},agent);};
 async function consult(agent){let cached;const pending=call('gvs_ask_user',{question:'Confirm the exact goal'},agent).then(value=>(cached=value,value));await new Promise(resolve=>setImmediate(resolve));if(cached)return cached;let list=await call('gvs_task',{action:'list'});const question=list.tasks.find(task=>task.kind==='consultation'&&task.state==='running');assert.ok(question);await complete(question.id,actor('user'));return pending;}
 return {root,ctx,hooks,definitions,files,members,tasks,sent,call,actor,complete,consult,effects,failNextSpawn:()=>{nextSpawnError=new Error('Temporary spawn failure');},changeSource:value=>{source=value;},get spawns(){return spawns;}};
}
test('missing update reasons derive a factual audit; identical updates do not notify or reassign and real running lease changes remain denied',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Keep the complete human goal',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Original',instructions:'Original requirement remains',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[]});
 const goal=JSON.parse([...f.files.values()][0]).goal;
 const request={action:'update',taskId:work.task.id,title:'Precise slice',instructions:'Implement exact slice; preserve follow-ups',priority:95,readScopes:['app.js'],writeScopes:['app.js'],resources:[]};
 const updated=await f.call('gvs_task',request);assert.equal(updated.updated,true);assert.equal(updated.update.reasonSource,'derived');assert.deepEqual(updated.update.fields.sort(),['instructions','priority','title']);assert.ok(!f.sent.at(-1).content[0].text.includes('undefined'));
 const sent=f.sent.length,revision=f.tasks.get(work.task.id).revision;const repeat=await f.call('gvs_task',request);assert.equal(repeat.status,'unchanged');assert.equal(f.sent.length,sent);assert.equal(f.tasks.get(work.task.id).revision,revision);
 await assert.rejects(f.call('gvs_task',{...request,writeScopes:['other.js']}),/running task/);
 await assert.rejects(f.call('gvs_task',{action:'update',taskId:'not-real',title:'Unknown'}),/Unknown task/);
 assert.deepEqual(JSON.parse([...f.files.values()][0]).goal,goal);
});

test('coordinator plans gate editing, source drift stops dispatch, and completion requires actual changed code with fresh exact checks',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Implement actual source changes',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement the plan',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Precise patch',instructions:'Actual implementation',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[]});
 assert.equal(work.status,'needs-coordinator-plan');assert.equal(work.task.state,'waiting');assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.waiting[0].reason.kind,'coordinator-plan');
 const plan={summary:'Correct actual source',changes:[{path:'app.js',anchor:'initial source',edit:'Replace initial source with the required implemented behavior.'}],checks:['node check.mjs'],acceptance:['Required behavior works in the actual app.']};
 const updated=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan});assert.equal(updated.task.state,'running');assert.equal(updated.task.codePlan.authoredBy,f.root.id);
 const agent=f.actor('developer');await assert.rejects(f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan},agent),/coordinator/);
 const denial=await f.hooks['tools/pre-execute']({agent:f.root,name:'write',arguments:{file_path:path.resolve('work/in-memory-fixture/app.js')},signal:new AbortController().signal},async()=>({kind:'allow'}));assert.equal(denial.kind,'deny');
 await f.consult(agent);
 const exec={agent,name:'pwsh',arguments:{command:'node check.mjs'}},result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]};
 await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);
 await assert.rejects(f.complete(work.task.id,agent,{checks:['node check.mjs']}),/No planned file changed/);
 f.changeSource('actual implemented code');await assert.rejects(f.complete(work.task.id,agent,{checks:['node check.mjs']}),/plan checks/,'A check before the edit cannot certify the changed source');
 await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);
 await f.complete(work.task.id,agent,{checks:['node check.mjs']});assert.equal(f.tasks.get(work.task.id).status,'completed');
});

test('a queued plan whose source changes waits for Lead to inspect and refresh it, preserving the same task ID',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Fresh exact plans',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const dependency=await f.call('gvs_task',{action:'create',title:'Independent source review',instructions:'Review',kind:'consultation',assignee:'user'});
 const plan={summary:'Grounded patch',changes:[{path:'app.js',anchor:'initial source',edit:'Implement required code.'}],checks:['node check.mjs'],acceptance:['Actual required behavior.']};
 const work=await f.call('gvs_task',{action:'create',title:'Planned after dependency',instructions:'Implement exact plan',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[],dependsOn:[dependency.task.id],codePlan:plan});assert.equal(work.task.state,'waiting');
 f.changeSource('new current source');await f.complete(dependency.task.id,f.actor('user'));
 const waiting=await f.call('gvs_task',{action:'list',taskId:work.task.id});assert.equal(waiting.tasks[0].state,'waiting');assert.equal(waiting.tasks[0].planning.state,'stale');
 await assert.rejects(f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan}),/anchor not found/);
 plan.changes[0].anchor='new current source';const refreshed=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan});assert.equal(refreshed.task.id,work.task.id);assert.equal(refreshed.task.state,'running');
});

test('a promised report must actually exist and be nonempty; writing that report does not invalidate code checks',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Deliver actual files',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 let report=null;const bytes=f.ctx.fs.readBytes;f.ctx.fs.readBytes=async target=>{if(target.file.replaceAll('\\','/').endsWith('/artifacts/job/HANDOFF.md')){if(report===null)throw Object.assign(Error('missing'),{code:'ENOENT'});return Buffer.from(report);}return bytes(target);};
 const codePlan={summary:'Actual implementation and handoff',changes:[{path:'app.js',anchor:'initial source',edit:'Implement behavior.'},{path:'artifacts/job/HANDOFF.md',anchor:'# Guessed heading',edit:'Write actual integration instructions.'}],checks:['node test.mjs'],acceptance:['Behavior works; real handoff is supplied.']};
 const work=await f.call('gvs_task',{action:'create',title:'Deliver code',instructions:'Implement',kind:'work',assignee:'developer',writeScopes:['app.js','artifacts/job'],readScopes:['app.js'],resources:[],codePlan});
 const agent=f.actor('developer');await f.consult(agent);f.changeSource('implemented code');
 const exec={agent,name:'pwsh',arguments:{command:'node test.mjs'}},result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]};await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);
 await assert.rejects(f.complete(work.task.id,agent,{checks:['node test.mjs']}),/Planned outputs are missing/);
 report='  ';await assert.rejects(f.complete(work.task.id,agent,{checks:['node test.mjs']}),/missing or empty/);
 report='# Actual integration evidence\nObserved results and usage.';await f.complete(work.task.id,agent,{checks:['node test.mjs']});assert.equal(f.tasks.get(work.task.id).status,'completed');
 const files=await f.call('gvs_artifacts',{taskId:work.task.id},agent);assert.ok(files.files.includes('artifacts/job/HANDOFF.md'));
});

test('task admission separates absolute environment leases before calling the Native task API',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Native fixture work',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const cwd=path.resolve('work/in-memory-fixture'),outside=path.resolve(cwd,'../external-fixture');let admitted;
 const original=f.ctx.agentTeams.createTask;f.ctx.agentTeams.createTask=async(...args)=>{admitted=args[1];return original(...args);};
 const task=await f.call('gvs_task',{action:'create',title:'Precise code and isolated fixture',instructions:'Use only the already permitted fixture',kind:'work',assignee:'developer',writeScopes:[path.join(cwd,'src'),outside],readScopes:[],resources:[]});
 assert.deepEqual(admitted.writeScopes,['src']);assert.equal(task.task.externalWriteScopes.length,1);assert.equal(task.task.scopeNotices[1].kind,'external-environment-lease');
 f.definitions.set('write',{execute:async()=>({ok:true})});await assert.rejects(f.call('write',{file_path:path.join(outside,'file')},f.actor('developer')),/outside this task writeScopes/);
});

test('a report-only plan delivers an actual document without demanding a fake production-code edit',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Provide integration instructions',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'writer',title:'Writer',purpose:'Document actual integration',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Document integration',instructions:'Write actual instructions',kind:'work',assignee:'writer',writeScopes:['safety-ui/INTEGRATION.md'],readScopes:['safety-ui'],resources:[],codePlan:{summary:'Document verified integration',changes:[{path:'safety-ui/INTEGRATION.md',anchor:null,edit:'Record actual integration contract and usage.'}],checks:['node check-document.mjs'],acceptance:['Actual nonempty integration instructions exist.']}});
 assert.equal(work.task.codePlan.sources.length,0);const actor=f.actor('writer');await f.consult(actor);
 const exec={agent:actor,name:'pwsh',arguments:{command:'node check-document.mjs'}},result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]};
 await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);
 await f.complete(work.task.id,actor,{checks:['node check-document.mjs']});assert.equal(f.tasks.get(work.task.id).status,'completed');
});

test('specialists discover current reusable User IDs and Lead messages without weakening task completion',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Fix implementation',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Bounded work',instructions:'Implement',kind:'work',assignee:'developer'}),agent=f.actor('developer');
 const status=await f.call('gvs_ask_user',{action:'status'},agent);assert.equal(status.decisions[0].taskId,start.briefTaskId);assert.equal(status.total,1);
 assert.ok(f.sent.find(item=>item.target==='developer').content[0].text.includes('"taskId":"'+start.briefTaskId+'"'),'Assignment includes exact reusable IDs');
 const reused=await f.call('gvs_ask_user',{reuseTaskId:status.decisions[0].taskId},agent);assert.equal(reused.reused,true);
 const sent=await f.call('gvs_agent',{action:'message',name:'Lead',message:'Current source checkpoint'},agent);assert.equal(sent.target,'lead');
 await assert.rejects(f.call('gvs_task',{action:'complete',taskId:work.task.id,verdict:'pass',summary:'No explicit findings'},agent),/TOP-LEVEL/);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 await assert.rejects(f.call('gvs_ask_user',{reuseTaskId:'not-a-decision'},agent),new RegExp('Current reusable IDs: '+start.briefTaskId));
});

test('host API defers tasks, forbids early execution and wakes the same role without duplicating work',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Fix arithmetic',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Small changes',capability:'edit'});
 await f.call('gvs_agent',{action:'create',name:'reviewer',title:'Reviewer',purpose:'Independent checks',capability:'verify'});
 const work=await f.call('gvs_task',{action:'create',title:'Build',instructions:'Implement',kind:'work',assignee:'developer'});
 const review=await f.call('gvs_task',{action:'create',title:'Review',instructions:'Verify',kind:'review',assignee:'reviewer',dependsOn:[work.task.id]});
 assert.equal(review.task.state,'waiting');const count=f.tasks.size;
 const wake=await f.call('gvs_agent',{action:'wake',name:'reviewer',message:'Please continue the existing review'});
 assert.equal(wake.status,'waiting');assert.equal(f.tasks.size,count);assert.equal(f.sent.filter(message=>message.target==='reviewer').length,0);
 await assert.rejects(f.call('gvs_native_game_check',{command:'should not run'},f.actor('reviewer')),/dependency-ready/);
 await assert.rejects(f.call('gvs_task',{action:'complete',taskId:review.task.id,verdict:'pass',summary:'False',findings:[]},f.actor('reviewer')),/assigned running/);
 const originalId=f.actor('developer').id;await f.consult(f.actor('developer'));await f.complete(work.task.id,f.actor('developer'));
 assert.equal(f.sent.filter(message=>message.target==='reviewer').length,1);
 await assert.rejects(f.call('gvs_task',{action:'complete',taskId:review.task.id,verdict:'pass',summary:'Checks',findings:['positive observation']},f.actor('reviewer')),/findings must be/);
 await f.consult(f.actor('reviewer'));
 f.hooks['tools/result']({agent:f.actor('reviewer'),name:'pwsh',arguments:{command:'node test.mjs'}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]});
 await assert.rejects(f.complete(review.task.id,f.actor('reviewer'),{checks:['node test.mjs: passed']}),/ONLY verbatim/);
 await f.complete(review.task.id,f.actor('reviewer'),{checks:['node test.mjs'],simple:true,scopePreserved:true});
 const next=await f.call('gvs_task',{action:'create',title:'Second change',instructions:'New work, same role',kind:'work',assignee:'developer',dependsOn:[review.task.id]});
 assert.equal(next.task.state,'running');assert.equal(f.actor('developer').id,originalId);assert.equal(f.spawns,3);
});
test('scheduler overlaps independent scoped branches, preserves conflict waits, and guards direct edits',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Parallel project',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 for(const [name,capability] of [['ui','edit'],['server','edit'],['qa','verify'],['spare','edit']])await f.call('gvs_agent',{action:'create',name,title:name,purpose:'Independent branch',capability});
 const create=(name,paths,extra={})=>f.call('gvs_task',{action:'create',title:name,instructions:'Bounded isolated work',kind:'work',assignee:name,writeScopes:paths,readScopes:paths,resources:[],...extra});
 const ui=await create('ui',['ui']),server=await create('server',['backend']),qa=await create('qa',[],{readScopes:['tests/static']});
 assert.equal(ui.task.state,'running');assert.equal(server.task.state,'running');assert.equal(qa.task.state,'running');assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.active.length,3);
 const overlap=await create('spare',['ui/dialog']);assert.equal(overlap.task.state,'waiting');
 assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.waiting.find(t=>t.id===overlap.task.id).reason.kind,'resources');
 f.definitions.set('write',{execute:async()=>({ok:true})});const cwd=path.resolve('work/in-memory-fixture');
 assert.equal((await f.call('write',{file_path:path.join(cwd,'ui/dialog.js')},f.actor('ui'))).ok,true);
 await assert.rejects(f.call('write',{file_path:path.join(cwd,'backend/main.rs')},f.actor('ui')),/outside this task writeScopes/);
 await assert.rejects(f.call('gvs_task',{action:'update',taskId:ui.task.id,writeScopes:['backend'],reason:'Attempt live scope change'}),/running task/);
 await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},f.actor('ui'));await f.complete(ui.task.id,f.actor('ui'));
 assert.equal((await f.call('gvs_task',{action:'list',taskId:overlap.task.id})).tasks[0].state,'running','The same waiting task wakes when its file lease is released');
});
test('queued ownership/scopes can be corrected without new task IDs; limit and real dependencies remain binding',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Reuse queued branches',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 for(const name of ['first','second'])await f.call('gvs_agent',{action:'create',name,title:name,purpose:'Implement',capability:'edit'});
 await f.call('gvs_parallel',{action:'configure',maxParallel:1});
 const a=await f.call('gvs_task',{action:'create',title:'A',instructions:'A',kind:'work',assignee:'first',writeScopes:['a'],readScopes:['a'],resources:[]});
 const b=await f.call('gvs_task',{action:'create',title:'B',instructions:'B',kind:'work',assignee:'first',writeScopes:['b'],readScopes:['b'],resources:[]});
 const count=f.tasks.size;
 await f.call('gvs_task',{action:'update',taskId:b.task.id,assignee:'second',writeScopes:['b'],readScopes:['b'],resources:[],reason:'Reuse an independent specialist for the queued branch'});
 assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.waiting[0].reason.kind,'parallel-limit');
 await f.call('gvs_parallel',{action:'configure',maxParallel:2});assert.equal(f.tasks.size,count);assert.equal(f.tasks.get(b.task.id).ownerName,'second');
 const dependent=await f.call('gvs_task',{action:'create',title:'Join',instructions:'Needs A',kind:'work',assignee:'first',dependsOn:[a.task.id]});assert.equal(dependent.task.state,'waiting');
 await assert.rejects(f.call('gvs_parallel',{action:'configure',maxParallel:8},f.actor('second')),/Only the coordinator/);
 await f.call('gvs_pause');await f.call('gvs_parallel',{action:'configure',maxParallel:4});assert.equal((await f.call('gvs_status')).status,'paused');
});
test('verify can write its leased evidence in both native guards, but cannot edit product sources or another report',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Independent QA reports',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Independent verification',capability:'verify'});
 await assert.rejects(f.call('gvs_task',{action:'create',title:'Illegal QA edit',instructions:'Check',kind:'work',assignee:'qa',writeScopes:['src']}),/Verify writeScopes/);
 await f.call('gvs_task',{action:'create',title:'Evidence',instructions:'Write exact findings',kind:'work',assignee:'qa',readScopes:['src'],writeScopes:['artifacts/qa-report','dist'],resources:[]});
 f.definitions.set('write',{execute:async()=>({ok:true})});const actor=f.actor('qa'),cwd=path.resolve('work/in-memory-fixture'),target=path.join(cwd,'artifacts/qa-report/handoff.md');
 const exec={agent:actor,name:'write',arguments:{file_path:target},signal:new AbortController().signal};
 assert.equal((await f.hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}))).kind,'allow');assert.equal((await f.call('write',exec.arguments,actor)).ok,true);
 for(const file of ['src/app.js','scripts/analyzer.mjs','dist/forged.html','artifacts/other/handoff.md','../outside.md']){
  const denied={...exec,arguments:{file_path:path.resolve(cwd,file)}};
  assert.equal((await f.hooks['tools/pre-execute'](denied,async()=>({kind:'allow'}))).kind,'deny');await assert.rejects(f.call('write',denied.arguments,actor),/Verification may write/);
 }
 f.hooks['tools/result'](exec,{isError:false});assert.equal((await f.call('gvs_status')).progress.writes,0,'Report output is not production delivery');
 await f.call('gvs_pause');await assert.rejects(f.call('write',exec.arguments,actor),/paused|dependency-ready/);
});
test('a stale retry/update reports an advanced task without duplicating work or silently applying changes',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Avoid lifecycle races',kind:'code'}),before=await f.call('gvs_task',{action:'list',taskId:start.briefTaskId}),count=f.tasks.size,sent=f.sent.length;
 const running=await f.call('gvs_task',{action:'retry',taskId:start.briefTaskId,instructions:'Must not replace live work',dependsOn:['not-real']});assert.equal(running.status,'already-running');assert.equal(running.retried,false);assert.equal(f.sent.length,sent);
 await f.complete(start.briefTaskId,f.actor('user'));
 const done=await f.call('gvs_task',{action:'retry',taskId:start.briefTaskId});assert.equal(done.status,'already-completed');
 const update=await f.call('gvs_task',{action:'update',taskId:start.briefTaskId,title:'Must not overwrite accepted result',reason:'The task completed after the stale status read'});assert.equal(update.updated,false);assert.equal(update.status,'already-completed');assert.equal(update.task.title,before.tasks[0].title);assert.equal(f.tasks.size,count);
 await assert.rejects(f.call('gvs_task',{action:'dependencies',taskId:start.briefTaskId,dependsOn:[]}),/blocked or waiting/);
 await assert.rejects(f.call('gvs_task',{action:'retry',taskId:'not-real'}),/Unknown task/);
 const staleUpdate=await f.call('gvs_task',{action:'update',taskId:start.briefTaskId,title:'No reason'});assert.equal(staleUpdate.status,'already-completed');assert.equal(staleUpdate.updated,false);
});
test('UI reviews wait for actual preview readiness while isolated source work continues, then wake automatically',async()=>{
 const {createServer}=await import('node:http');let healthy=false;
 const server=createServer((_req,res)=>{res.statusCode=healthy?200:503;res.end('preview fixture');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const f=fixture(),start=await f.call('gvs_run',{task:'Restore a real UI preview',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
  for(const [name,capability] of [['visual','verify'],['source','verify'],['backend','edit']])await f.call('gvs_agent',{action:'create',name,title:name,purpose:'Independent work',capability});
  const state=JSON.parse([...f.files.values()][0]);state.preview={url:`http://127.0.0.1:${server.address().port}/`,jobId:'preview-fixture'};for(const key of f.files.keys())f.files.set(key,JSON.stringify(state));
  f.ctx.jobs.get=()=>({status:'running'});f.ctx.jobs.read=()=>({chunks:[{channel:'stderr',text:'Preview still starting'}]});
  const fresh=await import(`../v3/runtime.js?preview=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false});
  const visual=await f.call('gvs_task',{action:'create',title:'Visual QA',instructions:'Actual screenshots',kind:'review',assignee:'visual',scope:'increment',analysisIds:[],readScopes:['src'],writeScopes:['artifacts/visual'],resources:[]});
  assert.equal(visual.task.state,'waiting');assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.waiting[0].reason.kind,'preview-not-ready');assert.equal(f.sent.filter(m=>m.target==='visual').length,0);
  const source=await f.call('gvs_task',{action:'create',title:'Native source',instructions:'Static ABI',kind:'review',assignee:'source',scope:'increment',analysisIds:[],reviewFocus:'source',readScopes:['native'],resources:[]});assert.equal(source.task.state,'running');
  const backend=await f.call('gvs_task',{action:'create',title:'Backend',instructions:'Isolated module',kind:'work',assignee:'backend',readScopes:['backend'],writeScopes:['backend'],resources:[]});assert.equal(backend.task.state,'running');
  healthy=true;const preview=await f.call('gvs_preview',{action:'status'});assert.equal(preview.ready,true);assert.equal((await f.call('gvs_task',{action:'list',taskId:visual.task.id})).tasks[0].state,'running');assert.equal(f.sent.filter(m=>m.target==='visual').length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('one recorded User decision is reused across roles and later tasks without a consultation storm',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Deliver mobile then admin without reapproving known scope',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'dev',title:'Developer',purpose:'Implement known work',capability:'edit'});
 const task=await f.call('gvs_task',{action:'create',title:'Mobile slice',instructions:'Implement the known layout and test it',kind:'work',assignee:'dev'}),actor=f.actor('dev');
 const answer=await f.consult(actor),count=f.tasks.size;
 const reused=await f.call('gvs_ask_user',{question:'Confirm the exact goal'},actor);assert.equal(reused.reused,true);assert.equal(f.tasks.size,count);
 await f.complete(task.task.id,actor);
 const next=await f.call('gvs_task',{action:'create',title:'Admin slice',instructions:'Implement the already decided token flow',kind:'work',assignee:'dev'});
 assert.ok(next.task.consultations.includes(answer.userTaskId));await f.complete(next.task.id,actor);
});

test('batch linking is atomic and does not return the full contract for each link',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Batch known obligations',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 const work=await f.call('gvs_task',{action:'create',title:'Work',instructions:'Known work',kind:'work',assignee:'user'});
 await assert.rejects(f.call('gvs_goal',{action:'link',links:[{id:'human-goal',workTasks:[work.task.id]},{id:'missing',workTasks:[work.task.id]}]}),/Unknown requirement/);
 assert.deepEqual((await f.call('gvs_goal',{action:'status'})).requirements[0].workTasks,[]);
 const linked=await f.call('gvs_goal',{action:'link',links:[{id:'human-goal',workTasks:[work.task.id]}]});assert.equal(linked.linked.length,1);assert.equal(linked.humanMessages,undefined);
 assert.deepEqual((await f.call('gvs_goal',{action:'status'})).requirements[0].workTasks,[work.task.id]);
});

test('Lead can bound an active assignment and read its exact instructions without editing state files',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Full mobile and admin goal',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'dev',title:'Developer',purpose:'Implement',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Overlarge work',instructions:'Mobile plus every backend feature',kind:'work',assignee:'dev'});
 await f.call('gvs_task',{action:'update',taskId:work.task.id,title:'Mobile runnable increment',instructions:'Finish mobile layout and real render test; backend remains in the next owned task.',reason:'Stop an oversized assignment from delaying every deliverable',priority:50});
 const detail=await f.call('gvs_task',{action:'list',taskId:work.task.id});assert.match(detail.tasks[0].instructions,/real render test/);assert.equal(detail.tasks[0].state,'running');assert.equal(detail.tasks[0].priority,50);
 assert.match(f.sent.filter(x=>x.target==='dev').at(-1).content[0].text,/UPDATED EXISTING/);assert.equal((await f.call('gvs_goal',{action:'status'})).requirements[0].criterion,'Full mobile and admin goal');
});

test('identical analysis criteria keep existing report versions and stale User decisions cannot be reused',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Test version stability',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 const plan=(await f.call('gvs_analysis',{action:'status'})).plan;
 await f.call('gvs_task',{action:'create',title:'Consultation',instructions:'Clarify only new criteria',kind:'consultation',assignee:'user'});
 const repeated=await f.call('gvs_analysis',{action:'plan',rationale:'Same criteria, clearer explanation',requirements:[]},f.actor('user'));assert.equal(repeated.plan.version,plan.version);assert.equal(repeated.unchanged,true);
 await f.call('gvs_analysis',{action:'plan',rationale:'New latency requirement',requirements:[{id:'latency',criterion:'p95 below the target',reason:'Actual new criterion',method:'runtime'}]},f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'dev',title:'Developer',purpose:'Implement',capability:'edit'});await f.call('gvs_task',{action:'create',title:'Work',instructions:'Work',kind:'work',assignee:'dev'});
 await assert.rejects(f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},f.actor('dev')),/current human contract/);
});

test('static increment checks can finish before unrelated full-plan analysis but never count as final acceptance',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Deliver code with independent latency analysis later',kind:'code'});
 await f.call('gvs_analysis',{action:'plan',rationale:'Full acceptance needs runtime latency',requirements:[{id:'latency',criterion:'p95 below budget',reason:'Full target',method:'runtime'}]},f.actor('user'));await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'design',title:'Design',purpose:'Inspect static increment',capability:'read'});
 await assert.rejects(f.call('gvs_task',{action:'create',title:'Ambiguous increment',instructions:'Inspect',kind:'design-review',assignee:'design',scope:'increment'}),/explicit analysisIds/);
 const review=await f.call('gvs_task',{action:'create',title:'Static increment',instructions:'Static slice only',kind:'design-review',assignee:'design',scope:'increment',analysisIds:[]});await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},f.actor('design'));await f.complete(review.task.id,f.actor('design'));
 const finish=await f.call('gvs_finish');assert.equal(finish.status,'needs-review');assert.equal(finish.quality.analysis,false);assert.equal(finish.quality.goal,false);
 const whole=await f.call('gvs_task',{action:'create',title:'Full acceptance',instructions:'Full check',kind:'design-review',assignee:'design'});await assert.rejects(f.complete(whole.task.id,f.actor('design')),/analysis is incomplete/);
});

test('incremental visual approval still requires actual received current screenshots',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Static UI layout',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const task=await f.call('gvs_task',{action:'create',title:'Static visual slice',instructions:'Inspect pixels',kind:'user-review',assignee:'user',scope:'increment',analysisIds:[]});await assert.rejects(f.complete(task.task.id,f.actor('user')),/actual current images/);
});
test('Lead can classify an existing static audit without a visual waiver or a changed running lease',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'UI and a native adapter',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'abi',title:'ABI auditor',purpose:'Independent native source verification',capability:'verify'});
 const work=await f.call('gvs_task',{action:'create',title:'Static ABI audit',instructions:'Audit source and real native assertions',kind:'review',assignee:'abi',scope:'increment',analysisIds:[],readScopes:['crates/native'],writeScopes:[],resources:[]});
 const actor=f.actor('abi');await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},actor);
 f.hooks['tools/result']({agent:actor,name:'pwsh',arguments:{command:'node native-source-tests.mjs'}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]});
 await assert.rejects(f.complete(work.task.id,actor,{checks:['node native-source-tests.mjs']}),/Visual acceptance/);
 await assert.rejects(f.complete(work.task.id,actor,{checks:['node native-source-tests.mjs'],reviewFocus:'source'}),/coordinator assignment/);
 const updated=await f.call('gvs_task',{action:'update',taskId:work.task.id,reviewFocus:'source',reason:'This existing increment audits native source, not rendered UI'});
 assert.equal(updated.task.reviewFocus,'source');assert.equal(updated.task.state,'running');assert.deepEqual(updated.task.readScopes,['crates/native']);
 await f.complete(work.task.id,actor,{checks:['node native-source-tests.mjs'],simple:true,scopePreserved:true});
 assert.equal(f.tasks.get(work.task.id).status,'completed');const finish=await f.call('gvs_finish');assert.equal(finish.status,'needs-review');assert.equal(finish.quality.technical,false);assert.equal(finish.quality.visual,false);assert.equal(finish.quality.user,false);
});
test('source focus cannot be assigned to full, visual, User or motion-bearing reviews',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Do not waive visual review',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Review',capability:'verify'});
 for(const input of [{kind:'review',assignee:'qa',scope:'full'},{kind:'design-review',assignee:'qa',scope:'increment',analysisIds:[]},{kind:'user-review',assignee:'user',scope:'increment',analysisIds:[]}])await assert.rejects(f.call('gvs_task',{action:'create',title:'Invalid waiver',instructions:'Review',reviewFocus:'source',...input}),/Source-only focus/);
});

test('all required existing states can be paged and reopened by exact ID even with no geometry warnings',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Inspect every actual state',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Inspect',capability:'verify'});
 const work=await f.call('gvs_task',{action:'create',title:'Visual review',instructions:'Inspect all states',kind:'design-review',assignee:'qa',scope:'increment',analysisIds:[],readScopes:[],writeScopes:[],resources:[]});
 const saved=JSON.parse([...f.files.values()][0]),images=Array.from({length:48},(_,i)=>({viewport:i%2?'mobile':'desktop',stage:i===0?'initial':'step-'+i,attachment:{attachmentId:'actual-'+i}}));
 saved.visualChecks=[{ok:true,revision:saved.revision,taskId:work.task.id,capturedBy:'qa',images,views:['desktop','mobile'].map(viewport=>({viewport,layout:{captures:images.filter(i=>i.viewport===viewport).map(i=>({imageId:i.attachment.attachmentId,stage:i.stage,warningIds:[]})),warnings:[],truncated:false}}))}];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const isolated=await import(`../v3/runtime.js?all-states=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});await f.call('gvs_recover');
 const actor=f.actor('qa'),seen=[];let offset=0;do{const page=await f.call('gvs_visual',{action:'states',taskId:work.task.id,offset,limit:6},actor);assert.equal(page.total,48);assert.equal(page.images.length,page.states.length);seen.push(...page.states.map(s=>s.imageId));offset=page.nextOffset;}while(offset!==null);
 assert.equal(new Set(seen).size,48);assert.ok(seen.includes('actual-0'));assert.deepEqual((await f.call('gvs_visual',{action:'states',imageId:'actual-0'},actor)).images,[images[0]]);
 await assert.rejects(f.call('gvs_visual',{action:'states',imageId:'guessed-hash'},actor),/copy its literal ID/);assert.equal(f.tasks.size,2);
});

test('a runnable UI automatically queues the same User for exploration and coalesces later completed UI increments',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Continuously test current windows',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 let saved=JSON.parse([...f.files.values()][0]);saved.preview={url:'http://localhost:5173/',jobId:'not-running',ready:false};for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 let isolated=await import(`../v3/runtime.js?user-probe=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});await f.call('gvs_recover');
 saved=JSON.parse([...f.files.values()][0]);const probe=saved.tasks.find(t=>t.autoUserProbe);assert.ok(probe);assert.equal(probe.assignee,'user');assert.equal(probe.state,'waiting');assert.equal(probe.kind,'user-review');assert.equal(f.spawns,1);assert.deepEqual(probe.resources,[]);
 await f.call('gvs_recover');assert.equal(f.tasks.size,2);
 saved.tasks.push({id:'new-ui-slice',kind:'work',assignee:'developer',state:'done',dependsOn:[],result:{verdict:'pass',summary:'Actual UI slice',findings:[]},codePlan:{version:2,sources:[],changes:[{path:'store-ui/Badge.tsx'}]}});for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 isolated=await import(`../v3/runtime.js?coalesce-probe=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});await f.call('gvs_recover');
 saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.tasks.filter(t=>t.autoUserProbe).length,1);assert.equal(saved.tasks.find(t=>t.autoUserProbe).id,probe.id);assert.deepEqual(saved.tasks.find(t=>t.autoUserProbe).userProbeFor,['new-ui-slice']);assert.equal(f.tasks.size,2);
 await f.call('gvs_pause');await f.call('gvs_recover');assert.equal(JSON.parse([...f.files.values()][0]).status,'paused');
});

test('teammates can inspect their wait without coordinator authority and interrupted negative feedback is preserved without completing a queued task',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Preserve agent feedback',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const build=await f.call('gvs_task',{action:'create',title:'Build',instructions:'Implement',kind:'work',assignee:'developer'}),review=await f.call('gvs_task',{action:'create',title:'User test',instructions:'Test current UI',kind:'user-review',assignee:'user',dependsOn:[build.task.id]}),actor=f.actor('user'),count=f.tasks.size,revision=f.tasks.get(review.task.id).revision;
 f.ctx.agentTeams.waitForChange=()=>assert.fail('A queued teammate ends its turn instead of polling or scheduling the team');
 const wait=await f.call('gvs_wait',{seconds:10},actor);assert.equal(wait.ownTasks[0].state,'waiting');assert.equal(wait.ownTasks[0].blocker.kind,'dependencies');assert.equal(f.tasks.size,count);assert.equal(f.tasks.get(review.task.id).revision,revision);
 const feedback={action:'complete',taskId:review.task.id,verdict:'revise',summary:'Window failed before interruption',findings:['Observed dialog stays open after Close is pressed.']};
 const result=await f.call('gvs_task',feedback,actor);assert.equal(result.completed,false);assert.equal(result.status,'feedback-forwarded');assert.equal(result.state,'waiting');assert.equal(f.tasks.get(review.task.id).status,'pending');assert.equal(result.issueIds.length,1);assert.match(f.sent.at(-1).content[0].text,/INTERRUPTED REVIEW FEEDBACK/);
 await f.call('gvs_task',feedback,actor);assert.equal((await f.call('gvs_goal',{action:'status'})).issues.length,1);
 await assert.rejects(f.complete(review.task.id,actor),/assigned running/);await assert.rejects(f.call('gvs_task',feedback,f.actor('developer')),/assigned running/);
});

test('a teammate protocol error is automatically saved and sent to Lead without human forwarding',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Automatic diagnostics',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 const actor=f.actor('user');await assert.rejects(f.call('gvs_agent',{action:'create',name:'not-owned',title:'No',purpose:'Invalid role change',capability:'edit'},actor),/coordinator/);
 const report=await f.call('gvs_diagnostics');assert.equal(report.total,1);assert.equal(report.errors[0].agent,'user');assert.equal(report.errors[0].tool,'gvs_agent');assert.match(f.sent.at(-1).content[0].text,/GVS TOOL ERROR/);assert.equal(f.sent.at(-1).target,'lead');
});

test('actual failed native checks are reported automatically and an unrelated successful command cannot erase them',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Watch real check errors',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});const task=await f.call('gvs_task',{action:'create',title:'Check',instructions:'Implement and check',kind:'work',assignee:'developer'}),actor=f.actor('developer');
 const exec={agent:actor,name:'pwsh',arguments:{command:'node real-check.mjs'},signal:new AbortController().signal},failed={isError:false,value:{kind:'foreground',exitCode:1,stderr:{text:'Actual failed assertion'}},content:[]},passed={isError:false,value:{kind:'foreground',exitCode:0},content:[]};
 f.hooks['tools/result'](exec,failed);await new Promise(resolve=>setImmediate(resolve));let d=await f.call('gvs_diagnostics');assert.equal(d.open,1);assert.match(d.errors[0].message,/Actual failed assertion/);assert.equal(d.errors[0].taskId,task.task.id);
 f.hooks['tools/result']({...exec,arguments:{command:'node unrelated-check.mjs'}},passed);await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.call('gvs_diagnostics')).open,1);
 f.hooks['tools/result'](exec,passed);await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.call('gvs_diagnostics')).open,0);assert.equal(f.tasks.get(task.task.id).status,'in_progress','A successful command does not complete or accept the product task');
});

test('a passed increment still saves out-of-scope visual defects as mandatory goal issues',async()=>{
 const {VISUAL_CHECKS}=await import('../v3/visual.js');
 const f=fixture(),start=await f.call('gvs_run',{task:'Real UI review',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Inspect the actual UI',capability:'verify'});
 const saved=JSON.parse([...f.files.values()][0]);
 const warning={id:'layout-overlap',kind:'overlap',targets:[{label:'An unrelated dialog brand'}],images:['mobile']};
 saved.visualChecks=[{ok:true,revision:saved.revision,capturedBy:'other',images:['desktop','mobile'].map(viewport=>({viewport,stage:'initial',attachment:{attachmentId:viewport}})),views:['desktop','mobile'].map(viewport=>({viewport,layout:{schema:'gvs.layout/1',captures:[{stage:'initial',imageId:viewport,warningIds:viewport==='mobile'?[warning.id]:[]}],warnings:viewport==='mobile'?[warning]:[]}}))}];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 const fresh=await import(`../v3/runtime.js?visual=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false});
 const work=await f.call('gvs_task',{action:'create',title:'Focused visual review',instructions:'Review the current increment',assignee:'qa',kind:'review',scope:'increment',analysisIds:[]});
 await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},f.actor('qa'));
 f.hooks['tools/result']({agent:f.actor('qa'),name:'pwsh',arguments:{command:'node actual-review.mjs'}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'Observed'}},content:[]});
 await f.complete(work.task.id,f.actor('qa'),{checks:['node actual-review.mjs'],images:['desktop','mobile'],visualReview:{checked:VISUAL_CHECKS,assessments:[{warningId:warning.id,imageId:'mobile',disposition:'outside-scope',reason:'This separate dialog has a visible overlap and needs a specifically owned repair and independent recheck.'}]}});
 const goal=await f.call('gvs_goal',{action:'status'});assert.equal(goal.issues.length,1);assert.match(goal.issues[0].criterion,/visible overlap/);assert.equal(goal.ready,false);
 assert.equal((await f.call('gvs_task',{action:'list',taskId:work.task.id})).tasks[0].result.verdict,'pass');
});
test('a claimed agent turn ending without completion becomes a visible blocker',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Task',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'helper',title:'Helper',purpose:'Read task',capability:'read'});
 const created=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect',kind:'work',assignee:'helper'});
 const actor=f.actor('helper');f.hooks['session/event']({id:actor.id},{type:'turn/start',data:{turn:1}});
 f.hooks['session/event']({id:actor.id},{type:'user/message',data:{content:[{type:'text',text:`TASK NONCE: ${created.task.nonce}`}]}});
 f.hooks['session/event']({id:actor.id},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 const status=await f.call('gvs_task',{action:'list'});assert.equal(status.tasks.find(task=>task.id===created.task.id).state,'blocked');
});
test('restart preserves the active goal and resume reuses its original actor',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Recover',kind:'code'});const id=f.actor('user').id;
 const isolated=await import(`../v3/runtime.js?recovery=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});
 const status=await f.call('gvs_status');assert.equal(status.status,'running');assert.equal(status.gvsTeam.tasks.find(task=>task.id===start.briefTaskId).state,'blocked');
 await f.call('gvs_resume');assert.equal(f.actor('user').id,id);assert.equal(f.spawns,1);assert.equal(f.tasks.get(start.briefTaskId).status,'in_progress');
});
test('automatic recovery reuses interrupted assignments but never resumes a human pause or retries genuine blockers',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Automatic recovery',kind:'code'}),id=f.actor('user').id;
 const isolated=await import(`../v3/runtime.js?boot=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});
 const recovered=await f.call('gvs_recover');assert.equal(recovered.continued,true);assert.deepEqual(recovered.recovered,[start.briefTaskId]);assert.equal(f.actor('user').id,id);assert.equal(f.spawns,1);assert.equal(f.tasks.get(start.briefTaskId).status,'in_progress');
 assert.deepEqual((await f.call('gvs_recover')).recovered,[],'No duplicate wake of an already running task');
 await f.call('gvs_pause');const messages=f.sent.length;
 const paused=await f.call('gvs_recover');assert.equal(paused.status,'paused');assert.equal(paused.continued,false);assert.equal(f.sent.length,messages);
 await f.call('gvs_resume');
 await f.call('gvs_task',{action:'complete',taskId:start.briefTaskId,verdict:'blocked',summary:'Real missing external dependency',findings:['Runtime source is unavailable']},f.actor('user'));
 const blocked=await f.call('gvs_recover');assert.deepEqual(blocked.recovered,[]);assert.equal((await f.call('gvs_task',{action:'list',taskId:start.briefTaskId})).tasks[0].state,'blocked');
});

test('a human route change recovers the same provider-failed task once and preserves explicit pauses',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Recover after a human model switch',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Implement',instructions:'Preserve existing work',kind:'work',assignee:'developer'}),actor=f.actor('developer'),old={provider:'limited',model:'old'},policy={schema:1,revision:2,defaults:{provider:'available',model:'luna'},overrides:{}};
 f.ctx.sessionProjections={stateOf:(_session,key)=>key==='gvsModelRouting'?{policy}:key==='modelSelection'?{lastUsed:old}:undefined};
 f.hooks['session/event']({id:actor.id},{type:'turn/start',data:{turn:1}});f.hooks['session/event']({id:actor.id},{type:'user/message',data:{content:[{type:'text',text:work.task.nonce}]}});f.hooks['session/event']({id:actor.id},{type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'429 Token Plan usage limit reached'}}}});await new Promise(resolve=>setImmediate(resolve));
 const recovered=await f.call('gvs_recover',{reason:'model-change'});assert.deepEqual(recovered.recovered,[work.task.id]);assert.equal(f.tasks.get(work.task.id).status,'in_progress');assert.equal(f.actor('developer').id,actor.id);assert.equal(f.spawns,2);
 const saved=JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===work.task.id);assert.deepEqual(saved.modelRecovery.from,old);assert.deepEqual(saved.modelRecovery.to,policy.defaults);assert.equal(saved.lastFailure.verdict,'blocked');assert.deepEqual((await f.call('gvs_recover',{reason:'model-change'})).recovered,[]);
 await f.call('gvs_pause');assert.equal((await f.call('gvs_recover',{reason:'model-change'})).continued,false);
});

test('interrupted planned edits continue from their partial source, preserving the original baseline and requiring new checks',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Finish the planned implementation after restart',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const plan={summary:'Implement source',changes:[{path:'app.js',anchor:'initial source',edit:'Implement the required behavior.'}],checks:['node check.mjs'],acceptance:['Required behavior works.']};
 const work=await f.call('gvs_task',{action:'create',title:'Implement',instructions:'Finish source and checks',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[],codePlan:plan}),actor=f.actor('developer');await f.consult(actor);
 f.changeSource('partial implementation');
 const exec={agent:actor,name:'pwsh',arguments:{command:'node check.mjs'}},result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]};
 await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);await f.call('gvs_status');
 await new Promise(resolve=>setTimeout(resolve,5));
 const isolated=await import(`../v3/runtime.js?planned-recovery=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:true});
 const recovered=await f.call('gvs_recover');assert.deepEqual(recovered.recovered,[work.task.id]);
 const resumed=(await f.call('gvs_task',{action:'list',taskId:work.task.id})).tasks[0];assert.equal(resumed.state,'running');assert.equal(resumed.codePlan.sources[0].sha256,work.task.codePlan.sources[0].sha256);assert.equal(f.actor('developer').id,actor.id);assert.match(f.sent.at(-1).content[0].text,/CONTINUING AN INTERRUPTED ASSIGNMENT/);
 await assert.rejects(f.complete(work.task.id,actor,{checks:['node check.mjs']}),/plan checks/,'The interrupted assignment checks cannot certify the resumed assignment');
 await f.hooks['tools/post-execute'](exec,result,async()=>({kind:'accept'}));f.hooks['tools/result'](exec,result);
 await f.complete(work.task.id,actor,{checks:['node check.mjs']});assert.equal(f.tasks.get(work.task.id).status,'completed');
});

test('an interruption checkpoint still rejects later source drift and a replacement plan discards the continuation',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Preserve exact plans across pause',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});
 const plan={summary:'Initial patch',changes:[{path:'app.js',anchor:'initial source',edit:'Implement behavior.'}],checks:['node check.mjs'],acceptance:['Required behavior works.']};
 const work=await f.call('gvs_task',{action:'create',title:'Implement',instructions:'Implement',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[],codePlan:plan});
 f.changeSource('partial source');await f.call('gvs_pause');f.changeSource('different source after pause');
 await f.call('gvs_resume');const waiting=(await f.call('gvs_task',{action:'list',taskId:work.task.id})).tasks[0];assert.equal(waiting.state,'waiting');assert.equal(waiting.planning.state,'stale');
 const updated=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:{...plan,changes:[{path:'app.js',anchor:'different source after pause',edit:'Implement corrected patch.'}]}});assert.equal(updated.task.state,'running');
 assert.equal(JSON.parse([...f.files.values()][0]).tasks.find(task=>task.id===work.task.id).planContinuation,undefined);
});
test('a verbose assignment fits the native team limit and old oversize delivery failures retry the same task',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Bounded delivery',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'reviewer',title:'Reviewer',purpose:'Independent work',capability:'verify'});
 const saved=JSON.parse([...f.files.values()][0]);saved.goal.messages.push({id:'large-human-source',text:'Полный реальный контракт '.repeat(20000)});
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 const isolated=await import(`../v3/runtime.js?budget=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false});
 const work=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect current source',kind:'work',assignee:'reviewer'});
 const sent=f.sent.filter(message=>message.target==='reviewer').at(-1);assert.ok(Buffer.byteLength(JSON.stringify(sent.content),'utf8')<120001);assert.match(sent.content[0].text,/COMPACT ASSIGNMENT/);assert.match(sent.content[0].text,new RegExp(work.task.id));
 const state=JSON.parse([...f.files.values()][0]),task=state.tasks.find(task=>task.id===work.task.id);task.state='blocked';task.result={verdict:'blocked',summary:'team message exceeds 131072 bytes',findings:[]};
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(state));
 const reboot=await import(`../v3/runtime.js?retry=${randomUUID()}`);reboot.apply(f.ctx,{requireCoordinatorPlan:false});
 const recovered=await f.call('gvs_recover');assert.deepEqual(recovered.recovered,[work.task.id]);assert.equal(f.spawns,2);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
});

test('optional lifecycle metadata never leaks undefined into native JSON tool outputs',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Serialization',kind:'code'});
 const saved=JSON.parse([...f.files.values()][0]);
 f.hooks['session/event']({id:f.actor('user').id},{type:'turn/start',data:{}});
 f.hooks['session/event']({id:f.actor('user').id},{type:'user/message',data:{content:[{type:'text',text:`TASK NONCE: ${saved.tasks[0].nonce}`}]}});
 const result=await f.call('gvs_agent',{action:'list'});assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
});

test('routine status does not repeat large task instructions into the coordinator context',async()=>{
 const f=fixture();await f.call('gvs_run',{task:'Large instructions',kind:'code'});
 for(let i=0;i<3;i++)await f.call('gvs_task',{action:'create',title:`Later ${i}`,instructions:'x'.repeat(15000),kind:'work',assignee:'user'});
 const list=await f.call('gvs_task',{action:'list'});assert.equal(list.tasks.length,4);assert.ok(JSON.stringify(list).length<16000);
 const wait=await f.call('gvs_wait',{seconds:10});assert.ok(JSON.stringify(wait).length<8000);
});

test('User must choose task-specific checks before accepting the brief; roles cannot approve missing motion evidence',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Сделай параллакс плавным: текстура двигается рывками.',kind:'ui',viewports:['desktop']});
 await assert.rejects(f.call('gvs_task',{action:'complete',taskId:start.briefTaskId,verdict:'pass',summary:'Assumed smooth',findings:[]},f.actor('user')),/first call gvs_analysis plan/);
 await assert.rejects(f.call('gvs_analysis',{action:'plan',rationale:'No analysis',requirements:[]}),/central User/);
 await assert.rejects(f.call('gvs_analysis',{action:'plan',rationale:'No analysis',requirements:[]},f.actor('user')),/visible smoothness/);
 await f.call('gvs_analysis',{action:'plan',rationale:'Visible steps must be checked in the rendered output.',requirements:[{id:'motion',reason:'The user sees stepping',criterion:'Rendered texture moves without quantized jumps',method:'rendered-sequence'}]},f.actor('user'));
 await f.complete(start.briefTaskId,f.actor('user'));
 const task=await f.call('gvs_task',{action:'create',title:'Accept',instructions:'Actual evidence needed',kind:'user-review',assignee:'user'});
 await assert.rejects(f.complete(task.task.id,f.actor('user')),/analysis is incomplete/);
 const finish=await f.call('gvs_finish');assert.equal(finish.status,'needs-review');assert.equal(finish.quality.analysis,false);
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'do not execute'},f.actor('user')),/independent verify agent/);
});

test('conditional runtime evidence comes from a finished foreground command and still needs independent review',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Improve lookup latency',kind:'code'});
 await f.call('gvs_analysis',{action:'plan',rationale:'Latency is the acceptance target.',requirements:[{id:'latency',reason:'The user requested faster lookup',criterion:'Measured p95 under the agreed budget',method:'runtime'}]},f.actor('user'));await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'perf',title:'Performance QA',purpose:'Measure real lookup',capability:'verify'});
 await f.call('gvs_task',{action:'create',title:'Measure',instructions:'Use actual implementation',kind:'work',assignee:'perf'});
 const actor=f.actor('perf');actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'GVS_ANALYSIS_RESULT: '+JSON.stringify({schema:'gvs.analysis/1',engine:'fixture',analyzer:'Call actual lookup and measure elapsed milliseconds',results:[{id:'latency',cases:[{name:'p95 latency',source:'runtime',actual:8,expected:'<10ms',passed:true}]}]})}}})};
 const measured=await f.call('gvs_analysis',{action:'check',command:'node latency.mjs'},actor);assert.equal(measured.ok,true);
 const status=await f.call('gvs_analysis',{action:'status'});assert.equal(status.ready,false);assert.equal(status.reports.length,1);
 actor.ctx.tools.execute=async()=>({isError:false,value:{kind:'background',jobId:'pending'}});
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node latency.mjs'},actor),/foreground/);
});
test('failed analysis preserves the real assertion and cannot manufacture accepted evidence',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Measure latency',kind:'code'});
 await f.call('gvs_analysis',{action:'plan',rationale:'Actual runtime measurement',requirements:[{id:'latency',criterion:'Within budget',reason:'Runtime target',method:'runtime'}]},f.actor('user'));await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Measure',capability:'verify'});await f.call('gvs_task',{action:'create',title:'Runtime',instructions:'Actual runner',kind:'work',assignee:'qa'});
 const actor=f.actor('qa');actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'foreground',exitCode:1,stdout:{text:''},stderr:{text:'AssertionError: Settings must return keyboard focus to its trigger'}}})};
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node actual-runner.mjs'},actor),error=>/exit 1/.test(error.message)&&/Settings must return keyboard focus/.test(error.message)&&/No analysis evidence accepted/.test(error.message));
 assert.equal((await f.call('gvs_analysis',{action:'status'})).reports.length,0);
});

test('motion checker rejects out-of-workspace captures and repeated copies of one static image',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Smooth visible motion',kind:'ui',viewports:['desktop']});
 await f.call('gvs_analysis',{action:'plan',rationale:'Inspect actual visible motion',requirements:[{id:'motion',reason:'User sees stepping',criterion:'Continuous rendered motion and consistent frame times',method:'rendered-sequence'}]},f.actor('user'));await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'motion',title:'Motion QA',purpose:'Inspect rendered frames',capability:'verify'});
 await f.call('gvs_task',{action:'create',title:'Analyze',instructions:'Capture real frames',kind:'work',assignee:'motion'});
 const actor=f.actor('motion');actor.session.requestHeader=()=>({config:{provider:'mock',model:'vision'}});f.ctx.llm={resolveModelInfo:async()=>({inputModalities:['image']})};f.ctx.attachments={saveImage:async()=>({attachmentId:'same-image',mediaType:'image/png'})};
 f.ctx.fs.readBytes=async()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5foAAAAASUVORK5CYII=','base64');
 const data={schema:'gvs.analysis/1',engine:'mock',analyzer:'Contract test fixture',results:[{id:'motion',cases:[{name:'Pixel movement',source:'rendered-pixels',passed:true,actual:0,expected:0},{name:'Cadence',source:'frame-timing',passed:true,actual:0,expected:0}],samples:Array.from({length:32},(_,i)=>({viewport:'desktop',atMs:i*40,renderedPixelMetric:i*.25,frameTimeMs:16.7})),frames:Array.from({length:8},(_,i)=>({path:`../outside-${i}.png`,viewport:'desktop',atMs:i*150}))}]};
 actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'GVS_ANALYSIS_RESULT: '+JSON.stringify(data)}}})};
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node motion.mjs'},actor),/inside the project/);
 for(const [i,frame] of data.results[0].frames.entries())frame.path=`capture-${i}.png`;
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node motion.mjs'},actor),/identical/);
 assert.equal((await f.call('gvs_analysis',{action:'status'})).reports.length,0);
});

test('read-only commands preserve report freshness; actual source changes invalidate it regardless of command success',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Small change',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 const revision=(await f.call('gvs_status')).gvsTeam.revision;
 f.hooks['tools/result']({agent:f.root,name:'pwsh',arguments:{command:'Get-Content app.js'}},{isError:false,value:{kind:'foreground',exitCode:0},content:[]});
 assert.equal((await f.call('gvs_status')).gvsTeam.revision,revision);
 f.changeSource('changed even though the shell later failed');f.hooks['tools/result']({agent:f.root,name:'pwsh',arguments:{command:'edit; failed build'}},{isError:true,value:{kind:'foreground',exitCode:1},content:[]});
 assert.equal((await f.call('gvs_status')).gvsTeam.revision,revision+1);
 assert.equal((await f.call('gvs_status')).gvsTeam.revision,revision+1);
});
test('a rejected task explicitly escalates every finding and cannot disappear from goal coverage',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Small change',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'research',title:'Research',purpose:'Discover gaps',capability:'read'});
 const task=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Find all missing states',kind:'work',assignee:'research'});
 await f.call('gvs_task',{action:'complete',taskId:task.task.id,verdict:'revise',summary:'Useful local prototype',findings:['Missing original mobile split','Missing moderation notifications']},f.actor('research'));
 const notice=f.sent.filter(message=>message.target==='lead').at(-1).content[0].text;
 assert.match(notice,/Missing original mobile split/);assert.match(notice,/Missing moderation notifications/);
 const status=await f.call('gvs_goal',{action:'status'});assert.equal(status.issues.length,2);
 const finish=await f.call('gvs_finish');assert.equal(finish.continue,true);assert.equal(finish.quality.goal,false);
});
test('normal runtime disposal keeps the goal recoverable while explicit pause remains paused',async()=>{
 const f=fixture();await f.call('gvs_run',{task:'Long running goal',kind:'code'});
 const cleanup=f.effects.at(-1)();await cleanup();
 let saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.status,'running');assert.equal(saved.suspended,true);assert.equal(saved.tasks[0].result.interrupted,true);
 const p=fixture();await p.call('gvs_run',{task:'Human paused goal',kind:'code'});await p.call('gvs_pause');const pausedCleanup=p.effects.at(-1)();await pausedCleanup();saved=JSON.parse([...p.files.values()][0]);assert.equal(saved.status,'paused');
});
test('a disposed driver preserves its goal, but a human cancellation pauses it',async()=>{
 const f=fixture();await f.call('gvs_run',{task:'Recovery',kind:'code'});
 f.hooks['session/event']({id:f.root.id},{type:'turn/end',data:{reason:{kind:'aborted',reason:{kind:'disposed'}}}});await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.call('gvs_status')).status,'running');
 const p=fixture();await p.call('gvs_run',{task:'Stop',kind:'code'});p.hooks['session/event']({id:p.root.id},{type:'turn/end',data:{reason:{kind:'aborted',reason:{kind:'user'}}}});await new Promise(resolve=>setImmediate(resolve));assert.equal((await p.call('gvs_status')).status,'paused');
});
test('disposing one runtime scope never suspends another root goal',async()=>{
 const a=fixture(),b=fixture();await a.call('gvs_run',{task:'A',kind:'code'});await b.call('gvs_run',{task:'B',kind:'code'});
 await a.effects.at(-1)()();const status=await b.call('gvs_status');assert.equal(status.status,'running');assert.equal(status.gvsTeam.tasks[0].state,'running');
});
test('verbose roles obey the native description limit and a failed registration can wake the same role successfully',async()=>{
 const f=fixture();await f.call('gvs_run',{task:'Research',kind:'code'});const spec={action:'create',name:'reverse',title:'R'.repeat(80),purpose:'Detailed source analysis '.repeat(50),instructions:'Preserve complete instructions',capability:'read'};
 f.failNextSpawn();await assert.rejects(f.call('gvs_agent',spec),/Temporary spawn failure/);
 await assert.rejects(f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect',kind:'work',assignee:'reverse'}),/failed to register/);
 await f.call('gvs_agent',{action:'wake',name:'reverse'});const roles=await f.call('gvs_agent',{action:'list'});const role=roles.roles.find(role=>role.name==='reverse');
 assert.ok(role.sessionId);assert.equal(role.error,undefined);assert.equal(roles.roles.filter(role=>role.name==='reverse').length,1);const count=f.spawns;
 await f.call('gvs_agent',spec);assert.equal(f.spawns,count);
});
