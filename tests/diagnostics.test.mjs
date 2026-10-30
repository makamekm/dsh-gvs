import test from 'node:test';import assert from 'node:assert/strict';
import {recordToolFailure,recordToolSuccess,diagnosticStatus,toolIdentity,toolFailureMessage,recoveryAdvice,failureFamily,checkFailureDetails} from '../v3/diagnostics.js';import {progressStatus} from '../v3/flow.js';

const runnerReport=(attempt,target='source-system-notice',padding=0)=>'Command failed (exit 1): '+JSON.stringify({startedAt:`2026-10-28T00:0${attempt}:00Z`,attempt:`artifacts/rules/attempt-${attempt}`,cases:[{passed:true,actual:'visible desktop '+'.'.repeat(padding)}],failures:[{message:'runner exception',actual:`TimeoutError: locator.waitFor: Timeout 30000ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('[data-ui="${target}"]') to be visible\u001b[22m\n`,stack:`at generated-${attempt}.mjs:34:900`}]},null,2);
const panic=(pid,name='table::tests::bounded_input',actual='InvalidRange',line=30)=>`thread '${name}' (${pid}) panicked at src\\table.rs:${line}:142:\ncalled Result::unwrap() on an Err value: ${actual}\nnote: run with RUST_BACKTRACE=1 to display a backtrace\n`;
const missingReport=i=>`Analysis runner finished without its required report (exit 0).\n${JSON.stringify({atMs:i*1.13,events:[{pid:i,kind:'tcp-data',bytes:i*20}],trace:'.'.repeat(1900)})}\nNo analysis evidence accepted. Runner must print final GVS_ANALYSIS_RESULT: followed by gvs.analysis/1 JSON.`;

test('missing analysis envelope repetitions group by protocol verdict, preserving raw evidence and operation boundaries',()=>{
 const run={tasks:[]},base={agent:'qa',taskId:'trace',tool:'gvs_analysis',identity:'same-real-command'},messages=[1,2,3].map(missingReport);
 const first=recordToolFailure(run,{...base,message:messages[0]},1000);assert.equal(first.notify,true);assert.equal(recordToolFailure(run,{...base,message:messages[1]},2000).notify,false);assert.equal(recordToolFailure(run,{...base,message:messages[2]},3000).notify,true);
 assert.equal(run.diagnostics.length,1);assert.equal(run.diagnostics[0].count,3);assert.equal(run.diagnostics[0].message,messages[2].slice(0,1400));assert.equal(run.diagnostics[0].firstMessage,messages[0].slice(0,1400));assert.equal(diagnosticStatus(run,3000).repeatedFamilies[0].count,3);assert.equal(progressStatus(run,3000).needsIntervention,true);
 recordToolFailure(run,{...base,identity:'different-command',message:missingReport(4)},4000);assert.equal(run.diagnostics.length,2);recordToolSuccess(run,{...base,identity:'different-command'},5000);assert.equal(diagnosticStatus(run,5000).repeated,1);
 recordToolSuccess(run,base,6000);assert.equal(diagnosticStatus(run,6000).repeated,0);
 assert.match(recoveryAdvice(messages[0]),/exploratory raw traces.*foreground pwsh\/bash/);assert.match(recoveryAdvice(messages[0]),/real measured cases/);assert.match(recoveryAdvice(messages[0]),/independent adapter review/);
 assert.notEqual(failureFamily('Analysis runner failed (exit 1).\nAssertionError: actual=1 expected=2'),failureFamily('Analysis runner failed (exit 1).\nAssertionError: actual=3 expected=2'));
 assert.notEqual(failureFamily('Malformed final GVS_ANALYSIS_RESULT JSON: first error'),failureFamily('Malformed final GVS_ANALYSIS_RESULT JSON: second error'));
});

test('saved missing-envelope families reclassify read-only even with clipped trace digests, without guessing partial verdicts',()=>{
 const base={agent:'qa',taskId:'trace',tool:'gvs_analysis',identity:'same'},run={tasks:[],diagnostics:[1,2,3].map(i=>({...base,id:'prior-'+i,message:missingReport(i).slice(0,1400),family:missingReport(i).slice(0,1300)+' [family sha256:'+String(i).repeat(64)+']',status:'open',count:1,firstAt:i*1000,lastAt:i*1000}))},before=structuredClone(run);
 assert.equal(diagnosticStatus(run,4000).repeatedFamilies[0].count,3);assert.deepEqual(run,before);
 const next=recordToolFailure(run,{...base,message:missingReport(4)},5000);assert.equal(next.item.id,'prior-1');assert.equal(run.diagnostics.length,3);assert.equal(next.item.firstMessage,before.diagnostics[0].message);assert.equal(diagnosticStatus(run,5000).repeatedFamilies[0].count,4);
 const partial=structuredClone(before);for(const row of partial.diagnostics)row.family='Analysis runner finished without its required rep '+row.id;assert.equal(diagnosticStatus(partial,4000).repeated,0);
 const secrets={tasks:[]};recordToolFailure(secrets,{...base,message:missingReport(5)+'\nhttp://localhost/?token=secret-test-value'},1000);assert.ok(!JSON.stringify(secrets).includes('secret-test-value'));
});
test('Rust panic repetitions retain the actual test/assertion while ignoring PIDs, stack positions and unrelated parallel output',()=>{
 const run={tasks:[]},base={agent:'qa',taskId:'ranges',tool:'pwsh',identity:'same-cargo-command'},messages=[1,2,3].map(i=>'Command failed (exit 1): '+('test unrelated_'+i+' ... ok\n').repeat(100)+panic(50000+i,undefined,undefined,30+i)+'\nrunning 20 tests\n');
 for(let i=0;i<messages.length;i++)recordToolFailure(run,{...base,message:messages[i]},1000+i*1000);assert.equal(run.diagnostics.length,1);assert.equal(run.diagnostics[0].count,3);assert.equal(run.diagnostics[0].message,messages[2].slice(0,1400));assert.equal(run.diagnostics[0].firstMessage,messages[0].slice(0,1400));assert.match(run.diagnostics[0].family,/bounded_input/);assert.match(run.diagnostics[0].family,/InvalidRange/);assert.ok(!run.diagnostics[0].family.includes('50001'));assert.equal(diagnosticStatus(run,3000).repeatedFamilies[0].count,3);assert.equal(run.diagnostics[0].status,'open');
 assert.notEqual(failureFamily(panic(1)),failureFamily(panic(2,'table::tests::other')));assert.notEqual(failureFamily(panic(1)),failureFamily(panic(2,undefined,'InvalidLength')));
 const assertion=actual=>`thread 'counts' (100) panicked at src/count.rs:9:2:\nassertion left == right failed\n  left: ${actual}\n right: 3\nnote: backtrace disabled\n`;assert.notEqual(failureFamily(assertion(1)),failureFamily(assertion(2)),'Do not normalize numerical assertions as process IDs');
 recordToolSuccess(run,base,4000);assert.equal(diagnosticStatus(run,4000).repeated,0);
});
test('parallel Rust panic sets group independent of order; legacy rows and incomplete output are not rewritten or guessed',()=>{
 const a=panic(12,'a'),b=panic(13,'b');assert.equal(failureFamily(a+'\n'+b),failureFamily(panic(999,'b',undefined,55)+'\n'+panic(888,'a',undefined,77)));assert.notEqual(failureFamily(a),failureFamily(a+'\n'+b));
 const run={diagnostics:[1,2,3].map(i=>({id:'old-panic-'+i,agent:'qa',taskId:'same',tool:'pwsh',identity:'same',message:'Command failed (exit 1): '+panic(i),family:'Command failed (exit 1): '+panic(i),status:'open',firstAt:i*1000,lastAt:i*1000,count:1}))},before=structuredClone(run);assert.equal(diagnosticStatus(run,4000).repeatedFamilies[0].count,3);assert.deepEqual(run,before);assert.notEqual(failureFamily("thread 'a' (1) panicked at src/a.rs:1:1:\n"),failureFamily("thread 'a' (2) panicked at src/a.rs:1:1:\n"),'Incomplete panic headers are not an invented common assertion');
 const hashed=structuredClone(run);for(let i=0;i<hashed.diagnostics.length;i++)hashed.diagnostics[i].family+=' [family sha256:'+String(i).repeat(64)+']';assert.equal(diagnosticStatus(hashed,4000).repeated,0,'A clipped/digested old family must not drop possible additional unseen assertions');
 const next=recordToolFailure(run,{agent:'qa',taskId:'same',tool:'pwsh',identity:'same',message:'Command failed (exit 1): '+panic(900)},5000);assert.equal(next.item.id,'old-panic-1');assert.equal(next.notify,true);assert.equal(run.diagnostics.length,3);assert.equal(next.item.firstMessage,before.diagnostics[0].message);assert.equal(diagnosticStatus(run,5000).repeatedFamilies[0].count,4);
 const secrets={tasks:[]};recordToolFailure(secrets,{agent:'qa',taskId:'t',tool:'pwsh',identity:'cmd',message:panic(3,undefined,'http://localhost/?token=private-test-value npm_fakecredentialvalue12345')},1000);assert.ok(!JSON.stringify(secrets).includes('private-test-value'));assert.ok(!JSON.stringify(secrets).includes('npm_fake'));
});
test('JSON runner failures group by decoded failing target before log clipping while preserving original errors',()=>{
 const run={tasks:[]},base={agent:'qa',taskId:'rules',tool:'pwsh',identity:'actual-command'},messages=[1,2,3].map(i=>runnerReport(i,'source-system-notice',1800));
 for(let i=0;i<messages.length;i++)recordToolFailure(run,{...base,message:messages[i]},1000+i*1000);
 assert.equal(run.diagnostics.length,1);assert.equal(run.diagnostics[0].count,3);assert.equal(run.diagnostics[0].message,messages[2].slice(0,1400));assert.equal(run.diagnostics[0].firstMessage,messages[0].slice(0,1400));assert.ok(!run.diagnostics[0].message.includes('TimeoutError'),'The cause was genuinely beyond the stored log bound');
 assert.match(run.diagnostics[0].family,/TimeoutError/);assert.match(run.diagnostics[0].family,/source-system-notice/);assert.ok(!run.diagnostics[0].family.includes('attempt-'));assert.equal(diagnosticStatus(run,3000).repeatedFamilies[0].count,3);assert.equal(progressStatus(run,3000).needsIntervention,true);
 recordToolFailure(run,{...base,message:runnerReport(4,'mobile-drawer',1800)},4000);assert.equal(run.diagnostics.length,2,'Different actual selectors must not merge');assert.equal(run.diagnostics.every(d=>d.status==='open'),true);
 const serialized=JSON.stringify(run);assert.equal(diagnosticStatus(JSON.parse(serialized),4000).repeated,1,'Full-derived family survives persistence');
});
test('legacy clipped JSON failures aggregate read-only only when the complete actual exception remains',()=>{
 const run={diagnostics:[1,2,3].map(i=>{const message=runnerReport(i);return {id:'old-json-'+i,agent:'qa',taskId:'rules',tool:'pwsh',identity:'actual-command',message:message.slice(0,message.indexOf('"stack"')+12),status:'open',firstAt:i*1000,lastAt:i*1000,count:1};})},before=structuredClone(run);
 assert.equal(diagnosticStatus(run,4000).repeatedFamilies[0].count,3);assert.deepEqual(run,before,'Do not rewrite or delete old evidence');assert.equal(failureFamily(run.diagnostics[0].message),failureFamily(runnerReport(9)));
 assert.notEqual(failureFamily(runnerReport(1).slice(0,120)),failureFamily(runnerReport(2).slice(0,120)),'Do not guess a missing cause from a truncated report header');
 const passedOnly=i=>'Command failed (exit 1): '+JSON.stringify({startedAt:i,cases:[{passed:true,actual:'TimeoutError: unrelated passed text'}]});assert.notEqual(failureFamily(passedOnly(1)),failureFamily(passedOnly(2)));
});
test('structured failures retain differing criteria, actual values and failing viewports, and redact the stored family',()=>{
 const report=(actual,expected=3,width=480)=>'Command failed (exit 1): '+JSON.stringify({startedAt:Date.now(),results:[{id:'layout',cases:[{name:'expected count',passed:false,actual,expected,viewport:{width,height:800}},{name:'irrelevant passing case',passed:true}]}]});
 assert.notEqual(failureFamily(report(2)),failureFamily(report(3)));assert.notEqual(failureFamily(report(2,4)),failureFamily(report(2)));assert.notEqual(failureFamily(report(2,3,575)),failureFamily(report(2)));
 const long=actual=>JSON.stringify({failures:[{message:'assertion',actual:'x'.repeat(1900)+actual,expected:2}]});assert.notEqual(failureFamily(long('A')),failureFamily(long('B')),'Different assertions beyond display bound retain distinct hashes');
 const run={tasks:[]};recordToolFailure(run,{agent:'qa',taskId:'same',tool:'pwsh',identity:'cmd',message:runnerReport(1,'http://localhost/?token=private-test-value npm_fakecredentialvalue12345')},1000);const stored=JSON.stringify(run);assert.ok(!stored.includes('private-test-value'));assert.ok(!stored.includes('npm_fake'));assert.match(run.diagnostics[0].family,/redacted/);
});

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
 for(const extension of ['png','jpg','jpeg','gif','webp'])assert.match(recoveryAdvice(`cannot read "C:\\work\\real capture.${extension}": binary file`),/read_image.*exact existing image path/);
 assert.equal(recoveryAdvice('cannot read "C:\\work\\asset.uasset": binary file'),null);
 const missing=recoveryAdvice('cannot read "C:\\work\\missing.png": not found');assert.match(missing,/does not exist.*glob the parent/);assert.doesNotMatch(missing,/read_image/,'a missing screenshot is never treated as viewable');
});
test('native read/edit/glob mistakes get a concrete next step',()=>{
 assert.match(recoveryAdvice('cannot read "C:\\p\\artifacts\\task217": not a regular file'),/directory.*glob/);
 assert.match(recoveryAdvice('offset must be a positive integer'),/start at 1/);
 assert.match(recoveryAdvice('offset 424 is out of range for "C:\\p\\a.rs" (300 lines)'),/only 300 line/);
 assert.match(recoveryAdvice('limit must be less than or equal to 180'),/limit ≤ 180/);
 assert.match(recoveryAdvice('cannot modify "C:\\p\\a.ts": file has not been read — read the file, then retry'),/Read the relevant range/);
 assert.match(recoveryAdvice('cannot edit "C:\\p\\a.rs": file changed since it was read — re-read the file, then retry'),/CURRENT text/);
 assert.match(recoveryAdvice('old_string matched 2 times in "C:\\p\\a.rs"; provide a more specific old_string'),/unique/);
 assert.match(recoveryAdvice('This role has no command execution capability.'),/verify role/);
 assert.match(recoveryAdvice('tool call timed out after 30000ms'),/specific subdirectory/);
});

test('unsupported JSON/document image reads do not masquerade as SVG or prove an existing screenshot',()=>{
 const suffix='extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files';for(const ext of ['json','txt','pdf']){const advice=recoveryAdvice(`cannot read "missing.${ext}": the .${ext} ${suffix}`);assert.match(advice,/textual sources\/reports such as JSON with read/);assert.match(advice,/if missing, enumerate/);assert.ok(!advice.includes('SVG/vector'));assert.match(advice,/not.*visual inspection/);}
 assert.match(recoveryAdvice(`cannot read "icon.svg": the .svg ${suffix}`),/SVG\/vector/);
});
