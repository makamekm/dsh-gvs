import test from 'node:test';import assert from 'node:assert/strict';
import {responsiveMatrix,mergeResponsiveHints,responsiveStatus,inspectResponsiveCheck,validateResponsiveAcceptance,responsiveRunReady} from '../v3/responsive.js';
import {VISUAL_CHECKS} from '../v3/visual.js';import {scenarioKey} from '../v3/journeys.js';
const runFixture=()=>({kind:'ui',revision:4,visualRequired:true,responsivePolicy:1,roles:[{name:'qa',capability:'verify'},{name:'user',capability:'user'}],tasks:[],responsiveChecks:[]});
const taskFixture=(assignee='user')=>({id:'task-'+assignee,kind:assignee==='user'?'user-review':'review',scope:'increment',assignee});
function captured(run,task,item){const scenario={id:'current-surface',category:'primary',target:'Current assigned UI surface and its actual controls',expected:'Real actions produce the assigned observable state without layout defects.'},imageId=item.id+'-pixels';return {id:'capture-'+item.id,caseId:item.id,caseKey:item.key,taskId:task.id,capturedBy:task.assignee,revision:run.revision,scenarioId:scenario.id,scenarioKey:scenarioKey(scenario),ok:true,images:[{viewport:item.name,attachment:{attachmentId:imageId}}],views:[{viewport:item.name,steps:[{kind:'click',target:'Open',passed:true,inputEvents:[{type:'pointerdown',pointerType:'mouse',trusted:true}]},{kind:'assertVisible',target:'Options',passed:true}],layout:{captures:[{imageId,stage:'initial',warningIds:[]}],warnings:[],truncated:false}}]};}
const inspection=check=>({verdict:'pass',findings:[],images:check.images.map(i=>i.attachment.attachmentId),visualReview:{checked:VISUAL_CHECKS,assessments:[]}});

test('negative pixel assessments become durable feedback even when findings omits them; same-owner batch evidence is retained',()=>{
 const run=runFixture(),task=taskFixture(),[a,b]=responsiveMatrix(run).cases.slice(0,2),first=captured(run,task,a),second=captured(run,task,b),image=second.images[0].attachment.attachmentId;
 second.views[0].layout.warnings=[{id:'footer-overlap',kind:'overlap',images:[image],targets:[{label:'Age'},{label:'Agreement'}]}];run.responsiveChecks=[first,second];
 const input={...inspection(first),verdict:'revise',findings:[],observations:['The chat close button itself remains visible.'],images:[...first.images,...second.images].map(i=>i.attachment.attachmentId),visualReview:{checked:VISUAL_CHECKS,assessments:[{warningId:'footer-overlap',imageId:image,disposition:'defect',reason:'The actual age and agreement text visibly overlap at this phone size.'}]}};
 const result=inspectResponsiveCheck(run,task,first,input);assert.equal(result.findings.length,1);assert.match(result.findings[0],/age and agreement/);assert.match(result.findings[0],new RegExp(b.id));assert.equal(result.assessmentFindings.length,1);assert.deepEqual(result.observations,input.observations);assert.equal(responsiveStatus(run,task).completed,0);
 assert.throws(()=>inspectResponsiveCheck(run,task,first,{...input,verdict:'pass'}),/Responsive review needs/);
 second.capturedBy='qa';const foreign=inspectResponsiveCheck(run,task,first,input);assert.match(foreign.findings[0],/^Unverified visual defect report:/);assert.match(foreign.findings[0],/not confirmed product evidence/);
 second.capturedBy='user';second.revision--;assert.match(inspectResponsiveCheck(run,task,first,input).findings[0],/^Unverified/);
});

test('matrix includes small/wide phones, tablets, landscape, desktop and accessibility/input/DPR variations with explicit emulation limits',()=>{
 const run=runFixture(),matrix=responsiveMatrix(run);assert.ok(matrix.cases.some(c=>c.width===320));assert.ok(matrix.cases.some(c=>c.width===575));assert.ok(matrix.cases.some(c=>c.width===844&&c.height===390));assert.ok(matrix.cases.some(c=>c.width===1920));
 assert.ok(matrix.cases.some(c=>c.deviceScaleFactor===3));assert.ok(matrix.cases.some(c=>!c.isMobile&&c.hasTouch));assert.ok(matrix.cases.some(c=>c.rootFontScale===2));assert.ok(matrix.cases.some(c=>c.forcedColors==='active'));assert.ok(matrix.cases.some(c=>c.colorScheme==='dark'));assert.ok(matrix.cases.some(c=>c.reducedMotion==='reduce'));assert.match(matrix.limits.strategy,/not.*physical/);
 run.responsiveEngines=[{engine:'chromium',available:true},{engine:'firefox',available:true},{engine:'webkit',available:false,reason:'Not installed'}];const expanded=responsiveMatrix(run);assert.equal(expanded.cases.length,matrix.cases.length*2);assert.ok(expanded.cases.filter(c=>c.engine==='firefox').every(c=>!c.isMobile));assert.equal(expanded.limits.unavailableEngines[0].engine,'webkit');
});

test('actual stylesheet breakpoints add before/at/after cases, accumulate dynamically and become stale after source change',()=>{
 const run=runFixture();mergeResponsiveHints(run,{widths:[425,680],heights:[635],unreadable:['https://cdn.invalid/style.css']});mergeResponsiveHints(run,{widths:[425,850]});let m=responsiveMatrix(run);
 for(const width of [424,425,426,679,680,681])assert.ok(m.cases.some(c=>c.id==='chromium-css-width-'+width));for(const height of [634,635,636])assert.ok(m.cases.some(c=>c.id==='chromium-css-height-'+height));assert.equal(m.limits.unreadableStylesheets.length,1);
 run.revision++;assert.ok(!responsiveMatrix(run).cases.some(c=>c.id==='chromium-css-width-426'));mergeResponsiveHints(run,{widths:[500]});assert.deepEqual(run.responsiveHints.widths,[500]);
});

test('capture is not inspection; missing pixels/warnings, failed/stale and another role evidence cannot satisfy the matrix',()=>{
 const run=runFixture(),task=taskFixture(),item=responsiveMatrix(run).cases[0],check=captured(run,task,item);run.responsiveChecks.push(check);
 assert.equal(responsiveStatus(run,task).completed,0);assert.throws(()=>inspectResponsiveCheck(run,task,check,{...inspection(check),images:[]}),/every planned viewport/);
 assert.throws(()=>inspectResponsiveCheck(run,task,{...check,capturedBy:'qa'},inspection(check)),/own current/);assert.throws(()=>inspectResponsiveCheck(run,task,{...check,revision:3},inspection(check)),/stale responsive capture cannot pass/);
 assert.throws(()=>inspectResponsiveCheck(run,task,{...check,ok:false},inspection(check)),/failed responsive/);
 const warning={id:'logo-over-button',kind:'overlap',targets:[{label:'Brand'},{label:'Facebook'}],images:[check.images[0].attachment.attachmentId]};check.views[0].layout.warnings=[warning];assert.throws(()=>inspectResponsiveCheck(run,task,check,inspection(check)),/Classify/);
 const revised=inspectResponsiveCheck(run,task,check,{verdict:'revise',findings:['The Facebook button visibly covers the logo.'],images:[warning.images[0]]});assert.equal(revised.verdict,'revise');assert.equal(responsiveStatus(run,task).completed,0);
 check.views[0].layout.warnings=[];inspectResponsiveCheck(run,task,check,inspection(check));assert.equal(responsiveStatus(run,task).completed,1);assert.throws(()=>validateResponsiveAcceptance(run,task,{verdict:'pass'}),/incomplete/);
});

test('source revision drift never discards own negative feedback, but historical or foreign evidence cannot pass the current matrix',()=>{
 const run=runFixture(),task=taskFixture(),item=responsiveMatrix(run).cases[0],check=captured(run,task,item);run.responsiveChecks=[check];const pixels=structuredClone(check.images),originalRevision=check.revision,image=check.images[0].attachment.attachmentId;check.views[0].layout.warnings=[{id:'actual-old-overlap',kind:'overlap',images:[image]}];run.revision++;
 const feedback={...inspection(check),verdict:'revise',findings:['The captured dialog extends beyond its phone viewport; current state needs an independent recheck.'],observations:['The local-entry action itself succeeded.'],visualReview:{checked:VISUAL_CHECKS,assessments:[{warningId:'actual-old-overlap',imageId:image,disposition:'defect',reason:'The actual older screenshot shows the same dialog edge cutting the text.'}]}};
 const result=inspectResponsiveCheck(run,task,check,feedback);assert.equal(result.historical,true);assert.equal(result.acceptanceEvidence,false);assert.equal(result.revision,originalRevision);assert.equal(result.reviewedAtRevision,run.revision);assert.match(result.findings[0],/^Historical capture revision/);assert.deepEqual(check.images,pixels);assert.equal(check.revision,originalRevision);assert.equal(responsiveStatus(run,task).completed,0);
 assert.equal(result.findings.length,2);assert.match(result.findings[1],/actual older screenshot/);assert.ok(!result.findings.some(f=>f.includes('Unverified')),'Historic own warning provenance is preserved without pretending the pixels are current.');
 const originalFinding=result.findings[0];run.revision++;assert.equal(inspectResponsiveCheck(run,task,check,feedback).findings[0],originalFinding,'Repeated historical feedback has stable obligation identity despite other source edits.');
 assert.throws(()=>inspectResponsiveCheck(run,task,check,{...feedback,verdict:'pass',findings:[]}),/cannot pass/);assert.throws(()=>inspectResponsiveCheck(run,task,{...check,capturedBy:'qa'},feedback),/own current/);assert.throws(()=>inspectResponsiveCheck(run,task,{...check,taskId:'another-task'},feedback),/own current/);
});

test('saved per-batch inspections cover the current matrix without a giant final citation list, but QA/User remain independent and stale evidence is rejected',()=>{
 const run=runFixture(),user=taskFixture(),qa=taskFixture('qa');
 for(const task of [user,qa]){for(const item of responsiveMatrix(run).cases){const check=captured(run,task,item);run.responsiveChecks.push(check);inspectResponsiveCheck(run,task,check,inspection(check));}assert.equal(responsiveStatus(run,task).ready,true);assert.doesNotThrow(()=>validateResponsiveAcceptance(run,task,{verdict:'pass'}));task.state='done';task.result={verdict:'pass',revision:run.revision};run.tasks.push(task);if(task===user)assert.equal(responsiveRunReady(run),false);}
 assert.equal(responsiveRunReady(run),true);run.revision++;assert.equal(responsiveStatus(run,user).ready,false);assert.equal(responsiveRunReady(run),false);
});

test('User journeys require their exact scenario and real close/reopen traces in every device case; source increments do not claim responsive approval',()=>{
 const run=runFixture(),task=taskFixture();task.userJourneys={scenarios:[{id:'dismiss-options',category:'dismiss',target:'Open and close the Options dialog',expected:'The same dialog closes and reopens.'}]};const item=responsiveMatrix(run).cases[0],check=captured(run,task,item);check.scenarioId=task.userJourneys.scenarios[0].id;check.scenarioKey=scenarioKey(task.userJourneys.scenarios[0]);run.responsiveChecks.push(check);inspectResponsiveCheck(run,task,check,inspection(check));assert.equal(responsiveStatus(run,task).completed,0);
 check.views[0].steps=[{kind:'assertVisible',target:'Options',passed:true},{kind:'press',target:'',passed:true,inputEvents:[{type:'keydown',key:'Escape',trusted:true}]},{kind:'assertHidden',target:'Options',passed:true},{kind:'click',target:'Open',passed:true},{kind:'assertVisible',target:'Options',passed:true}];assert.equal(responsiveStatus(run,task).completed,1);
 const source={...task,kind:'review',reviewFocus:'source',analysisIds:[]};assert.equal(responsiveStatus(run,source).required,false);assert.doesNotThrow(()=>validateResponsiveAcceptance(run,source,{verdict:'pass'}));
});
