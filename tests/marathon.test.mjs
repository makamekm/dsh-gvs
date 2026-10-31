import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {marathonSettings,detectTests,marathonPhase,hardeningDecision,marathonView,testsGreen} from '../v3/marathon.js';
import {checkpointStore} from '../v3/checkpoint.js';
import {goalStatus} from '../v3/goal.js';
const MINUTE=60000;

test('marathon settings normalize a time budget and stay off unless requested',()=>{
 assert.equal(marathonSettings(undefined,undefined),null);assert.equal(marathonSettings(false,{minutes:60}),null,'an explicit false overrides the configured default');
 const m=marathonSettings({minutes:120,tests:[' npm test ','npm test','']},undefined,1000);
 assert.equal(m.deadline,1000+120*MINUTE);assert.deepEqual(m.tests,['npm test']);assert.equal(m.wrapUpMinutes,12);assert.equal(m.idleRounds,0,'by default the run works until the deadline');assert.equal(m.checkpointMinutes,20);
 const unbounded=marathonSettings(true,undefined,0);assert.equal(unbounded.deadline,null);assert.equal(unbounded.tests,null,'tests are detected later');
 assert.equal(marathonSettings(undefined,{minutes:30,idleRounds:2},0).idleRounds,2,'configured defaults apply when gvs_run omits marathon');
 const asked=marathonSettings({minutes:30,idleRounds:1,restoreGreen:false},{idleRounds:4},0);assert.equal(asked.idleRounds,4,'the coordinator cannot loosen the early-finish policy');assert.equal(asked.restoreGreen,true);
});

test('phases move from work to wrap-up to over at the deadline',()=>{
 const m=marathonSettings({minutes:100},undefined,0);
 assert.equal(marathonPhase(m,10*MINUTE),'work');assert.equal(marathonPhase(m,91*MINUTE),'wrap-up');assert.equal(marathonPhase(m,100*MINUTE),'over');
 assert.equal(marathonPhase({...m,final:{at:1}},0),'final');assert.equal(marathonPhase(marathonSettings(true,undefined,0),1e12),'work');
});

test('visible test commands are detected from root manifests',async()=>{
 const reader=files=>async file=>{if(!(file in files))throw new Error('missing');return files[file];};
 assert.deepEqual(await detectTests(reader({'package.json':JSON.stringify({scripts:{test:'node --test'}}),'pnpm-lock.yaml':''})),['pnpm test']);
 assert.deepEqual(await detectTests(reader({'package.json':JSON.stringify({scripts:{test:'echo "Error: no test specified" && exit 1'}})})),[]);
 assert.deepEqual(await detectTests(reader({'Cargo.toml':'[package]','pyproject.toml':'[tool.pytest.ini_options]'})),['cargo test','python -m pytest -q']);
 assert.deepEqual(await detectTests(reader({'Makefile':'build:\n\ttrue\ntest:\n\ttrue\n'})),['make test']);
});

test('hardening rounds need a new review each time; idle rounds without new findings allow an early finish',()=>{
 const m=marathonSettings(undefined,{minutes:600,idleRounds:2},0),now=MINUTE;
 assert.deepEqual(hardeningDecision(m,{reviews:3,issues:5,now}),{finish:false,round:true,idle:0});
 assert.deepEqual(hardeningDecision(m,{reviews:3,issues:5,now}),{finish:false,round:false,idle:0},'calling again without new review work does not count');
 assert.deepEqual(hardeningDecision(m,{reviews:4,issues:7,now}),{finish:false,round:true,idle:0},'new findings reset the idle count');
 assert.deepEqual(hardeningDecision(m,{reviews:5,issues:7,now}),{finish:false,round:true,idle:1});
 assert.deepEqual(hardeningDecision(m,{reviews:6,issues:7,now}),{finish:true,round:true,idle:2});
 const strict=marathonSettings({minutes:600},undefined,0);for(let i=0;i<5;i++)assert.equal(hardeningDecision(strict,{reviews:i,issues:0,now}).finish,false,'idleRounds 0 works until the deadline');
 assert.equal(hardeningDecision(strict,{reviews:9,issues:0,now:595*MINUTE}).finish,true,'a green run may finish in the wrap-up phase');
 assert.equal(hardeningDecision(marathonSettings(true,undefined,0),{reviews:0,issues:0}).finish,true,'without a deadline green gates finish');
 const view=marathonView({...m,lastTests:{revision:3,results:[{command:'npm test',passed:false}]}},now);assert.equal(view.lastTests.green,false);assert.deepEqual(view.lastTests.failing,['npm test']);assert.equal(view.remainingMinutes,599);
 assert.equal(testsGreen([]),false,'no executed test is not green');
});

test('backlog issues block the goal in marathon mode only',()=>{
 const run={goal:{messages:[],assessed:[],requirements:[],issues:[{id:'i1',taskId:'t',criterion:'Spacing',workTasks:[],reviewTasks:[],backlog:true}],staffingRationale:'x'},tasks:[],roles:[]};
 assert.equal(goalStatus(run).blockingIssues,0);assert.equal(goalStatus({...run,marathon:{}}).blockingIssues,1);
});

const hasGit=spawnSync('git',['--version']).status===0;
test('checkpoints save and restore the working tree without touching the project repository',{skip:!hasGit&&'git is not installed'},async t=>{
 const cwd=await fs.mkdtemp(path.join(tmpdir(),'gvs-checkpoint-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
 const write=(file,text)=>fs.mkdir(path.dirname(path.join(cwd,file)),{recursive:true}).then(()=>fs.writeFile(path.join(cwd,file),text));
 await write('src/app.js','v1\r\n');await write('node_modules/dep/index.js','dep');await write('.gvs/team.json','{}');
 const store=checkpointStore(cwd,'run-1'),first=await store.save('green');assert.equal(first.created,true);
 assert.equal((await store.save('same')).created,false,'an unchanged tree does not create a checkpoint');
 await write('src/app.js','broken');await write('src/new.js','new');await write('.gvs/team.json','{"kept":true}');await fs.rm(path.join(cwd,'node_modules/dep/index.js'));
 const restored=await store.restore(first.id);assert.equal(restored.removed,1);
 assert.equal(await fs.readFile(path.join(cwd,'src/app.js'),'utf8'),'v1\r\n','bytes are restored exactly');
 await assert.rejects(fs.access(path.join(cwd,'src/new.js')),'files created after the checkpoint are removed');
 assert.equal(await fs.readFile(path.join(cwd,'.gvs/team.json'),'utf8'),'{"kept":true}','GVS state is never restored or removed');
 await assert.rejects(fs.access(path.join(cwd,'node_modules/dep/index.js')),'excluded directories are not part of checkpoints');
 await assert.rejects(fs.access(path.join(cwd,'.git')),'no project repository is created');
 await store.restore(restored.before);assert.equal(await fs.readFile(path.join(cwd,'src/new.js'),'utf8'),'new','a restore can be undone');
});
