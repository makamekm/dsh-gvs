import test from 'node:test';import assert from 'node:assert/strict';
import {recoverGoals} from '../v3/recovery.js';
import {apply} from '../v3/recovery-host.js';
test('boot recovery resumes opted-in active goals and the explicit upgrade target, preserving paused, verified and unrelated sessions',async()=>{
 const statuses={active:{status:'running',goal:{autonomous:true}},paused:{status:'paused',goal:{autonomous:true}},verified:{status:'verified',goal:{autonomous:true}},handoff:{status:'running',goal:{autonomous:true,handoff:{dependency:'missing-source'}}},old:{status:'running'},legacyTest:{status:'running'}};
 const called=[];
 const ctx={sessionPersistence:{list:async()=>Object.keys(statuses).map(id=>({header:{id,cwd:'/project',agentPreset:'gvs-local'}}))},
  fs:{resolve:async name=>name,readText:async name=>{const id=name.match(/team-(.+)\.json/)[1];return JSON.stringify({sessionId:id,...statuses[id]});}},
  sessionController:{resolveAgent:async id=>{called.push(id);return {agent:{id}};}}};
 const result=await recoverGoals(ctx,{recoverSessions:['old']});assert.deepEqual(called,['active','old']);assert.equal(result.resumed.length,2);assert.deepEqual(result.errors,[]);
});
test('boot wakes a resumed coordinator even when old teammate results are still queued',async()=>{
 const sent=[],agent={id:'active',status:'inactive',inbox:{nextTurn:[{id:'old-team-result'}],nextStep:[]},followup:message=>sent.push(message)};
 const ctx={effect:fn=>fn(),sessionPersistence:{list:async()=>[{header:{id:'active',cwd:'/project',agentPreset:'gvs-local'}}]},
  fs:{resolve:async name=>name,readText:async()=>JSON.stringify({sessionId:'active',status:'running',goal:{autonomous:true}})},sessionController:{resolveAgent:async()=>({agent})}};
 apply(ctx);await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);assert.equal(sent[0].source.kind,'gvs-coordinator-continuation');assert.equal(agent.inbox.nextTurn[0].id,'old-team-result');
});
