import test from 'node:test';import assert from 'node:assert/strict';
import {analyzeLayout,addLayoutCapture,VISUAL_CHECKS,validateVisualReview,visualAuditStatus,visualStates} from '../v3/visual.js';
const node=(key,type,x,y,width,height,extra={})=>({key,elementKey:key,type,label:key,rect:{x,y,width,height},ancestors:[],...extra});
test('rendered geometry detects independent overlaps, edge text, clipping and blocked controls, not normal nested content',()=>{
 const nodes=[node('brand','image',10,30,80,80),node('action','control',20,70,180,40),node('footer','text',0,180,180,20,{surface:{key:'card',rect:{x:0,y:0,width:220,height:200}}}),node('clipped','text',250,0,80,20,{clip:{x:250,y:0,right:300,bottom:30}}),node('blocked','control',350,0,20,20,{hitBlocked:true}),node('button-label','text',25,75,100,20,{ancestors:['action']})];
 const warnings=analyzeLayout({nodes});assert.ok(warnings.some(w=>w.kind==='overlap'&&w.targets.some(t=>t.key==='brand')&&w.targets.some(t=>t.key==='action')));assert.ok(warnings.some(w=>w.kind==='edge-spacing'));assert.ok(warnings.some(w=>w.kind==='clipping'));assert.ok(warnings.some(w=>w.kind==='occluded-control'));assert.ok(!warnings.some(w=>w.kind==='overlap'&&w.targets.some(t=>t.key==='button-label')&&w.targets.some(t=>t.key==='action')));
});
function fixture(){
 const image=viewport=>({viewport,stage:'initial',attachment:{attachmentId:viewport}}),view={viewport:'mobile'};
 addLayoutCapture(view,{nodes:[node('brand','image',10,30,80,80),node('action','control',20,70,180,40)],scope:'active-surface',truncated:false},{imageId:'mobile',stage:'initial',url:'http://127.0.0.1:5173/'});
 const desktop={viewport:'desktop'};addLayoutCapture(desktop,{nodes:[],scope:'page',truncated:false},{imageId:'desktop',stage:'initial',url:'http://127.0.0.1:5173/'});
 const run={visualPolicy:1,visualRequired:true,kind:'ui',revision:3,viewports:['desktop','mobile'],roles:[{name:'qa',capability:'verify'},{name:'user',capability:'user'}],tasks:[],visualChecks:[{ok:true,revision:3,capturedBy:'runner',images:[image('desktop'),image('mobile')],views:[desktop,view]}]};
 const task={id:'qa-review',kind:'review',assignee:'qa',scope:'increment',receivedImages:['desktop','mobile']};
 const warning=view.layout.warnings[0],result={verdict:'pass',revision:3,images:['desktop','mobile'],visualReview:{checked:VISUAL_CHECKS,assessments:[{warningId:warning.id,imageId:'mobile',disposition:'intentional',reason:'Actual screenshot demonstrates readable intentional layering with no obstructed hit area.'}]}};
 return {run,task,warning,result};
}
test('a green test count or a clean final image cannot replace visual review and warning classification',()=>{
 const {run,task,result}=fixture();assert.throws(()=>validateVisualReview(run,task,{verdict:'pass',images:['desktop','mobile']}),/Visual acceptance needs/);
 assert.throws(()=>validateVisualReview(run,task,{...result,visualReview:{checked:VISUAL_CHECKS,assessments:[]}}),/Classify/);
 assert.throws(()=>validateVisualReview(run,task,{...result,images:['desktop']}),/every planned viewport/);
 result.visualReview.assessments[0].disposition='defect';assert.throws(()=>validateVisualReview(run,task,result),/Unfixed visual defect/);
 result.visualReview.assessments[0].disposition='intentional';assert.deepEqual(validateVisualReview(run,task,result),[]);
});
test('outside-slice defects remain mandatory and full acceptance requires separate QA and User judgements',()=>{
 const {run,task,result}=fixture();result.visualReview.assessments[0].disposition='outside-scope';assert.equal(validateVisualReview(run,task,result).length,1);
 assert.throws(()=>validateVisualReview(run,{...task,scope:'full'},result),/full review/);
 result.visualReview.assessments[0].disposition='intentional';run.tasks=[{...task,state:'done',result}];assert.equal(visualAuditStatus(run).ready,false);assert.equal(visualAuditStatus(run).warnings[0].qaReviewed,true);
 run.tasks.push({...task,id:'user-review',assignee:'user',kind:'user-review',state:'done',result:structuredClone(result)});assert.equal(visualAuditStatus(run).ready,true);
 run.revision++;assert.equal(visualAuditStatus(run).warnings.length,0); // Old screenshots cannot describe edited geometry.
});
test('warnings from intermediate states survive a clean final state and require their actual screenshot',()=>{
 const {run,task,result}=fixture(),view=run.visualChecks[0].views[1];
 addLayoutCapture(view,{nodes:[],scope:'page',truncated:false},{imageId:'clean-final',stage:'journey',url:'http://127.0.0.1:5173/'});
 run.visualChecks[0].images.push({viewport:'mobile',stage:'journey',attachment:{attachmentId:'clean-final'}});task.receivedImages.push('clean-final');
 assert.throws(()=>validateVisualReview(run,task,{...result,images:['desktop','clean-final']}),error=>/all supplied/.test(error.message)&&/Missing 1 of 3/.test(error.message)&&/"imageId":"mobile"/.test(error.message)&&/action:states/.test(error.message));
 assert.equal(view.layout.warnings.length,1);assert.equal(view.layout.captures.length,2);
});

test('required state discovery includes warning-free frames, deduplicates identical pixels, and excludes unrelated or stale captures',()=>{
 const {run,task}=fixture();const extra={viewport:'mobile'};addLayoutCapture(extra,{nodes:[],scope:'page',truncated:false},{imageId:'quiet',stage:'step-1',url:'http://localhost'});addLayoutCapture(extra,{nodes:[],scope:'page',truncated:false},{imageId:'quiet',stage:'journey',url:'http://localhost'});
 const check={ok:true,revision:3,taskId:task.id,capturedBy:'qa',images:[{viewport:'mobile',stage:'step-1',attachment:{attachmentId:'quiet'}}],views:[extra]};run.visualChecks.push(check,{...check,taskId:'other',images:[{viewport:'mobile',attachment:{attachmentId:'unrelated'}}]},{...check,revision:2});
 const states=visualStates(run,task);assert.deepEqual(states.map(s=>s.imageId),['desktop','mobile','quiet']);assert.deepEqual(states[2].contexts.map(c=>c.stage),['step-1','journey']);assert.deepEqual(states[2].contexts[0].warningIds,[]);
});

test('a repeated geometry candidate accepts a cited actual earlier frame instead of overwriting its evidence with the latest capture',()=>{
 const {run,task,result,warning}=fixture(),check=structuredClone(run.visualChecks[0]);check.images[1].attachment.attachmentId='later';check.views[1].layout.captures[0].imageId='later';check.views[1].layout.warnings[0].images=['later'];run.visualChecks.push(check);task.receivedImages.push('later');result.images.push('later');
 assert.deepEqual(validateVisualReview(run,task,result),[]);assert.equal(result.visualReview.assessments[0].imageId,warning.images[0]);
});

test('a bounded automatic scan cannot be described as complete without explicit manual coverage',()=>{
 const {run,task,result}=fixture();run.visualChecks[0].views[1].layout.truncated=true;
 assert.throws(()=>validateVisualReview(run,task,result),/bounded/);
 result.visualReview.manualCoverage='Personally checked the full supplied phone frame, including the remaining footer and icon content, and used the recorded hit-area evidence.';
 assert.deepEqual(validateVisualReview(run,task,result),[]);
});
test('source-only increments do not require screenshots and cannot contribute visual QA approval',()=>{
 const {run,task,result}=fixture();const source={...task,reviewFocus:'source',analysisIds:[]};
 assert.deepEqual(validateVisualReview(run,source,{verdict:'pass'}),[]);
 run.tasks=[{...source,state:'done',result}];assert.equal(visualAuditStatus(run).warnings[0].qaReviewed,false);
 for(const other of [{...source,scope:'full'},{...source,kind:'user-review'},{...source,kind:'design-review'},{...source,analysisIds:['motion']}])assert.throws(()=>validateVisualReview(run,other,{verdict:'pass'}),/Visual acceptance/);
});
