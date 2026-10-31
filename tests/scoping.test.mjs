import test from 'node:test';import assert from 'node:assert/strict';
import {toolVisible,teammateTaskSchema,scopeTools,scopeSections,rolePolicy,projectSurfaces} from '../v3/scoping.js';
import {coerceArgs} from '../v3/args.js';
import {COMMON,USER} from '../v3/prompts.js';
const codeRun={kind:'code',qaTarget:{surfaces:['service','cli']},roles:[]},webRun={kind:'ui',qaTarget:{surfaces:['web']},roles:[]};
const role=capability=>({name:capability+'-role',title:'Specialist',purpose:'Bounded purpose',capability,instructions:'Inspect the assigned area.'});

test('each teammate sees only the tools its role and the actual project surfaces can use',()=>{
 const read={run:webRun,role:role('read')},edit={run:webRun,role:role('edit')},verify={run:webRun,role:role('verify')};
 for(const name of ['gvs_run','gvs_finish','gvs_pause','gvs_parallel','gvs_wait','list_mcp_resources'])assert.equal(toolVisible(name,verify),false,name);
 for(const name of ['write','edit','pwsh','gvs_browser_check','mcp__desktop__windows_computer_use_click','browser_click'])assert.equal(toolVisible(name,read),false,name);
 for(const name of ['read','grep','glob','gvs_task','gvs_agent','gvs_goal'])assert.equal(toolVisible(name,read),true,name);
 assert.equal(toolVisible('gvs_responsive',edit),false);assert.equal(toolVisible('gvs_browser_check',edit),true);assert.equal(toolVisible('pwsh',edit),true);
 assert.equal(toolVisible('gvs_responsive',verify),true);assert.equal(toolVisible('gvs_analysis',edit),false);assert.equal(toolVisible('gvs_analysis',verify),true);
 assert.equal(toolVisible('gvs_plan_check',edit),false,'code plans are opt-in');assert.equal(toolVisible('gvs_plan_check',{...edit,task:{codePlan:{}}}),true);
 const source={run:webRun,role:role('verify'),task:{reviewFocus:'source'}};
 for(const name of ['gvs_browser_check','gvs_visual','read_image','browser_click'])assert.equal(toolVisible(name,source),false,name);
 assert.equal(toolVisible('pwsh',source),true);
});

test('surface gating hides desktop, game and browser tools from projects that cannot use them, but never on unknown projects',()=>{
 assert.deepEqual(projectSurfaces({kind:'ui',qaTarget:{surfaces:['code-or-unknown']}}),null);
 assert.deepEqual(projectSurfaces({kind:'code',qaTarget:{surfaces:['code-or-unknown']}}),{web:false,native:false,game:false,rendered:false},'a declared code task without detected UI');
 assert.equal(projectSurfaces({kind:'code'}),null,'no inspection, nothing hidden');
 for(const name of ['mcp__desktop__windows_computer_use_click','gvs_game_check','gvs_native_game_check','gvs_browser_check','gvs_responsive','browser_click','gvs_visual']){
  assert.equal(toolVisible(name,{lead:true,run:codeRun}),false,name);
  assert.equal(toolVisible(name,{lead:true,run:{kind:'ui',qaTarget:{surfaces:['code-or-unknown']}}}),true,name);
  assert.equal(toolVisible(name,{lead:true,run:null}),true,name);
 }
 for(const name of ['gvs_run','gvs_finish','gvs_task','pwsh'])assert.equal(toolVisible(name,{lead:true,run:codeRun}),true,name);
 assert.equal(toolVisible('gvs_checkpoint',{lead:true,run:codeRun}),false,'checkpoints exist only in marathon runs');assert.equal(toolVisible('gvs_checkpoint',{lead:true,run:{...codeRun,marathon:{}}}),true);assert.equal(toolVisible('gvs_checkpoint',{run:{...codeRun,marathon:{}},role:role('edit')}),false);
 const native={kind:'ui',qaTarget:{surfaces:['native-ui']}};
 assert.equal(toolVisible('mcp__desktop__windows_computer_use_click',{run:native,role:role('user')}),true);
 assert.equal(toolVisible('gvs_browser_check',{run:native,role:role('verify')}),false);
});

test('guidance for hidden desktop/browser tools leaves the prompt with them, GVS sections stay',()=>{
 const sections=[{name:'windows-and-chrome-routing',text:'You can control this Windows PC using mcp__desktop__* tools. Browser work uses browser tools.'},{name:'dsh-chrome:browser',text:'You can perceive and drive the user browser through browser tools: browser_click.'},{name:'mcp:desktop',text:'Choose the browser lane or desktop tools according to the request.'},{name:'gvs-visual-acceptance',text:'browser tools are evidence'},{name:'fs',text:'Read files before editing.'},{name:'dynamic',text:()=>'x'}];
 assert.deepEqual(scopeSections(sections,[{name:'read'}]).map(s=>s.name),['gvs-visual-acceptance','fs','dynamic']);
 assert.deepEqual(scopeSections(sections,[{name:'browser_click'}]).map(s=>s.name),['windows-and-chrome-routing','dsh-chrome:browser','mcp:desktop','gvs-visual-acceptance','fs','dynamic']);
 assert.deepEqual(scopeSections(sections,[{name:'mcp__desktop__windows_computer_use_click'}]).map(s=>s.name),['windows-and-chrome-routing','mcp:desktop','gvs-visual-acceptance','fs','dynamic']);
});

test('teammates get a gvs_task schema without coordinator planning fields; the lead keeps the full one',()=>{
 const parameters={type:'object',properties:{action:{type:'string',enum:['create','list','complete','retry','dependencies','update']},taskId:{type:'string'},title:{type:'string'},assignee:{type:'string'},codePlan:{type:'object'},verdict:{type:'string'},summary:{type:'string'},findings:{type:'array'},minorFindings:{type:'array'},addressedIssues:{type:'array'},coveredRequirements:{type:'array'},visualReview:{type:'object'},inventory:{type:'array'}},required:['action']};
 const edit=teammateTaskSchema(parameters,{run:webRun,role:role('edit')});
 assert.deepEqual(edit.properties.action.enum,['list','complete']);
 for(const key of ['title','assignee','codePlan','visualReview','inventory'])assert.equal(key in edit.properties,false,key);
 for(const key of ['verdict','summary','findings','minorFindings','addressedIssues','coveredRequirements'])assert.ok(key in edit.properties,key);
 const verify=teammateTaskSchema(parameters,{run:webRun,role:role('verify')});assert.ok('visualReview' in verify.properties);assert.ok('inventory' in verify.properties);
 assert.equal('visualReview' in teammateTaskSchema(parameters,{run:codeRun,role:role('verify')}).properties,false,'no visual review fields for code-only projects');
 const tools=[{name:'gvs_task',parameters},{name:'gvs_run',parameters:{}}];
 assert.deepEqual(scopeTools(tools,{lead:true,run:webRun}),tools);
 const scoped=scopeTools(tools,{run:webRun,role:role('edit')});assert.deepEqual(scoped.map(tool=>tool.name),['gvs_task']);assert.deepEqual(scoped[0].parameters.properties.action.enum,['list','complete']);
 assert.deepEqual(parameters.properties.action.enum.length,6,'the registered schema is not mutated');
});

test('the role policy carries the shared rules plus the role-specific contract',()=>{
 const editor=rolePolicy(webRun,role('edit'));assert.ok(editor.startsWith(COMMON));assert.match(editor,/ROLE edit-role: Specialist/);assert.match(editor,/Inspect the assigned area/);
 assert.ok(rolePolicy(webRun,{...role('user'),name:'user'}).includes(USER));
 assert.equal(rolePolicy(webRun,null),COMMON);
});

test('unambiguous local-model argument mistakes are repaired against the tool schema',()=>{
 const schema={properties:{action:{type:'string'},taskId:{type:'string'},findings:{type:'array',items:{type:'string'}},limit:{type:'integer'},scopeReviewed:{type:'boolean'},summary:{type:'string'},visualReview:{type:'object',properties:{checked:{type:'array',items:{type:'string'}}}}}};
 assert.deepEqual(coerceArgs({action:'complete',findings:'["a","b"]',limit:'20',scopeReviewed:'True'},schema),{action:'complete',findings:['a','b'],limit:20,scopeReviewed:true});
 assert.deepEqual(coerceArgs({findings:'One defect'},schema),{findings:['One defect']},'a single finding becomes a list');
 assert.deepEqual(coerceArgs({task_id:'task-3'},schema),{taskId:'task-3'});
 assert.deepEqual(coerceArgs({action:'complete',result:{summary:'done',findings:[]}},schema),{summary:'done',findings:[],action:'complete'},'a nested completion is hoisted');
 assert.deepEqual(coerceArgs({visualReview:'{"checked":"[\\"spacing\\"]"}'},schema),{visualReview:{checked:['spacing']}});
 const untouched={summary:'["kept as text"]',limit:'twenty',findings:[]};assert.strictEqual(coerceArgs(untouched,schema),untouched);
 assert.deepEqual(coerceArgs({limit:'2.5'},schema),{limit:'2.5'},'a non-integer stays for the tool to reject');
 assert.deepEqual(coerceArgs({result:{unknown:1},action:'list'},schema),{result:{unknown:1},action:'list'},'an unrelated object is not hoisted');
});
