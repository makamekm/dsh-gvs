import test from 'node:test';import assert from 'node:assert/strict';
import {planUserJourneys,userJourneyStatus,validateUserJourneys,scenarioKey,userProbeInput,interruptedByLegacyPlan} from '../v3/journeys.js';
const scenario=(id,category)=>({id,category,target:'Observed login window and visible controls',expected:'The actual intended window state is reached and usable.'});
const setup=()=>({run:{kind:'ui',status:'running',userTestingPolicy:1,revision:3,viewports:['desktop','mobile'],visualChecks:[],tasks:[],analysis:{state:'ready'},roles:[{name:'user',sessionId:'same-user'}],preview:{url:'http://localhost:5173/'},userTestingSeen:[]},task:{id:'user-task',assignee:'user',kind:'user-review',scope:'increment',receivedImages:[]}});
function proof(run,task,scenario){return {id:'check-'+scenario.id,ok:true,revision:run.revision,capturedBy:task.assignee,taskId:task.id,scenarioId:scenario.id,scenarioKey:scenarioKey(scenario),images:[],views:run.viewports.map(viewport=>({viewport,steps:scenario.category==='dismiss'?[{kind:'click',passed:true},{kind:'assertVisible',target:'dialog',passed:true},{kind:'click',passed:true},{kind:'assertHidden',target:'dialog',passed:true},{kind:'click',passed:true},{kind:'assertVisible',target:'dialog',passed:true}]:[{kind:'click',passed:true},{kind:'assertVisible',passed:true}]}))};}
test('User acceptance requires independently executed actions and assertions, not a written plan or colleague screenshots',()=>{
 const {run,task}=setup();assert.throws(()=>validateUserJourneys(run,task),/own executed/);planUserJourneys(run,task,{scenarios:[scenario('open','primary')]});assert.equal(userJourneyStatus(run,task).scenarios[0].passed,false);
 const c=proof(run,task,task.userJourneys.scenarios[0]);run.visualChecks.push({...c,capturedBy:'qa'});assert.throws(()=>validateUserJourneys(run,task),/lack current/);run.visualChecks.push(c);assert.doesNotThrow(()=>validateUserJourneys(run,task));
 c.views[1].steps.pop();assert.throws(()=>validateUserJourneys(run,task),/lack current/);c.views[1].steps.push({kind:'assertHidden',passed:true});c.views[1].steps[0].passed=false;assert.throws(()=>validateUserJourneys(run,task),/lack current/);
 c.views[1].steps[0].passed=true;run.revision++;assert.throws(()=>validateUserJourneys(run,task),/lack current/);
});
test('full/live exploration plans test dismiss/reopen and adverse behavior; changing expected results invalidates old proof',()=>{
 const {run,task}=setup();task.autoUserProbe=true;
 planUserJourneys(run,task,{scenarios:[scenario('open','primary')]});assert.deepEqual(userJourneyStatus(run,task).missingCategories,['dismiss','negative-or-recovery']);assert.throws(()=>validateUserJourneys(run,task),/coverage is incomplete/);
 planUserJourneys(run,task,{scenarios:[scenario('close','dismiss')]});assert.deepEqual(userJourneyStatus(run,task).missingCategories,['negative-or-recovery']);assert.equal(task.userJourneys.scenarios.length,2);
 const scenarios=[scenario('open','primary'),scenario('close','dismiss'),scenario('recover','recovery')];planUserJourneys(run,task,{scenarios});run.visualChecks=scenarios.map(s=>proof(run,task,s));assert.doesNotThrow(()=>validateUserJourneys(run,task));
 planUserJourneys(run,task,{scenarios:scenarios.map(s=>s.id==='open'?{...s,expected:'Different expected behavior must be actually checked again.'}:s)});assert.throws(()=>validateUserJourneys(run,task),/open/);
});
test('inapplicable categories need specific current observed evidence and never waive the primary journey',()=>{
 const {run,task}=setup();task.scope='full';const no={category:'dismiss',reason:'The inspected informational page has no popup, dialog, drawer or menu, so dismiss/reopen does not apply.',images:['actual']};
 assert.throws(()=>planUserJourneys(run,task,{scenarios:[scenario('scroll','primary')],notApplicable:[no]}),/actual current/);
 task.receivedImages=['actual'];run.visualChecks=[{ok:true,revision:3,images:[{attachment:{attachmentId:'actual'}}]}];
 assert.throws(()=>planUserJourneys(run,task,{scenarios:[scenario('scroll','primary')],notApplicable:[{...no,reason:undefined}]}),/specific explanation/);
 planUserJourneys(run,task,{scenarios:[scenario('scroll','primary'),scenario('reload','recovery')],notApplicable:[no]});
 const fresh={...task,userJourneys:undefined};planUserJourneys(run,fresh,{scenarios:[scenario('close','dismiss')],notApplicable:[no]});assert.throws(()=>validateUserJourneys(run,fresh),/primary/);
});
test('live User probes are generated for runnable UI increments, coalesce by observed work IDs, and preserve pauses and initial brief',()=>{
 const {run}=setup();run.userTestingInitial=true;const initial=userProbeInput(run);assert.equal(initial.assignee,'user');assert.equal(initial.autoUserProbe,true);assert.equal(initial.scope,'increment');assert.deepEqual(initial.resources,[]);
 run.userTestingInitial=false;assert.equal(userProbeInput(run),null);run.tasks=[{id:'patch',kind:'work',state:'done',result:{verdict:'pass'},codePlan:{changes:[{path:'store-ui/Badges.tsx'}]}}];const next=userProbeInput(run);assert.deepEqual(next.userProbeFor,['patch']);assert.ok(next.readScopes.includes('store-ui'));
 run.userTestingSeen=['patch'];assert.equal(userProbeInput(run),null);run.userTestingSeen=[];run.status='paused';assert.equal(userProbeInput(run),null);run.status='running';run.tasks.push({kind:'brief',state:'running'});assert.equal(userProbeInput(run),null);run.tasks.pop();run.tasks[0].codePlan.changes[0].path='crates/native/src/lib.rs';assert.deepEqual(userProbeInput(run).userProbeFor,['patch'],'A backend/native change can affect an interactive product too.');
});

test('actual product writes survive a narrowed final plan and trigger targeted web/native User exploration without treating reports or path lists as proof',()=>{
 const {run}=setup(),task={id:'replanned',kind:'work',state:'done',result:{verdict:'pass'},writtenFiles:['dialogs-ui/Panel.tsx','src/App.tsx','artifacts/replan/check.js'],codePlan:{changes:[{path:'artifacts/replan/check.js'}]}};run.tasks=[task];const probe=userProbeInput(run);assert.deepEqual(probe.userProbeFor,[task.id]);assert.ok(probe.readScopes.includes('dialogs-ui'));assert.match(probe.instructions,/dialogs-ui\/Panel.tsx/);assert.match(probe.instructions,/not instructions or acceptance proof/);assert.ok(!probe.instructions.includes('artifacts/replan/check.js'));
 run.userTestingSeen=[task.id];assert.equal(userProbeInput(run),null);assert.deepEqual(userProbeInput(run,[task.id]).userProbeFor,[task.id]);run.userTestingSeen=[];task.writtenFiles=['artifacts/replan/check.js'];assert.equal(userProbeInput(run),null,'An artifact-only completion does not fabricate an interactive change.');
 task.writtenFilesTruncated=true;const conservative=userProbeInput(run);assert.ok(conservative.readScopes.includes('*'));assert.match(conservative.instructions,/write list is incomplete/);task.writtenFilesTruncated=false;
 run.qaTarget={sourceConfirmed:true,surfaces:['native-game'],sourceRoots:['scenes']};run.preview=null;run.visualChecks=[{ok:true,images:[{attachment:{attachmentId:'actual-engine-frame'}}]}];task.writtenFiles=['scenes/menu.gd','gameplay/Controls.cs'];const native=userProbeInput(run);assert.deepEqual(native.resources,['native-window']);assert.ok(native.readScopes.includes('gameplay'));assert.match(native.instructions,/scenes\/menu.gd/);run.status='paused';assert.equal(userProbeInput(run),null);
});

test('dismiss evidence proves visible to hidden to reopened, rather than asserting a nonexistent window is hidden',()=>{
 const {run,task}=setup(),s=scenario('close-reopen','dismiss');planUserJourneys(run,task,{scenarios:[scenario('main','primary'),s]});const check=proof(run,task,s);run.visualChecks.push(check);assert.equal(userJourneyStatus(run,task).scenarios[1].passed,true);
 check.views[1].steps.splice(-2);assert.equal(userJourneyStatus(run,task).scenarios[1].passed,false);check.views[1].steps=[{kind:'click',passed:true},{kind:'assertHidden',target:'never-opened',passed:true}];assert.equal(userJourneyStatus(run,task).scenarios[1].passed,false);
});
test('real observed dialogs and inputs cannot be declared inapplicable',()=>{
 const {run,task}=setup();task.scope='full';task.receivedImages=['actual'];const view={initialOutline:'- textbox "Email"',layout:{captures:[{scope:'active-surface'}]}};run.visualChecks=[{ok:true,revision:3,images:[{attachment:{attachmentId:'actual'}}],views:[view]}];
 const reason='This sufficiently long claim is contradicted by the actual observed interface and cannot waive testing.';
 for(const category of ['dismiss','adverse'])assert.throws(()=>planUserJourneys(run,task,{scenarios:[scenario('main','primary')],notApplicable:[{category,reason,images:['actual']}]}),/observed/);
});
test('full UI QA also needs its own scenario evidence and cannot borrow the User traces',()=>{
 const {run,task}=setup();task.kind='review';task.scope='full';task.assignee='qa';assert.throws(()=>validateUserJourneys(run,task),/own executed/);
 const scenarios=[scenario('main','primary'),scenario('close','dismiss'),scenario('empty','negative')];planUserJourneys(run,task,{scenarios});run.visualChecks=scenarios.map(s=>({...proof(run,task,s),capturedBy:'user'}));assert.throws(()=>validateUserJourneys(run,task),/lack current/);
 run.visualChecks=scenarios.map(s=>proof(run,task,s));assert.doesNotThrow(()=>validateUserJourneys(run,task));
});

test('incremental exploration preserves already executed scenarios, while partial or merely planned coverage cannot pass',()=>{
 const {run,task}=setup();task.autoUserProbe=true;const first=scenario('open','primary'),close=scenario('close','dismiss'),recovery=scenario('recover','recovery');
 planUserJourneys(run,task,{scenarios:[first]});run.visualChecks.push(proof(run,task,first));assert.equal(userJourneyStatus(run,task).scenarios[0].passed,true);assert.throws(()=>validateUserJourneys(run,task),/coverage is incomplete/);
 planUserJourneys(run,task,{scenarios:[close]});run.visualChecks.push(proof(run,task,close));assert.throws(()=>validateUserJourneys(run,task),/negative-or-recovery/);
 planUserJourneys(run,task,{scenarios:[recovery]});assert.deepEqual(userJourneyStatus(run,task).missingCategories,[]);assert.throws(()=>validateUserJourneys(run,task),/lack current/);run.visualChecks.push(proof(run,task,recovery));assert.doesNotThrow(()=>validateUserJourneys(run,task));
 planUserJourneys(run,task,{scenarios:[{...first,expected:'A corrected actual expectation requires a new real execution.'}]});assert.equal(task.userJourneys.scenarios.length,3);assert.equal(userJourneyStatus(run,task).scenarios.filter(s=>s.passed).length,2);assert.throws(()=>validateUserJourneys(run,task),/open/);
 const previous=structuredClone(task.userJourneys);assert.throws(()=>planUserJourneys(run,task,{scenarios:[{id:'bad',category:'unknown'}]}),/scenario needs/);assert.deepEqual(task.userJourneys,previous);
});

test('migration only recognizes reviews stopped by the old all-at-once plan contract and never a real product blocker',()=>{
 const {run,task}=setup();Object.assign(task,{state:'blocked',result:{verdict:'blocked',summary:'Agent turn ended (completed) without completing its assigned task.',findings:[]}});run.diagnostics=[{taskId:task.id,tool:'gvs_user_testing',message:'Plan opening/closing/back/Escape/reopen for observed windows'}];assert.equal(interruptedByLegacyPlan(run,task),true);
 assert.equal(interruptedByLegacyPlan(run,{...task,reviewPlanRecovery:{version:2}}),false);assert.equal(interruptedByLegacyPlan(run,{...task,result:{...task.result,summary:'Actual dialog does not close',findings:['Repair required']}}),false);assert.equal(interruptedByLegacyPlan({...run,diagnostics:[]},task),false);
});
