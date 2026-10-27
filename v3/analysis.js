import {createHash} from 'node:crypto';
export const MAX_ANALYSIS_STDOUT_BYTES=8*1024*1024;
export async function decodeAnalysisOutput(result,readSpill){
 try{return decodeAnalysisRunner(result);}catch(original){
  const output=result.value?.stdout;
  if(result.value?.kind!=='foreground'||!output?.truncated)throw original;
  if(!output.spillPath)throw new Error(`${original.message}\nStdout was truncated and its complete spill file is unavailable. Emit a bounded final report; do not infer success from the retained tail.`);
  try{
   const bytes=await readSpill(output.spillPath,MAX_ANALYSIS_STDOUT_BYTES);
   if(bytes.length>MAX_ANALYSIS_STDOUT_BYTES)throw new Error('Complete stdout exceeds the 8 MiB ingestion budget; keep full diagnostics in artifacts and emit a compact final report.');
   const stdout=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   return {...decodeAnalysisRunner(result,stdout),outputSource:{kind:'native-stdout-spill',path:output.spillPath,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
  }catch(error){throw new Error(`${original.message}\nComplete stdout recovery failed: ${error.message}\nNo analysis evidence accepted.`);}
 }
}
export function decodeAnalysisRunner(result,stdout=result.value?.stdout?.text??''){
 const value=result.value,stderr=value?.stderr?.text??'';
 const detail=(stderr||stdout||result.content?.filter(part=>part.type==='text').map(part=>part.text).join('\n')||'No process output.').slice(-3000);
 if(value?.kind!=='foreground')throw new Error(`Analysis must finish in foreground.${result.isError?' Execution failed: '+detail:''}`);
 const ok=!result.isError&&value.exitCode===0&&!value.timedOut&&!value.aborted&&value.signal==null;
 const status=`exit ${value.exitCode??'unknown'}${value.timedOut?', timed out':''}${value.aborted?', aborted':''}${value.signal?', signal '+value.signal:''}`;
 const marker='GVS_ANALYSIS_RESULT:',offset=stdout.lastIndexOf(marker);
 if(offset<0)throw new Error(`Analysis runner ${ok?'finished without its required report':'failed'} (${status}).\n${detail}\nNo analysis evidence accepted. Runner must print final GVS_ANALYSIS_RESULT: followed by gvs.analysis/1 JSON. Inspect the actual failed assertion/runtime cause; do not fabricate a success report or weaken the test.`);
 let raw;try{raw=JSON.parse(stdout.slice(offset+marker.length).trim());}catch(error){throw new Error(`Malformed final GVS_ANALYSIS_RESULT JSON (${status}): ${error.message}\n${detail}\nNo analysis evidence accepted.`);}
 return {raw,ok};
}
export function motionHint(task){return /плавн|рывк|ступенчат|параллакс|анимац|д[её]рг|дискретн|фриз|smooth|stutter|jitter|animation|chopp|jerk|frame.?pacing/i.test(task);}
export function analysisPlan(input,hint=false){
 if(!input.rationale?.trim()||!Array.isArray(input.requirements)||input.requirements.length>6)throw new Error('Explain which task-specific analyses are needed; use [] with a reason for a simple task.');
 const ids=new Set();
 for(const item of input.requirements){
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(item.id)||ids.has(item.id)||!item.criterion?.trim()||!item.reason?.trim()||!['runtime','rendered-sequence'].includes(item.method))throw new Error('Each analysis needs a unique id, concrete criterion, reason and runtime/rendered-sequence method.');
  if(item.id==='motion'&&item.method!=='rendered-sequence')throw new Error('Motion acceptance requires a rendered sequence, not transform-only measurements.');
  ids.add(item.id);
 }
 if(hint&&!ids.has('motion')&&!input.notRequiredReason?.trim())throw new Error('The human request mentions visible smoothness. Require motion, or explain specifically why this is only a static/text change.');
 return {state:'ready',rationale:input.rationale,requirements:input.requirements,notRequiredReason:input.notRequiredReason??''};
}
export function parseAnalysisReport(raw,plan,viewports){
 if(raw?.schema!=='gvs.analysis/1'||!raw.engine?.trim()||!raw.analyzer?.trim()||!Array.isArray(raw.results)||!raw.results.length)throw new Error('Expected a real gvs.analysis/1 runner report with engine, analyzer and results.');
 if(raw.results.length>6||raw.results.reduce((count,result)=>count+(result.frames?.length??0),0)>120)throw new Error('Keep one analysis report to six results and 120 captured frames.');
 const ids=new Set();
 for(const result of raw.results){
  const requirement=plan.requirements.find(item=>item.id===result.id);
  if(!requirement||ids.has(result.id)||!Array.isArray(result.cases)||!result.cases.length)throw new Error('Report each planned analysis once with measured cases.');
  ids.add(result.id);
  for(const item of result.cases)if(!item.name?.trim()||!['runtime','rendered-pixels','frame-timing'].includes(item.source)||typeof item.passed!=='boolean'||item.actual===undefined||item.expected===undefined)throw new Error('Analysis cases need a source, passed, actual and expected; counters alone are insufficient.');
  if(requirement.method==='rendered-sequence'){
   if(!result.cases.some(item=>item.source==='rendered-pixels')||!result.cases.some(item=>item.source==='frame-timing'))throw new Error('Temporal analysis needs BOTH rendered-pixel and frame-timing measurements. Numeric transforms alone cannot prove visible smoothness.');
   if(!Array.isArray(result.frames)||result.frames.length>120)throw new Error('Provide 8–120 actual captured frames with timestamps.');
   for(const viewport of viewports){
    const frames=result.frames.filter(frame=>frame.viewport===viewport);
    if(frames.length<8||frames.some((frame,i)=>!frame.path?.trim()||!Number.isFinite(frame.atMs)||frame.atMs<0||i&&frame.atMs<=frames[i-1].atMs)||frames.at(-1).atMs-frames[0].atMs<1000)throw new Error(`Temporal evidence needs at least 8 ordered ${viewport} frames spanning one second.`);
    const samples=(result.samples??[]).filter(sample=>sample.viewport===viewport);
    if(samples.length<30||samples.length>1200||samples.some((sample,i)=>!Number.isFinite(sample.atMs)||!Number.isFinite(sample.renderedPixelMetric)||!Number.isFinite(sample.frameTimeMs)||sample.frameTimeMs<=0||i&&sample.atMs<=samples[i-1].atMs)||samples.at(-1).atMs-samples[0].atMs<1000)throw new Error(`Temporal analysis needs 30+ ordered ${viewport} pixel/timing samples over one second, not transform-only coordinates.`);
    if(new Set(samples.map(sample=>sample.renderedPixelMetric)).size<2)throw new Error('The rendered-pixel metric never changes; visible motion is not demonstrated.');
   }
  }
 }
 return {engine:raw.engine,analyzer:raw.analyzer,results:raw.results,ok:raw.results.every(result=>result.cases.every(item=>item.passed))};
}
export function analysisReportReviewStatus(run,id,reviewer,{historical=false}={}){
 const report=(run.analysisChecks??[]).find(r=>r.id===id),reasons=[];
 if(!report)reasons.push('unknown-report');
 else{
  if(report.ok!==true)reasons.push('failed-report');
  if(!report.capturedBy||!Number.isInteger(report.revision)||!Number.isInteger(report.planVersion))reasons.push('missing-provenance');
  if(report.capturedBy===reviewer)reasons.push('same-capture-agent');
  if(!historical&&report.revision!==run.revision)reasons.push('stale-source-revision');
  if(!historical&&report.planVersion!==run.analysis?.version)reasons.push('stale-analysis-plan');
 }
 return {id,reviewable:reasons.length===0,historicalOnly:historical,reasons,capturedBy:report?.capturedBy??null,reportRevision:report?.revision??null,currentRevision:run.revision,reportPlanVersion:report?.planVersion??null,currentPlanVersion:run.analysis?.version??null};
}

export function acceptedAnalyses(run){
 if(!run.analysis)return [];
 return (run.analysisChecks??[]).filter(report=>report.ok&&report.revision===run.revision&&report.planVersion===run.analysis.version&&run.tasks.some(task=>task.kind==='review'&&task.state==='done'&&task.assignee!==report.capturedBy&&task.result?.verdict==='pass'&&task.result.revision===run.revision&&task.result.adapterReviewed===true&&task.result.analysisReports?.includes(report.id)));
}
export function analysisReady(run){
 if(!run.analysis)return true; // Historical v2.0 transcripts retain their original contract.
 if(run.analysis.state!=='ready')return false;
 const accepted=acceptedAnalyses(run);
 return run.analysis.requirements.every(requirement=>accepted.some(report=>report.results.some(result=>result.id===requirement.id)));
}
export function analysisAcceptance(run,task){
 if(!run.analysis)return true;
 if(!analysisReady(run)||task?.result?.analysisVersion!==run.analysis.version)return false;
 return run.analysis.requirements.every(requirement=>acceptedAnalyses(run).some(report=>report.results.some(result=>result.id===requirement.id)&&(task.receivedAnalysisReports??[]).includes(report.id)&&(task.result.analysisReports??[]).includes(report.id)));
}
