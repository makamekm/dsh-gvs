import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {apply} from '../v3/runtime.js';
function fixture(){
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
 apply(ctx);
 const actor=name=>{const member=[...members.values()].find(member=>member.name===name);return {id:member.id,session:{header:{parentSession:root.id}},ctx:{}};};
 async function call(name,args={},agent=root){const exec={agent,name,arguments:args,signal:new AbortController().signal};await hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}));const denied=guard(exec);if(denied)throw new Error(denied);return definitions.get(name).execute(args,exec);}
 const complete=async(id,agent,extra={})=>{const saved=JSON.parse([...files.values()][0]);if(saved.tasks.find(task=>task.id===id)?.kind==='brief'){
  if(saved.analysis?.state!=='ready')await call('gvs_analysis',{action:'plan',rationale:'Small code-only fixture: existing unit checks cover the goal; no additional visual analysis needed.',requirements:[]},agent);
  const goal=await call('gvs_goal',{action:'status'});await call('gvs_goal',{action:'plan',requirements:[{id:'human-goal',criterion:saved.task,sourceIds:goal.humanMessages.map(item=>item.id)}],assessedMessages:goal.humanMessages.map(item=>item.id),expertise:[],staffingRationale:'The fixture already has all needed capabilities.'},agent);
 }return call('gvs_task',{action:'complete',taskId:id,verdict:'pass',summary:'Observed result',findings:[],...extra},agent);};
 async function consult(agent){let cached;const pending=call('gvs_ask_user',{question:'Confirm the exact goal'},agent).then(value=>(cached=value,value));await new Promise(resolve=>setImmediate(resolve));if(cached)return cached;let list=await call('gvs_task',{action:'list'});const question=list.tasks.find(task=>task.kind==='consultation'&&task.state==='running');assert.ok(question);await complete(question.id,actor('user'));return pending;}
 return {root,ctx,hooks,definitions,files,members,tasks,sent,call,actor,complete,consult,effects,failNextSpawn:()=>{nextSpawnError=new Error('Temporary spawn failure');},changeSource:value=>{source=value;},get spawns(){return spawns;}};
}
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
 const isolated=await import(`../v3/runtime.js?recovery=${randomUUID()}`);isolated.apply(f.ctx);
 const status=await f.call('gvs_status');assert.equal(status.status,'running');assert.equal(status.gvsTeam.tasks.find(task=>task.id===start.briefTaskId).state,'blocked');
 await f.call('gvs_resume');assert.equal(f.actor('user').id,id);assert.equal(f.spawns,1);assert.equal(f.tasks.get(start.briefTaskId).status,'in_progress');
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
