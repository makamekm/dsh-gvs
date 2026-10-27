import {requiresWebVerification} from './project-qa.js';
export function needsPreview(run,task){return !!(requiresWebVerification(run)&&run.visualRequired&&run.preview?.url&&task.reviewFocus!=='source'&&['review','design-review','game-review','user-review'].includes(task.kind));}
export function previewRestoreRecipe(run){
 const recipe=run.previewRestore;if(!recipe?.enabled||recipe.disabledByStop||recipe.runId!==run.runId||typeof recipe.command!=='string'||!recipe.command.trim()||recipe.command.length>4000||!Number.isInteger(recipe.port)||recipe.port<1024||recipe.port>65535)return null;
 try{const url=new URL(run.preview?.url),saved=new URL(recipe.url);if(url.protocol!=='http:'||url.href!==saved.href||url.port!==String(recipe.port))return null;}catch{return null;}
 return {command:recipe.command,port:recipe.port};
}
// Uses only a successfully started, owned preview recipe from this exact run.
// Observing a port or an old ready flag never authorizes a guessed command.
export async function restoreManagedPreview(run,{observe,start,signal}){
 signal?.throwIfAborted();if(run.status!=='running')return {status:'run-stopped',ready:false};
 if(!run.preview)return {status:'not-configured',ready:false};
 const observed=await observe();signal?.throwIfAborted();if(run.status!=='running')return {status:'run-stopped',ready:false};run.preview.ready=observed.ready===true;
 if(observed.ready)return {...observed,status:'already-ready'};
 if(['running','stopping'].includes(observed.jobStatus))return {...observed,next:'The existing owned job is still active. Inspect its actual startup output; do not duplicate it.'};
 const recipe=previewRestoreRecipe(run);if(!recipe)return {status:'needs-coordinator',ready:false,next:'No successful enabled preview recipe matches this run and URL. Coordinator must inspect the actual existing startup command; never guess it.'};
 try{const result=await start(recipe);signal?.throwIfAborted();if(run.status!=='running')return {status:'run-stopped',ready:false};run.preview.ready=result.ready===true;return {...result,restored:result.ready===true};}
 catch(error){signal?.throwIfAborted();return {status:run.status==='running'?'restore-failed':'run-stopped',ready:false,next:'Automatic preview restoration failed. Inspect the original startup tool error and gvs_preview status; dependent runtime tasks must keep waiting.'};}
}
export async function previewState(preview,jobs,owner,signal,fetcher=fetch,readOutput=false){
 if(!preview?.url||!preview.jobId)return {status:'not-running',ready:false};
 let job;try{job=jobs.get(preview.jobId,owner);}catch{return {url:preview.url,jobId:preview.jobId,status:'not-running',ready:false};}
 let ready=false;try{const response=await fetcher(preview.url,{signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(700)])});ready=response.status<500;await response.body?.cancel();}catch{signal?.throwIfAborted();}
 let output;
 if(readOutput&&!ready)try{output=jobs.read(preview.jobId,owner).chunks.filter(chunk=>chunk.channel!=='log').map(chunk=>chunk.text).join('').slice(-3000);}catch{}
 return {url:preview.url,jobId:preview.jobId,jobStatus:job.status,status:ready?'running':['running','stopping'].includes(job.status)?'starting':'failed',ready,...(output?{startupOutput:output}:{}),...(!ready?{next:'The HTTP preview is NOT ready. Inspect startupOutput or job_output for this exact job and fix the concrete startup error; do not claim restoration or duplicate a running job.'}:{})};
}
