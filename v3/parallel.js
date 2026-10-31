import path from 'node:path';
import {goalStatus,setReviewReads} from './goal.js';
import {needsPreview} from './preview.js';
import {needsCodePlan} from './planning.js';

// Literal workspace paths (optionally ending in /**), not arbitrary globs.
// Unknown scopes retain a workspace-wide lease; [] is an explicit declaration.
export function normalizeScopes(scopes){
 if(!Array.isArray(scopes))throw new Error('Scopes must be an array of workspace-relative literal files/directories.');
 return [...new Set(scopes.map(value=>{
  if(typeof value!=='string'||!value.trim())throw new Error('An empty scope is ambiguous. Use [] or ["*"].');
  let scope=value.trim().replaceAll('\\','/').replace(/\/\*\*$/,'').replace(/\/+$/,'');
  if(['*','.','**'].includes(scope))return '*';
  if(/^[a-z]:|^\/|[*?]/i.test(scope)||scope.split('/').some(part=>['..',''].includes(part)))throw new Error(`Invalid workspace scope ${JSON.stringify(value)}. Use a literal project path (optional /**), not a glob or traversal.`);
  scope=scope.replace(/^\.\//,'').toLowerCase();return scope||'*';
 }))];
}
const overlaps=(a,b)=>a==='*'||b==='*'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const shared=(a,b)=>a.filter(left=>b.some(right=>overlaps(left,right)));
const reportRoots=['artifacts','test-results','playwright-report'];
const outputRoots=['dist','build','coverage','node_modules/.tmp','node_modules/.cache','node_modules/.vite','node_modules/.vite-temp'];
// Cargo build output (target, or a custom target-* dir) may sit inside any crate, e.g. backend/target.
const generatedOutput=scope=>outputRoots.some(root=>scope===root||scope.startsWith(root+'/'))||/(^|\/)target(-[\w-]+)?(\/|$)/.test(scope);
export function validateWriteScopes(role,scopes=[]){
 if(role.capability==='edit')return;
 const writes=normalizeScopes(scopes);
 if(writes.length&&(role.capability!=='verify'||writes.some(scope=>!reportRoots.some(root=>scope.startsWith(root+'/'))&&!generatedOutput(scope))))throw new Error(`Verify writeScopes may contain only specific report/evidence paths (${reportRoots.map(root=>root+'/...').join(', ')}) and generated build/cache outputs (${outputRoots.join(', ')}, Cargo target or target-* in any crate). Product source, scripts and whole-workspace writes require an edit role.`);
}
export function evidencePath(target,cwd){
 const relative=path.relative(cwd,path.resolve(cwd,target)).replaceAll('\\','/').toLowerCase();
 return reportRoots.some(root=>relative.startsWith(root+'/'));
}
export function parallelFields(input,cwd){
 const result={},notices=[];
 for(const [key,externalKey] of [['readScopes','externalReadScopes'],['writeScopes','externalWriteScopes']]){
  if(input[key]===undefined&&input[externalKey]===undefined)continue;
  const relative=[],external=[];
  function classify(value,explicitExternal=false){
   if(typeof value!=='string')throw new Error('Scope paths must be strings.');
   const file=value.trim().replace(/[\\/]\*\*$/,'');
   const absolute=/^[a-z]:[\\/]|^[\\/]/i.test(file);
   if(!absolute){if(explicitExternal)throw new Error('External environment leases require an absolute bounded path.');relative.push(value);return;}
   if(!cwd)throw new Error('Absolute scope requires the current workspace to normalize its boundary.');
   const api=/^[a-z]:|^\\\\/i.test(cwd)?path.win32:path.posix;
   if(/[*?]/.test(file))throw new Error('Absolute environment scopes must be literal paths, optionally ending in /**.');
   const target=api.resolve(cwd,file),delta=api.relative(cwd,target);
   if(!delta||(!api.isAbsolute(delta)&&delta!=='..'&&!delta.startsWith('..'+api.sep))){relative.push(delta||'*');notices.push({path:value,kind:'workspace-absolute',normalized:delta||'*'});return;}
   const ancestor=api.relative(target,cwd);
   if(target===api.parse(target).root||(!api.isAbsolute(ancestor)&&ancestor!=='..'&&!ancestor.startsWith('..'+api.sep)))throw new Error('External environment lease must name a bounded fixture, not a drive root or workspace ancestor.');
   const normalized=target.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();external.push(normalized);
   notices.push({path:value,kind:'external-environment-lease',normalized,note:'Exclusive scheduling metadata only. Native permissions remain authoritative; this does not grant outside-workspace write/edit access.'});
  }
  if(input[key]!==undefined){if(!Array.isArray(input[key]))throw new Error('Scopes must be arrays.');for(const value of input[key])classify(value);result[key]=normalizeScopes(relative);}
  if(input[externalKey]!==undefined){if(!Array.isArray(input[externalKey]))throw new Error('External scopes must be arrays.');for(const value of input[externalKey])classify(value,true);}
  if(relative.length&&input[key]===undefined)result[key]=normalizeScopes(relative);
  if(external.length||input[externalKey]!==undefined)result[externalKey]=[...new Set(external)];
 }
 if(input.resources!==undefined){if(!Array.isArray(input.resources)||input.resources.some(name=>typeof name!=='string'||!name.trim()||name.length>128))throw new Error('Resources need nonempty names up to 128 characters.');result.resources=[...new Set(input.resources.map(name=>name.trim().toLowerCase()))];}
 if(notices.length)result.scopeNotices=notices;
 return result;
}
setReviewReads((run,task)=>{try{return taskAccess(run,task).reads;}catch{return null;}});
export function taskAccess(run,task){
 const capability=run.roles.find(role=>role.name===task.assignee)?.capability;
 const decision=['brief','consultation'].includes(task.kind);
 const writes=capability==='edit'?normalizeScopes(task.writeScopes??['*']):capability==='verify'?normalizeScopes(task.writeScopes??[]):[];
 const fullReview=['review','design-review','game-review','user-review'].includes(task.kind)&&task.scope!=='increment';
 const reads=decision?[]:fullReview?['*']:[...new Set([...normalizeScopes(task.readScopes??['*']),...writes])];
 const resources=task.resources??(decision||capability==='read'?[]:['project-runtime']);
 const externalWrites=task.externalWriteScopes??[],externalReads=[...new Set([...(task.externalReadScopes??[]),...externalWrites])];
 return {reads,writes,resources,...(externalReads.length||externalWrites.length?{externalReads,externalWrites}:{})};
}
export function taskConflict(run,task,other){
 const a=taskAccess(run,task),b=taskAccess(run,other);
 const external=[...shared(a.externalWrites??[],b.externalReads??[]),...shared(b.externalWrites??[],a.externalReads??[])];
 const files=[...new Set([...shared(a.writes,[...b.writes,...b.reads]),...shared(b.writes,a.reads),...external.map(file=>'external:'+file)])];
 const resources=a.resources.filter(name=>b.resources.includes(name));
 return files.length||resources.length?{taskId:other.id,assignee:other.assignee,files,resources}:null;
}
export function runningAccessChange(run,task,patch){
 const next={...task,...patch},before=taskAccess(run,task),after=taskAccess(run,next);
 const same=(a=[],b=[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 if(next.assignee!==task.assignee||!['writes','resources','externalWrites'].every(key=>same(before[key],after[key])))return {kind:'exclusive-lease-change'};
 if(same(before.reads,after.reads)&&same(before.externalReads,after.externalReads))return null;
 // Expand read access only: never drop the scope that protects an in-flight read.
 if(!before.reads.every(file=>after.reads.some(scope=>scope==='*'||file===scope||file.startsWith(scope+'/')))||!(before.externalReads??[]).every(file=>(after.externalReads??[]).some(scope=>file===scope||file.startsWith(scope+'/'))))return {kind:'read-lease-contraction'};
 const conflicts=run.tasks.filter(other=>other.id!==task.id&&other.state==='running').map(other=>taskConflict(run,next,other)).filter(Boolean);
 return conflicts.length?{kind:'resources',conflicts}:null;
}
export function parallelBlocker(run,task,limit=run.parallelLimit??4){
 if(run.status&&run.status!=='running')return {kind:'run-stopped',status:run.status};
 const role=run.roles.find(role=>role.name===task.assignee);
 if(role?.retired||role?.error)return {kind:'role-unavailable'};
 const missing=(task.dependsOn??[]).filter(id=>run.tasks.find(other=>other.id===id)?.state!=='done');
 if(missing.length)return {kind:'dependencies',taskIds:missing};
 if(needsCodePlan(run,task)&&(!task.codePlan||task.planStale))return {kind:'coordinator-plan',stale:task.planStale??false,files:task.stalePlanFiles??[],next:'Coordinator inspects current files and supplies gvs_task update codePlan before implementation starts.'};
 if(task.waitForPreviewRecovery&&run.preview?.ready!==true&&taskAccess(run,task).resources.some(r=>r==='project-runtime'||r.startsWith('preview:')))return {kind:'preview-recovery',url:run.preview?.url,next:'Restore the existing managed preview and confirm actual HTTP readiness before retrying this service-interrupted runtime task.'};
 if(role?.capability==='edit'&&!goalStatus(run).discoveryReady)return {kind:'initial-discovery'};
 if(role?.capability!=='user'&&run.analysis&&(run.analysis.state!=='ready'||run.tasks.some(other=>other.kind==='brief'&&other.state!=='done')))return {kind:'user-brief-analysis'};
 if(needsPreview(run,task)&&run.preview.ready===false)return {kind:'preview-not-ready',url:run.preview.url};
 const running=run.tasks.filter(other=>other.state==='running'),busy=running.filter(other=>other.assignee===task.assignee);
 if(busy.length)return {kind:'agent-busy',taskIds:busy.map(other=>other.id)};
 const conflicts=running.map(other=>taskConflict(run,task,other)).filter(Boolean);
 if(conflicts.length)return {kind:'resources',conflicts};
 if(task.assignee!=='user'&&running.filter(other=>other.assignee!=='user').length>=limit)return {kind:'parallel-limit',limit};
 return null;
}
export function parallelStatus(run,limit=run.parallelLimit??4){
 const waiting=run.tasks.filter(task=>task.state==='waiting');
 return {limit,active:run.tasks.filter(task=>task.state==='running').map(task=>({id:task.id,assignee:task.assignee,...taskAccess(run,task)})),
  waiting:waiting.slice(0,40).map(task=>({id:task.id,assignee:task.assignee,reason:parallelBlocker(run,task,limit)})),waitingCount:waiting.length,truncated:waiting.length>40};
}
export function writeAllowed(task,target,cwd){
 const relative=path.relative(cwd,path.resolve(cwd,target)).replaceAll('\\','/').toLowerCase();
 if(!relative||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))return false;
 return normalizeScopes(task.writeScopes??['*']).some(scope=>scope==='*'||relative===scope||relative.startsWith(scope+'/'));
}
