import test from 'node:test';import assert from 'node:assert/strict';
import {recordToolFailure,recordToolSuccess,diagnosticStatus,toolIdentity,toolFailureMessage,recoveryAdvice,failureFamily,checkFailureDetails} from '../v3/diagnostics.js';import {progressStatus} from '../v3/flow.js';

test('repeated actual failures group across generated session IDs/event timings while preserving first/latest evidence and distinct assertions',()=>{
 const run={tasks:[]},base={agent:'qa',taskId:'runtime',tool:'pwsh',identity:'same-command'},messages=[1,2,3].map(i=>`Command failed (exit 1): Error: rotate-A timeout; events=[{"t":${i*107},"session":"00000000-0000-4000-8000-${String(i).padStart(12,'0')}"}]\nGVS_ANALYSIS_RESULT:{"port":${50000+i}}`);
 assert.equal(recordToolFailure(run,{...base,message:messages[0]},1000).notify,true);assert.equal(recordToolFailure(run,{...base,message:messages[1]},2000).notify,false);assert.equal(recordToolFailure(run,{...base,message:messages[2]},3000).notify,true);assert.equal(run.diagnostics.length,1);assert.equal(run.diagnostics[0].message,messages[2]);assert.equal(run.diagnostics[0].firstMessage,messages[0]);assert.equal(diagnosticStatus(run,3000).repeated,1);assert.equal(diagnosticStatus(run,3000).repeatedFamilies[0].count,3);
 recordToolFailure(run,{...base,message:'Command failed (exit 1): Error: presence-1 timeout'},4000);assert.equal(run.diagnostics.length,2);assert.notEqual(failureFamily('Error: expected 2 sessions'),failureFamily('Error: expected 3 sessions'));assert.notEqual(failureFamily('Error: width480 is clipped'),failureFamily('Error: width575 is clipped'));
 recordToolSuccess(run,base,5000);assert.equal(diagnosticStatus(run,5000).repeated,0);assert.equal(recordToolFailure(run,{...base,message:messages[0]},6000).notify,true);assert.equal(diagnosticStatus(run,6000).repeated,0,'An actual subsequent success starts a new error episode, not a fake three-retry count.');
});
test('legacy error rows aggregate without deleting original records, and failures outside the time window do not inflate current repeats',()=>{
 const run={tasks:[],diagnostics:[1,2,3].map(i=>({id:'legacy-'+i,agent:'qa',taskId:'same',tool:'pwsh',identity:'same',message:`Command failed (exit 1): Error: rotate-A timeout; events=[{"t":${i}}]`,status:'open',firstAt:i*1000,lastAt:i*1000,count:1}))},before=structuredClone(run.diagnostics);assert.equal(diagnosticStatus(run,4000).repeated,1);assert.deepEqual(run.diagnostics,before);assert.equal(diagnosticStatus(run,700000).repeated,0);
 const notified=recordToolFailure(run,{agent:'qa',taskId:'same',tool:'pwsh',identity:'same',message:'Command failed (exit 1): Error: rotate-A timeout; events=[{"t":99}]'},5000);assert.equal(notified.notify,true);assert.equal(run.diagnostics.length,3);assert.ok(run.diagnostics.some(d=>d.id==='legacy-1'));
});
test('a new failure after success is not lost to duplicate suppression and a new time window escalates again',()=>{
 const run={tasks:[]},event={agent:'qa',taskId:'same',tool:'pwsh',identity:'same',message:'Command failed (exit 1): Error: rotate-A timeout'};recordToolFailure(run,event,1000);recordToolSuccess(run,event,1010);assert.equal(recordToolFailure(run,event,1020).notify,true);assert.equal(run.diagnostics[0].status,'open');assert.equal(diagnosticStatus(run,1020).repeated,0);recordToolFailure(run,event,2000);assert.equal(recordToolFailure(run,event,3000).notify,true);assert.equal(recordToolFailure(run,event,700000).notify,true);assert.equal(diagnosticStatus(run,700000).repeated,0);
});
test('failed analysis diagnostics name the real failed cases and expected/actual values instead of a generic false result',()=>{
 const details=checkFailureDetails({views:[],results:[{id:'regression',cases:[{name:'actual binary',passed:true},{name:'repeat avoidance',passed:false,actual:'same peer',expected:'unseen queued peer'}]}]});assert.equal(details.failedCount,1);assert.equal(details.failedCases[0].case,'repeat avoidance');assert.match(details.failedCases[0].actual,/same peer/);assert.match(details.failedCases[0].expected,/unseen/);assert.deepEqual(checkFailureDetails({views:[{viewport:'mobile',errors:['actual clipping']}]}),[{viewport:'mobile',errors:['actual clipping']}]);
});
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
