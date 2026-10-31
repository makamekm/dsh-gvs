import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';

// Working-tree checkpoints in a private git directory under .gvs. The project's own repository, branch,
// index and history are never touched; the project needs no git repository at all.
const EXCLUDE=['.gvs/','.git/','.claude/','.tools/','.godot/','.venv/','venv/','node_modules/','target/','dist/','build/','.next/','.cache/','coverage/','artifacts/','test-results/','playwright-report/','__pycache__/',
 '*.exe','*.dll','*.pdb','*.ilk','*.exp','*.so','*.dylib','*.o','*.obj','*.lib','*.a','*.pyc','*.class'];
const GIT_CONFIG=['-c','core.autocrlf=false','-c','core.safecrlf=false','-c','core.longpaths=true','-c','safe.directory=*','-c','gc.auto=0','-c','core.quotepath=false'];

export function checkpointStore(cwd,runId,{git='git',timeoutMs=120000}={}){
 const dir=path.join(cwd,'.gvs','checkpoints','repo.git'),ref=`refs/gvs/${runId.replace(/[^\w.-]/g,'-')}`;
 const env={...process.env,GIT_DIR:dir,GIT_WORK_TREE:cwd,GIT_INDEX_FILE:path.join(dir,'gvs-index'),GIT_AUTHOR_NAME:'GVS',GIT_AUTHOR_EMAIL:'gvs@localhost',GIT_COMMITTER_NAME:'GVS',GIT_COMMITTER_EMAIL:'gvs@localhost',GIT_TERMINAL_PROMPT:'0'};
 const run=(args,signal)=>new Promise((resolve,reject)=>{
  execFile(git,[...GIT_CONFIG,...args],{cwd,env,signal,timeout:timeoutMs,maxBuffer:64*1024*1024,windowsHide:true},(error,stdout,stderr)=>{
   if(error)reject(Object.assign(new Error(`git ${args[0]} failed: ${(stderr||error.message).trim().slice(0,600)}`),{code:error.code}));else resolve(stdout.trim());
  });
 });
 async function ready(signal){
  try{await fs.access(path.join(dir,'HEAD'));}catch{await fs.mkdir(dir,{recursive:true});await run(['init','--quiet'],signal);}
  await fs.mkdir(path.join(dir,'info'),{recursive:true});await fs.writeFile(path.join(dir,'info','exclude'),EXCLUDE.join('\n')+'\n');
 }
 const head=signal=>run(['rev-parse','--verify','--quiet',ref],signal).catch(()=>null);
 async function snapshot(label,signal){
  await ready(signal);await run(['add','-A','--',':/'],signal);
  const tree=await run(['write-tree'],signal),parent=await head(signal);
  if(parent&&await run(['rev-parse',`${parent}^{tree}`],signal)===tree)return {id:parent,tree,created:false};
  const id=await run(['commit-tree',tree,...(parent?['-p',parent]:[]),'-m',String(label).slice(0,200)||'checkpoint'],signal);
  await run(['update-ref',ref,id],signal);return {id,tree,created:true};
 }
 return {
  save:snapshot,
  // Restores the exact checkpointed tree: changed files are rewritten, files created since are removed.
  // The current tree is saved first, so a restore can itself be undone.
  async restore(id,signal){
   const target=await run(['rev-parse','--verify',`${id}^{commit}`],signal),before=await snapshot(`before restore of ${target.slice(0,12)}`,signal);
   const added=(await run(['diff','--name-only','--no-renames','-z','--diff-filter=A',target,before.id],signal)).split('\0').filter(Boolean);
   for(const file of added){const resolved=path.resolve(cwd,file);if(resolved.startsWith(cwd+path.sep))await fs.rm(resolved,{force:true});}
   await run(['read-tree',target],signal);await run(['checkout-index','-a','-f'],signal);
   return {restored:target,before:before.id,removed:added.length};
  },
 };
}
