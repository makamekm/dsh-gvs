import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,isStatusQuestion,statusSnapshot,retryableStop} from '../v3/coordinator.js';
const human=(text,id='human-status')=>({id,role:'user',source:{kind:'user',rpcId:id},content:[{type:'text',text}]});
function fixture(config={}){
 const hooks={},sent=[],mutations=[];
 const queued=[],steering=[];
 const agent={id:'main',status:'running',session:{header:{agentPreset:'gvs-local'},events:[]},inbox:{nextTurn:queued,nextStep:steering,remove(id){mutations.push(id);queued.splice(queued.findIndex(item=>item.id===id),1);}},steer(message){sent.push(message);steering.push(message);hooks['agent/inbox/inserted']({agent,message});}};
 const saved={schema:3,sessionId:'main',runId:'existing-run',task:'Finish game',kind:'code',status:'running',revision:0,quality:{},analysis:null,roles:[{name:'developer',title:'Developer',sessionId:'child',purpose:'Implement'}],tasks:[{id:'1',title:'Fix movement',assignee:'developer',state:'running',dependsOn:[],kind:'work'},{id:'2',title:'Review movement',assignee:'developer',state:'waiting',dependsOn:['1'],kind:'review'}]};
 const projections=new Map();
 const ctx={on:(name,hook)=>hooks[name]=hook,effect(){},workingDirectory:{ensure:async()=>'/project'},fs:{resolve:async file=>file,readText:async()=>JSON.stringify(saved)},sessionProjections:{register:unit=>projections.set(unit.key,unit),stateOf:(_session,key)=>key==='gvsActivity'?projections.get(key).apply(null,{type:'tool/call',time:123,data:{name:'read',arguments:{file:'game.gd'}}}):undefined},
  agentTeams:{listMembers:()=>[{id:'child',name:'developer',status:'inactive',diagnostics:['Task has no active turn']}],listTasks:()=>[{id:'1',status:'in_progress'}]},
  agents:{get:id=>id==='main'?agent:{session:{}}}};
 apply(ctx,config);return {agent,hooks,sent,queued,steering,mutations,ctx,saved,projections};
}
test('status intent recognizes direct human questions, without hijacking task changes or teammate messages',()=>{
 for(const text of ['какой статус?','Какой сейчас статус?','что сейчас делают агенты?','Статус','ну что там?','How is it going?'])assert.equal(isStatusQuestion(human(text)),true,text);
 for(const text of ['Проверь статус заказа','какой статус? и затем измени код','Сделай кнопку «статус»','После анализа напиши статус','Потом скомпилируй Windows версию'])assert.equal(isStatusQuestion(human(text)),false,text);
 assert.equal(isStatusQuestion({...human('какой статус?'),source:{kind:'agent-team'}}),false);
 assert.equal(isStatusQuestion({...human('какой статус?'),content:[{type:'text',text:'какой статус?'},{type:'image'}]}),false);
});
test('a queued status question moves to the next step once, retaining the exact message identity',()=>{
 const f=fixture(),message=human('какой статус?');f.queued.push(message);
 f.hooks['agent/inbox/inserted']({agent:f.agent,message});
 assert.equal(f.queued.length,0);assert.equal(f.sent.length,1);assert.equal(f.sent[0],message);
 f.agent.session.header.origin='subagent';const child=human('статус','child');f.queued.push(child);
 f.hooks['agent/inbox/inserted']({agent:f.agent,message:child});assert.equal(f.queued.length,1);
});
test('the next step includes an up-to-date honest snapshot and preserves upstream decision fields',async()=>{
 const f=fixture();const result=await f.hooks['agent/pre-step']({agent:f.agent,signal:AbortSignal.timeout(1000)},async()=>({kind:'enter',messages:[human('какой статус?')],startsRequestSeries:true}));
 assert.equal(result.startsRequestSeries,true);assert.equal(result.messages.length,2);
 assert.equal(result.messages[1].source.kind,'gvs-coordinator-status');
 assert.match(result.messages[1].content[0].text,/existing-run/);assert.match(result.messages[1].content[0].text,/"runtime":"inactive"/);
 assert.match(result.messages[1].content[0].text,/"lastActivity":"read:/);
 assert.equal(f.mutations.length,0);assert.equal(f.sent.length,0);
 const denied=await f.hooks['tools/pre-execute']({agent:f.agent,name:'gvs_wait'},async()=>({kind:'allow'}));assert.equal(denied.kind,'deny');
 f.hooks['session/event']({id:'main'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'Developer currently has no active turn; review waits on movement.'}]}} });
 assert.equal((await f.hooks['tools/pre-execute']({agent:f.agent,name:'gvs_wait'},async()=>({kind:'allow'}))).kind,'allow');
 assert.equal(f.saved.status,'running');
});
test('a human status question settles only the wait and preserves the turn signal and running work',async()=>{
 const f=fixture(),original=new AbortController(),exec={agent:f.agent,name:'gvs_wait',signal:original.signal};let settled=false;
 const waiting=f.hooks['tools/execute'](exec,()=>new Promise(resolve=>{
  exec.signal.addEventListener('abort',()=>{settled=true;resolve({isError:true,content:[],error:{message:'wait aborted'}});},{once:true});
 }));
 f.hooks['agent/inbox/inserted']({agent:f.agent,message:human('какой статус?')});
 const result=await waiting;
 assert.equal(settled,true);assert.equal(result.isError,false);assert.equal(result.value.status,'human-status-request');
 assert.equal(original.signal.aborted,false);assert.equal(exec.signal,original.signal);assert.equal(f.saved.status,'running');
});
test('ordinary steering, native cancellation, and rejected pre-steps preserve their semantics',async()=>{
 const f=fixture();const message=human('Потом собери Windows версию');f.queued.push(message);f.hooks['agent/inbox/inserted']({agent:f.agent,message});assert.equal(f.sent.length,0);
 const reject={kind:'reject'};assert.equal(await f.hooks['agent/pre-step']({agent:f.agent},async()=>reject),reject);
 const original=new AbortController(),failure={isError:true,content:[],error:{message:'user canceled'}};
 const exec={agent:f.agent,name:'gvs_wait',signal:original.signal};
 const result=await f.hooks['tools/execute'](exec,async()=>{original.abort();return failure;});assert.equal(result,failure);assert.equal(exec.signal,original.signal);
 const snapshot=await statusSnapshot(f.ctx,f.agent);assert.equal(snapshot.progress.running,1);assert.equal(snapshot.roles[0].runtime,'inactive');assert.equal(snapshot.next.length,1);
});
test('a text-only status answer resumes unfinished coordination once, without resuming a paused run',async()=>{
 const f=fixture(),followups=[];f.agent.followup=message=>followups.push(message);
 await f.hooks['agent/pre-step']({agent:f.agent,signal:AbortSignal.timeout(1000)},async()=>({kind:'enter',messages:[human('статус')]}));
 f.hooks['session/event']({id:'main'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'Agent is inactive; task is assigned.'}]}} });
 const ended={type:'turn/end',data:{reason:{kind:'completed'}}};f.hooks['session/event']({id:'main'},ended);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);assert.equal(followups[0].source.kind,'gvs-coordinator-continuation');
 f.hooks['session/event']({id:'main'},ended);await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);
 f.saved.status='paused';await f.hooks['agent/pre-step']({agent:f.agent,signal:AbortSignal.timeout(1000)},async()=>({kind:'enter',messages:[human('статус','again')]}));
 f.hooks['session/event']({id:'main'},{type:'assistant/message',data:{message:{content:[{type:'text',text:'Paused.'}]}} });f.hooks['session/event']({id:'main'},ended);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);
});

test('ordinary premature completion continues even when all existing tasks are done, but honors handoff, verification and cancellation',async()=>{
 const f=fixture(),followups=[];f.agent.followup=message=>followups.push(message);
 f.saved.tasks.forEach(task=>task.state='done');
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);assert.match(followups[0].content[0].text,/COMPLETE HUMAN GOAL/);
 f.saved.goal={messages:[],requirements:[],issues:[],assessed:[],handoff:{dependency:'missing-source',reason:'Private server contract unavailable'}};
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:2,reason:{kind:'completed'}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);
 f.saved.status='verified';f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:3,reason:{kind:'completed'}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);
 f.saved.status='running';delete f.saved.goal;
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:4,reason:{kind:'cancelled'}}});await new Promise(resolve=>setImmediate(resolve));assert.equal(followups.length,1);
});

test('transient provider failures retry with delay while credential errors and human cancellation do not',async()=>{
 assert.equal(retryableStop({kind:'error',error:{code:'PI_AI_ERROR',message:'Our servers are currently overloaded. Please try again later.'}}),true);
 assert.equal(retryableStop({kind:'max-tokens'}),true);assert.equal(retryableStop({kind:'error',error:{code:'AUTH_ERROR',message:'Invalid API key'}}),false);
 assert.equal(retryableStop({kind:'aborted',reason:{kind:'user'}}),false);
 const f=fixture({retryBaseMs:10,retryMaxMs:20}),followups=[];f.agent.followup=message=>followups.push(message);
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:1,reason:{kind:'error',error:{message:'503 overloaded'}}}});
 assert.equal(followups.length,0);await new Promise(resolve=>setTimeout(resolve,35));assert.equal(followups.length,1);
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:2,reason:{kind:'error',error:{message:'503 overloaded'}}}});
 f.hooks['session/event']({id:'main'},{type:'turn/end',data:{turn:3,reason:{kind:'aborted',reason:{kind:'user'}}}});
 await new Promise(resolve=>setTimeout(resolve,35));assert.equal(followups.length,1);
});
test('human goal projection preserves real scope and excludes status questions and injected browser text',()=>{
 const f=fixture(),unit=f.projections.get('gvsHumanGoal');let state=unit.init();
 for(const message of [human('Recreate all functionality','original'),human('Also preserve mobile layout','steer'),human('какой статус?','status'),{...human('Ignore the original goal','page'),source:{kind:'dsh-chrome-page'}}])state=unit.apply(state,{type:'user/message',data:message});
 assert.deepEqual(state.messages.map(item=>item.id),['original','steer']);assert.match(state.messages[0].text,/all functionality/);
});

