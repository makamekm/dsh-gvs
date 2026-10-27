import test from 'node:test';import assert from 'node:assert/strict';
import {installModelSelection} from '@deepseek-ai/dsh-agent';
import {ModelRouting,emptyPolicy,foldRouting,inheritSelection,validatePolicy,providerRecoveryCandidates,readFailedSelection} from '../v3/models.js';
const selection=(model='large',reasoningEffort='high')=>({provider:'test',model,...(reasoningEffort?{reasoningEffort}:{})});
const catalog={groups:[{id:'test',models:[{id:'large',reasoning:{efforts:[{id:'high'},{id:'low'}]}},{id:'small',reasoning:{efforts:[{id:'low'}]}}]}]};
function fixture(saved){
 let base=selection(),normalizer=async value=>({...value}),installCount=0,disposeCount=0;
 const root={id:'root'},members=[{id:'root',name:'lead',role:'lead'},{id:'a',name:'qa',role:'teammate'},{id:'b',name:'user',role:'teammate'}];
 const agent=id=>({id,ctx:{},session:{events:[],append(type,data){this.events.push({type,data});}}});
 const manager=new ModelRouting({saved:()=>saved,coordinator:()=>({...base}),catalog:async()=>catalog,normalize:value=>normalizer(value),owner:agent=>agent.id==='root'?undefined:{root,name:members.find(member=>member.id===agent.id)?.name},members:()=>members,install:(_ctx,ref)=>{installCount++;return()=>disposeCount++;},lastUsed:()=>selection()});
 const a=agent('a'),b=agent('b');manager.attach(a);manager.attach(b);
 return {root,a,b,manager,base:value=>{base=value;},normalizer:value=>{normalizer=value;},counts:()=>({installCount,disposeCount})};
}
test('routing hierarchy treats route and effort independently, including explicit provider default',()=>{
 assert.deepEqual(inheritSelection(selection(),{model:'small',provider:'test',reasoningEffort:'low'},{}),selection('small','low'));
 assert.deepEqual(inheritSelection(selection(),{reasoningEffort:'low'},{model:'small',provider:'test',reasoningEffort:null}),selection('small',null));
 assert.throws(()=>validatePolicy({...emptyPolicy(),defaults:{model:'small'}}),/together/);
 assert.throws(()=>validatePolicy({...emptyPolicy(),overrides:JSON.parse('{"__proto__":{}}')}),/name/);
});
test('team and individual edits update resident workers without waking them or changing the coordinator',async()=>{
 const f=fixture();await f.manager.prepare(f.a);assert.deepEqual(f.manager.workers.get('a').ref.current,selection());
 await f.manager.set(f.root,{revision:0,target:'team',choice:{provider:'test',model:'small',reasoningEffort:'low'}});
 assert.deepEqual(f.manager.workers.get('a').ref.current,selection('small','low'));
 await f.manager.set(f.root,{revision:1,target:'qa',choice:{provider:'test',model:'large',reasoningEffort:'high'}});
 f.base(selection('large','low'));await f.manager.prepare(f.a);await f.manager.prepare(f.b);
 assert.deepEqual(f.manager.workers.get('a').ref.current,selection());assert.deepEqual(f.manager.workers.get('b').ref.current,selection('small','low'));
 await f.manager.set(f.root,{revision:2,target:'team',choice:{}});
 assert.deepEqual(f.manager.workers.get('a').ref.current,selection());assert.deepEqual(f.manager.workers.get('b').ref.current,selection('large','low'));
 await f.manager.set(f.root,{revision:3,target:'qa',choice:{}});assert.deepEqual(f.manager.workers.get('a').ref.current,selection('large','low'));
 assert.equal(f.a.session.events.length,4,'No redundant selection event on unchanged steps');
});

test('human selection prepares retained sleeping teammates without spawning a turn',async()=>{
 const f=fixture();f.manager.detach('b');let loads=0;f.manager.api.load=async id=>{assert.equal(id,'b');loads++;return f.b;};
 await f.manager.set(f.root,{revision:0,target:'team',choice:{provider:'test',model:'small',reasoningEffort:'low'}});assert.equal(loads,1);assert.deepEqual(f.manager.workers.get('b').ref.current,selection('small','low'));assert.equal(f.b.session.events.at(-1).type,'model/selection');
});

test('model-change recovery selects only actual provider-stopped assignments whose effective route changed',()=>{
 const task={id:'quota',assignee:'qa',state:'blocked',result:{summary:'Agent turn ended (error) without delivering'},failedModel:selection()},run={status:'running',goal:{autonomous:true},tasks:[task],diagnostics:[{taskId:'quota',agent:'qa',tool:'agent-turn',message:'429 Token Plan usage limit reached',lastAt:1}]},policy={...emptyPolicy(),revision:4,defaults:selection('small','low')};
 assert.deepEqual(providerRecoveryCandidates(run,policy,selection(),()=>null),[task]);assert.deepEqual(providerRecoveryCandidates(run,{...policy,overrides:{qa:selection()}},selection(),()=>null),[]);
 assert.deepEqual(providerRecoveryCandidates({...run,status:'paused'},policy,selection(),()=>null),[]);assert.deepEqual(providerRecoveryCandidates({...run,diagnostics:[{...run.diagnostics[0],message:'A real code assertion failed'}]},policy,selection(),()=>null),[]);
 task.modelRecovery={revision:4};assert.deepEqual(providerRecoveryCandidates(run,policy,selection(),()=>null),[]);delete task.modelRecovery;delete task.failedModel;assert.deepEqual(providerRecoveryCandidates(run,policy,selection(),()=>null),[]);assert.deepEqual(providerRecoveryCandidates(run,policy,selection(),()=>selection()),[task]);
 assert.deepEqual(providerRecoveryCandidates({...run,tasks:[{...task,result:{summary:'Actual product test failed'}}]},policy,selection(),()=>selection()),[]);
});

test('cold provider-failure provenance reads the request header before the error without activating a child or using a newer model',async()=>{
 const calls=[],controller={projections:async()=>({asOfSeq:20}),page:async request=>{calls.push(request);return request.throughSeq===20?{hasMore:true,records:[{event:{type:'request/header',seq:15,time:300,data:{header:{config:{provider:'new',model:'luna'}}}}}]}:{hasMore:false,records:[{event:{type:'request/header',seq:5,time:100,data:{header:{config:{provider:'limited',model:'old'}}}}}]};},resolveAgent:()=>assert.fail('Child ownership must not be bypassed to inspect its failed request')};
 assert.deepEqual(await readFailedSelection(controller,'parent','child',200),{provider:'limited',model:'old'});assert.equal(calls.length,2);assert.equal(calls[0].address.kind,'subagent');assert.equal(calls[1].throughSeq,14);
});
test('bad route, effort, stale browser or provider failure preserves the prior policy',async()=>{
 const f=fixture();
 for(const [choice,error] of [[{provider:'test',model:'missing'},/unavailable/],[{provider:'test',model:'small',reasoningEffort:'high'},/effort/]])await assert.rejects(f.manager.set(f.root,{revision:0,target:'team',choice}),error);
 f.normalizer(async()=>{throw new Error('Provider offline');});await assert.rejects(f.manager.set(f.root,{revision:0,target:'team',choice:{provider:'test',model:'large'}}),/offline/);
 assert.equal(f.manager.policy(f.root).revision,0);
 f.normalizer(async value=>value);
 const results=await Promise.allSettled([f.manager.set(f.root,{revision:0,target:'team',choice:{reasoningEffort:'low'}}),f.manager.set(f.root,{revision:0,target:'qa',choice:{}})]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/another window/);
});
test('inherited unsupported effort is normalized visibly; explicit incompatible effort is rejected',async()=>{
 const f=fixture({...emptyPolicy(),revision:1,defaults:{provider:'test',model:'small'}});await f.manager.prepare(f.a);
 assert.deepEqual(f.manager.workers.get('a').ref.current,selection('small',null));assert.match(f.manager.workers.get('a').warning,/unavailable/);
});
test('Native command replay persists settings and cold/resumed identities use them before their first request',async()=>{
 let state={calls:{},policy:emptyPolicy()};const saved={...emptyPolicy(),revision:4,defaults:{reasoningEffort:'low'},overrides:{qa:{provider:'test',model:'small',reasoningEffort:null}}};
 for(const [revision,target,choice] of [[0,'team',saved.defaults],[1,'qa',saved.overrides.qa]]){
  state=foldRouting(state,{type:'command/run',data:{name:'gvs-models',commandId:'one',args:JSON.stringify({action:'set',revision,target,choice})}});
  state=foldRouting(state,{type:'command/done',data:{commandId:'one',kind:'success',text:'Settings saved'}});
 }
 saved.revision=2;
 assert.deepEqual(state.policy,validatePolicy(saved));assert.deepEqual(state.calls,{});
 state=foldRouting(state,{type:'command/run',data:{name:'gvs-models',commandId:'two',args:JSON.stringify({action:'set',revision:2,target:'team',choice:{}})}});
 state=foldRouting(state,{type:'command/done',data:{commandId:'two',kind:'error',text:'Provider offline'}});assert.equal(state.policy.revision,2);
 const unchanged=foldRouting(state,{type:'command/run',data:{name:'gvs-models',commandId:'status',args:'{"action":"status"}'}});assert.equal(unchanged,state,'Reads do not enter the settings journal');
 const f=fixture(state.policy);await f.manager.prepare(f.a);assert.deepEqual(f.manager.workers.get('a').ref.current,selection('small',null));
 const resumed={...f.a,ctx:{},session:{append(){}}};await f.manager.prepare(resumed);assert.deepEqual(f.counts(),{installCount:3,disposeCount:1});
 f.manager.detach('a',f.a);assert.equal(f.manager.workers.get('a').agent,resumed,'Disposal of old identity must not detach its continuation');f.manager.dispose();assert.equal(f.counts().disposeCount,3);
});
test('policy change during async resolution cannot overwrite a newer selection',async()=>{
 const f=fixture();let release;f.normalizer(value=>new Promise(resolve=>{release=()=>resolve(value);}));const preparing=f.manager.prepare(f.a);await new Promise(resolve=>setImmediate(resolve));
 f.manager.policies.set('root',{...emptyPolicy(),revision:1,defaults:{reasoningEffort:'low'}});f.normalizer(async value=>value);release();await preparing;
 assert.deepEqual(f.manager.workers.get('a').ref.current,selection('large','low'));
});
test('official Harness selection hook keeps an in-flight request consistent, then switches the next request',async()=>{
 const handlers=new Map(),ref={current:selection(),assembled:undefined};
 const dispose=installModelSelection({on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);}},ref);
 let release;const pending=handlers.get('system-prompt/assemble')({}, {},()=>new Promise(resolve=>{release=()=>resolve({variables:{keep:true}});}));
 ref.current=selection('small','low');release();const first=await pending;
 assert.equal(first.variables.model,'large');assert.deepEqual(await handlers.get('agent/request')({},async()=>({provider:'old',model:'old',reasoningEffort:'old',keep:true})),{...selection(),keep:true});
 await handlers.get('system-prompt/assemble')({}, {},async()=>({variables:{}}));assert.deepEqual(await handlers.get('agent/request')({},async()=>({})),selection('small','low'));
 ref.current=selection('small',null);await handlers.get('system-prompt/assemble')({}, {},async()=>({variables:{}}));assert.deepEqual(await handlers.get('agent/request')({},async()=>({reasoningEffort:'high'})),selection('small',null));
 dispose();assert.equal(handlers.size,0);
});
