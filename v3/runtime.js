import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {clip,roleSpec,readyTasks,assertDag,view,quality,kinds,taskKinds,parseGameReport} from './domain.js';
import {captureBrowser,captureGame,previewURL} from './browser.js';
import {COMMON,USER,GAME} from './prompts.js';

export const inject=['tools','agentTeams','subagents','fs','workingDirectory','sandboxPolicy','attachments','llm','jobs'];
const entries=new Map(),instance=randomUUID();
const object=properties=>({type:'object',additionalProperties:false,properties});
const text=(maxLength=4000)=>({type:'string',maxLength});
const strings={type:'array',items:{type:'string'},maxItems:40};
const imageParts=images=>images.map(image=>({type:'image',attachment:image.attachment}));
const roleOf=(entry,name)=>entry.run.roles.find(role=>role.name===name);
const liveImages=run=>run.viewports.map(viewport=>run.visualChecks.filter(check=>check.ok&&check.revision===run.revision).flatMap(check=>check.images).filter(image=>image.viewport===viewport).at(-1)).filter(Boolean);
const taskSummaries=run=>run.tasks.map(({id,title,assignee,kind,dependsOn,state,result})=>({id,title,assignee,kind,dependsOn,state,...(result?{result:{...result,summary:clip(result.summary,800)}}:{})}));

export function apply(ctx,config={}){
 const maxParallel=config.maxParallel??2,maxTasks=config.maxTasks??64;
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
    run.status='paused';run.summary='Service restarted. Inspect partial work and call gvs_resume to continue.';
    for(const role of run.roles)role.waitingForUser=false;
    for(const task of run.tasks.filter(task=>task.state==='running')){task.state='blocked';task.result={verdict:'blocked',summary:'Interrupted by service restart; inspect partial work before resuming.',findings:[],revision:run.revision};}
   }
   const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);return entry;
  }catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return null;throw error;}
 }
 async function current(exec,required=true){
  if(!exec.agent)throw new Error('A GVS session is required');
  const member=ctx.agentTeams.membership(exec.agent),entry=await load(member.root,exec.signal);
  if(required&&!entry)throw new Error('The coordinator must call gvs_run first.');
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
  if(existing){if(existing.capability!==spec.capability)throw new Error('A persistent role cannot silently change capability. Use a new role name.');existing.retired=false;return existing;}
  if(entry.run.roles.length>=8)throw new Error('This team already has eight roles; reuse a suitable agent.');
  const role={...spec,sessionId:null,retired:false};entry.run.roles.push(role);
  try{
   const created=await ctx.agentTeams.spawnTeammate(entry.root,{name:spec.name,description:`${spec.title} — ${spec.purpose}`.slice(0,1000),context:'fresh',provider:'spawn',signal,
    prompt:[{type:'text',text:`${COMMON}\n\nROLE ${spec.name}: ${spec.title}\nPURPOSE: ${spec.purpose}\nCAPABILITY: ${spec.capability}\n${spec.capability==='user'?USER:spec.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\nHUMAN TASK: ${entry.run.task}\nThis is role registration, not an assigned task yet. Briefly acknowledge and become idle; a dependency-ready task will wake this same conversation.`}]});
   role.sessionId=created.member.id;
  }catch(error){role.error=clip(error.message);throw error;}finally{await commit(entry);}
  return role;
 }
 async function createTask(entry,input,signal){
  if(entry.run.tasks.length>=maxTasks)throw new Error('Task budget exhausted; report the remaining work.');
  if(!roleOf(entry,input.assignee)||roleOf(entry,input.assignee).retired)throw new Error('Create an appropriate role first.');
  const dependsOn=input.dependsOn??[];assertDag([...entry.run.tasks,{id:'new-task',dependsOn}]);
  if(!taskKinds.includes(input.kind))throw new Error('Choose a supported task kind.');
  const role=roleOf(entry,input.assignee);
  if(['review','game-review'].includes(input.kind)&&role.capability!=='verify')throw new Error('Assign independent verification to a verify role, not the editing agent.');
  if(input.kind==='design-review'&&role.capability==='edit')throw new Error('The rendered design reviewer must be separate from the editing role.');
  if(['user-review','brief','consultation'].includes(input.kind)&&input.assignee!=='user')throw new Error('User decisions belong to the central User role.');
  const native=await ctx.agentTeams.createTask(entry.root,{subject:clip(input.title,180),description:clip(input.instructions,15000),blockedBy:dependsOn,writeScopes:input.writeScopes??[]});
  const task={id:native.id,title:clip(input.title,180),instructions:clip(input.instructions,15000),assignee:input.assignee,kind:input.kind,dependsOn,state:'waiting',receivedImages:[],consultations:[]};
  entry.run.tasks.push(task);await commit(entry);await schedule(entry,signal);return task;
 }
 async function schedule(entry,signal){
  if(entry.scheduling)return entry.scheduling;
  entry.scheduling=(async()=>{
   if(entry.run.status!=='running')return;
   for(const task of readyTasks(entry.run)){
    if(entry.abort.signal.aborted||signal.aborted)break;
    const role=roleOf(entry,task.assignee),running=entry.run.tasks.filter(task=>task.state==='running');
    if(role.retired||running.some(task=>task.assignee===role.name))continue;
    if(role.capability!=='user'&&running.filter(task=>task.assignee!=='user').length>=maxParallel)continue;
    if(role.capability==='edit'&&running.some(task=>['edit','verify'].includes(roleOf(entry,task.assignee)?.capability)))continue;
    if(role.capability==='verify'&&running.some(task=>['edit','verify'].includes(roleOf(entry,task.assignee)?.capability)))continue;
    const native=ctx.agentTeams.getTask(entry.root,task.id);
    await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'reassign',owner:role.name});
    task.state='running';task.startedRevision=entry.run.revision;task.nonce=randomUUID();delete task.executionTurn;
    const images=liveImages(entry.run);task.receivedImages=images.map(image=>image.attachment.attachmentId);
    const deps=entry.run.tasks.filter(previous=>task.dependsOn.includes(previous.id)).map(({id,title,result})=>({id,title,result}));
    const observations=entry.run.visualChecks.filter(check=>check.revision===entry.run.revision).slice(-2).map(({ok,scenario,views})=>({ok,scenario,views}));
    const prompt=`${COMMON}\n${role.capability==='user'?USER:role.instructions}\n${entry.run.kind.startsWith('game')?GAME:''}\n\nCURRENT HUMAN TASK: ${entry.run.task}\nROLE: ${role.title}\nASSIGNED TASK ID: ${task.id}\nTASK NONCE: ${task.nonce}\nKIND: ${task.kind}\nWORK: ${task.instructions}\nDEPENDENCY RESULTS: ${JSON.stringify(deps)}\nSHARED USER DECISIONS: ${JSON.stringify(entry.run.tasks.filter(task=>task.assignee==='user'&&task.result).slice(-4).map(task=>task.result))}\nRECORDED BROWSER EVIDENCE: ${JSON.stringify(observations)}\nPREVIEW: ${JSON.stringify(entry.run.preview)}\nACTUAL ATTACHED IMAGES: ${JSON.stringify(images.map(image=>({viewport:image.viewport,id:image.attachment.attachmentId})))}\nFinish with gvs_task complete for this exact task. Include actual image IDs and exact commands when reviewing. Other members wake automatically; do not poll them.`;
    try{await ctx.agentTeams.sendMessage(entry.root,{target:role.name,content:[{type:'text',text:prompt},...imageParts(images)],signal});}
    catch(error){task.state='blocked';task.result={verdict:'blocked',summary:clip(error.message),findings:[clip(error.message)],revision:entry.run.revision};}
    await commit(entry);
   }
  })();try{await entry.scheduling;}finally{entry.scheduling=null;}
 }
 function register(name,description,properties,required,execute,timeoutMs=120000){
  ctx.tools.register({name,description,parameters:{...object(properties),required},timeoutMs,
   output:{schema:{},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)},...imageParts(value.images??[])]},
   async execute(args,exec){const value=await execute(args,exec);const info=await current(exec,false);return JSON.parse(JSON.stringify({...value,...(info.entry?{gvsTeam:view(info.entry.run)}:{})}));}});
 }
 ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!exec.agent)return next();const membership=ctx.agentTeams.tryMembership(exec.agent);if(!membership||membership.role==='lead')return next();
  const entry=await load(membership.root,exec.signal),role=entry&&roleOf(entry,membership.name);
  const alwaysRead=['read','read_image','glob','grep','working_directory','gvs_status'];
  if(!role)return alwaysRead.includes(exec.name)?next():{kind:'deny',reason:'This teammate has no GVS role assignment.'};
  if(['gvs_run','gvs_finish','gvs_resume','gvs_pause'].includes(exec.name))return {kind:'deny',reason:'This is a coordinator-only operation.'};
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
  if(['gvs_run','gvs_finish','gvs_resume','gvs_pause'].includes(exec.name))return 'Only the coordinator may control the run.';
  if(role.capability==='user'&&exec.name==='gvs_ask_user')return 'The User advocate cannot consult itself.';
  if(['write','edit'].includes(exec.name)&&role.capability!=='edit')return 'This role may not edit project files.';
  if(['pwsh','bash','gvs_native_game_check'].includes(exec.name)&&!['edit','verify'].includes(role.capability))return 'This role has no command execution capability.';
  if(!entry.run.tasks.some(task=>task.assignee===member.name&&task.state==='running')&&['write','edit','pwsh','bash','gvs_native_game_check','gvs_browser_check','gvs_game_check'].includes(exec.name))return 'No dependency-ready task is assigned. Wait for the scheduler; do not start this work early.';
  if(entry.run.status!=='running'&&!basic.includes(exec.name))return 'The run is paused or finished.';
 });
 ctx.on('tools/result',(exec,result)=>{
  if(!exec.agent)return;const member=ctx.agentTeams.tryMembership(exec.agent),entry=member&&entries.get(member.root.id);if(!entry||entry.run.status!=='running')return;
  const role=roleOf(entry,member.name),task=entry.run.tasks.find(task=>task.assignee===member.name&&task.state==='running');
  if(!result.isError&&(['write','edit'].includes(exec.name)||['pwsh','bash'].includes(exec.name)&&(!role||role.capability==='edit')))entry.run.revision++;
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
   visualRequired,viewports:args.viewports??(args.kind==='ui'?['desktop','mobile']:['desktop']),roles:previous?.run.roles??[],tasks:[],checks:[],visualChecks:[],gameChecks:[],preview:null,quality:null,summary:''};
  const entry={run,root,io,write:Promise.resolve(),abort:new AbortController(),waiters:new Map(),scheduling:null};entries.set(root.id,entry);
  await createRole(entry,{name:'user',title:'Пользователь',purpose:'Цели, UX и независимая пользовательская приёмка',instructions:USER,capability:'user'},exec.signal);
  const brief=await createTask(entry,{assignee:'user',title:'Определить цель и критерии приёмки',kind:'brief',instructions:`Inspect the actual task/project. Define audience/player, primary journey, meaningful acceptance criteria and visual ambition. Keep it concise. Do not prescribe a composition before exploration. For a game identify actual engine and key mechanics to verify. Do not run a full regression yet.\n${args.task}`,dependsOn:[]},exec.signal);
  return {status:'running',briefTaskId:brief.id,next:'Wait for the User brief, create suitable named specialists and dependency tasks. Coordinate until gvs_finish accepts all gates.'};
 });
 register('gvs_agent','Create, list, wake, message, retire or request a persistent named role. Only Lead creates roles; teammates may message peers or request help. Wake rechecks EXISTING tasks and respects dependencies; use gvs_task create for NEW work. Message only clarifies existing work.',{action:{type:'string',enum:['create','list','wake','message','retire','request']},name:text(40),title:text(80),purpose:text(1200),instructions:text(5000),capability:{type:'string',enum:['read','edit','verify']},message:text(5000)},['action'],async(args,exec)=>{
  const {member,entry}=await current(exec);
  if(args.action==='list')return {roles:entry.run.roles};
  if(args.action==='request'){
   await ctx.agentTeams.sendMessage(exec.agent,{target:'lead',content:[{type:'text',text:`GVS ROLE REQUEST from ${member.name}: ${args.message??args.purpose}. Coordinator: decide whether to create or reuse a suitable role and dependency task.`}],signal:exec.signal});return {status:'request-sent'};
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
  const assigned=entry.run.tasks.find(task=>task.assignee===role.name&&['waiting','running','blocked'].includes(task.state));
  if(!assigned)return {status:'idle',sessionId:role.sessionId,reused:true,next:'Create a new task for this existing role with gvs_task create. No new agent is needed.'};
  if(assigned.state==='running'&&args.message)await ctx.agentTeams.sendMessage(entry.root,{target:role.name,content:[{type:'text',text:`Clarification for existing ${assigned.id}: ${args.message}`}],signal:exec.signal});
  await schedule(entry,exec.signal);await commit(entry);
  return {status:assigned.state,taskId:assigned.id,dependsOn:assigned.dependsOn,sessionId:role.sessionId,reused:true,next:assigned.state==='blocked'?'Resolve the blocker and use gvs_task retry.':assigned.state==='waiting'?'Dependencies/resources are not ready; the scheduler wakes this agent automatically.':'This agent is already working on the existing task.'};
 });
 register('gvs_task','Create tasks with real dependencies; waiting tasks automatically wake their named agents. Teammates complete their own task. Reviews must report actual checks/images and concrete findings; blocked tasks keep downstream work waiting.',
  {action:{type:'string',enum:['create','list','complete','retry','dependencies']},taskId:text(40),title:text(180),instructions:text(15000),assignee:text(40),kind:{type:'string',enum:taskKinds},dependsOn:strings,writeScopes:strings,
   verdict:{type:'string',enum:['pass','revise','blocked']},summary:text(4000),findings:{...strings,description:'ONLY required fixes or blockers. For pass use []. Put positive observations in summary.'},checks:{...strings,description:'ONLY exact verbatim foreground command strings, e.g. node test.mjs. No commentary, prefixes, read tools or annotations.'},images:strings,simple:{type:'boolean'},scopePreserved:{type:'boolean'},adapterReviewed:{type:'boolean'}},['action'],async(args,exec)=>{
   const {member,entry,name}=await current(exec);
   if(args.action==='list')return {tasks:taskSummaries(entry.run)};
   if(args.action==='create'){lead(member);return {task:await createTask(entry,args,exec.signal)};}
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
   if(name!=='user'&&!task.consultations.length&&args.verdict==='pass')throw new Error('Consult the central User with gvs_ask_user before accepting your task.');
   const checks=args.checks??[];
   if(task.kind==='review'&&args.verdict==='pass'&&(!checks.length||checks.some(command=>!entry.run.checks.some(check=>check.taskId===task.id&&check.command.trim()===command.trim()&&check.finished&&!check.error&&check.exitCode===0))))throw new Error(`checks must contain ONLY verbatim successful command strings, without commentary. Available exact commands for this task: ${JSON.stringify([...new Set(entry.run.checks.filter(check=>check.taskId===task.id&&check.finished&&!check.error&&check.exitCode===0).map(check=>check.command))])}. Move observations to summary. Do not use a game adapter for an ordinary code task.`);
   task.result={verdict:args.verdict,summary:args.summary,findings:args.findings,checks,images:args.images??[],simple:args.simple===true,scopePreserved:args.scopePreserved===true,adapterReviewed:args.adapterReviewed===true,revision:entry.run.revision};
   task.state=args.verdict==='blocked'?'blocked':'done';
   if(task.state==='done'){const native=ctx.agentTeams.getTask(entry.root,task.id);await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:'complete'});}
   entry.waiters.get(task.id)?.(task.result);entry.waiters.delete(task.id);
   await commit(entry);await schedule(entry,exec.signal);return {task};
  });
 register('gvs_ask_user','Ask the central User advocate a concrete UX/design/gameplay question. This wakes the SAME User conversation and waits for its task result. Do not use it for permission or repeat a full regression unnecessarily.',{question:text(2000),context:text(6000)},['question'],async(args,exec)=>{
  const {entry,name}=await current(exec);if(name==='lead'||name==='user')throw new Error('This tool is for specialists; the coordinator schedules User tasks.');
  const own=entry.run.tasks.find(task=>task.assignee===name&&task.state==='running');if(!own)throw new Error('No assigned running task');
  const role=roleOf(entry,name);role.waitingForUser=true;
  const task=await createTask(entry,{assignee:'user',title:`Ответить: ${role.title}`,kind:'consultation',instructions:`Answer this concrete colleague question critically against the human goal. Use supplied actual evidence; do not repeat unrelated regression. Complete this consultation task with pass/revise/blocked and useful summary/findings.\nQUESTION: ${args.question}\nCONTEXT: ${args.context??''}`},exec.signal);
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
  const {member,entry}=await current(exec);lead(member);await schedule(entry,exec.signal);if(!entry.run.tasks.some(task=>task.state==='running'))return {status:'needs-coordination'};await ctx.agentTeams.waitForChange(exec.agent,(args.seconds??20)*1000,exec.signal);return {status:entry.run.status};
 },35000);
 register('gvs_status','Read saved GVS team state, decisions and evidence in this session.',{},[],async(_args,exec)=>{
  const {entry,root}=await current(exec,false);if(entry)return {status:entry.run.status,quality:entry.run.quality,
   checks:entry.run.checks.slice(-8).map(({agent,taskId,command,exitCode,finished,error,output})=>({agent,taskId,command,exitCode,finished,error,output:clip(output,800)})),
   gameChecks:entry.run.gameChecks.slice(-8).map(({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,views})=>({mode,ok,revision,capturedBy,coverage,scenario,assertions,advancedFrames,errors:(views??[]).flatMap(view=>view.errors)})),preview:entry.run.preview};
  try{const io=await storage(root,exec.signal);const legacy=JSON.parse(await io.read('.gvs/latest.json'));return {status:legacy.status,legacy:true,summary:legacy.summary};}catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code))return {status:'no-runs'};throw error;}
 });
 register('gvs_finish','Accept a run only when independent code, User and applicable visual/game gates have real current evidence. Pending/blocked tasks and missing runtime evidence prevent verified.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);entry.run.quality=quality(entry.run);
  const open=entry.run.tasks.filter(task=>['waiting','running','blocked'].includes(task.state));
  if(open.length||!Object.values(entry.run.quality).every(Boolean)){await commit(entry);return {status:'needs-review',quality:entry.run.quality,outstanding:open.map(task=>({id:task.id,state:task.state,title:task.title})),reason:'Resolve pending/fix tasks and provide all current independent checks. Screenshots do not prove game physics.'};}
  entry.run.status='verified';entry.run.summary='Independent code, User and required visual/game evidence accepted.';await commit(entry);return {status:'verified',quality:entry.run.quality};
 });
 async function pause(entry){
  entry.run.status='paused';entry.abort.abort(new Error('GVS paused'));
  for(const task of entry.run.tasks.filter(task=>task.state==='running')){ctx.agentTeams.interrupt(entry.root,task.assignee);task.state='blocked';task.result={verdict:'blocked',summary:'Paused; inspect partial work before resuming.',findings:[],revision:entry.run.revision};}
  if(entry.run.preview?.jobId){try{ctx.jobs.kill(entry.run.preview.jobId,entry.root.id,'GVS paused');}catch{}}
  await commit(entry);
 }
 register('gvs_pause','Pause this team’s work and its managed preview, preserving named agents, tasks and memory.',{},[],async(_args,exec)=>{const {member,entry}=await current(exec);lead(member);await pause(entry);return {status:'paused'};});
 register('gvs_resume','Resume saved GVS tasks after the user requests continuation; the same named agents keep their conversations.',{},[],async(_args,exec)=>{
  const {member,entry}=await current(exec);lead(member);entry.abort=new AbortController();entry.run.status='running';
  for(const task of entry.run.tasks.filter(task=>task.state==='blocked')){
   const native=ctx.agentTeams.getTask(entry.root,task.id);if(['in_progress','completed'].includes(native.status))await ctx.agentTeams.updateTask(entry.root,{taskId:task.id,expectedRevision:native.revision,action:native.status==='completed'?'reopen':'release'});
   task.state='waiting';delete task.result;
  }await commit(entry);await schedule(entry,exec.signal);return {status:'running'};
 });
 register('gvs_preview','Start, inspect or stop this team’s managed local dev server. Use the existing project command and free port; the coordinator owns it across agent tasks.',{action:{type:'string',enum:['start','status','stop']},command:text(4000),port:{type:'integer',minimum:1024,maximum:65535}},['action'],async(args,exec)=>{
  const {entry}=await current(exec),jobs=ctx.jobs;
  if(args.action==='status'){try{return {...entry.run.preview,status:jobs.get(entry.run.preview.jobId,entry.root.id).status};}catch{return {status:'not-running'};}}
  if(args.action==='stop'){if(!entry.run.preview?.jobId)return {status:'not-running'};const id=entry.run.preview.jobId;jobs.kill(id,entry.root.id,'Stop GVS preview');const settled=await jobs.wait(id,5000,entry.root.id,exec.signal);return {status:settled.status,jobId:id};}
  const membership=ctx.agentTeams.membership(exec.agent),role=roleOf(entry,membership.name);
  if(membership.role!=='lead'&&!['edit','verify'].includes(role?.capability))throw new Error('Ask the coordinator to start the preview; this role cannot execute startup commands.');
  const port=args.port??4173,url=previewURL(`http://127.0.0.1:${port}/`).href;
  try{const old=jobs.get(entry.run.preview?.jobId,entry.root.id);if(old.status==='running')return {...entry.run.preview,status:'running'};}catch{}
  if(!args.command)throw new Error('Provide the project preview command.');
  let occupied=false;try{const res=await fetch(url,{signal:AbortSignal.timeout(700)});await res.body?.cancel();occupied=true;}catch{}if(occupied)throw new Error('This port already responds; inspect it explicitly or use a free port.');
  const result=await entry.root.ctx.tools.execute({callId:randomUUID(),agent:entry.root,signal:exec.signal,name:process.platform==='win32'?'pwsh':'bash',arguments:{description:'Start GVS project preview',command:args.command,workdir:entry.io.cwd,run_in_background:true}});
  if(result.isError||!result.value?.jobId)throw new Error('Preview could not start as a managed job.');entry.run.preview={url,jobId:result.value.jobId};await commit(entry);
  for(let i=0;i<40;i++){exec.signal.throwIfAborted();try{const res=await fetch(url,{signal:AbortSignal.timeout(700)});await res.body?.cancel();if(res.status<500)return {...entry.run.preview,status:'running'};}catch{}await new Promise(resolve=>setTimeout(resolve,400));}
  jobs.kill(entry.run.preview.jobId,entry.root.id,'Preview startup failed');throw new Error('Preview did not become ready.');
 },60000);
 async function vision(exec){const route=exec.agent.session.requestHeader()?.config??exec.agent.options;const info=await ctx.llm.resolveModelInfo(route.provider,route.model,exec.signal);if(!info.inputModalities?.includes('image'))throw new Error('Choose an image-capable model for visual acceptance.');}
 const action={...object({kind:text(30),role:text(50),name:text(180),label:text(180),testId:text(100),state:text(30),value:{type:['string','number','boolean']},key:text(60),frames:{type:'integer',minimum:1,maximum:600},scenario:text(100),x:{type:'number'},y:{type:'number'},click:{type:'boolean'},path:text(200),op:{type:'string',enum:['eq','gt','gte','lt','lte','near']},tolerance:{type:'number',minimum:0},category:{type:'string',enum:['collision','gameplay','controls','camera']}}),required:['kind']};
 async function browserCheck(args,exec,game){
  const {entry,name}=await current(exec);await vision(exec);
  if(entry.run.visualChecks.length>=64)throw new Error('Browser check budget exhausted.');
  const signal=AbortSignal.any([exec.signal,entry.abort.signal]);
  const report=await (game?captureGame:captureBrowser)(args,{config,signal,saveImage:image=>ctx.attachments.saveImage(image),viewports:entry.run.viewports});
  const record={...report,revision:entry.run.revision,capturedBy:name};entry.run.visualChecks.push(record);if(game)entry.run.gameChecks.push(record);await commit(entry);return report;
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
  if(own?.run.status==='running'&&event.type==='turn/end'&&event.data.reason.kind!=='completed'){pause(own).catch(()=>{});return;}
  for(const entry of entries.values()){
   if(entry.run.status!=='running')continue;
   const role=entry.run.roles.find(role=>role.sessionId===session.id);if(!role)continue;
   if(event.type==='turn/start')role.executionTurn=event.data.turn;
   const task=entry.run.tasks.find(task=>task.assignee===role.name&&task.state==='running');if(!task)continue;
   if(event.type==='user/message'&&Number.isInteger(role.executionTurn)&&event.data.content.some(part=>part.type==='text'&&part.text.includes(task.nonce)))task.executionTurn=role.executionTurn;
   if(event.type==='turn/end'&&task.executionTurn===event.data.turn){task.state='blocked';task.result={verdict:'blocked',summary:`Agent turn ended (${event.data.reason.kind}) without completing its assigned task. Inspect its chat and retry this task.`,findings:[],revision:entry.run.revision};commit(entry).catch(()=>{});}
  }
 });
 ctx.effect(()=>async()=>{for(const entry of entries.values())if(entry.run.status==='running')await pause(entry).catch(()=>{});});
}
