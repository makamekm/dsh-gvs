import {createHash} from 'node:crypto';
import {requiresWebVerification,isRenderedProject,isInteractiveProject} from './project-qa.js';

export const USER_TESTING='USER IS AN ACTIVE PRODUCT TESTER. For a web UI, as soon as a runnable interface exists, exercise it repeatedly after implementation increments. Observe real controls first, invent concrete scenarios, open each affected window, operate its controls, close/back/Escape and reopen it, try invalid/empty inputs or unavailable/loading/recovery paths where applicable, and compare expected vs actual behavior on desktop and phone. Register scenarios incrementally with gvs_user_testing action:plan (upsert by ID). Saved partial plans are runnable immediately; discover and add further scenarios while testing, and satisfy every required category before final acceptance. Then execute gvs_browser_check with the exact scenarioId and semantic actions plus observable assertions. Screenshots, another agent’s tests and a written scenario are not functional evidence. Send concrete failures to Lead immediately; diagnose automation/selector failures separately from product defects. Every confirmed defect needs findings, an owned repair and independent recheck. Do not wait for the entire product or another approval cycle to test the current UI. An exploratory increment is never full acceptance. Other product types keep their appropriate real native/game testing tools. For citation failures read existing gvs_visual action:states pages and copy exact imageIds; do not keep recapturing or invent hashes.';
export const scenarioKey=scenario=>createHash('sha256').update(JSON.stringify(scenario)).digest('hex');
const categories=['primary','dismiss','negative','recovery'];
export function exercised(view,category){
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
 const ids=new Set(),additions=input.scenarios.map(item=>{
  if(!/^[a-z][a-z0-9-]{0,39}$/.test(item.id)||ids.has(item.id))throw new Error('Scenario IDs must be unique lowercase literal IDs.');ids.add(item.id);
  if(!categories.includes(item.category)||['target','expected'].some(key=>typeof item[key]!=='string'||item[key].trim().length<10||item[key].length>1200))throw new Error('Each scenario needs category, the actual observed target/flow and a concrete expected outcome.');
  return {id:item.id,category:item.category,target:item.target.trim(),expected:item.expected.trim()};
 });
 const merged=new Map((task.userJourneys?.scenarios??[]).map(s=>[s.id,s]));for(const item of additions)merged.set(item.id,item);const scenarios=[...merged.values()];
 if(scenarios.length>16)throw new Error('This review already has 16 scenarios. Preserve them and ask Lead to split remaining exploration into an owned review task.');
 const observed=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision&&(c.taskId===task.id||c.images.some(i=>task.receivedImages?.includes(i.attachment.attachmentId))));
 const available=new Set(observed.flatMap(c=>c.images).map(i=>i.attachment.attachmentId));
 const exemptions=(input.notApplicable??[]).map(item=>{
  if(!['dismiss','adverse'].includes(item.category)||typeof item.reason!=='string'||item.reason.trim().length<60||!item.images?.length||item.images.some(id=>!available.has(id)))throw new Error('An inapplicable dismiss/adverse category needs a specific explanation (60+ characters) and actual current observed image IDs; it cannot waive an existing window, input or required behavior.');
  if(item.category==='dismiss'&&observed.some(c=>c.views?.some(v=>v.layout?.captures?.some(s=>s.scope==='active-surface'))))throw new Error('A real dialog/menu was observed. Test its dismiss/back/Escape/reopen behavior instead of declaring it inapplicable.');
  if(item.category==='adverse'&&observed.some(c=>c.views?.some(v=>/(?:^|\n)\s*-\s*(?:textbox|combobox|spinbutton|searchbox)\b/.test((v.initialOutline??'')+'\n'+(v.finalOutline??''))||v.steps?.some(s=>['fill','select','check'].includes(s.kind)))))throw new Error('Actual input controls were observed. Invent and execute a relevant invalid/empty/recovery scenario instead of waiving adverse behavior.');
  return {category:item.category,reason:item.reason.trim(),images:[...new Set(item.images)],revision:run.revision};
 });
 const waiverMap=new Map((task.userJourneys?.notApplicable??[]).map(s=>[s.category,s]));for(const item of exemptions)waiverMap.set(item.category,item);
 const notApplicable=[...waiverMap.values()].filter(item=>item.category==='dismiss'?!scenarios.some(s=>s.category==='dismiss'):!scenarios.some(s=>['negative','recovery'].includes(s.category)));
 task.userJourneys={scenarios,notApplicable};return task.userJourneys;
}
function missingCategories(run,task){
 const scenarios=task.userJourneys?.scenarios??[],waivers=(task.userJourneys?.notApplicable??[]).filter(w=>w.revision===run.revision),missing=[];
 if(!scenarios.some(s=>s.category==='primary'))missing.push('primary');
 if(task.autoUserProbe||task.scope!=='increment'){
  if(!scenarios.some(s=>s.category==='dismiss')&&!waivers.some(w=>w.category==='dismiss'))missing.push('dismiss');
  if(!scenarios.some(s=>['negative','recovery'].includes(s.category))&&!waivers.some(w=>w.category==='adverse'))missing.push('negative-or-recovery');
 }return missing;
}
export function userJourneyStatus(run,task){
 const plan=task.userJourneys;
 return {taskId:task.id,planned:!!plan,missingCategories:missingCategories(run,task),scenarios:(plan?.scenarios??[]).map(scenario=>{
  const checks=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision&&c.taskId===task.id&&c.capturedBy===task.assignee&&c.scenarioId===scenario.id&&c.scenarioKey===scenarioKey(scenario)&&run.viewports.every(viewport=>c.views?.some(v=>v.viewport===viewport&&exercised(v,scenario.category))));
  return {...scenario,passed:checks.length>0,checkIds:checks.map(c=>c.id),requiredTrace:scenario.category==='dismiss'?'Assert the same surface visible/expanded, act to close, assert hidden/collapsed, act to reopen, assert visible/expanded again.':'Actually act, then assert the expected observable outcome on every planned viewport.'};
 }),notApplicable:plan?.notApplicable??[]};
}
export function validateUserJourneys(run,task){
 if(!run.userTestingPolicy||!requiresWebVerification(run)||!(task.kind==='user-review'||task.kind==='review'&&task.scope!=='increment'&&task.reviewFocus!=='source'))return;
 const status=userJourneyStatus(run,task);
 if(!status.planned)throw new Error('User acceptance needs your own executed UI scenarios. First use gvs_user_testing action:plan, then gvs_browser_check scenarioId with real actions and assertions. A colleague’s screenshots or a written plan cannot prove working windows.');
 if(status.missingCategories.length)throw new Error(`User scenario coverage is incomplete: ${JSON.stringify(status.missingCategories)}. Existing scenarios are saved and runnable; add missing categories incrementally with gvs_user_testing action:plan. Reassess stale inapplicability with current evidence. Do not restart the plan or claim pass from a partial exploration.`);
 const missing=status.scenarios.filter(s=>!s.passed).map(s=>s.id);
 if(missing.length)throw new Error(`User scenarios lack current successful interaction AND assertion evidence on every planned viewport: ${JSON.stringify(missing)}. Read gvs_user_testing action:status and execute the actual UI; do not claim pass from screenshots.`);
 if(status.notApplicable.some(s=>s.revision!==run.revision))throw new Error('Reassess inapplicable UI categories against the current source and fresh screenshots.');
}
export function interruptedByLegacyPlan(run,task){
 return run.kind==='ui'&&task.state==='blocked'&&!task.reviewPlanRecovery&&['user-review','review','design-review'].includes(task.kind)&&/^Agent turn ended \(completed\)/.test(task.result?.summary??'')&&!(task.result?.findings?.length)&&
  (run.diagnostics??[]).some(d=>d.taskId===task.id&&d.tool==='gvs_user_testing'&&/Plan opening\/closing|Invent an applicable negative\/recovery|Test the primary user journey/.test(d.message));
}

const uiFile=file=>/\.(?:[jt]sx?|css|scss|sass|less|html|vue|svelte|svg|png|jpe?g|webp|gd|tscn|scn|cs|unity|prefab|cpp|h|umap|uasset|py|rs|go|java|kt|rb)$/i.test(file)&&!/^(?:artifacts|test-results|playwright-report|node_modules|dist|build)\//i.test(file.replaceAll('\\','/'));
const uiWork=task=>task.kind==='work'&&(task.codePlan?.changes?.some(c=>uiFile(c.path))||!task.codePlan&&(task.writeScopes??['*']).some(s=>s==='*'||/^(?:src|public|app|web|frontend)(?:\/|$)|(?:^|\/)[^/]*(?:-ui|-web)(?:\/|$)/i.test(s)));
export function userProbeInput(run){
 const web=requiresWebVerification(run),rendered=isRenderedProject(run),runnable=web?!!run.preview?.url:rendered?run.visualChecks?.some(c=>c.ok&&c.images?.length):run.analysisChecks?.some(c=>c.ok);
 if(!isInteractiveProject(run)||!run.userTestingPolicy||run.status!=='running'||!runnable||run.analysis?.state!=='ready'||run.tasks.some(t=>t.kind==='brief'&&t.state!=='done')||!run.roles.some(r=>r.name==='user'&&r.sessionId&&!r.retired))return null;
 const seen=new Set(run.userTestingSeen??[]),work=run.tasks.filter(t=>t.state==='done'&&t.result?.verdict==='pass'&&uiWork(t)&&!seen.has(t.id));
 if(!run.userTestingInitial&&!work.length)return null;
 const roots=new Set(run.qaTarget?.sourceRoots??['src','public']);for(const task of run.tasks.filter(t=>t.state==='done'))for(const change of task.codePlan?.changes??[])if(uiFile(change.path))roots.add(change.path.replaceAll('\\','/').split('/')[0]);
 const native='NATIVE PRODUCT TESTING: inspect gvs_project. Exercise the actual owned engine/application window using native input tools and inspect current engine/window frames with gvs_visual. Test real controls, scene/space, close/reopen/restart and negative/recovery paths. Ask the assigned verify driver to run real engine commands; do not use browser/DOM matrices or arbitrary shell as a substitute. Missing driver/window access needs an owned adapter task, not a pass.';
 const commands='COMMAND/BOT PRODUCT TESTING: inspect gvs_project and the actual production entry/handlers. Invent own command/event/state/negative/retry/restart/permission scenarios and use the actual owned bot/CLI interaction driver. Inspect real outputs and durable state; a colleague runner report alone is not your interaction. If no safe interactive driver is available, report that exact blocker to Lead so an inferred specialist implements a real adapter. Never substitute a browser/screenshot or an invented conversation, arbitrary shell, or unauthorized external messaging.';
 return {title:web||rendered?'Пользователь: проверить работающий интерфейс и окна':'Пользователь: проверить команды, состояния и восстановление',instructions:`${web?USER_TESTING:rendered?native:commands}\nThis is an automatic ongoing exploration after ${work.map(t=>t.id).join(', ')||'activating live User testing'}. Inspect the actual product entry, derive scenarios from its interface and the human goal, and return concrete expected/actual failures immediately. Do not claim final parity, scope completion or authorize external operations. Preserve all outstanding requirements.`,assignee:'user',kind:'user-review',scope:'increment',analysisIds:[],readScopes:[...roots],writeScopes:[],resources:web?[]:[rendered?'native-window':'product-interaction'],priority:95,autoUserProbe:true,userProbeFor:work.map(t=>t.id),dependsOn:[]};
}
