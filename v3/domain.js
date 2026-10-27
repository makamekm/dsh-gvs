import {analysisReady,analysisAcceptance} from './analysis.js';
import {goalStatus} from './goal.js';
import {sameEntry} from './browser.js';
import {visualReviewAccepted,visualAuditStatus} from './visual.js';
import {responsiveRunReady,responsiveStatus,needsResponsive} from './responsive.js';
import {parallelBlocker} from './parallel.js';
export const clip=(value,max=4000)=>String(value??'').slice(0,max);
export const ID=/^[a-z][a-z0-9-]{0,39}$/;
export const kinds=['code','ui','game2d','game3d'];
export const taskKinds=['work','discovery','review','design-review','game-review','user-review','consultation','brief'];
export function roleSpec(input){
 if(!ID.test(input.name)||input.name==='lead')throw new Error('Use a unique lowercase role name, up to 40 characters.');
 if(!['read','edit','verify','user'].includes(input.capability))throw new Error('Capability must be read, edit, verify or user.');
 if(!input.title?.trim()||!input.purpose?.trim())throw new Error('Give the role a specific title and purpose.');
 if(input.capability==='user'&&input.name!=='user')throw new Error('The central User role is named user.');
 return {name:input.name,title:clip(input.title,80),purpose:clip(input.purpose,1200),instructions:clip(input.instructions,5000),capability:input.capability};
}
export function readyTasks(run){
 const done=new Set(run.tasks.filter(task=>task.state==='done').map(task=>task.id));
 return run.tasks.filter(task=>task.state==='waiting'&&task.dependsOn.every(id=>done.has(id)));
}
export function assertDag(tasks){
 const map=new Map(tasks.map(task=>[task.id,task]));const visiting=new Set(),visited=new Set();
 function visit(id){
  if(visiting.has(id))throw new Error('Task dependencies contain a cycle.');
  if(visited.has(id))return;
  const task=map.get(id);if(!task)throw new Error(`Unknown dependency ${id}`);
  visiting.add(id);task.dependsOn.forEach(visit);visiting.delete(id);visited.add(id);
 }
 tasks.forEach(task=>visit(task.id));
}
export function view(run){
 const goal=goalStatus(run);
 const shownTasks=[...run.tasks.filter(task=>task.state!=='done').slice(-100),...run.tasks.filter(task=>task.state==='done').slice(-20)];
 return {schema:3,sessionId:run.sessionId,runId:run.runId,task:clip(run.task,900),kind:run.kind,engine:run.engine,status:run.status,revision:run.revision,quality:run.quality,analysis:run.analysis??null,
  taskCounts:{total:run.tasks.length,done:run.tasks.filter(task=>task.state==='done').length},parallel:{limit:run.parallelLimit??4,assigned:run.tasks.filter(task=>task.state==='running'&&task.assignee!=='user').length},
  goal:{ready:goal.ready,unassessed:goal.unassessed.map(item=>item.id),requirements:goal.requirements.length,remainingCount:goal.requirements.filter(item=>!item.accepted).length,remaining:goal.requirements.filter(item=>!item.accepted).slice(0,20).map(({id,criterion})=>({id,criterion:clip(criterion,300)})),issueCount:goal.issues.filter(item=>!item.resolved).length,issues:goal.issues.filter(item=>!item.resolved).slice(0,10).map(({id,taskId,criterion})=>({id,taskId,criterion:clip(criterion,400)})),expertise:(goal.expertise??[]).filter(item=>!item.assigned).slice(0,20),staffingReady:goal.staffingReady??true,discoveryReady:goal.discoveryReady,handoff:goal.handoff??null},
  roles:run.roles.map(role=>{
   const current=run.tasks.find(task=>task.assignee===role.name&&task.state==='running');
   const blocked=run.tasks.find(task=>task.assignee===role.name&&task.state==='blocked');
   const waiting=run.tasks.find(task=>task.assignee===role.name&&task.state==='waiting');
   const responsive=current&&needsResponsive(run,current)?responsiveStatus(run,current):null;
   const dependencies=waiting?.dependsOn.filter(id=>run.tasks.find(task=>task.id===id)?.state!=='done').map(id=>run.tasks.find(task=>task.id===id));
   return {name:role.name,title:role.title,purpose:role.purpose,sessionId:role.sessionId??null,
    waitingForUser:role.waitingForUser===true,scheduling:!current&&waiting?parallelBlocker(run,waiting):null,state:role.waitingForUser?'waiting':current?'running':blocked?'blocked':waiting?'waiting':role.error?'error':'idle',
    activity:clip(role.waitingForUser?'Ждёт ответа Пользователя':current?current.title+(responsive?` · матрица ${responsive.completed}/${responsive.total}`:''):blocked?.result?.summary??waiting?.title??'Ожидает новую задачу',280),
    waitingFor:(dependencies??[]).filter(Boolean).map(task=>({id:task.id,title:task.title,agent:run.roles.find(role=>role.name===task.assignee)?.title??task.assignee})),
    completed:run.tasks.filter(task=>task.assignee===role.name&&task.state==='done').length,error:role.error??null};
  }),tasks:shownTasks.map(({id,title,assignee,kind,state,dependsOn,result})=>({id,title,assignee,kind,state,dependsOn,verdict:result?.verdict??null,findings:result?.findings?.map(item=>clip(item,400))??[],summary:clip(result?.summary,280)})),summary:run.summary??''};
}
export function imageAcceptance(run,task){
 if(!run.visualRequired)return true;
 const images=run.visualChecks.filter(check=>check.ok&&check.revision===run.revision).flatMap(check=>check.images);
 const received=new Set([...(task.receivedImages??[]),...run.visualChecks.filter(check=>check.capturedBy===task.assignee&&check.revision===run.revision).flatMap(check=>check.images).map(image=>image.attachment.attachmentId)]);
 return run.viewports.every(viewport=>images.some(image=>image.viewport===viewport&&received.has(image.attachment.attachmentId)&&(task.result?.images??[]).includes(image.attachment.attachmentId)));
}
export function quality(run){
 const latest=kind=>run.tasks.filter(task=>task.kind===kind&&task.state==='done'&&task.scope!=='increment').at(-1);
 const accepted=task=>!!task&&task.result.verdict==='pass'&&task.result.findings.length===0&&task.result.revision===run.revision;
 const technical=latest('review'),designer=latest('design-review'),user=latest('user-review'),game=latest('game-review');
 const coverage=new Set(run.gameChecks.filter(check=>check.ok&&check.revision===run.revision&&check.capturedBy===game?.assignee).flatMap(check=>check.coverage));
 const gameplay=!run.kind.startsWith('game')||accepted(game)&&technical?.assignee!==game.assignee&&
  ['collision','gameplay','controls',...(run.kind==='game3d'?['camera']:[])].every(category=>coverage.has(category))&&technical?.result.adapterReviewed===true;
 const current=run.visualChecks.filter(check=>check.ok&&check.revision===run.revision);
 const interaction=!run.visualRequired||current.some(check=>check.interactions>0&&check.assertions>0);
 const entry=run.kind!=='ui'||!run.visualRequired||!run.preview?.url||current.some(check=>sameEntry(check.url,run.preview.url)&&run.viewports.every(viewport=>check.views?.some(view=>view.viewport===viewport&&(viewport!=='mobile'||view.isMobile===true&&view.touchPoints>0&&/Android|iPhone|iPad/.test(view.userAgent??'')))));
 return {goal:goalStatus(run).ready,source:!run.sourceError,entry,technical:accepted(technical)&&technical.result.simple===true&&technical.result.scopePreserved===true&&technical.result.checks.length>0&&visualReviewAccepted(run,technical),
  design:!run.visualRequired||accepted(designer)&&imageAcceptance(run,designer)&&analysisAcceptance(run,designer)&&visualReviewAccepted(run,designer),
  user:accepted(user)&&user.assignee==='user'&&imageAcceptance(run,user)&&analysisAcceptance(run,user)&&visualReviewAccepted(run,user),
  visualAudit:visualAuditStatus(run).ready,responsive:responsiveRunReady(run),
  visual:!run.visualRequired||interaction&&run.viewports.every(viewport=>current.some(check=>check.images.some(image=>image.viewport===viewport))),game:gameplay,analysis:analysisReady(run)};
}
export function parseGameReport(report){
 if(report?.schema!=='gvs.game/1'||typeof report.engine!=='string'||!Array.isArray(report.cases)||!report.cases.length)throw new Error('Expected a gvs.game/1 report produced by the actual engine test runner.');
 const categories=['collision','gameplay','controls','camera'];
 for(const item of report.cases){
  if(typeof item.name!=='string'||!categories.includes(item.category)||typeof item.passed!=='boolean'||item.actual===undefined||item.expected===undefined)throw new Error('Every game case needs name, category, passed, actual and expected.');
 }
 return {ok:report.cases.every(item=>item.passed),coverage:[...new Set(report.cases.filter(item=>item.passed).map(item=>item.category))],engine:report.engine,cases:report.cases};
}
