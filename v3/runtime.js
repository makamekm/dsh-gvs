import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {clip,roleSpec,readyTasks,assertDag,view,quality,kinds,taskKinds,parseGameReport,imageAcceptance} from './domain.js';
import {captureBrowser,captureGame,previewURL} from './browser.js';
import {COMMON,USER,GAME} from './prompts.js';
import {motionHint,analysisPlan,parseAnalysisReport,analysisReady,analysisAcceptance} from './analysis.js';
import {syncGoal,planGoal,linkGoal,recordFindings,goalStatus,resolvedBlocker} from './goal.js';
import {refreshRevision} from './revision.js';
import {decisionKey,reusableDecision,consultationKey,progressStatus,modelResult} from './flow.js';
import {previewState} from './preview.js';
import {VISUAL_CHECKS,validateVisualReview,visualAuditStatus} from './visual.js';

export const inject=['tools','agentTeams','subagents','fs','workingDirectory','sandboxPolicy','attachments','llm','jobs','sessionProjections'];
const entries=new Map(),instance=randomUUID();
const object=properties=>({type:'object',additionalProperties:false,properties});
const text=(maxLength=4000)=>({type:'string',maxLength});
const strings={type:'array',items:{type:'string'},maxItems:40};
const imageParts=images=>images.map(image=>({type:'image',attachment:image.attachment}));
const roleOf=(entry,name)=>entry.run.roles.find(role=>role.name===name);
const liveImages=run=>{
 const current=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision),scene=current.filter(c=>c.views?.some(v=>v.layout)).at(-1);
 const ui=scene?.images??run.viewports.map(viewport=>current.flatMap(c=>c.images).filter(i=>i.viewport===viewport).at(-1)).filter(Boolean);
 const temporal=(run.analysisChecks??[]).filter(c=>c.ok&&c.revision===run.revision&&c.planVersion===run.analysis?.version).slice(-1).flatMap(c=>c.images);
 return [...ui,...run.viewports.flatMap(viewport=>temporal.filter(i=>i.viewport===viewport).slice(-2))].filter((image,i,all)=>all.findIndex(item=>item.attachment.attachmentId===image.attachment.attachmentId)===i).slice(0,20);
};
const taskSummaries=(tasks,detail=false)=>tasks.map(({id,title,assignee,kind,dependsOn,state,result,instructions,startedAt,priority,scope,analysisIds})=>({id,title,assignee,kind,dependsOn,state,startedAt,priority,scope,analysisIds,...(detail?{instructions}:{}),...(result?{result:detail?result:{...result,summary:clip(result.summary,800),findings:result.findings.map(item=>clip(item,600)),inventory:result.inventory?.slice(0,10).map(item=>({...item,evidence:clip(item.evidence,400)}))}}:{})}));

function reviewPlan(run,input){
 const scope=input.scope??'full';
 if(scope==='increment'&&(!Array.isArray(input.analysisIds)||input.analysisIds.some(id=>!run.analysis?.requirements.some(item=>item.id===id))))throw new Error('An increment needs explicit analysisIds from the current User plan ([] only for a static slice). It cannot satisfy full-goal review gates.');
 return {scope,analysisIds:scope==='increment'?input.analysisIds:null};
}

export function apply(ctx,config={}){
 const owned=new Set();
 const maxParallel=config.maxParallel??2,maxTasks=!config.goalProtocol&&[64,160].includes(config.maxTasks)?10000:config.maxTasks??10000;
 ctx.effect(()=>ctx.jobs.attachController('gvs-team-preview'));
 async function storage(root,signal){
  const cwd=await ctx.workingDirectory.ensure(root,signal),policy=ctx.sandboxPolicy.resolve({session:root.session});
  const target=relative=>ctx.fs.resolve(path.resolve(cwd,relative),{cwd,signal});
  return {cwd,read:async file=>ctx.fs.readText(await target(file),signal),bytes:async file=>ctx.fs.readBytes(await target(file),signal,10*1024*1024),
   write:async(file,value)=>ctx.fs.writeText(await target(file),value,undefined,signal,policy),policy};
 }
 const stateFile=root=>path.join('.gvs',`team-${root.id}.json`);
 async function load(root,signal){
  if(entries.has(root.id)){const entry=entries.get(root.id);entry.root=root;return entry;}
  const io=await storage(root,signal);
  try{
   const run=JSON.parse(await io.read(stateFile(root)));
   if(run.schema!==3||run.sessionId!==root.id)throw new Error('Invalid GVS state for this session');
   if(run.status==='running'){
    run.summary='Service restarted. Inspect interrupted tasks, preserve completed work and continue the same human goal.';
    for(const role of run.roles)role.waitingForUser=false;
    for(const task of run.tasks.filter(task=>task.state==='running')){task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],interrupted:true,revision:run.revision};}
   }
   const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);return entry;
  }catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return null;throw error;}
 }
 async function current(exec,required=true){
  if(!exec.agent)throw new Error('A GVS session is required');
  const member=ctx.agentTeams.membership(exec.agent),entry=await load(member.root,exec.signal);
  if(required&&!entry)throw new Error('The coordinator must call gvs_run first.');
  if(entry){
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
  }
  return {member,entry,root:member.root,name:member.name};
 }
 function lead(member){if(member.role!=='lead')throw new Error('Only the coordinator can change team composition or the task plan.');}
 async function commit(entry){
  const saved=JSON.stringify({...entry.run,updatedAt:new Date().toISOString()},null,2);
  entry.write=entry.write.catch(()=>{}).then(async()=>{
   const io=await storage(entry.root,AbortSignal.timeout(15000));
   await io.write(stateFile(entry.root),saved);await io.write(path.join('.gvs',entry.run.runId,'state.json'),saved);await io.write(path.join('.gvs','latest.json'),saved);
  });await entry.write;
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
 async function createTask(entry,input,signal){
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
  const native=await ctx.agentTeams.createTask(entry.root,{subject:clip(input.title,180),description:clip(input.instructions,15000),blockedBy:dependsOn,writeScopes:input.writeScopes??[]});
  const inherited=entry.run.tasks.filter(task=>task.assignee===input.assignee).flatMap(task=>task.consultations??[]).filter(id=>reusableDecision(entry.run,id));
  const task={id:native.id,title:clip(input.title,180),instructions:clip(input.instructions,15000),assignee:input.assignee,kind:input.kind,dependsOn,state:'waiting',receivedImages:[],consultations:[...new Set(inherited)],priority:input.priority??0,...scope};
  entry.run.progress.metadataSinceWrite++;
  entry.run.tasks.push(task);await commit(entry);await schedule(entry,signal);return task;
 }
 async function schedule(entry,signal){
  if(entry.scheduling)return entry.scheduling;
  entry.scheduling=(async()=>{
   if(entry.run.status!=='running')return;
   for(const task of readyTasks(entry.run).sort((a,b)=>(b.priority??0)-(a.priority??0))){
    if(entry.abort.signal.aborted||signal.aborted)break;
    const role=roleOf(entry,task.assignee),running=entry.run.tasks.filter(task=>task.state==='running');
    if(role.capability==='edit'&&!goalStatus(entry.run).discoveryReady)continue;
    if(role.capability!=='user'&&entry.run.analysis&&(entry.run.analysis.state!=='ready'||entry.run.tasks.some(task=>task.kind==='brief'&&task.state!=='done')))continue;
    if(role.retired||running.some(task=>task.assignee===role.name))continue;
    if(role.capability!=='user'&&running.filter(task=>task.assignee!=='user').length>=maxParallel)continue;
    if(role.capability==='edit'&&running.some(task=>['edit','verify'].includes(roleOf(entry,task.assignee)?.capability)))continue;
    if(role.capability==='verify'&&running.some(task=>['edit','verify'].includes(roleOf(entry,task.assignee)?.capability)))continue;
    const native=ctx.agentTeams.getTask(entry.root,task.id);
    await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'reassign',owner:role.name});
    task.state='running';task.startedAt=Date.now();task.startedRevision=entry.run.revision;task.nonce=randomUUID();delete task.executionTurn;
    const images=liveImages(entry.run);task.receivedImages=images.map(image=>image.attachment.attachmentId);
    task.receivedAnalysisReports=(entry.run.analysisChecks??[]).filter(check=>check.ok&&check.revision===entry.run.revision&&check.planVersion===entry.run.analysis?.version).map(check=>check.id);
    const deps=entry.run.tasks.filter(previous=>task.dependsOn.includes(previous.id)).map(({id,title,result})=>({id,title,result:result?{verdict:result.verdict,summary:clip(result.summary,1200),findings:result.findings?.map(item=>clip(item,400)),inventoryItems:result.inventory?.length??0}:null}));
    const observations=entry.run.visualChecks.filter(check=>check.revision===entry.run.revision).slice(-2).map(({ok,scenario,views})=>({ok,scenario,views}));
    const prompt=`${COMMON}\n${role.capability==='user'?USER:role.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\n\nCURRENT HUMAN TASK: ${entry.run.task}\nROLE: ${role.title}\nASSIGNED TASK ID: ${task.id}\nTASK NONCE: ${task.nonce}\nKIND: ${task.kind}\nWORK: ${task.instructions}\nCONDITIONAL ANALYSIS PLAN: ${JSON.stringify(entry.run.analysis??null)}\nANALYSIS REPORTS: ${JSON.stringify((entry.run.analysisChecks??[]).filter(check=>task.receivedAnalysisReports.includes(check.id)).map(({id,engine,analyzer,results,frameSummary})=>({id,engine,analyzer,results:results.map(({frames,samples,...result})=>result),frameSummary})))}\nDEPENDENCY RESULTS: ${JSON.stringify(deps)}\nSHARED USER DECISIONS: ${JSON.stringify(entry.run.tasks.filter(task=>task.assignee==='user'&&task.result).slice(-4).map(task=>task.result))}\nRECORDED BROWSER EVIDENCE: ${JSON.stringify(observations)}\nPREVIEW: ${JSON.stringify(entry.run.preview)}\nACTUAL ATTACHED IMAGES: ${JSON.stringify(images.map(image=>({viewport:image.viewport,id:image.attachment.attachmentId,atMs:image.atMs})))}\nFinish with gvs_task complete for this exact task. Include actual image IDs, analysisReports IDs and exact commands when reviewing. Other members wake automatically; do not poll them.`;
    const messages=entry.run.goal?.messages??[],selected=messages.filter((_,i)=>i<2||i>=messages.length-8);
    const contract=`REAL HUMAN CONTRACT (unaltered excerpts; ${messages.length} messages stored, paginate gvs_goal status for all): ${JSON.stringify(selected)}\nGOAL COVERAGE: ${JSON.stringify(view(entry.run).goal)}\nUser brief MUST first call gvs_goal status then gvs_goal plan with sourceIds/assessedMessages and expertise/staffingRationale. Infer needed roles; the human need not name them. Discovery inventories must map to requirements. Reviews MUST attest coveredRequirements IDs and scopeReviewed=true after independent completeness analysis; repairs attest addressedIssues IDs. Every required mismatch belongs in findings, never only in summary. Simulated User decisions cannot waive the human goal.`;
    const flow=`DELIVER AN INCREMENT, NOT A PLANNING LOOP. Review scope: ${task.scope??'full'}, analysisIds: ${JSON.stringify(task.analysisIds??'ALL')}. An increment pass attests only this slice/selected criteria and NEVER full-goal acceptance. [] allows only a static slice, not a motion acceptance claim. Established User decisions for this role: ${JSON.stringify(task.consultations)}. Reuse a current decision with gvs_ask_user reuseTaskId; consult only for an actual consequential unknown, never to approve the same scope again. Read a dependency's exact assignment/result with gvs_task list taskId when needed; summaries above are not a claim that you read the whole evidence. For implementation, produce a coherent runnable slice with a real build/render check, normally within 20 minutes. If this assignment is too broad, message Lead with the completed slice and remaining work so it can be split without dropping requirements. Do not expand an in-progress mobile fix into every backend/product feature or postpone all product work until universal readiness. Independent final acceptance remains mandatory.`;
    try{await ctx.agentTeams.sendMessage(entry.root,{target:role.name,content:[{type:'text',text:flow+'\n'+contract+'\n'+prompt},...imageParts(images)],signal});}
    catch(error){task.state='blocked';task.result={verdict:'blocked',summary:clip(error.message),findings:[clip(error.message)],revision:entry.run.revision};}
    await commit(entry);
   }
  })();try{await entry.scheduling;}finally{entry.scheduling=null;}
 }
 function register(name,description,properties,required,execute,timeoutMs=120000){
  ctx.tools.register({name,description,parameters:{...object(properties),required},timeoutMs,
   output:{schema:{},presentationMeta:(_args,value)=>({gvsTeam:value.gvsTeam??null}),render:(_args,value)=>[{type:'text',text:JSON.stringify(modelResult(value))},...imageParts(value.images??[])]},
   async execute(args,exec){const value=await execute(args,exec);const info=await current(exec,false);return JSON.parse(JSON.stringify({...value,...(info.entry?{gvsTeam:view(info.entry.run)}:{})}));}});
 }
 ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!exec.agent)return next();const membership=ctx.agentTeams.tryMembership(exec.agent);if(!membership||membership.role==='lead')return next();
  const entry=await load(membership.root,exec.signal),role=entry&&roleOf(entry,membership.name);
  const alwaysRead=['read','read_image','glob','grep','working_directory','gvs_status'];
  if(!role)return alwaysRead.includes(exec.name)?next():{kind:'deny',reason:'This teammate has no GVS role assignment.'};
  if(['gvs_run','gvs_finish','gvs_resume','gvs_recover','gvs_pause'].includes(exec.name))return {kind:'deny',reason:'This is a coordinator-only operation.'};
  if(role.capability==='user'&&exec.name==='gvs_ask_user')return {kind:'deny',reason:'The User advocate cannot consult itself.'};
  if(['write','edit'].includes(exec.name)&&role.capability!=='edit')return {kind:'deny',reason:'This role may not edit project files.'};
  if(['pwsh','bash','gvs_native_game_check'].includes(exec.name)&&!['edit','verify'].includes(role.capability))return {kind:'deny',reason:'This role has no command execution capability.'};
  if(entry.run.status!=='running'&&!alwaysRead.includes(exec.name))return {kind:'deny',reason:'The run is paused or finished. Ask the coordinator to resume or assign new work.'};
  return next();
 });
 ctx.tools.guard(exec=>{
  if(!exec.agent)return;
  const member=ctx.agentTeams.tryMembership(exec.agent);if(!member||member.role==='lead')return;
  const entry=entries.get(member.root.id),role=entry&&roleOf(entry,member.name);
  const basic=['read','read_image','glob','grep','working_directory','gvs_status'];
  if(!role)return basic.includes(exec.name)?undefined:'No GVS role is assigned to this teammate.';
  if(['gvs_run','gvs_finish','gvs_resume','gvs_recover','gvs_pause'].includes(exec.name))return 'Only the coordinator may control the run.';
  if(role.capability==='user'&&exec.name==='gvs_ask_user')return 'The User advocate cannot consult itself.';
  if(['write','edit'].includes(exec.name)&&role.capability!=='edit')return 'This role may not edit project files.';
  if(['pwsh','bash','gvs_native_game_check'].includes(exec.name)&&!['edit','verify'].includes(role.capability))return 'This role has no command execution capability.';
  if(!entry.run.tasks.some(task=>task.assignee===member.name&&task.state==='running')&&['write','edit','pwsh','bash','gvs_native_game_check','gvs_browser_check','gvs_game_check'].includes(exec.name))return 'No dependency-ready task is assigned. Wait for the scheduler; do not start this work early.';
  if(entry.run.status!=='running'&&!basic.includes(exec.name))return 'The run is paused or finished.';
 });
 ctx.on('tools/result',(exec,result)=>{
  if(!exec.agent)return;const member=ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);if(!entry||entry.run.status!=='running')return;
  const role=roleOf(entry,member.name),task=entry.run.tasks.find(task=>task.assignee===member.name&&task.state==='running');
  if(['write','edit'].includes(exec.name)&&!result.isError){
   const file=exec.arguments?.file_path??exec.arguments?.path??'';
   if(file&&!/[\\/](?:\.gvs|artifacts|test-results|node_modules)[\\/]/.test(file)){
    entry.run.progress??={startedAt:Date.now()};Object.assign(entry.run.progress,{lastWriteAt:Date.now(),lastWriteFile:file,writes:(entry.run.progress.writes??0)+1,metadataSinceWrite:0});
   }
  }
  if(!['pwsh','bash'].includes(exec.name))return;
  const value=result.value;
  entry.run.checks.push({taskId:task?.id??null,agent:member.name,command:clip(exec.arguments?.command,5000),exitCode:value?.exitCode??null,
   finished:value?.kind==='foreground'&&value?.signal==null&&!value?.timedOut&&!value?.aborted,error:result.isError,
   output:clip(value?.stdout?.text??result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n'),12000)});
  entry.run.checks=entry.run.checks.slice(-120);
 });
 register('gvs_run','Start an adaptive GVS team run. Returns immediately; then create only needed specialists and dependency tasks, coordinate results, and call gvs_finish. Named teammates persist and wake for later tasks.',{task:text(16000),kind:{type:'string',enum:kinds},engine:text(100),viewports:{type:'array',items:{type:'string',enum:['desktop','mobile']},minItems:1,maxItems:2}},['task','kind'],async(args,exec)=>{
  const {member,root,entry:previous}=await current(exec,false);lead(member);
  if(previous?.run.status==='running')throw new Error('A run is active; coordinate it or pause it first.');
  const io=await storage(root,exec.signal);if(io.policy.mode==='read-only')throw new Error('GVS work requires Workspace Write.');
  const visualRequired=args.kind!=='code';
  const run={schema:3,sessionId:root.id,runId:`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,task:args.task,kind:args.kind,engine:args.engine??'',status:'running',revision:0,
   visualRequired,visualPolicy:visualRequired?1:0,viewports:args.viewports??(args.kind==='ui'?['desktop','mobile']:['desktop']),roles:previous?.run.roles??[],tasks:[],checks:[],visualChecks:[],gameChecks:[],analysis:{state:'pending',version:0,requirements:[],rationale:'',motionHint:motionHint(args.task)},analysisChecks:[],preview:null,quality:null,summary:'',progress:{startedAt:Date.now(),metadataSinceWrite:0,writes:0}};
  const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);
  entry.owner=ctx;owned.add(root.id);
  const human=ctx.sessionProjections?.stateOf(root.session,'gvsHumanGoal')?.messages;
  syncGoal(run,human?.length?human:[{id:'initial-request',text:args.task}]);
  await refreshRevision(entry,ctx.fs,exec.signal);
  await createRole(entry,{name:'user',title:'Пользователь',purpose:'Цели, UX и независимая пользовательская приёмка',instructions:USER,capability:'user'},exec.signal);
  const brief=await createTask(entry,{assignee:'user',title:'Определить цель и критерии приёмки',kind:'brief',instructions:`Inspect the actual task/project. Define audience/player, primary journey, meaningful acceptance criteria and visual ambition. Keep it concise. Do not prescribe a composition before exploration. For a game identify actual engine and key mechanics to verify. Do not run a full regression yet.\n${args.task}`,dependsOn:[]},exec.signal);
  return {status:'running',briefTaskId:brief.id,next:'Wait for the User brief, create suitable named specialists and dependency tasks. Coordinate until gvs_finish accepts all gates.'};
 });
 register('gvs_agent','Create, list, wake, message, retire or request a persistent named role. Only Lead creates roles; teammates may message peers or request help. Wake rechecks EXISTING tasks and respects dependencies; use gvs_task create for NEW work. Message only clarifies existing work.',{action:{type:'string',enum:['create','list','wake','message','retire','request']},name:text(40),title:text(80),purpose:text(1200),instructions:text(5000),capability:{type:'string',enum:['read','edit','verify']},message:text(5000)},['action'],async(args,exec)=>{
  const {member,entry}=await current(exec);
  if(args.action==='list')return {roles:entry.run.roles};
  if(args.action==='request'){
   if(!args.message?.trim()&&!args.purpose?.trim())throw new Error('Explain the concrete missing expertise or task dependency.');
   entry.run.goal.roleRequests??=[];const request={id:`need-${randomUUID().slice(0,8)}`,from:member.name,purpose:args.message??args.purpose,capability:args.capability??null,agent:null,taskId:null};entry.run.goal.roleRequests.push(request);delete entry.run.goal.handoff;await commit(entry);
   await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS ROLE REQUEST ${request.id} from ${member.name}: ${args.message??args.purpose}. Coordinator: create or reuse a suitable role and dependency task, then gvs_goal link requestId=${request.id} agentName/taskId. This durable request blocks completion until assigned.`}],signal:exec.signal});return {status:'request-sent',requestId:request.id};
  }
  if(args.action==='message'){if(!args.name||!args.message)throw new Error('Provide recipient name and message.');await ctx.agentTeams.sendMessage(exec.agent,{target:args.name,content:[{type:'text',text:args.message}],signal:exec.signal});return {status:'message-accepted',target:args.name};}
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
 register('gvs_task','Create tasks with real dependencies; waiting tasks automatically wake their named agents. Teammates complete their own task. Reviews must report actual checks/images and concrete findings; blocked tasks keep downstream work waiting.',
  {action:{type:'string',enum:['create','list','complete','retry','dependencies','update']},taskId:text(40),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:60},title:text(180),instructions:text(15000),assignee:text(40),kind:{type:'string',enum:taskKinds},dependsOn:strings,writeScopes:strings,priority:{type:'integer',minimum:-100,maximum:100},reason:text(1000),scope:{type:'string',enum:['increment','full']},analysisIds:strings,
   verdict:{type:'string',enum:['pass','revise','blocked']},summary:text(4000),findings:{...strings,description:'ALL required fixes, missing functionality, visual mismatches or blockers; do not hide scope gaps in summary. For pass use [].'},scopeReviewed:{type:'boolean',description:'Independently compared the entire human goal and feature inventory against implementation; accepting the recent repair alone is insufficient.'},coveredRequirements:{...strings,maxItems:1000},addressedIssues:{...strings,maxItems:1000},inventory:{type:'array',maxItems:100,items:{...object({feature:text(500),evidence:text(1500),status:{type:'string',enum:['confirmed','unknown']},requirementIds:strings}),required:['feature','evidence','status','requirementIds']}},checks:{...strings,description:'ONLY exact verbatim foreground command strings, e.g. node test.mjs. No commentary, prefixes, read tools or annotations.'},images:{...strings,maxItems:1000},analysisReports:strings,simple:{type:'boolean'},scopePreserved:{type:'boolean'},adapterReviewed:{type:'boolean'},visualReview:{...object({manualCoverage:text(2000),checked:{type:'array',items:{type:'string',enum:VISUAL_CHECKS},maxItems:7},assessments:{type:'array',maxItems:1000,items:{...object({warningId:text(60),imageId:text(150),disposition:{type:'string',enum:['intentional','defect','outside-scope']},reason:text(1000)}),required:['warningId','imageId','disposition','reason']}}}),required:['checked','assessments']}},['action'],async(args,exec)=>{
   const {member,entry,name}=await current(exec);
   if(args.action==='list'){
    if(args.taskId){
     const tasks=taskSummaries(entry.run.tasks.filter(task=>task.id===args.taskId),true),offset=args.offset??0,limit=args.limit??4;
     for(const task of tasks)if(task.result){const {inventory=[],findings=[]}=task.result;task.result={...task.result,inventory:inventory.slice(offset,offset+limit),findings:findings.slice(offset,offset+limit),totals:{inventory:inventory.length,findings:findings.length},nextOffset:offset+limit<Math.max(inventory.length,findings.length)?offset+limit:null};}
     return {tasks};
    }
    const tasks=[...entry.run.tasks.filter(task=>task.state!=='done'),...entry.run.tasks.filter(task=>task.state==='done').reverse()],offset=args.offset??0,limit=args.limit??10;
    return {tasks:taskSummaries(tasks.slice(offset,offset+limit)),total:tasks.length,nextOffset:offset+limit<tasks.length?offset+limit:null};
   }
   if(args.action==='create'){lead(member);return {task:await createTask(entry,args,exec.signal)};}
   if(args.action==='update'){
    lead(member);const task=entry.run.tasks.find(task=>task.id===args.taskId);
    if(!task||!['waiting','running','blocked'].includes(task.state)||!args.reason?.trim())throw new Error('Update an outstanding task with the concrete reason; preserve remaining requirements in owned follow-up tasks.');
    if(args.scope)Object.assign(task,reviewPlan(entry.run,args));
    if(args.instructions)task.instructions=args.instructions;if(args.title)task.title=args.title;if(args.priority!==undefined)task.priority=args.priority;
    await commit(entry);
    if(task.state==='running')await ctx.agentTeams.sendMessage(entry.root,{target:task.assignee,content:[{type:'text',text:`UPDATED EXISTING ${task.id}: ${args.reason}\nCURRENT ASSIGNMENT: ${task.instructions}\nContinue this same task/identity; old unrelated work remains owned in follow-up tasks and the full goal is still binding.`}],signal:exec.signal});
    await schedule(entry,exec.signal);return {task:taskSummaries([task],true)[0]};
   }
   if(['retry','dependencies'].includes(args.action)){
    lead(member);const task=entry.run.tasks.find(task=>task.id===args.taskId);if(!task||!['blocked','waiting'].includes(task.state))throw new Error('Retry/change dependencies only for blocked or waiting tasks.');
    if(args.instructions)task.instructions=args.instructions;
    if(args.dependsOn){assertDag(entry.run.tasks.map(item=>item.id===task.id?{...item,dependsOn:args.dependsOn}:item));const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'set_dependencies',blockedBy:args.dependsOn});task.dependsOn=args.dependsOn;}
    if(args.action==='retry'){const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});task.state='waiting';delete task.result;}
    await commit(entry);await schedule(entry,exec.signal);return {task};
   }
   const task=entry.run.tasks.find(task=>task.id===args.taskId);if(!task||task.assignee!==name||task.state!=='running')throw new Error('Only the assigned running teammate may complete this task.');
   if(!args.verdict||!args.summary||!Array.isArray(args.findings))throw new Error('Provide verdict, summary and findings.');
   if(args.verdict==='pass'&&args.findings.length)throw new Error('For pass, findings must be []. Put positive observations in summary; findings is only for required fixes or blockers.');
   if((args.coveredRequirements??[]).some(id=>!entry.run.goal.requirements.some(req=>req.id===id))||(args.addressedIssues??[]).some(id=>!entry.run.goal.issues.some(issue=>issue.id===id)))throw new Error('Attest only actual requirement/issue IDs from gvs_goal status.');
   if(task.kind==='brief'&&args.verdict==='pass'&&entry.run.analysis?.state!=='ready')throw new Error('The User must first call gvs_analysis plan, selecting only analyses this task needs. Use [] with a concrete rationale for a simple task.');
   if(task.kind==='brief'&&args.verdict==='pass'&&(!entry.run.goal.requirements.length||goalStatus(entry.run).unassessed.length))throw new Error('First call gvs_goal plan to cover the actual human messages; a local subset cannot replace the human contract.');
   if(task.kind==='discovery'&&args.verdict==='pass'&&(!args.inventory?.length||args.inventory.some(item=>!item.requirementIds.length||item.requirementIds.some(id=>!entry.run.goal.requirements.some(req=>req.id===id)))))throw new Error('Discovery needs a source-backed feature/protocol/state inventory mapped to existing requirement IDs. Unknown features remain explicit requirements/blockers.');
   const reviewRun=task.scope==='increment'?{...entry.run,analysis:{...entry.run.analysis,requirements:entry.run.analysis?.requirements.filter(item=>task.analysisIds.includes(item.id))??[]}}:entry.run;
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!analysisReady(reviewRun))throw new Error('Task-specific analysis is incomplete or lacks independent adapter review. Do not accept visible smoothness from transform values or static screenshots.');
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!analysisAcceptance(reviewRun,{...task,result:{analysisVersion:entry.run.analysis?.version??0,analysisReports:args.analysisReports??[]}}))throw new Error('Cite received current analysisReports IDs when accepting task-specific evidence.');
   if(['design-review','user-review'].includes(task.kind)&&args.verdict==='pass'&&!imageAcceptance(entry.run,{...task,result:{images:args.images??[]}}))throw new Error('A rendered review requires actual current images for each assigned viewport, including increment reviews.');
   if(task.kind==='review'&&args.verdict==='pass'&&(args.analysisReports??[]).some(id=>!(entry.run.analysisChecks??[]).some(report=>report.id===id&&report.ok&&report.revision===entry.run.revision&&report.planVersion===entry.run.analysis?.version&&report.capturedBy!==name)) )throw new Error('Independently review only successful current analysis reports captured by another agent.');
   if(name!=='user'&&!task.consultations.some(id=>reusableDecision(entry.run,id))&&args.verdict==='pass')throw new Error('Use gvs_ask_user with a current recorded User decision (reuseTaskId) or one focused unanswered question. Do not repeat the full regression or readiness audit.');
   const checks=args.checks??[];
   if(task.kind==='review'&&args.verdict==='pass'&&(!checks.length||checks.some(command=>!entry.run.checks.some(check=>check.taskId===task.id&&check.command.trim()===command.trim()&&check.finished&&!check.error&&check.exitCode===0))))throw new Error(`checks must contain ONLY verbatim successful command strings, without commentary. Available exact commands for this task: ${JSON.stringify([...new Set(entry.run.checks.filter(check=>check.taskId===task.id&&check.finished&&!check.error&&check.exitCode===0).map(check=>check.command))])}. Move observations to summary. Do not use a game adapter for an ordinary code task.`);
   const externalVisualFindings=validateVisualReview(entry.run,task,args);
   task.result={verdict:args.verdict,summary:args.summary,findings:args.findings,inventory:args.inventory??[],scopeReviewed:args.scopeReviewed===true,coveredRequirements:args.coveredRequirements??[],addressedIssues:args.addressedIssues??[],checks,images:args.images??[],analysisReports:args.analysisReports??[],analysisVersion:entry.run.analysis?.version??0,simple:args.simple===true,scopePreserved:args.scopePreserved===true,adapterReviewed:args.adapterReviewed===true,visualReview:args.visualReview??null,revision:entry.run.revision};
   if(name==='user'&&['brief','consultation'].includes(task.kind))task.result.decisionKey=decisionKey(entry.run);
   if(['brief','consultation','discovery'].includes(task.kind))entry.run.progress.metadataSinceWrite++;
   task.state=args.verdict==='blocked'?'blocked':'done';
   if(task.state==='done'){const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'complete'});}
   entry.waiters.get(task.id)?.(task.result);entry.waiters.delete(task.id);
   const issues=[...recordFindings(entry.run,task),...(externalVisualFindings.length?recordFindings(entry.run,{...task,result:{verdict:'revise',summary:'Visual defects outside this increment remain mandatory',findings:externalVisualFindings}}):[])];
   await commit(entry);
   try{await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS TASK RESULT ${JSON.stringify({taskId:task.id,assignee:name,kind:task.kind,verdict:task.result.verdict,summary:clip(task.result.summary,1000),findings:task.result.findings.map(item=>clip(item,600)),issueIds:issues.map(item=>item.id),inventoryItems:task.result.inventory.length})}\nCoordinator: read the full result via gvs_task list, process EVERY finding, create/link repair and independent recheck tasks with gvs_goal. Continue the complete human goal; this is not permission to narrow scope or end the run.`}],signal:exec.signal});}
   catch(error){task.notificationError=clip(error.message,500);await commit(entry);}
   await schedule(entry,exec.signal);return {task};
  });
 register('gvs_ask_user','Consult the central User on a consequential unanswered UX decision, or reuse a recorded decision with reuseTaskId. Do not ask for repeated readiness/ownership approval or permission.',{question:text(2000),context:text(6000),reuseTaskId:text(40)},[],async(args,exec)=>{
  const {entry,name}=await current(exec);if(name==='lead'||name==='user')throw new Error('This tool is for specialists; the coordinator schedules User tasks.');
  const own=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running');if(!own)throw new Error('No assigned running task');
  const key=args.question?consultationKey(args.question,args.context):null;
  const cached=args.reuseTaskId?reusableDecision(entry.run,args.reuseTaskId):entry.run.tasks.find(task=>task.questionKey===key&&reusableDecision(entry.run,task.id));
  if(args.reuseTaskId&&!cached)throw new Error('Reuse only a passed User brief/consultation for the current human contract and analysis criteria. A new or changed decision needs a focused question.');
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
 register('gvs_wait','Wait up to 30 seconds for actual team activity, then inspect results. Dependencies wake agents automatically; do not poll inactive teammates.',{seconds:{type:'integer',minimum:10,maximum:30}},[],async(args,exec)=>{
  const {member,entry}=await current(exec);lead(member);await schedule(entry,exec.signal);const progress=progressStatus(entry.run,Date.now(),config.maxSliceMs??1200000);if(progress.needsIntervention)return {status:'needs-coordination',progress};if(!entry.run.tasks.some(task=>task.state==='running'))return {status:'needs-coordination',progress};await ctx.agentTeams.waitForChange(exec.agent,(args.seconds??20)*1000,exec.signal);return {status:entry.run.status,progress};
 },35000);
 register('gvs_status','Read saved GVS team state, decisions and evidence in this session.',{},[],async(_args,exec)=>{
  const {entry,root}=await current(exec,false);if(entry)return {status:entry.run.status,quality:entry.run.quality,
   checks:entry.run.checks.slice(-8).map(({agent,taskId,command,exitCode,finished,error,output})=>({agent,taskId,command,exitCode,finished,error,output:clip(output,800)})),
   gameChecks:entry.run.gameChecks.slice(-8).map(({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,views})=>({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,errors:(views??[]).flatMap(view=>view.errors)})),preview:entry.run.preview,progress:progressStatus(entry.run)};
  try{const io=await storage(root,exec.signal);const legacy=JSON.parse(await io.read('.gvs/latest.json'));return {status:legacy.status,legacy:true,summary:legacy.summary};}catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return {status:'no-runs'};throw error;}
 });
 register('gvs_visual','Read rendered layout warnings and actual screenshots. QA and User independently inspect overlap, clipping, spacing, alignment, readability, responsive states and hit areas. Warnings are candidates, never automatic proof of a defect. Page through all pending warnings; do not substitute a clean final image for initial/intermediate states.',{warningId:text(60),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:6}},[],async(args,exec)=>{
  const {entry,name}=await current(exec),status=visualAuditStatus(entry.run),offset=args.offset??0,limit=args.limit??6;
  const ordered=[...status.warnings.filter(w=>!w.qaReviewed||!w.userReviewed),...status.warnings.filter(w=>w.qaReviewed&&w.userReviewed)];
  const warnings=args.warningId?ordered.filter(w=>w.id===args.warningId):ordered.slice(offset,offset+limit),images=[];
  const available=entry.run.visualChecks.filter(c=>c.ok&&c.revision===entry.run.revision).flatMap(c=>c.images);
  for(const warning of warnings){const image=available.find(i=>warning.images.includes(i.attachment.attachmentId));if(image&&!images.some(i=>i.attachment.attachmentId===image.attachment.attachmentId))images.push(image);}
  const own=entry.run.tasks.find(t=>t.assignee===name&&t.state==='running');if(own){own.receivedImages=[...new Set([...(own.receivedImages??[]),...images.map(i=>i.attachment.attachmentId)])];await commit(entry);}
  return {ready:status.ready,total:ordered.length,warnings,images,nextOffset:!args.warningId&&offset+limit<ordered.length?offset+limit:null,requiredChecks:VISUAL_CHECKS,coverageLimits:entry.run.visualChecks.filter(c=>c.ok&&c.revision===entry.run.revision).flatMap(c=>(c.views??[]).filter(v=>v.layout?.truncated||v.uncapturedTransitions>0).map(v=>({viewport:v.viewport,truncated:v.layout?.truncated??false,uncapturedTransitions:v.uncapturedTransitions??0}))),next:'Classify visible candidates with actual image IDs and specific pixel/readability/hit-area evidence. Defects require revise+repair/recheck. An out-of-scope defect in an increment is saved as a mandatory global issue, never waived. No findings does not replace manual visual inspection of all states. Split long journeys to capture omitted transitions; bounded scans require explicit manualCoverage.'};
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
  if(result.value?.kind!=='foreground')throw new Error('Analysis must finish in foreground.');
  const stdout=result.value.stdout?.text??'',marker='GVS_ANALYSIS_RESULT:',offset=stdout.lastIndexOf(marker);if(offset<0)throw new Error('Runner must print final GVS_ANALYSIS_RESULT: followed by gvs.analysis/1 JSON.');
  const report={...parseAnalysisReport(JSON.parse(stdout.slice(offset+marker.length).trim()),entry.run.analysis,entry.run.viewports),id:`analysis-${randomUUID()}`,revision,planVersion,capturedBy:name,taskId:own.id,command:args.command,images:[],frameSummary:[]};
  report.ok=report.ok&&!result.isError&&result.value.exitCode===0;
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
  for(const task of entry.run.tasks.filter(task=>task.state==='running')){ctx.agentTeams.interrupt(entry.root,task.assignee);task.state='blocked';task.result={verdict:'blocked',summary:'Paused; inspect partial work before resuming.',findings:[],interrupted:true,revision:entry.run.revision};}
  if(entry.run.preview?.jobId){try{ctx.jobs.kill(entry.run.preview.jobId,entry.root.id,'GVS paused');}catch{}}
  await commit(entry);
 }
 async function suspend(entry){
  if(entry.suspending||entry.run.status!=='running')return;entry.suspending=true;
  entry.run.suspended=true;entry.run.summary='Runtime stopped; the complete goal remains active and will recover after restart.';
  entry.abort.abort(new Error('GVS runtime suspended'));
  for(const task of entry.run.tasks.filter(task=>task.state==='running')){
   task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],interrupted:true,revision:entry.run.revision};
   try{ctx.agentTeams.interrupt(entry.root,task.assignee);}catch{}
  }
  await commit(entry);
 }
 register('gvs_pause','Pause this team’s work and its managed preview, preserving named agents, tasks and memory.',{},[],async(_args,exec)=>{const {member,entry}=await current(exec);lead(member);await pause(entry);return {status:'paused'};});
 async function restoreTasks(entry,signal,automatic=false){
  const recovered=[];
  for(const task of entry.run.tasks.filter(task=>task.state==='blocked'&&(automatic?/^Interrupted by service restart;/.test(task.result?.summary??''):task.result?.interrupted===true||/^(?:Interrupted by service restart;|Paused;)/.test(task.result?.summary??'')))){
   signal.throwIfAborted();if(entry.run.status!=='running')break;
   const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});
   task.state='waiting';delete task.result;recovered.push(task.id);
  }await commit(entry);await schedule(entry,signal);return recovered;
 }
 register('gvs_recover','Recover only service-interrupted assignments of an already active autonomous goal. Never resumes a human pause or replaces agents/tasks.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);
  if(entry.run.status!=='running'||!entry.run.goal?.autonomous||entry.run.goal?.handoff)return {status:entry.run.status,recovered:[],continued:false};
  if(entry.abort.signal.aborted)entry.abort=new AbortController();entry.suspending=false;delete entry.run.suspended;
  const recovered=await restoreTasks(entry,exec.signal,true);return {status:entry.run.status,recovered,continued:entry.run.status==='running'};
 });
 register('gvs_resume','Resume saved GVS tasks after the user requests continuation; the same named agents keep their conversations.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);entry.abort=new AbortController();entry.run.status='running';entry.suspending=false;delete entry.run.suspended;
  const recovered=await restoreTasks(entry,exec.signal);return {status:entry.run.status,recovered};
 });
 register('gvs_preview','Start, inspect or stop this team’s managed local dev server. Use the existing project command and free port; the coordinator owns it across agent tasks.',{action:{type:'string',enum:['start','status','stop']},command:text(4000),port:{type:'integer',minimum:1024,maximum:65535}},['action'],async(args,exec)=>{
  const {entry}=await current(exec),jobs=ctx.jobs;
  if(args.action==='status')return previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true);
  if(args.action==='stop'){if(!entry.run.preview?.jobId)return {status:'not-running'};const id=entry.run.preview.jobId;jobs.kill(id,entry.root.id,'Stop GVS preview');const settled=await jobs.wait(id,5000,entry.root.id,exec.signal);return {status:settled.status,jobId:id};}
  const membership=ctx.agentTeams.membership(exec.agent),role=roleOf(entry,membership.name);
  if(membership.role!=='lead'&&!['edit','verify'].includes(role?.capability))throw new Error('Ask the coordinator to start the preview; this role cannot execute startup commands.');
  const port=args.port??4173,url=previewURL(`http://127.0.0.1:${port}/`).href;
  try{const old=jobs.get(entry.run.preview?.jobId,entry.root.id);if(['running','stopping'].includes(old.status))return previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true);}catch{}
  if(!args.command)throw new Error('Provide the project preview command.');
  let occupied=false;try{const res=await fetch(url,{signal:AbortSignal.timeout(700)});await res.body?.cancel();occupied=true;}catch{}if(occupied)throw new Error('This port already responds; inspect it explicitly or use a free port.');
  const result=await entry.root.ctx.tools.execute({callId:randomUUID(),agent:entry.root,signal:exec.signal,name:process.platform==='win32'?'pwsh':'bash',arguments:{description:'Start GVS project preview',command:args.command,workdir:entry.io.cwd,run_in_background:true}});
  if(result.isError||!result.value?.jobId)throw new Error('Preview could not start as a managed job.');entry.run.preview={url,jobId:result.value.jobId};await commit(entry);
  for(let i=0;i<40;i++){
   exec.signal.throwIfAborted();const observed=await previewState(entry.run.preview,jobs,entry.root.id,exec.signal);
   if(observed.ready)return observed;
   if(observed.status==='failed')return previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true);
   await new Promise(resolve=>setTimeout(resolve,400));
  }
  return previewState(entry.run.preview,jobs,entry.root.id,exec.signal,fetch,true);
 },60000);
 async function vision(exec){const route=exec.agent.session.requestHeader()?.config??exec.agent.options;const info=await ctx.llm.resolveModelInfo(route.provider,route.model,exec.signal);if(!info.inputModalities?.includes('image'))throw new Error('Choose an image-capable model for visual acceptance.');}
 const action={...object({kind:text(30),role:text(50),name:text(180),label:text(180),testId:text(100),state:text(30),value:{type:['string','number','boolean']},key:text(60),frames:{type:'integer',minimum:1,maximum:600},scenario:text(100),x:{type:'number'},y:{type:'number'},click:{type:'boolean'},path:text(200),op:{type:'string',enum:['eq','gt','gte','lt','lte','near']},tolerance:{type:'number',minimum:0},category:{type:'string',enum:['collision','gameplay','controls','camera']}}),required:['kind']};
 async function browserCheck(args,exec,game){
  const {entry,name}=await current(exec);await vision(exec);
  if(entry.run.visualChecks.length>=64)throw new Error('Browser check budget exhausted.');
  const signal=AbortSignal.any([exec.signal,entry.abort.signal]);
  const report=await (game?captureGame:captureBrowser)(args,{config,signal,saveImage:image=>ctx.attachments.saveImage(image),viewports:entry.run.viewports});
  const record={...report,revision:entry.run.revision,capturedBy:name,taskId:entry.run.tasks.find(t=>t.assignee===name&&t.state==='running')?.id??null};entry.run.visualChecks.push(record);if(game)entry.run.gameChecks.push(record);await commit(entry);return report;
 }
 register('gvs_browser_check','Inspect the real local UI at desktop/phone sizes with semantic actions and assertions. Returns actual screenshots, errors and layout evidence. Game collision evidence needs gvs_game_check.',{url:text(2000),scenario:text(500),actions:{type:'array',items:action,maxItems:12}},['url'],(args,exec)=>browserCheck(args,exec,false));
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
   if(event.type==='turn/end'&&task.executionTurn===event.data.turn){task.state='blocked';task.result={verdict:'blocked',summary:`Agent turn ended (${event.data.reason.kind}) without completing its assigned task. Inspect its chat and retry this task.`,findings:[],revision:entry.run.revision};commit(entry).catch(()=>{});}
  }
 });
 ctx.effect(()=>async()=>{for(const id of owned){const entry=entries.get(id);if(entry?.owner===ctx&&entry.run.status==='running')await suspend(entry).catch(()=>{});}});
}
