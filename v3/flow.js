import {createHash} from 'node:crypto';

export function decisionKey(run){
 return createHash('sha256').update(JSON.stringify({messages:run.goal?.messages??[],requirements:run.goal?.requirements?.map(({id,criterion})=>({id,criterion})),analysis:run.analysis?.requirements??[]})).digest('hex');
}
export function reusableDecision(run,id){
 const task=run.tasks.find(task=>task.id===id);
 return task?.assignee==='user'&&['brief','consultation'].includes(task.kind)&&task.state==='done'&&task.result?.verdict==='pass'&&task.result.decisionKey===decisionKey(run)?task:null;
}
export function consultationKey(question,context=''){
 return createHash('sha256').update(question.trim()+'\0'+context.trim()).digest('hex');
}
export function progressStatus(run,now=Date.now(),maxSliceMs=1200000){
 const p=run.progress??{};
 const active=run.tasks.filter(task=>task.state==='running');
 const long=active.filter(task=>task.kind==='work'&&Number.isFinite(task.startedAt)&&now-task.startedAt>maxSliceMs).map(task=>({id:task.id,assignee:task.assignee,title:task.title,elapsedMs:now-task.startedAt}));
 const idleMs=now-(p.lastWriteAt??p.startedAt??now);
 const metadataLoop=(p.metadataSinceWrite??0)>=24&&idleMs>=600000;
 return {lastWriteAt:p.lastWriteAt??null,lastWriteFile:p.lastWriteFile??null,writes:p.writes??0,metadataSinceWrite:p.metadataSinceWrite??0,idleMs,overlongWork:long,needsIntervention:metadataLoop||long.length>0,
  next:metadataLoop?'Stop repeating readiness/ownership consultations. Inspect the actual blocker, reuse recorded User decisions, and assign the next concrete implementation or independent test.':long.length?'Ask the assigned editor for a bounded runnable increment and a real build/render check now. Move unrelated remaining work into subsequent owned tasks; preserve every goal and review gate.':'Continue assigned work; activity alone is not a completed deliverable.'};
}

// The full panel snapshot is replayable presentation metadata, not a repeated
// model-facing copy of every old task and finding after each tool call.
export function modelResult(value){
 const {gvsTeam,...result}=value;
 if(!gvsTeam)return result;
 const goal=gvsTeam.goal;
 return {...result,team:{runId:gvsTeam.runId,status:gvsTeam.status,revision:gvsTeam.revision,taskCounts:gvsTeam.taskCounts,
  goal:goal?{ready:goal.ready,requirements:goal.requirements,remainingCount:goal.remainingCount,issueCount:goal.issueCount,unassessed:goal.unassessed,discoveryReady:goal.discoveryReady,staffingReady:goal.staffingReady}:null,
  roles:gvsTeam.roles.map(({name,state,activity})=>({name,state,activity:activity?.slice(0,160)}))}};
}
