import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {apply} from '../v3/runtime.js';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
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
 apply(ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false,...config});
 const actor=name=>{const member=[...members.values()].find(member=>member.name===name);return {id:member.id,session:{header:{parentSession:root.id}},ctx:{}};};
 async function call(name,args={},agent=root){const exec={agent,name,arguments:args,signal:new AbortController().signal};await hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}));const denied=guard(exec);if(denied)throw new Error(denied);return definitions.get(name).execute(args,exec);}
 const complete=async(id,agent,extra={})=>{const saved=JSON.parse([...files.values()][0]);if(saved.tasks.find(task=>task.id===id)?.kind==='brief'){
  if(saved.analysis?.state!=='ready')await call('gvs_analysis',{action:'plan',rationale:'Small code-only fixture: existing unit checks cover the goal; no additional visual analysis needed.',requirements:[]},agent);
  const goal=await call('gvs_goal',{action:'status'});await call('gvs_goal',{action:'plan',requirements:[{id:'human-goal',criterion:saved.task,sourceIds:goal.humanMessages.map(item=>item.id)}],assessedMessages:goal.humanMessages.map(item=>item.id),expertise:[],staffingRationale:'The fixture already has all needed capabilities.'},agent);
 }return call('gvs_task',{action:'complete',taskId:id,verdict:'pass',summary:'Observed result',findings:[],...extra},agent);};
 async function consult(agent){let cached;const pending=call('gvs_ask_user',{question:'Confirm the exact goal'},agent).then(value=>(cached=value,value));await new Promise(resolve=>setImmediate(resolve));if(cached)return cached;let list=await call('gvs_task',{action:'list'});const question=list.tasks.find(task=>task.kind==='consultation'&&task.state==='running');assert.ok(question);await complete(question.id,actor('user'));return pending;}
 return {root,ctx,hooks,definitions,files,members,tasks,sent,call,actor,complete,consult,effects,nativeGuard:exec=>guard(exec),failNextSpawn:()=>{nextSpawnError=new Error('Temporary spawn failure');},changeSource:value=>{source=value;},get spawns(){return spawns;}};
}

test('a real successful process keeps its output and side effects when a planned new file became a directory and source proof fails',async t=>{
 const cwd=await fs.mkdtemp(path.join(tmpdir(),'gvs-proof-result-'));t.after(async()=>{assert.equal(path.dirname(cwd),path.resolve(tmpdir()));assert.ok(path.basename(cwd).startsWith('gvs-proof-result-'));await fs.rm(cwd,{recursive:true,force:true});});
 await fs.writeFile(path.join(cwd,'app.js'),'initial source');await fs.writeFile(path.join(cwd,'run.cjs'),"const f=require('node:fs');f.mkdirSync('artifacts/new-output',{recursive:true});f.writeFileSync('artifacts/new-output/marker.txt','actual side effect');console.log('ACTUAL PROCESS SUCCESS');");
 const f=fixture({requireCoordinatorPlan:true});f.ctx.workingDirectory.ensure=async()=>cwd;f.ctx.fs.readBytes=target=>fs.readFile(target.file);
 const start=await f.call('gvs_run',{task:'Preserve real process results',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Real process checkpoint',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Owned process',instructions:'Run actual checkpoint',kind:'work',assignee:'editor',readScopes:['app.js','run.cjs'],writeScopes:['app.js','artifacts/new-output'],resources:[],codePlan:{summary:'Implement exact source/output',changes:[{path:'app.js',anchor:'initial source',edit:'Implement actual behavior'},{path:'artifacts/new-output',anchor:null,edit:'Create the promised new output'}],checks:['node run.cjs'],acceptance:['Actual output exists']}}),actor=f.actor('editor'),exec={agent:actor,name:process.platform==='win32'?'pwsh':'bash',callId:'actual-process-without-proof',arguments:{command:'node run.cjs'},signal:new AbortController().signal};
 const child=spawnSync(process.execPath,['run.cjs'],{cwd,encoding:'utf8'});assert.equal(child.status,0);const value={kind:'foreground',exitCode:child.status,stdout:{text:child.stdout},stderr:{text:child.stderr}},content=[{type:'text',text:child.stdout},{type:'image',data:'kept-original-image',mimeType:'image/png'}],prior={id:'prior-context'},raw={isError:false,value,content,additionalContexts:[prior]};
 const result=await f.hooks['tools/execute'](exec,async()=>{await f.hooks['tools/post-execute'](exec,raw,async()=>({kind:'allow'}));f.hooks['tools/result'](exec,raw);return raw;});
 assert.equal(result.isError,false);assert.strictEqual(result.value,value);assert.strictEqual(result.content,content);assert.strictEqual(result.additionalContexts[0],prior);assert.match(result.additionalContexts.at(-1).content[0].text,/NO current code-plan check proof/);assert.equal(await fs.readFile(path.join(cwd,'artifacts/new-output/marker.txt'),'utf8'),'actual side effect');assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 let reruns=0;actor.ctx.tools={execute:async()=>{reruns++;throw new Error('Must not rerun a side effect just to repair metadata');}};await assert.rejects(f.call('gvs_plan_check',{taskId:work.task.id},actor),/EISDIR|directory|regular file/i);assert.equal(reruns,0);
 const diagnostics=await f.call('gvs_diagnostics');assert.ok(diagnostics.recent.some(d=>d.tool==='code-plan-evidence'));await f.call('gvs_pause');const saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.status,'paused');assert.equal(saved.checks.length,1);assert.equal(saved.checks[0].exitCode,0);assert.equal(saved.checks[0].error,false);assert.equal(saved.checks[0].finished,true);assert.equal(saved.checks[0].codePlanSources,undefined);assert.match(saved.checks[0].output,/ACTUAL PROCESS SUCCESS/);assert.equal(saved.tasks.find(t=>t.id===work.task.id).planContinuation,undefined);
 await f.call('gvs_recover');assert.equal(JSON.parse([...f.files.values()][0]).status,'paused','Recovery must not override a human pause, even with unreadable plan sources');await f.call('gvs_resume');const resumed=JSON.parse([...f.files.values()][0]),pending=resumed.tasks.find(t=>t.id===work.task.id);assert.equal(pending.state,'waiting');assert.equal(pending.planStale,true);assert.match(pending.planCheckpointError,/checkpoint unavailable|inspection failed/);assert.equal(f.tasks.get(work.task.id).status,'pending');assert.equal(reruns,0);
});

test('source-proof recovery is separate from process outcomes and cannot mask failures or reuse stale snapshot notices',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Separate process and proof status',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Owned source',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Work',instructions:'Run exact check',kind:'work',assignee:'editor',resources:[],writeScopes:['app.js'],codePlan:{summary:'Actual change',changes:[{path:'app.js',anchor:'initial source',edit:'Implement change'}],checks:['node check.cjs'],acceptance:['Actual check passes']}}),actor=f.actor('editor'),exec={agent:actor,name:'pwsh',arguments:{command:'node check.cjs'},signal:new AbortController().signal};
 let reads=0,broken=true;f.ctx.fs.readBytes=async()=>{reads++;if(broken)throw new Error('Source metadata unavailable');return Buffer.from('implemented source');};const run=raw=>f.hooks['tools/execute'](exec,async()=>{await f.hooks['tools/post-execute'](exec,raw,async()=>({kind:'allow'}));return raw;});
 for(const failure of [{isError:true},{exitCode:1},{timedOut:true},{aborted:true},{signal:'SIGTERM'},{kind:'background'}]){const {isError=false,...state}=failure,raw={isError,value:{kind:'foreground',exitCode:0,...state,stdout:{text:'original stdout'},stderr:{text:'original stderr'}},content:[]};assert.strictEqual(await run(raw),raw);}assert.equal(reads,0);
 const raw={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'success'},stderr:{text:''}},content:[]};assert.ok((await run(raw)).additionalContexts.length);assert.ok((await f.call('gvs_diagnostics')).recent.some(d=>d.tool==='code-plan-evidence'));
 broken=false;assert.strictEqual(await run(raw),raw);assert.equal((await f.call('gvs_diagnostics')).recent.some(d=>d.tool==='code-plan-evidence'),false,'Only successful source-proof capture resolves its own diagnostic');assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 broken=true;f.ctx.fs.writeText=async()=>{throw new Error('Diagnostic persistence temporarily unavailable');};const kept=await run(raw);assert.equal(kept.isError,false);assert.strictEqual(kept.value,raw.value);assert.ok(kept.additionalContexts.length);
});

test('long runtime analyses forward a bounded observation budget without completing tasks or bypassing independent acceptance',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Verify real connection idle expiry',kind:'code'}),user=f.actor('user');
 await f.call('gvs_analysis',{action:'plan',rationale:'Observe real connection expiry',requirements:[{id:'idle',reason:'The connection must stay alive before expiry',criterion:'Observe the required 180-second idle window',method:'runtime'}]},user);await f.complete(start.briefTaskId,user);
 await f.call('gvs_agent',{action:'create',name:'observer',title:'Runtime verifier',purpose:'Measure actual idle behavior',capability:'verify'});
 const work=await f.call('gvs_task',{action:'create',title:'Actual idle measurement',instructions:'Execute the full observation window',kind:'work',assignee:'observer',readScopes:['app.js'],resources:[]}),actor=f.actor('observer'),requests=[];
 const raw={schema:'gvs.analysis/1',engine:'fixture transport',analyzer:'idle-check.mjs',results:[{id:'idle',cases:[{name:'required idle window',source:'runtime',passed:true,actual:180000,expected:180000}]}]};
 actor.ctx.tools={execute:async request=>{requests.push(request);return {isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'GVS_ANALYSIS_RESULT: '+JSON.stringify(raw)},stderr:{text:''}}};}};
 const definition=f.definitions.get('gvs_analysis');assert.equal(definition.parameters.properties.timeoutMs.maximum,600000);assert.ok(definition.timeoutMs>600000);
 await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node idle-check.mjs',timeoutMs:240000}),/independent verify agent/);
 for(const timeoutMs of [0,999,600001,Infinity,240000.5,'240000'])await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node idle-check.mjs',timeoutMs},actor),/integer from 1000 to 600000/);
 assert.equal(requests.length,0);
 for(const timeoutMs of [240000,600000,1000,undefined]){const report=await f.call('gvs_analysis',{action:'check',command:'node idle-check.mjs',...(timeoutMs===undefined?{}:{timeoutMs})},actor),request=requests.at(-1);assert.equal(request.arguments.timeoutMs,timeoutMs??120000);assert.equal(report.timeoutMs,request.arguments.timeoutMs);assert.equal(request.arguments.command,'node idle-check.mjs');assert.equal(request.signal.aborted,false);assert.ok(request.callId);assert.equal(report.ok,true);assert.equal(report.taskId,work.task.id);}
 assert.equal(f.tasks.get(work.task.id).status,'in_progress');assert.equal((await f.call('gvs_analysis',{action:'status'})).ready,false);
});

test('extended analysis budgets preserve failed exits, timeouts, cancellation and missing-report failures',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Measure the complete lifecycle',kind:'code'}),user=f.actor('user');await f.call('gvs_analysis',{action:'plan',rationale:'Actual runtime behavior',requirements:[{id:'lifecycle',reason:'Runtime required',criterion:'Actual lifecycle completes',method:'runtime'}]},user);await f.complete(start.briefTaskId,user);
 await f.call('gvs_agent',{action:'create',name:'observer',title:'Verifier',purpose:'Actual lifecycle',capability:'verify'});const work=await f.call('gvs_task',{action:'create',title:'Lifecycle',instructions:'Run complete lifecycle',kind:'work',assignee:'observer',resources:[]}),actor=f.actor('observer');
 const raw={schema:'gvs.analysis/1',engine:'fixture',analyzer:'lifecycle.mjs',results:[{id:'lifecycle',cases:[{name:'lifecycle',source:'runtime',passed:true,actual:'closed',expected:'closed'}]}]};
 for(const failure of [{exitCode:1},{timedOut:true},{aborted:true},{signal:'SIGTERM'}]){actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'foreground',exitCode:0,...failure,stdout:{text:'GVS_ANALYSIS_RESULT: '+JSON.stringify(raw)},stderr:{text:''}}})};const report=await f.call('gvs_analysis',{action:'check',command:'node lifecycle.mjs',timeoutMs:600000},actor);assert.equal(report.ok,false);}
 actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'foreground',exitCode:1,timedOut:true,stdout:{text:''},stderr:{text:'Actual runner exceeded its budget'}}})};await assert.rejects(f.call('gvs_analysis',{action:'check',command:'node lifecycle.mjs',timeoutMs:600000},actor),/timed out/);
 assert.equal(f.tasks.get(work.task.id).status,'in_progress');assert.equal((await f.call('gvs_analysis',{action:'status'})).ready,false);assert.equal(JSON.parse([...f.files.values()][0]).analysisChecks.length,4);
});

test('planned-check helper executes actual build/assertion processes separately, requires exact fresh Native proof and never completes or bypasses a task',async t=>{
 const directory=await fs.mkdtemp(path.join(tmpdir(),'gvs-plan-native-')),artifact=path.join(directory,'actual-build.txt');t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('gvs-plan-native-'));await fs.rm(directory,{recursive:true,force:true});});
 const build=path.join(directory,'real-build.cjs'),verify=path.join(directory,'real-verify.cjs');await fs.writeFile(build,`require('node:fs').writeFileSync(${JSON.stringify(artifact)},'42')`);await fs.writeFile(verify,`require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(artifact)},'utf8'),'42')`);
 const quote=value=>process.platform==='win32'?"'"+value.replaceAll("'","''")+"'":"'"+value.replaceAll("'","'\\''")+"'",command=file=>(process.platform==='win32'?'& ':'')+quote(process.execPath)+' '+quote(file),checks=[command(build),command(verify)];
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Implement and validate exact planned behavior',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Implementation',purpose:'Execute a precise source plan',capability:'edit'});
 const plan={summary:'Change actual source then build and assert the real artifact',changes:[{path:'app.js',anchor:'initial source',edit:'Replace initial source with implemented behavior'}],checks,acceptance:['The built artifact contains the independently asserted required value.']},work=await f.call('gvs_task',{action:'create',title:'Owned implementation',instructions:'Implement and run planned checks',kind:'work',assignee:'editor',writeScopes:['app.js'],readScopes:['app.js'],resources:[],codePlan:plan}),actor=f.actor('editor'),executed=[];await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},actor);f.changeSource('implemented-v1');
 actor.ctx.tools={execute:async request=>{assert.equal(request.agent.id,actor.id);assert.equal(request.name,process.platform==='win32'?'pwsh':'bash');assert.ok(checks.includes(request.arguments.command));assert.equal((await f.hooks['tools/pre-execute'](request,async()=>({kind:'allow'}))).kind,'allow');assert.equal(f.nativeGuard(request),undefined);executed.push(request.arguments.command);const result=spawnSync(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',request.arguments.command]:['-c',request.arguments.command],{cwd:directory,encoding:'utf8',timeout:10000,windowsHide:true});if(result.error)throw result.error;const outcome={isError:false,value:{kind:'foreground',exitCode:result.status,stdout:{text:result.stdout},stderr:{text:result.stderr}},content:[]};await f.hooks['tools/post-execute'](request,outcome,async()=>({kind:'allow'}));f.hooks['tools/result'](request,outcome);return outcome;}};
 await assert.rejects(f.call('gvs_plan_check',{taskId:work.task.id}),/assigned running implementation/);await assert.rejects(f.call('gvs_plan_check',{taskId:work.task.id,index:-1},actor),/actual planned check index/);await assert.rejects(f.call('gvs_plan_check',{taskId:work.task.id,timeoutMs:500},actor),/1000/);assert.equal(executed.length,0);const first=await f.call('gvs_plan_check',{taskId:work.task.id},actor);assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.allChecksCurrent,false);assert.equal(first.remaining[0].index,1);assert.equal(await fs.readFile(artifact,'utf8'),'42');assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 const second=await f.call('gvs_plan_check',{taskId:work.task.id},actor);assert.equal(second.allChecksCurrent,true);assert.deepEqual(executed,checks);const cached=await f.call('gvs_plan_check',{taskId:work.task.id},actor);assert.equal(cached.status,'already-verified');assert.equal(executed.length,2);
 await fs.writeFile(artifact,'wrong');const failed=await f.call('gvs_plan_check',{taskId:work.task.id,index:1},actor);assert.equal(failed.ok,false);assert.equal(failed.execution.exitCode,1);assert.equal(failed.allChecksCurrent,false);assert.ok(failed.errors[0].includes('AssertionError'));await assert.rejects(f.complete(work.task.id,actor,{checks}),/Coordinator plan checks must actually pass/);
 await f.call('gvs_plan_check',{taskId:work.task.id,index:0},actor);assert.ok(JSON.parse([...f.files.values()][0]).diagnostics.some(d=>d.tool==='gvs_plan_check'&&d.status==='open'&&d.message.includes('AssertionError')),'A successful different planned command cannot clear this actual failed assertion.');
 await fs.writeFile(artifact,'42');assert.equal((await f.call('gvs_plan_check',{taskId:work.task.id,index:1},actor)).allChecksCurrent,true);f.changeSource('implemented-v2');const fresh=await f.call('gvs_plan_check',{taskId:work.task.id},actor);assert.equal(fresh.index,0);assert.equal(fresh.allChecksCurrent,false);assert.equal((await f.call('gvs_plan_check',{taskId:work.task.id},actor)).allChecksCurrent,true);
 const done=await f.complete(work.task.id,actor,{checks});assert.equal(done.task.result.verdict,'pass');assert.equal(f.tasks.get(work.task.id).status,'completed');const count=executed.length;await assert.rejects(f.call('gvs_plan_check',{taskId:work.task.id},actor),/assigned running implementation/);assert.equal(executed.length,count);
 const next=await f.call('gvs_task',{action:'create',title:'Another owned slice',instructions:'Preserve pause',kind:'work',assignee:'editor',writeScopes:['app.js'],resources:[],codePlan:{...plan,changes:[{...plan.changes[0],anchor:'implemented-v2'}]}});await f.call('gvs_pause');await assert.rejects(f.call('gvs_plan_check',{taskId:next.task.id},actor),/paused|assigned running implementation/);assert.equal(executed.length,count);
});

test('an unrecorded Native invocation cannot borrow an older successful planned-check proof',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Retain exact invocation evidence',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Implement',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Owned code',instructions:'Actual work',kind:'work',assignee:'editor',writeScopes:['app.js'],resources:[],codePlan:{summary:'Implement actual behavior',changes:[{path:'app.js',anchor:'initial source',edit:'Replace with actual behavior'}],checks:['node exact-check.mjs'],acceptance:['Actual behavior is correct']}}),actor=f.actor('editor');f.changeSource('implemented');
 const prior={callId:'previous-call',agent:actor,name:'pwsh',arguments:{command:'node exact-check.mjs'}},result={isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'Old real success'},stderr:{text:''}},content:[]};await f.hooks['tools/post-execute'](prior,result,async()=>({kind:'allow'}));f.hooks['tools/result'](prior,result);
 actor.ctx.tools={execute:async()=>result};const missing=await f.call('gvs_plan_check',{taskId:work.task.id,index:0},actor);assert.equal(missing.status,'needs-evidence-record');assert.equal(missing.accepted,false);assert.equal(missing.allChecksCurrent,false);assert.equal(missing.taskCompleted,false);assert.equal(JSON.parse([...f.files.values()][0]).checks.length,1);
 actor.ctx.tools={execute:async()=>({isError:false,value:{kind:'background',jobId:'unfinished'},content:[]})};const unfinished=await f.call('gvs_plan_check',{taskId:work.task.id,index:0},actor);assert.equal(unfinished.status,'needs-evidence-record');assert.equal(unfinished.allChecksCurrent,false);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
});
test('self-message and coordinator-only consultation mistakes return unapplied direction without Native self-send or fabricated tasks',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Preserve actual human goal',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));const count=f.tasks.size,goal=JSON.parse([...f.files.values()][0]).goal;
 const consultation=await f.call('gvs_ask_user',{action:'ask',question:'Clarify only this actual question'});assert.equal(consultation.accepted,false);assert.equal(consultation.consulted,false);assert.equal(consultation.status,'coordinator-consultation-required');assert.equal(f.tasks.size,count);
 const request=await f.call('gvs_agent',{action:'request',message:'Need expertise'});assert.equal(request.requested,false);assert.deepEqual(JSON.parse([...f.files.values()][0]).goal,goal);
 await f.call('gvs_agent',{action:'create',name:'author',title:'Author',purpose:'Bounded work',capability:'edit'});await f.call('gvs_task',{action:'create',title:'Actual slice',instructions:'Continue actual owned slice',kind:'work',assignee:'author'});const self=await f.call('gvs_agent',{action:'message',name:'author',message:'This is a mistaken self message'},f.actor('author'));assert.equal(self.sent,false);assert.equal(self.accepted,false);assert.ok(!f.sent.some(m=>m.target==='author'&&m.content[0].text==='This is a mistaken self message'));assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('Self-message')));
});

test('neutral observations are saved, paged and delivered without creating repair issues or hiding actionable findings',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Preserve full actual requirements',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Bounded work',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Bounded slice',instructions:'Report actual outcomes',kind:'work',assignee:'editor'}),actor=f.actor('editor');await f.consult(actor);
 const observations=['The selected state has no observed clipping.','A corrected locator reached the intended control.','This note is not full-goal acceptance.'];const finished=await f.complete(work.task.id,actor,{observations});assert.deepEqual(finished.task.result.observations,observations);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,0);
 const page=await f.call('gvs_task',{action:'list',taskId:work.task.id,offset:1,limit:1});assert.deepEqual(page.tasks[0].result.observations,[observations[1]]);assert.equal(page.tasks[0].result.totals.observations,3);assert.equal(page.tasks[0].result.nextOffset,2);assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('"observationCount":3')));
 const repair=await f.call('gvs_task',{action:'create',title:'Another owned slice',instructions:'Retain actionable defects',kind:'work',assignee:'editor'}),findings=['Actual settings window cannot close or recover.'];const rejected=await f.complete(repair.task.id,actor,{findings,observations});assert.equal(rejected.completed,false);assert.equal(f.tasks.get(repair.task.id).status,'in_progress');
 await f.complete(repair.task.id,actor,{verdict:'revise',findings,observations});const saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.goal.issues.length,1);assert.equal(saved.goal.issues[0].criterion,findings[0]);assert.equal((await f.call('gvs_finish')).status,'needs-review');
});

test('a lost managed preview is restored before reassigning interrupted runtime work; stop, pause, owner and task identity stay binding',async t=>{
 const f=fixture(),servers=[],jobs=new Map(),order=[];let lastServer,closing,serial=0;
 const close=async server=>{if(!server?.listening)return;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};t.after(async()=>{for(const server of servers)await close(server);});
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await close(reservation);
 Object.assign(f.ctx.jobs,{get(id){if(!jobs.has(id))throw Error('lost owned job');return jobs.get(id);},kill(id){jobs.get(id).status='completed';closing=close(lastServer);},wait:async id=>{await closing;return jobs.get(id);},read:()=>({chunks:[]})});
 f.root.ctx.tools={execute:async request=>{if(request.name==='gvs_preview')return {isError:false,value:await f.call('gvs_preview',request.arguments)};assert.ok(['pwsh','bash'].includes(request.name));assert.equal(request.arguments.command,'known authorized fixture server');order.push('shell-start');lastServer=createServer((_req,res)=>res.end('owned fixture HTTP ready'));servers.push(lastServer);await new Promise(resolve=>lastServer.listen(port,'127.0.0.1',resolve));const jobId='owned-preview-'+(++serial);jobs.set(jobId,{status:'running'});return {isError:false,value:{kind:'background',jobId}};}};
 const start=await f.call('gvs_run',{task:'Restore a managed runtime after restart',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));const observed=await f.call('gvs_preview',{action:'start',command:'known authorized fixture server',port});assert.equal(observed.ready,true);
 await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Current runtime slice',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Runtime work',instructions:'Keep exact task and source work',kind:'work',assignee:'editor',resources:['project-runtime'],readScopes:['app.js'],writeScopes:['app.js']}),actorId=f.actor('editor').id;
 const status=await f.call('gvs_status');assert.equal(status.previewRestore,undefined);let saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.previewRestore.enabled,true);assert.equal(saved.previewRestore.runId,saved.runId);
 const nativeUpdate=f.ctx.agentTeams.updateTask;f.ctx.agentTeams.updateTask=async(root,request)=>{if(request.action==='reassign'){assert.equal(lastServer.listening,true,'Task dispatch cannot race the actual preview restoration');order.push('reassign');}return nativeUpdate(root,request);};
 async function interrupt(){await close(lastServer);jobs.clear();saved=JSON.parse([...f.files.values()][0]);const task=saved.tasks.find(task=>task.id===work.task.id);task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],interrupted:true,revision:saved.revision};for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?preview-restore=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false});}
 await interrupt();order.length=0;const recovered=await f.call('gvs_recover');assert.equal(recovered.previewRecovery.restored,true);assert.equal(recovered.previewRecovery.gvsTeam,undefined,'Recovery must not replay a nested complete team history into model context');assert.deepEqual(recovered.recovered,[work.task.id]);assert.deepEqual(order,['shell-start','reassign']);assert.equal(f.actor('editor').id,actorId);assert.equal(f.tasks.get(work.task.id).status,'in_progress');assert.equal(JSON.parse([...f.files.values()][0]).runId,saved.runId);
 const count=serial;await f.call('gvs_recover');assert.equal(serial,count,'An already ready owned server is not duplicated');
 await f.call('gvs_pause');const paused=await f.call('gvs_recover');assert.equal(paused.continued,false);const denied=await f.call('gvs_preview',{action:'start',command:'known authorized fixture server',port});assert.equal(denied.started,false);assert.equal(serial,count);const resumed=await f.call('gvs_resume');assert.equal(resumed.previewRecovery.restored,true);assert.equal(f.actor('editor').id,actorId);
 await f.call('gvs_preview',{action:'stop'});await interrupt();const stopped=await f.call('gvs_recover');assert.equal(stopped.previewRecovery.status,'needs-coordinator');assert.equal(f.tasks.get(work.task.id).status,'pending');assert.equal(JSON.parse([...f.files.values()][0]).tasks.find(task=>task.id===work.task.id).waitForPreviewRecovery,true);
 const explicit=await f.call('gvs_preview',{action:'start',command:'known authorized fixture server',port});assert.equal(explicit.ready,true);assert.equal(f.tasks.get(work.task.id).status,'in_progress');assert.equal(JSON.parse([...f.files.values()][0]).tasks.find(task=>task.id===work.task.id).waitForPreviewRecovery,undefined);
});

test('read-only browser runtime discovery works before a run and for assigned discovery roles without inventing acceptance or requiring a review',async()=>{
 const browserModule=fileURLToPath(new URL('./fixtures/no-browser.mjs',import.meta.url)),f=fixture({browserModule}),before=await f.call('gvs_browser_capabilities');assert.equal(before.status,'browser-capabilities');assert.equal(before.acceptanceEvidence,false);assert.equal(f.files.size,0);assert.equal(f.spawns,0);assert.ok(before.engines.every(e=>e.available===false&&e.runtime.modulePath===browserModule));
 const start=await f.call('gvs_run',{task:'Inspect CLI and its actual runtime',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'reader',title:'Runtime investigator',purpose:'Discover actual runtime',capability:'read'});await f.call('gvs_task',{action:'create',title:'Runtime discovery',instructions:'Read actual capabilities without launching product work',kind:'discovery',assignee:'reader',resources:[]});
 const saved=JSON.parse([...f.files.values()][0]),result=await f.call('gvs_browser_capabilities',{},f.actor('reader')),after=JSON.parse([...f.files.values()][0]);assert.equal(result.acceptanceEvidence,false);assert.deepEqual(after.goal,saved.goal);assert.deepEqual(after.tasks,saved.tasks);assert.deepEqual(after.visualChecks,saved.visualChecks);assert.equal(after.kind,'code');
});

test('target inspection uses sandbox metadata before a run and native UI never launches a browser matrix',async()=>{
 const f=fixture({projectInspection:true,responsiveTesting:true}),cwd=await f.ctx.workingDirectory.ensure();
 f.ctx.fs.listDir=async target=>path.relative(cwd,target.file)===''?[{name:'project.godot',type:'file'},{name:'scenes',type:'directory'}]:[{name:'main.tscn',type:'file'}];
 f.ctx.fs.readBytes=async target=>{if(path.relative(cwd,target.file)==='project.godot')return Buffer.from('[application]\nconfig/name="Native game"');if(path.relative(cwd,target.file)===path.join('scenes','main.tscn'))return Buffer.from('[gd_scene format=3]');throw Object.assign(new Error('missing'),{code:'ENOENT'});};
 const discovery=await f.call('gvs_project');assert.deepEqual(discovery.target.surfaces,['native-game']);assert.deepEqual(discovery.target.sourceRoots,['scenes']);assert.equal(discovery.target.sourceConfirmed,true);
 const started=await f.call('gvs_run',{task:'Verify actual native game windows',kind:'game2d',engine:'Godot'});assert.deepEqual(JSON.parse([...f.files.values()][0]).viewports,['desktop']);
 const response=await f.call('gvs_responsive',{action:'status'});assert.equal(response.status,'not-web-target');assert.equal(response.accepted,false);assert.equal(response.required,false);assert.ok(started.briefTaskId);
});

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

test('running discovery can add an immutable shared input without abandoning its assignment or changing its write lease',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Inspect complete captured source',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'researcher',title:'Researcher',purpose:'Inspect actual source',capability:'read'});
 await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Isolated edits',capability:'edit'});
 const research=await f.call('gvs_task',{action:'create',title:'Source contract',instructions:'Inspect',kind:'discovery',scope:'increment',analysisIds:[],assignee:'researcher',readScopes:['artifacts/source'],writeScopes:[],resources:[]});
 const edit=await f.call('gvs_task',{action:'create',title:'Other isolated branch',instructions:'Implement',kind:'work',assignee:'editor',readScopes:['src'],writeScopes:['src'],resources:[]});
 const id=research.task.id,session=f.actor('researcher').id;
 const expanded=await f.call('gvs_task',{action:'update',taskId:id,readScopes:['artifacts/source','artifacts/picker/main-decoded.txt']});
 assert.equal(expanded.task.state,'running');assert.equal(f.actor('researcher').id,session);assert.deepEqual(expanded.task.writeScopes,[]);
 const reorder=await f.call('gvs_task',{action:'update',taskId:id,readScopes:['artifacts/picker/main-decoded.txt','artifacts/source']});assert.equal(reorder.task.state,'running');
 await assert.rejects(f.call('gvs_task',{action:'update',taskId:id,readScopes:['artifacts/source','artifacts/picker/main-decoded.txt','src']}),/resources/);
 await assert.rejects(f.call('gvs_task',{action:'update',taskId:id,readScopes:[]}),/read-lease-contraction/);
 assert.equal(f.tasks.get(edit.task.id).status,'in_progress');
});

test('Native failure recovery context preserves errors, outputs and images and is not injected into success or paused work',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Correct an actual tool error',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 const exec={agent:f.root,name:'edit',arguments:{file_path:'app.js'}},image={type:'image',attachment:{attachmentId:'actual-image'}},error={isError:true,error:{message:'old_string was not found in app.js'},content:[image]};
 const recovered=await f.hooks['tools/execute'](exec,async()=>error);assert.equal(recovered.isError,true);assert.equal(recovered.error,error.error);assert.equal(recovered.content,error.content);assert.match(recovered.additionalContexts[0].content[0].text,/leading spaces/);
 const command={isError:false,value:{kind:'foreground',exitCode:1,stderr:{text:''},stdout:{text:'Page.captureScreenshot: Unable to capture screenshot'}},content:[]};
 const hinted=await f.hooks['tools/execute']({...exec,name:'pwsh'},async()=>command);assert.equal(hinted.value,command.value);assert.match(hinted.additionalContexts[0].content[0].text,/no new image/);
 const prior={id:'existing-context',content:[]},binary={isError:true,error:{message:'cannot read "C:\\work\\real capture.png": binary file'},content:[{type:'text',text:'cannot read "C:\\work\\real capture.png": binary file'},image],additionalContexts:[prior]},rasterHint=await f.hooks['tools/execute']({...exec,name:'read'},async()=>binary);
 assert.equal(rasterHint.isError,true);assert.equal(rasterHint.error,binary.error);assert.equal(rasterHint.content,binary.content);assert.equal(rasterHint.additionalContexts[0],prior);assert.equal(rasterHint.additionalContexts[1].source.kind,'gvs-tool-recovery');assert.match(rasterHint.additionalContexts[1].content[0].text,/read_image.*exact existing image path/);assert.match(rasterHint.additionalContexts[1].content[0].text,/does not satisfy any test or acceptance gate/);
 const success={isError:false,value:{kind:'foreground',exitCode:0},content:[]};assert.equal(await f.hooks['tools/execute'](exec,async()=>success),success);
 await f.call('gvs_pause',{});assert.equal(await f.hooks['tools/execute'](exec,async()=>error),error);
});

test('live UI acceptance exposes the paged responsive matrix and cannot pass from the old single-phone checks or coordinator attestations',async()=>{
 const f=fixture({responsiveTesting:true}),start=await f.call('gvs_run',{task:'Test responsive windows and visual collisions',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const created=await f.call('gvs_task',{action:'create',title:'User live layout review',instructions:'Exercise real windows and inspect pixels',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',readScopes:['src'],resources:[]});
 const status=await f.call('gvs_responsive',{action:'status',taskId:created.task.id,limit:2});assert.equal(status.cases.length,2);assert.ok(status.caseCount>=22);assert.equal(status.coverage.ready,false);assert.equal(status.nextOffset,2);
 await assert.rejects(f.call('gvs_responsive',{action:'review',taskId:created.task.id,checkId:'invented',verdict:'pass',findings:[]}),/OWN matrix/);
 await assert.rejects(f.complete(created.task.id,f.actor('user'),{observations:['No clipping seen in a single selected image.']}),/actual current images|Responsive acceptance is incomplete/);assert.equal(f.tasks.get(created.task.id).status,'in_progress');
});

test('ordinary browser capture cannot be reviewed as a matrix batch and the refusal explains the actual evidence route',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Inspect actual browser output without fabricated matrix proof',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const work=await f.call('gvs_task',{action:'create',title:'Actual User UI review',instructions:'Inspect current actual windows',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',resources:[]}),saved=JSON.parse([...f.files.values()][0]),browser={id:'actual-browser-check',taskId:work.task.id,capturedBy:'user',revision:saved.revision,ok:true,views:[{viewport:'mobile',layout:{captures:[{imageId:'actual-browser-pixels',stage:'initial'}]}}],images:[{viewport:'mobile',attachment:{attachmentId:'actual-browser-pixels'}}]};saved.visualChecks=[browser];saved.responsiveChecks=[];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?browser-not-matrix=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:true,projectInspection:false});await f.call('gvs_recover');const actor=f.actor('user');
 await assert.rejects(f.call('gvs_responsive',{action:'review',taskId:work.task.id,checkId:browser.id,verdict:'revise',findings:['Actual footer collision']},actor),/gvs_browser_check, not a responsive-matrix.*gvs_visual action:states/);
 await assert.rejects(f.call('gvs_responsive',{action:'review',taskId:work.task.id,checkId:browser.id,verdict:'pass',findings:[]},actor),/cannot supply matrix coverage/);
 const read=await f.call('gvs_visual',{action:'states',taskId:work.task.id},actor);assert.ok(JSON.stringify(read).includes('actual-browser-pixels'),'Original pixels remain available through the specified readonly tool');
 const after=JSON.parse([...f.files.values()][0]);assert.deepEqual(after.visualChecks,[browser]);assert.deepEqual(after.responsiveChecks,[]);assert.equal(after.tasks.find(t=>t.id===work.task.id).state,'running');assert.equal(after.goal.issues.length,0,'A refused mismatched API is not a saved product finding or pass');
});

test('responsive capture/inspection of an owned non-running task returns truthful refusal before probing engines and preserves evidence and pause',async()=>{
 for(const state of ['waiting','blocked','done']){
  const f=fixture(),start=await f.call('gvs_run',{task:'Preserve existing stopped review',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
  const work=await f.call('gvs_task',{action:'create',title:'Existing User task',instructions:'Inspect real UI',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',resources:[]}),saved=JSON.parse([...f.files.values()][0]),task=saved.tasks.find(t=>t.id===work.task.id);task.state=state;task.result={verdict:'revise',summary:'Existing observed footer collision',findings:['Existing collision']};saved.responsiveChecks=[{id:'actual-saved-check',taskId:task.id,capturedBy:'user',revision:saved.revision,ok:false,views:[],images:[]}];saved.diagnostics=[];
  for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?inactive-responsive=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:true,projectInspection:false,browserModule:'unavailable-module-must-not-be-probed'});const actor=f.actor('user'),before=JSON.parse([...f.files.values()][0]);
  for(const action of ['check','review']){const result=await f.call('gvs_responsive',{action,taskId:task.id,checkId:'actual-saved-check',verdict:'pass',caseIds:['invented']},actor);assert.equal(result.status,'not-running');assert.equal(result.accepted,false);assert.equal(result.executed,false);assert.equal(result.reviewed,false);assert.equal(result.taskState,state);assert.match(result.next,/let Lead schedule/);}
  assert.deepEqual(JSON.parse([...f.files.values()][0]),before,'No capture, inspection, diagnostic resolution, prior-result mutation, engine probe or resume');
  await assert.rejects(f.call('gvs_responsive',{action:'review',taskId:task.id,checkId:'actual-saved-check',verdict:'pass'}),/OWN matrix/,'Lead cannot gain authority via the non-running response');
  if(state==='blocked'){await f.call('gvs_pause');const paused=JSON.parse([...f.files.values()][0]);await assert.rejects(f.call('gvs_responsive',{action:'check',taskId:task.id,caseIds:['invented']},actor),/paused/);assert.deepEqual(JSON.parse([...f.files.values()][0]),paused);}
 }
});

test('coordinator can inspect teammate responsive failure images without acquiring the right to accept their evidence',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Inspect responsive feedback',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const work=await f.call('gvs_task',{action:'create',title:'Actual User review',instructions:'Observe actual pixels',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',resources:[]});
 const saved=JSON.parse([...f.files.values()][0]);saved.responsiveChecks=[{id:'responsive-peer',taskId:work.task.id,caseId:'chromium-phone-wide',capturedBy:'user',revision:saved.revision,ok:false,views:[{viewport:'mobile',errors:['Visible brand is covered']}],images:[{viewport:'mobile',attachment:{attachmentId:'actual-peer-frame'}}]}];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?responsive-read=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:true,projectInspection:false});
 const read=await f.call('gvs_responsive',{action:'states',taskId:work.task.id,checkId:'responsive-peer'});assert.equal(read.readOnly,true);assert.equal(read.images[0].attachment.attachmentId,'actual-peer-frame');assert.equal(read.capturedBy,'user');
 await assert.rejects(f.call('gvs_responsive',{action:'review',taskId:work.task.id,checkId:'responsive-peer',verdict:'pass',findings:[]}),/OWN matrix/);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
});

test('responsive assessment defects omitted from findings are recorded and delivered to Lead, without making a pass or deleting previous issues',async()=>{
 const f=fixture({browserModule:fileURLToPath(new URL('./fixtures/no-browser.mjs',import.meta.url))}),start=await f.call('gvs_run',{task:'Verify real pixel feedback delivery',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const work=await f.call('gvs_task',{action:'create',title:'Actual User review',instructions:'Inspect pixels',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',resources:[]}),saved=JSON.parse([...f.files.values()][0]),image='actual-own-overlap',check={id:'responsive-own',taskId:work.task.id,caseId:'chromium-phone-standard',capturedBy:'user',revision:saved.revision,ok:false,views:[{viewport:'mobile',errors:[],layout:{warnings:[{id:'age-overlap',kind:'overlap',images:[image]}],captures:[{imageId:image,stage:'initial'}]}}],images:[{viewport:'mobile',attachment:{attachmentId:image}}]};saved.responsiveChecks=[check];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?assessment-feedback=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false,browserModule:fileURLToPath(new URL('./fixtures/no-browser.mjs',import.meta.url))});await f.call('gvs_recover');
 const input={action:'review',taskId:work.task.id,checkId:check.id,verdict:'revise',findings:[],images:[image],visualReview:{checked:[],assessments:[{warningId:'age-overlap',imageId:image,disposition:'defect',reason:'The actual agreement link overlaps the preceding age confirmation text.'}]}};
 const result=await f.call('gvs_responsive',input,f.actor('user'));assert.equal(result.issueIds.length,1);assert.match(result.inspection.findings[0],/agreement link overlaps/);assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('agreement link overlaps')));
 const again=await f.call('gvs_responsive',input,f.actor('user'));assert.equal(again.issueIds.length,0);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);
 const pass=await f.complete(work.task.id,f.actor('user'),{images:input.images,visualReview:input.visualReview});assert.equal(pass.accepted,false);assert.equal(pass.completed,false);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);
 const completed=await f.complete(work.task.id,f.actor('user'),{verdict:'revise',images:input.images,visualReview:input.visualReview});assert.match(completed.task.result.findings[0],/agreement link overlaps/);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);
 const old=JSON.parse([...f.files.values()][0]);old.goal.issues=[];const historical=structuredClone(old.responsiveChecks[0].inspection),oldResult=structuredClone(old.tasks.find(t=>t.id===work.task.id).result);old.responsiveChecks[0].inspection.findings=[];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(old));const upgrade=await import(`../v3/runtime.js?assessment-upgrade=${randomUUID()}`);upgrade.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false});await f.call('gvs_recover');
 const upgraded=JSON.parse([...f.files.values()][0]);assert.equal(upgraded.goal.issues.length,1);assert.match(upgraded.goal.issues[0].criterion,/agreement link overlaps/);assert.deepEqual(upgraded.tasks.find(t=>t.id===work.task.id).result,oldResult);assert.deepEqual(upgraded.responsiveChecks[0].inspection,{...historical,findings:[]});assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('GVS RECOVERED VISUAL FEEDBACK')));
 await f.call('gvs_recover');assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(old));const delivery=await import(`../v3/runtime.js?assessment-delivery=${randomUUID()}`);delivery.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false});const send=f.ctx.agentTeams.sendMessage;let fail=true;f.ctx.agentTeams.sendMessage=async(agent,request)=>{if(fail&&request.content[0].text.includes('GVS RECOVERED VISUAL FEEDBACK')){fail=false;throw new Error('Temporary transport failure');}return send(agent,request);};
 await f.call('gvs_recover');const pending=JSON.parse([...f.files.values()][0]);assert.equal(pending.visualFeedbackPending.length,1);assert.equal(pending.goal.issues.length,1);assert.equal(pending.status,'running');await f.call('gvs_recover');assert.equal(JSON.parse([...f.files.values()][0]).visualFeedbackPending,undefined);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);
});

test('own failed responsive frames remain discoverable and negative feedback survives parallel source revision drift without granting current acceptance',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Keep actual UI feedback during parallel changes',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));const work=await f.call('gvs_task',{action:'create',title:'UI exploration',instructions:'Exercise and inspect actual windows',kind:'user-review',scope:'increment',analysisIds:[],assignee:'user',resources:[]}),saved=JSON.parse([...f.files.values()][0]),check={id:'actual-old-responsive',taskId:work.task.id,caseId:'chromium-phone-small',capturedBy:'user',revision:saved.revision,ok:false,views:[{viewport:'mobile',errors:['Observed target not reached']}],images:[{viewport:'mobile',attachment:{attachmentId:'actual-failed-pixels'}}]};saved.responsiveChecks=[check];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?negative-drift=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false,browserModule:fileURLToPath(new URL('./fixtures/no-browser.mjs',import.meta.url))});await f.call('gvs_recover');f.changeSource('Actual source revision advanced during the independent capture');const actor=f.actor('user');
 const index=await f.call('gvs_responsive',{action:'states',taskId:work.task.id},actor);assert.equal(index.readOnly,true);assert.equal(index.checks[0].checkId,check.id);assert.equal(index.checks[0].current,false);const frames=await f.call('gvs_responsive',{action:'states',taskId:work.task.id,checkId:check.id},actor);assert.equal(frames.images[0].attachment.attachmentId,'actual-failed-pixels');assert.equal(frames.current,false);
 const input={action:'review',taskId:work.task.id,checkId:check.id,verdict:'revise',findings:['Actual captured footer touches the dialog edge; independently verify current spacing and hit targets.'],images:['actual-failed-pixels']};const result=await f.call('gvs_responsive',input,actor);assert.equal(result.acceptedCurrent,false);assert.equal(result.inspection.acceptanceEvidence,false);assert.equal(result.inspection.revision,check.revision);assert.equal(result.issueIds.length,1);assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('"historical":true')&&m.content[0].text.includes('captured footer')));
 f.changeSource('Another unrelated source revision');const again=await f.call('gvs_responsive',input,actor);assert.equal(again.issueIds.length,0);assert.equal(JSON.parse([...f.files.values()][0]).goal.issues.length,1);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 await assert.rejects(f.call('gvs_responsive',{...input,verdict:'pass',findings:[]},actor),/stale responsive capture cannot pass/);assert.equal((await f.call('gvs_finish')).status,'needs-review');
});

test('a source-only review can attest actual historical reports without claiming current evidence or weakening other review kinds',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Review frozen evidence while implementation continues',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'qa',title:'Independent source reviewer',purpose:'Inspect actual recorded evidence',capability:'verify'});
 const task=await f.call('gvs_task',{action:'create',title:'Static frozen report attestation',instructions:'Read source and exact saved report, not execute a writing analyzer',kind:'review',scope:'increment',reviewFocus:'source',analysisIds:[],assignee:'qa',readScopes:['artifacts'],resources:[]}),saved=JSON.parse([...f.files.values()][0]);saved.analysisChecks=[{id:'actual-old-report',ok:true,revision:saved.revision-1,planVersion:saved.analysis.version,capturedBy:'capture-agent',taskId:'capture-task',results:[{id:'regression',cases:[{name:'Actual recorded service check',source:'runtime',passed:true,actual:1,expected:1}]}]}];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const fresh=await import(`../v3/runtime.js?historical-reports=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false});await f.call('gvs_recover');const qa=f.actor('qa');await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},qa);
 const command='Get-FileHash artifacts/frozen.bin';f.hooks['tools/result']({agent:qa,name:'pwsh',arguments:{command}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'actual hash'}},content:[]});
 await assert.rejects(f.complete(task.task.id,qa,{analysisReports:['actual-old-report'],adapterReviewed:true,checks:[command]}),/stale-source-revision/);
 const status=await f.call('gvs_analysis',{action:'status'},qa);assert.deepEqual(status.reports[0].reviewStatus.reasons,['stale-source-revision']);
 await assert.rejects(f.complete(task.task.id,qa,{historicalAnalysisReports:['actual-old-report'],adapterReviewed:false,checks:[command]}),/source-only review increment/);
 await assert.rejects(f.complete(task.task.id,qa,{historicalAnalysisReports:['invented'],adapterReviewed:true,checks:[command]}),/unknown-report/);
 const done=await f.complete(task.task.id,qa,{historicalAnalysisReports:['actual-old-report'],adapterReviewed:true,checks:[command]});assert.equal(done.task.result.verdict,'pass');assert.deepEqual(done.task.result.analysisReports,[]);assert.deepEqual(done.task.result.historicalAnalysisReports,['actual-old-report']);assert.equal(done.task.result.historicalReportAttestations[0].acceptanceEvidence,false);assert.equal(done.task.result.historicalReportAttestations[0].reportRevision,saved.revision-1);assert.deepEqual(JSON.parse([...f.files.values()][0]).analysisChecks,saved.analysisChecks);assert.ok(f.sent.some(m=>m.target==='lead'&&m.content[0].text.includes('historicalReportAttestations')));assert.equal((await f.call('gvs_finish')).status,'needs-review');
 const other=await f.call('gvs_task',{action:'create',title:'Actual visual review',instructions:'Requires current images',kind:'review',scope:'increment',analysisIds:[],assignee:'qa',resources:[]});await assert.rejects(f.complete(other.task.id,qa,{historicalAnalysisReports:['actual-old-report'],adapterReviewed:true,checks:[command]}),/source-only review increment/);
});

test('coordinator plans gate editing, source drift stops dispatch, and completion requires actual changed code with fresh exact checks',async()=>{
 const f=fixture({requireCoordinatorPlan:true}),start=await f.call('gvs_run',{task:'Implement actual source changes',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement the plan',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Precise patch',instructions:'Actual implementation',kind:'work',assignee:'developer',writeScopes:['app.js'],readScopes:['app.js'],resources:[]});
 assert.equal(work.status,'needs-coordinator-plan');assert.equal(work.task.state,'waiting');assert.equal((await f.call('gvs_parallel',{action:'status'})).parallel.waiting[0].reason.kind,'coordinator-plan');
 const plan={summary:'Correct actual source',changes:[{path:'app.js',anchor:'initial source',edit:'Replace initial source with the required implemented behavior.'}],checks:['node check.mjs'],acceptance:['Required behavior works in the actual app.']};
 const updated=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan});assert.equal(updated.task.state,'running');assert.equal(updated.task.codePlan.authoredBy,f.root.id);
 const agent=f.actor('developer'),count=f.sent.length;const proposal=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan},agent);assert.equal(proposal.status,'forwarded-to-coordinator');assert.equal(proposal.applied,false);assert.equal(f.sent.length,count+1);const duplicate=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan},agent);assert.equal(duplicate.duplicate,true);assert.equal(f.sent.length,count+1);
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
 const recovery=await f.call('gvs_task',{action:'update',taskId:work.task.id,codePlan:plan});assert.equal(recovery.status,'needs-current-source');assert.equal(recovery.accepted,false);assert.equal(recovery.updated,false);assert.equal(recovery.recovery.path,'app.js');assert.equal(recovery.recovery.nextRead.tool,'read');assert.equal((await f.call('gvs_task',{action:'list',taskId:work.task.id})).tasks[0].state,'waiting');
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

test('explicit decision reuse is honored with status and never creates an approval-of-approval task',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Preserve actual goal and implement',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Implement',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Bounded source work',instructions:'Implement exact existing requirements',kind:'work',assignee:'editor'}),agent=f.actor('editor'),count=f.tasks.size;
 const listed=await f.call('gvs_ask_user',{action:'status'},agent);assert.equal(listed.total,1);assert.deepEqual(JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===work.task.id).consultations,[]);
 const reused=await f.call('gvs_ask_user',{action:'status',reuseTaskId:start.briefTaskId},agent);assert.equal(reused.reused,true);assert.equal(reused.userTaskId,start.briefTaskId);assert.equal(f.tasks.size,count);assert.deepEqual(JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===work.task.id).consultations,[start.briefTaskId]);
 await f.complete(work.task.id,agent);assert.equal(f.tasks.get(work.task.id).status,'completed');await assert.rejects(f.call('gvs_ask_user',{action:'status',reuseTaskId:'invented'},agent),/No assigned running task/);
});

test('User can read decisions and self-consultation returns direction without permissions, extra tasks or fabricated consultation',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Inspect the real goal',kind:'code'}),user=f.actor('user'),count=f.tasks.size,before=JSON.parse([...f.files.values()][0]);
 const status=await f.call('gvs_ask_user',{action:'status'},user);assert.equal(status.total,0);const result=await f.call('gvs_ask_user',{action:'ask',question:'May I approve my own goal?'},user);assert.equal(result.status,'self-advocate');assert.equal(result.accepted,false);assert.equal(result.consulted,false);assert.equal(f.tasks.size,count);const after=JSON.parse([...f.files.values()][0]);assert.deepEqual(after.goal,before.goal);assert.equal(after.tasks.find(t=>t.id===start.briefTaskId).state,'running');
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
 const early=await f.call('gvs_task',{action:'complete',taskId:review.task.id,verdict:'pass',summary:'False',findings:[]},f.actor('reviewer'));assert.equal(early.accepted,false);assert.equal(early.completed,false);assert.equal(f.tasks.get(review.task.id).status,'pending');
 const originalId=f.actor('developer').id;await f.consult(f.actor('developer'));await f.complete(work.task.id,f.actor('developer'));
 assert.equal(f.sent.filter(message=>message.target==='reviewer').length,1);
 const correction=await f.call('gvs_task',{action:'complete',taskId:review.task.id,verdict:'pass',summary:'Checks',findings:['positive observation']},f.actor('reviewer'));assert.equal(correction.status,'needs-verdict-correction');assert.equal(correction.accepted,false);assert.deepEqual(correction.findings,['positive observation']);assert.equal(f.tasks.get(review.task.id).status,'in_progress');
 await f.consult(f.actor('reviewer'));
 f.hooks['tools/result']({agent:f.actor('reviewer'),name:'pwsh',arguments:{command:'node test.mjs'}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'passed'}},content:[]});
 await assert.rejects(f.complete(review.task.id,f.actor('reviewer'),{checks:['node test.mjs: passed']}),/ONLY verbatim/);
 await f.complete(review.task.id,f.actor('reviewer'),{checks:['node test.mjs'],simple:true,scopePreserved:true});
 const next=await f.call('gvs_task',{action:'create',title:'Second change',instructions:'New work, same role',kind:'work',assignee:'developer',dependsOn:[review.task.id]});
 assert.equal(next.task.state,'running');assert.equal(f.actor('developer').id,originalId);assert.equal(f.spawns,3);
});
test('wrong-tool edit/write arguments identify the real invocation error without inventing a lease conflict or dispatching another tool',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Capture a real owned rendered scenario',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 let mutations=0;for(const name of ['edit','write'])f.definitions.set(name,{execute:async()=>{mutations++;return {ok:true};}});
 for(const [name,capability] of [['capture','edit'],['verifier','verify']]){
  await f.call('gvs_agent',{action:'create',name,title:name,purpose:'Own bounded evidence',capability});const root='artifacts/'+name,work=await f.call('gvs_task',{action:'create',title:name,instructions:'Write and execute the actual owned adapter',kind:'work',assignee:name,readScopes:[],writeScopes:[root],resources:[]}),actor=f.actor(name),before=JSON.parse([...f.files.values()][0]);
  const cases=[{args:{taskId:work.task.id,index:0,timeoutMs:180000},hint:/use gvs_plan_check/},{args:{description:'Execute owned check',command:'node '+root+'/check.mjs',workdir:'.',timeoutMs:180000},hint:/use pwsh\/bash/},{args:{},hint:/actual tool schema/},{args:{file_path:' '},hint:/actual tool schema/},{args:{path:{bad:true}},hint:/actual tool schema/}];
  for(const tool of ['edit','write'])for(const item of cases){const exec={agent:actor,name:tool,arguments:item.args,signal:new AbortController().signal},pre=await f.hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}));assert.equal(pre.kind,'deny');assert.match(pre.reason,/no file_path\/path/);assert.match(pre.reason,item.hint);assert.doesNotMatch(pre.reason,/The file is outside/);assert.equal(f.nativeGuard(exec),pre.reason);await assert.rejects(f.call(tool,item.args,actor),item.hint);}
  assert.equal(mutations,capability==='edit'?0:1,'Invalid calls must not dispatch a mutation or a suggested replacement tool');
  const valid=await f.call('write',{file_path:root+'/check.mjs',content:'actual owned script'},actor);assert.equal(valid.ok,true);
  await assert.rejects(f.call('edit',{file_path:'src/foreign.js',old_string:'a',new_string:'b'},actor),capability==='edit'?/outside this task writeScopes/:/Product sources remain read-only/);
  const after=JSON.parse([...f.files.values()][0]);assert.equal(after.status,before.status);assert.equal(after.runId,before.runId);assert.deepEqual(after.tasks.find(t=>t.id===work.task.id).writeScopes,[root]);assert.equal(f.tasks.get(work.task.id).status,'in_progress');
 }
 assert.equal(mutations,2);
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
 const lateDeps=await f.call('gvs_task',{action:'dependencies',taskId:start.briefTaskId,dependsOn:[]});assert.equal(lateDeps.status,'already-completed');assert.equal(lateDeps.updated,false);const foreign=await f.call('gvs_task',{action:'complete',taskId:start.briefTaskId,verdict:'pass',summary:'Cannot attest for User',findings:[]});assert.equal(foreign.status,'not-owner');assert.equal(foreign.accepted,false);assert.equal(f.tasks.get(start.briefTaskId).status,'completed');
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
  const fresh=await import(`../v3/runtime.js?preview=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});
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
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const isolated=await import(`../v3/runtime.js?all-states=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});await f.call('gvs_recover');
 const actor=f.actor('qa'),seen=[];let offset=0;do{const page=await f.call('gvs_visual',{action:'states',taskId:work.task.id,offset,limit:6},actor);assert.equal(page.total,48);assert.equal(page.images.length,page.states.length);seen.push(...page.states.map(s=>s.imageId));offset=page.nextOffset;}while(offset!==null);
 assert.equal(new Set(seen).size,48);assert.ok(seen.includes('actual-0'));assert.deepEqual((await f.call('gvs_visual',{action:'states',imageId:'actual-0'},actor)).images,[images[0]]);
 await assert.rejects(f.call('gvs_visual',{action:'states',imageId:'guessed-hash'},actor),/copy its literal ID/);assert.equal(f.tasks.size,2);
});

test('a review stopped by the former complete-plan prerequisite resumes once and can save its first runnable scenario',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Explore UI incrementally',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 const work=await f.call('gvs_task',{action:'create',title:'Explore existing windows',instructions:'Test actual controls',kind:'user-review',assignee:'user',scope:'full',readScopes:[],writeScopes:[],resources:[]});const saved=JSON.parse([...f.files.values()][0]),task=saved.tasks.find(t=>t.id===work.task.id);
 task.state='blocked';task.result={verdict:'blocked',summary:'Agent turn ended (completed) without completing its assigned task.',findings:[]};saved.diagnostics=[{id:'legacy',agent:'user',taskId:task.id,tool:'gvs_user_testing',message:'Plan opening/closing/back/Escape/reopen for observed windows',status:'open',count:3,firstAt:1,lastAt:1}];
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));const isolated=await import(`../v3/runtime.js?partial-plan-recovery=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});const recovered=await f.call('gvs_recover');assert.deepEqual(recovered.recovered,[task.id]);assert.equal(f.tasks.get(task.id).status,'in_progress');assert.equal(f.spawns,1);
 const partial=await f.call('gvs_user_testing',{action:'plan',scenarios:[{id:'open',category:'primary',target:'Observed Settings button in the ordinary UI',expected:'Actual settings window opens and its controls are usable.'}]},f.actor('user'));assert.equal(partial.planned,true);assert.equal(partial.scenarios[0].id,'open');assert.deepEqual(partial.missingCategories,['dismiss','negative-or-recovery']);assert.equal(partial.scenarios[0].passed,false);
 assert.deepEqual((await f.call('gvs_recover')).recovered,[]);const state=JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===task.id);assert.equal(state.reviewPlanRecovery.version,2);assert.equal(state.lastFailure.verdict,'blocked');assert.equal(state.state,'running');
});

test('a runnable UI automatically queues the same User for exploration and coalesces later completed UI increments',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Continuously test current windows',kind:'ui'});await f.complete(start.briefTaskId,f.actor('user'));
 let saved=JSON.parse([...f.files.values()][0]);saved.preview={url:'http://localhost:5173/',jobId:'not-running',ready:false};for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 let isolated=await import(`../v3/runtime.js?user-probe=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});await f.call('gvs_recover');
 saved=JSON.parse([...f.files.values()][0]);const probe=saved.tasks.find(t=>t.autoUserProbe);assert.ok(probe);assert.equal(probe.assignee,'user');assert.equal(probe.state,'waiting');assert.equal(probe.kind,'user-review');assert.equal(f.spawns,1);assert.deepEqual(probe.resources,[]);
 await f.call('gvs_recover');assert.equal(f.tasks.size,2);
 saved.tasks.push({id:'new-ui-slice',kind:'work',assignee:'developer',state:'done',dependsOn:[],result:{verdict:'pass',summary:'Actual UI slice',findings:[]},codePlan:{version:2,sources:[],changes:[{path:'store-ui/Badge.tsx'}]}});for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 isolated=await import(`../v3/runtime.js?coalesce-probe=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});await f.call('gvs_recover');
 saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.tasks.filter(t=>t.autoUserProbe).length,1);assert.equal(saved.tasks.find(t=>t.autoUserProbe).id,probe.id);assert.deepEqual(saved.tasks.find(t=>t.autoUserProbe).userProbeFor,['new-ui-slice']);assert.equal(f.tasks.size,2);
 saved.tasks.push({id:'replanned-ui',kind:'work',assignee:'developer',state:'done',dependsOn:[],result:{verdict:'pass',summary:'Real UI changes, final plan only validates them',findings:[]},writtenFiles:['dialogs-ui/Panel.tsx'],codePlan:{version:2,sources:[],changes:[{path:'artifacts/replanned/check.js'}]}});for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 isolated=await import(`../v3/runtime.js?written-ui-probe=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});await f.call('gvs_recover');saved=JSON.parse([...f.files.values()][0]);const coalesced=saved.tasks.find(t=>t.autoUserProbe);assert.equal(coalesced.id,probe.id);assert.deepEqual(coalesced.userProbeFor,['new-ui-slice','replanned-ui']);assert.ok(coalesced.readScopes.includes('dialogs-ui'));assert.match(coalesced.instructions,/store-ui\/Badge.tsx/);assert.match(coalesced.instructions,/dialogs-ui\/Panel.tsx/);assert.equal(f.tasks.size,2);await f.call('gvs_recover');assert.equal(f.tasks.size,2);assert.equal(f.spawns,1);
 saved=JSON.parse([...f.files.values()][0]);saved.qaTarget={version:2,sourceConfirmed:true,surfaces:['web','cli'],sourceRoots:['store-ui','tools/echo'],components:[{root:'',sourceConfirmed:true,surfaces:['web']},{root:'tools/echo',sourceConfirmed:true,surfaces:['cli']}]};saved.tasks.push({id:'new-cli-slice',kind:'work',assignee:'developer',state:'done',dependsOn:[],result:{verdict:'pass',summary:'Actual command change',findings:[]},writtenFiles:['tools/echo/src/main.rs']});for(const key of f.files.keys())f.files.set(key,JSON.stringify(saved));
 isolated=await import(`../v3/runtime.js?command-coalesce=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});await f.call('gvs_recover');const merged=JSON.parse([...f.files.values()][0]).tasks.find(t=>t.autoUserProbe);assert.equal(merged.id,probe.id);assert.equal(merged.userProbeInitial,true);assert.ok(merged.userProbeFor.includes('new-cli-slice'));assert.ok(merged.resources.includes('product-interaction'));assert.match(merged.instructions,/COMMAND\/BOT PRODUCT TESTING/);assert.match(merged.instructions,/USER IS AN ACTIVE PRODUCT TESTER/);assert.equal(f.tasks.size,2);assert.equal(f.spawns,1);
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
 const queued=await f.complete(review.task.id,actor);assert.equal(queued.status,'not-running');assert.equal(queued.accepted,false);assert.equal(queued.completed,false);const foreign=await f.call('gvs_task',feedback,f.actor('developer'));assert.equal(foreign.status,'not-owner');assert.equal(foreign.completed,false);assert.equal(f.tasks.get(review.task.id).status,'pending');
});

test('a stale repeat cannot replace an already recorded revise with pass',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Keep actual results',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'developer',title:'Developer',purpose:'Implement',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Implement',instructions:'Implement',kind:'work',assignee:'developer'}),actor=f.actor('developer');
 await f.call('gvs_task',{action:'complete',taskId:work.task.id,verdict:'revise',summary:'Actual issue remains',findings:['Required repair']},actor);
 const repeat=await f.call('gvs_task',{action:'complete',taskId:work.task.id,verdict:'pass',summary:'Stale claimed success',findings:[]},actor);assert.equal(repeat.status,'already-completed');assert.equal(repeat.completed,false);assert.equal(repeat.previousVerdict,'revise');assert.deepEqual(repeat.findings,['Required repair']);
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
 const fresh=await import(`../v3/runtime.js?visual=${randomUUID()}`);fresh.apply(f.ctx,{requireCoordinatorPlan:false,responsiveTesting:false,projectInspection:false});
 const work=await f.call('gvs_task',{action:'create',title:'Focused visual review',instructions:'Review the current increment',assignee:'qa',kind:'review',scope:'increment',analysisIds:[]});
 await f.call('gvs_ask_user',{reuseTaskId:start.briefTaskId},f.actor('qa'));
 f.hooks['tools/result']({agent:f.actor('qa'),name:'pwsh',arguments:{command:'node actual-review.mjs'}},{isError:false,value:{kind:'foreground',exitCode:0,stdout:{text:'Observed'}},content:[]});
 await f.complete(work.task.id,f.actor('qa'),{checks:['node actual-review.mjs'],images:['desktop','mobile'],visualReview:{checked:VISUAL_CHECKS,assessments:[{warningId:warning.id,imageId:'mobile',disposition:'outside-scope',reason:'This separate dialog has a visible overlap and needs a specifically owned repair and independent recheck.'}]}});
 const goal=await f.call('gvs_goal',{action:'status'});assert.equal(goal.issues.length,1);assert.match(goal.issues[0].criterion,/visible overlap/);assert.equal(goal.ready,false);
 assert.equal((await f.call('gvs_task',{action:'list',taskId:work.task.id})).tasks[0].result.verdict,'pass');
});
test('a claimed read-only turn becomes a visible blocker after bounded normal continuations',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Task',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'helper',title:'Helper',purpose:'Read task',capability:'read'});
 const created=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect',kind:'work',assignee:'helper'});
 const actor=f.actor('helper');for(const turn of [1,2,3]){f.hooks['session/event']({id:actor.id},{type:'turn/start',data:{turn}});
 f.hooks['session/event']({id:actor.id},{type:'user/message',data:{content:[{type:'text',text:`TASK NONCE: ${created.task.nonce}`}]}});
 f.hooks['session/event']({id:actor.id},{type:'turn/end',data:{turn,reason:{kind:'completed'}}});for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));}
 const status=await f.call('gvs_task',{action:'list'});assert.equal(status.tasks.find(task=>task.id===created.task.id).state,'blocked');
});
test('restart preserves the active goal and resume reuses its original actor',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Recover',kind:'code'});const id=f.actor('user').id;
 const isolated=await import(`../v3/runtime.js?recovery=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});
 const status=await f.call('gvs_status');assert.equal(status.status,'running');assert.equal(status.gvsTeam.tasks.find(task=>task.id===start.briefTaskId).state,'blocked');
 await f.call('gvs_resume');assert.equal(f.actor('user').id,id);assert.equal(f.spawns,1);assert.equal(f.tasks.get(start.briefTaskId).status,'in_progress');
});
test('automatic recovery reuses interrupted assignments but never resumes a human pause or retries genuine blockers',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Automatic recovery',kind:'code'}),id=f.actor('user').id;
 const isolated=await import(`../v3/runtime.js?boot=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});
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
 const isolated=await import(`../v3/runtime.js?budget=${randomUUID()}`);isolated.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});
 const work=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect current source',kind:'work',assignee:'reviewer'});
 const sent=f.sent.filter(message=>message.target==='reviewer').at(-1);assert.ok(Buffer.byteLength(JSON.stringify(sent.content),'utf8')<120001);assert.match(sent.content[0].text,/COMPACT ASSIGNMENT/);assert.match(sent.content[0].text,new RegExp(work.task.id));
 const state=JSON.parse([...f.files.values()][0]),task=state.tasks.find(task=>task.id===work.task.id);task.state='blocked';task.result={verdict:'blocked',summary:'team message exceeds 131072 bytes',findings:[]};
 for(const key of f.files.keys())f.files.set(key,JSON.stringify(state));
 const reboot=await import(`../v3/runtime.js?retry=${randomUUID()}`);reboot.apply(f.ctx,{requireCoordinatorPlan:false,projectInspection:false,responsiveTesting:false});
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
async function incompleteTurnFixture(){
 const f=fixture(),start=await f.call('gvs_run',{task:'Finish the existing exact task',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Deliver actual work',capability:'edit'});const work=await f.call('gvs_task',{action:'create',title:'Actual slice',instructions:'Implement and report actual evidence',kind:'work',assignee:'editor',readScopes:['app.js'],writeScopes:['app.js'],resources:[]}),actor=f.actor('editor'),nonce=JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===work.task.id).nonce,session={id:actor.id};
 const startTurn=turn=>{f.hooks['session/event'](session,{type:'turn/start',data:{turn}});f.hooks['session/event'](session,{type:'user/message',data:{content:[{type:'text',text:'Assigned task nonce '+JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===work.task.id).nonce}]}});},endTurn=(turn,kind='completed')=>f.hooks['session/event'](session,{type:'turn/end',data:{turn,reason:{kind,...(kind==='error'?{error:{message:'Actual provider failure'}}:{})}}}),settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},continuations=()=>f.sent.filter(s=>s.content.some(c=>c.text?.startsWith('GVS TASK CONTINUATION ')));
 return {...f,start,work,actor,session,nonce,startTurn,endTurn,settle,continuations};
}

test('normal teammate stops receive at most two same-task continuations with nonce, preserved leases and no fabricated completion',async()=>{
 const f=await incompleteTurnFixture(),spawns=f.members.size;
 for(const turn of [11,12]){f.startTurn(turn);f.endTurn(turn);f.endTurn(turn);await f.settle();assert.equal(f.continuations().length,turn-10);const saved=JSON.parse([...f.files.values()][0]),task=saved.tasks.find(t=>t.id===f.work.task.id),notice=f.continuations().at(-1);assert.equal(task.state,'running');assert.equal(task.result,undefined);assert.deepEqual(task.writeScopes,['app.js']);assert.equal(f.tasks.get(task.id).status,'in_progress');assert.match(notice.content[0].text,new RegExp(f.nonce));assert.match(notice.content[0].text,new RegExp('EXACT taskId:"'+task.id+'"'));assert.equal(notice.target,'editor');assert.equal(notice.model,undefined);assert.equal(notice.thinking,undefined);}
 f.startTurn(13);f.endTurn(13);await f.settle();assert.equal(f.continuations().length,2);const blocked=JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===f.work.task.id);assert.equal(blocked.state,'blocked');assert.equal(blocked.result.verdict,'blocked');assert.equal(blocked.incompleteTurnRecoveries,2);assert.equal(f.members.size,spawns);
 await f.call('gvs_task',{action:'retry',taskId:f.work.task.id});f.startTurn(14);f.endTurn(14);await f.settle();assert.equal(f.continuations().length,3,'Only explicit coordinator retry grants a new bounded continuation budget');assert.equal(f.tasks.get(f.work.task.id).status,'in_progress');
});

test('real task reports and provider/cancellation/block/fork outcomes are never replaced by normal-stop continuation',async()=>{
 for(const kind of ['error','aborted','blocked','forked']){const f=await incompleteTurnFixture();f.startTurn(4);f.endTurn(4,kind);await f.settle();assert.equal(f.continuations().length,0);assert.equal(JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===f.work.task.id).state,'blocked');}
 const f=await incompleteTurnFixture();f.hooks['session/event'](f.session,{type:'turn/end',data:{reason:{kind:'completed'}}});await f.settle();assert.equal(f.continuations().length,0,'A stale/unattributed turn must not wake an assignment');f.startTurn(9);await f.call('gvs_task',{action:'complete',taskId:f.work.task.id,verdict:'revise',summary:'Actual checkpoint with required remaining fixes',findings:['Actual unresolved behavior']},f.actor);f.endTurn(9);await f.settle();assert.equal(f.continuations().length,0);assert.equal(JSON.parse([...f.files.values()][0]).tasks.find(t=>t.id===f.work.task.id).result.summary,'Actual checkpoint with required remaining fixes');
});

test('human pause while a normal-stop continuation is queued prevents wake and preserves the same paused task',async()=>{
 const f=await incompleteTurnFixture(),write=f.ctx.fs.writeText;let release;const gate=new Promise(resolve=>{release=resolve;});f.ctx.fs.writeText=async(...args)=>{await gate;return write(...args);};f.startTurn(5);f.endTurn(5);const pausing=f.call('gvs_pause');await Promise.resolve();release();await pausing;await f.settle();assert.equal(f.continuations().length,0);let saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.status,'paused');assert.equal(saved.tasks.find(t=>t.id===f.work.task.id).state,'blocked');await f.call('gvs_recover');saved=JSON.parse([...f.files.values()][0]);assert.equal(saved.status,'paused');assert.equal(f.continuations().length,0);
});

test('failed continuation delivery leaves the original task blocked with diagnostics instead of a phantom running worker',async()=>{
 const f=await incompleteTurnFixture();f.ctx.agentTeams.sendMessage=async()=>{throw new Error('Actual unavailable recipient');};f.startTurn(7);f.endTurn(7);await f.settle();const saved=JSON.parse([...f.files.values()][0]),task=saved.tasks.find(t=>t.id===f.work.task.id);assert.equal(task.state,'blocked');assert.match(task.result.summary,/continuation could not be delivered/);assert.ok(saved.diagnostics.some(d=>d.taskId===task.id&&d.tool==='agent-turn'));assert.equal(f.continuations().length,0);
 const g=await incompleteTurnFixture(),send=g.ctx.agentTeams.sendMessage;let rejectOld;g.ctx.agentTeams.sendMessage=async(...args)=>args[1].content.some(c=>c.text?.startsWith('GVS TASK CONTINUATION '))?new Promise((_,reject)=>{rejectOld=reject;}):send(...args);g.startTurn(8);g.endTurn(8);await g.settle();assert.equal(typeof rejectOld,'function');await g.call('gvs_pause');await g.call('gvs_resume');const freshNonce=JSON.parse([...g.files.values()][0]).tasks.find(t=>t.id===g.work.task.id).nonce;assert.notEqual(freshNonce,g.nonce);rejectOld(new Error('Late failure for pre-pause delivery'));await g.settle();const fresh=JSON.parse([...g.files.values()][0]);assert.equal(fresh.status,'running');assert.equal(fresh.tasks.find(t=>t.id===g.work.task.id).state,'running','A late old continuation failure cannot block a newly authorized resumed assignment');
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
test('an editor ships its slice without a User consultation once a command passes after its last edit; wider gaps become tracked follow-ups',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Build the chat feature',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Implement features',capability:'edit'});
 await f.call('gvs_agent',{action:'create',name:'qa',title:'QA',purpose:'Review the whole goal',capability:'verify'});
 const work=await f.call('gvs_task',{action:'create',title:'Chat panel',instructions:'Implement the chat panel',kind:'work',assignee:'editor',readScopes:['app.js'],writeScopes:['app.js'],resources:[]}),editor=f.actor('editor');
 const cwd=path.resolve('work/in-memory-fixture'),shell=process.platform==='win32'?'pwsh':'bash';
 const run=(command,exitCode)=>f.hooks['tools/result']({agent:editor,name:shell,callId:randomUUID(),arguments:{command}},{isError:false,value:{kind:'foreground',exitCode,stdout:{text:''},stderr:{text:''}}});
 f.hooks['tools/result']({agent:editor,name:'edit',arguments:{file_path:path.join(cwd,'app.js')}},{isError:false});
 await assert.rejects(f.complete(work.task.id,editor),/no successful command after it/);
 run('npm test',1);await assert.rejects(f.complete(work.task.id,editor),/no successful command after it/,'a failing command is not a green build');
 run('npm test',0);
 const done=await f.complete(work.task.id,editor,{followUps:['Chat history persistence is not implemented yet']});
 assert.equal(done.task.state,'done');assert.equal(done.task.result.verdict,'pass');assert.deepEqual(done.task.result.checks,['npm test']);assert.deepEqual(done.task.consultations,[]);
 const saved=JSON.parse([...f.files.values()][0]);assert.ok(saved.goal.issues.some(issue=>issue.taskId===work.task.id&&/history persistence/.test(issue.criterion)),'follow-up is a mandatory goal issue');
 assert.match(f.sent.at(-1).content[0].text,/"followUpCount":1/);
 const review=await f.call('gvs_task',{action:'create',title:'Full review',instructions:'Review the whole goal',kind:'review',assignee:'qa',readScopes:['app.js'],resources:[]});
 const refused=await f.complete(review.task.id,f.actor('qa'),{followUps:['Moderation is missing']});
 assert.equal(refused.status,'needs-verdict-correction','a full-scope review cannot pass while reporting missing goal work');assert.deepEqual(refused.findings,['Moderation is missing']);
});
test('the coordinator wait stays inside its tool timeout even after slow scheduling',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Wait budget',kind:'code'});let waited;
 f.ctx.agentTeams.waitForChange=async(_agent,ms)=>{waited=ms;return {timedOut:true};};
 await f.call('gvs_wait',{seconds:30});
 assert.ok(start.briefTaskId);assert.ok(waited<=f.definitions.get('gvs_wait').timeoutMs-10000,'wait leaves room for scheduling and the result view');assert.ok(waited>=1000);
});
test('bare task numbers, "coordinator" and wrong actions are understood or explained instead of failing obscurely',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Normalize references',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'editor',title:'Editor',purpose:'Implement',capability:'edit'});
 const work=await f.call('gvs_task',{action:'create',title:'Slice',instructions:'Do it',kind:'work',assignee:'editor',readScopes:['app.js'],writeScopes:['app.js'],resources:[]}),editor=f.actor('editor');
 const bare=work.task.id.replace('task-','');
 const listed=await f.call('gvs_task',{action:'list',taskId:bare},editor);assert.equal(listed.tasks[0].id,work.task.id,'"313" means task-313');
 const sent=await f.call('gvs_agent',{action:'message',name:'coordinator',message:'Slice is ready'},editor);assert.notEqual(sent.accepted,false);assert.equal(f.sent.at(-1).target,'lead');
 await assert.rejects(f.call('gvs_task',{action:'message',taskId:work.task.id,message:'hi'},editor),/Unknown gvs_task action "message".*gvs_agent action:message/);
 await assert.rejects(f.complete(work.task.id,editor,{coveredRequirements:['invented-req']}),/Unknown: .*invented-req/);
});
test('a refused handoff names the actual unfinished tasks instead of a generic refusal',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Handoff naming',kind:'code'});
 await assert.rejects(f.call('gvs_goal',{action:'handoff',dependency:'unavailable-service',reason:'Service is down',evidence:'HTTP 503'}),new RegExp(`${start.briefTaskId} running`));
});
test('state writes survive a transient Windows replace failure but still surface real write errors',async()=>{
 const f=fixture(),write=f.ctx.fs.writeText;let failures=2;
 f.ctx.fs.writeText=async(...args)=>{if(failures-->0)throw Object.assign(new Error('ReplaceFileW EIO (Win32 1175): state.json'),{code:'EIO'});return write(...args);};
 const start=await f.call('gvs_run',{task:'Transient write',kind:'code'});assert.ok(start.briefTaskId);assert.ok([...f.files.values()].some(value=>JSON.parse(value).runId));
 f.ctx.fs.writeText=async()=>{throw Object.assign(new Error('no space left on device'),{code:'ENOSPC'});};
 await assert.rejects(f.call('gvs_pause'),/no space left/);
});
