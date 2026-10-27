import {createHash} from 'node:crypto';

export const fullTransfer=text=>/1\s*в\s*1|пиксел|pixel.{0,15}pixel|реверс|reverse.{0,5}engineer|весь функционал|полны[йяоеую]+\s+(?:перенос|копи|функционал)/iu.test(text);
export function syncGoal(run,messages){
 if(!run.goal)run.goal={version:1,autonomous:true,messages:[],requirements:[],issues:[],assessed:[],discoveryRequired:false};
 const goal=run.goal;
 for(const message of messages??[]){
  if(goal.messages.some(item=>item.id===message.id))continue;
  goal.messages.push({id:message.id,text:message.text});
  goal.discoveryRequired ||= fullTransfer(message.text);
  delete goal.handoff;
 }
 return goal;
}
export function planGoal(run,{requirements,assessedMessages,expertise,staffingRationale,discoveryRequired}){
 const goal=run.goal;
 if(!Array.isArray(requirements)||!requirements.length)throw new Error('Record concrete requirements from the real human messages.');
 const proposed=structuredClone(goal.requirements),ids=new Set(goal.messages.map(item=>item.id));
 for(const item of requirements){
  if(!/^[a-z][a-z0-9-]{0,59}$/.test(item.id)||!item.criterion?.trim()||!item.sourceIds?.length||item.sourceIds.some(id=>!ids.has(id)))throw new Error('Each requirement needs an id, a criterion and actual human sourceIds.');
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
export function expertiseRoleSuitable(need,role){return !!role?.sessionId&&!role.retired&&!role.error&&(!need.capability||role.capability===need.capability||need.capability==='read'&&role.capability==='verify');}
function proof(run,item){
 const work=item.workTasks.map(id=>run.tasks.find(task=>task.id===id));
 const issue=!!item.taskId;
 const reviews=item.reviewTasks.map(id=>run.tasks.find(task=>task.id===id)).filter(task=>issue||task?.scope!=='increment');
 return work.length>0&&work.every(passed)&&reviews.length>0&&reviews.every(task=>passed(task)&&task.result.revision===run.revision&&['review','design-review','game-review','user-review'].includes(task.kind)&&!work.some(implementation=>implementation.assignee===task.assignee)&&
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
 if(!item)throw new Error('Unknown requirement or issue.');
 for(const taskId of [...(workTasks??[]),...(reviewTasks??[])])if(!run.tasks.some(task=>task.id===taskId))throw new Error(`Unknown task ${taskId}`);
 for(const taskId of reviewTasks??[])if(!['review','design-review','game-review','user-review'].includes(run.tasks.find(task=>task.id===taskId).kind))throw new Error('Review links must name independent review tasks.');
 if(workTasks)item.workTasks=[...new Set(workTasks)];
 // Explicitly replace superseded review attempts; findings remain durable issues.
 if(reviewTasks)item.reviewTasks=[...new Set(reviewTasks)];
 delete run.goal.handoff;
 return item;
}
export function recordFindings(run,task){
 if(!run.goal||!['revise','blocked'].includes(task.result?.verdict))return [];
 const created=[];
 for(const finding of task.result.findings.length?task.result.findings:[task.result.summary]){
  const id='issue-'+createHash('sha256').update(task.id+'\0'+finding).digest('hex').slice(0,14);
  if(run.goal.issues.some(item=>item.id===id))continue;
  const issue={id,taskId:task.id,criterion:finding,workTasks:[],reviewTasks:[]};
  run.goal.issues.push(issue);created.push(issue);
 }
 delete run.goal.handoff;
 return created;
}
export function goalStatus(run){
 if(!run.goal)return {ready:true,legacy:true,requirements:[],issues:[],unassessed:[],discoveryReady:true};
 const goal=run.goal;
 const requirements=goal.requirements.map(item=>({...item,accepted:proof(run,item)}));
 const issues=goal.issues.map(item=>({...item,resolved:proof(run,item)}));
 const unassessed=goal.messages.filter(message=>!goal.assessed.includes(message.id));
 // A later focused investigation must not revoke already established knowledge
 // and stop unrelated implementation. Its real consumers wait through task DAG
 // dependencies; all unresolved requirements/findings still block final acceptance.
 const discoveries=run.tasks.filter(task=>task.kind==='discovery'&&passed(task));
 const discoveryReady=!goal.discoveryRequired||discoveries.some(task=>task.result.inventory?.length>0&&task.result.inventory.every(item=>item.requirementIds?.length&&item.requirementIds.every(id=>requirements.some(req=>req.id===id))));
 const expertise=[...(goal.roleNeeds??[]),...(goal.roleRequests??[])].map(need=>({...need,assigned:!!need.agent&&run.roles?.some(role=>role.name===need.agent&&expertiseRoleSuitable(need,role))&&run.tasks.some(task=>task.id===need.taskId&&task.assignee===need.agent)}));
 const staffingReady=!!goal.staffingRationale&&expertise.every(item=>item.assigned);
 return {ready:requirements.length>0&&!unassessed.length&&requirements.every(item=>item.accepted)&&issues.every(item=>item.resolved)&&discoveryReady&&staffingReady,
  requirements,issues,unassessed,expertise,staffingReady,discoveryRequired:goal.discoveryRequired,discoveryReady,handoff:goal.handoff??null};
}
export function resolvedBlocker(run,task){
 const issues=goalStatus(run).issues.filter(item=>item.taskId===task.id);
 return issues.length>0&&issues.every(item=>item.resolved);
}
