import test from 'node:test';import assert from 'node:assert/strict';
import {syncGoal,planGoal,linkGoal,recordFindings,goalStatus,resolvedBlocker} from '../v3/goal.js';
const done=(id,assignee,kind='work',revision=1)=>({id,assignee,kind,state:'done',result:{verdict:'pass',findings:[],revision,scopeReviewed:true,coveredRequirements:['feature']}});
function run(text='Build the requested feature'){
 const run={revision:1,tasks:[]};syncGoal(run,[{id:'human',text}]);
 planGoal(run,{requirements:[{id:'feature',criterion:'Complete requested feature',sourceIds:['human']}],assessedMessages:['human'],expertise:[],staffingRationale:'Existing fixture roles suffice'});return run;
}
test('requirements preserve real human sources and cannot be weakened or dropped by a later plan',()=>{
 const r=run();assert.throws(()=>planGoal(r,{requirements:[{id:'feature',criterion:'Just a prototype',sourceIds:['human']}]}),/immutable/);
 assert.throws(()=>planGoal(r,{requirements:[{id:'invented',criterion:'Fake scope permission',sourceIds:['simulated-user']}]}),/actual human/);
 syncGoal(r,[{id:'steer',text:'Also deliver the mobile version'}]);assert.equal(goalStatus(r).unassessed.length,1);
 assert.throws(()=>planGoal(r,{requirements:[{id:'feature',criterion:'Complete requested feature',sourceIds:['human']}],assessedMessages:['steer']}),/covered/);
 planGoal(r,{requirements:[{id:'mobile',criterion:'Deliver mobile version',sourceIds:['steer']}],assessedMessages:['steer'],expertise:[],staffingRationale:'Reuse existing roles'});assert.equal(r.goal.requirements.length,2);
});
test('a local pass cannot close the human goal without implementation and current independent review for every requirement',()=>{
 const r=run();r.tasks=[done('build','dev'),done('qa','qa','review')];assert.equal(goalStatus(r).ready,false);
 linkGoal(r,{id:'feature',workTasks:['build'],reviewTasks:['qa']});assert.equal(goalStatus(r).ready,true);
 r.revision++;assert.equal(goalStatus(r).ready,false);r.tasks[1].result.revision=2;assert.equal(goalStatus(r).ready,true);
 r.tasks[1].assignee='dev';assert.equal(goalStatus(r).ready,false);
});
test('every rejection becomes a durable issue that a subsequent pass cannot erase',()=>{
 const r=run();const rejected={id:'old-review',assignee:'qa',kind:'design-review',state:'blocked',result:{verdict:'blocked',findings:['Missing original noise','No mobile parity'],summary:'Needs repair'}};
 r.tasks=[rejected,done('repair','dev'),done('recheck','qa','design-review')];recordFindings(r,rejected);recordFindings(r,rejected);
 assert.equal(r.goal.issues.length,2);assert.equal(resolvedBlocker(r,rejected),false);
 r.tasks[2].result.addressedIssues=r.goal.issues.map(item=>item.id);
 for(const issue of r.goal.issues)linkGoal(r,{issueId:issue.id,workTasks:['repair'],reviewTasks:['recheck']});
 assert.equal(resolvedBlocker(r,rejected),true);r.revision++;assert.equal(resolvedBlocker(r,rejected),false);
});
test('full reverse engineering requires a source-backed feature inventory mapped to the preserved goal',()=>{
 const r=run('Сделай реверс и весь функционал 1 в 1');r.tasks=[done('build','dev'),done('qa','qa','review')];linkGoal(r,{id:'feature',workTasks:['build'],reviewTasks:['qa']});
 assert.equal(goalStatus(r).discoveryReady,false);const discovery=done('discover','architect','discovery');r.tasks.push(discovery);
 discovery.result.inventory=[{feature:'Moderation camera notifications',evidence:'source.js notification handler',status:'confirmed',requirementIds:['missing']}];assert.equal(goalStatus(r).ready,false);
 discovery.result.inventory[0].requirementIds=['feature'];assert.equal(goalStatus(r).ready,true);
});

test('a later focused investigation never freezes unrelated work or erases unresolved acceptance gates',()=>{
 const r=run('Full reverse 1 в 1');const known=done('known','researcher','discovery');known.result.inventory=[{feature:'Known mobile layout',evidence:'Actual CSS',status:'confirmed',requirementIds:['feature']}];r.tasks=[known];assert.equal(goalStatus(r).discoveryReady,true);
 r.tasks.push({id:'followup',kind:'discovery',state:'waiting',dependsOn:[],assignee:'researcher'});assert.equal(goalStatus(r).discoveryReady,true);assert.equal(goalStatus(r).ready,false);
 r.tasks[1].state='blocked';r.tasks[1].result={verdict:'blocked',summary:'Unknown unrelated admin contract',findings:['Missing admin implementation']};recordFindings(r,r.tasks[1]);assert.equal(goalStatus(r).discoveryReady,true);assert.equal(goalStatus(r).issues.length,1);assert.equal(goalStatus(r).ready,false);
});

test('an incremental review cannot attest a complete requirement or bypass full goal acceptance',()=>{
 const r=run();r.tasks=[done('build','dev'),{...done('focused','qa','review'),scope:'increment'}];linkGoal(r,{id:'feature',workTasks:['build'],reviewTasks:['focused']});assert.equal(goalStatus(r).ready,false);
 r.tasks[1].scope='full';assert.equal(goalStatus(r).ready,true);
 r.tasks.push({...done('checkpoint','qa','review'),scope:'increment'});linkGoal(r,{id:'feature',reviewTasks:['checkpoint','focused']});assert.equal(goalStatus(r).ready,true);
});
test('the team must infer needed expertise and actually assign specialists work before goal acceptance',()=>{
 const r=run();r.roles=[{name:'dev',capability:'edit'},{name:'qa',capability:'verify'}];r.tasks=[done('build','dev'),done('qa','qa','review')];linkGoal(r,{id:'feature',workTasks:['build'],reviewTasks:['qa']});
 planGoal(r,{requirements:[{id:'feature',criterion:'Complete requested feature',sourceIds:['human']}],assessedMessages:['human'],expertise:[{id:'protocol-research',purpose:'Unknown protocol requires source-level investigation',capability:'read'}],staffingRationale:'Discovery revealed an unowned protocol risk'});
 assert.equal(goalStatus(r).staffingReady,false);assert.equal(goalStatus(r).ready,false);
 r.roles.push({name:'researcher',capability:'read',sessionId:'real-researcher'});assert.throws(()=>linkGoal(r,{roleNeedId:'protocol-research',agentName:'researcher',taskId:'absent'}),/actual task/);
 r.tasks.push(done('inspect','researcher'));linkGoal(r,{roleNeedId:'protocol-research',agentName:'researcher',taskId:'inspect'});assert.equal(goalStatus(r).ready,true);
});

test('a registered verify specialist can satisfy independent read expertise with its real assigned discovery task, without creating a replacement role',()=>{
 const r=run();r.roles=[{name:'reverse',capability:'verify',sessionId:'existing-reverse'},{name:'editor',capability:'edit',sessionId:'existing-editor'}];r.tasks=[{id:'inspect-source',kind:'discovery',assignee:'reverse',state:'running'},{id:'implement',kind:'work',assignee:'editor',state:'running'}];
 r.goal.roleNeeds=[{id:'source-discovery',capability:'read',purpose:'Independent source inspection'}];r.goal.roleRequests=[{id:'need-read-input',capability:'read',purpose:'Inspect captured source'}];
 for(const link of [{roleNeedId:'source-discovery'},{requestId:'need-read-input'}])assert.doesNotThrow(()=>linkGoal(r,{...link,agentName:'reverse',taskId:'inspect-source'}));assert.ok(goalStatus(r).expertise.every(n=>n.assigned));assert.equal(r.roles.length,2);
 assert.throws(()=>linkGoal(r,{roleNeedId:'source-discovery',agentName:'editor',taskId:'implement'}),/edit\/User roles do not replace/);
 assert.throws(()=>linkGoal(r,{requestId:'need-read-input',agentName:'editor',taskId:'inspect-source'}),/currently assigned to reverse/);
 r.tasks[0].assignee='editor';assert.ok(goalStatus(r).expertise.every(n=>!n.assigned));
 r.goal.roleNeeds.push({id:'must-verify',capability:'verify'});r.roles.push({name:'reader',capability:'read',sessionId:'read-only'});r.tasks.push({id:'read-task',assignee:'reader'});assert.throws(()=>linkGoal(r,{roleNeedId:'must-verify',agentName:'reader',taskId:'read-task'}),/requires verify/);
});
