// Human-owned, session-local routing. No model-facing setter and no worker wakeups.
export const emptyPolicy=()=>({schema:1,revision:0,defaults:{},overrides:{}});
const own=(value,key)=>Object.hasOwn(value,key);
const same=(a,b)=>a?.provider===b?.provider&&a?.model===b?.model&&a?.reasoningEffort===b?.reasoningEffort;
export function validateChoice(choice){
 if(!choice||typeof choice!=='object'||Array.isArray(choice))throw new Error('Invalid model choice');
 if(Object.keys(choice).some(key=>!['provider','model','reasoningEffort'].includes(key)))throw new Error('Unknown model setting');
 if(own(choice,'provider')!==own(choice,'model'))throw new Error('Provider and model must be selected together');
 for(const key of ['provider','model'])if(own(choice,key)&&(typeof choice[key]!=='string'||!choice[key]||choice[key].length>200))throw new Error(`Invalid ${key}`);
 if(own(choice,'reasoningEffort')&&choice.reasoningEffort!==null&&(typeof choice.reasoningEffort!=='string'||!choice.reasoningEffort||choice.reasoningEffort.length>80))throw new Error('Invalid reasoning effort');
 return {...choice};
}
export function validatePolicy(policy){
 if(policy?.schema!==1||!Number.isSafeInteger(policy.revision)||policy.revision<0||!policy.overrides||typeof policy.overrides!=='object'||Array.isArray(policy.overrides)||Object.keys(policy.overrides).length>64)throw new Error('Invalid routing policy');
 const overrides=Object.create(null);
 for(const [name,choice] of Object.entries(policy.overrides)){if(!name||name.length>100||['__proto__','constructor','prototype'].includes(name))throw new Error('Invalid agent name');overrides[name]=validateChoice(choice);}
 return {schema:1,revision:policy.revision,defaults:validateChoice(policy.defaults),overrides};
}
export function inheritSelection(base,defaults={},override={}){
 const route=override.model?override:defaults.model?defaults:base;
 const effort=own(override,'reasoningEffort')?override.reasoningEffort:own(defaults,'reasoningEffort')?defaults.reasoningEffort:base?.reasoningEffort;
 if(!route?.provider||!route.model)throw new Error('Coordinator model is not configured');
 return {provider:route.provider,model:route.model,...(effort==null?{}:{reasoningEffort:effort})};
}
export function providerFailureFor(run,task){const last=(run.diagnostics??[]).filter(d=>d.taskId===task.id&&d.agent===task.assignee&&d.tool==='agent-turn').sort((a,b)=>b.lastAt-a.lastAt)[0];return last&&/429|rate.?limit|quota|usage limit|overload|provider.{0,30}(?:configured|unavailable)|invalid.api.key|insufficient.credit/iu.test(last.message)?last:undefined;}
export async function readFailedSelection(controller,rootId,childId,at,signal){
 const projection=await controller.projections({sessionId:childId},signal);let throughSeq=projection.asOfSeq;
 for(let pageIndex=0;pageIndex<3;pageIndex++){
  const page=await controller.page({address:{kind:'subagent',parentSessionId:rootId,childSessionId:childId,mode:'continuable'},throughSeq,maxMessages:40},signal),events=page.records.map(r=>r.event);
  const header=events.filter(e=>e.type==='request/header'&&e.time<=at).at(-1)?.data.header.config;
  if(header?.provider&&header.model)return {provider:header.provider,model:header.model,...(header.reasoningEffort?{reasoningEffort:header.reasoningEffort}:{})};
  if(!page.hasMore||!events.length)break;throughSeq=Math.min(...events.map(e=>e.seq))-1;
 }
 return null;
}
export function providerRecoveryCandidates(run,policy,base,lastUsed){
 if(run.status!=='running'||!run.goal?.autonomous||run.goal?.handoff)return [];
 return run.tasks.filter(task=>{
  if(task.state!=='blocked'||task.modelRecovery?.revision===policy.revision||!/^Agent turn ended \(error\)/.test(task.result?.summary??''))return false;
  if(!providerFailureFor(run,task))return false;
  const before=task.failedModel??lastUsed(task.assignee,task),after=inheritSelection(base,policy.defaults,policy.overrides[task.assignee]);
  return !!before?.provider&&!!before.model&&(before.provider!==after.provider||before.model!==after.model);
 });
}
export function foldRouting(state,event){
 if(event.type==='command/run'&&event.data.name==='gvs-models'){
  let request;try{request=JSON.parse(event.data.args??'{}');}catch{return state;}
  if(request.action!=='set')return state;
  return {...state,calls:{...state.calls,[event.data.commandId]:request}};
 }
 if(event.type!=='command/done'||!state.calls[event.data.commandId])return state;
 const calls={...state.calls};delete calls[event.data.commandId];let policy=state.policy;
 try{
  const request=state.calls[event.data.commandId];
  if(event.data.kind==='success'&&request.revision===policy.revision){
   const choice=validateChoice(request.choice);
   policy=validatePolicy({...policy,revision:policy.revision+1,defaults:request.target==='team'?choice:policy.defaults,overrides:request.target==='team'?policy.overrides:{...policy.overrides,[request.target]:choice}});
  }
 }catch{}
 return {calls,policy};
}

export class ModelRouting {
 constructor(api){this.api=api;this.policies=new Map();this.workers=new Map();this.queues=new Map();}
 policy(root){const saved=this.api.saved(root),cached=this.policies.get(root.id);const policy=saved&&(!cached||saved.revision>cached.revision)?validatePolicy(saved):cached??emptyPolicy();this.policies.set(root.id,policy);return policy;}
 attach(agent){
  const owner=this.api.owner(agent);if(!owner)return;
  if(this.workers.get(agent.id)?.agent===agent)return this.workers.get(agent.id);
  this.detach(agent.id);const ref={current:undefined,assembled:undefined};
  const worker={agent,...owner,ref,dispose:this.api.install(agent.ctx,ref)};this.workers.set(agent.id,worker);return worker;
 }
 detach(id,agent){const worker=this.workers.get(id);if(worker&&(!agent||worker.agent===agent)){worker.dispose();this.workers.delete(id);}}
 async resolve(root,name,policy,catalog){
  if(!catalog){this.catalogPromise??=this.api.catalog().finally(()=>{this.catalogPromise=null;});catalog=await this.catalogPromise;this.catalog=catalog;}
  const base=this.api.coordinator(root),choice=policy.overrides[name]??{},selected=inheritSelection(base,policy.defaults,choice);
  let warning;
  const model=catalog?.groups.find(group=>group.id===selected.provider)?.models.find(model=>model.id===selected.model);
  if(selected.reasoningEffort&&model&&!model.reasoning?.efforts?.some(item=>item.id===selected.reasoningEffort)){
   warning=`${selected.reasoningEffort} is unavailable for ${selected.model}; using the model default`;
   delete selected.reasoningEffort;
  }
  const value=await this.api.normalize(selected);
  return {effective:{provider:value.provider,model:value.model,...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})},...(warning?{warning}:{})};
 }
 install(worker,result){
  worker.error=undefined;worker.warning=result.warning;
  if(!same(worker.ref.current,result.effective)){worker.agent.session.append('model/selection',result.effective);worker.ref.current=result.effective;}
 }
 async prepare(agent){
  const worker=this.attach(agent);if(!worker)return;
  // Retry if a human changes policy/coordinator while normalization is in flight.
  for(let attempt=0;attempt<8;attempt++){
   const policy=this.policy(worker.root),base=this.api.coordinator(worker.root);
   const result=await this.resolve(worker.root,worker.name,policy,this.catalog);
   if(this.workers.get(agent.id)!==worker)return;
   if(this.policy(worker.root).revision!==policy.revision||!same(base,this.api.coordinator(worker.root)))continue;
   this.install(worker,result);return;
  }
  throw new Error('Model settings changed repeatedly; retry this request');
 }
 async status(root){
  const policy=this.policy(root),agents=[];
  for(const member of this.api.members(root)){
   if(member.role==='lead')continue;
   const live=this.workers.get(member.id);let routing;
   try{routing=await this.resolve(root,member.name,policy,this.catalog);}catch(error){routing={error:error.message};}
   agents.push({name:member.name,sessionId:member.id,...routing,lastUsed:live?this.api.lastUsed(live.agent):null});
  }
  return {type:'gvs-model-routing',sessionId:root.id,policy,coordinator:this.api.coordinator(root),agents};
 }
 async refreshMembers(root){
  for(const member of this.api.members(root)){
   if(member.role==='lead')continue;
   try{const agent=this.workers.get(member.id)?.agent??await this.api.load?.(member.id);if(agent)await this.prepare(agent);}catch(error){const worker=this.workers.get(member.id);if(worker)worker.error=error.message;}
  }
 }
 async set(root,request){
  // Revision fencing makes edits from two open browsers explicit instead of losing one.
  const previous=this.queues.get(root.id)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
   const policy=this.policy(root);
   if(request.revision!==policy.revision)throw new Error('Settings changed in another window. Refresh and try again.');
   if(request.target!=='team'&&!this.api.members(root).some(member=>member.role!=='lead'&&member.name===request.target))throw new Error('Agent is no longer in this team');
   const choice=validateChoice(request.choice),catalog=await this.api.catalog();this.catalog=catalog;
   const candidate=validatePolicy({...policy,revision:policy.revision+1,defaults:request.target==='team'?choice:policy.defaults,overrides:request.target==='team'?policy.overrides:{...policy.overrides,[request.target]:choice}});
   if(choice.model&&!catalog.groups.some(group=>group.id===choice.provider&&group.models.some(model=>model.id===choice.model)))throw new Error('Selected model is unavailable');
   const effective=inheritSelection(this.api.coordinator(root),candidate.defaults,request.target==='team'?{}:choice);
   const model=catalog.groups.find(group=>group.id===effective.provider)?.models.find(model=>model.id===effective.model);
   if(choice.reasoningEffort&&!model?.reasoning?.efforts?.some(item=>item.id===choice.reasoningEffort))throw new Error('Selected reasoning effort is unavailable for this model');
   // Resolve before committing; a broken provider cannot overwrite saved preferences.
   await this.resolve(root,request.target==='team'?'':request.target,candidate,catalog);
   this.policies.set(root.id,candidate);
   await this.refreshMembers(root);
   return this.status(root);
  });
  this.queues.set(root.id,operation);try{return await operation;}finally{if(this.queues.get(root.id)===operation)this.queues.delete(root.id);}
 }
 dispose(){for(const id of this.workers.keys())this.detach(id);}
}
