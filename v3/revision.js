import path from 'node:path';
import {createHash} from 'node:crypto';

// Source, assets, tests, configuration and reference inputs are hashed. Generated
// outputs do not invalidate the source evidence that produced those outputs.
const generated=new Set(['.git','.gvs','.tools','.godot','.venv','node_modules','target','dist','build','.next','.cache','coverage','artifacts','test-results','playwright-report']);
export async function sourceFingerprint(fs,cwd,signal,cache=new Map()){
 const root=await fs.resolve(cwd,{cwd,signal}),hash=createHash('sha256');let count=0,bytes=0;
 async function walk(target,relative=''){
  const children=await fs.listDir(target,signal);
  for(const child of children.sort((a,b)=>a.name.localeCompare(b.name))){
   signal?.throwIfAborted();
   if(generated.has(child.name))continue;
   if(++count>50000)throw new Error('Source fingerprint exceeds 50000 entries; define a smaller project workspace.');
   const name=path.join(relative,child.name),absolute=path.join(cwd,name);
   const info=await fs.lstat(absolute,{cwd},signal);
   if(!info)throw new Error(`Source changed during fingerprint: ${name}`);
   const resolved=await fs.resolve(absolute,{cwd,signal});
   if(!fs.contains(root,resolved))throw new Error(`Source input outside workspace: ${name}`);
   if(info.type==='symlink')throw new Error(`Source symlink requires an explicit in-workspace copy for verification: ${name}`);
   if(info.type==='directory'){await walk(resolved,name);continue;}
   if(info.type!=='file')throw new Error(`Unsupported source input: ${name}`);
   let cached=cache.get(name);
   if(!info.version||cached?.version!==info.version){
    const data=await fs.readBytes(resolved,signal,64*1024*1024);
    cached={version:info.version,size:data.length,digest:createHash('sha256').update(data).digest()};cache.set(name,cached);
   }
   bytes+=cached.size;if(bytes>512*1024*1024)throw new Error('Source fingerprint exceeds 512 MiB; select a smaller project workspace.');
   hash.update(JSON.stringify(name)).update('\0').update(cached.digest);
  }
 }
 await walk(root);return hash.digest('hex');
}
export async function refreshRevision(entry,fs,signal){
 const run=entry.run;
 try{
  entry.sourceCache??=new Map();const fingerprint=await sourceFingerprint(fs,entry.io.cwd,signal,entry.sourceCache);
  if(run.sourceFingerprint&&run.sourceFingerprint!==fingerprint){run.revision++;if(run.goal)delete run.goal.handoff;}
  run.sourceFingerprint=fingerprint;delete run.sourceError;
 }catch(error){
  signal?.throwIfAborted();run.sourceError=error.message;
 }
}
