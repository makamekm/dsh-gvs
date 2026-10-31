import path from 'node:path';
import {createHash} from 'node:crypto';

// Source, assets, tests, configuration and reference inputs are hashed. Generated
// outputs and other agents' state (.claude worktrees are full repository copies) do not
// invalidate the source evidence that produced those outputs.
const generated=new Set(['.git','.gvs','.claude','.tools','.godot','.venv','node_modules','target','dist','build','.next','.cache','coverage','artifacts','test-results','playwright-report']);
// Compiled binaries and objects are build products of the hashed sources, wherever a build copies them.
const compiled=/\.(?:exe|dll|pdb|ilk|exp|so|dylib|o|obj|lib|a|pyc|class)$/i;
const MAX_CHANGED_FILES=200;
async function cargoOutput(fs,cwd,directory,signal){
 const marker=path.join(directory,'CACHEDIR.TAG'),compiler=path.join(directory,'.rustc_info.json');
 try{
  if((await fs.lstat(marker,{cwd},signal))?.type!=='file'||(await fs.lstat(compiler,{cwd},signal))?.type!=='file')return false;
  const bytes=await fs.readBytes(await fs.resolve(marker,{cwd,signal}),signal,1024);
  return new TextDecoder().decode(bytes).startsWith('Signature: 8a477f597d28d172789f06886806bc55');
 }catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return false;throw error;}
}
const MAX_SOURCE_BYTES=512*1024*1024,WHOLE_READ=64*1024*1024,WINDOW=16*1024*1024;
// Content digest of one file; files above the whole-read cap are hashed in bounded windows.
async function digestFile(fs,target,signal,budget){
 try{const data=await fs.readBytes(target,signal,WHOLE_READ);return {size:data.length,digest:createHash('sha256').update(data).digest()};}
 catch(error){if(error.code!=='FS_TOO_LARGE'&&!/too large/i.test(error.message))throw error;}
 const hash=createHash('sha256');let size=0;
 for(;;){
  signal?.throwIfAborted();
  const part=await fs.readByteRange(target,{offset:size,length:WINDOW},signal);
  hash.update(part);size+=part.length;
  if(size>budget)return {size};
  if(part.length<WINDOW)return {size,digest:hash.digest()};
 }
}
export async function sourceFingerprint(fs,cwd,signal,cache=new Map(),files){
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
   if(info.type==='directory'){if(!await cargoOutput(fs,cwd,absolute,signal))await walk(resolved,name);continue;}
   if(info.type!=='file')throw new Error(`Unsupported source input: ${name}`);
   if(compiled.test(child.name))continue;
   let cached=cache.get(name);
   const tooLarge=()=>new Error(`Source fingerprint exceeds 512 MiB at ${name}; inspect whether this is a generated output or select a smaller project workspace.`);
   if(bytes+(info.size??0)>MAX_SOURCE_BYTES)throw tooLarge();
   if(!info.version||cached?.version!==info.version){
    const file=await digestFile(fs,resolved,signal,MAX_SOURCE_BYTES-bytes);
    if(!file.digest)throw tooLarge();
    cached={version:info.version,...file};cache.set(name,cached);
   }
   bytes+=cached.size;if(bytes>MAX_SOURCE_BYTES)throw tooLarge();
   hash.update(JSON.stringify(name)).update('\0').update(cached.digest);
   files?.set(name.replaceAll('\\','/').toLowerCase(),cached.digest.toString('hex'));
  }
 }
 await walk(root);return hash.digest('hex');
}
// Which files one revision changed; complete:false (unknown after a restart or too many) affects every scope.
export function changedFiles(before,after,revision){
 if(!before)return {revision,files:[],complete:false};
 const files=[...new Set([...before.keys(),...after.keys()])].filter(name=>before.get(name)!==after.get(name)).sort();
 return files.length>MAX_CHANGED_FILES?{revision,files:files.slice(0,MAX_CHANGED_FILES),complete:false}:{revision,files,complete:true};
}
export async function refreshRevision(entry,fs,signal){
 const run=entry.run;
 try{
  entry.sourceCache??=new Map();const files=new Map(),fingerprint=await sourceFingerprint(fs,entry.io.cwd,signal,entry.sourceCache,files);
  if(run.sourceFingerprint&&run.sourceFingerprint!==fingerprint){run.revision++;if(run.goal)delete run.goal.handoff;run.revisionLog=[...(run.revisionLog??[]),changedFiles(entry.sourceFiles,files,run.revision)].slice(-400);}
  entry.sourceFiles=files;run.sourceFingerprint=fingerprint;delete run.sourceError;
 }catch(error){
  signal?.throwIfAborted();run.sourceError=error.message;
 }
}
