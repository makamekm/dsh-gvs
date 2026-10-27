import path from 'node:path';
import {createHash} from 'node:crypto';
import {isReportFile} from './artifacts.js';
export const CODE_PLANNING='COORDINATOR OWNS CODE PLANNING. Top-level Lead inspects current production files and actual reference/runtime evidence, resolves UX/architecture with the existing User/specialists, and authors codePlan on each edit work task: summary, changes[{path,anchor,edit}], checks (exact executable foreground commands), acceptance (observable outcomes). anchor is an exact CURRENT source fragment or sha256:<actual file hash>; null is only a genuinely new source file. Text handoff/report files are outputs, not code anchors: preserve earlier notes, and discover their real paths with gvs_artifacts rather than inventing HANDOFF.md/INTEGRATION.md. Generated report headings do not gate product code planning. edit describes the precise before/after change and relevant functions/selectors/data flow, not just a vague goal. The Host pins source hashes; a missing/stale plan prevents dispatch. Use gvs_task update to plan existing queued tasks; preserve IDs, full requirements, scopes and independent QA. Existing in-flight legacy work can finish its slice during migration. Do not create more analysis/approval roles instead of a concrete plan. Independent plans/implementations can still run in parallel. Lead coordinates and plans; delegate actual product file edits to edit specialists. Executors read the plan, implement it, run its exact checks and return actual evidence. No self-directed redesign, scope reduction, fake completion or replacing the requested behavior with a convenient alternative. If source changed, a plan is impossible, or a necessary deviation appears, message lead with the exact evidence and get a corrected plan; do not blindly apply stale code. QA/User independently compare the actual result to the real human/reference goal AND the intended plan; a faithfully executed bad plan must be rejected and corrected by Lead. Gates and current human steering remain binding.';
export class CodePlanSourceError extends Error{
 constructor(message,file,bytes,reason){super(message);this.code='GVS_PLAN_SOURCE_MISMATCH';this.recovery={reason,path:file,exists:bytes!==null,bytes:bytes?.length??0,sha256:bytes===null?null:createHash('sha256').update(bytes).digest('hex'),nextRead:{tool:'read',file_path:file,offset:1,limit:80}};}
}
export function needsCodePlan(run,task){
 const generated=['artifacts','test-results','playwright-report','dist','build','coverage','node_modules'];
 const sourceWrites=(task.writeScopes??['*']).some(scope=>!generated.some(root=>{const value=scope.replaceAll('\\','/').replace(/\/\*\*$/,'').toLowerCase();return value===root||value.startsWith(root+'/');}));
 return run.requireCoordinatorPlan===true&&task.kind==='work'&&sourceWrites&&!(task.planGrandfathered===true&&!task.codePlan)&&run.roles.find(role=>role.name===task.assignee)?.capability==='edit';
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function nonempty(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Code plan needs ${label} (1–${max} characters).`);return value.trim();}
async function source(read,file){try{return await read(file);}catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return null;throw error;}}
export async function prepareCodePlan(input,{cwd,read,allowed,author}){
 const summary=nonempty(input?.summary,'a concrete implementation summary',2000);
 if(!Array.isArray(input.changes)||!input.changes.length||input.changes.length>16)throw new Error('Code plan needs 1–16 exact file changes.');
 for(const key of ['checks','acceptance'])if(!Array.isArray(input[key])||!input[key].length||input[key].length>12)throw new Error(`Code plan needs 1–12 ${key}.`);
 const checks=input.checks.map(value=>nonempty(value,'an exact validation command',4000)),acceptance=input.acceptance.map(value=>nonempty(value,'an observable acceptance criterion',2000));
 const changes=[],sources=new Map(),outputs=new Set(),notices=[];
 for(const item of input.changes){
  const file=nonempty(item.path,'a literal workspace file path',300);
  if(path.isAbsolute(file)||/^[a-z]:|[*?]/iu.test(file)||file.replaceAll('\\','/').split('/').includes('..'))throw new Error('Code plan paths must be literal files inside the workspace.');
  const relative=path.relative(cwd,path.resolve(cwd,file)).replaceAll('\\','/');
  if(!relative||relative.startsWith('../')||relative.toLowerCase()==='.gvs'||relative.toLowerCase().startsWith('.gvs/')||!allowed(relative))throw new Error(`Planned file is outside the assigned writeScopes: ${file}`);
  const bytes=await source(read,relative),sha256=bytes===null?null:hash(bytes);
  const report=isReportFile(relative);
  if(report){outputs.add(relative);notices.push({path:relative,kind:'report-output',note:'Append/update the actual report while preserving earlier evidence; a prose heading is not a product-source anchor.'});}
  else if(item.anchor===null){if(bytes!==null)throw new CodePlanSourceError(`Code plan marks ${file} as new, but it already exists. Inspect the actual file.`,relative,bytes,'existing-file-marked-new');outputs.add(relative);}
  else{
   const anchor=nonempty(item.anchor,'an exact existing source anchor (or null for a new file)',2000);
   if(bytes===null||!(anchor===`sha256:${sha256}`||new TextDecoder().decode(bytes).replace(/\r\n?/g,'\n').includes(anchor.replace(/\r\n?/g,'\n'))))throw new CodePlanSourceError(`Code plan anchor not found in ${file}. Coordinator must inspect the current source and correct the plan.`,relative,bytes,bytes===null?'missing-source-file':'missing-current-anchor');
  }
  changes.push({path:relative,anchor:item.anchor,edit:nonempty(item.edit,'a precise before/after edit instruction',6000),...(report?{kind:'report'}:{})});
  if(!report)sources.set(relative,{path:relative,sha256});
 }
 return {version:2,summary,changes,checks,acceptance,sources:[...sources.values()],outputs:[...outputs],notices,authoredBy:author,plannedAt:new Date().toISOString()};
}
export function migrateCodePlan(plan){
 if(!plan||plan.version===2)return plan;
 const reports=new Set(plan.changes.filter(change=>isReportFile(change.path)).map(change=>change.path));
 return {...plan,version:2,changes:plan.changes.map(change=>reports.has(change.path)?{...change,kind:'report'}:change),sources:plan.sources.filter(item=>!reports.has(item.path)),outputs:[...new Set([...(plan.outputs??[]),...reports,...plan.sources.filter(item=>item.sha256===null).map(item=>item.path)])]};
}
export async function missingPlanOutputs(plan,read){const missing=[];for(const file of plan.outputs??[]){const bytes=await source(read,file);if(bytes===null||isReportFile(file)&&!new TextDecoder().decode(bytes).trim())missing.push(file);}return missing;}
export async function stalePlanFiles(plan,read){
 const current=await planSources(plan,read);
 return current.filter((item,index)=>item.sha256!==plan.sources[index].sha256).map(item=>item.path);
}
export async function planSources(plan,read){const current=[];for(const item of plan.sources){const bytes=await source(read,item.path);current.push({path:item.path,sha256:bytes===null?null:hash(bytes)});}return current;}
