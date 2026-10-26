import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {apply} from '../v3/runtime.js';
function fixture(){
 const files=new Map(),members=new Map(),tasks=new Map(),sent=[];let serial=0,spawns=0;
 const root={id:`mock-${randomUUID()}`,session:{header:{}},ctx:{}};const hooks={},definitions=new Map();let guard;
 const team={membership(agent){return {root,name:agent===root?'lead':members.get(agent.id).name,role:agent===root?'lead':'teammate'};},tryMembership(agent){return team.membership(agent);},
  async spawnTeammate(_root,request){spawns++;const member={id:`member-${randomUUID()}`,name:request.name};members.set(member.id,member);return {member};},
  async createTask(_root,request){const task={id:`task-${++serial}`,revision:1,status:'pending',blockedBy:request.blockedBy??[],subject:request.subject};tasks.set(task.id,task);return {...task};},
  getTask(_root,id){return {...tasks.get(id)};},async updateTask(_root,request){const task=tasks.get(request.taskId);assert.equal(request.expectedRevision,task.revision);
   if(request.action==='reassign'){assert.ok(task.blockedBy.every(id=>tasks.get(id).status==='completed'));task.status='in_progress';task.ownerName=request.owner;}
   if(request.action==='complete')task.status='completed';if(['reopen','release'].includes(request.action))task.status='pending';if(request.action==='set_dependencies')task.blockedBy=request.blockedBy;task.revision++;return {...task};},
  async sendMessage(_agent,request){sent.push(request);return {messageId:randomUUID()};},async waitForChange(){return {timedOut:false};},interrupt(){return {previousStatus:'inactive'};}};
 const ctx={agentTeams:team,on:(name,fn)=>{hooks[name]=fn;},effect(){},jobs:{attachController:()=>()=>{}},tools:{register:definition=>definitions.set(definition.name,definition),guard:fn=>{guard=fn;}},
  workingDirectory:{ensure:async()=>path.resolve('work/in-memory-fixture')},sandboxPolicy:{resolve:()=>({mode:'workspace-write'})},
  fs:{resolve:async file=>({file}),readText:async target=>{if(!files.has(target.file))throw Object.assign(new Error('missing'),{code:'ENOENT'});return files.get(target.file);},writeText:async(target,value)=>{files.set(target.file,value);}}};
 apply(ctx);
 const actor=name=>{const member=[...members.values()].find(member=>member.name===name);return {id:member.id,session:{header:{parentSession:root.id}},ctx:{}};};
 async function call(name,args={},agent=root){const exec={agent,name,arguments:args,signal:new AbortController().signal};await hooks['tools/pre-execute'](exec,async()=>({kind:'allow'}));const denied=guard(exec);if(denied)throw new Error(denied);return definitions.get(name).execute(args,exec);}
 const complete=(id,agent,extra={})=>call('gvs_task',{action:'complete',taskId:id,verdict:'pass',summary:'Observed result',findings:[],...extra},agent);
 async function consult(agent){const pending=call('gvs_ask_user',{question:'Confirm the exact goal'},agent);await new Promise(resolve=>setImmediate(resolve));let list=await call('gvs_task',{action:'list'});const question=list.tasks.find(task=>task.kind==='consultation'&&task.state==='running');assert.ok(question);await complete(question.id,actor('user'));await pending;}
 return {root,ctx,hooks,definitions,files,members,tasks,sent,call,actor,complete,consult,get spawns(){return spawns;}};
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
test('a claimed agent turn ending without completion becomes a visible blocker',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Task',kind:'code'});await f.complete(start.briefTaskId,f.actor('user'));
 await f.call('gvs_agent',{action:'create',name:'helper',title:'Helper',purpose:'Read task',capability:'read'});
 const created=await f.call('gvs_task',{action:'create',title:'Inspect',instructions:'Inspect',kind:'work',assignee:'helper'});
 const actor=f.actor('helper');f.hooks['session/event']({id:actor.id},{type:'turn/start',data:{turn:1}});
 f.hooks['session/event']({id:actor.id},{type:'user/message',data:{content:[{type:'text',text:`TASK NONCE: ${created.task.nonce}`}]}});
 f.hooks['session/event']({id:actor.id},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 const status=await f.call('gvs_task',{action:'list'});assert.equal(status.tasks.find(task=>task.id===created.task.id).state,'blocked');
});
test('restart pauses interrupted work and resume reuses its original actor',async()=>{
 const f=fixture(),start=await f.call('gvs_run',{task:'Recover',kind:'code'});const id=f.actor('user').id;
 const isolated=await import(`../v3/runtime.js?recovery=${randomUUID()}`);isolated.apply(f.ctx);
 const status=await f.call('gvs_status');assert.equal(status.status,'paused');assert.equal(status.gvsTeam.tasks.find(task=>task.id===start.briefTaskId).state,'blocked');
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
