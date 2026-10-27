import test from 'node:test';import assert from 'node:assert/strict';
import {motionHint,analysisPlan,parseAnalysisReport,analysisReady,analysisAcceptance,decodeAnalysisRunner} from '../v3/analysis.js';
const plan=()=>({...analysisPlan({rationale:'The human sees stepping in a moving texture.',requirements:[{id:'motion',reason:'Visible stepping was reported',criterion:'No quantized texture steps or uneven frame cadence',method:'rendered-sequence'}]},true),version:1});
const report=()=>({schema:'gvs.analysis/1',engine:'test renderer',analyzer:'Compare rendered texture displacement and presentation timestamps',results:[{id:'motion',cases:[{name:'Rendered texture step cadence',source:'rendered-pixels',actual:0,expected:0,passed:true},{name:'Frame-time spike count',source:'frame-timing',actual:0,expected:0,passed:true}],samples:Array.from({length:32},(_,i)=>({viewport:'desktop',atMs:i*40,renderedPixelMetric:i*.25,frameTimeMs:16.7})),frames:Array.from({length:12},(_,i)=>({path:`capture-${i}.png`,viewport:'desktop',atMs:i*100}))}]});
test('runner diagnostics preserve stderr and distinguish failed execution from missing or malformed JSON',()=>{
 assert.throws(()=>decodeAnalysisRunner({value:{kind:'foreground',exitCode:1,stdout:{text:''},stderr:{text:'AssertionError: focus was BODY'}}}),/failed \(exit 1\)[\s\S]*focus was BODY/);
 assert.throws(()=>decodeAnalysisRunner({value:{kind:'foreground',exitCode:0,stdout:{text:'No report emitted'}}}),/finished without its required report/);
 assert.throws(()=>decodeAnalysisRunner({value:{kind:'foreground',exitCode:1,stdout:{text:'GVS_ANALYSIS_RESULT: {broken'},stderr:{text:'Compiler failure'}}}),/Malformed[\s\S]*Compiler failure/);
});
test('valid report data cannot conceal process failure, timeout, abort or signal',()=>{
 const value={kind:'foreground',exitCode:0,stdout:{text:'GVS_ANALYSIS_RESULT: '+JSON.stringify(report())}};
 assert.equal(decodeAnalysisRunner({value}).ok,true);
 for(const extra of [{exitCode:1},{timedOut:true},{aborted:true},{signal:'SIGTERM'}])assert.equal(decodeAnalysisRunner({value:{...value,...extra}}).ok,false);
 assert.equal(decodeAnalysisRunner({isError:true,value}).ok,false);
});
test('simple tasks may explicitly omit additional analysis; a smoothness request cannot silently omit it',()=>{
 assert.equal(analysisPlan({rationale:'Rename a static button label; existing UI checks suffice.',requirements:[]}).requirements.length,0);
 assert.ok(motionHint('Люди двигаются словно шагами, сделай плавно'));
 assert.throws(()=>analysisPlan({rationale:'No checks',requirements:[]},true),/visible smoothness/);
 assert.equal(analysisPlan({rationale:'Only rename the label Smoothness',requirements:[],notRequiredReason:'This changes literal text, not any animation or rendering.'},true).requirements.length,0);
 assert.throws(()=>analysisPlan({rationale:'Motion',requirements:[{id:'motion',reason:'Motion',criterion:'Smooth',method:'runtime'}]},true),/rendered sequence/);
});
test('the old transform samples and two-screenshot approach cannot prove visible smoothness',()=>{
 let data=report();data.results[0].cases=[{name:'342 checks, 50 floating-point samples',source:'runtime',passed:true,actual:342,expected:342}];assert.throws(()=>parseAnalysisReport(data,plan(),['desktop']),/rendered-pixel/);
 data=report();data.results[0].frames=data.results[0].frames.slice(0,2);assert.throws(()=>parseAnalysisReport(data,plan(),['desktop']),/8 ordered/);
 data=report();data.results[0].frames[2].atMs=data.results[0].frames[1].atMs;assert.throws(()=>parseAnalysisReport(data,plan(),['desktop']),/ordered/);
 data=report();assert.throws(()=>parseAnalysisReport(data,plan(),['desktop','mobile']),/mobile/);
 data=report();delete data.results[0].samples;assert.throws(()=>parseAnalysisReport(data,plan(),['desktop']),/timing samples/);
 data=report();data.results[0].cases[0].passed=false;assert.equal(parseAnalysisReport(data,plan(),['desktop']).ok,false);
});
test('current real reports need a different reviewer and received evidence in final User acceptance',()=>{
 const parsed=parseAnalysisReport(report(),plan(),['desktop']);const run={revision:4,analysis:plan(),analysisChecks:[{...parsed,id:'a1',revision:4,planVersion:1,capturedBy:'motion-qa'}],tasks:[]};
 assert.equal(analysisReady(run),false);
 const review={kind:'review',state:'done',assignee:'motion-qa',result:{verdict:'pass',revision:4,adapterReviewed:true,analysisReports:['a1']}};run.tasks.push(review);assert.equal(analysisReady(run),false);
 review.assignee='code-review';assert.equal(analysisReady(run),true);
 const user={receivedAnalysisReports:[],result:{analysisVersion:1,analysisReports:['a1']}};assert.equal(analysisAcceptance(run,user),false);user.receivedAnalysisReports=['a1'];assert.equal(analysisAcceptance(run,user),true);
 run.revision++;assert.equal(analysisReady(run),false);run.revision--;run.analysis.version++;assert.equal(analysisReady(run),false);
});
test('pending analysis blocks acceptance even when ordinary code and visual checks would pass',()=>{
 assert.equal(analysisReady({analysis:{state:'pending'}}),false);
 assert.equal(analysisReady({analysis:{state:'ready',version:1,requirements:[]},analysisChecks:[],tasks:[]}),true);
});
