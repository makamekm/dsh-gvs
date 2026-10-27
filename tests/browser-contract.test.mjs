import test from 'node:test';import assert from 'node:assert/strict';
import {captureBrowser,validateBrowserActions,browserPlans,captureViewport,currentControlOutline} from '../v3/browser.js';
test('unsupported viewport action is rejected before any browser or screenshot capture with a specific correction',async()=>{
 let captured=false;await assert.rejects(captureBrowser({url:'http://127.0.0.1:5173/',actions:[{kind:'viewport',value:'1440x960'}]},{signal:new AbortController().signal,saveImage:async()=>{captured=true;}}),error=>/Unsupported browser action "viewport"/.test(error.message)&&/automatically/.test(error.message));assert.equal(captured,false);
});
test('boolean state assertions accept actual booleans and strings, reject other values, and retain valid close/reopen actions',()=>{
 assert.doesNotThrow(()=>validateBrowserActions([{kind:'assertState',state:'expanded',value:true},{kind:'assertState',state:'disabled',value:false},{kind:'check',label:'Consent',value:false}]));assert.throws(()=>validateBrowserActions([{kind:'check',label:'Consent',value:0}]),/check accepts/);assert.throws(()=>validateBrowserActions([{kind:'assertState',state:'expanded',value:1}]),/boolean states/);assert.throws(()=>validateBrowserActions([{kind:'assertState',state:'imagined-state',value:'true'}]),/supported state/);
 assert.doesNotThrow(()=>validateBrowserActions([{kind:'click',role:'button',name:'Settings'},{kind:'assertVisible',role:'dialog',name:'Settings'},{kind:'press',value:'Escape'},{kind:'assertHidden',role:'dialog',name:'Settings'},{kind:'click',role:'button',name:'Settings'},{kind:'assertVisible',role:'dialog',name:'Settings'}]));
});

test('press accepts key and legacy value without letting contradictory or missing keys reach the browser',async()=>{
 assert.doesNotThrow(()=>validateBrowserActions([{kind:'press',key:'Escape'},{kind:'press',value:'Escape'},{kind:'press',key:'Escape',value:'Escape'}]));
 for(const action of [{kind:'press'},{kind:'press',key:'Escape',value:'Enter'}])await assert.rejects(captureBrowser({url:'http://127.0.0.1:5173/',actions:[action]},{signal:new AbortController().signal,saveImage:()=>assert.fail('Invalid keys must fail before capture')}),/press needs/);
});

test('responsive action branches override only their viewport while preserving shared fallback and validation for both',()=>{
 const desktop=[{kind:'click',role:'button',name:'Desktop options'}],mobile=[{kind:'click',role:'button',name:'Phone options'}];assert.deepEqual(browserPlans({actions:desktop,actionsByViewport:{mobile}}),{desktop,mobile});
 assert.throws(()=>browserPlans({actionsByViewport:{mobile:[{kind:'viewport'}]}}),/Unsupported browser action/);assert.throws(()=>browserPlans({actionsByViewport:{tablet:mobile}}),/desktop\/mobile/);
});

test('capture retries a transient protocol failure once on the same page and never invents pixels on persistent failure',async()=>{
 let attempts=0;const bytes=Buffer.from('actual captured bytes'),page={evaluate:async()=>{},screenshot:async()=>{if(++attempts===1)throw Error('Page.captureScreenshot: Unable to capture screenshot');return bytes;}};
 assert.equal(await captureViewport(page),bytes);assert.equal(attempts,2);
 attempts=0;page.screenshot=async()=>{attempts++;throw Error('Page.captureScreenshot: persistent failure');};await assert.rejects(captureViewport(page),/persistent failure/);assert.equal(attempts,2);
 attempts=0;page.screenshot=async()=>{attempts++;throw Error('Target page closed');};await assert.rejects(captureViewport(page),/page closed/);assert.equal(attempts,1);
});

test('control discovery prioritizes the real active dialog instead of truncating its controls behind background page text',async()=>{
 const surface={isVisible:async()=>true,evaluate:async()=>true,ariaSnapshot:async()=>'- button "Continue with FB"\n- button "Dismiss notice"'},page={locator:selector=>selector==='body'?{ariaSnapshot:async()=>'- Background article text '.repeat(2000)}:{count:async()=>1,nth:()=>surface}};
 const text=await currentControlOutline(page);assert.match(text,/Continue with FB/);assert.ok(!text.includes('Background article'));
 surface.isVisible=async()=>false;assert.match(await currentControlOutline(page),/Background article/);
});
