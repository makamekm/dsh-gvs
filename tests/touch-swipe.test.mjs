import test from 'node:test';import assert from 'node:assert/strict';
import {nativeTouchSwipe,validateBrowserActions} from '../v3/browser.js';
const action={kind:'swipe',role:'group',name:'Gesture surface',direction:'left',durationMs:100};
function fixture({engine='chromium',count=1,hit=true,box={x:10,y:20,width:200,height:100},onSend}={}){
 const sent=[];let detached=false,attached=0;
 const session={send:async(name,args)=>{sent.push({name,...args});onSend?.(args);},detach:async()=>{detached=true;}};
 const page={context:()=>({browser:()=>({browserType:()=>({name:()=>engine})}),newCDPSession:async()=>{attached++;return session;}}),evaluate:async()=>({width:400,height:300})};
 const target={count:async()=>count,waitFor:async()=>{},scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>box,evaluate:async()=>hit};
 return {page,target,sent,get detached(){return detached;},get attached(){return attached;}};
}
test('swipe validates its observed target and bounded direction/distance/time before capture',()=>{
 assert.doesNotThrow(()=>validateBrowserActions([action]));
 assert.doesNotThrow(()=>validateBrowserActions([{kind:'swipe',selector:'.observed-surface',direction:'left'}]));
 for(const selector of ['',42,'x'.repeat(301),'canvas >> nth=0'])assert.throws(()=>validateBrowserActions([{kind:'swipe',selector,direction:'left'}]),/selector/);
 assert.throws(()=>validateBrowserActions([{...action,selector:'.surface'}]),/instead of an ambiguous semantic target/);
 for(const change of [{direction:'diagonal'},{distance:0},{distance:1},{distance:NaN},{durationMs:99},{durationMs:2001},{durationMs:100.5},{role:undefined,name:undefined}])assert.throws(()=>validateBrowserActions([{...action,...change}]),/swipe needs/);
});
test('swipe never substitutes mouse/wheel or DOM dispatch for unsupported input/engine',async()=>{
 for(const mode of ['pointer','keyboard']){const f=fixture();await assert.rejects(nativeTouchSwipe(f.page,f.target,action,mode),/touch input case/);assert.equal(f.attached,0);}
 for(const engine of ['firefox','webkit']){const f=fixture({engine});await assert.rejects(nativeTouchSwipe(f.page,f.target,action),/requires Chromium\/Edge CDP/);assert.equal(f.attached,0);}
});
test('ambiguous, covered and clipped gesture surfaces fail before sending native input',async()=>{
 for(const options of [{count:2},{hit:false},{box:{x:-400,y:20,width:200,height:100}},{box:{x:10,y:20,width:0,height:0}},{box:{x:NaN,y:20,width:200,height:100}}]){const f=fixture(options);await assert.rejects(nativeTouchSwipe(f.page,f.target,action),/exactly one|covered|viewport|usable visible/);assert.equal(f.attached,0);assert.equal(f.sent.length,0);}
});
test('native swipe sends a bounded actual touch sequence with measured endpoints and detaches',async()=>{
 const f=fixture(),proof=await nativeTouchSwipe(f.page,f.target,action);
 assert.equal(proof.kind,'native-touch-swipe');assert.deepEqual(proof.start,{x:180,y:70});assert.deepEqual(proof.end,{x:40,y:70});assert.equal(proof.touchEvents,f.sent.length);assert.ok(proof.elapsedMs>=80);assert.equal(f.sent[0].type,'touchStart');assert.equal(f.sent.at(-1).type,'touchEnd');assert.deepEqual(f.sent.at(-1).touchPoints,[]);assert.ok(f.sent.every(e=>e.name==='Input.dispatchTouchEvent'));assert.ok(f.sent.slice(1,-1).every(e=>e.type==='touchMove'&&e.touchPoints[0].x>=40&&e.touchPoints[0].x<=180));assert.equal(f.detached,true);
});
test('abort cancels an in-flight contact and cannot return a passing gesture',async()=>{
 const controller=new AbortController(),f=fixture({onSend:e=>{if(e.type==='touchStart')controller.abort(new Error('Explicit test cancellation'));}});
 await assert.rejects(nativeTouchSwipe(f.page,f.target,action,'touch',controller.signal),/Explicit test cancellation/);assert.equal(f.sent.at(-1).type,'touchCancel');assert.ok(!f.sent.some(e=>e.type==='touchEnd'));assert.equal(f.detached,true);
});
