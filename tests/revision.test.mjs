import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {sourceFingerprint,refreshRevision} from '../v3/revision.js';
const provider={resolve:async name=>name,contains:(root,child)=>child===root||child.startsWith(root+path.sep),
 listDir:async directory=>(await fs.readdir(directory,{withFileTypes:true})).map(entry=>({name:entry.name})),
 lstat:async name=>{const s=await fs.lstat(name);return {type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other'};},readBytes:async name=>fs.readFile(name)};
test('source fingerprints ignore generated results, detect assets/config/code changes and deletions, and fail closed on unreadable inputs',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gvs-source-'));
 try{
  await fs.writeFile(path.join(cwd,'app.js'),'original');await fs.mkdir(path.join(cwd,'artifacts'));await fs.writeFile(path.join(cwd,'artifacts','report.json'),'old');
  const first=await sourceFingerprint(provider,cwd);await fs.writeFile(path.join(cwd,'artifacts','report.json'),'fresh');assert.equal(await sourceFingerprint(provider,cwd),first);
  const entry={io:{cwd},run:{revision:7,sourceFingerprint:first,goal:{handoff:{reason:'old'}}}};
  await refreshRevision(entry,provider);assert.equal(entry.run.revision,7);
  await fs.writeFile(path.join(cwd,'texture.png'),'new source asset');await refreshRevision(entry,provider);assert.equal(entry.run.revision,8);assert.equal(entry.run.goal.handoff,undefined);
  await fs.unlink(path.join(cwd,'app.js'));await refreshRevision(entry,provider);assert.equal(entry.run.revision,9);
  await refreshRevision(entry,{...provider,readBytes:async()=>{throw new Error('Access denied');}});assert.match(entry.run.sourceError,/Access denied/);
 }finally{
  assert.ok(path.resolve(cwd).startsWith(path.resolve(os.tmpdir())+path.sep+'gvs-source-'));await fs.rm(cwd,{recursive:true,force:true});
 }
});
