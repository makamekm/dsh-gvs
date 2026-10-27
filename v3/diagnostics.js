import {createHash} from 'node:crypto';
const redact=value=>String(value??'').replace(/^Error:\s*/,'').replace(/\b(?:npm_[\w]+|github_pat_[\w]+|ghp_[\w]+|sk-[\w-]{12,})\b/g,'[redacted]').replace(/([?&](?:token|key|auth)=)[^\s&]+/gi,'$1[redacted]').slice(0,1400);
export function toolIdentity(exec){return createHash('sha256').update(JSON.stringify([exec.name,exec.arguments?.action??'',exec.arguments?.file_path??exec.arguments?.path??'',exec.arguments?.command??'',exec.arguments?.scenarioId??exec.arguments?.scenario??''])).digest('hex');}
export function recordToolFailure(run,{agent,taskId,tool,identity,message},now=Date.now()){
 const safe=redact(message),id='error-'+createHash('sha256').update(JSON.stringify([agent,taskId,tool,identity,safe])).digest('hex').slice(0,16);
 run.diagnostics??=[];let item=run.diagnostics.find(d=>d.id===id);
 if(item&&now-item.lastAt<50)return {item,notify:false};
 if(item){item.count++;item.lastAt=now;item.status='open';delete item.resolution;}
 else{item={id,agent,taskId,tool,identity,message:safe,count:1,firstAt:now,lastAt:now,status:'open'};run.diagnostics.push(item);run.diagnostics=run.diagnostics.slice(-100);}
 return {item,notify:[1,3,10].includes(item.count)};
}
export function recordToolSuccess(run,{agent,taskId,identity},now=Date.now()){
 let changed=false;for(const item of run.diagnostics??[])if(item.status==='open'&&item.agent===agent&&item.taskId===taskId&&item.identity===identity){item.status='resolved';item.resolvedAt=now;item.resolution='The same task operation subsequently succeeded.';changed=true;}return changed;
}
export function diagnosticStatus(run,now=Date.now()){
 const open=(run.diagnostics??[]).filter(d=>d.status==='open'),repeated=open.filter(d=>d.count>=3&&now-d.lastAt<600000);
 return {open:open.length,repeated:repeated.length,recent:[...open].sort((a,b)=>b.lastAt-a.lastAt).slice(0,6).map(({identity,...item})=>item)};
}
