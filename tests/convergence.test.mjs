import test from 'node:test';import assert from 'node:assert/strict';
import {syncGoal,planGoal,recordFindings,goalStatus,autoLink,reviewCurrent} from '../v3/goal.js';
import '../v3/parallel.js';
import {changedFiles} from '../v3/revision.js';
import {inheritSelection,CLASS_TARGETS} from '../v3/models.js';
function run(){
 const run={revision:1,tasks:[],roles:[{name:'dev',capability:'edit'},{name:'qa',capability:'verify'}]};syncGoal(run,[{id:'human',text:'Build the feature'}]);
 planGoal(run,{requirements:[{id:'feature',criterion:'Complete requested feature',sourceIds:['human']}],assessedMessages:['human'],expertise:[],staffingRationale:'Fixture roles suffice'});return run;
}
const finished=(id,assignee,kind,result,extra={})=>({id,assignee,kind,state:'done',...extra,result:{verdict:'pass',findings:[],revision:1,...result}});

test('revision log names the changed files; unknown or oversized changes are marked incomplete',()=>{
 const before=new Map([['src/a.js','1'],['src/b.js','2']]),after=new Map([['src/a.js','1'],['src/b.js','3'],['docs/c.md','4']]);
 assert.deepEqual(changedFiles(before,after,2),{revision:2,files:['docs/c.md','src/b.js'],complete:true});
 assert.deepEqual(changedFiles(undefined,after,2),{revision:2,files:[],complete:false});
 const many=new Map([...Array(250).keys()].map(i=>[`f${i}`,'x']));assert.equal(changedFiles(new Map(),many,3).complete,false);
});

test('a scoped recheck stays current only while later changes are outside the paths it read; full reviews never carry over',()=>{
 const r=run();r.revision=3;r.revisionLog=[{revision:2,files:['backend/src/auth.rs'],complete:true},{revision:3,files:['docs/readme.md'],complete:true}];
 const recheck={result:{revision:1}};
 assert.equal(reviewCurrent(r,recheck,['src']),true);
 assert.equal(reviewCurrent(r,recheck,['backend']),false);
 assert.equal(reviewCurrent(r,recheck,['*']),false,'whole-workspace reviews need a fresh pass');
 assert.equal(reviewCurrent(r,recheck,null),false);
 r.revisionLog[1].complete=false;assert.equal(reviewCurrent(r,recheck,['src']),false,'an unknown change set fails closed');
 assert.equal(reviewCurrent(r,{result:{revision:3}},['*']),true);
});

test('a scoped issue recheck survives an unrelated later change through goal proof',()=>{
 const r=run();
 r.tasks.push({id:'review-1',assignee:'qa',kind:'review',state:'done',scope:'increment',readScopes:['src'],result:{verdict:'revise',findings:['src/app.js crashes on empty input'],revision:1}});
 const [issue]=recordFindings(r,r.tasks[0]);
 r.tasks.push(finished('fix-1','dev','work',{addressedIssues:[issue.id]},{writeScopes:['src']}),finished('recheck-1','qa','review',{addressedIssues:[issue.id]},{scope:'increment',readScopes:['src']}));
 autoLink(r,r.tasks[1]);autoLink(r,r.tasks[2]);
 assert.equal(goalStatus(r).issues[0].resolved,true);
 r.revision=2;r.revisionLog=[{revision:2,files:['backend/main.rs'],complete:true}];
 assert.equal(goalStatus(r).issues[0].resolved,true,'outside the recheck scope');
 r.revision=3;r.revisionLog.push({revision:3,files:['src/app.js'],complete:true});
 assert.equal(goalStatus(r).issues[0].resolved,false,'a change inside the recheck scope reopens it');
});

test('passing results that name requirements and issues are linked automatically; failing ones are not',()=>{
 const r=run();
 const work=finished('w','dev','work',{coveredRequirements:['feature']}),review=finished('v','qa','review',{coveredRequirements:['feature'],scopeReviewed:true});
 const failed={...finished('x','dev','work',{coveredRequirements:['feature']}),result:{verdict:'revise',findings:['still broken'],coveredRequirements:['feature'],revision:1}};
 r.tasks.push(work,review,failed);
 assert.deepEqual(autoLink(r,work),['feature']);assert.deepEqual(autoLink(r,review),['feature']);assert.deepEqual(autoLink(r,failed),[]);
 assert.deepEqual(autoLink(r,work),[],'linking is idempotent');
 assert.deepEqual(r.goal.requirements[0].workTasks,['w']);assert.deepEqual(r.goal.requirements[0].reviewTasks,['v']);
 assert.equal(goalStatus(r).requirements[0].accepted,true);
});

test('restated duplicates merge into one open issue, while new defects and resolved regressions stay separate',()=>{
 const r=run();
 const first={id:'r1',result:{verdict:'revise',findings:['Login dialog footer button overlaps the agreement link on phone width 390'],summary:''}};
 const again={id:'r2',result:{verdict:'revise',findings:['On phone width 390 the login dialog footer button overlaps the agreement link'],summary:''}};
 const other={id:'r3',result:{verdict:'revise',findings:['Websocket reconnect drops queued chat messages after network loss'],summary:''}};
 assert.equal(recordFindings(r,first).length,1);assert.equal(recordFindings(r,again).length,0);assert.equal(recordFindings(r,other).length,1);
 assert.equal(r.goal.issues.length,2);assert.deepEqual(r.goal.issues[0].reportedBy,['r2']);
});

test('minor findings are tracked as backlog without blocking a verified goal; blocking issues still block',()=>{
 const r=run();
 r.tasks.push(finished('w','dev','work',{coveredRequirements:['feature']}),finished('v','qa','review',{coveredRequirements:['feature'],scopeReviewed:true}));
 for(const task of r.tasks)autoLink(r,task);
 assert.equal(recordFindings(r,r.tasks[1],{backlog:true,findings:['Button hover colour could be slightly warmer']}).length,1);
 let status=goalStatus(r);assert.equal(status.ready,true);assert.equal(status.backlog,1);assert.equal(status.blockingIssues,0);
 recordFindings(r,{id:'v2',result:{verdict:'revise',findings:['src/app.js throws on submit'],summary:''}});
 status=goalStatus(r);assert.equal(status.ready,false);assert.equal(status.blockingIssues,1);assert.deepEqual(status.issueGroups,[{area:'src',count:1,ids:[r.goal.issues.at(-1).id]}]);
});

test('role classes route every teammate of a capability; a named override still wins',()=>{
 const base={provider:'cloud',model:'large',reasoningEffort:'high'},local={provider:'bb',model:'qwen',reasoningEffort:null};
 assert.deepEqual(CLASS_TARGETS,['@edit','@verify','@read','@user']);
 assert.deepEqual(inheritSelection(base,{},{},local),{provider:'bb',model:'qwen'});
 assert.deepEqual(inheritSelection(base,{},{provider:'cloud',model:'large'},local),{provider:'cloud',model:'large'});
 assert.deepEqual(inheritSelection(base,{provider:'team',model:'mid'},{},{}),{provider:'team',model:'mid',reasoningEffort:'high'});
});
