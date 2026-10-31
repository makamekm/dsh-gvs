// Marathon mode: a time-boxed run scored by binary hidden tests. Nothing is "minor", the run works until
// its deadline, visible tests must pass before acceptance and the working tree is checkpointed regularly.
const MINUTE=60000;
const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;

export const MARATHON_INPUT={type:'object',additionalProperties:false,description:'Marathon mode for a time-boxed job judged by binary hidden tests: every finding blocks, the team keeps working until the time limit, visible tests gate acceptance and the work is checkpointed. Set it when the human gives a time budget or asks for marathon mode.',properties:{
 minutes:{type:'number',minimum:1,maximum:10080,description:'Wall-clock budget from now. Omit to work until backlog and visible tests are clear, without a deadline.'},
 tests:{type:'array',items:{type:'string',maxLength:2000},maxItems:8,description:'Exact visible test commands run from the project root. Omit to detect them from project manifests.'},
 checkpointMinutes:{type:'number',minimum:5,maximum:240}}};

// The early-finish policy (idleRounds, restoreGreen) belongs to the installation, never to the coordinator's call.
export function marathonSettings(input,defaults,now=Date.now()){
 const source=input===undefined?defaults:input;
 if(!source||source===false)return null;
 const configured=defaults&&typeof defaults==='object'?defaults:{},{idleRounds:_idle,restoreGreen:_restore,...requested}=source===true?{}:source;
 const value={...configured,...(source===configured?{}:requested)};
 const minutes=value.minutes==null?null:clamp(value.minutes,1,10080,null);
 const tests=Array.isArray(value.tests)?[...new Set(value.tests.map(item=>String(item).trim()).filter(Boolean))].slice(0,8):null;
 return {startedAt:now,deadline:minutes?now+minutes*MINUTE:null,minutes,tests,testsDetected:false,
  checkpointMinutes:clamp(value.checkpointMinutes,5,240,20),wrapUpMinutes:minutes?clamp(value.wrapUpMinutes,1,120,Math.min(30,Math.max(5,Math.round(minutes*0.1)))):0,
  idleRounds:Math.round(clamp(value.idleRounds,0,20,0)),restoreGreen:value.restoreGreen!==false,testTimeoutMs:clamp(value.testTimeoutMs,10000,600000,300000),
  checkpoints:[],rounds:[],lastTests:null,lastCheckpointAt:0,wrapUpSent:false,final:null};
}

// Visible test commands from the manifests at the project root; read(file) returns text or null.
export async function detectTests(read){
 const commands=[],text=async file=>{try{return await read(file);}catch{return null;}};
 const pkg=await text('package.json');
 if(pkg){try{const test=JSON.parse(pkg).scripts?.test;if(typeof test==='string'&&test.trim()&&!/no test specified/i.test(test))commands.push(await text('pnpm-lock.yaml')!=null?'pnpm test':await text('yarn.lock')!=null?'yarn test':'npm test');}catch{}}
 if(await text('Cargo.toml')!=null)commands.push('cargo test');
 if(await text('go.mod')!=null)commands.push('go test ./...');
 const pytest=await text('pytest.ini')??await text('tox.ini'),pyproject=await text('pyproject.toml'),setup=await text('setup.cfg');
 if(pytest!=null&&/\[(?:pytest|tool:pytest)\]/.test(pytest)||/\[tool\.pytest/.test(pyproject??'')||/\[tool:pytest\]/.test(setup??'')||await text('conftest.py')!=null)commands.push('python -m pytest -q');
 if(!commands.length){const make=await text('Makefile');if(/^test\s*:/m.test(make??''))commands.push('make test');}
 return commands;
}

export function marathonPhase(m,now=Date.now()){
 if(!m)return null;
 if(m.final)return 'final';
 if(!m.deadline)return 'work';
 if(now>=m.deadline)return 'over';
 return now>=m.deadline-m.wrapUpMinutes*MINUTE?'wrap-up':'work';
}
export const remainingMinutes=(m,now=Date.now())=>m?.deadline?Math.max(0,Math.round((m.deadline-now)/MINUTE)):null;
export const testsGreen=results=>!!results?.length&&results.every(item=>item.passed);

// Decision once every ordinary gate passed and the visible tests ran green. reviews is the number of completed
// review-kind tasks, issues the number of recorded goal issues; a round counts only after a new review.
export function hardeningDecision(m,{reviews,issues,now=Date.now()}){
 const phase=marathonPhase(m,now);
 if(!m.deadline||phase!=='work')return {finish:true};
 const previous=m.rounds.at(-1);
 if(previous&&previous.reviews===reviews)return {finish:false,round:false,idle:previous.idle};
 const idle=previous?(issues===previous.issues?previous.idle+1:0):0;
 m.rounds.push({at:now,reviews,issues,idle});m.rounds=m.rounds.slice(-40);
 return {finish:m.idleRounds>0&&idle>=m.idleRounds,round:true,idle};
}

export function marathonView(m,now=Date.now()){
 if(!m)return null;
 const green=m.checkpoints.filter(item=>item.green).at(-1);
 return {phase:marathonPhase(m,now),deadline:m.deadline?new Date(m.deadline).toISOString():null,remainingMinutes:remainingMinutes(m,now),tests:m.tests??[],
  lastTests:m.lastTests?{revision:m.lastTests.revision,green:testsGreen(m.lastTests.results),failing:m.lastTests.results.filter(item=>!item.passed).map(item=>item.command)}:null,
  checkpoints:m.checkpoints.length,lastGreenCheckpoint:green?{id:green.id,at:new Date(green.at).toISOString(),revision:green.revision}:null,
  hardeningIdle:m.rounds.at(-1)?.idle??0,idleRounds:m.idleRounds,final:m.final??null};
}

export const MARATHON_LEAD=`MARATHON MODE (this run). The result is judged only by binary hidden tests on the final working tree when time runs out. Rules:
1. Nothing is minor. Every deviation from the task fails some hidden test: backlog items and minorFindings block acceptance like any other issue. Repair them.
2. Visible tests gate acceptance. gvs_finish runs them itself; a red test means repair work, not a report. Never weaken, skip or special-case tests or verifiers — that is detected and scores zero.
3. Use the whole time limit. When gates and tests are green before the deadline, gvs_finish asks for a hardening round: assign an independent verify role to derive additional edge-case tests from the requirements (inputs, errors, limits, performance, parity with the reference behavior), run them and report defects; then repair. Implement still-missing functionality first.
4. Keep the tree runnable. GVS checkpoints the working tree every few minutes and after every green test run; gvs_checkpoint lists and restores them. Prefer small integrated slices that keep the tests green.
5. Wrap-up phase (last minutes): no new features or refactors — make the visible tests green and stable. At the deadline GVS stops the team, restores the last green checkpoint if the final tree is red and records the outcome.`;
export const MARATHON_TEAM='MARATHON MODE: the result is judged by binary hidden tests, so there is no non-blocking minor category — report every deviation from the task in findings. Before completing work, run the visible tests and fix what you broke. Never weaken, skip or special-case tests.';
