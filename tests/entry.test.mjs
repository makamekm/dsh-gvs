import test from 'node:test';import assert from 'node:assert/strict';import {sameEntry,phoneContext} from '../v3/browser.js';import {quality} from '../v3/domain.js';
test('phone checks expose a real mobile UA and special fixture routes cannot stand in for the public entry',()=>{
 assert.match(phoneContext('149.0.1.2').userAgent,/Android.*Chrome\/149\.0\.1\.2 Mobile/);assert.equal(phoneContext('149').hasTouch,true);
 assert.equal(sameEntry('http://localhost:5173/','http://127.0.0.1:5173/'),true);for(const url of ['http://127.0.0.1:5173/m/','http://127.0.0.1:5173/?fixture=mobile','http://127.0.0.1:5173/#test','http://127.0.0.1:5174/'])assert.equal(sameEntry(url,'http://127.0.0.1:5173/'),false);
 const run={kind:'ui',visualRequired:true,preview:{url:'http://127.0.0.1:5173/'},revision:1,viewports:['desktop','mobile'],tasks:[],roles:[],gameChecks:[],visualChecks:[{ok:true,url:'http://127.0.0.1:5173/m/',revision:1,images:[],views:[{viewport:'desktop'},{viewport:'mobile',isMobile:true,touchPoints:1,userAgent:phoneContext('149').userAgent}]}]};
 assert.equal(quality(run).entry,false);run.visualChecks[0].url=run.preview.url;assert.equal(quality(run).entry,true);run.visualChecks[0].views[1].userAgent='Desktop browser';assert.equal(quality(run).entry,false);
});
