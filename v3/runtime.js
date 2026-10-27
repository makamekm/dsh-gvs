import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {clip,roleSpec,readyTasks,assertDag,view,quality,kinds,taskKinds,parseGameReport,imageAcceptance} from './domain.js';
import {captureBrowser,captureGame,previewURL,BROWSER_ACTIONS,BROWSER_STATES,browserCapabilities} from './browser.js';
import {RESPONSIVE_TESTING,responsiveMatrix,responsiveStatus,responsiveScenarios,mergeResponsiveHints,validateResponsiveAcceptance,inspectResponsiveCheck} from './responsive.js';
import {COMMON,USER,GAME} from './prompts.js';
import {motionHint,analysisPlan,parseAnalysisReport,analysisReady,analysisAcceptance,decodeAnalysisOutput} from './analysis.js';
import {syncGoal,planGoal,linkGoal,recordFindings,goalStatus,resolvedBlocker} from './goal.js';
import {refreshRevision} from './revision.js';
import {decisionKey,reusableDecision,availableDecisions,consultationKey,progressStatus,modelResult} from './flow.js';
import {previewState,needsPreview,restoreManagedPreview} from './preview.js';
import {VISUAL_CHECKS,validateVisualReview,visualAuditStatus,visualStates,visualAssessmentFindings} from './visual.js';
import {USER_TESTING,planUserJourneys,userJourneyStatus,scenarioKey,userProbeInput,interruptedByLegacyPlan} from './journeys.js';
import {recordToolFailure,recordToolSuccess,toolIdentity,diagnosticStatus,toolFailureMessage,recoveryAdvice,checkFailureDetails} from './diagnostics.js';
import {providerRecoveryCandidates,providerFailureFor,readFailedSelection,inheritSelection} from './models.js';
import {parallelFields,parallelBlocker,parallelStatus,taskAccess,runningAccessChange,writeAllowed,validateWriteScopes,evidencePath} from './parallel.js';
import {assignmentDelivery} from './delivery.js';
import {prepareCodePlan,stalePlanFiles,planSources,needsCodePlan,missingPlanOutputs,migrateCodePlan,CodePlanSourceError} from './planning.js';
import {taskArtifacts} from './artifacts.js';
import {classifyProjectQA,isInteractiveProject,requiresWebVerification} from './project-qa.js';

export const inject=['tools','agentTeams','agents','sessionController','subagents','fs','workingDirectory','sandboxPolicy','attachments','llm','jobs','sessionProjections'];
const entries=new Map(),instance=randomUUID();
const object=properties=>({type:'object',additionalProperties:false,properties});
const text=(maxLength=4000)=>({type:'string',maxLength});
const strings={type:'array',items:{type:'string'},maxItems:40};
const codePlanInput={...object({summary:text(2000),changes:{type:'array',minItems:1,maxItems:16,items:{...object({path:text(300),anchor:{type:['string','null'],description:'Exact existing SOURCE fragment/hash, or null for new source. Text report headings are advisory; preserve previous evidence when appending reports.'},edit:{...text(6000),description:"Precise code edits at the anchor: before/after conditions, functions, CSS values or replacement snippet. Not a vague goal."}}),required:['path','anchor','edit']}},checks:{...strings,minItems:1,maxItems:12,description:'Exact foreground validation commands the executor must actually run.'},acceptance:{...strings,minItems:1,maxItems:12,description:'Observable behavior/UX to verify, including matching reference states for 1:1 work.'}}),required:['summary','changes','checks','acceptance']};
const imageParts=images=>images.map(image=>({type:'image',attachment:image.attachment}));
const roleOf=(entry,name)=>entry.run.roles.find(role=>role.name===name);
const liveImages=run=>{
 const current=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision),scene=current.filter(c=>c.views?.some(v=>v.layout)).at(-1);
 const ui=scene?.images??run.viewports.map(viewport=>current.flatMap(c=>c.images).filter(i=>i.viewport===viewport).at(-1)).filter(Boolean);
 const temporal=(run.analysisChecks??[]).filter(c=>c.ok&&c.revision===run.revision&&c.planVersion===run.analysis?.version).slice(-1).flatMap(c=>c.images);
 const failed=run.visualChecks.filter(c=>!c.ok&&c.revision===run.revision).at(-1)?.images??[];
 return [...ui,...failed,...run.viewports.flatMap(viewport=>temporal.filter(i=>i.viewport===viewport).slice(-2))].filter((image,i,all)=>all.findIndex(item=>item.attachment.attachmentId===image.attachment.attachmentId)===i).slice(0,20);
};
const taskSummaries=(tasks,detail=false)=>tasks.map(({id,title,assignee,kind,dependsOn,state,result,instructions,startedAt,priority,scope,reviewFocus,analysisIds,readScopes,writeScopes,resources,externalReadScopes,externalWriteScopes,scopeNotices,codePlan,planRequired,planStale,lastUpdate})=>({id,title,assignee,kind,dependsOn,state,startedAt,priority,scope,reviewFocus,analysisIds,readScopes,writeScopes,resources,externalReadScopes,externalWriteScopes,scopeNotices,...(detail?{instructions,codePlan,lastUpdate}:{}),planning:codePlan?{state:planStale?'stale':'planned',summary:clip(codePlan.summary,300)}:planRequired?{state:'needs-coordinator-plan'}:null,...(result?{result:detail?result:{...result,summary:clip(result.summary,800),findings:result.findings.map(item=>clip(item,600)),observations:result.observations?.slice(0,6).map(item=>clip(item,400)),inventory:result.inventory?.slice(0,10).map(item=>({...item,evidence:clip(item.evidence,400)}))}}:{})}));

function reviewPlan(run,input){
 const scope=input.scope??'full';
 if(scope==='increment'&&(!Array.isArray(input.analysisIds)||input.analysisIds.some(id=>!run.analysis?.requirements.some(item=>item.id===id))))throw new Error('An increment needs explicit analysisIds from the current User plan ([] only for a static slice). It cannot satisfy full-goal review gates.');
 const reviewFocus=input.reviewFocus??'visual';
 if(reviewFocus==='source'&&(input.kind!=='review'||scope!=='increment'||input.analysisIds?.length!==0))throw new Error('Source-only focus is limited to an independent review of a source increment with explicit analysisIds:[]. It cannot replace visual/design/User or full-goal acceptance.');
 return {scope,reviewFocus,analysisIds:scope==='increment'?input.analysisIds:null};
}

export function apply(ctx,config={}){
 const owned=new Set();
 const checkedPlanSources=new WeakMap();
 const maxParallel=config.maxParallel??4,maxTasks=!config.goalProtocol&&[64,160].includes(config.maxTasks)?10000:config.maxTasks??10000;
 ctx.effect(()=>ctx.jobs.attachController('gvs-team-preview'));
 async function storage(root,signal){
  const cwd=await ctx.workingDirectory.ensure(root,signal),policy=ctx.sandboxPolicy.resolve({session:root.session});
  const target=relative=>ctx.fs.resolve(path.resolve(cwd,relative),{cwd,signal});
  return {cwd,read:async file=>ctx.fs.readText(await target(file),signal),bytes:async file=>ctx.fs.readBytes(await target(file),signal,10*1024*1024),
   write:async(file,value)=>ctx.fs.writeText(await target(file),value,undefined,signal,policy),policy};
 }
 const stateFile=root=>path.join('.gvs',`team-${root.id}.json`);
 async function inspectProject(root,signal,engineHint=''){
  const io=await storage(root,signal),files=[],documents={},warnings=[],queue=[{directory:'',depth:0}],ignored=new Set(['.git','.gvs','.godot','.codex','node_modules','artifacts','dist','build','target','library','temp','obj','bin','.venv','venv','content','assets']);let scanned=0;
  while(queue.length&&scanned++<64){const {directory,depth}=queue.shift();let rows;try{rows=await ctx.fs.listDir(await ctx.fs.resolve(path.resolve(io.cwd,directory),{cwd:io.cwd,signal}),signal);}catch{warnings.push(`Cannot inspect directory ${directory||'.'}; target discovery is incomplete.`);continue;}
   for(const row of rows){const relative=(directory?directory+'/':'')+row.name;files.push(relative);if(/^(?:package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|project\.godot)$/i.test(row.name)||/\.(?:csproj|uproject)$/i.test(row.name)){try{documents[relative]=new TextDecoder().decode(await io.bytes(relative));}catch{warnings.push(`Cannot read metadata ${relative}; inspect permissions/source before accepting its target.`);}}
    if(row.type==='directory'&&depth<2&&!ignored.has(row.name.toLowerCase())&&!row.name.startsWith('.'))queue.push({directory:relative,depth:depth+1});
   }
  }
  try{documents['ProjectSettings/ProjectVersion.txt']=new TextDecoder().decode(await io.bytes('ProjectSettings/ProjectVersion.txt'));}catch{}
  if(queue.length)warnings.push('Metadata discovery was bounded at 64 directories. An assigned source specialist must inspect remaining targets.');
  const target=classifyProjectQA({files,documents,engineHint});return {...target,warnings:[...target.warnings,...warnings],revision:entries.get(root.id)?.run.revision??null};
 }
 async function load(root,signal){
  if(entries.has(root.id)){const entry=entries.get(root.id);entry.root=root;return entry;}
  const io=await storage(root,signal);
  try{
   const run=JSON.parse(await io.read(stateFile(root)));
   if(run.schema!==3||run.sessionId!==root.id)throw new Error('Invalid GVS state for this session');
   if(run.coordinatorPlanningVersion!==1){for(const task of run.tasks)if(task.state==='running'&&!task.codePlan)task.planGrandfathered=true;run.coordinatorPlanningVersion=1;}
   if(run.status==='running'){
    run.summary='Service restarted. Inspect interrupted tasks, preserve completed work and continue the same human goal.';
    for(const role of run.roles)role.waitingForUser=false;
    for(const task of run.tasks.filter(task=>task.state==='running')){await checkpointPlan(io,task);task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],interrupted:true,revision:run.revision};}
   }
   const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);return entry;
  }catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return null;throw error;}
 }
 async function current(exec,required=true){
  if(!exec.agent)throw new Error('A GVS session is required');
  const member=ctx.agentTeams.membership(exec.agent),entry=await load(member.root,exec.signal);
  if(required&&!entry)throw new Error('The coordinator must call gvs_run first.');
  if(entry){
   entry.run.requireCoordinatorPlan=config.requireCoordinatorPlan!==false;
   for(const task of entry.run.tasks){task.codePlan=migrateCodePlan(task.codePlan);task.planRequired=task.state!=='done'&&needsCodePlan(entry.run,task);}
   entry.run.parallelLimit??=maxParallel;
   if(isInteractiveProject(entry.run)){
    if(config.responsiveTesting!==false)entry.run.responsivePolicy=1;
    entry.run.userTestingPolicy=1;
    if(!entry.run.userTestingSeen){entry.run.userTestingSeen=entry.run.tasks.filter(t=>t.state==='done').map(t=>t.id);entry.run.userTestingInitial=true;}
   }
   if(entry.run.status==='running'&&entry.run.visualRequired)entry.run.visualPolicy=1;
   entry.run.progress??={startedAt:Date.now(),metadataSinceWrite:0,writes:0};
   if(member.role==='lead'){
    if(entry.owner!==ctx&&entry.suspending){entry.abort=new AbortController();entry.suspending=false;}
    entry.owner=ctx;owned.add(member.root.id);
   }
   const messages=ctx.sessionProjections?.stateOf(member.root.session,'gvsHumanGoal')?.messages;
   const migrating=!entry.run.goal;
   syncGoal(entry.run,messages?.length?messages:!entry.run.goal?[{id:'initial-request',text:entry.run.task}]:[]);
   if(migrating){for(const task of entry.run.tasks)recordFindings(entry.run,task);entry.run.revision++;}
   await refreshRevision(entry,ctx.fs,exec.signal);
   if(config.projectInspection!==false&&entry.run.qaTarget?.revision!==entry.run.revision){const target=await inspectProject(member.root,exec.signal,entry.run.engine);if(target.surfaces.includes('code-or-unknown')&&entry.run.qaTarget?.sourceConfirmed){target.surfaces=entry.run.qaTarget.surfaces;target.engines=entry.run.qaTarget.engines;target.warnings.push('Preserved previously confirmed targets while current metadata is incomplete; source changes cannot silently waive verification.');}entry.run.qaTarget=target;if(entry.run.viewportsAuto&&entry.run.visualRequired&&requiresWebVerification(entry.run))entry.run.viewports=[...new Set([...entry.run.viewports,'desktop','mobile'])];await commit(entry);}
  }
  return {member,entry,root:member.root,name:member.name};
 }
 function lead(member){if(member.role!=='lead')throw new Error('Only the coordinator can change team composition or the task plan. Send the precise request with gvs_agent action:message name:lead; for missing expertise use gvs_agent action:request. Continue your own assignment or preserve negative feedback without changing team authority.');}
 async function checkpointPlan(io,task){
  const plan=migrateCodePlan(task.codePlan);if(!plan)return;
  task.planContinuation={plannedAt:plan.plannedAt,sources:await planSources(plan,io.bytes)};
  task.planStale=false;task.stalePlanFiles=[];
 }
 async function codePlan(entry,task,input){
  const prepared=await prepareCodePlan(input,{cwd:entry.io.cwd,read:entry.io.bytes,allowed:file=>writeAllowed(task,file,entry.io.cwd),author:entry.root.id});
  const comparable=plan=>{const {plannedAt,...rest}=plan;return JSON.stringify(rest);};
  return task.codePlan&&comparable(task.codePlan)===comparable(prepared)?task.codePlan:prepared;
 }
 async function artifactManifest(entry,task,signal){return taskArtifacts(task,{
  stat:file=>ctx.fs.lstat(path.resolve(entry.io.cwd,file),{cwd:entry.io.cwd},signal),
  list:async file=>ctx.fs.listDir(await ctx.fs.resolve(path.resolve(entry.io.cwd,file),{cwd:entry.io.cwd,signal}),signal)
 });}
 async function commit(entry){
  const saved=JSON.stringify({...entry.run,updatedAt:new Date().toISOString()},null,2);
  entry.write=entry.write.catch(()=>{}).then(async()=>{
   const io=await storage(entry.root,AbortSignal.timeout(15000));
   await io.write(stateFile(entry.root),saved);await io.write(path.join('.gvs',entry.run.runId,'state.json'),saved);await io.write(path.join('.gvs','latest.json'),saved);
  });await entry.write;
 }
 function operation(entry,exec){const member=ctx.agentTeams.tryMembership(exec.agent);return {agent:member.name,taskId:exec.arguments?.taskId??entry.run.tasks.find(t=>t.assignee===member.name&&t.state==='running')?.id??entry.run.tasks.find(t=>t.assignee===member.name&&t.state==='waiting')?.id??null,tool:exec.name,identity:toolIdentity(exec)};}
 async function noteFailure(entry,exec,message){
  const {item,notify}=recordToolFailure(entry.run,{...operation(entry,exec),message});await commit(entry);
  if(notify&&item.agent!=='lead')try{await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS TOOL ERROR ${JSON.stringify(item)}. Diagnose this without waiting for the human to forward it. Correct the protocol/configuration or assign an owned repair for a real failed check. A missing check, permission denial or product failure is not permission to waive acceptance. Read gvs_diagnostics for current errors.`}],signal:exec.signal});}catch{}
 }
 async function createRole(entry,input,signal){
  const spec=roleSpec(input),existing=roleOf(entry,spec.name);
  if(existing){if(existing.capability!==spec.capability)throw new Error('A persistent role cannot silently change capability. Use a new role name.');existing.retired=false;if(existing.sessionId){delete existing.error;return existing;}}
  if(!existing&&entry.run.roles.length>=32)throw new Error('This team has 32 persistent roles; reuse an appropriate specialist.');
  const role=existing??{...spec,sessionId:null,retired:false};if(!existing)entry.run.roles.push(role);
  try{
   const native=ctx.agentTeams.listMembers?.(entry.root).find(member=>member.name===spec.name);
   if(native){role.sessionId=native.id;delete role.error;return role;}
   const created=await ctx.agentTeams.spawnTeammate(entry.root,{name:spec.name,description:`${spec.title} — ${spec.purpose}`.slice(0,200),context:'fresh',provider:'spawn',signal,
    prompt:[{type:'text',text:`${COMMON}\n\nROLE ${spec.name}: ${spec.title}\nPURPOSE: ${spec.purpose}\nCAPABILITY: ${spec.capability}\n${spec.capability==='user'?USER:spec.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\nHUMAN TASK: ${entry.run.task}\nThis is role registration, not an assigned task yet. Briefly acknowledge and become idle; a dependency-ready task will wake this same conversation.`}]});
   role.sessionId=created.member.id;delete role.error;
  }catch(error){role.error=clip(error.message);throw error;}finally{await commit(entry);}
  return role;
 }
 async function createTask(entry,input,signal,dispatch=true){
  if(entry.run.tasks.length>=maxTasks)throw new Error('Task budget exhausted; report the remaining work.');
  if(!roleOf(entry,input.assignee)||roleOf(entry,input.assignee).retired)throw new Error('Create an appropriate role first.');
  const dependsOn=input.dependsOn??[];assertDag([...entry.run.tasks,{id:'new-task',dependsOn}]);
  if(!taskKinds.includes(input.kind))throw new Error('Choose a supported task kind.');
  const role=roleOf(entry,input.assignee);
  if(!role.sessionId)throw new Error('This role failed to register. Use gvs_agent wake with its existing name to repair registration before assigning work.');
  if(input.kind==='discovery'&&!['read','verify'].includes(role.capability))throw new Error('Assign discovery to an independent read/verify architect or researcher.');
  if(['review','game-review'].includes(input.kind)&&role.capability!=='verify')throw new Error('Assign independent verification to a verify role, not the editing agent.');
  if(input.kind==='design-review'&&role.capability==='edit')throw new Error('The rendered design reviewer must be separate from the editing role.');
  if(['user-review','brief','consultation'].includes(input.kind)&&input.assignee!=='user')throw new Error('User decisions belong to the central User role.');
  const scope=reviewPlan(entry.run,input);
  const access=parallelFields(input,entry.io.cwd);
  validateWriteScopes(role,access.writeScopes);
  const plan=input.codePlan?await codePlan(entry,{...input,...scope,...access},input.codePlan):null;
  const native=await ctx.agentTeams.createTask(entry.root,{subject:clip(input.title,180),description:clip(input.instructions,15000),blockedBy:dependsOn,writeScopes:access.writeScopes??[]});
  const inherited=entry.run.tasks.filter(task=>task.assignee===input.assignee).flatMap(task=>task.consultations??[]).filter(id=>reusableDecision(entry.run,id));
  const task={id:native.id,title:clip(input.title,180),instructions:clip(input.instructions,15000),assignee:input.assignee,kind:input.kind,dependsOn,state:'waiting',receivedImages:[],consultations:[...new Set(inherited)],priority:input.priority??0,...scope,...access};
  if(input.autoUserProbe)Object.assign(task,{autoUserProbe:true,userProbeFor:input.userProbeFor});
  if(plan)task.codePlan=plan;
  task.planRequired=needsCodePlan(entry.run,task);
  entry.run.progress.metadataSinceWrite++;
  entry.run.tasks.push(task);await commit(entry);if(dispatch)await schedule(entry,signal);return task;
 }
 async function ensureUserProbe(entry,signal){
  const input=userProbeInput(entry.run);if(!input)return;
  const queued=entry.run.tasks.find(t=>t.autoUserProbe&&t.state==='waiting');
  if(queued){queued.userProbeFor=[...new Set([...queued.userProbeFor,...input.userProbeFor])];queued.readScopes=[...new Set([...queued.readScopes,...input.readScopes])];}
  else await createTask(entry,input,signal,false);
  entry.run.userTestingSeen=[...new Set([...entry.run.userTestingSeen,...input.userProbeFor])];entry.run.userTestingInitial=false;await commit(entry);
 }
 async function schedule(entry,signal){
  if(entry.recoveringPreview)return;
  if(entry.scheduling)return entry.scheduling;
  entry.scheduling=(async()=>{
   if(entry.run.status!=='running')return;
   await ensureUserProbe(entry,signal);
   const ready=readyTasks(entry.run).sort((a,b)=>(b.priority??0)-(a.priority??0));
   if(ready.some(task=>needsPreview(entry.run,task)||task.waitForPreviewRecovery)){const observed=await previewState(entry.run.preview,ctx.jobs,entry.root.id,signal);observePreview(entry,observed);await commit(entry);}
   for(const task of ready){
    if(entry.abort.signal.aborted||signal.aborted||entry.recoveringPreview)break;
    const role=roleOf(entry,task.assignee);
    if(role.capability==='edit'&&!goalStatus(entry.run).discoveryReady)continue;
    if(role.capability!=='user'&&entry.run.analysis&&(entry.run.analysis.state!=='ready'||entry.run.tasks.some(task=>task.kind==='brief'&&task.state!=='done')))continue;
    if(role.retired||parallelBlocker(entry.run,task,entry.run.parallelLimit??maxParallel))continue;
    const continuation=task.planContinuation?.plannedAt===task.codePlan?.plannedAt?task.planContinuation:null;
    if(needsCodePlan(entry.run,task)&&task.codePlan){const baseline=continuation?{sources:continuation.sources.filter(item=>task.codePlan.sources.some(source=>source.path===item.path))}:task.codePlan;const stale=await stalePlanFiles(baseline,entry.io.bytes);if(stale.length){task.planStale=true;task.stalePlanFiles=stale;await commit(entry);continue;}}
    const native=ctx.agentTeams.getTask(entry.root,task.id);
    await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'reassign',owner:role.name});
    task.state='running';task.startedAt=Date.now();task.startedRevision=entry.run.revision;task.nonce=randomUUID();delete task.executionTurn;delete task.planContinuation;
    const images=task.reviewFocus==='source'?[]:liveImages(entry.run);task.receivedImages=images.map(image=>image.attachment.attachmentId);
    task.receivedAnalysisReports=(entry.run.analysisChecks??[]).filter(check=>check.ok&&check.revision===entry.run.revision&&check.planVersion===entry.run.analysis?.version).map(check=>check.id);
    const deps=entry.run.tasks.filter(previous=>task.dependsOn.includes(previous.id)).map(({id,title,result})=>({id,title,result:result?{verdict:result.verdict,summary:clip(result.summary,1200),findings:result.findings?.map(item=>clip(item,400)),inventoryItems:result.inventory?.length??0,artifacts:(result.artifacts??[]).slice(0,12)}:null}));
    const observations=entry.run.visualChecks.filter(check=>check.revision===entry.run.revision).slice(-2).map(({ok,scenario,views})=>({ok,scenario,views}));
    const prompt=`${COMMON}\n${role.capability==='user'?USER:role.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\n\nCURRENT HUMAN TASK: ${entry.run.task}\nROLE: ${role.title}\nASSIGNED TASK ID: ${task.id}\nTASK NONCE: ${task.nonce}\nKIND: ${task.kind}\nWORK: ${task.instructions}\nCOORDINATOR CODE PLAN (binding exact changes/checks; ask Lead about source drift): ${JSON.stringify(task.codePlan??null)}\nCONDITIONAL ANALYSIS PLAN: ${JSON.stringify(entry.run.analysis??null)}\nANALYSIS REPORTS: ${JSON.stringify((entry.run.analysisChecks??[]).filter(check=>task.receivedAnalysisReports.includes(check.id)).map(({id,engine,analyzer,results,frameSummary})=>({id,engine,analyzer,results:results.map(({frames,samples,...result})=>result),frameSummary})))}\nDEPENDENCY RESULTS: ${JSON.stringify(deps)}\nSHARED USER DECISIONS: ${JSON.stringify(availableDecisions(entry.run).slice(-6))}\nRECORDED BROWSER EVIDENCE: ${JSON.stringify(observations)}\nPREVIEW: ${JSON.stringify(entry.run.preview)}\nACTUAL ATTACHED IMAGES: ${JSON.stringify(images.map(image=>({viewport:image.viewport,id:image.attachment.attachmentId,atMs:image.atMs})))}\nFinish with gvs_task complete for this exact task. Include actual image IDs, analysisReports IDs and exact commands when reviewing. Other members wake automatically; do not poll them.`;
    const messages=entry.run.goal?.messages??[],selected=messages.filter((_,i)=>i<2||i>=messages.length-8);
    const contract=`REAL HUMAN CONTRACT (unaltered excerpts; ${messages.length} messages stored, paginate gvs_goal status for all): ${JSON.stringify(selected)}\nGOAL COVERAGE: ${JSON.stringify(view(entry.run).goal)}\nUser brief MUST first call gvs_goal status then gvs_goal plan with sourceIds/assessedMessages and expertise/staffingRationale. Infer needed roles; the human need not name them. Discovery inventories must map to requirements. Reviews MUST attest coveredRequirements IDs and scopeReviewed=true after independent completeness analysis; repairs attest addressedIssues IDs. Every required mismatch belongs in findings, never only in summary. Simulated User decisions cannot waive the human goal.`;
    const flow=`PARALLEL ACCESS CONTRACT: ${JSON.stringify(taskAccess(entry.run,task))}. Edit only leased write paths. Shell commands must obey the same contract; leases coordinate agents and are not OS isolation. Do not mutate shared servers/databases, run dependency installs/shared builds or overwrite another task's artifacts without the named exclusive resource (project-runtime for the common preview/build/test environment). Use task-specific artifacts and isolated checks for parallel work. Ask Lead to update a queued task's scopes/resources before an undeclared operation. Full final reviews read the whole frozen source; scoped increment results never replace integration acceptance.\nDELIVER AN INCREMENT, NOT A PLANNING LOOP. Review scope: ${task.scope??'full'}, analysisIds: ${JSON.stringify(task.analysisIds??'ALL')}. An increment pass attests only this slice/selected criteria and NEVER full-goal acceptance. [] allows only a static slice, not a motion acceptance claim. Established User decisions for this role: ${JSON.stringify(task.consultations)}. Reuse a current decision with gvs_ask_user reuseTaskId; consult only for an actual consequential unknown, never to approve the same scope again. Read a dependency's exact assignment/result with gvs_task list taskId when needed; summaries above are not a claim that you read the whole evidence. For implementation, produce a coherent runnable slice with a real build/render check, normally within 20 minutes. If this assignment is too broad, message Lead with the completed slice and remaining work so it can be split without dropping requirements. Do not expand an in-progress mobile fix into every backend/product feature or postpone all product work until universal readiness. Independent final acceptance remains mandatory.`;
    const fallback=`${COMMON}\n${role.capability==='user'?USER:role.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\nASSIGNED TASK ID: ${task.id}\nTASK NONCE: ${task.nonce}\nROLE: ${role.title}\nKIND: ${task.kind}\nWORK: ${task.instructions}\n${flow}\nThe complete human goal is unchanged. First read gvs_goal status, then gvs_task list taskId=${task.id}; inspect dependency IDs ${JSON.stringify(task.dependsOn)} and relevant evidence via their paged tools. Finish only with gvs_task complete for this exact ID/nonce. PREVIEW: ${JSON.stringify(entry.run.preview)}`;
    const focusPrompt=task.reviewFocus==='source'?'COORDINATOR-ASSIGNED SOURCE-ONLY INCREMENT: inspect actual source/native ABI/security policy and run exact appropriate successful checks. No visualReview/screenshots are required for THIS source task; do not fabricate them. This pass does not attest UI, runtime-only behavior, design/User acceptance or the full human goal. Any such unresolved obligations remain open.':'';
    const reportPrompt=role.capability==='verify'?(entry.run.kind==='ui'&&task.kind==='review'&&task.scope!=='increment'?`INDEPENDENT FULL UI QA: plan and execute your own scenarios with gvs_user_testing and gvs_browser_check; the User's checks do not substitute for yours. ${USER_TESTING}\n`:'')+'VERIFY OUTPUTS: direct write/edit is allowed only for reports/evidence in your explicitly leased artifacts/, test-results/ or playwright-report/ paths. Keep production sources and analyzer scripts read-only. Generated build/cache leases are for actual checks, never fabricated product output. If no report path is leased, return structured findings via gvs_task complete or ask Lead for a precise report task; do not bypass scope restrictions with shell writes. Analysis failures report the real exit/stderr cause; never weaken tests or invent a success report.':'';
    const resumePrompt=continuation?'CONTINUING AN INTERRUPTED ASSIGNMENT: partial edits already exist. Inspect the current planned files before editing, preserve completed work, finish the same plan and rerun every planned check. The original implementation baseline and independent acceptance remain binding.':'';
    const delivery=assignmentDelivery(flow+'\n'+contract+'\n'+prompt+'\n'+focusPrompt+'\n'+reportPrompt+'\n'+resumePrompt,images,focusPrompt+'\n'+reportPrompt+'\n'+resumePrompt+'\n'+fallback);task.receivedImages=delivery.images.map(image=>image.attachment.attachmentId);task.compactAssignment=delivery.compact;
    try{await ctx.agentTeams.sendMessage(entry.root,{target:role.name,content:delivery.content,signal});}
    catch(error){task.state='blocked';task.result={verdict:'blocked',summary:clip(error.message),findings:[clip(error.message)],deliveryError:true,revision:entry.run.revision};}
    await commit(entry);
   }
  })();try{await entry.scheduling;}finally{entry.scheduling=null;}
 }
 function register(name,description,properties,required,execute,timeoutMs=120000){
  ctx.tools.register({name,description,parameters:{...object(properties),required},timeoutMs,
   output:{schema:{},presentationMeta:(_args,value)=>({gvsTeam:value.gvsTeam??null}),render:(_args,value)=>[{type:'text',text:JSON.stringify(modelResult(value))},...imageParts(value.images??[])]},
   async execute(args,exec){try{const value=await execute(args,exec);const info=await current(exec,false);if(info.entry){if(value.ok===false)await noteFailure(info.entry,exec,`Check ${value.id??exec.name} ${value.scenarioId??''} failed: ${JSON.stringify(checkFailureDetails(value))}`);else if(value.accepted!==false&&value.updated!==false&&value.retried!==false&&recordToolSuccess(info.entry.run,operation(info.entry,exec)))await commit(info.entry);}return JSON.parse(JSON.stringify({...value,...(info.entry?{gvsTeam:view(info.entry.run)}:{})}));}catch(error){const member=exec.agent&&ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);if(error instanceof CodePlanSourceError&&entry){await noteFailure(entry,exec,error.message);return JSON.parse(JSON.stringify({status:'needs-current-source',accepted:false,updated:false,created:false,taskId:args.taskId??null,recovery:error.recovery,next:'No task/plan/assignment changes were applied. Coordinator reads the actual current source at nextRead, corrects the anchor/edit and resubmits this SAME task. Missing file: inspect its actual producer/path; null anchor is only for genuinely new source. Never bypass validation or fabricate the file.',gvsTeam:view(entry.run)}));}if(entry)try{await noteFailure(entry,exec,error.message);}catch{}throw error;}}});
 }
 function writeDenial(entry,name,role,exec){
  if(!['write','edit'].includes(exec.name))return;
  const task=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running'),target=exec.arguments?.file_path??exec.arguments?.path;
  if(!task)return 'No dependency-ready task is assigned. Wait for the scheduler.';
  if(role.capability==='verify'){
   if(target&&evidencePath(target,entry.io.cwd)&&writeAllowed({...task,writeScopes:task.writeScopes??[]},target,entry.io.cwd))return;
   return 'Verification may write/edit only reports or evidence inside explicitly assigned artifacts/, test-results/ or playwright-report/ scopes. Product sources remain read-only; ask Lead for a precise report lease.';
  }
  if(role.capability!=='edit')return 'This role may not edit project files.';
  if(!target||!writeAllowed(task,target,entry.io.cwd))return 'The file is outside this task writeScopes. Ask Lead to schedule a separate scoped task; do not modify another parallel branch.';
  if(task.codePlan&&!evidencePath(target,entry.io.cwd)&&!task.codePlan.changes.some(change=>path.resolve(entry.io.cwd,change.path).toLowerCase()===path.resolve(entry.io.cwd,target).toLowerCase()))return 'This product file is outside the coordinator codePlan. Report the concrete missing change to Lead and obtain a corrected plan before editing it.';
 }
 ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!exec.agent)return next();const membership=ctx.agentTeams.tryMembership(exec.agent);if(!membership)return next();
  if(membership.role==='lead'){
   const entry=entries.get(membership.root.id),target=exec.arguments?.file_path??exec.arguments?.path;
   if(entry?.run.requireCoordinatorPlan&&['write','edit'].includes(exec.name)&&target&&!evidencePath(target,entry.io.cwd))return {kind:'deny',reason:'Coordinator owns source inspection and the exact codePlan. Delegate product file changes through gvs_task to an edit specialist; direct coordinator edits are not the implementation workflow.'};
   return next();
  }
  const entry=await load(membership.root,exec.signal),role=entry&&roleOf(entry,membership.name);
  const alwaysRead=['read','read_image','glob','grep','working_directory','gvs_status','gvs_artifacts','gvs_diagnostics','gvs_browser_capabilities','gvs_wait'];
  if(!role)return alwaysRead.includes(exec.name)?next():{kind:'deny',reason:'This teammate has no GVS role assignment.'};
  if(['gvs_run','gvs_finish','gvs_resume','gvs_recover','gvs_pause'].includes(exec.name))return {kind:'deny',reason:'This is a coordinator-only operation.'};
  const writing=writeDenial(entry,membership.name,role,exec);if(writing)return {kind:'deny',reason:writing};
  if(['pwsh','bash','gvs_native_game_check'].includes(exec.name)&&!['edit','verify'].includes(role.capability))return {kind:'deny',reason:'This role has no command execution capability.'};
  if(entry.run.status!=='running'&&!alwaysRead.includes(exec.name))return {kind:'deny',reason:'The run is paused or finished. Ask the coordinator to resume or assign new work.'};
  return next();
 });
 ctx.tools.guard(exec=>{
  if(!exec.agent)return;
  const member=ctx.agentTeams.tryMembership(exec.agent);if(!member||member.role==='lead')return;
  const entry=entries.get(member.root.id),role=entry&&roleOf(entry,member.name);
  const basic=['read','read_image','glob','grep','working_directory','gvs_status','gvs_artifacts','gvs_diagnostics','gvs_browser_capabilities','gvs_wait'];
  if(!role)return basic.includes(exec.name)?undefined:'No GVS role is assigned to this teammate.';
  if(['gvs_run','gvs_finish','gvs_resume','gvs_recover','gvs_pause'].includes(exec.name))return 'Only the coordinator may control the run.';
  const writing=writeDenial(entry,member.name,role,exec);if(writing)return writing;
  if(['pwsh','bash','gvs_native_game_check'].includes(exec.name)&&!['edit','verify'].includes(role.capability))return 'This role has no command execution capability.';
  if(!entry.run.tasks.some(task=>task.assignee===member.name&&task.state==='running')&&['write','edit','pwsh','bash','gvs_native_game_check','gvs_browser_check','gvs_game_check'].includes(exec.name))return 'No dependency-ready task is assigned. Wait for the scheduler; do not start this work early.';
  if(entry.run.status!=='running'&&!basic.includes(exec.name))return 'The run is paused or finished.';
 });
 ctx.on('tools/post-execute',async(exec,result,next)=>{
  if(exec.agent&&['pwsh','bash'].includes(exec.name)){
   const member=ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);
   const task=entry?.run.tasks.find(task=>task.assignee===member.name&&task.state==='running');
   if(task?.codePlan&&!result.isError&&result.value?.kind==='foreground'&&result.value.exitCode===0&&!result.value.timedOut&&!result.value.aborted&&result.value.signal==null)checkedPlanSources.set(exec,await planSources(task.codePlan,entry.io.bytes));
  }
  return next();
 });
 ctx.on('tools/execute',async(exec,next)=>{
  const result=await next();
  const member=exec.agent&&ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);
  if(!entry||entry.run.status!=='running')return result;
  const message=toolFailureMessage(result),advice=message&&recoveryAdvice(message);
  if(!advice)return result;
  // Keep the canonical outcome/error and all images. Context survives Native
  // definition-owned content finalizers and is delivered after this failed call.
  return {...result,additionalContexts:[...(result.additionalContexts??[]),{id:randomUUID(),role:'user',source:{kind:'gvs-tool-recovery',form:'notice',summary:'Correct the failed tool operation before retrying'},content:[{type:'text',text:`GVS TOOL RECOVERY (${exec.name}): ${advice} This notice does not satisfy any test or acceptance gate.`}]}]};
 });
 ctx.on('tools/result',(exec,result)=>{
  if(!exec.agent)return;const member=ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);if(!entry||entry.run.status!=='running')return;
  const role=roleOf(entry,member.name),task=entry.run.tasks.find(task=>task.assignee===member.name&&task.state==='running');
  if(!exec.name.startsWith('gvs_')){const message=toolFailureMessage(result);if(message){void noteFailure(entry,exec,message).catch(()=>{});}
  else if(recordToolSuccess(entry.run,operation(entry,exec)))void commit(entry).catch(()=>{});}
  if(['write','edit'].includes(exec.name)&&!result.isError){
   const file=exec.arguments?.file_path??exec.arguments?.path??'';
   if(task&&file){const relative=path.relative(entry.io.cwd,path.resolve(entry.io.cwd,file)).replaceAll('\\','/');if(relative&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative)){const written=[...new Set([...(task.writtenFiles??[]),relative])];task.writtenFilesTruncated||=written.length>160;task.writtenFiles=written.slice(-160);}}
   if(role?.capability==='edit'&&file&&!/(^|[\\/])(?:\.gvs|artifacts|test-results|playwright-report|node_modules)[\\/]/.test(file)){
    entry.run.progress??={startedAt:Date.now()};Object.assign(entry.run.progress,{lastWriteAt:Date.now(),lastWriteFile:file,writes:(entry.run.progress.writes??0)+1,metadataSinceWrite:0});
   }
  }
  if(!['pwsh','bash'].includes(exec.name))return;
  const value=result.value;
  entry.run.checks.push({taskId:task?.id??null,at:Date.now(),agent:member.name,command:clip(exec.arguments?.command,5000),exitCode:value?.exitCode??null,
   finished:value?.kind==='foreground'&&value?.signal==null&&!value?.timedOut&&!value?.aborted,error:result.isError,
   output:clip([value?.stdout?.text,value?.stderr?.text].filter(Boolean).join('\n')||result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n'),12000),...(checkedPlanSources.has(exec)?{codePlanSources:checkedPlanSources.get(exec)}:{})});
  entry.run.checks=entry.run.checks.slice(-120);
 });
 register('gvs_run','Start an adaptive GVS team run. Returns immediately; then create only needed specialists and dependency tasks, coordinate results, and call gvs_finish. Named teammates persist and wake for later tasks.',{task:text(16000),kind:{type:'string',enum:kinds},engine:text(100),viewports:{type:'array',items:{type:'string',enum:['desktop','mobile']},minItems:1,maxItems:2}},['task','kind'],async(args,exec)=>{
  const {member,root,entry:previous}=await current(exec,false);lead(member);
  if(previous?.run.status==='running')throw new Error('A run is active; coordinate it or pause it first.');
  const io=await storage(root,exec.signal);if(io.policy.mode==='read-only')throw new Error('GVS work requires Workspace Write.');
  const visualRequired=args.kind!=='code';
  const run={schema:3,sessionId:root.id,runId:`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,task:args.task,kind:args.kind,engine:args.engine??'',status:'running',revision:0,
   visualRequired,visualPolicy:visualRequired?1:0,viewports:args.viewports??(args.kind==='ui'?['desktop','mobile']:['desktop']),viewportsAuto:args.viewports===undefined,roles:previous?.run.roles??[],tasks:[],checks:[],visualChecks:[],gameChecks:[],analysis:{state:'pending',version:0,requirements:[],rationale:'',motionHint:motionHint(args.task)},analysisChecks:[],preview:null,quality:null,summary:'',progress:{startedAt:Date.now(),metadataSinceWrite:0,writes:0}};
  const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);
  entry.owner=ctx;owned.add(root.id);
  const human=ctx.sessionProjections?.stateOf(root.session,'gvsHumanGoal')?.messages;
  syncGoal(run,human?.length?human:[{id:'initial-request',text:args.task}]);
  if(config.projectInspection!==false){run.qaTarget=await inspectProject(root,exec.signal,run.engine);if(run.viewportsAuto&&run.qaTarget.sourceConfirmed&&!requiresWebVerification(run))run.viewports=['desktop'];}
  await refreshRevision(entry,ctx.fs,exec.signal);
  await createRole(entry,{name:'user',title:'Пользователь',purpose:'Цели, UX и независимая пользовательская приёмка',instructions:USER,capability:'user'},exec.signal);
  const brief=await createTask(entry,{assignee:'user',title:'Определить цель и критерии приёмки',kind:'brief',instructions:`Inspect the actual task/project. Define audience/player, primary journey, meaningful acceptance criteria and visual ambition. Keep it concise. Do not prescribe a composition before exploration. For a game identify actual engine and key mechanics to verify. Do not run a full regression yet.\n${args.task}`,dependsOn:[]},exec.signal);
  return {status:'running',briefTaskId:brief.id,next:'Wait for the User brief, create suitable named specialists and dependency tasks. Coordinate until gvs_finish accepts all gates.'};
 });
 register('gvs_browser_capabilities','Read the ACTUAL GVS browser runtime/module/version/executable and isolated engine launch/input/media capabilities. Available to discovery/read roles before any review task or run; no product URL, shell or installation needed. Do not guess product node_modules/default caches or equate an executable file with a successful launch. This is diagnostics, not product/device acceptance.',{},[],async(_args,exec)=>{
  const {entry}=await current(exec,false);return {status:'browser-capabilities',acceptanceEvidence:false,target:entry?.run.qaTarget?.surfaces??null,engines:await browserCapabilities(config),next:'Use these actual runtime/executable paths when diagnosing the GVS adapter. Unavailable engines and unsupported settings remain limitations. Do not install another runtime from guessed paths, waive review, or claim a physical device was tested. Non-web products still require their own actual engine/process/native-window drivers.'};
 });
 register('gvs_project','Inspect actual project manifests and execution targets before choosing QA tools. Detects web, native games (Unity/Godot/Unreal), native UI, CLI/bot/service and mixed targets. Returns adapter/evidence contracts, not claims that engines or drivers are installed. Create needed specialist/driver tasks yourself; never force a browser matrix on non-web products.',{},[],async(_args,exec)=>{
  const {root,entry}=await current(exec,false),target=await inspectProject(root,exec.signal,entry?.run.engine??'');if(entry){entry.run.qaTarget=target;await commit(entry);}return {target,next:'Discover actual runtime/entrypoints and feature-specific risks. Use the listed appropriate existing tools; if a driver is missing, assign a concrete adapter task to an existing or newly inferred specialist. Do not invent test results or substitute localhost for native/CLI execution.'};
 });
 register('gvs_agent','Create, list, wake, message, retire or request a persistent named role. Only Lead creates roles; teammates may message peers or request help. Wake rechecks EXISTING tasks and respects dependencies; use gvs_task create for NEW work. Message only clarifies existing work.',{action:{type:'string',enum:['create','list','wake','message','retire','request']},name:text(40),title:text(80),purpose:text(1200),instructions:text(5000),capability:{type:'string',enum:['read','edit','verify']},message:text(5000)},['action'],async(args,exec)=>{
  const {member,entry}=await current(exec);
  if(args.action==='list')return {roles:entry.run.roles};
  if(args.action==='request'){
   if(member.role==='lead')return {status:'coordinator-planning-required',accepted:false,requested:false,next:'You coordinate this team. Create/reuse suitable expertise and assign an actual task, or schedule a User consultation for an unresolved goal question. No self-request or team change was recorded.'};
   if(!args.message?.trim()&&!args.purpose?.trim())throw new Error('Explain the concrete missing expertise or task dependency.');
   entry.run.goal.roleRequests??=[];const request={id:`need-${randomUUID().slice(0,8)}`,from:member.name,purpose:args.message??args.purpose,capability:args.capability??null,agent:null,taskId:null};entry.run.goal.roleRequests.push(request);delete entry.run.goal.handoff;await commit(entry);
   await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS ROLE REQUEST ${request.id} from ${member.name}: ${args.message??args.purpose}. Coordinator: create or reuse a suitable role and dependency task, then gvs_goal link requestId=${request.id} agentName/taskId. This durable request blocks completion until assigned.`}],signal:exec.signal});return {status:'request-sent',requestId:request.id};
  }
  if(args.action==='message'){if(!args.name||!args.message)throw new Error('Provide recipient name and message.');const target=args.name.toLowerCase()==='lead'?'lead':args.name;if(target.toLowerCase()===member.name.toLowerCase()){await noteFailure(entry,exec,'Self-message was not sent; address the actual teammate or coordinator instead.');return {status:'self-message',accepted:false,sent:false,next:'This is your own identity. Continue your actual assignment, or send the concrete result/question to the real recipient (lead for a specialist). No message was sent.'};}await ctx.agentTeams.sendMessage(exec.agent,{target,content:[{type:'text',text:args.message}],signal:exec.signal});return {status:'message-accepted',target};}
  lead(member);
  if(args.action==='create')return {role:await createRole(entry,args,exec.signal)};
  const role=roleOf(entry,args.name);if(!role)throw new Error('Unknown role');
  if(args.action==='retire'){
   if(entry.run.tasks.some(task=>task.assignee===role.name&&['waiting','running'].includes(task.state)))throw new Error('Resolve this role’s outstanding tasks before retiring it.');
   role.retired=true;await commit(entry);return {status:'retired',name:role.name};
  }
  role.retired=false;
  if(!role.sessionId)await createRole(entry,role,exec.signal);
  const assigned=entry.run.tasks.find(task=>task.assignee===role.name&&['waiting','running','blocked'].includes(task.state));
  if(!assigned)return {status:'idle',sessionId:role.sessionId,reused:true,next:'Create a new task for this existing role with gvs_task create. No new agent is needed.'};
  if(assigned.state==='running'&&args.message)await ctx.agentTeams.sendMessage(entry.root,{target:role.name,content:[{type:'text',text:`Clarification for existing ${assigned.id}: ${args.message}`}],signal:exec.signal});
  await schedule(entry,exec.signal);await commit(entry);
  return {status:assigned.state,taskId:assigned.id,dependsOn:assigned.dependsOn,sessionId:role.sessionId,reused:true,next:assigned.state==='blocked'?'Resolve the blocker and use gvs_task retry.':assigned.state==='waiting'?'Dependencies/resources are not ready; the scheduler wakes this agent automatically.':'This agent is already working on the existing task.'};
 });
 register('gvs_task','Create tasks with real dependencies; waiting tasks wake automatically. For complete, REQUIRED top-level fields are taskId, verdict (pass/revise/blocked), summary and findings (explicit [] for pass); do not nest them inside result. Increment create/update requires explicit analysisIds ([] for an actual static slice). Reviews report real checks/images/findings; blocked tasks keep dependants waiting.',
  {action:{type:'string',enum:['create','list','complete','retry','dependencies','update']},taskId:text(40),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60},title:text(180),instructions:text(15000),assignee:text(40),kind:{type:'string',enum:taskKinds},dependsOn:strings,writeScopes:strings,readScopes:strings,externalReadScopes:{...strings,description:"Absolute external environment read leases; scheduling metadata only, not a permission grant."},externalWriteScopes:{...strings,description:"Absolute external environment write leases; outside-workspace Native write/edit remain disallowed."},resources:{...strings,description:'Exclusive resource names. Omit for conservative project-runtime locking on edit/verify tasks; [] only for isolated work. Literal workspace read/write paths may end in /**.'},priority:{type:'integer',minimum:-100,maximum:100},reason:{...text(1000),description:"Optional audit rationale for update. If omitted, an exact description is derived from changed fields."},codePlan:codePlanInput,scope:{type:'string',enum:['increment','full']},reviewFocus:{type:'string',enum:['visual','source'],description:'Lead-assigned source only for static/native/ABI source reviews: kind review, scope increment, analysisIds []. No visual/full-goal waiver.'},analysisIds:strings,
   verdict:{type:'string',enum:['pass','revise','blocked']},summary:text(4000),findings:{...strings,description:'ALL actionable required fixes, missing functionality, visual mismatches, untested required coverage or blockers. For pass use []. Neutral/positive evidence belongs in observations, never hide an unresolved obligation there.'},observations:{...strings,items:text(1600),description:'Non-actionable facts, positive inspections or corrected tool-debug notes. These are saved evidence notes, not repair obligations or acceptance proof. Every unresolved required defect, coverage gap and blocker MUST still be in findings.'},scopeReviewed:{type:'boolean',description:'Independently compared the entire human goal and feature inventory against implementation; accepting the recent repair alone is insufficient.'},coveredRequirements:{...strings,maxItems:1000},addressedIssues:{...strings,maxItems:1000},inventory:{type:'array',maxItems:100,items:{...object({feature:text(500),evidence:text(1500),status:{type:'string',enum:['confirmed','unknown']},requirementIds:strings}),required:['feature','evidence','status','requirementIds']}},checks:{...strings,description:'ONLY exact verbatim foreground command strings, e.g. node test.mjs. No commentary, prefixes, read tools or annotations.'},images:{...strings,maxItems:1000},analysisReports:strings,simple:{type:'boolean'},scopePreserved:{type:'boolean'},adapterReviewed:{type:'boolean'},visualReview:{...object({manualCoverage:text(2000),checked:{type:'array',items:{type:'string',enum:VISUAL_CHECKS},maxItems:7},assessments:{type:'array',maxItems:1000,items:{...object({warningId:text(60),imageId:text(150),disposition:{type:'string',enum:['intentional','defect','outside-scope']},reason:text(1000)}),required:['warningId','imageId','disposition','reason']}}}),required:['checked','assessments']}},['action'],async(args,exec)=>{
   const {member,entry,name}=await current(exec);
   if(member.role!=='lead'&&['create','update','retry','dependencies'].includes(args.action)){
    const own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
    if(!own)return {status:'not-assigned',accepted:false,applied:false,next:'No live task is assigned to you. Do not change or poll another assignment; the scheduler wakes your same identity when needed.'};
    entry.forwardedPlanRequests??=new Set();const key=createHash('sha256').update(name+JSON.stringify(args)).digest('hex'),duplicate=entry.forwardedPlanRequests.has(key);
    if(!duplicate){await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS TASK PLAN PROPOSAL from ${name} on ${own.id}: ${clip(JSON.stringify(args),6000)}. This is a proposal only: NO task/owner/access/dependency/plan changes were applied. Inspect current source and contracts before accepting; the coordinator retains all authority.`}],signal:exec.signal});entry.forwardedPlanRequests.add(key);}
    return {status:'forwarded-to-coordinator',accepted:false,applied:false,duplicate,taskId:args.taskId??null,next:'Your proposal was sent to Lead without changing the task graph or permissions. Continue the actual owned slice, or report a concrete blocker; do not repeatedly submit the same proposal or impersonate Lead.'};
   }
   if(args.action==='list'){
    if(args.taskId){
     const tasks=taskSummaries(entry.run.tasks.filter(task=>task.id===args.taskId),true),offset=args.offset??0,limit=args.limit??4;
     for(const task of tasks)if(task.result){const {inventory=[],findings=[],observations=[]}=task.result;task.result={...task.result,inventory:inventory.slice(offset,offset+limit),findings:findings.slice(offset,offset+limit),observations:observations.slice(offset,offset+limit),totals:{inventory:inventory.length,findings:findings.length,observations:observations.length},nextOffset:offset+limit<Math.max(inventory.length,findings.length,observations.length)?offset+limit:null};}
     const original=entry.run.tasks.find(task=>task.id===args.taskId),manifest=original?await artifactManifest(entry,original,exec.signal):null;
     return {tasks,...(original?{visualStateCount:visualStates(entry.run,original).length,userTesting:userJourneyStatus(entry.run,original),visualNext:'Inspect actual required pixels with gvs_visual action:states taskId and offset/limit; use its exact imageIds, never guessed hashes.'}:{}),artifacts:manifest?{...manifest,files:manifest.files.slice(0,20),total:manifest.files.length,nextOffset:manifest.files.length>20?20:null}:null};
    }
    const tasks=[...entry.run.tasks.filter(task=>task.state!=='done'),...entry.run.tasks.filter(task=>task.state==='done').reverse()],offset=args.offset??0,limit=args.limit??10;
    return {tasks:taskSummaries(tasks.slice(offset,offset+limit)),total:tasks.length,nextOffset:offset+limit<tasks.length?offset+limit:null};
   }
   if(args.action==='create'){lead(member);const task=await createTask(entry,args,exec.signal);return {task,...(task.planRequired&&!task.codePlan?{status:'needs-coordinator-plan',next:'Coordinator must inspect current source and supply gvs_task update codePlan: summary, changes[{path,anchor,edit}], checks (exact commands), acceptance. This edit task has not been dispatched.'}:{})};}
   if(args.action==='update'){
    lead(member);const task=entry.run.tasks.find(task=>task.id===args.taskId);
    if(!task)throw new Error(`Unknown task ${args.taskId??'(missing taskId)'}. No changes applied. Read gvs_task action:list and copy the exact existing taskId.`);
    if(task.state==='done')return {status:'already-completed',updated:false,task:taskSummaries([task],true)[0],next:'No changes were applied to the completed task. Preserve its result; create a linked follow-up for actual remaining work.'};
    if(!['waiting','running','blocked'].includes(task.state))throw new Error('Update only an outstanding task.');
    const access=parallelFields(args,entry.io.cwd),reassign=args.assignee&&args.assignee!==task.assignee;
    if(reassign){
     const role=roleOf(entry,args.assignee);
     if(!role?.sessionId||role.retired||['review','game-review'].includes(task.kind)&&role.capability!=='verify'||task.kind==='discovery'&&!['read','verify'].includes(role.capability)||task.kind==='design-review'&&role.capability==='edit'||['user-review','brief','consultation'].includes(task.kind)&&role.name!=='user')throw new Error('Reassign to a registered, suitable independent role; User decisions stay with user.');
    }
    const scope=args.scope||args.reviewFocus||args.analysisIds!==undefined?reviewPlan(entry.run,{...task,...args}):{};
    validateWriteScopes(roleOf(entry,reassign?args.assignee:task.assignee),access.writeScopes??task.writeScopes);
    const leaseChange=task.state==='running'&&runningAccessChange(entry.run,task,{...scope,...access,...(reassign?{assignee:args.assignee}:{})});
    if(leaseChange)throw new Error(`Do not change the owner/exclusive lease or shrink read access of a running task. Read-only expansion is allowed only without active write/resource conflicts. ${JSON.stringify(leaseChange)}. Preserve this slice; queue a scoped follow-up for conflicting changes.`);
    const plan=args.codePlan?await codePlan(entry,{...task,...scope,...access,...(reassign?{assignee:args.assignee}:{})},args.codePlan):null;
    const changes={...scope,...access,...(plan?{codePlan:plan,planStale:false,stalePlanFiles:[]}:{}),...(reassign?{assignee:args.assignee}:{}),...(args.instructions?{instructions:args.instructions}:{}),...(args.title?{title:args.title}:{}),...(args.priority!==undefined?{priority:args.priority}:{})};
    const fields=Object.keys(changes).filter(key=>JSON.stringify(task[key])!==JSON.stringify(changes[key]));
    if(!fields.length)return {status:'unchanged',updated:false,task:taskSummaries([task],true)[0],next:'The requested values already match. The task, assignment and remaining requirements are unchanged.'};
    const reason=args.reason?.trim()||`Updated ${fields.join(', ')} on existing ${task.id}. Remaining human requirements and owned follow-ups stay binding.`;
    if(fields.includes('writeScopes')){const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'edit',writeScopes:access.writeScopes});}
    Object.assign(task,changes);if(fields.includes('codePlan')||reassign)delete task.planContinuation;if(reassign)task.consultations=[];
    task.lastUpdate={at:new Date().toISOString(),reason,reasonSource:args.reason?.trim()?'provided':'derived',fields};
    await commit(entry);
    if(task.state==='running'){
     const message=`UPDATED EXISTING ${task.id}: ${reason}\nREVIEW FOCUS: ${task.reviewFocus??'visual'}; scope=${task.scope??'full'}. Source focus is only static/source increment evidence, never visual or final acceptance.\nCURRENT ASSIGNMENT: ${task.instructions}\nCOORDINATOR CODE PLAN: ${JSON.stringify(task.codePlan??null)}\nContinue this same task/identity; old unrelated work remains owned in follow-up tasks and the full goal is still binding.`;
     const delivery=assignmentDelivery(message,[],`UPDATED EXISTING ${task.id}: ${reason}. Read gvs_task action:list taskId:${task.id} for the full current instructions and coordinator codePlan before implementing. Preserve the same task/identity and every remaining human requirement.`);
     await ctx.agentTeams.sendMessage(entry.root,{target:task.assignee,content:delivery.content,signal:exec.signal});
    }
    await schedule(entry,exec.signal);return {updated:true,update:task.lastUpdate,task:taskSummaries([task],true)[0]};
   }
   if(['retry','dependencies'].includes(args.action)){
    lead(member);const task=entry.run.tasks.find(task=>task.id===args.taskId);
    if(!task)throw new Error('Unknown task. Retry/change dependencies only for an existing task.');
    if(args.action==='retry'&&['running','done'].includes(task.state))return {status:task.state==='running'?'already-running':'already-completed',retried:false,task:taskSummaries([task],true)[0],next:'The existing task already advanced; no duplicate assignment or requested instruction/dependency changes were applied. Read its current result; create a follow-up only for new work.'};
    if(args.action==='dependencies'&&['running','done'].includes(task.state))return {status:task.state==='running'?'already-running':'already-completed',accepted:false,updated:false,taskId:task.id,state:task.state,dependsOn:task.dependsOn,next:'The task advanced before this request. No dependency/instruction changes were applied. Preserve its result or live assignment; use an owned queued follow-up for new prerequisites, or update for instructions that do not change a running lease.'};
    if(!['blocked','waiting'].includes(task.state))throw new Error('Retry/change dependencies only for blocked or waiting tasks.');
    if(args.instructions)task.instructions=args.instructions;
    if(args.dependsOn){assertDag(entry.run.tasks.map(item=>item.id===task.id?{...item,dependsOn:args.dependsOn}:item));const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'set_dependencies',blockedBy:args.dependsOn});task.dependsOn=args.dependsOn;}
    if(args.action==='retry'){const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});task.state='waiting';delete task.result;}
    await commit(entry);await schedule(entry,exec.signal);return {task};
   }
   const task=entry.run.tasks.find(task=>task.id===args.taskId);
   if(task&&task.assignee!==name)return {status:'not-owner',accepted:false,completed:false,taskId:task.id,state:task.state,assignee:task.assignee,next:'No result was accepted or changed. The assigned teammate must report its own evidence. Read the actual current owner/state and send it concrete feedback; Lead coordinates owned repairs/rechecks instead of completing a colleague task.'};
   if(task?.assignee===name&&task.state==='done')return {status:'already-completed',completed:false,changed:false,taskId:task.id,previousVerdict:task.result?.verdict,previousSummary:clip(task.result?.summary,600),findings:(task.result?.findings??[]).slice(0,4).map(f=>clip(f,400)),findingsTotal:task.result?.findings?.length??0,next:'No new result was accepted. Read the existing verdict/evidence via paged gvs_task list taskId; do not repeat completion or replace this result. New work needs an owned follow-up.'};
   if(task?.assignee===name&&task.state!=='done'&&Array.isArray(args.findings))args={...args,findings:[...new Set([...args.findings,...visualAssessmentFindings(entry.run,task,args,[...entry.run.visualChecks,...(entry.run.responsiveChecks??[])])])]};
   if(task?.assignee===name&&['waiting','blocked'].includes(task.state)&&['revise','blocked'].includes(args.verdict)&&args.summary&&Array.isArray(args.findings)){
    const issues=recordFindings(entry.run,{...task,result:{verdict:args.verdict,summary:args.summary,findings:args.findings}});await commit(entry);
    if(issues.length)await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS INTERRUPTED REVIEW FEEDBACK ${JSON.stringify({taskId:task.id,state:task.state,summary:clip(args.summary,1500),findings:args.findings,issueIds:issues.map(i=>i.id)})}. Feedback is preserved without completing a queued assignment or claiming current acceptance. Assign repairs and rechecks; the scheduler retains the same task.`}],signal:exec.signal});
    return {status:'feedback-forwarded',completed:false,taskId:task.id,state:task.state,issueIds:issues.map(i=>i.id),next:'Your findings are preserved and sent to Lead. End this turn; do not poll or repeat completion. The scheduler will wake this same task when its dependencies/leases are ready.'};
   }
   if(task?.assignee===name&&['waiting','blocked'].includes(task.state))return {status:'not-running',completed:false,accepted:false,taskId:task.id,state:task.state,blocker:task.state==='waiting'?parallelBlocker(entry.run,task):task.result?.summary,next:'Your proposed pass was NOT evaluated or accepted. This task is queued/blocked, not assigned for execution now. End this turn; do not poll or repeat complete. When the scheduler wakes this same task, actually execute its current scenarios/checks and report fresh evidence. Negative feedback can be forwarded with revise/blocked and findings.'};
   if(!task||task.assignee!==name||task.state!=='running')throw new Error('Only the assigned running teammate may complete this task. Inspect its current owner and state; do not complete another role’s task.');
   if(args.reviewFocus!==undefined&&args.reviewFocus!==(task.reviewFocus??'visual'))throw new Error('Review focus belongs to the coordinator assignment. Ask Lead to update an actual source-only increment; do not waive an assigned visual review yourself.');
   if(!args.verdict||!args.summary||!Array.isArray(args.findings))throw new Error(`Provide verdict, summary and findings as TOP-LEVEL gvs_task fields for ${task.id}. Required shape: {action:"complete",taskId:"${task.id}",verdict:"pass|revise|blocked",summary:"actual result",findings:["required fixes/blockers"]}. Use findings:[] only when there are no required fixes. Keep all assigned evidence and review fields; this error did not complete the task.`);
   if(args.verdict==='pass'&&args.findings.length)return {status:'needs-verdict-correction',accepted:false,completed:false,taskId:task.id,state:task.state,findings:args.findings,next:'No pass was accepted and no finding was discarded. Required fixes/blockers require verdict:revise or blocked; positive observations belong in summary. Resubmit the same task with the correct verdict and retain all required evidence.'};
   if(args.verdict==='pass'&&needsCodePlan(entry.run,task)&&task.codePlan){
    const currentSources=await planSources(task.codePlan,entry.io.bytes);
    const successful=entry.run.checks.filter(check=>check.taskId===task.id&&check.at>=task.startedAt&&check.finished&&!check.error&&check.exitCode===0&&JSON.stringify(check.codePlanSources?.filter(item=>currentSources.some(source=>source.path===item.path)))===JSON.stringify(currentSources)).map(check=>check.command);
    const missing=task.codePlan.checks.filter(command=>!successful.includes(command)||!args.checks?.includes(command));
    if(missing.length)throw new Error(`Coordinator plan checks must actually pass in this assignment and be listed verbatim in checks: ${JSON.stringify(missing)}. Ask Lead to correct an unsuitable plan; do not fabricate results.`);
    const missingOutputs=await missingPlanOutputs(task.codePlan,entry.io.bytes);if(missingOutputs.length)throw new Error(`Planned outputs are missing or empty: ${JSON.stringify(missingOutputs)}. Create the actual promised files before pass; do not claim a handoff that does not exist.`);
    if(task.codePlan.sources.length&&!(await stalePlanFiles(task.codePlan,entry.io.bytes)).length)throw new Error('No planned file changed from the coordinator source snapshot. Implement the plan or report the actual blocker; a prose acknowledgement is not code delivery.');
   }
   if((args.coveredRequirements??[]).some(id=>!entry.run.goal.requirements.some(req=>req.id===id))||(args.addressedIssues??[]).some(id=>!entry.run.goal.issues.some(issue=>issue.id===id)))throw new Error('Attest only actual requirement/issue IDs from gvs_goal status.');
   if(task.kind==='brief'&&args.verdict==='pass'&&entry.run.analysis?.state!=='ready')throw new Error('The User must first call gvs_analysis plan, selecting only analyses this task needs. Use [] with a concrete rationale for a simple task.');
   if(task.kind==='brief'&&args.verdict==='pass'&&(!entry.run.goal.requirements.length||goalStatus(entry.run).unassessed.length))throw new Error('First call gvs_goal plan to cover the actual human messages; a local subset cannot replace the human contract.');
   if(task.kind==='discovery'&&args.verdict==='pass'&&(!args.inventory?.length||args.inventory.some(item=>!item.requirementIds.length||item.requirementIds.some(id=>!entry.run.goal.requirements.some(req=>req.id===id)))))throw new Error('Discovery needs a source-backed feature/protocol/state inventory mapped to existing requirement IDs. Unknown features remain explicit requirements/blockers.');
   const reviewRun=task.scope==='increment'?{...entry.run,analysis:{...entry.run.analysis,requirements:entry.run.analysis?.requirements.filter(item=>task.analysisIds.includes(item.id))??[]}}:entry.run;
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!analysisReady(reviewRun))throw new Error('Task-specific analysis is incomplete or lacks independent adapter review. Do not accept visible smoothness from transform values or static screenshots.');
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!analysisAcceptance(reviewRun,{...task,result:{analysisVersion:entry.run.analysis?.version??0,analysisReports:args.analysisReports??[]}}))throw new Error('Cite received current analysisReports IDs when accepting task-specific evidence.');
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!imageAcceptance(entry.run,{...task,result:{images:args.images??[]}}))throw new Error('A rendered review requires actual current images for each assigned viewport, including increment reviews.');
   if(task.kind==='review'&&args.verdict==='pass'&&(args.analysisReports??[]).some(id=>!(entry.run.analysisChecks??[]).some(report=>report.id===id&&report.ok&&report.revision===entry.run.revision&&report.planVersion===entry.run.analysis?.version&&report.capturedBy!==name)) )throw new Error('Independently review only successful current analysis reports captured by another agent.');
   if(name!=='user'&&!task.consultations.some(id=>reusableDecision(entry.run,id))&&args.verdict==='pass')throw new Error(`Use gvs_ask_user with a current recorded User decision (reuseTaskId) or one focused unanswered question. Current reusable IDs: ${availableDecisions(entry.run).map(item=>item.taskId).join(', ')||'none'}. gvs_ask_user action:status lists their actual summaries. Do not repeat the full regression or readiness audit.`);
   const checks=args.checks??[];
   if(task.kind==='review'&&args.verdict==='pass'&&(!checks.length||checks.some(command=>!entry.run.checks.some(check=>check.taskId===task.id&&check.command.trim()===command.trim()&&check.finished&&!check.error&&check.exitCode===0))))throw new Error(`checks must contain ONLY verbatim successful command strings, without commentary. Available exact commands for this task: ${JSON.stringify([...new Set(entry.run.checks.filter(check=>check.taskId===task.id&&check.finished&&!check.error&&check.exitCode===0).map(check=>check.command))])}. Move non-actionable observations to observations/summary. Do not use a game adapter for an ordinary code task.`);
   validateResponsiveAcceptance(entry.run,task,args);
   const externalVisualFindings=validateVisualReview(entry.run,task,args),artifacts=await artifactManifest(entry,task,exec.signal);
   task.result={verdict:args.verdict,summary:args.summary,findings:args.findings,observations:(args.observations??[]).map(item=>clip(item,1600)),inventory:args.inventory??[],scopeReviewed:args.scopeReviewed===true,coveredRequirements:args.coveredRequirements??[],addressedIssues:args.addressedIssues??[],checks,images:args.images??[],analysisReports:args.analysisReports??[],analysisVersion:entry.run.analysis?.version??0,simple:args.simple===true,scopePreserved:args.scopePreserved===true,reviewFocus:task.reviewFocus??'visual',adapterReviewed:args.adapterReviewed===true,visualReview:args.visualReview??null,revision:entry.run.revision};
   if(name==='user'&&['brief','consultation'].includes(task.kind))task.result.decisionKey=decisionKey(entry.run);
   task.result.artifacts=artifacts.files.slice(0,40);task.result.artifactManifest={total:artifacts.files.length,truncated:artifacts.truncated||artifacts.files.length>40,warnings:artifacts.warnings};
   if(['brief','consultation','discovery'].includes(task.kind))entry.run.progress.metadataSinceWrite++;
   task.state=args.verdict==='blocked'?'blocked':'done';
   if(task.state==='done'){const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'complete'});}
   entry.waiters.get(task.id)?.(task.result);entry.waiters.delete(task.id);
   const issues=[...recordFindings(entry.run,task),...(externalVisualFindings.length?recordFindings(entry.run,{...task,result:{verdict:'revise',summary:'Visual defects outside this increment remain mandatory',findings:externalVisualFindings}}):[])];
   await commit(entry);
   try{await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS TASK RESULT ${JSON.stringify({taskId:task.id,assignee:name,kind:task.kind,verdict:task.result.verdict,summary:clip(task.result.summary,1000),findings:task.result.findings.map(item=>clip(item,600)),observations:task.result.observations.slice(0,3).map(item=>clip(item,400)),observationCount:task.result.observations.length,issueIds:issues.map(item=>item.id),inventoryItems:task.result.inventory.length,artifacts:task.result.artifacts?.slice(0,12)})}\nCoordinator: read the full result via gvs_task list, process EVERY finding, create/link repair and independent recheck tasks with gvs_goal. Continue the complete human goal; this is not permission to narrow scope or end the run.`}],signal:exec.signal});}
   catch(error){task.notificationError=clip(error.message,500);await commit(entry);}
   await schedule(entry,exec.signal);return {task};
  });
 register('gvs_ask_user','action:status lists current reusable User decisions. An explicit reuseTaskId requests reuse even with action:status; this binds that actual current decision to your task without creating another consultation. Otherwise ask one consequential unanswered question. Do not ask for repeated readiness/ownership approval or permission.',{action:{type:'string',enum:['status','ask']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20},question:text(2000),context:text(6000),reuseTaskId:text(40)},[],async(args,exec)=>{
  const {entry,name}=await current(exec);
  if(args.action==='status'&&!args.reuseTaskId){const decisions=availableDecisions(entry.run),offset=args.offset??0,limit=args.limit??6;return {decisions:decisions.slice(offset,offset+limit),total:decisions.length,nextOffset:offset+limit<decisions.length?offset+limit:null,next:'Reuse only a relevant decision with the exact call {action:"ask",reuseTaskId:<current taskId>}. Listing status alone does not consult. If none applies, ask one focused unanswered question; do not repeat general readiness audits.'};}
  if(name==='user')return {status:'self-advocate',accepted:false,consulted:false,next:'You ARE the central User. Answer your assigned brief/consultation directly using the human contract and evidence, then complete its actual task ID. Do not consult yourself, create approval tasks, waive requirements or grant human permission.'};
  if(name==='lead'){await noteFailure(entry,exec,'The coordinator must schedule an actual User consultation, not use specialist-only consultation.');return {status:'coordinator-consultation-required',accepted:false,consulted:false,next:'Use gvs_ask_user action:status to read current decisions, or gvs_task action:create assignee:user kind:consultation with the concrete unresolved question. No consultation/task or permission was created.'};}
  const own=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running');if(!own)throw new Error('No assigned running task');
  const key=args.question?consultationKey(args.question,args.context):null;
  const cached=args.reuseTaskId?reusableDecision(entry.run,args.reuseTaskId):entry.run.tasks.find(task=>task.questionKey===key&&reusableDecision(entry.run,task.id));
  if(args.reuseTaskId&&!cached)throw new Error(`Reuse only a passed User brief/consultation for the current human contract and analysis criteria. ${args.reuseTaskId} is not reusable. Current reusable IDs: ${availableDecisions(entry.run).map(item=>item.taskId).join(', ')||'none'}. Read gvs_ask_user action:status; choose an actually relevant decision, or ask one focused unanswered question. A new or changed decision needs a focused question.`);
  if(cached){if(!own.consultations.includes(cached.id))own.consultations.push(cached.id);await commit(entry);return {answer:cached.result,userTaskId:cached.id,reused:true};}
  if(!args.question?.trim())throw new Error('Provide an actual unanswered question or reuseTaskId.');
  const role=roleOf(entry,name);role.waitingForUser=true;
  const task=await createTask(entry,{assignee:'user',title:`Ответить: ${role.title}`,kind:'consultation',instructions:`Answer this concrete colleague question critically against the human goal. Use supplied actual evidence; do not repeat unrelated regression. Complete this consultation task with pass/revise/blocked and useful summary/findings.\nQUESTION: ${args.question}\nCONTEXT: ${args.context??''}`},exec.signal);
  task.questionKey=key;
  try{
   const result=task.result??await new Promise((resolve,reject)=>{
    const abort=()=>{entry.waiters.delete(task.id);reject(exec.signal.reason??entry.abort.signal.reason);};
    exec.signal.addEventListener('abort',abort,{once:true});entry.abort.signal.addEventListener('abort',abort,{once:true});
    entry.waiters.set(task.id,value=>{exec.signal.removeEventListener('abort',abort);entry.abort.signal.removeEventListener('abort',abort);resolve(value);});
    if(exec.signal.aborted||entry.abort.signal.aborted)abort();
   });
   own.consultations.push(task.id);return {answer:result,userTaskId:task.id,userSessionId:roleOf(entry,'user').sessionId};
  }finally{role.waitingForUser=false;await commit(entry);}
 },600000);
 register('gvs_parallel','Inspect actual parallel capacity, file/resource conflicts and dependency waits. Lead may configure 1..8 non-User slots; agents are created/reused through gvs_agent and assigned real scoped tasks, not by this tool.',{action:{type:'string',enum:['status','configure']},maxParallel:{type:'integer',minimum:1,maximum:8}},['action'],async(args,exec)=>{
  const {member,entry}=await current(exec);
  if(args.action==='configure'){lead(member);if(!Number.isInteger(args.maxParallel)||args.maxParallel<1||args.maxParallel>8)throw new Error('Choose 1..8 parallel slots.');entry.run.parallelLimit=args.maxParallel;await commit(entry);await schedule(entry,exec.signal);}
  return {status:entry.run.status,parallel:parallelStatus(entry.run,entry.run.parallelLimit??maxParallel)};
 });
 register('gvs_wait','Wait up to 30 seconds for actual team activity, then inspect results. Dependencies wake agents automatically; do not poll inactive teammates.',{seconds:{type:'integer',minimum:10,maximum:30}},[],async(args,exec)=>{
  const {member,entry,name}=await current(exec);
  if(member.role!=='lead')return {status:entry.run.status,ownTasks:entry.run.tasks.filter(t=>t.assignee===name&&t.state!=='done').map(t=>({id:t.id,state:t.state,blocker:t.state==='waiting'?parallelBlocker(entry.run,t):null})),next:'This is a read-only assignment snapshot, not a plan change. If your task is running, continue or report actual blockers. If queued, end this turn; the scheduler wakes your existing conversation automatically. Do not poll or create duplicate tasks.'};
  await schedule(entry,exec.signal);const progress=progressStatus(entry.run,Date.now(),config.maxSliceMs??1200000);if(progress.needsIntervention)return {status:'needs-coordination',progress};if(!entry.run.tasks.some(task=>task.state==='running'))return {status:'needs-coordination',progress};await ctx.agentTeams.waitForChange(exec.agent,(args.seconds??20)*1000,exec.signal);return {status:entry.run.status,progress};
 },35000);
 register('gvs_diagnostics','Read automatically captured tool errors across coordinator and teammates. Lead must diagnose repeated errors proactively; legitimate failed checks retain their evidence gates.',{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}},[],async(args,exec)=>{const {entry}=await current(exec),rows=[...(entry.run.diagnostics??[])].sort((a,b)=>b.lastAt-a.lastAt),offset=args.offset??0,limit=args.limit??8;return {...diagnosticStatus(entry.run),errors:rows.slice(offset,offset+limit).map(({identity,...row})=>row),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null};});
 register('gvs_status','Read saved GVS team state, decisions and evidence in this session.',{},[],async(_args,exec)=>{
  const {entry,root}=await current(exec,false);if(entry)return {status:entry.run.status,quality:entry.run.quality,parallel:parallelStatus(entry.run,entry.run.parallelLimit??maxParallel),userDecisions:availableDecisions(entry.run).slice(-6),
   checks:entry.run.checks.slice(-8).map(({agent,taskId,command,exitCode,finished,error,output})=>({agent,taskId,command,exitCode,finished,error,output:clip(output,800)})),
   gameChecks:entry.run.gameChecks.slice(-8).map(({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,views})=>({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,errors:(views??[]).flatMap(view=>view.errors)})),preview:entry.run.preview,progress:progressStatus(entry.run)};
  try{const io=await storage(root,exec.signal);const legacy=JSON.parse(await io.read('.gvs/latest.json'));return {status:legacy.status,legacy:true,summary:legacy.summary};}catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return {status:'no-runs'};throw error;}
 });
 register('gvs_artifacts','Discover actual existing output files for a task, including historical tasks. Read these exact paths instead of inventing HANDOFF.md or INTEGRATION.md. An active producer may not have created its report yet.',{taskId:text(40),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:40}},['taskId'],async(args,exec)=>{
  const {entry}=await current(exec),task=entry.run.tasks.find(task=>task.id===args.taskId);
  if(!task)throw new Error('Unknown task. Copy its exact ID from gvs_task list.');
  const manifest=await artifactManifest(entry,task,exec.signal),offset=args.offset??0,limit=args.limit??20;
  return {...manifest,files:manifest.files.slice(offset,offset+limit),total:manifest.files.length,nextOffset:offset+limit<manifest.files.length?offset+limit:null};
 });
 register('gvs_visual','Read existing screenshots: action states pages ALL required initial/intermediate/final frames, including those with no warnings; copy exact imageIds after inspection. Default warnings pages geometry candidates for independent pixel judgement. Never recapture to repair a citation error.',{action:{type:'string',enum:['warnings','states']},taskId:text(40),imageId:text(150),warningId:text(60),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:6}},[],async(args,exec)=>{
  const {entry,name}=await current(exec),status=visualAuditStatus(entry.run),offset=args.offset??0,limit=args.limit??6;
  if(args.action==='states'){
   const task=args.taskId?entry.run.tasks.find(t=>t.id===args.taskId):entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
   if(!task)throw new Error('Provide an existing taskId, or use the assigned running review task.');
   const all=visualStates(entry.run,task),states=args.imageId?all.filter(s=>s.imageId===args.imageId):all.slice(offset,offset+limit);
   if(args.imageId&&!states.length)throw new Error('That imageId is not a current required audited state for this task. Read action:states without imageId and copy its literal ID.');
   const images=states.map(s=>s.image),own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
   if(own){own.receivedImages=[...new Set([...(own.receivedImages??[]),...images.map(i=>i.attachment.attachmentId)])];await commit(entry);}
   return {taskId:task.id,revision:entry.run.revision,total:all.length,states:states.map(({image,contexts,...state})=>({...state,contexts:contexts.slice(0,16),contextCount:contexts.length})),images,nextOffset:!args.imageId&&offset+limit<all.length?offset+limit:null,requiredChecks:VISUAL_CHECKS,next:'Inspect these actual pixels, including initial dialogs and intermediate states without warnings. Cite ALL required literal imageIds in complete.images and classify visible warning candidates via action:warnings. Retrieval is not a pass and does not auto-attest inspection. If there are no current states, capture fresh evidence for the current source.'};
  }
  const ordered=[...status.warnings.filter(w=>!w.qaReviewed||!w.userReviewed),...status.warnings.filter(w=>w.qaReviewed&&w.userReviewed)];
  const warnings=args.warningId?ordered.filter(w=>w.id===args.warningId):ordered.slice(offset,offset+limit),images=[];
  const available=entry.run.visualChecks.filter(c=>c.revision===entry.run.revision).flatMap(c=>c.images);
  for(const warning of warnings){const image=available.find(i=>warning.images.includes(i.attachment.attachmentId));if(image&&!images.some(i=>i.attachment.attachmentId===image.attachment.attachmentId))images.push(image);}
  const own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');if(own){own.receivedImages=[...new Set([...(own.receivedImages??[]),...images.map(i=>i.attachment.attachmentId)])];await commit(entry);}
  return {ready:status.ready,total:ordered.length,warnings,images,nextOffset:!args.warningId&&offset+limit<ordered.length?offset+limit:null,requiredChecks:VISUAL_CHECKS,coverageLimits:entry.run.visualChecks.filter(c=>c.ok&&c.revision===entry.run.revision).flatMap(c=>(c.views??[]).filter(v=>v.layout?.truncated||v.uncapturedTransitions>0).map(v=>({viewport:v.viewport,truncated:v.layout?.truncated??false,uncapturedTransitions:v.uncapturedTransitions??0}))),next:'Classify visible candidates with actual image IDs and specific pixel/readability/hit-area evidence. Defects require revise+repair/recheck. An out-of-scope defect in an increment is saved as a mandatory global issue, never waived. No findings does not replace manual visual inspection of all states. Split long journeys to capture omitted transitions; bounded scans require explicit manualCoverage.'};
 });
 const userScenario={...object({id:text(40),category:{type:'string',enum:['primary','dismiss','negative','recovery']},target:text(1200),expected:text(1200)}),required:['id','category','target','expected']};
 register('gvs_user_testing','Add/update your OWN UI scenarios by ID as you explore. Partial plans are saved and runnable immediately; other saved scenarios are preserved. Final acceptance still requires primary, dismiss/reopen and adverse coverage plus real actions/assertions on every viewport.',{action:{type:'string',enum:['plan','status']},scenarios:{type:'array',minItems:1,maxItems:16,items:userScenario},notApplicable:{type:'array',maxItems:2,items:{...object({category:{type:'string',enum:['dismiss','adverse']},reason:text(1200),images:{...strings,maxItems:6}}),required:['category','reason','images']}}},['action'],async(args,exec)=>{
  const {entry,name}=await current(exec),task=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
  if(!task||!['review','design-review','user-review'].includes(task.kind))throw new Error('Use your assigned running UI review task; the initial brief is planning, not a completed product test.');
  if(args.action==='plan'){planUserJourneys(entry.run,task,args);await commit(entry);}
  return {...userJourneyStatus(entry.run,task),instructions:USER_TESTING,next:'Execute saved scenarios now using their exact scenarioId; add/update more by ID as you discover states. missingCategories blocks only final pass, not registration/execution. Other saved scenarios and actual proof remain. No scenario is passed just by planning.'};
 });
 const requirement={...object({id:text(40),reason:text(600),criterion:text(1000),method:{type:'string',enum:['runtime','rendered-sequence']}}),required:['id','reason','criterion','method']};
 register('gvs_analysis','Plan conditional task-specific evidence (User only), execute a real analysis runner (assigned verify agent only), or inspect status. Smoothness requires actual rendered pixels AND frame timing with a timestamped frame sequence. Static screenshots and transform-only reports cannot pass.',{action:{type:'string',enum:['plan','check','status']},rationale:text(1200),notRequiredReason:text(1000),requirements:{type:'array',maxItems:6,items:requirement},command:text(5000)},['action'],async(args,exec)=>{
  const {entry,name}=await current(exec);const own=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running');
  if(args.action==='status')return {plan:entry.run.analysis??null,ready:analysisReady(entry.run),reports:(entry.run.analysisChecks??[]).map(({id,ok,revision,capturedBy,planVersion,frameSummary})=>({id,ok,revision,capturedBy,planVersion,frameSummary}))};
  if(args.action==='plan'){
   if(name!=='user'||!own||!['brief','consultation'].includes(own.kind))throw new Error('Only the central User may set analysis criteria during an assigned brief/consultation.');
   const hint=entry.run.analysis?.motionHint??motionHint(entry.run.task);const plan=analysisPlan(args,hint);
   if(entry.run.analysis?.state==='ready'&&JSON.stringify(entry.run.analysis.requirements)===JSON.stringify(plan.requirements)&&entry.run.analysis.notRequiredReason===plan.notRequiredReason){entry.run.analysis.rationale=plan.rationale;await commit(entry);return {plan:entry.run.analysis,unchanged:true};}
   entry.run.analysis={...plan,version:(entry.run.analysis?.version??0)+1,motionHint:hint};entry.run.analysisChecks??=[];await commit(entry);return {plan:entry.run.analysis};
  }
  if(!own||roleOf(entry,name)?.capability!=='verify')throw new Error('Assign an independent verify agent a dependency-ready task before running analysis.');
  if(entry.run.analysis?.state!=='ready'||!entry.run.analysis.requirements.length)throw new Error('The User must define required conditional analyses first; do not invent extra work for a simple task.');
  if(!args.command)throw new Error('Provide the actual project analysis runner command.');
  const revision=entry.run.revision,planVersion=entry.run.analysis.version;
  if(entry.run.analysis.requirements.some(item=>item.method==='rendered-sequence'))await vision(exec);
  const result=await exec.agent.ctx.tools.execute({callId:randomUUID(),agent:exec.agent,signal:exec.signal,name:process.platform==='win32'?'pwsh':'bash',arguments:{description:'Run task-specific real runtime/render analysis',command:args.command,workdir:entry.io.cwd,timeoutMs:120000}});
  const decoded=await decodeAnalysisOutput(result,async(file,maxBytes)=>ctx.fs.readBytes(await ctx.fs.resolve(file,{cwd:entry.io.cwd,signal:exec.signal}),exec.signal,maxBytes));
  const report={...parseAnalysisReport(decoded.raw,entry.run.analysis,entry.run.viewports),id:`analysis-${randomUUID()}`,revision,planVersion,capturedBy:name,taskId:own.id,command:args.command,images:[],frameSummary:[]};
  report.ok=report.ok&&decoded.ok;
  if(decoded.outputSource)report.outputSource=decoded.outputSource;
  let capturedBytes=0;
  for(const analysis of report.results){
   if(entry.run.analysis.requirements.find(item=>item.id===analysis.id).method!=='rendered-sequence')continue;
   for(const viewport of entry.run.viewports){
    const frames=analysis.frames.filter(frame=>frame.viewport===viewport),hashes=new Set(),selected=new Set([0,Math.floor((frames.length-1)/3),Math.floor((frames.length-1)*2/3),frames.length-1]);
    for(const [i,frame] of frames.entries()){
     const resolved=path.resolve(entry.io.cwd,frame.path);if(!resolved.startsWith(entry.io.cwd+path.sep))throw new Error('Captured frames must be inside the project workspace.');
     const data=await entry.io.bytes(frame.path);capturedBytes+=data.length;if(capturedBytes>64*1024*1024)throw new Error('Keep captured frame evidence under 64 MiB per report.');const png=data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71,jpeg=data[0]===255&&data[1]===216;if(!png&&!jpeg)throw new Error('Captured frames must be actual PNG/JPEG images.');
     const hash=createHash('sha256').update(data).digest('hex');hashes.add(hash);frame.sha256=hash;
     if(selected.has(i)&&report.images.length<16){const attachment=await ctx.attachments.saveImage({data,mediaType:png?'image/png':'image/jpeg',name:`gvs-analysis-${analysis.id}-${viewport}-${i}`});report.images.push({viewport,atMs:frame.atMs,stage:'temporal',attachment});}
    }
    if(hashes.size<2)throw new Error('All captured frames are identical; they cannot demonstrate visible motion.');
    report.frameSummary.push({id:analysis.id,viewport,count:frames.length,pixelTimingSamples:analysis.samples.filter(sample=>sample.viewport===viewport).length,durationMs:frames.at(-1).atMs-frames[0].atMs,distinctFrameFiles:hashes.size});
   }
  }
  entry.run.analysisChecks.push(report);
  if(report.images.length)entry.run.visualChecks.push({...report,interactions:1,assertions:report.results.reduce((count,item)=>count+item.cases.length,0),views:entry.run.viewports.map(viewport=>({viewport,errors:[],overflow:false}))});
  await commit(entry);return {...report,results:report.results.map(({frames,samples,...result})=>result)};
 },180000);
 const goalRequirement={...object({id:text(60),criterion:text(1500),sourceIds:strings}),required:['id','criterion','sourceIds']};
 const expertise={...object({id:text(60),purpose:text(1200),capability:{type:'string',enum:['read','edit','verify']}}),required:['id','purpose','capability']};
 function goalPage(run,args={}){
  const status=goalStatus(run),offset=args.offset??0,limit=args.limit??8;
  const requirements=[...status.requirements.filter(item=>!item.accepted),...status.requirements.filter(item=>item.accepted)],issues=[...status.issues.filter(item=>!item.resolved),...status.issues.filter(item=>item.resolved)],messages=run.goal.messages;
  return {...status,requirements:args.id?requirements.filter(item=>item.id===args.id):requirements.slice(offset,offset+limit),issues:args.issueId?issues.filter(item=>item.id===args.issueId):issues.slice(offset,offset+limit),humanMessages:messages.slice(offset,offset+limit),unassessed:status.unassessed.slice(offset,offset+limit),totals:{requirements:requirements.length,issues:issues.length,humanMessages:messages.length,unassessed:status.unassessed.length},nextOffset:offset+limit<Math.max(requirements.length,issues.length,messages.length)?offset+limit:null};
 }
 register('gvs_goal','Track the full REAL human goal. User appends immutable requirements covering actual sourceIds; Lead links each requirement/issue to implementation and independent rechecks. Open requirements, unmapped discovery and unresolved findings prevent finish. Never waive scope through simulated User decisions.',
  {action:{type:'string',enum:['status','plan','link','handoff']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:40},requirements:{type:'array',maxItems:100,items:goalRequirement},assessedMessages:strings,expertise:{type:'array',maxItems:32,items:expertise},staffingRationale:text(1500),discoveryRequired:{type:'boolean'},id:text(60),issueId:text(60),roleNeedId:text(60),requestId:text(60),agentName:text(40),taskId:text(40),workTasks:strings,reviewTasks:strings,links:{type:'array',minItems:1,maxItems:100,items:object({id:text(60),issueId:text(60),workTasks:strings,reviewTasks:strings,roleNeedId:text(60),requestId:text(60),agentName:text(40),taskId:text(40)})},reason:text(2000),evidence:text(4000),dependency:{type:'string',enum:['credentials','permission','unavailable-service','missing-source','human-decision']}},['action'],async(args,exec)=>{
   const {member,entry,name}=await current(exec);
   if(args.action==='status')return goalPage(entry.run,args);
   if(args.action==='plan'){
    const own=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running');
    if(name!=='user'||!own||!['brief','consultation'].includes(own.kind))throw new Error('Only the central User in an assigned brief/consultation may assess the full human contract.');
    planGoal(entry.run,args);
   }else{
    lead(member);
    if(args.action==='link'){
     const draft={...entry.run,goal:structuredClone(entry.run.goal)};
     const linked=(args.links??[args]).map(item=>linkGoal(draft,item));entry.run.goal=draft.goal;entry.run.progress.metadataSinceWrite++;
     await commit(entry);return {linked,goal:view(entry.run).goal};
    }
    if(args.action==='handoff'){
     const status=goalStatus(entry.run);
     if(!args.reason?.trim()||!args.evidence?.trim()||!args.dependency)throw new Error('Name the actual external dependency, attempts/evidence and exactly what is needed. A partial deliverable, test freshness error or missing internal work is not an external dependency.');
     if(status.ready||entry.run.tasks.some(task=>['running','waiting'].includes(task.state)))throw new Error('Complete all actionable running/waiting work before an external handoff.');
     if(!entry.run.tasks.some(task=>task.state==='blocked'))throw new Error('Record the actual externally blocked task before a handoff.');
     entry.run.goal.handoff={dependency:args.dependency,reason:args.reason,evidence:args.evidence,revision:entry.run.revision,messageIds:entry.run.goal.messages.map(item=>item.id)};
    }
   }
   await commit(entry);return {goal:view(entry.run).goal};
  });
 register('gvs_finish','Accept a run only when independent code, User and applicable visual/game gates have real current evidence. Pending/blocked tasks and missing runtime evidence prevent verified.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);entry.run.quality=quality(entry.run);
  const open=entry.run.tasks.filter(task=>['waiting','running','blocked'].includes(task.state)&&!resolvedBlocker(entry.run,task));
  if(open.length||!Object.values(entry.run.quality).every(Boolean)){await commit(entry);return {status:'needs-review',continue:true,quality:entry.run.quality,goal:view(entry.run).goal,sourceError:entry.run.sourceError??null,outstanding:open.slice(0,40).map(task=>({id:task.id,state:task.state,title:task.title})),outstandingCount:open.length,reason:'The goal is not achieved. Continue the SAME run: inspect all findings, link repair/recheck tasks, complete uncovered requirements and discovery. Only a documented external dependency can justify a handoff; partial success is not final.'};}
  entry.run.status='verified';entry.run.summary='Independent code, User and required visual/game evidence accepted.';await commit(entry);return {status:'verified',quality:entry.run.quality};
 });
 async function pause(entry){
  entry.run.status='paused';entry.abort.abort(new Error('GVS paused'));
  for(const task of entry.run.tasks.filter(task=>task.state==='running')){ctx.agentTeams.interrupt(entry.root,task.assignee);await checkpointPlan(entry.io,task);task.state='blocked';task.result={verdict:'blocked',summary:'Paused; inspect partial work before resuming.',findings:[],interrupted:true,revision:entry.run.revision};}
  if(entry.run.preview?.jobId){try{ctx.jobs.kill(entry.run.preview.jobId,entry.root.id,'GVS paused');}catch{}}
  await commit(entry);
 }
 async function suspend(entry){
  if(entry.suspending||entry.run.status!=='running')return;entry.suspending=true;
  entry.run.suspended=true;entry.run.summary='Runtime stopped; the complete goal remains active and will recover after restart.';
  entry.abort.abort(new Error('GVS runtime suspended'));
  for(const task of entry.run.tasks.filter(task=>task.state==='running')){
   await checkpointPlan(entry.io,task);
   task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],interrupted:true,revision:entry.run.revision};
   try{ctx.agentTeams.interrupt(entry.root,task.assignee);}catch{}
  }
  await commit(entry);
 }
 register('gvs_pause','Pause this team’s work and its managed preview, preserving named agents, tasks and memory.',{},[],async(_args,exec)=>{const {member,entry}=await current(exec);lead(member);await pause(entry);return {status:'paused'};});
 async function restoreTasks(entry,signal,automatic=false){
  const recovered=[];
  for(const task of entry.run.tasks.filter(task=>task.state==='blocked'&&(interruptedByLegacyPlan(entry.run,task)||(automatic?/^Interrupted by service restart;|^team message exceeds 131072 bytes$/.test(task.result?.summary??''):task.result?.interrupted===true||/^(?:Interrupted by service restart;|Paused;)/.test(task.result?.summary??''))))){
   signal.throwIfAborted();if(entry.run.status!=='running')break;
   const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});
   if(interruptedByLegacyPlan(entry.run,task)){task.lastFailure=task.result;task.reviewPlanRecovery={version:2,at:new Date().toISOString()};}
   if(task.result?.interrupted&&!task.planContinuation)await checkpointPlan(entry.io,task);
   task.state='waiting';delete task.result;recovered.push(task.id);
  }await commit(entry);await schedule(entry,signal);return recovered;
 }
 register('gvs_recover','Recover service interruptions, or provider-failed tasks after a human model change actually changes their effective route. Never resumes a human pause or replaces agents/tasks.',{reason:{type:'string',enum:['service','model-change']}},[],async(args,exec)=>{
  const {member,entry}=await current(exec);lead(member);
  if(entry.run.status!=='running'||!entry.run.goal?.autonomous||entry.run.goal?.handoff)return {status:entry.run.status,recovered:[],continued:false};
  // Reconcile already saved negative judgements from older versions. Keep the
  // original inspection/result and task state; only add missing owned obligations.
  const recoveredFeedback=[];
  for(const check of entry.run.responsiveChecks??[]){
   if(check.revision!==entry.run.revision||!check.inspection?.visualReview?.assessments?.some(a=>a.disposition==='defect'))continue;
   const task=entry.run.tasks.find(t=>t.id===check.taskId&&t.assignee===check.capturedBy);if(!task)continue;
   const findings=visualAssessmentFindings(entry.run,{...task,receivedImages:[]},check.inspection,entry.run.responsiveChecks);
   if(findings.length)recoveredFeedback.push(...recordFindings(entry.run,{...task,result:{verdict:'revise',findings}}));
  }
  if(recoveredFeedback.length)entry.run.visualFeedbackPending=[...new Set([...(entry.run.visualFeedbackPending??[]),...recoveredFeedback.map(i=>i.id)])];
  if(entry.run.visualFeedbackPending?.length){
   await commit(entry);const pending=entry.run.goal.issues.filter(i=>entry.run.visualFeedbackPending.includes(i.id));
   try{await ctx.agentTeams.sendMessage(entry.root,{target:'lead',content:[{type:'text',text:`GVS RECOVERED VISUAL FEEDBACK ${JSON.stringify({total:pending.length,issues:pending.slice(0,12).map(i=>({issueId:i.id,taskId:i.taskId,finding:clip(i.criterion,2000)}))})}. These saved negative pixel assessments were omitted from findings by the previous version. Read all current issues with paged gvs_goal status; preserve original evidence/results and assign actual repair plus independent recheck tasks. No pass or product edit was performed.`}],signal:exec.signal});delete entry.run.visualFeedbackPending;delete entry.run.visualFeedbackNotificationError;}
   catch(error){entry.run.visualFeedbackNotificationError=clip(error.message,500);}await commit(entry);
  }
  if(entry.abort.signal.aborted)entry.abort=new AbortController();entry.suspending=false;delete entry.run.suspended;
  if(args.reason==='model-change'){
   const policy=ctx.sessionProjections.stateOf(entry.root.session,'gvsModelRouting')?.policy;
   if(!policy)return {status:entry.run.status,recovered:[],continued:true};
   const failedSelections=new Map();
   for(const task of entry.run.tasks.filter(t=>t.state==='blocked'&&!t.failedModel)){
    const failure=providerFailureFor(entry.run,task),role=roleOf(entry,task.assignee);
    if(failure&&role?.sessionId&&ctx.sessionController)failedSelections.set(task.id,await readFailedSelection(ctx.sessionController,entry.root.id,role.sessionId,failure.lastAt,exec.signal));
   }
   const base=entry.root.session.requestHeader?.()?.config??entry.root.options,lastUsed=(_name,task)=>failedSelections.get(task.id),recovered=[];
   for(const task of providerRecoveryCandidates(entry.run,policy,base,lastUsed)){
    const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});
    task.lastFailure=task.result;task.state='waiting';delete task.result;task.modelRecovery={revision:policy.revision,at:new Date().toISOString(),from:task.failedModel??lastUsed(task.assignee,task),to:inheritSelection(base,policy.defaults,policy.overrides[task.assignee])};recovered.push(task.id);
   }
   await commit(entry);await schedule(entry,exec.signal);return {status:entry.run.status,recovered,continued:true};
  }
  const previewRecovery=await recoverPreview(entry,exec.signal),recovered=await restoreTasks(entry,exec.signal,true);return {status:entry.run.status,recovered,previewRecovery,continued:entry.run.status==='running'};
 });
 register('gvs_resume','Resume saved GVS tasks after the user requests continuation; the same named agents keep their conversations.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);entry.abort=new AbortController();entry.run.status='running';entry.suspending=false;delete entry.run.suspended;
  const previewRecovery=await recoverPreview(entry,exec.signal),recovered=await restoreTasks(entry,exec.signal);return {status:entry.run.status,recovered,previewRecovery};
 });
 async function recoverPreview(entry,signal){
  entry.recoveringPreview=true;try{
  const combined=AbortSignal.any([signal,entry.abort.signal]);
  const observed=await restoreManagedPreview(entry.run,{signal:combined,observe:()=>previewState(entry.run.preview,ctx.jobs,entry.root.id,combined,fetch,true),start:async recipe=>{
   const result=await entry.root.ctx.tools.execute({callId:randomUUID(),agent:entry.root,signal:combined,name:'gvs_preview',arguments:{action:'start',...recipe}});if(result.isError)throw new Error('Managed preview startup failed; original tool error is preserved.');const {gvsTeam,...observation}=result.value??{};return observation;
  }});
  if(entry.run.preview){observePreview(entry,observed);for(const task of entry.run.tasks.filter(t=>t.state==='blocked'&&t.result?.interrupted)){
   if(entry.run.preview.ready===true)delete task.waitForPreviewRecovery;
   else if(taskAccess(entry.run,task).resources.some(r=>r==='project-runtime'||r.startsWith('preview:')))task.waitForPreviewRecovery=true;
  }await commit(entry);}return observed;
  }finally{entry.recoveringPreview=false;}
 }
 function observePreview(entry,observed){
  if(!entry.run.preview)return;entry.run.preview.ready=observed.ready===true;
  if(observed.ready){for(const task of entry.run.tasks)delete task.waitForPreviewRecovery;if(entry.run.status==='running'&&entry.run.previewRestore?.jobId===entry.run.preview.jobId&&!entry.run.previewRestore.disabledByStop)entry.run.previewRestore.enabled=true;}
 }
 async function previewObserved(entry,observed,signal){
  if(entry.run.preview){observePreview(entry,observed);await commit(entry);}
  if(observed.ready)await schedule(entry,signal);
  return observed;
 }
 register('gvs_preview','Start, inspect or stop this team’s managed local dev server. Use the existing project command and free port; the coordinator owns it across agent tasks.',{action:{type:'string',enum:['start','status','stop']},command:text(4000),port:{type:'integer',minimum:1024,maximum:65535}},['action'],async(args,exec)=>{
  const {entry}=await current(exec),jobs=ctx.jobs;
  const previewMember=ctx.agentTeams.membership(exec.agent);
  if(args.action!=='status'&&previewMember.role!=='lead'){
   const task=entry.run.tasks.find(task=>task.assignee===previewMember.name&&task.state==='running');
   if(!task||!taskAccess(entry.run,task).resources.includes('project-runtime'))throw new Error('Preview startup/stop needs the exclusive project-runtime lease. Ask Lead; do not restart another parallel task’s environment.');
  }
  if(args.action==='status')return previewObserved(entry,await previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true),exec.signal);
  if(args.action==='stop'){if(entry.run.previewRestore){entry.run.previewRestore.enabled=false;entry.run.previewRestore.disabledByStop=true;}await commit(entry);if(!entry.run.preview?.jobId)return {status:'not-running'};const id=entry.run.preview.jobId;jobs.kill(id,entry.root.id,'Stop GVS preview');const settled=await jobs.wait(id,5000,entry.root.id,exec.signal);entry.run.preview.ready=false;await commit(entry);return {status:settled.status,jobId:id};}
  if(entry.run.status!=='running')return {status:'run-stopped',accepted:false,started:false,next:'The run is paused or finished. This call did not restart its preview or resume work.'};
  const membership=ctx.agentTeams.membership(exec.agent),role=roleOf(entry,membership.name);
  if(membership.role!=='lead'&&!['edit','verify'].includes(role?.capability))throw new Error('Ask the coordinator to start the preview; this role cannot execute startup commands.');
  const port=args.port??4173,url=previewURL(`http://127.0.0.1:${port}/`).href;
  let old;try{old=jobs.get(entry.run.preview?.jobId,entry.root.id);}catch{}
  if(old&&['running','stopping'].includes(old.status))return previewObserved(entry,await previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true),exec.signal);
  if(!args.command)throw new Error('Provide the project preview command.');
  let occupied=false;try{const res=await fetch(url,{signal:AbortSignal.timeout(700)});await res.body?.cancel();occupied=true;}catch{}if(occupied)throw new Error('This port already responds; inspect it explicitly or use a free port.');
  const result=await entry.root.ctx.tools.execute({callId:randomUUID(),agent:entry.root,signal:exec.signal,name:process.platform==='win32'?'pwsh':'bash',arguments:{description:'Start GVS project preview',command:args.command,workdir:entry.io.cwd,run_in_background:true}});
  if(result.isError||!result.value?.jobId)throw new Error('Preview could not start as a managed job.');entry.run.preview={url,jobId:result.value.jobId};entry.run.previewRestore={runId:entry.run.runId,url,port,command:args.command,jobId:result.value.jobId,enabled:false,disabledByStop:false};await commit(entry);
  for(let i=0;i<40;i++){
   exec.signal.throwIfAborted();const observed=await previewState(entry.run.preview,jobs,entry.root.id,exec.signal);
   if(observed.ready)return previewObserved(entry,observed,exec.signal);
   if(observed.status==='failed')return previewObserved(entry,await previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true),exec.signal);
   await new Promise(resolve=>setTimeout(resolve,400));
  }
  return previewObserved(entry,await previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true),exec.signal);
 },60000);
 async function vision(exec){const route=exec.agent.session.requestHeader()?.config??exec.agent.options;const info=await ctx.llm.resolveModelInfo(route.provider,route.model,exec.signal);if(!info.inputModalities?.includes('image'))throw new Error('Choose an image-capable model for visual acceptance.');}
 const action={...object({kind:text(30),role:text(50),name:text(180),label:text(180),testId:text(100),state:text(30),value:{type:['string','number','boolean']},key:text(60),frames:{type:'integer',minimum:1,maximum:600},scenario:text(100),x:{type:'number'},y:{type:'number'},click:{type:'boolean'},path:text(200),op:{type:'string',enum:['eq','gt','gte','lt','lte','near']},tolerance:{type:'number',minimum:0},category:{type:'string',enum:['collision','gameplay','controls','camera']}}),required:['kind']};
 async function browserCheck(args,exec,game){
  const {entry,name}=await current(exec);await vision(exec);
  const own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running'),scenario=args.scenarioId?own?.userJourneys?.scenarios.find(s=>s.id===args.scenarioId):null;
  if(args.scenarioId&&!scenario)throw new Error('Register this exact observed scenarioId with gvs_user_testing action:plan before running it.');
  const signal=AbortSignal.any([exec.signal,entry.abort.signal]);
  const revision=entry.run.revision;
  const report=await (game?captureGame:captureBrowser)(args,{config,signal,saveImage:image=>ctx.attachments.saveImage(image),viewports:entry.run.viewports});
  await refreshRevision(entry,ctx.fs,exec.signal);
  if(report.ok&&(game||report.views.some(v=>v.controls>0))&&entry.run.qaTarget){entry.run.qaTarget.surfaces=[...new Set([...entry.run.qaTarget.surfaces.filter(s=>s!=='code-or-unknown'),'web'])];entry.run.qaTarget.evidence.push({surface:'web',engine:game?'web-game':'browser',path:report.url,observed:true});}
  if(!game&&revision===entry.run.revision)for(const view of report.views)mergeResponsiveHints(entry.run,view.responsiveHints);
  const record={...report,id:`browser-${randomUUID()}`,at:Date.now(),revision,capturedBy:name,taskId:own?.id??null,...(scenario?{scenarioId:scenario.id,scenarioKey:scenarioKey(scenario)}:{})};entry.run.visualChecks.push(record);if(game)entry.run.gameChecks.push(record);await commit(entry);
  return {...report,id:record.id,revision,scenarioId:record.scenarioId,sourceChanged:revision!==entry.run.revision,...(own?{visualStateCount:visualStates(entry.run,own).length,next:'Inspect existing required frames via gvs_visual action:states; copy literal imageIds. Do not recapture journeys to fix completion citations.'}:{})};
 }
 const browserAction={...action,properties:{...action.properties,kind:{type:'string',enum:BROWSER_ACTIONS},state:{type:'string',enum:BROWSER_STATES},key:{...text(60),description:'Keyboard key for press, e.g. Escape. value remains an alias; do not supply conflicting keys.'}}},browserActions={type:'array',items:browserAction,maxItems:12};
 register('gvs_browser_check','Test actual UI on automatic desktop/phone viewports. press uses key (value alias); assertState accepts boolean true/false. actionsByViewport overrides shared actions for differing responsive controls; both views still need real actions/assertions. Observe current controls first.',{url:text(2000),scenario:text(500),scenarioId:text(40),actions:browserActions,actionsByViewport:object({desktop:browserActions,mobile:browserActions})},['url'],(args,exec)=>browserCheck(args,exec,false));
 const responsiveReview={...object({manualCoverage:text(2000),checked:{type:'array',items:{type:'string',enum:VISUAL_CHECKS},maxItems:7},assessments:{type:'array',maxItems:200,items:{...object({warningId:text(60),imageId:text(150),disposition:{type:'string',enum:['intentional','defect','outside-scope']},reason:text(1000)}),required:['warningId','imageId','disposition','reason']}}}),required:['checked','assessments']};
 register('gvs_responsive','Systematic UI simulation: status pages device/settings and discovered CSS-boundary cases; check executes up to TWO cases with real actions and images; states retrieves stored pixels; review saves your explicit per-batch visual judgement and forwards defects. Complete the matrix independently as QA/User before pass. Missing engines are reported, never treated as tested physical devices.',
 {action:{type:'string',enum:['status','check','states','review']},taskId:text(40),caseIds:{type:'array',items:text(100),minItems:1,maxItems:2},checkId:text(100),scenarioId:text(40),scenario:text(1000),url:text(2000),actions:browserActions,actionsByViewport:object({desktop:browserActions,mobile:browserActions}),actionsByCase:{type:'object',additionalProperties:browserActions,maxProperties:2},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:6},verdict:{type:'string',enum:['pass','revise']},findings:strings,observations:{...strings,items:text(1600),description:'Neutral/positive facts and corrected invocation notes, not required fixes or missing coverage.'},images:{...strings,maxItems:20},visualReview:responsiveReview},['action'],async(args,exec)=>{
  const {entry,name,member}=await current(exec),task=entry.run.tasks.find(t=>t.id===args.taskId)??entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
  if(args.action!=='states'&&!requiresWebVerification(entry.run))return {status:'not-web-target',accepted:false,required:false,target:entry.run.qaTarget??null,next:'This browser matrix does not apply to the actual native/CLI/service target. Inspect gvs_project, use real engine/process/native-window evidence, and assign a needed driver task; do not start a localhost substitute.'};
  if(!task||!['review','user-review','design-review'].includes(task.kind))throw new Error('Use the exact existing UI review taskId. Briefs/consultations and editing tasks are not responsive acceptance.');
  const offset=args.offset??0,limit=args.limit??3;
  entry.run.responsiveEngines=await browserCapabilities(config);
  const compact=()=>{const s=responsiveStatus(entry.run,task);return {...s,missing:s.missing.slice(0,6),missingTotal:s.missing.length};};
  if(args.action==='status'){
   const matrix=responsiveMatrix(entry.run),missingIds=new Set(responsiveStatus(entry.run,task).missing.map(m=>m.caseId)),ordered=[...matrix.cases.filter(c=>missingIds.has(c.id)),...matrix.cases.filter(c=>!missingIds.has(c.id))];await commit(entry);
   return {taskId:task.id,revision:entry.run.revision,cases:args.caseIds?ordered.filter(c=>args.caseIds.includes(c.id)):ordered.slice(offset,offset+limit),caseCount:matrix.cases.length,nextOffset:!args.caseIds&&offset+limit<ordered.length?offset+limit:null,scenarios:responsiveScenarios(task),coverage:compact(),instructions:RESPONSIVE_TESTING};
  }
  if(args.action==='states'){
   const record=entry.run.responsiveChecks?.find(c=>c.id===args.checkId&&c.taskId===task.id);if(!record)throw new Error('Use an actual existing taskId/checkId from responsive feedback or check results.');
   return {checkId:record.id,taskId:record.taskId,caseId:record.caseId,capturedBy:record.capturedBy,readOnly:true,revision:record.revision,current:record.revision===entry.run.revision,ok:record.ok,views:record.views,images:record.images.slice(offset,offset+limit),nextOffset:offset+limit<record.images.length?offset+limit:null,next:'These are shared diagnostic pixels, not your independent proof or visual approval. Only the assigned capture owner may record review. Lead can use these actual images to plan an owned repair; QA and User still execute their own cases.'};
  }
  const own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');
  if(member.role==='lead'||!own||own.id!==task.id)throw new Error('The assigned QA/design/User must perform and inspect its OWN matrix. Lead may read status but cannot attest on behalf of another role.');
  if(args.action==='check'){
   if(!args.caseIds?.length)throw new Error('Copy up to two literal caseIds from status; preserve remaining cases for following batches.');
   const matrix=responsiveMatrix(entry.run),cases=args.caseIds.map(id=>matrix.cases.find(c=>c.id===id));if(cases.some(c=>!c)||new Set(args.caseIds).size!==cases.length)throw new Error('Use unique actual caseIds from the current responsive status.');
   if(Object.keys(args.actionsByCase??{}).some(id=>!args.caseIds.includes(id)))throw new Error('actionsByCase keys must be exactly selected caseIds, not guessed device labels.');
   const scenario=responsiveScenarios(task).find(s=>s.id===(args.scenarioId??'current-surface'));if(!scenario)throw new Error('Use a saved scenarioId from responsive status / gvs_user_testing; first register the real observed User journey.');
   await vision(exec);const records=[],images=[];
   for(const item of cases){
    const revision=entry.run.revision,report=await captureBrowser({...args,url:args.url??entry.run.preview?.url,scenario:args.scenario??scenario.expected},{config:{...config,browserEngine:item.engine},signal:AbortSignal.any([exec.signal,entry.abort.signal]),saveImage:image=>ctx.attachments.saveImage(image),viewports:[item]});
    await refreshRevision(entry,ctx.fs,exec.signal);
    if(revision===entry.run.revision)for(const view of report.views)mergeResponsiveHints(entry.run,view.responsiveHints);
    const record={...report,id:`responsive-${randomUUID()}`,caseId:item.id,caseKey:item.key,scenarioId:scenario.id,scenarioKey:scenarioKey(scenario),taskId:task.id,capturedBy:name,revision,at:Date.now()};
    entry.run.responsiveChecks??=[];entry.run.responsiveChecks.push(record);records.push(record);images.push(...record.images);await commit(entry);
   }
   return {ok:records.every(c=>c.ok),taskId:task.id,views:records.flatMap(c=>c.views.map(v=>({viewport:v.viewport,caseId:v.caseId,errors:v.errors}))),checks:records.map(({images,...r})=>r),images,coverage:compact(),next:'Inspect every returned frame and warning, then review each literal checkId. Report defects immediately; a capture is not visual approval.'};
  }
  const record=entry.run.responsiveChecks?.find(c=>c.id===args.checkId&&c.taskId===task.id);
  if(!record||record.capturedBy!==name)throw new Error('Copy your exact existing checkId from check results; another role cannot supply your inspection.');
  const inspection=inspectResponsiveCheck(entry.run,task,record,args);
  const findings=[...inspection.findings,...(inspection.visualReview?.assessments??[]).filter(a=>a.disposition==='outside-scope').map(a=>`Responsive ${record.caseId}: ${a.reason} Evidence ${a.imageId}`)];
  const issues=findings.length?recordFindings(entry.run,{...task,result:{verdict:'revise',summary:`Responsive defect in ${record.caseId}`,findings}}):[];await commit(entry);
  if(findings.length)await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS RESPONSIVE FEEDBACK ${JSON.stringify({taskId:task.id,caseId:record.caseId,checkId:record.id,findings,observations:inspection.observations.slice(0,3),issueIds:issues.map(i=>i.id)})}. Assign owned repair and independent rechecks; preserve the complete goal.`}],signal:exec.signal});
  return {checkId:record.id,inspection,issueIds:issues.map(i=>i.id),coverage:compact()};
 },180000);
 register('gvs_game_check','Exercise an actual Canvas/WebGL game using its test-build __gvsGame v1 bridge. reset/step/hold/press/pointer drive real simulation; assert compares state paths. Returns actual frames, images and category coverage. It never treats a screenshot as collision proof.',{url:text(2000),scenario:text(500),actions:{type:'array',items:action,minItems:1,maxItems:32}},['url','actions'],(args,exec)=>browserCheck(args,exec,true));
 register('gvs_native_game_check','Run the actual native engine test command in foreground and read its GVS_GAME_RESULT JSON report. Accepts engine-generated screenshot files under the workspace. Independent code review must verify the adapter uses real game/physics logic.',{command:text(5000)},['command'],async(args,exec)=>{
  const {entry,name}=await current(exec);const result=await exec.agent.ctx.tools.execute({callId:randomUUID(),agent:exec.agent,signal:exec.signal,name:process.platform==='win32'?'pwsh':'bash',arguments:{description:'Run actual engine gameplay tests',command:args.command,workdir:entry.io.cwd,timeoutMs:120000}});
  if(result.isError||result.value?.kind!=='foreground'||result.value.exitCode!==0)throw new Error('The actual engine test command did not pass.');
  const stdout=result.value.stdout?.text??result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
  const marker='GVS_GAME_RESULT:',offset=stdout.lastIndexOf(marker);if(offset<0)throw new Error('Runner did not print GVS_GAME_RESULT: followed by its gvs.game/1 JSON.');
  let raw;try{raw=JSON.parse(stdout.slice(offset+marker.length).trim());}catch{throw new Error('Runner report must be the final JSON in stdout.');}
  const report={...parseGameReport(raw),mode:'native-engine',command:args.command,revision:entry.run.revision,capturedBy:name,images:[],interactions:1,assertions:raw.cases.length,views:[]};
  if((raw.screenshots??[]).length)await vision(exec);
  for(const image of (raw.screenshots??[]).slice(0,4)){
   const resolved=path.resolve(entry.io.cwd,image.path);if(!resolved.startsWith(entry.io.cwd+path.sep))throw new Error('Engine screenshots must be inside the selected workspace.');
   const bytes=await entry.io.bytes(image.path),mediaType=/\.png$/i.test(image.path)?'image/png':'image/jpeg';
   const attachment=await ctx.attachments.saveImage({data:bytes,mediaType,name:path.basename(image.path)});const viewport=image.viewport==='mobile'?'mobile':'desktop';report.images.push({viewport,stage:'engine',attachment});report.views.push({viewport,errors:[],overflow:false});
  }
  entry.run.gameChecks.push(report);if(report.images.length)entry.run.visualChecks.push(report);await commit(entry);return report;
 },180000);
 ctx.on('session/event',(session,event)=>{
  const own=entries.get(session.id);
  if(own?.run.status==='running'&&event.type==='turn/end'&&event.data.reason.kind==='error'){
   recordToolFailure(own.run,{agent:'lead',taskId:null,tool:'agent-turn',identity:'lead-turn',message:event.data.reason.error?.message??'Coordinator turn failed'});void commit(own).catch(()=>{});
  }
  if(own?.run.status==='running'&&event.type==='turn/end'&&['aborted','blocked','forked'].includes(event.data.reason.kind)){
   if(own.suspending||event.data.reason.kind==='aborted'&&event.data.reason.reason?.kind==='disposed')suspend(own).catch(()=>{});
   else pause(own).catch(()=>{});
   return;
  }
  for(const entry of entries.values()){
   if(entry.run.status!=='running')continue;
   const role=entry.run.roles.find(role=>role.sessionId===session.id);if(!role)continue;
   if(event.type==='turn/start')role.executionTurn=event.data.turn;
   const task=entry.run.tasks.find(task=>task.assignee===role.name&&task.state==='running');if(!task)continue;
   if(event.type==='user/message'&&Number.isInteger(role.executionTurn)&&event.data.content.some(part=>part.type==='text'&&part.text.includes(task.nonce)))task.executionTurn=role.executionTurn;
   if(event.type==='turn/end'&&task.executionTurn===event.data.turn){task.failedModel=ctx.sessionProjections?.stateOf(session,'modelSelection')?.lastUsed??session.requestHeader?.()?.config??task.failedModel;task.state='blocked';task.result={verdict:'blocked',summary:`Agent turn ended (${event.data.reason.kind}) without completing its assigned task. Inspect its chat and retry this task.`,findings:[],revision:entry.run.revision};
    const {item,notify}=recordToolFailure(entry.run,{agent:role.name,taskId:task.id,tool:'agent-turn',identity:'teammate-turn',message:event.data.reason.error?.message??task.result.summary});
    if(notify)try{entry.root.steer?.({id:randomUUID(),role:'user',source:{kind:'gvs-tool-diagnostics',form:'notice',summary:'A teammate stopped before delivering its task'},content:[{type:'text',text:`GVS AGENT ERROR ${JSON.stringify(item)}. Inspect this agent and preserve the same task. Repair a concrete configuration/protocol issue or retry a transient failure; do not wait for the human to forward errors and do not claim delivery.`}]});}catch{}
    commit(entry).catch(()=>{});}
  }
 });
 ctx.effect(()=>async()=>{for(const id of owned){const entry=entries.get(id);if(entry?.owner===ctx&&entry.run.status==='running')await suspend(entry).catch(()=>{});}});
}
