import path from 'node:path';
export async function recoverGoals(ctx,config={},signal){
 const resumed=[],maintenance=[],errors=[];
 for(const item of await ctx.sessionPersistence.list({signal})){
  signal?.throwIfAborted();const header=item.header;
  if(header.agentPreset!=='gvs-local'||header.origin==='subagent'||!header.cwd)continue;
  try{
   const target=await ctx.fs.resolve(path.join(header.cwd,'.gvs',`team-${header.id}.json`),{cwd:header.cwd,signal});
   const run=JSON.parse(await ctx.fs.readText(target,signal));
   const restore=run.status==='paused'&&config.restorePaused?.some(item=>item.sessionId===header.id&&item.runId===run.runId&&item.updatedAt===run.updatedAt);
   if(run.sessionId!==header.id||run.status!=='running'&&!restore||run.goal?.handoff||!(restore||run.goal?.autonomous||config.recoverSessions?.includes(header.id)))continue;
   const result=await ctx.sessionController.resolveAgent(header.id);
   if(result.agent)(restore?maintenance:resumed).push(result.agent);else errors.push({sessionId:header.id,code:result.error?.code??'resume-failed'});
  }catch(error){
   signal?.throwIfAborted();if(!['ENOENT','FS_NOT_FOUND'].includes(error.code))errors.push({sessionId:header.id,code:error.code??'recovery-read-failed'});
  }
 }
 return {resumed,maintenance,errors};
}
