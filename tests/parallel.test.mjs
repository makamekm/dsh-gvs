import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {normalizeScopes,parallelFields,taskAccess,taskConflict,parallelBlocker,writeAllowed,validateWriteScopes,evidencePath} from '../v3/parallel.js';
const run=()=>({status:'running',roles:[{name:'ui',capability:'edit'},{name:'server',capability:'edit'},{name:'qa',capability:'verify'},{name:'user',capability:'user'}],tasks:[]});
const task=(id,assignee,extra={})=>({id,assignee,state:'waiting',kind:'work',dependsOn:[],...extra});
test('absolute project paths normalize; outside fixtures remain exclusive environment leases without outside Native write permission',()=>{
 const cwd='C:\\Users\\Max\\project';
 const access=parallelFields({writeScopes:['C:\\Users\\Max\\project\\src/**','C:\\Users\\Max\\AppData\\Local\\Fixture\\task152/**'],resources:[]},cwd);
 assert.deepEqual(access.writeScopes,['src']);assert.deepEqual(access.externalWriteScopes,['c:/users/max/appdata/local/fixture/task152']);assert.equal(access.scopeNotices[1].kind,'external-environment-lease');
 const r=run(),a=task('a','ui',{...access}),b=task('b','server',{writeScopes:[],readScopes:[],externalReadScopes:['c:/users/max/appdata/local/fixture/task152/lock'],resources:[]});
 assert.deepEqual(taskConflict(r,a,b).files,['external:c:/users/max/appdata/local/fixture/task152']);
 assert.equal(writeAllowed(a,'C:\\Users\\Max\\AppData\\Local\\Fixture\\task152/file',cwd),false);assert.equal(writeAllowed(a,'C:\\Users\\Max\\project\\other/file',cwd),false);
 for(const file of ['C:/','C:/Users/Max'])assert.throws(()=>parallelFields({writeScopes:[file]},cwd),/bounded fixture/);
 assert.deepEqual(normalizeScopes(['src/app/[id]/**','src/{literal}.ts']),['src/app/[id]','src/{literal}.ts']);
});
test('scope leases distinguish path boundaries, case/separators and shared read inputs',()=>{
 const r=run(),a=task('a','ui',{writeScopes:['UI/**'],readScopes:['shared'],resources:[]}),b=task('b','server',{writeScopes:['backend'],readScopes:['shared'],resources:[]});
 assert.equal(taskConflict(r,a,b),null);assert.deepEqual(normalizeScopes(['.\\UI\\**','ui/']),['ui']);
 assert.equal(taskConflict(r,a,{...b,writeScopes:['shared/types.ts']}).files[0],'shared/types.ts');
 assert.equal(taskConflict(r,a,{...b,writeScopes:['ui-old'],readScopes:[]}),null);
 for(const scope of ['../outside','C:\\private','/tmp','src/*.js',''])assert.throws(()=>normalizeScopes([scope]));
 const cwd=path.resolve('fixture');assert.equal(writeAllowed(a,path.join(cwd,'ui/button.ts'),cwd),true);assert.equal(writeAllowed(a,path.join(cwd,'backend/main.rs'),cwd),false);assert.equal(writeAllowed(a,'../outside',cwd),false);
});
test('legacy tasks remain conservative; explicit isolated reviews and disjoint edits may overlap',()=>{
 const r=run(),editor=task('editor','ui',{state:'running',writeScopes:['ui'],readScopes:['ui'],resources:[]});r.tasks=[editor];
 const isolated=task('qa','qa',{kind:'review',scope:'increment',readScopes:['backend'],resources:[]});assert.equal(parallelBlocker(r,isolated),null);
 assert.equal(parallelBlocker(r,{...isolated,scope:'full'}).kind,'resources','Full final review still reads every source');
 assert.equal(parallelBlocker(r,task('legacy','server')).kind,'resources');
 const decision=task('question','user',{kind:'consultation'});assert.deepEqual(taskAccess(r,decision),{reads:[],writes:[],resources:[]});assert.equal(parallelBlocker(r,decision),null);
});
test('exclusive environments, same-agent work, capacity and real dependencies explain waits',()=>{
 const r=run();r.tasks=[task('one','ui',{state:'running',readScopes:['ui'],writeScopes:['ui'],resources:['db:test']})];
 const other=task('two','server',{readScopes:['backend'],writeScopes:['backend'],resources:['db:test']});assert.equal(parallelBlocker(r,other).conflicts[0].resources[0],'db:test');
 assert.equal(parallelBlocker(r,{...other,resources:[]},1).kind,'parallel-limit');assert.equal(parallelBlocker(r,{...other,assignee:'ui'}).kind,'agent-busy');
 assert.equal(parallelBlocker(r,{...other,dependsOn:['one']}).kind,'dependencies');
 r.status='paused';assert.equal(parallelBlocker(r,other).kind,'run-stopped');
});
test('QA evidence and generated outputs participate in leases without granting product write access',()=>{
 const r=run(),qa=task('a','qa',{writeScopes:['artifacts/runtime-a','dist','node_modules/.cache'],readScopes:['src'],resources:[]});
 assert.deepEqual(taskAccess(r,qa).writes,['artifacts/runtime-a','dist','node_modules/.cache']);validateWriteScopes({capability:'verify'},qa.writeScopes);
 for(const scope of ['src','scripts/analyzer.mjs','backend','*','artifacts','node_modules/react'])assert.throws(()=>validateWriteScopes({capability:'verify'},[scope]));
 const reader=task('b','server',{writeScopes:['backend'],readScopes:['artifacts/runtime-a/handoff.md'],resources:[]});assert.ok(taskConflict(r,qa,reader));
 const independent={...reader,readScopes:['backend']};assert.equal(taskConflict(r,qa,independent),null);
 const cwd=path.resolve('fixture');assert.equal(evidencePath(path.join(cwd,'artifacts/runtime-a/handoff.md'),cwd),true);assert.equal(evidencePath('../artifacts/outside',cwd),false);assert.equal(evidencePath('src/app.js',cwd),false);
});
