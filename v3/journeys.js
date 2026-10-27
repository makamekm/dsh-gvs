import {createHash} from 'node:crypto';

export const USER_TESTING='USER IS AN ACTIVE PRODUCT TESTER. For a web UI, as soon as a runnable interface exists, exercise it repeatedly after implementation increments. Observe real controls first, invent concrete scenarios, open each affected window, operate its controls, close/back/Escape and reopen it, try invalid/empty inputs or unavailable/loading/recovery paths where applicable, and compare expected vs actual behavior on desktop and phone. Register scenarios with gvs_user_testing action:plan, then execute gvs_browser_check with the exact scenarioId and semantic actions plus observable assertions. Screenshots, another agent’s tests and a written scenario are not functional evidence. Send concrete failures to Lead immediately; diagnose automation/selector failures separately from product defects. Every confirmed defect needs findings, an owned repair and independent recheck. Do not wait for the entire product or another approval cycle to test the current UI. An exploratory increment is never full acceptance. Other product types keep their appropriate real native/game testing tools. For citation failures read existing gvs_visual action:states pages and copy exact imageIds; do not keep recapturing or invent hashes.';
export const scenarioKey=scenario=>createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
const categories=['primary','dismiss','negative','recovery'];
function exercised(view,category){
 const steps=view.steps??[],action=s=>s.passed&&!s.kind.startsWith('assert'),first=steps.findIndex(action);
 if(first<0||!steps.slice(first+1).some(s=>s.passed&&s.kind.startsWith('assert')))return false;
 if(category!=='dismiss')return true;
 return steps.some((closed,i)=>{
  const hidden=closed.kind==='assertHidden',collapsed=closed.kind==='assertState'&&closed.state==='expanded'&&closed.value==='false';
  if(!closed.passed||!hidden&&!collapsed)return false;
  const open=s=>s.passed&&s.target===closed.target&&(hidden?s.kind==='assertVisible':s.kind==='assertState'&&s.state==='expanded'&&s.value==='true');
  return steps.some((before,j)=>j<i&&open(before)&&steps.slice(j+1,i).some(action))&&steps.some((after,j)=>j>i&&open(after)&&steps.slice(i+1,j).some(action));
 });
}
export function planUserJourneys(run,task,input){
 if(!Array.isArray(input.scenarios)||!input.scenarios.length||input.scenarios.length>16)throw new Error('Plan 1–16 concrete observed UI scenarios, then actually execute them.');
 const ids=new Set(),scenarios=input.scenarios.map(item=>{
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(item.id)||ids.has(item.id))throw new Error('Scenario IDs must be unique lowercase literal IDs.');ids.add(item.id);
  if(!categories.includes(item.category)||['target','expected'].some(key=>typeof item[key]!=='string'||item[key].trim().length<10||item[key].length>1200))throw new Error('Each scenario needs category, the actual observed target/flow and a concrete expected outcome.');
  return {id:item.id,category:item.category,target:item.target.trim(),expected:item.expected.trim()};
 });
 const observed=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision&&(c.taskId===task.id||c.images.some(i=>task.receivedImages?.includes(i.attachment.attachmentId))));
 const available=new Set(observed.flatMap(c=>c.images).map(i=>i.attachment.attachmentId));
 const notApplicable=(input.notApplicable??[]).map(item=>{
  if(!['dismiss','adverse'].includes(item.category)||typeof item.reason!=='string'||item.reason.trim().length<60||!item.images?.length||item.images.some(id=>!available.has(id)))throw new Error('An inapplicable dismiss/adverse category needs a specific explanation (60+ characters) and actual current observed image IDs; it cannot waive an existing window, input or required behavior.');
  if(item.category==='dismiss'&&observed.some(c=>c.views?.some(v=>v.layout?.captures?.some(s=>s.scope==='active-surface'))))throw new Error('A real dialog/menu was observed. Test its dismiss/back/Escape/reopen behavior instead of declaring it inapplicable.');
  if(item.category==='adverse'&&observed.some(c=>c.views?.some(v=>/(?:^|\n)\s*-\s*(?:textbox|combobox|spinbutton|searchbox)\b/.test((v.initialOutline??'')+'\n'+(v.finalOutline??''))||v.steps?.some(s=>['fill','select','check'].includes(s.kind)))))throw new Error('Actual input controls were observed. Invent and execute a relevant invalid/empty/recovery scenario instead of waiving adverse behavior.');
  return {category:item.category,reason:item.reason.trim(),images:[...new Set(item.images)],revision:run.revision};
 });
 if(!scenarios.some(s=>s.category==='primary'))throw new Error('Test the primary user journey; a screenshot-only or dismiss-only plan is insufficient.');
 if(task.autoUserProbe||task.scope!=='increment'){
  if(!scenarios.some(s=>s.category==='dismiss')&&!notApplicable.some(s=>s.category==='dismiss'))throw new Error('Plan opening/closing/back/Escape/reopen for observed windows, or evidence why no dismissible surface exists.');
  if(!scenarios.some(s=>['negative','recovery'].includes(s.category))&&!notApplicable.some(s=>s.category==='adverse'))throw new Error('Invent an applicable negative/recovery scenario, or document with current evidence why none exists in this slice.');
 }
 task.userJourneys={scenarios,notApplicable};return task.userJourneys;
}
export function userJourneyStatus(run,task){
 const plan=task.userJourneys;
 return {taskId:task.id,planned:!!plan,scenarios:(plan?.scenarios??[]).map(scenario=>{
  const checks=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision&&c.taskId===task.id&&c.capturedBy===task.assignee&&c.scenarioId===scenario.id&&c.scenarioKey===scenarioKey(scenario)&&run.viewports.every(viewport=>c.views?.some(v=>v.viewport===viewport&&exercised(v,scenario.category))));
  return {...scenario,passed:checks.length>0,checkIds:checks.map(c=>c.id),requiredTrace:scenario.category==='dismiss'?'Assert the same surface visible/expanded, act to close, assert hidden/collapsed, act to reopen, assert visible/expanded again.':'Actually act, then assert the expected observable outcome on every planned viewport.'};
 }),notApplicable:plan?.notApplicable??[]};
}
export function validateUserJourneys(run,task){
 if(!run.userTestingPolicy||run.kind!=='ui'||!(task.kind==='user-review'||task.kind==='review'&&task.scope!=='increment'&&task.reviewFocus!=='source'))return;
 const status=userJourneyStatus(run,task);
 if(!status.planned)throw new Error('User acceptance needs your own executed UI scenarios. First use gvs_user_testing action:plan, then gvs_browser_check scenarioId with real actions and assertions. A colleague’s screenshots or a written plan cannot prove working windows.');
 const missing=status.scenarios.filter(s=>!s.passed).map(s=>s.id);
 if(missing.length)throw new Error(`User scenarios lack current successful interaction AND assertion evidence on every planned viewport: ${JSON.stringify(missing)}. Read gvs_user_testing action:status and execute the actual UI; do not claim pass from screenshots.`);
 if(status.notApplicable.some(s=>s.revision!==run.revision))throw new Error('Reassess inapplicable UI categories against the current source and fresh screenshots.');
}

const uiFile=file=>/\.(?:[jt]sx?|css|scss|sass|less|html|vue|svelte|svg|png|jpe?g|webp)$/i.test(file)&&!/^(?:artifacts|test-results|playwright-report|node_modules|dist|build)\//i.test(file.replaceAll('\\','/'));
const uiWork=task=>task.kind==='work'&&(task.codePlan?.changes?.some(c=>uiFile(c.path))||!task.codePlan&&(task.writeScopes??['*']).some(s=>s==='*'||/^(?:src|public|app|web|frontend)(?:\/|$)|(?:^|\/)[^/]*(?:-ui|-web)(?:\/|$)/i.test(s)));
export function userProbeInput(run){
 if(run.kind!=='ui'||!run.userTestingPolicy||run.status!=='running'||!run.preview?.url||run.analysis?.state!=='ready'||run.tasks.some(t=>t.kind==='brief'&&t.state!=='done')||!run.roles.some(r=>r.name==='user'&&r.sessionId&&!r.retired))return null;
 const seen=new Set(run.userTestingSeen??[]),work=run.tasks.filter(t=>t.state==='done'&&t.result?.verdict==='pass'&&uiWork(t)&&!seen.has(t.id));
 if(!run.userTestingInitial&&!work.length)return null;
 const roots=new Set(['src','public']);for(const task of run.tasks.filter(t=>t.state==='done'))for(const change of task.codePlan?.changes??[])if(uiFile(change.path))roots.add(change.path.replaceAll('\\','/').split('/')[0]);
 return {title:'Пользователь: проверить работающий интерфейс и окна',instructions:`${USER_TESTING}\nTest the currently runnable product now, including actual windows and their controls. This is an automatic ongoing exploration after ${work.map(t=>t.id).join(', ')||'activating live User testing'}. Inspect the ordinary public entry, derive scenarios from actual visible UI and the human goal, and return concrete expected/actual failures immediately. Do not claim final parity, scope completion or authorize external operations. Preserve all outstanding requirements.`,assignee:'user',kind:'user-review',scope:'increment',analysisIds:[],readScopes:[...roots],writeScopes:[],resources:[],priority:95,autoUserProbe:true,userProbeFor:work.map(t=>t.id),dependsOn:[]};
}
