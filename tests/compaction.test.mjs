import test from 'node:test';import assert from 'node:assert/strict';import {compactionTranscript,splitTranscript,boundedCheckpoint,recoveryBackend} from '../v3/compaction.js';
const input={tools:[{name:'huge-schema'}],messages:[{role:'user',content:[{type:'text',text:'Do not waive mobile parity or human pause.'},{type:'image',attachment:{attachmentId:'original-frame'}}]},{role:'assistant',content:[{type:'reasoning',text:'private'},{type:'tool-call',id:'actual-call',name:'read',arguments:'{"path":"src/main.gd"}'}]},{role:'tool',toolCallId:'actual-call',content:[{type:'text',text:'Actual result: overlap and unresolved task-17.'}]}]};
test('overflow transcript retains human contract, calls, actual errors and image IDs without pretending to inspect pixels or altering history',()=>{
 const before=structuredClone(input),text=compactionTranscript(input);for(const value of ['human pause','original-frame','actual-call','src/main.gd','overlap','task-17','NOT inspected'])assert.ok(text.includes(value));assert.ok(!text.includes('private'));assert.deepEqual(input,before);
 const textWithEmoji=('x'.repeat(126)+'😀').repeat(8),parts=splitTranscript(textWithEmoji,128);assert.equal(parts.join(''),textWithEmoji);assert.ok(parts.every(p=>p.length<=128&&!/[\uD800-\uDBFF]$/.test(p)));
});
test('large history is reduced in bounded parts without silently truncating any original text or declaring several calls to be one stream',async()=>{
 const text='human exact first '+('middle '.repeat(70))+' exact last';const seen=[];const result=await boundedCheckpoint({messages:[{role:'user',content:[{type:'text',text}]}]},{budget:180,summarize:async part=>{assert.deepEqual(part.tools,[]);const request=part.messages.at(-1).content[0].text;seen.push(request);return {summary:[{type:'text',text:request.includes('exact last')?'last requirement':'partial checkpoint'}],provider:'same',model:'same',llmStreamCall:true,usage:{inputTokens:10}};}});
 assert.ok(seen.some(s=>s.includes('human exact first')));assert.ok(seen.some(s=>s.includes('exact last')));assert.ok(seen.length>2);assert.equal(result.llmStreamCall,undefined);assert.equal(result.usage,undefined);assert.match(result.summary[0].text,/retrieve the original frames/);
});
test('failed, cancelled, empty and nonshrinking recovery never produce a checkpoint',async()=>{
 await assert.rejects(boundedCheckpoint(input,{budget:180,summarize:async()=>{throw new Error('provider down');}}),/provider down/);
 await assert.rejects(boundedCheckpoint(input,{budget:180,summarize:async()=>({summary:[]})}),/empty checkpoint/);
 await assert.rejects(boundedCheckpoint(input,{budget:180,summarize:async()=>({summary:[{type:'text',text:'x'.repeat(300)}]})}),/did not shrink/);
 await assert.rejects(boundedCheckpoint(input,{budget:180,signal:AbortSignal.abort(new Error('human cancelled')),summarize:async()=>assert.fail()}),/human cancelled/);
 assert.throws(()=>compactionTranscript({messages:[{role:'user',content:[{type:'new-unsupported'}]}]}),/Unsupported/);
});
test('backend keeps normal compaction and model route, and only confirmed overflow invokes bounded recovery',async()=>{
 let failure,calls=[];class Base{constructor(){this.config={maxTokens:8192,modelPolicies:[]};this.ctx={llm:{resolveModelInfo:async(provider,model)=>{assert.equal(provider,'current-provider');assert.equal(model,'current-model');return {context:{contextWindow:200000}};}}};}async summarize(part,owner){calls.push(part);if(part===input&&failure)throw failure;if(part!==input){assert.deepEqual(owner.session.toolHistory(),{tools:[],updates:[]});assert.ok(part.messages.every(m=>m.role==='user'&&!m.id));}return {summary:[{type:'text',text:'Preserved actual outstanding goal.'}],provider:'current-provider',model:'current-model',llmStreamCall:true};}}
 const history={tools:[{name:'original'}],updates:[]},Backend=recoveryBackend(Base),backend=new Backend(),agent={session:{requestHeader:()=>({config:{provider:'current-provider',model:'current-model'}}),toolHistory:()=>history}};
 assert.equal((await backend.summarize(input,agent)).llmStreamCall,true);assert.equal(calls.length,1);
 failure=Object.assign(new Error('context overflow'),{code:'CONTEXT_WINDOW_EXCEEDED'});const result=await backend.summarize(input,agent);assert.equal(result.model,'current-model');assert.deepEqual(calls.at(-1).tools,[]);assert.ok(calls.at(-1).messages.every(m=>m.content.every(b=>b.type==='text')));
 assert.equal(agent.session.toolHistory(),history);const count=calls.length;failure=new Error('quota exceeded');await assert.rejects(backend.summarize(input,agent),/quota exceeded/);assert.equal(calls.length,count+1);
});
