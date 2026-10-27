import {createHash} from 'node:crypto';
const redact=value=>String(value??'').replace(/^Error:\s*/,'').replace(/\b(?:npm_[\w]+|github_pat_[\w]+|ghp_[\w]+|sk-[\w-]{12,})\b/g,'[redacted]').replace(/([?&](?:token|key|auth)=)[^\s&]+/gi,'$1[redacted]').slice(0,1400);
export function toolIdentity(exec){return createHash('sha256').update(JSON.stringify([exec.name,exec.arguments?.action??'',exec.arguments?.file_path??exec.arguments?.path??'',exec.arguments?.command??'',exec.arguments?.scenarioId??exec.arguments?.scenario??''])).digest('hex');}
export function toolFailureMessage(result){
 if(result.isError)return result.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')||result.error?.message||'Tool execution failed';
 const value=result.value;
 if(value?.kind!=='foreground'||value.exitCode===0&&!value.timedOut&&!value.aborted&&value.signal==null)return null;
 const output=[value.stderr?.text,value.stdout?.text].filter(text=>text?.trim()).join('\n')||result.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')||'No process output was captured.';
 return `Command failed (exit ${value.exitCode??'unknown'}${value.timedOut?', timed out':''}${value.aborted?', aborted':''}${value.signal?', signal '+value.signal:''}): ${output}`;
}
export function recoveryAdvice(message){
 if(/old_string was not found/i.test(message))return 'Re-read the exact affected lines and copy literal source including leading spaces and newlines. Use a short UNIQUE anchor that actually exists; do not repeat the same failed replacement or assume the file changed. Never rewrite an unread file or bypass the coordinator plan.';
 if(/old_string and new_string must differ/i.test(message))return 'The replacement is a no-op. Inspect current source; if the required change already exists, validate it instead of editing. Otherwise supply a genuinely different replacement.';
 if(/BROWSER_TAB_NOT_FOUND/i.test(message))return 'Enumerate current windows/tabs with list_windows, then use its actual current tab ID. Do not guess or reuse a stale ID such as 1.';
 if(/strict mode violation/i.test(message))return 'The test locator is ambiguous. Inspect the current control outline and scope to the visible intended surface using an observed semantic target. Do not use force or an arbitrary first() to hide duplicate controls.';
 if(/Page.captureScreenshot|Unable to capture screenshot/i.test(message))return 'Capture failed; there is no new image to read or approve. Wait for actual visible app readiness and fonts, then retry a viewport capture once in the same page. Preserve failure output. Close only your own browser in finally; report a persistent capture failure to Lead. Never substitute a blank or invented screenshot.';
 if(/regex parse error|pattern rejected by ripgrep/i.test(message))return 'This is a search syntax error. Use fixed-string search for literal code, or escape regex metacharacters. Repeating the invalid pattern cannot produce evidence.';
 if(/ERR_CONNECTION_REFUSED/i.test(message))return 'The preview was unavailable for this attempt. Tell Lead the exact URL, verify readiness and retry only after the managed preview is running. A refused connection is not proof of a product UI defect or a passed test.';
 return null;
}
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
