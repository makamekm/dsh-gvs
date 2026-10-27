import test from 'node:test';import assert from 'node:assert/strict';
import {captureBrowser,validateBrowserActions} from '../v3/browser.js';
test('unsupported viewport action is rejected before any browser or screenshot capture with a specific correction',async()=>{
 let captured=false;await assert.rejects(captureBrowser({url:'http://127.0.0.1:5173/',actions:[{kind:'viewport',value:'1440x960'}]},{signal:new AbortController().signal,saveImage:async()=>{captured=true;}}),error=>/Unsupported browser action "viewport"/.test(error.message)&&/automatically/.test(error.message));assert.equal(captured,false);
});
test('boolean state assertions require literal expected strings and supported states; genuine close/reopen actions remain valid',()=>{
 assert.throws(()=>validateBrowserActions([{kind:'assertState',state:'expanded',value:true}]),/string expected value/);assert.throws(()=>validateBrowserActions([{kind:'assertState',state:'imagined-state',value:'true'}]),/supported state/);
 assert.doesNotThrow(()=>validateBrowserActions([{kind:'click',role:'button',name:'Settings'},{kind:'assertVisible',role:'dialog',name:'Settings'},{kind:'press',value:'Escape'},{kind:'assertHidden',role:'dialog',name:'Settings'},{kind:'click',role:'button',name:'Settings'},{kind:'assertVisible',role:'dialog',name:'Settings'}]));
});
