import {requiresWebVerification} from './project-qa.js';
export function needsPreview(run,task){return !!(requiresWebVerification(run)&&run.visualRequired&&run.preview?.url&&task.reviewFocus!=='source'&&['review','design-review','game-review','user-review'].includes(task.kind));}
export async function previewState(preview,jobs,owner,signal,fetcher=fetch,readOutput=false){
 if(!preview?.url||!preview.jobId)return {status:'not-running',ready:false};
 let job;try{job=jobs.get(preview.jobId,owner);}catch{return {url:preview.url,jobId:preview.jobId,status:'not-running',ready:false};}
 let ready=false;try{const response=await fetcher(preview.url,{signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(700)])});ready=response.status<500;await response.body?.cancel();}catch{signal?.throwIfAborted();}
 let output;
 if(readOutput&&!ready)try{output=jobs.read(preview.jobId,owner).chunks.filter(chunk=>chunk.channel!=='log').map(chunk=>chunk.text).join('').slice(-3000);}catch{}
 return {url:preview.url,jobId:preview.jobId,jobStatus:job.status,status:ready?'running':['running','stopping'].includes(job.status)?'starting':'failed',ready,...(output?{startupOutput:output}:{}),...(!ready?{next:'The HTTP preview is NOT ready. Inspect startupOutput or job_output for this exact job and fix the concrete startup error; do not claim restoration or duplicate a running job.'}:{})};
}
