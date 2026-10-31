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

test('custom Cargo target directories are recognized by actual cache/compiler markers, while similarly named source directories stay hashed',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gvs-source-'));
 try{
  const cache=path.join(cwd,'backend/target-admin');await fs.mkdir(cache,{recursive:true});await fs.writeFile(path.join(cache,'CACHEDIR.TAG'),'Signature: 8a477f597d28d172789f06886806bc55\n# This is a cache created by cargo.');await fs.writeFile(path.join(cache,'.rustc_info.json'),'{}');await fs.writeFile(path.join(cache,'libapp.rlib'),'generated');
  await fs.mkdir(path.join(cwd,'target-source'));await fs.writeFile(path.join(cwd,'target-source/lib.rs'),'actual code');
  const reads=[],observed={...provider,readBytes:async(file,...args)=>{reads.push(file);assert.ok(!file.endsWith('libapp.rlib'),'Do not read compiler binaries as source');return provider.readBytes(file,...args);}};
  const first=await sourceFingerprint(observed,cwd);await fs.writeFile(path.join(cache,'libapp.rlib'),'different generated build');assert.equal(await sourceFingerprint(observed,cwd),first);
  await fs.writeFile(path.join(cwd,'target-source/lib.rs'),'changed actual code');assert.notEqual(await sourceFingerprint(observed,cwd),first);
  await fs.unlink(path.join(cache,'.rustc_info.json'));await assert.rejects(sourceFingerprint(observed,cwd),/Do not read compiler binaries/,'A marker without compiler metadata is not enough to silently omit a source directory');
 }finally{const resolved=path.resolve(cwd);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('gvs-source-'));await fs.rm(resolved,{recursive:true,force:true});}
});
test('a source file above the whole-read cap is hashed by content in windows instead of failing the fingerprint',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gvs-large-'));
 try{
  await fs.writeFile(path.join(cwd,'app.js'),'code');await fs.writeFile(path.join(cwd,'archive.tar.gz'),Buffer.alloc(40*1024*1024,7));
  const ranged={...provider,readBytes:async(name,_signal,max)=>{if(name.endsWith('.tar.gz'))throw Object.assign(new Error('file too large'),{code:'FS_TOO_LARGE'});return provider.readBytes(name,_signal,max);},
   readByteRange:async(name,{offset,length})=>{const handle=await fs.open(name);try{const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,offset);return buffer.subarray(0,bytesRead);}finally{await handle.close();}}};
  const whole=await sourceFingerprint(provider,cwd),windowed=await sourceFingerprint(ranged,cwd);
  assert.equal(windowed,whole,'windowed hashing digests the same bytes');
  await fs.appendFile(path.join(cwd,'archive.tar.gz'),'x');assert.notEqual(await sourceFingerprint(ranged,cwd),whole,'content changes still invalidate evidence');
  const huge={...ranged,lstat:async name=>({...await provider.lstat(name),...(name.endsWith('.tar.gz')?{size:600*1024*1024}:{})})};
  await assert.rejects(sourceFingerprint(huge,cwd),/exceeds 512 MiB at archive\.tar\.gz/,'the total source budget still fails closed');
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
test('other agents\' .claude worktrees are not product source',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'gvs-claude-'));
 try{
  await fs.writeFile(path.join(cwd,'app.js'),'code');const first=await sourceFingerprint(provider,cwd);
  await fs.mkdir(path.join(cwd,'.claude','worktrees','copy'),{recursive:true});await fs.writeFile(path.join(cwd,'.claude','worktrees','copy','app.js'),'other agent copy');
  assert.equal(await sourceFingerprint(provider,cwd),first);
  await fs.writeFile(path.join(cwd,'app.js'),'changed');assert.notEqual(await sourceFingerprint(provider,cwd),first);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
