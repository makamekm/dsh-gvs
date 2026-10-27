import test from 'node:test';import assert from 'node:assert/strict';
import {assignmentDelivery} from '../v3/delivery.js';
test('large UTF-8 evidence uses a bounded assignment without silently claiming the omitted evidence',()=>{
 const images=[{attachment:{attachmentId:'current-frame'}}],normal=assignmentDelivery('Task nonce: abc',images,'fallback');assert.equal(normal.compact,false);assert.equal(normal.content[0].text,'Task nonce: abc');
 const large=assignmentDelivery('результаты'.repeat(30000),images,'ASSIGNED TASK ID: preserved\nTASK NONCE: abc\n'+('контракт'.repeat(15000)));
 assert.ok(Buffer.byteLength(JSON.stringify(large.content),'utf8')<120001);assert.equal(large.compact,true);assert.equal(large.images.length,1);assert.match(large.content[0].text,/not reduced scope/);assert.match(large.content[0].text,/TASK NONCE: abc/);assert.match(large.content[0].text,/gvs_visual/);
});
