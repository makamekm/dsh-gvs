import test from 'node:test';import assert from 'node:assert/strict';
import {classifyProjectQA,requiresWebVerification,affectedVerificationTargets,isRenderedProject} from '../v3/project-qa.js';import {needsResponsive,responsiveRunReady} from '../v3/responsive.js';import {needsPreview} from '../v3/preview.js';import {VISUAL_CHECKS,visualStates,validateVisualReview} from '../v3/visual.js';import {userProbeInput} from '../v3/journeys.js';

test('actual nested manifest boundaries route Rust commands, services and engine code independently of the web shell',()=>{
 const target=classifyProjectQA({files:['package.json','src','api','api/Cargo.toml','api/src','tools/echo','tools/echo/Cargo.toml','tools/echo/src','game','game/project.godot','game/scenes'],documents:{'package.json':'{"dependencies":{"vite":"7"}}','api/Cargo.toml':'[dependencies]\naxum="0.8"','tools/echo/Cargo.toml':'[package]\nname="echo"\n[[bin]]\npath="src/main.rs"','game/project.godot':'[application]'}});
 assert.equal(target.version,2);assert.ok(target.surfaces.includes('cli'));assert.deepEqual(affectedVerificationTargets(target,['tools/echo/src/main.rs']).surfaces,['cli']);assert.deepEqual(affectedVerificationTargets(target,['api/src/main.rs']).surfaces,['service']);assert.deepEqual(affectedVerificationTargets(target,['game/scenes/menu.gd']).surfaces,['native-game']);assert.deepEqual(affectedVerificationTargets(target,['src/App.tsx']).surfaces,['web']);assert.deepEqual(affectedVerificationTargets(target,['api-other/control.ts']).surfaces,['web'],'A component name must match an actual path boundary');
 const mixed=affectedVerificationTargets(target,['api/src/main.rs','src/App.tsx']);assert.deepEqual(new Set(mixed.surfaces),new Set(['web','service']));assert.equal(mixed.unknown,false);assert.equal(requiresWebVerification({kind:'ui',qaTarget:target}),true,'Increment focus cannot remove global browser acceptance');
});

test('unknown nested manifests and legacy metadata remain discovery needs rather than inheriting a false browser target',()=>{
 const target=classifyProjectQA({files:['package.json','plugins/opaque','plugins/opaque/Cargo.toml'],documents:{'package.json':'{"dependencies":{"vite":"7"}}','plugins/opaque/Cargo.toml':'[package]\nname="opaque"'}}),unknown=affectedVerificationTargets(target,['plugins/opaque/src/lib.rs']);assert.equal(unknown.unknown,true);assert.deepEqual(unknown.surfaces,['code-or-unknown']);assert.equal(unknown.components[0].root,'plugins/opaque');assert.equal(affectedVerificationTargets({surfaces:['web']},['service/main.rs']).unknown,true);assert.equal(affectedVerificationTargets(target,[]).unknown,true);
 const service=classifyProjectQA({files:['Cargo.toml'],documents:{'Cargo.toml':'[[bin]]\nname="server"\n[dependencies]\naxum="0.8"'}});assert.ok(service.surfaces.includes('service'));assert.ok(!service.surfaces.includes('cli'),'A known HTTP server binary is not relabelled as command-only');
});

test('confirmed command metadata overrides a legacy UI kind without inventing a native window or installed adapter',()=>{
 const target=classifyProjectQA({files:['Cargo.toml'],documents:{'Cargo.toml':'[[bin]]\npath="src/main.rs"'}}),run={kind:'ui',status:'running',userTestingPolicy:1,userTestingInitial:true,analysis:{state:'ready'},qaTarget:target,roles:[{name:'user',sessionId:'same-user'}],tasks:[],analysisChecks:[{ok:true}]};assert.equal(isRenderedProject(run),false);const probe=userProbeInput(run);assert.match(probe.instructions,/actual owned bot\/CLI interaction driver/);assert.deepEqual(probe.resources,['product-interaction']);assert.ok(!probe.instructions.includes('actual owned engine/application window'));assert.equal(isRenderedProject({kind:'ui',qaTarget:{surfaces:['code-or-unknown']}}),false);
});
test('actual Unity/Godot/Unreal metadata selects native engine evidence, not browser simulation or invented runtime availability',()=>{
 for(const [engine,input] of [['godot',{files:['project.godot','scenes'],documents:{'project.godot':'[application]\nconfig/name="Game"'}}],['unity',{files:['Assets','ProjectSettings'],documents:{'ProjectSettings/ProjectVersion.txt':'m_EditorVersion: 2022.3.0f1'}}],['unreal',{files:['Game.uproject','Source','Content'],documents:{'Game.uproject':'{}'}}]]){
  const target=classifyProjectQA(input),run={kind:'ui',visualRequired:true,responsivePolicy:1,qaTarget:target,preview:{url:'http://localhost:5173/'}};
  assert.ok(target.engines.includes(engine));assert.ok(target.surfaces.includes('native-game'));assert.equal(requiresWebVerification(run),false);assert.equal(needsResponsive(run,{kind:'user-review'}),false);assert.equal(responsiveRunReady(run),true);assert.equal(needsPreview(run,{kind:'review'}),false);assert.ok(target.adapters[0].tools.includes('gvs_native_game_check'));assert.match(target.adapters[0].availability,/not a successful test/);
 }
});
test('Node/Python/Rust bots and CLI projects require actual commands/process/transport/state proof with no browser or screenshots',()=>{
 for(const input of [{files:['package.json','src'],documents:{'package.json':JSON.stringify({dependencies:{telegraf:'4',commander:'12'}})}},{files:['pyproject.toml'],documents:{'pyproject.toml':'dependencies = ["aiogram"]'}},{files:['Cargo.toml'],documents:{'Cargo.toml':'[dependencies]\nteloxide="0.13"'}}]){
  const target=classifyProjectQA(input);assert.ok(target.surfaces.includes('bot-service'));assert.equal(requiresWebVerification({kind:'code',visualRequired:false,qaTarget:target}),false);assert.ok(target.adapters.every(a=>!a.tools.includes('gvs_responsive')));assert.ok(!target.sourceRoots.includes('nonexistent-dir'));
 }
});
test('mixed nested applications retain web, native and bot/backend targets without guessing source directories',()=>{
 const target=classifyProjectQA({files:['package.json','src','backend','backend/Cargo.toml','backend/src','bot','bot/package.json'],documents:{'package.json':JSON.stringify({dependencies:{vite:'7','react-native-web':'1'}}),'backend/Cargo.toml':'[dependencies]\naxum="0.8"','bot/package.json':JSON.stringify({dependencies:{grammy:'1'}})}});
 for(const surface of ['web','service','bot-service'])assert.ok(target.surfaces.includes(surface));assert.equal(target.mixed,true);assert.ok(target.sourceRoots.includes('backend/src'));assert.ok(target.sourceRoots.includes('bot'));assert.equal(requiresWebVerification({kind:'ui',visualRequired:true,qaTarget:target}),true);assert.equal(requiresWebVerification({kind:'code',visualRequired:false,qaTarget:target}),false);
});
test('native UI frame inspection covers initial and intermediate pixels without requiring DOM geometry or web journeys',()=>{
 const images=['initial','opened'].map(stage=>({viewport:'desktop',stage,attachment:{attachmentId:stage}})),run={kind:'ui',visualRequired:true,visualPolicy:1,userTestingPolicy:1,qaTarget:{surfaces:['native-ui']},revision:2,viewports:['desktop'],visualChecks:[{ok:true,revision:2,taskId:'native-user',capturedBy:'user',engine:'Godot Control',images,views:[{viewport:'desktop'}]}]},task={id:'native-user',kind:'user-review',assignee:'user',scope:'increment',receivedImages:[]},result={verdict:'pass',images:['initial','opened'],visualReview:{checked:VISUAL_CHECKS,assessments:[]}};
 assert.equal(visualStates(run,task).length,2);assert.doesNotThrow(()=>validateVisualReview(run,task,result));assert.throws(()=>validateVisualReview(run,task,{...result,images:['opened']}),/all supplied/);
});
test('automatic User exploration follows actual native frames or bot runtime evidence and requests the correct interaction driver',()=>{
 const base={status:'running',revision:3,userTestingPolicy:1,userTestingInitial:true,analysis:{state:'ready'},roles:[{name:'user',sessionId:'same-user'}],tasks:[]};
 const native=userProbeInput({...base,kind:'game2d',visualRequired:true,qaTarget:{surfaces:['native-game'],sourceRoots:['Assets']},visualChecks:[{ok:true,images:[{}]}]});assert.ok(native);assert.match(native.instructions,/actual owned engine/);assert.ok(!native.instructions.includes('Register scenarios incrementally'));assert.deepEqual(native.resources,['native-window']);
 const bot=userProbeInput({...base,kind:'code',visualRequired:false,qaTarget:{surfaces:['bot-service'],sourceRoots:['src']},analysisChecks:[{ok:true}]});assert.ok(bot);assert.match(bot.instructions,/actual owned bot\/CLI interaction driver/);assert.deepEqual(bot.resources,['product-interaction']);
});
test('unknown and hinted projects do not become an installed/verified engine or default browser target',()=>{
 const unknown=classifyProjectQA({files:['main.py']});assert.equal(unknown.sourceConfirmed,false);assert.equal(requiresWebVerification({kind:'ui',qaTarget:unknown}),false);
 const hinted=classifyProjectQA({engineHint:'Godot 4'});assert.ok(hinted.engines.includes('godot'));assert.equal(hinted.sourceConfirmed,false);assert.match(hinted.warnings.join(' '),/intent hint only/);
});
