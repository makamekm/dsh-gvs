import test from 'node:test';import assert from 'node:assert/strict';import {previewState} from '../v3/preview.js';
test('a running shell job is not a ready preview; actual HTTP readiness and startup errors are returned',async()=>{
 const preview={url:'http://127.0.0.1:5173/',jobId:'vite'},jobs={get:()=>({status:'running'}),read:()=>({chunks:[{channel:'stderr',text:'actual startup error'}]})};
 const down=await previewState(preview,jobs,'root',undefined,async()=>{throw Error('refused');},true);assert.equal(down.ready,false);assert.equal(down.status,'starting');assert.equal(down.startupOutput,'actual startup error');
 const up=await previewState(preview,jobs,'root',undefined,async()=>({status:200,body:{cancel:async()=>{}}}));assert.equal(up.ready,true);assert.equal(up.status,'running');
 jobs.get=()=>({status:'completed'});const failed=await previewState(preview,jobs,'root',undefined,async()=>{throw Error('refused');},true);assert.equal(failed.status,'failed');assert.match(failed.startupOutput,/actual startup error/);
});
