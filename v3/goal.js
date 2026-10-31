import {createHash} from 'node:crypto';
import {isStatusText} from './requests.js';

export const fullTransfer=text=>/1\s*в\s*1|пиксел|pixel.{0,15}pixel|реверс|reverse.{0,5}engineer|весь функционал|полны[йяоеую]+\s+(?:перенос|копи|функционал)/iu.test(text);
export function syncGoal(run,messages){
 if(!run.goal)run.goal={version:1,autonomous:true,messages:[],requirements:[],issues:[],assessed:[],discoveryRequired:false};
 const goal=run.goal;
 for(const message of messages??[]){
  if(isStatusText(message.text))continue;
  if(goal.messages.some(item=>item.id===message.id))continue;
  goal.messages.push({id:message.id,text:message.text});
  goal.discoveryRequired ||= fullTransfer(message.text);
  delete goal.handoff;
 }
 return goal;
}
export function planGoal(run,{requirements,assessedMessages,expertise,staffingRationale,discoveryRequired}){
 const goal=run.goal;
 // An expertise-only update keeps the existing requirements; assessed messages must still be covered by them.
 if(!requirements?.length&&!(Array.isArray(expertise)&&goal.requirements.length))throw new Error('Record concrete requirements from the real human messages.');
 if(requirements!==undefined&&!Array.isArray(requirements))throw new Error('requirements must be an array.');
 const proposed=structuredClone(goal.requirements),ids=new Set(goal.messages.map(item=>item.id));
 for(const [index,item] of (requirements??[]).entries()){
  const invalid=(field,reason,details={})=>{throw new Error(`Each requirement needs an id, a criterion and actual human sourceIds. ${JSON.stringify({code:'GOAL_REQUIREMENT_INVALID',path:`requirements[${index}].${field}`,reason,...details})} Read gvs_goal action:status and copy exact humanMessages[].id values (paginate with nextOffset). Task IDs, requirement IDs and guessed/transcribed message IDs are not human sources. No changes applied; correct this field, keeping valid criteria unchanged. You may submit the valid requirements separately; unresolved human messages remain unassessed and still block completion.`);};
  if(!item||typeof item!=='object'||Array.isArray(item))invalid('item','Expected a requirement object.');
  if(typeof item.id!=='string'||!/^[a-z][a-z0-9-]{0,59}$/.test(item.id))invalid('id','Use 1..60 lowercase letters/digits/hyphens, starting with a letter.');
  if(typeof item.criterion!=='string'||!item.criterion.trim())invalid('criterion','Provide the concrete nonempty human requirement as text.');
  if(!Array.isArray(item.sourceIds)||!item.sourceIds.length)invalid('sourceIds','Provide a nonempty array of exact human message IDs.');
  const unknown=item.sourceIds.filter(id=>typeof id!=='string'||!ids.has(id));
  if(unknown.length)invalid('sourceIds','Unknown human message IDs; do not guess or silently substitute another message.',{unknownSourceIds:unknown.slice(0,4),unknownSourceIdsTruncated:unknown.length>4,unassessedSourceIds:goal.messages.filter(m=>!(goal.assessed??[]).includes(m.id)).slice(0,6).map(m=>m.id)});
  const previous=proposed.find(req=>req.id===item.id);
  if(previous&&previous.criterion!==item.criterion)throw new Error('Existing requirements are immutable. Add the additional requirement; do not silently reduce the contract.');
  if(previous)previous.sourceIds=[...new Set([...previous.sourceIds,...item.sourceIds])];
  if(!previous)proposed.push({...item,workTasks:[],reviewTasks:[]});
 }
 if((assessedMessages??[]).some(id=>!ids.has(id)||!proposed.some(req=>req.sourceIds.includes(id))))throw new Error('Every assessed human message must be covered by a requirement.');
 if(!Array.isArray(expertise)||!staffingRationale?.trim())throw new Error('Assess needed expertise from the goal, risks and unknowns. Provide expertise (possibly []) and staffingRationale; the human does not select specialist roles.');
 const needs=structuredClone(goal.roleNeeds??[]);
 for(const item of expertise){
  if(!/^[a-z][a-z0-9-]{0,59}$/.test(item.id)||!item.purpose?.trim()||!['read','edit','verify'].includes(item.capability))throw new Error('Each expertise need requires a concrete purpose, id and read/edit/verify capability.');
  if(!needs.some(need=>need.id===item.id))needs.push({...item,agent:null,taskId:null});
 }
 goal.requirements=proposed;goal.assessed=[...new Set([...goal.assessed,...(assessedMessages??[])])];
 goal.roleNeeds=needs;goal.staffingRationale=staffingRationale;goal.discoveryRequired ||= discoveryRequired===true;
 delete goal.handoff;
}
const passed=task=>task?.state==='done'&&task.result?.verdict==='pass'&&!task.result.findings?.length;
// A scoped recheck stays current while later revisions change only files outside the scopes it read.
// Full reviews read the whole workspace, so any change still requires fresh full acceptance.
const within=(file,scope)=>scope==='*'||file===scope||file.startsWith(scope+'/');
export function reviewCurrent(run,task,reads){
 const at=task?.result?.revision;
 if(at===run.revision)return true;
 if(!Number.isInteger(at)||at>run.revision||!reads?.length||reads.includes('*'))return false;
 for(let revision=at+1;revision<=run.revision;revision++){
  const change=run.revisionLog?.find(item=>item.revision===revision);
  if(!change?.complete||change.files.some(file=>reads.some(scope=>within(file,scope))))return false;
 }
 return true;
}
export function expertiseRoleSuitable(need,role){return !!role?.sessionId&&!role.retired&&!role.error&&(!need.capability||role.capability===need.capability||need.capability==='read'&&role.capability==='verify');}
let reviewReads=()=>null;
// Injected by parallel.js (which imports this module) to avoid a module cycle.
export function setReviewReads(fn){reviewReads=fn;}
function proof(run,item){
 const work=item.workTasks.map(id=>run.tasks.find(task=>task.id===id));
 const issue=!!item.taskId;
 const reviews=item.reviewTasks.map(id=>run.tasks.find(task=>task.id===id)).filter(task=>issue||task?.scope!=='increment');
 return work.length>0&&work.every(passed)&&reviews.length>0&&reviews.every(task=>passed(task)&&reviewCurrent(run,task,reviewReads(run,task))&&['review','design-review','game-review','user-review'].includes(task.kind)&&!work.some(implementation=>implementation.assignee===task.assignee)&&
  (issue?task.result.addressedIssues:task.result.coveredRequirements)?.includes(item.id))&&(issue||reviews.some(task=>task.result.scopeReviewed===true));
}
export function linkGoal(run,{id,issueId,workTasks,reviewTasks,roleNeedId,requestId,agentName,taskId}){
 if(roleNeedId||requestId){
  const need=roleNeedId?run.goal.roleNeeds?.find(item=>item.id===roleNeedId):run.goal.roleRequests?.find(item=>item.id===requestId);
  const role=run.roles.find(role=>role.name===agentName),task=run.tasks.find(task=>task.id===taskId);
  if(!need)throw new Error(`Unknown expertise ${roleNeedId?'roleNeedId':'requestId'} ${roleNeedId??requestId}. Read gvs_goal status and copy the exact existing ID; no changes applied.`);
  if(!task||task.assignee!==agentName)throw new Error(`Expertise ${need.id} needs an actual task assigned to ${agentName}. ${task?`${task.id} is currently assigned to ${task.assignee}; use its current owner or schedule a suitable owned task.`:`Unknown task ${taskId}.`} No new role is needed merely to correct an ID/owner.`);
  if(!expertiseRoleSuitable(need,role))throw new Error(`Expertise ${need.id} requires ${need.capability}; role ${agentName} has ${role?.capability??'no registered capability'}${role?.sessionId?'':' and no successful registration'}. Use a registered suitable role and its actual task. Verify roles also satisfy read-only expertise; edit/User roles do not replace independent read/verify roles.`);
  need.agent=agentName;need.taskId=taskId;delete run.goal.handoff;return need;
 }
 const item=issueId?run.goal.issues.find(item=>item.id===issueId):run.goal.requirements.find(item=>item.id===id);
 if(!item)throw new Error(`Unknown ${issueId?'issue':'requirement'} ${JSON.stringify(issueId??id)}. Read gvs_goal status and copy the exact existing ID; no changes applied.`);
 for(const taskId of [...(workTasks??[]),...(reviewTasks??[])])if(!run.tasks.some(task=>task.id===taskId))throw new Error(`Unknown task ${taskId}`);
 for(const taskId of reviewTasks??[]){const kind=run.tasks.find(task=>task.id===taskId).kind;if(!['review','design-review','game-review','user-review'].includes(kind))throw new Error(`Review links must name independent review tasks: ${taskId} is kind ${kind}. Put work/discovery tasks in workTasks; no changes applied.`);}
 if(workTasks)item.workTasks=[...new Set(workTasks)];
 // Explicitly replace superseded review attempts; findings remain durable issues.
 if(reviewTasks)item.reviewTasks=[...new Set(reviewTasks)];
 delete run.goal.handoff;
 return item;
}
// Words and paths that identify what a finding is about; used to merge restated duplicates.
const terms=text=>new Set(String(text).toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu)??[]);
function duplicateOf(run,finding){
 const own=terms(finding);if(own.size<5)return null;
 return run.goal.issues.find(item=>{
  if(item.backlog)return false;
  const other=terms(item.criterion);if(other.size<5)return false;
  let shared=0;for(const term of own)if(other.has(term))shared++;
  return shared/Math.min(own.size,other.size)>=0.8&&!proof(run,item);
 })??null;
}
// backlog:true records optional polish that is tracked but does not block the goal.
export function recordFindings(run,task,{backlog=false,findings}={}){
 if(!run.goal||!backlog&&!['revise','blocked'].includes(task.result?.verdict))return [];
 const created=[];
 for(const finding of findings??(task.result.findings.length?task.result.findings:[task.result.summary])){
  const id='issue-'+createHash('sha256').update(task.id+'\0'+finding).digest('hex').slice(0,14);
  if(run.goal.issues.some(item=>item.id===id))continue;
  const duplicate=!backlog&&duplicateOf(run,finding);
  if(duplicate){duplicate.reportedBy=[...new Set([...(duplicate.reportedBy??[]),task.id])].slice(-20);continue;}
  const issue={id,taskId:task.id,criterion:finding,workTasks:[],reviewTasks:[],...(backlog?{backlog:true}:{})};
  run.goal.issues.push(issue);created.push(issue);
 }
 if(!backlog)delete run.goal.handoff;
 return created;
}
// A passing result that names the requirements/issues it covers is linked to them automatically, so the
// coordinator does not hand-maintain the ledger. proof() still demands independent current attestation.
export function autoLink(run,task){
 if(!run.goal||task.state!=='done'||task.result?.verdict!=='pass')return [];
 const review=['review','design-review','game-review','user-review'].includes(task.kind),work=task.kind==='work';
 if(!review&&!work)return [];
 const linked=[],field=review?'reviewTasks':'workTasks';
 for(const [list,ids] of [[run.goal.requirements,task.result.coveredRequirements??[]],[run.goal.issues,task.result.addressedIssues??[]]])
  for(const item of list)if(ids.includes(item.id)&&!item[field].includes(task.id)){item[field]=[...item[field],task.id];linked.push(item.id);}
 return linked;
}
// Open blocking issues grouped by the source area they name, so repairs can be batched per area.
function issueGroups(issues){
 const groups=new Map();
 for(const issue of issues){
  const file=String(issue.criterion).match(/[\w.-]+(?:[\/][\w.-]+)*\.(?:tsx?|jsx?|mjs|cjs|rs|css|scss|html|json|py|go|java|kt|swift|cs|cpp|c|h|vue|svelte|toml|ya?ml|md)\b/i)?.[0];
  const area=file?file.replaceAll('\\','/').split('/').slice(0,-1).join('/')||file:`task:${issue.taskId}`;
  const group=groups.get(area)??{area,count:0,ids:[]};group.count++;if(group.ids.length<20)group.ids.push(issue.id);groups.set(area,group);
 }
 return [...groups.values()].sort((a,b)=>b.count-a.count).slice(0,12);
}
export function goalStatus(run){
 if(!run.goal)return {ready:true,legacy:true,requirements:[],issues:[],unassessed:[],discoveryReady:true};
 const goal=run.goal;
 const requirements=goal.requirements.map(item=>({...item,accepted:proof(run,item)}));
 const issues=goal.issues.map(item=>({...item,resolved:proof(run,item)}));
 // Marathon runs are judged by binary hidden tests, so optional polish blocks like any other issue.
 const blocking=issues.filter(item=>!item.resolved&&(!item.backlog||!!run.marathon));
 const unassessed=goal.messages.filter(message=>!goal.assessed.includes(message.id));
 // A later focused investigation must not revoke already established knowledge
 // and stop unrelated implementation. Its real consumers wait through task DAG
 // dependencies; all unresolved requirements/findings still block final acceptance.
 const discoveries=run.tasks.filter(task=>task.kind==='discovery'&&passed(task));
 const discoveryReady=!goal.discoveryRequired||discoveries.some(task=>task.result.inventory?.length>0&&task.result.inventory.every(item=>item.requirementIds?.length&&item.requirementIds.every(id=>requirements.some(req=>req.id===id))));
 const expertise=[...(goal.roleNeeds??[]),...(goal.roleRequests??[])].map(need=>({...need,assigned:!!need.agent&&run.roles?.some(role=>role.name===need.agent&&expertiseRoleSuitable(need,role))&&run.tasks.some(task=>task.id===need.taskId&&task.assignee===need.agent)}));
 const staffingReady=!!goal.staffingRationale&&expertise.every(item=>item.assigned);
 return {ready:requirements.length>0&&!unassessed.length&&requirements.every(item=>item.accepted)&&!blocking.length&&discoveryReady&&staffingReady,
  requirements,issues,unassessed,expertise,staffingReady,discoveryRequired:goal.discoveryRequired,discoveryReady,handoff:goal.handoff??null,
  blockingIssues:blocking.length,backlog:run.marathon?0:issues.filter(item=>!item.resolved&&item.backlog).length,issueGroups:issueGroups(blocking)};
}
export function resolvedBlocker(run,task){
 const issues=goalStatus(run).issues.filter(item=>item.taskId===task.id);
 return issues.length>0&&issues.every(item=>item.resolved);
}
