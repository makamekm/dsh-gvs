import test from 'node:test';import assert from 'node:assert/strict';
import {progressStatus,decisionKey,reusableDecision,modelResult} from '../v3/flow.js';
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
