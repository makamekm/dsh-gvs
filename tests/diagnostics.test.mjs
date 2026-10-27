import test from 'node:test';import assert from 'node:assert/strict';
import {recordToolFailure,recordToolSuccess,diagnosticStatus,toolIdentity,toolFailureMessage,recoveryAdvice} from '../v3/diagnostics.js';import {progressStatus} from '../v3/flow.js';
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

test('empty stderr cannot hide actual stdout failure, and timeouts cannot resolve an error as success',()=>{
 const failed={isError:false,value:{kind:'foreground',exitCode:1,stderr:{text:''},stdout:{text:'ACTUAL_RUN_FAILED strict mode violation: duplicate controls'}}};
 assert.match(toolFailureMessage(failed),/ACTUAL_RUN_FAILED/);assert.match(recoveryAdvice(toolFailureMessage(failed)),/ambiguous/);
 assert.match(toolFailureMessage({isError:false,value:{kind:'foreground',exitCode:0,timedOut:true}}),/timed out/);
 assert.match(toolFailureMessage({isError:true,content:[],error:{message:'Concrete error'}}),/Concrete error/);
 assert.equal(toolFailureMessage({isError:false,value:{kind:'foreground',exitCode:0}}),null);
 assert.equal(toolFailureMessage({isError:false,value:{kind:'background'}}),null);
 assert.equal(recoveryAdvice('Expected actual pixels to match reference; mismatch 14%'),null,'Real product mismatch must not be labelled an automation failure');
});

test('recovery instructions address real edit whitespace, stale tabs and missing screenshots without waiving evidence',()=>{
 assert.match(recoveryAdvice('old_string was not found in check.mjs'),/leading spaces/);
 assert.match(recoveryAdvice('BROWSER_TAB_NOT_FOUND: no open browser tab 1'),/list_windows/);
 assert.match(recoveryAdvice('Page.captureScreenshot: Unable to capture screenshot'),/no new image/);
 assert.match(recoveryAdvice('grep pattern rejected by ripgrep: regex parse error'),/fixed-string/);
});
