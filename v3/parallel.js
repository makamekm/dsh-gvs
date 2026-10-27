import path from 'node:path';
import {goalStatus} from './goal.js';

// Literal workspace paths (optionally ending in /**), not arbitrary globs.
// Unknown scopes retain a workspace-wide lease; [] is an explicit declaration.
export function normalizeScopes(scopes){
 if(!Array.isArray(scopes))throw new Error('Scopes must be an array of workspace-relative literal files/directories.');
 return [...new Set(scopes.map(value=>{
  if(typeof value!=='string'||!value.trim())throw new Error('An empty scope is ambiguous. Use [] or ["*"].');
  let scope=value.trim().replaceAll('\\','/').replace(/\/\*\*$/,'').replace(/\/+$/,'');
  if(['*','.'].includes(scope))return '*';
  if(/^[a-z]:|^\/|[*?\[\]{}]/i.test(scope)||scope.split('/').some(part=>['..',''].includes(part)))throw new Error('Use literal paths inside the workspace, or * for the entire project.');
  scope=scope.replace(/^\.\//,'').toLowerCase();return scope||'*';
 }))];
}
const overlaps=(a,b)=>a==='*'||b==='*'||a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const shared=(a,b)=>a.filter(left=>b.some(right=>overlaps(left,right)));
export function parallelFields(input){
 const result={};for(const key of ['readScopes','writeScopes'])if(input[key]!==undefined)result[key]=normalizeScopes(input[key]);
 if(input.resources!==undefined){if(!Array.isArray(input.resources)||input.resources.some(name=>typeof name!=='string'||!name.trim()||name.length>128))throw new Error('Resources need nonempty names up to 128 characters.');result.resources=[...new Set(input.resources.map(name=>name.trim().toLowerCase()))];}
 return result;
}
export function taskAccess(run,task){
 const capability=run.roles.find(role=>role.name===task.assignee)?.capability;
 const decision=['brief','consultation'].includes(task.kind);
 const writes=capability==='edit'?normalizeScopes(task.writeScopes??['*']):[];
 const fullReview=['review','design-review','game-review','user-review'].includes(task.kind)&&task.scope!=='increment';
 const reads=decision?[]:fullReview?['*']:[...new Set([...normalizeScopes(task.readScopes??['*']),...writes])];
 const resources=task.resources??(decision||capability==='read'?[]:['project-runtime']);
 return {reads,writes,resources};
}
export function taskConflict(run,task,other){
 const a=taskAccess(run,task),b=taskAccess(run,other);
 const files=[...new Set([...shared(a.writes,[...b.writes,...b.reads]),...shared(b.writes,a.reads)])];
 const resources=a.resources.filter(name=>b.resources.includes(name));
 return files.length||resources.length?{taskId:other.id,assignee:other.assignee,files,resources}:null;
}
export function parallelBlocker(run,task,limit=run.parallelLimit??4){
 if(run.status&&run.status!=='running')return {kind:'run-stopped',status:run.status};
 const role=run.roles.find(role=>role.name===task.assignee);
 if(role?.retired||role?.error)return {kind:'role-unavailable'};
 const missing=(task.dependsOn??[]).filter(id=>run.tasks.find(other=>other.id===id)?.state!=='done');
 if(missing.length)return {kind:'dependencies',taskIds:missing};
 if(role?.capability==='edit'&&!goalStatus(run).discoveryReady)return {kind:'initial-discovery'};
 if(role?.capability!=='user'&&run.analysis&&(run.analysis.state!=='ready'||run.tasks.some(other=>other.kind==='brief'&&other.state!=='done')))return {kind:'user-brief-analysis'};
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
