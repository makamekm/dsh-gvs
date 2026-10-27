import test from 'node:test';import assert from 'node:assert/strict';
import {recordToolFailure,recordToolSuccess,diagnosticStatus,toolIdentity} from '../v3/diagnostics.js';import {progressStatus} from '../v3/flow.js';
test('tool errors are bounded, deduplicated, escalated and resolved only by the same successful task operation',()=>{
 const run={tasks:[]},event={agent:'user',taskId:'review',tool:'gvs_wait',identity:toolIdentity({name:'gvs_wait',arguments:{}}),message:'Error: Invalid waiting policy'};
 assert.equal(recordToolFailure(run,event,1000).notify,true);assert.equal(recordToolFailure(run,{...event,message:'Invalid waiting policy'},1010).notify,false);assert.equal(run.diagnostics[0].count,1);
 recordToolFailure(run,event,2000);assert.equal(recordToolFailure(run,event,3000).notify,true);assert.equal(diagnosticStatus(run,3000).repeated,1);assert.equal(progressStatus(run,3000).needsIntervention,true);
 recordToolSuccess(run,{...event,agent:'builder'},4000);assert.equal(diagnosticStatus(run,4000).open,1);recordToolSuccess(run,event,5000);assert.equal(diagnosticStatus(run,5000).open,0);
 for(let i=0;i<120;i++)recordToolFailure(run,{...event,message:'Different failure '+i},6000+i*100);assert.equal(run.diagnostics.length,100);
});
test('diagnostic reports redact credentials and keep repeated legitimate failures as evidence rather than success',()=>{
 const run={tasks:[]},event={agent:'qa',taskId:'review',tool:'read',identity:'read-path',message:'cannot read http://localhost/?token=private-test-value npm_fakecredentialvalue12345'};
 recordToolFailure(run,event,1000);const text=JSON.stringify(diagnosticStatus(run,1000));assert.ok(!text.includes('private-test-value'));assert.ok(!text.includes('npm_fake'));assert.ok(text.includes('cannot read'));assert.equal(run.diagnostics[0].status,'open');
});
