import {createHash} from 'node:crypto';
const redact=value=>String(value??'').replace(/^Error:\s*/,'').replace(/\b(?:npm_[\w]+|github_pat_[\w]+|ghp_[\w]+|sk-[\w-]{12,})\b/g,'[redacted]').replace(/([?&](?:token|key|auth)=)[^\s&]+/gi,'$1[redacted]').slice(0,1400);
export function failureFamily(message){
 const raw=String(message??'').replace(/\u001b\[[0-9;]*m/g,''),primary=raw.split(/\r?\n/).find(line=>/^(?:Command failed \([^\n]+\):\s*)?(?:Error|TypeError|ReferenceError|RangeError|SyntaxError):\s*\S/.test(line));let text=redact(raw);
 // The primary named exception is stable; event dumps, stack positions and
 // generated report IDs are supporting evidence, retained in the actual log.
 if(primary)text=redact(primary).replace(/;\s*events=.+$/,'; events=[recorded]');
 return text.replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi,'[uuid]').replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{5}(?=[/\s"\\]|$)/gi,'http://loopback:[port]').replace(/"(?:port|pid|processId)"\s*:\s*\d+/g,'"runtime-id":[number]').replace(/:(\d+):(\d+)(?=[)\s]|$)/g,':[line]:[column]');
}
const familyId=item=>createHash('sha256').update(JSON.stringify([item.agent,item.taskId,item.tool,item.identity,failureFamily(item.message)])).digest('hex').slice(0,16);
function diagnosticFamilies(run,now){
 const groups=new Map(),since=now-600000;
 for(const item of run.diagnostics??[]){if(item.status!=='open'||item.lastAt<since)continue;const key=familyId(item),group=groups.get(key)??{id:key,agent:item.agent,taskId:item.taskId,tool:item.tool,message:failureFamily(item.message),count:0,alertLevel:0};
  group.count+=item.occurrences?.filter(at=>at>=since).length??(item.firstAt>=since?item.count:1);group.alertLevel=Math.max(group.alertLevel,item.alertLevel??0);groups.set(key,group);
 }return [...groups.values()];
}
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
 if(/BROWSER_TAB_NOT_FOUND|No top-level window matched/i.test(message))return 'Enumerate current windows/tabs with list_windows, then use its actual current window/tab ID. Do not guess or reuse a stale ID such as 1.';
 if(/\.svg extension.*supported image format|read_image accepts PNG/i.test(message))return 'This is SVG/vector source, not a supported raster image. Read its actual source with read, or inspect its real rendered appearance using browser capture and the resulting actual image. Do not invent a PNG path or image ID.';
 if(/strict mode violation/i.test(message))return 'The test locator is ambiguous. Inspect the current control outline and scope to the visible intended surface using an observed semantic target. Do not use force or an arbitrary first() to hide duplicate controls.';
 if(/Page.captureScreenshot|Unable to capture screenshot/i.test(message))return 'Capture failed; there is no new image to read or approve. Wait for actual visible app readiness and fonts, then retry a viewport capture once in the same page. Preserve failure output. Close only your own browser in finally; report a persistent capture failure to Lead. Never substitute a blank or invented screenshot.';
 if(/regex parse error|pattern rejected by ripgrep/i.test(message))return 'This is a search syntax error. Use fixed-string search for literal code, or escape regex metacharacters. Repeating the invalid pattern cannot produce evidence.';
 if(/ERR_CONNECTION_REFUSED/i.test(message))return 'The preview was unavailable for this attempt. Tell Lead the exact URL, verify readiness and retry only after the managed preview is running. A refused connection is not proof of a product UI defect or a passed test.';
 return null;
}
export function recordToolFailure(run,{agent,taskId,tool,identity,message},now=Date.now()){
 const safe=redact(message),event={agent,taskId,tool,identity,message:safe},key=familyId(event),id='error-'+key;
 run.diagnostics??=[];let item=run.diagnostics.find(d=>d.id===id||familyId(d)===key);
 if(item&&item.status==='open'&&now-item.lastAt<50)return {item,notify:false};
 if(item){if(item.status!=='open'||now-item.lastAt>600000){item.occurrences=[now];item.alertLevel=0;}else item.occurrences=[...(item.occurrences??[item.lastAt]),now].slice(-32);if(item.message!==safe)item.firstMessage??=item.message;item.message=safe;item.count++;item.lastAt=now;item.status='open';delete item.resolution;delete item.resolvedAt;}
 else{item={id,agent,taskId,tool,identity,message:safe,count:1,firstAt:now,lastAt:now,status:'open',occurrences:[now]};run.diagnostics.push(item);run.diagnostics=run.diagnostics.slice(-100);}
 const group=diagnosticFamilies(run,now).find(g=>g.id===key),level=group.count>=10?10:group.count>=3?3:1,notify=level>group.alertLevel;item.alertLevel=Math.max(group.alertLevel,level);
 return {item,notify};
}
export function recordToolSuccess(run,{agent,taskId,identity},now=Date.now()){
 let changed=false;for(const item of run.diagnostics??[])if(item.status==='open'&&item.agent===agent&&item.taskId===taskId&&item.identity===identity){item.status='resolved';item.resolvedAt=now;item.resolution='The same task operation subsequently succeeded.';changed=true;}return changed;
}
export function diagnosticStatus(run,now=Date.now()){
 const open=(run.diagnostics??[]).filter(d=>d.status==='open'),repeated=diagnosticFamilies(run,now).filter(g=>g.count>=3);
 return {open:open.length,repeated:repeated.length,repeatedFamilies:repeated.slice(0,6).map(({alertLevel,...group})=>({...group,message:group.message.slice(0,500)})),repeatedFamiliesTruncated:repeated.length>6,recent:[...open].sort((a,b)=>b.lastAt-a.lastAt).slice(0,6).map(({identity,occurrences,firstMessage,alertLevel,...item})=>item)};
}
export function checkFailureDetails(value){
 if(value.views?.some(v=>v.errors?.length))return value.views.map(v=>({viewport:v.viewport,errors:v.errors}));
 if(value.results){const failed=value.results.flatMap(r=>(r.cases??[]).filter(c=>c.passed!==true).map(c=>({analysis:r.id,case:c.name,actual:JSON.stringify(c.actual)?.slice(0,600),expected:JSON.stringify(c.expected)?.slice(0,600)})));if(failed.length)return {failedCases:failed.slice(0,6),failedCount:failed.length};}
 return value.errors??(value.views?.length?value.views.map(v=>({viewport:v.viewport,errors:v.errors})):'Check returned ok:false');
}
