import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {createRequire} from 'node:module';
import {roleSpec,assertDag,readyTasks,quality,view,parseGameReport} from '../v3/domain.js';
import {compareProbe,probePath} from '../v3/browser.js';
import {apply} from '../v3/runtime.js';
test('dynamic role names and capabilities are bounded',()=>{
 assert.equal(roleSpec({name:'level-designer',title:'Левел-дизайнер',purpose:'Spatial readability',capability:'read'}).name,'level-designer');
 for(const name of ['lead','../outside','UPPER','a'.repeat(41)])assert.throws(()=>roleSpec({name,title:'X',purpose:'Y',capability:'edit'}));
 assert.throws(()=>roleSpec({name:'fake-user',title:'X',purpose:'Y',capability:'user'}));
});
test('dependency waiting and release are real DAG behaviour',()=>{
 const run={tasks:[{id:'build',state:'running',dependsOn:[]},{id:'qa',state:'waiting',dependsOn:['build']}]};
 assert.equal(readyTasks(run).length,0);run.tasks[0].state='done';assert.deepEqual(readyTasks(run).map(task=>task.id),['qa']);
 assert.throws(()=>assertDag([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}]));assert.throws(()=>assertDag([{id:'a',dependsOn:['missing']}]));
});
test('visible waiting explains which colleague is blocking a task',()=>{
 const data=view({schema:3,roles:[{name:'dev',title:'Разработчик'},{name:'physics',title:'Физика'}],tasks:[{id:'a',title:'Сборка',assignee:'dev',state:'running',dependsOn:[]},{id:'b',title:'Коллизии',assignee:'physics',state:'waiting',dependsOn:['a']}],task:'Game',kind:'game2d'});
 assert.equal(data.roles[1].state,'waiting');assert.equal(data.roles[1].waitingFor[0].agent,'Разработчик');
});
const accepted=(id,kind,assignee,images=[])=>({id,kind,assignee,state:'done',receivedImages:images,result:{verdict:'pass',findings:[],revision:2,simple:true,scopePreserved:true,adapterReviewed:true,checks:['node test.mjs'],images}});
function game(){return {kind:'game3d',visualRequired:true,revision:2,viewports:['desktop'],roles:[],tasks:[accepted('r','review','code-qa'),accepted('d','design-review','designer',['real']),accepted('u','user-review','user',['real']),accepted('g','game-review','physics')],visualChecks:[{ok:true,revision:2,capturedBy:'designer',images:[{viewport:'desktop',attachment:{attachmentId:'real'}}],interactions:2,assertions:4}],gameChecks:[{ok:true,revision:2,capturedBy:'physics',coverage:['collision','gameplay','controls','camera']}]};}
test('a 3D game needs real current runtime coverage as well as images',()=>{
 const run=game();assert.ok(Object.values(quality(run)).every(Boolean));run.gameChecks=[];assert.equal(quality(run).game,false);
});
test('game camera coverage and independent adapter review cannot be skipped',()=>{
 let run=game();run.gameChecks[0].coverage.pop();assert.equal(quality(run).game,false);
 run=game();run.tasks[0].result.adapterReviewed=false;assert.equal(quality(run).game,false);
 run=game();run.tasks[0].assignee='physics';assert.equal(quality(run).game,false);
});
test('independent runtime scenarios can supply complementary game coverage',()=>{
 const run=game();run.gameChecks=[{ok:true,revision:2,capturedBy:'physics',coverage:['collision']},{ok:true,revision:2,capturedBy:'physics',coverage:['gameplay','controls','camera']}];assert.equal(quality(run).game,true);
});
test('stale evidence and unread screenshots cannot verify a game',()=>{
 let run=game();run.revision++;assert.ok(Object.values(quality(run)).some(value=>!value));
 run=game();run.tasks[2].receivedImages=[];assert.equal(quality(run).user,false);
});
test('previously green code, screenshots and game checks cannot bypass required motion analysis',()=>{
 const run=game();assert.ok(Object.values(quality(run)).every(Boolean));
 run.analysis={state:'ready',version:1,requirements:[{id:'motion',method:'rendered-sequence',criterion:'Visible texture movement is smooth',reason:'Human sees stepping'}]};run.analysisChecks=[];
 for(const task of run.tasks)task.result.analysisVersion=1;
 const result=quality(run);assert.equal(result.technical,true);assert.equal(result.visual,true);assert.equal(result.game,true);assert.equal(result.analysis,false);assert.equal(result.user,false);assert.equal(result.design,false);
});
test('a runtime report needs actual and expected values for every case',()=>{
 assert.throws(()=>parseGameReport({schema:'gvs.game/1',engine:'fake',cases:[{name:'collision',category:'collision',passed:true}]}));
 const valid=parseGameReport({schema:'gvs.game/1',engine:'engine-under-test',cases:[{name:'wall',category:'collision',passed:false,actual:2,expected:1}]});assert.equal(valid.ok,false);assert.deepEqual(valid.coverage,[]);
});
test('state assertions reject unsafe paths and non-finite numeric comparisons',()=>{
 assert.equal(probePath({player:{x:3}},'player.x'),3);assert.throws(()=>probePath({},'__proto__.x'));assert.throws(()=>probePath({},'constructor.name'));
 assert.equal(compareProbe(3,'lte',4),true);assert.equal(compareProbe(NaN,'gt',0),false);assert.equal(compareProbe(3.001,'near',3,0.01),true);assert.equal(compareProbe(false,'eq',true),false);
});
test('exposed tools satisfy the installed native output contract',()=>{
 const definitions=[];const require=createRequire(path.resolve(import.meta.dirname,'../package.json'));const native=require('@deepseek-ai/dsh-tools');
 apply({on(){},effect(){},tools:{register:definition=>definitions.push(definition),guard(){}},jobs:{attachController:()=>()=>{}}});
 for(const definition of definitions){assert.doesNotThrow(()=>native.assertSupportedJsonSchema(definition.output.schema),definition.name);assert.equal(definition.parameters.type,'object');for(const key of definition.parameters.required)assert.ok(definition.parameters.properties[key]);}
 assert.ok(definitions.some(tool=>tool.name==='gvs_game_check'));assert.ok(definitions.some(tool=>tool.name==='gvs_agent'));
});
