import test from 'node:test';import assert from 'node:assert/strict';
import {apply} from '../v3/models-host.js';
test('Host composes the official Agent hooks, human-only commands, replay and child lifecycle',async()=>{
 let definition,projection,cleanup;const hooks=new Map(),childHooks=new Map(),events=[];
 const root={id:'root',options:{provider:'test',model:'large'},session:{header:{agentPreset:'gvs-local'},requestHeader:()=>null}};
 const child={id:'qa',ctx:{on(name,handler){childHooks.set(name,handler);return()=>childHooks.delete(name);}},session:{header:{origin:'subagent',parentSession:'root'},append:(type,data)=>events.push({type,data})}};
 const ctx={commands:{register:value=>definition=value},agents:{list:()=>[root,child],get:id=>({root,qa:child}[id])},agentTeams:{tryMembership:agent=>agent===child?{root,role:'teammate',name:'qa'}:undefined,listMembers:()=>[{id:'qa',name:'qa',role:'teammate'}]},sessionController:{modelCatalog:async()=>({groups:[{id:'test',models:[{id:'large',reasoning:{efforts:[{id:'low'}]}}]}]})},llm:{resolveCallConfig:async value=>value},sessionProjections:{register:value=>projection=value,stateOf:(_session,key)=>key==='gvsModelRouting'?projection.init():null},on(name,handler){hooks.set(name,handler);},effect:fn=>{cleanup=fn();}};
 await apply(ctx);assert.equal(definition.name,'gvs-models');assert.equal(childHooks.size,3);assert.equal(hooks.has('agent/created'),true);
 const failed=await definition.handler({agent:child,rawInput:'{"action":"set"}'});assert.equal(failed.kind,'error');
 const value=await definition.handler({agent:root,rawInput:'{"action":"set","revision":0,"target":"team","choice":{"reasoningEffort":"low"}}'});assert.equal(value.kind,'success');assert.match(value.text,/сохранены/);
 assert.deepEqual(events,[{type:'model/selection',data:{provider:'test',model:'large',reasoningEffort:'low'}}]);
 await hooks.get('system-prompt/assemble')({}, {agent:child},async()=>({}));
 await childHooks.get('system-prompt/assemble')({}, {},async()=>({variables:{}}));
 assert.deepEqual(await childHooks.get('agent/request')({},async()=>({})),{provider:'test',model:'large',reasoningEffort:'low'});
 cleanup();assert.equal(childHooks.size,0);
});

test('only a successfully committed human model command attempts provider recovery and human pause prevents a coordinator wake',async()=>{
 let definition,projection,state,continued=true;const hooks=new Map(),calls=[],sent=[];
 const root={id:'root',options:{provider:'test',model:'large'},ctx:{tools:{execute:async input=>{calls.push(input);return {value:{continued,recovered:['same-task']}};}}},session:{header:{agentPreset:'gvs-local'},requestHeader:()=>null},steer:message=>sent.push(message)};
 const ctx={commands:{register:value=>definition=value},agents:{list:()=>[root],get:id=>id==='root'?root:null},agentTeams:{tryMembership:()=>undefined,listMembers:()=>[]},sessionController:{modelCatalog:async()=>({groups:[{id:'test',models:[{id:'large'},{id:'small'}]}]})},llm:{resolveCallConfig:async value=>value},sessionProjections:{register:value=>{projection=value;state=value.init();},stateOf:(_session,key)=>key==='gvsModelRouting'?state:null},on:(name,handler)=>hooks.set(name,handler),effect(){}};
 await apply(ctx);
 async function command(id,request,kind='success'){
  const run={type:'command/run',data:{commandId:id,name:'gvs-models',args:JSON.stringify(request)}};state=projection.apply(state,run);hooks.get('session/event')(root.session.id?root.session:{id:'root'},run);
  if(kind==='success')assert.equal((await definition.handler({agent:root,rawInput:JSON.stringify(request)})).kind,'success');
  const done={type:'command/done',data:{commandId:id,kind}};state=projection.apply(state,done);hooks.get('session/event')({id:'root'},done);await new Promise(resolve=>setImmediate(resolve));
 }
 await command('one',{action:'set',revision:0,target:'team',choice:{provider:'test',model:'small'}});assert.equal(calls.length,1);assert.deepEqual(calls[0].arguments,{reason:'model-change'});assert.equal(sent.length,1);
 await command('failed',{action:'set',revision:1,target:'team',choice:{provider:'test',model:'large'}},'error');assert.equal(calls.length,1);
 continued=false;await command('paused',{action:'set',revision:1,target:'team',choice:{provider:'test',model:'large'}});assert.equal(calls.length,2);assert.equal(sent.length,1);
});
