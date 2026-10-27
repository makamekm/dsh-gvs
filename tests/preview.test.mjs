import test from 'node:test';import assert from 'node:assert/strict';import {previewState,previewRestoreRecipe,restoreManagedPreview} from '../v3/preview.js';
const running=()=>({status:'running',runId:'same-run',preview:{url:'http://127.0.0.1:5173/',jobId:'lost-job',ready:true},previewRestore:{runId:'same-run',url:'http://127.0.0.1:5173/',port:5173,command:'original authorized startup',enabled:true}});

test('recovery starts only the successful saved recipe matching the exact run and preview, after actually observing the lost job',async()=>{
 const run=running(),order=[];const result=await restoreManagedPreview(run,{observe:async()=>{order.push('observe');return {status:'not-running',ready:false};},start:async recipe=>{order.push('start');assert.deepEqual(recipe,{command:'original authorized startup',port:5173});assert.equal(run.preview.ready,false);return {status:'running',ready:true,jobId:'new-owned-job'};}});assert.deepEqual(order,['observe','start']);assert.equal(result.restored,true);assert.equal(run.preview.ready,true);
});
test('a healthy or still-starting owned preview is never duplicated, and a stale ready flag is not evidence',async()=>{
 const run=running();const up=await restoreManagedPreview(run,{observe:async()=>({status:'running',jobStatus:'running',ready:true}),start:async()=>assert.fail()});assert.equal(up.status,'already-ready');
 const waiting=await restoreManagedPreview(run,{observe:async()=>({status:'starting',jobStatus:'running',ready:false}),start:async()=>assert.fail()});assert.equal(waiting.ready,false);assert.equal(run.preview.ready,false);
});
test('missing recipes, changed run/URL, failed startup and explicit stop never authorize guessed commands',async()=>{
 for(const patch of [{enabled:false},{disabledByStop:true},{runId:'different-run'},{url:'http://127.0.0.1:9999/'},{port:9999},{command:''}]){const run=running();Object.assign(run.previewRestore,patch);assert.equal(previewRestoreRecipe(run),null);const result=await restoreManagedPreview(run,{observe:async()=>({ready:false}),start:async()=>assert.fail()});assert.equal(result.status,'needs-coordinator');assert.equal(result.ready,false);}
 const run=running(),failed=await restoreManagedPreview(run,{observe:async()=>({ready:false}),start:async()=>{throw Error('real startup failure');}});assert.equal(failed.status,'restore-failed');assert.equal(run.preview.ready,false);
});
test('human pause and cancellation stay authoritative before, during and after preview restoration',async()=>{
 const run=running();run.status='paused';assert.equal((await restoreManagedPreview(run,{observe:async()=>assert.fail(),start:async()=>assert.fail()})).status,'run-stopped');run.status='running';
 const during=await restoreManagedPreview(run,{observe:async()=>{run.status='paused';return {ready:false};},start:async()=>assert.fail()});assert.equal(during.status,'run-stopped');run.status='running';
 const after=await restoreManagedPreview(run,{observe:async()=>({ready:false}),start:async()=>{run.status='paused';return {ready:true};}});assert.equal(after.status,'run-stopped');
 await assert.rejects(restoreManagedPreview(running(),{signal:AbortSignal.abort(new Error('human cancelled')),observe:async()=>assert.fail(),start:async()=>assert.fail()}),/human cancelled/);
});
test('a running shell job is not a ready preview; actual HTTP readiness and startup errors are returned',async()=>{
 const preview={url:'http://127.0.0.1:5173/',jobId:'vite'},jobs={get:()=>({status:'running'}),read:()=>({chunks:[{channel:'stderr',text:'actual startup error'}]})};
 const down=await previewState(preview,jobs,'root',undefined,async()=>{throw Error('refused');},true);assert.equal(down.ready,false);assert.equal(down.status,'starting');assert.equal(down.startupOutput,'actual startup error');
 const up=await previewState(preview,jobs,'root',undefined,async()=>({status:200,body:{cancel:async()=>{}}}));assert.equal(up.ready,true);assert.equal(up.status,'running');
 jobs.get=()=>({status:'completed'});const failed=await previewState(preview,jobs,'root',undefined,async()=>{throw Error('refused');},true);assert.equal(failed.status,'failed');assert.match(failed.startupOutput,/actual startup error/);
});
