import {createHash} from 'node:crypto';
import {exercised,scenarioKey} from './journeys.js';
import {validateVisualReview} from './visual.js';

export const RESPONSIVE_TESTING='For assigned UI QA/design/User REVIEW tasks only (never briefs/consultations, editing or source-only tasks), use gvs_responsive status, check and review. Work through the current device/parameter/CSS-boundary matrix in batches of at most two cases. Observe first, then replay real journeys with actionsByCase when controls differ. Personally inspect every returned initial/intermediate/error/final frame and classify its warning candidates using review; these saved reviews avoid reciting hundreds of image IDs in the final task completion. A failed or stale capture is not proof. Report defects immediately with review verdict:revise and findings; do not wait for the entire matrix. Emulation is not a real phone, and bundled WebKit is not certification on physical Safari. Missing browser engines and untested conditions must remain explicit.';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const preset=(id,width,height,extra={})=>({id,name:width<1100?'mobile':'desktop',width,height,deviceScaleFactor:width<1100?2:1,isMobile:width<1100,hasTouch:width<1100,colorScheme:'light',reducedMotion:'no-preference',contrast:'no-preference',forcedColors:'none',rootFontScale:1,...extra});
export const DEVICE_CASES=[
 preset('phone-small',320,568),preset('phone-compact',360,800,{deviceScaleFactor:3}),preset('phone-standard',390,844,{deviceScaleFactor:3}),preset('phone-large',430,932,{deviceScaleFactor:3}),preset('phone-wide',480,960),preset('foldable-inner',575,900),
 preset('phone-landscape',844,390),preset('tablet-portrait',768,1024),preset('tablet-landscape',1024,768),preset('desktop-short',1280,720),preset('desktop-standard',1440,960),preset('desktop-large',1920,1080),
 preset('desktop-touch',1280,800,{name:'desktop',isMobile:false,hasTouch:true}),preset('phone-dark',390,844,{colorScheme:'dark'}),preset('desktop-dark',1440,960,{colorScheme:'dark'}),preset('phone-reduced-motion',390,844,{reducedMotion:'reduce'}),preset('desktop-reduced-motion',1440,960,{reducedMotion:'reduce'}),
 preset('desktop-keyboard',1280,720,{inputMode:'keyboard'}),preset('phone-keyboard',390,844,{inputMode:'keyboard'}),
 preset('phone-font-150',390,844,{rootFontScale:1.5}),preset('phone-font-200',390,844,{rootFontScale:2}),preset('desktop-font-200',1280,720,{rootFontScale:2}),preset('phone-high-contrast',390,844,{contrast:'more'}),preset('desktop-forced-colors',1280,720,{forcedColors:'active'}),
 preset('phone-font-failure',390,844,{blockFonts:true}),preset('phone-image-failure',480,960,{blockImages:true}),preset('phone-slow-requests',390,844,{requestDelayMs:150}),preset('phone-offline-after-load',390,844,{offlineAfterLoad:true}),preset('phone-short-available-height',390,420,{condition:'Short available viewport; not an actual OS virtual keyboard'})
];

// Executed inside the page. Cross-origin stylesheets cannot be silently treated
// as fully inspected. Values in em/rem use the browser media-query base of 16px.
export function collectResponsiveHints(){
 const widths=new Set(),heights=new Set(),unreadable=[],media=new Set();let rulesSeen=0,truncated=false;
 const visit=rules=>{for(const rule of rules){if(++rulesSeen>20000){truncated=true;return;}
  const query=rule.media?.mediaText??rule.conditionText??'';
  if(query){media.add(query);const add=(axis,value,unit)=>{const number=Number(value)*(unit.toLowerCase()==='px'?1:16);if(Number.isFinite(number))(axis.toLowerCase()==='width'?widths:heights).add(Math.round(number));};for(const match of query.matchAll(/(?:min|max)-(width|height)\s*:\s*([\d.]+)(px|em|rem)/gi))add(match[1],match[2],match[3]);for(const match of query.matchAll(/\b(width|height)\s*[<>]=?\s*([\d.]+)(px|em|rem)/gi))add(match[1],match[2],match[3]);for(const match of query.matchAll(/([\d.]+)(px|em|rem)\s*[<>]=?\s*(width|height)\b/gi))add(match[3],match[1],match[2]);}
  if(rule.cssRules)visit(rule.cssRules);
 }};
 for(const sheet of document.styleSheets)try{visit(sheet.cssRules);}catch{unreadable.push(sheet.href??'inline stylesheet');}
 return {widths:[...widths].sort((a,b)=>a-b),heights:[...heights].sort((a,b)=>a-b),media:[...media].slice(0,100),unreadable:unreadable.slice(0,20),truncated};
}
export function mergeResponsiveHints(run,hints){
 const current=run.responsiveHints?.revision===run.revision?run.responsiveHints:{};
 run.responsiveHints={revision:run.revision,widths:[...new Set([...(current.widths??[]),...(hints?.widths??[])])].sort((a,b)=>a-b),heights:[...new Set([...(current.heights??[]),...(hints?.heights??[])])].sort((a,b)=>a-b),unreadable:[...new Set([...(current.unreadable??[]),...(hints?.unreadable??[])])],truncated:current.truncated||hints?.truncated||false};
}
export function responsiveMatrix(run){
 const hints=run.responsiveHints?.revision===run.revision?run.responsiveHints:{},base=DEVICE_CASES.map(c=>({...c})),omitted=[];
 for(const [axis,values] of [['width',hints.widths??[]],['height',hints.heights??[]]])for(const boundary of values)for(const delta of [-1,0,1]){
  const value=boundary+delta;if(value<240||value>(axis==='width'?2560:1600))continue;
  if(base.length>=256){omitted.push({axis,value});continue;}
  base.push(preset(`css-${axis}-${value}`,axis==='width'?value:390,axis==='height'?value:844,{name:axis==='width'&&value>=1100?'desktop':'mobile'}));
 }
 const engines=run.responsiveEngines?.filter(e=>e.available).map(e=>e.engine)??['chromium'];if(!engines.length)engines.push('chromium');
 const priorities=['phone-standard','phone-wide','phone-small','foldable-inner'],priority=c=>{const i=priorities.indexOf(c.id);return i<0?1000:i;};
 const unique=[...new Map(base.map(c=>[c.id,c])).values()].sort((a,b)=>priority(a)-priority(b));
 const unsupportedCombinations=[];
 const cases=engines.flatMap(engine=>unique.flatMap(c=>{
  const features=run.responsiveEngines?.find(e=>e.engine===engine)?.features;
  const unsupported=features&&(c.inputMode==='keyboard'&&features.keyboardNavigation===null?'keyboard navigation':c.forcedColors==='active'&&features.forcedColors===false?'forced colors':c.contrast==='more'&&features.contrast===false?'contrast emulation':c.hasTouch&&features.touch===false?'touch emulation':null);
  if(unsupported){unsupportedCombinations.push({engine,caseId:`${engine}-${c.id}`,reason:`The isolated engine preflight cannot emulate ${unsupported}. Not tested or certified.`});return [];}
  const value={...c,id:`${engine}-${c.id}`,engine,...(c.inputMode==='keyboard'?{keyboardNavigation:features?.keyboardNavigation??'Tab'}:{}),...(engine==='firefox'&&c.isMobile?{isMobile:false,limitations:['Firefox viewport/touch emulation; isMobile is unsupported. This is not an Android device.']}:{}),...(c.rootFontScale!==1?{fontCondition:'CSS root-font stress, not browser zoom or OS text autosizing'}:{})};return [{...value,key:digest(value)}];}));
 return {cases,limits:{strategy:'Representative device/parameter combinations plus both sides and exact values of discovered CSS breakpoints; not an exhaustive Cartesian product or physical-device certification.',unavailableEngines:(run.responsiveEngines??[]).filter(e=>!e.available),unsupportedCombinations,unreadableStylesheets:hints.unreadable??[],omittedConditions:omitted,truncated:!!hints.truncated||omitted.length>0,fonts:'Root-font stress does not reproduce every browser zoom/text-autosizing setting.',devices:'No physical OS keyboard, browser chrome/safe-area hardware, native permissions or pinch/multitouch certification. Wheel scrolling is recorded as wheel, not a touch swipe.'}};
}
export function needsResponsive(run,task){return !!run.responsivePolicy&&run.kind==='ui'&&run.visualRequired!==false&&task.reviewFocus!=='source'&&['review','design-review','user-review'].includes(task.kind);}
export function responsiveScenarios(task){return task.userJourneys?.scenarios?.length?task.userJourneys.scenarios:[{id:'current-surface',category:'primary',target:'Current assigned UI surface and its actual controls',expected:'Real actions produce the assigned observable state without layout defects.'}];}
export function responsiveStatus(run,task){
 if(!needsResponsive(run,task))return {required:false,ready:true,completed:0,total:0,missing:[]};
 const matrix=responsiveMatrix(run),scenarios=responsiveScenarios(task),missing=[],grouped=new Map();let completed=0;
 for(const c of run.responsiveChecks??[])if(c.taskId===task.id&&c.capturedBy===task.assignee&&c.revision===run.revision){const key=JSON.stringify([c.caseId,c.caseKey,c.scenarioId,c.scenarioKey]),group=grouped.get(key)??[];group.push(c);grouped.set(key,group);}
 for(const item of matrix.cases)for(const scenario of scenarios){
  const checks=grouped.get(JSON.stringify([item.id,item.key,scenario.id,scenarioKey(scenario)]))??[];
  const accepted=checks.some(c=>c.ok&&c.views?.length===1&&exercised(c.views[0],scenario.category)&&c.views[0].steps?.some(s=>s.passed&&!s.kind.startsWith('assert')&&s.inputEvents?.some(e=>e.trusted))&&c.inspection?.verdict==='pass'&&c.inspection.revision===run.revision);
  if(accepted)completed++;else missing.push({caseId:item.id,scenarioId:scenario.id,reason:checks.some(c=>c.ok)?'Needs own successful interaction trace and explicit visual inspection':'Needs current successful capture and actual journey'});
 }
 return {required:true,ready:missing.length===0&&!matrix.limits.truncated&&!matrix.limits.unreadableStylesheets.length,completed,total:matrix.cases.length*scenarios.length,caseCount:matrix.cases.length,scenarioCount:scenarios.length,missing,limits:matrix.limits};
}
export function validateResponsiveAcceptance(run,task,result){
 if(result.verdict!=='pass')return;
 const status=responsiveStatus(run,task);if(!status.ready)throw new Error(`Responsive acceptance is incomplete: ${status.completed}/${status.total} case/scenario pairs inspected. Read gvs_responsive status, execute check batches, and save review judgements. First missing: ${JSON.stringify(status.missing.slice(0,4))}. ${status.limits?.truncated||status.limits?.unreadableStylesheets.length?'Stylesheet discovery also has explicit coverage gaps; preserve/report them, never label the scan complete.':''} Report observed defects with revise immediately; never create fake passes to fill the matrix.`);
}
export function inspectResponsiveCheck(run,task,check,input){
 if(check.taskId!==task.id||check.capturedBy!==task.assignee||check.revision!==run.revision)throw new Error('Inspect only your own current responsive capture for this assigned task. Stale or another role evidence cannot substitute.');
 if(!['pass','revise'].includes(input.verdict)||!Array.isArray(input.findings)||input.verdict==='pass'&&input.findings.length||input.verdict==='revise'&&!input.findings.length)throw new Error('Responsive review needs pass with findings:[], or revise with concrete defects/blockers.');
 if(input.verdict==='pass'){
  if(!check.ok)throw new Error('A failed responsive capture cannot pass inspection. Preserve failure images, fix the invocation/product and rerun the same case.');
  validateVisualReview({...run,visualPolicy:1,userTestingPolicy:0,visualChecks:[check],viewports:check.views.map(v=>v.viewport)}, {...task,kind:'review',receivedImages:[]},{...input,revision:run.revision});
 }
 check.inspection={verdict:input.verdict,findings:input.findings,images:input.images??[],visualReview:input.visualReview??null,revision:run.revision,at:Date.now()};return check.inspection;
}
export function responsiveRunReady(run){
 if(!run.responsivePolicy||run.kind!=='ui'||run.visualRequired===false)return true;
 const accepted=run.tasks.filter(t=>t.state==='done'&&t.result?.verdict==='pass'&&t.result.revision===run.revision&&needsResponsive(run,t)&&responsiveStatus(run,t).ready);
 return accepted.some(t=>t.assignee==='user')&&accepted.some(t=>run.roles.some(r=>r.name===t.assignee&&r.capability==='verify'));
}
