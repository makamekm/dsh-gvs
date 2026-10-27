import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {prepareCodePlan,stalePlanFiles,missingPlanOutputs,migrateCodePlan} from '../v3/planning.js';
import {parallelBlocker} from '../v3/parallel.js';
const cwd=path.resolve('fixture'),input=()=>({summary:'Center the report action in the connected remote pane',changes:[{path:'src/report.ts',anchor:'function report()',edit:'Replace the unconditional bottom bar with a centered compact action gated by the actual connected peer.'}],checks:['node report-contract.test.mjs'],acceptance:['Idle has no Report action; connected decoded video has one centered Report action.']});
function storage(){const files=new Map([['src/report.ts',Buffer.from('export function report() { return "old"; }')]]);return {files,read:async file=>{if(!files.has(file))throw Object.assign(Error('missing'),{code:'ENOENT'});return files.get(file);}};}
test('report headings are advisory outputs, while actual code anchors stay strict and CRLF/LF is normalized',async()=>{
 const f=storage();f.files.set('src/report.ts',Buffer.from('export function report() {\r\n return "old";\r\n}'));f.files.set('artifacts/task215/notes.md',Buffer.from('# Actual old heading\nKeep this history.'));
 const value=input();value.changes[0].anchor='function report() {\n';value.changes.push({path:'artifacts/task215/notes.md',anchor:'# Different guessed heading',edit:'Append actual resumed report and preserve earlier evidence.'});
 const plan=await prepareCodePlan(value,{cwd,read:f.read,allowed:()=>true,author:'lead'});assert.equal(plan.sources.length,1);assert.deepEqual(plan.outputs,['artifacts/task215/notes.md']);assert.equal(plan.changes[1].kind,'report');
 f.files.set('artifacts/task215/notes.md',Buffer.from('# Actual old heading\nMore actual diagnostics.'));assert.deepEqual(await stalePlanFiles(plan,f.read),[]);
 f.files.delete('artifacts/task215/notes.md');assert.deepEqual(await missingPlanOutputs(plan,f.read),['artifacts/task215/notes.md']);
 const old={...plan,version:undefined,sources:[...plan.sources,{path:'artifacts/task215/notes.md',sha256:null}],outputs:undefined};assert.deepEqual(migrateCodePlan(old).sources,plan.sources);
 value.changes[0].anchor='invented function';await assert.rejects(prepareCodePlan(value,{cwd,read:f.read,allowed:()=>true,author:'lead'}),/anchor not found/);
});
test('coordinator plans use real source anchors and detect per-file drift without invalidating unrelated parallel work',async()=>{
 const f=storage(),plan=await prepareCodePlan(input(),{cwd,read:f.read,allowed:file=>file==='src/report.ts',author:'lead-session'});
 assert.equal(plan.authoredBy,'lead-session');assert.match(plan.sources[0].sha256,/^[a-f0-9]{64}$/);assert.deepEqual(await stalePlanFiles(plan,f.read),[]);
 f.files.set('unrelated.ts',Buffer.from('other branch'));assert.deepEqual(await stalePlanFiles(plan,f.read),[]);
 f.files.set('src/report.ts',Buffer.from('export function report() { return "changed"; }'));assert.deepEqual(await stalePlanFiles(plan,f.read),['src/report.ts']);
});
test('plans reject invented anchors, out-of-lease/traversal paths and fake new files; actual new files are pinned as absent',async()=>{
 const f=storage(),options={cwd,read:f.read,allowed:()=>true,author:'lead'};
 const bad=input();bad.changes[0].anchor='invented source';await assert.rejects(prepareCodePlan(bad,options),/anchor not found/);
 for(const file of ['../outside.ts','C:/private.ts','src/*.ts','.gvs/state.json']){const value=input();value.changes[0].path=file;await assert.rejects(prepareCodePlan(value,options),/workspace|writeScopes/);}
 await assert.rejects(prepareCodePlan(input(),{...options,allowed:()=>false}),/writeScopes/);
 const fresh=input();fresh.changes[0].anchor=null;await assert.rejects(prepareCodePlan(fresh,options),/already exists/);
 fresh.changes[0].path='src/new.ts';const plan=await prepareCodePlan(fresh,options);assert.equal(plan.sources[0].sha256,null);assert.deepEqual(await stalePlanFiles(plan,f.read),[]);f.files.set('src/new.ts',Buffer.from('created'));assert.deepEqual(await stalePlanFiles(plan,f.read),['src/new.ts']);
});
test('an editor waits for the coordinator plan while independent read/QA work remains eligible; legacy in-flight slices can recover',()=>{
 const run={status:'running',requireCoordinatorPlan:true,roles:[{name:'builder',capability:'edit'},{name:'research',capability:'read'}],tasks:[]},work={id:'work',assignee:'builder',kind:'work',state:'waiting',dependsOn:[],resources:[]};run.tasks=[work];
 assert.equal(parallelBlocker(run,work).kind,'coordinator-plan');
 assert.equal(parallelBlocker(run,{...work,assignee:'research',kind:'discovery'}),null);
 assert.equal(parallelBlocker(run,{...work,planGrandfathered:true}),null);
 assert.equal(parallelBlocker(run,{...work,writeScopes:[]}),null,'Read-only operational work must not invent a code edit');
 assert.equal(parallelBlocker(run,{...work,writeScopes:['dist','artifacts/build']}),null,'A pure build/report operation has no product edit to plan');
 assert.equal(parallelBlocker(run,{...work,codePlan:{summary:'Grounded plan'}}),null);
 assert.equal(parallelBlocker(run,{...work,codePlan:{},planStale:true}).kind,'coordinator-plan');
});
