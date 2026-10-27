import {randomUUID} from 'node:crypto';
import {recoverGoals} from './recovery.js';
export const inject=['sessionPersistence','sessionController','fs'];
export function apply(ctx,config={}){
 ctx.effect(()=>{
  const controller=new AbortController();
  void recoverGoals(ctx,config,controller.signal).then(async result=>{
   if(controller.signal.aborted)return;
   for(const agent of [...result.resumed,...result.maintenance]){
    const maintenance=result.maintenance.includes(agent);
    if(!maintenance){
     const restored=await agent.ctx.tools.execute({callId:randomUUID(),agent,signal:controller.signal,name:'gvs_recover',arguments:{}});
     if(restored.isError){console.warn('GVS assignment recovery failed:',agent.id);continue;}
     if(!restored.value?.continued)continue;
     console.info('GVS assignment recovery:',JSON.stringify({sessionId:agent.id,recovered:restored.value.recovered}));
    }
    if(controller.signal.aborted)return;
    const note=config.resumeNotes?.[agent.id]??'';
    // steer also wakes an idle driver and avoids a cold-start race with teammate messages.
    for(const queued of agent.inbox?.nextTurn??[])if(queued.source?.kind==='gvs-coordinator-continuation')agent.inbox.remove(queued.id);
    agent.steer({id:randomUUID(),role:'user',source:{kind:'gvs-coordinator-continuation',form:'notice',summary:maintenance?'Restore the active goal interrupted by the authorized upgrade':'Restore the unfinished human goal after restart'},content:[{type:'text',text:`${maintenance?'The authorized GVS upgrade interrupted this previously running run. Its runId and exact pause timestamp match the maintenance record; this was not a human pause. Call gvs_resume.':'Harness restarted with this goal still active. Service-interrupted assignments were restored automatically by gvs_recover. Do not retry running tasks or create a new run.'} Preserve the SAME agents, tasks and completed work. A role whose registration failed can be repaired with gvs_agent wake using its existing name; the native description limit is now handled without dropping its detailed purpose/instructions. Do not create replacement identities for the same failed registration. Read gvs_goal status and paginate gvs_task list. If goal tracking was added by this upgrade, assign the same User a consultation to map all real humanMessages into immutable requirements and infer expertise/staffingRationale. Create/reuse suitable specialists yourself, assign real discovery/implementation/review tasks and link them to requirements and issues. Restore the project preview if interrupted. Every required mismatch and missing function needs repair plus independent recheck. Reviews explicitly attest coveredRequirements/scopeReviewed and addressedIssues. DELIVERY POLICY: source inventories and decisions already exist; do not reopen readiness/ownership audit loops. Scope each editing task to a runnable increment with a real build/render checkpoint; use gvs_task update to bound an active/queued task while keeping all remaining work in actual follow-ups. Use gvs_goal link links:[...] for batches and gvs_task list taskId for exact instructions instead of repeated shell reads of state. Reuse current User decisions via gvs_ask_user reuseTaskId; one old decision may need refreshing once for the current contract, not a chain of repeated approvals. Check progress.needsIntervention and act, never substitute waiting for delivery. Continue until gvs_finish returns verified; only an evidenced external dependency after all actionable work is exhausted permits a handoff.\n${note}`}]});
   }
   console.info('GVS recovery:',JSON.stringify({resumed:result.resumed.length,maintenance:result.maintenance.length,errors:result.errors}));
  }).catch(error=>{if(!controller.signal.aborted)console.warn('GVS recovery failed:',error.code??'unknown');});
  return()=>controller.abort();
 });
}
