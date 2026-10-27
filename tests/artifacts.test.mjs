import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {taskArtifacts,isReportFile} from '../v3/artifacts.js';
test('actual artifact discovery returns README rather than invented HANDOFF/INTEGRATION files, including completed legacy tasks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gvs-artifacts-'));
 try{
  await fs.mkdir(path.join(root,'artifacts/safety-module'),{recursive:true});await fs.mkdir(path.join(root,'safety-ui'));
  await fs.writeFile(path.join(root,'artifacts/safety-module/README.md'),'Actual provenance and integration contract');await fs.writeFile(path.join(root,'safety-ui/Component.tsx'),'actual source');
  const io={stat:async file=>{try{const s=await fs.lstat(path.join(root,file));return {type:s.isDirectory()?'directory':s.isSymbolicLink()?'symlink':'file'};}catch(error){if(error.code==='ENOENT')return;throw error;}},list:file=>fs.readdir(path.join(root,file),{withFileTypes:true})};
  const task={id:'task-221',state:'done',writeScopes:['safety-ui','artifacts/safety-module']};const manifest=await taskArtifacts(task,io);
  assert.deepEqual(manifest.files,['artifacts/safety-module/README.md','safety-ui/Component.tsx']);assert.equal(manifest.files.some(file=>/HANDOFF|INTEGRATION/.test(file)),false);assert.equal(manifest.truncated,false);
  task.codePlan={changes:[{path:'artifacts/safety-module/HANDOFF.md'}]};const pending=await taskArtifacts({...task,state:'running'},io);assert.ok(pending.missing.includes('artifacts/safety-module/HANDOFF.md'));assert.match(pending.next,/still working/);
  assert.equal(isReportFile('safety-ui/INTEGRATION.md'),true);assert.equal(isReportFile('artifacts/test/check.mjs'),false);
  const bounded=await taskArtifacts(task,io,{maxEntries:1});assert.equal(bounded.truncated,true);
 }finally{const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('gvs-artifacts-'));await fs.rm(resolved,{recursive:true,force:true});}
});
