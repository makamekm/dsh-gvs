import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ModelRouting,emptyPolicy,foldRouting} from './models.js';

export const inject=['commands','agents','agentTeams','sessionController','llm','sessionProjections'];
export async function apply(ctx,config={}){
 // Resolve the SDK owned by the running Harness; do not load another Agent runtime.
 const candidates=[config.hostRoot&&path.join(config.hostRoot,'package.json'),process.argv[1],import.meta.url].filter(Boolean);
 let sdk,z,lastError;
 for(const entry of candidates){try{const require=createRequire(entry);sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')).href);({z}=require('zod'));break;}catch(error){lastError=error;}}
 if(!sdk?.installModelSelection||!z)throw new Error(`GVS model routing requires the Harness Agent SDK: ${lastError?.message??'missing export'}`);
 const choice=z.object({provider:z.string().optional(),model:z.string().optional(),reasoningEffort:z.string().nullable().optional()});
 const policy=z.object({schema:z.literal(1),revision:z.number().int().nonnegative(),defaults:choice,overrides:z.record(z.string(),choice)});
 ctx.sessionProjections.register({key:'gvsModelRouting',stateVersion:2,stateSchema:z.object({calls:z.record(z.string(),z.unknown()),policy}),init:()=>({calls:{},policy:emptyPolicy()}),apply:foldRouting,wire:{viewSchema:policy,view:state=>state.policy}});
 const isRoot=agent=>agent?.session.header.agentPreset==='gvs-local'&&agent.session.header.origin!=='subagent';
 const coordinator=root=>{const state=ctx.sessionProjections.stateOf(root.session,'modelSelection');return state?.pending??state?.next??state?.lastUsed??root.session.requestHeader()?.config??root.options;};
 const manager=new ModelRouting({
  saved:root=>ctx.sessionProjections.stateOf(root.session,'gvsModelRouting')?.policy,
  coordinator,catalog:()=>ctx.sessionController.modelCatalog(),normalize:selection=>ctx.llm.resolveCallConfig(selection),
  owner(agent){
   let current=agent;
   for(let depth=0;current&&depth<16;depth++){
    const member=ctx.agentTeams.tryMembership(current);
    if(member?.role==='teammate'&&isRoot(member.root))return {root:member.root,name:member.name};
    current=current.session.header.parentSession?ctx.agents.get(current.session.header.parentSession):undefined;
   }
  },
  members:root=>ctx.agentTeams.listMembers(root),install:sdk.installModelSelection,
  load:async id=>ctx.agents.get(id),
  lastUsed:agent=>ctx.sessionProjections.stateOf(agent.session,'modelSelection')?.lastUsed??null
 });
 const pendingChanges=new Map();
 ctx.on('session/event',(session,event)=>{
  if(event.type==='command/run'&&event.data.name==='gvs-models'){
   try{const request=JSON.parse(event.data.args??'{}');if(request.action==='set')pendingChanges.set(event.data.commandId,{sessionId:session.id,revision:request.revision+1});}catch{}
  }
  const change=pendingChanges.get(event.data.commandId);
  if(event.type!=='command/done'||change?.sessionId!==session.id)return;
  pendingChanges.delete(event.data.commandId);if(event.data.kind!=='success')return;
  const root=ctx.agents.get(session.id);if(!isRoot(root))return;
  void (async()=>{
   for(let attempt=0;attempt<20&&(ctx.sessionProjections.stateOf(root.session,'gvsModelRouting')?.policy.revision??-1)<change.revision;attempt++)await new Promise(resolve=>setTimeout(resolve,25));
   if((ctx.sessionProjections.stateOf(root.session,'gvsModelRouting')?.policy.revision??-1)<change.revision)throw new Error('Model routing projection is not committed');
   const restored=await root.ctx.tools.execute({callId:randomUUID(),agent:root,signal:AbortSignal.timeout(120000),name:'gvs_recover',arguments:{reason:'model-change'}});
   if(restored.isError||!restored.value?.continued)return;
   root.steer({id:randomUUID(),role:'user',source:{kind:'gvs-model-routing',form:'notice',summary:'Human changed teammate model settings'},content:[{type:'text',text:`The human updated GVS teammate model settings. Provider-blocked tasks whose effective route changed were requeued: ${JSON.stringify(restored.value.recovered??[])}. Preserve the same run, roles, source plans and all requirements. Continue current assignments; do not create duplicates or retry unchanged quota-blocked providers. Inspect gvs_status and stale plans for exact current work. Human per-role overrides and pauses remain binding.`}]});
  })().catch(()=>console.warn('GVS model-change recovery failed:',session.id));
 });
 ctx.commands.register({name:'gvs-models',description:'Model and reasoning settings for GVS teammates (human only).',input:{hint:'JSON: status or set'},async handler({agent,rawInput}){
  try{
   if(!isRoot(agent))throw new Error('Open the main GVS conversation to change team models');
   const request=JSON.parse(rawInput.trim()||'{"action":"status"}');
   if(!['status','set'].includes(request.action))throw new Error('Unknown action');
   const value=request.action==='set'?await manager.set(agent,request):await manager.status(agent);
   return {kind:'success',text:request.action==='set'?'GVS: настройки моделей сохранены. Применятся со следующего запроса.':JSON.stringify(value)};
  }catch(error){return {kind:'error',text:error.message};}
 }});
 ctx.on('agent/created',async({agent})=>{manager.attach(agent);});
 ctx.on('agent/disposed',({agent})=>manager.detach(agent.id,agent));
 // This runs before the scoped SDK hook captures the selection for one model step.
 ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{await manager.prepare(context.agent);return next();},{prepend:true});
 for(const agent of ctx.agents.list())manager.attach(agent);
 ctx.effect(()=>()=>manager.dispose());
}
