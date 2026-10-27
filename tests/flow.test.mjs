import test from 'node:test';import assert from 'node:assert/strict';
import {progressStatus,decisionKey,reusableDecision,modelResult} from '../v3/flow.js';
import {syncGoal,planGoal} from '../v3/goal.js';

test('compound status requests preserve current User decisions while real and mixed steering still invalidates them',()=>{
 const run={tasks:[],analysis:{requirements:[]}};syncGoal(run,[{id:'goal',text:'Build all requested functionality'}]);planGoal(run,{requirements:[{id:'feature',criterion:'Deliver the full feature',sourceIds:['goal']}],assessedMessages:['goal'],expertise:[],staffingRationale:'Known expertise is sufficient.'});
 const task={id:'decision',assignee:'user',kind:'brief',state:'done',result:{verdict:'pass',decisionKey:decisionKey(run)}};run.tasks.push(task);const original=structuredClone(run.goal),key=decisionKey(run);
 syncGoal(run,[{id:'status',text:'Какой статус? Что в процессе и на очереди?'}]);assert.deepEqual(run.goal,original);assert.equal(decisionKey(run),key);assert.equal(reusableDecision(run,'decision'),task);
 syncGoal(run,[{id:'change',text:'Какой статус? Сделай настоящий серверный подбор партнёров.'}]);assert.equal(reusableDecision(run,'decision'),null);assert.equal(run.goal.messages.at(-1).id,'change');
});

test('status classification never deletes historical requirements, findings or already recorded messages',()=>{
 const run={tasks:[],goal:{messages:[{id:'legacy-status',text:'Какой статус?'}],requirements:[{id:'legacy',criterion:'Previously recorded criterion',sourceIds:['legacy-status']}],issues:[{id:'finding',criterion:'Actual overlap'}],assessed:[]}};const before=structuredClone(run.goal);syncGoal(run,[{id:'legacy-status',text:'Какой статус?'},{id:'new-status',text:'Что в процессе и на очереди?'}]);assert.deepEqual(run.goal,before);
});
test('readiness bookkeeping and a long unfinished edit surface actionable intervention without claiming completion',()=>{
 const now=4000000,run={tasks:[],progress:{startedAt:now-800000,metadataSinceWrite:50}};
 const stale=progressStatus(run,now);assert.equal(stale.needsIntervention,true);assert.match(stale.next,/readiness/);assert.equal(stale.writes,0);
 run.progress.lastWriteAt=now-1000;run.progress.metadataSinceWrite=0;run.progress.writes=3;assert.equal(progressStatus(run,now).needsIntervention,false);
 run.tasks=[{id:'mobile',title:'Mobile',assignee:'dev',kind:'work',state:'running',startedAt:now-1300000}];const long=progressStatus(run,now);assert.equal(long.needsIntervention,true);assert.equal(long.overlongWork[0].id,'mobile');assert.match(long.next,/runnable increment/);
});

test('large panel histories stay out of routine model content while explicit results remain available',()=>{
 const team={runId:'same',status:'running',roles:[{name:'dev',state:'running',activity:'Building'}],tasks:Array.from({length:120},()=>({summary:'x'.repeat(1000)})),goal:{ready:false,requirements:29,remainingCount:29,issueCount:171}};
 const model=modelResult({status:'running',gvsTeam:team});assert.ok(JSON.stringify(model).length<1000);assert.equal(model.team.goal.issueCount,171);assert.equal(model.gvsTeam,undefined);assert.equal(team.tasks.length,120);
});
test('decision reuse is tied to real human requirements and evidence criteria, not source revision or cosmetic rationale',()=>{
 const run={tasks:[],revision:1,goal:{messages:[{id:'human',text:'Build it'}],requirements:[{id:'feature',criterion:'Full feature',workTasks:[]}]},analysis:{requirements:[],rationale:'Original'}};
 const task={id:'decision',assignee:'user',kind:'brief',state:'done',result:{verdict:'pass',decisionKey:decisionKey(run)}};run.tasks=[task];assert.equal(reusableDecision(run,'decision'),task);
 run.revision++;run.analysis.rationale='Rephrased';run.goal.requirements[0].workTasks=['build'];assert.equal(reusableDecision(run,'decision'),task);
 run.goal.messages.push({id:'steer',text:'Different human instruction'});assert.equal(reusableDecision(run,'decision'),null);
});
