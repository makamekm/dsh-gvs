import test from 'node:test';import assert from 'node:assert/strict';import {apply} from '../v3/host.js';
test('panel state replays from Native presentation metadata even if model text was spilled, preserving legacy history',()=>{
 let unit;apply({sessionProjections:{register:value=>unit=value}});assert.equal(unit.stateVersion,2);
 const team={schema:3,sessionId:'root',roles:[],tasks:[{id:'admin',state:'waiting'}]};
 let state=unit.init();state=unit.apply(state,{type:'tool/call',data:{name:'gvs_status',callId:'a'}});
 state=unit.apply(state,{type:'tool/result',data:{meta:{gvsTeam:team},message:{toolCallId:'a',content:[{type:'text',text:'truncated JSON (Omitted bytes...)'}]}}});assert.deepEqual(state.value,team);
 state=unit.apply(state,{type:'tool/call',data:{name:'gvs_status',callId:'b'}});
 const legacy={...team,tasks:[{id:'mobile',state:'done'}]};state=unit.apply(state,{type:'tool/result',data:{message:{toolCallId:'b',content:[{type:'text',text:JSON.stringify({gvsTeam:legacy})}]}}});assert.deepEqual(state.value,legacy);
});
