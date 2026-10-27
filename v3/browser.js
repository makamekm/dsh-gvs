import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {clip} from './protocol.js';
import {collectLayout,addLayoutCapture} from './visual.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// Local project captures must also work in a Windows service without a GPU session.
// Chromium's explicit software GL path; personal browser settings are untouched.
const renderArgs=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'];
export const BROWSER_ACTIONS=['click','fill','select','press','check','scroll','assertText','assertState','assertVisible','assertHidden'];
export const BROWSER_STATES=['checked','pressed','expanded','disabled','invalid','focused','value'];
function pressKey(action){
 const key=action.key??action.value;
 if(typeof key!=='string'||!key.trim()||action.key!=null&&action.value!=null&&action.key!==action.value)throw new Error('press needs a nonempty key string (e.g. key:"Escape"); value is a supported alias and must agree if both are supplied.');
 return key;
}
function expectedState(action){
 if(!BROWSER_STATES.includes(action.state)||action.state==='value'&&typeof action.value!=='string'||action.state!=='value'&&typeof action.value!=='boolean'&&!['true','false'].includes(action.value))throw new Error('assertState needs a supported state; text values are strings, boolean states accept true/false booleans or strings.');
 return action.state==='value'?action.value:typeof action.value==='boolean'?action.value:action.value==='true';
}
export function validateBrowserActions(actions){
 if(!Array.isArray(actions)||actions.length>12)throw new Error('Use at most 12 actions in one reproducible journey.');
 for(const [index,action] of actions.entries()){
  if(!action||!BROWSER_ACTIONS.includes(action.kind))throw new Error(`Unsupported browser action ${JSON.stringify(action?.kind)} at index ${index}. Allowed: ${BROWSER_ACTIONS.join(', ')}. Desktop and phone viewports are already captured automatically; do not add a viewport action.`);
  if(action.kind==='press')pressKey(action);
  if(action.kind==='assertState')expectedState(action);
  if(action.kind==='check'&&action.value!==undefined&&typeof action.value!=='boolean'&&!['true','false'].includes(action.value))throw new Error('check accepts boolean true/false or their string aliases. Omit value to check the box.');
 }
}
export function browserPlans(args){
 const shared=args.actions??[];validateBrowserActions(shared);const by=args.actionsByViewport??{};
 if(typeof by!=='object'||Array.isArray(by)||Object.keys(by).some(key=>!['desktop','mobile'].includes(key)))throw new Error('actionsByViewport accepts only desktop/mobile action arrays. Both viewports remain required.');
 const plans={desktop:by.desktop??shared,mobile:by.mobile??shared};for(const actions of Object.values(plans))validateBrowserActions(actions);return plans;
}
export function phoneContext(version){return {isMobile:true,hasTouch:true,userAgent:`Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Mobile Safari/537.36`};}
export function sameEntry(actual,expected){try{const a=new URL(actual),b=new URL(expected);return a.port===b.port&&a.protocol===b.protocol&&(a.hostname===b.hostname||LOOPBACK.has(a.hostname)&&LOOPBACK.has(b.hostname))&&a.pathname.replace(/\/$/,'')===b.pathname.replace(/\/$/,'')&&a.search===b.search&&a.hash===b.hash;}catch{return false;}}
async function observeCanvas(page){
  await page.addInitScript(()=>{
    const errors=[];Object.defineProperty(window,'__gvsHarnessCanvasErrors',{value:errors});
    for(const type of ['webglcontextlost','contextlost'])window.addEventListener(type,()=>errors.push(`Canvas renderer reported ${type}`),true);
  });
}
async function canvasErrors(page,view){
  for(const message of await page.evaluate(()=>window.__gvsHarnessCanvasErrors??[]))if(!view.errors.includes(message))view.errors.push(message);
}
export function previewURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || ['3080', '18199'].includes(url.port)) {
    throw new Error('Use the project’s local HTTP preview, not Harness, the model server or an external website.');
  }
  return url;
}

async function browserRuntime(config) {
  const candidates = [config.browserModule,
    path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright-core', 'index.mjs')].filter(Boolean);
  for (const filename of candidates) {
    try {const module = await import(pathToFileURL(filename).href); if (module.chromium) return module.chromium;} catch {}
  }
  try {return (await import('playwright-core')).chromium;} catch {}
  throw new Error('Visual verification needs playwright-core. Set browserModule to its installed index.mjs.');
}
async function browserExecutable(config) {
  const candidates = [config.browserExecutable, process.env.GVS_BROWSER_EXECUTABLE,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
  for (const filename of candidates) {try {await fs.access(filename); return filename;} catch {}}
  return undefined;
}

function locator(page, action) {
  if (action.testId) return page.getByTestId(action.testId);
  if (action.label) return page.getByLabel(action.label, {exact: true});
  if (action.role && action.name) return page.getByRole(action.role, {name: action.name, exact: true});
  throw new Error('Target an observed control by role+name, label or testId.');
}
async function perform(page, action) {
  if (action.kind === 'assertText') return page.getByText(action.value, {exact: false}).first().waitFor({state: 'visible'});
  if (action.kind === 'press' && !action.role && !action.label && !action.testId) return page.keyboard.press(pressKey(action));
  if (action.kind === 'scroll') return page.mouse.wheel(0, Number(action.value) || 600);
  const target = locator(page, action);
  if (action.kind === 'assertState') {
    const expected = expectedState(action);
    let actual;
    for (let attempt = 0; attempt < 35; attempt++) {
      actual = await target.evaluate((element, state) => ({
        checked: 'checked' in element ? element.checked : element.getAttribute('aria-checked') === 'true',
        pressed: element.getAttribute('aria-pressed') === 'true', expanded: element.getAttribute('aria-expanded') === 'true',disabled: element.matches(':disabled,[aria-disabled=true]'),invalid: element.getAttribute('aria-invalid') === 'true',
        focused: element === document.activeElement, value: element.value ?? ''
      })[state], action.state);
      if (actual === expected) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Expected ${action.state}=${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}.`);
  }
  if (action.kind === 'click') return target.click();
  if (action.kind === 'fill') return target.fill(action.value);
  if (action.kind === 'select') return target.selectOption(action.value);
  if (action.kind === 'press') return target.press(pressKey(action));
  if (action.kind === 'check') return target.setChecked(action.value !== false && action.value !== 'false');
  if (action.kind === 'assertVisible') return target.waitFor({state: 'visible'});
  if (action.kind === 'assertHidden') return target.waitFor({state: 'hidden'});
  throw new Error(`Unsupported browser action: ${action.kind}`);
}

export async function captureViewport(page){
 const rendered=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await rendered();
 try{return await page.screenshot({type:'jpeg',quality:82,animations:'disabled',timeout:10000});}
 catch(error){
  if(!/Page.captureScreenshot|Unable to capture screenshot/.test(error.message))throw error;
  await rendered();
  return page.screenshot({type:'jpeg',quality:82,animations:'disabled',timeout:10000});
 }
}

export async function captureBrowser(args, {config = {}, signal, saveImage}) {
  const url = previewURL(args.url);
  const plans=browserPlans(args);
  const chromium = await browserRuntime(config);
  signal.throwIfAborted();
  const executablePath = await browserExecutable(config);
  const browser = await chromium.launch({headless: true, args:renderArgs, ...(executablePath ? {executablePath} : {}), timeout: 20000});
  const abort = () => {browser.close().catch(() => {});};
  signal.addEventListener('abort', abort, {once: true});
  const report = {url: url.href, scenario: clip(args.scenario || 'Inspect page layout and controls', 500), ok: true,
    interactions: 0, assertions: 0, images: [], views: []};
  try {
    for (const viewport of [{name: 'desktop', width: 1440, height: 960}, {name: 'mobile', width: 390, height: 844}]) {
      const actions=plans[viewport.name];
      signal.throwIfAborted();
      const context = await browser.newContext({viewport: {width: viewport.width, height: viewport.height},
        ...(viewport.name==='mobile'?phoneContext(browser.version()):{isMobile:false,hasTouch:false}), reducedMotion: 'reduce', serviceWorkers: 'block'});
      const view = {viewport: viewport.name, width: viewport.width, height: viewport.height, errors: [], steps: [], overflow: false};
      const page = await context.newPage();
      await observeCanvas(page);
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => view.errors.push(clip(error.message, 1000)));
      await context.route('**/*', route => {
        try {
          const request = new URL(route.request().url());
          if (['data:', 'blob:', 'about:'].includes(request.protocol)) return route.continue();
          if (LOOPBACK.has(request.hostname) && !['3080', '18199'].includes(request.port)) return route.continue();
        } catch {}
        return route.abort('blockedbyclient');
      });
      try {
        const response = await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 20000});
        if (!response || response.status() >= 400) throw new Error(`Preview returned HTTP ${response?.status() ?? 'no response'}`);
        // Fixed/absolute app shells can render correctly with a zero-height body.
        await page.locator('body').waitFor({state: 'attached'});
        // DOMContentLoaded can precede a dynamic app import. Capture the actual
        // initial UI, without dismissing a dialog or manufacturing an app state.
        await page.waitForFunction(()=>{
          const body=document.body;if(!body)return false;
          return !!body.innerText.trim()||[...body.querySelectorAll('canvas,img,svg,video,input,button,[role]')].some(element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(element).visibility!=='hidden';});
        },undefined,{timeout:15000});
        await page.waitForFunction(()=>document.fonts.status==='loaded',undefined,{timeout:7000});
        Object.assign(view,await page.evaluate(()=>({userAgent:navigator.userAgent,touchPoints:navigator.maxTouchPoints,entryUrl:location.href})),{isMobile:viewport.name==='mobile'});
        const screenshot = async stage => {
          const bytes=await captureViewport(page);
          await canvasErrors(page,view);
          const attachment = await saveImage({data: bytes, mediaType: 'image/jpeg', name: `gvs-${viewport.name}-${stage}.jpg`});
          report.images.push({viewport: viewport.name, stage, attachment});
          addLayoutCapture(view,await page.evaluate(collectLayout),{imageId:attachment.attachmentId,stage,url:url.href});
        };
        view.initialOutline = clip(await page.locator('body').ariaSnapshot(), 6000);
        await screenshot('initial');
        let states=0;view.uncapturedTransitions=0;
        for (const [index,action] of actions.entries()) {
          signal.throwIfAborted();
          try{await perform(page, action);}catch(error){view.steps.push({kind:action.kind,target:action.name??action.label??action.testId??'',value:clip(action.value??action.key,300),...(action.state?{state:action.state}:{}),passed:false,error:clip(error.message,1000)});await screenshot(`failed-step-${index+1}`).catch(()=>{});throw error;}
          const assertion = action.kind.startsWith('assert');
          if (assertion) report.assertions++; else report.interactions++;
          view.steps.push({kind: action.kind, target: action.name ?? action.label ?? action.testId ?? '', value: clip(action.value??action.key, 300), ...(action.state?{state:action.state}:{}), passed: true});
          if(!assertion){if(states++<3)await screenshot(`step-${index+1}`);else view.uncapturedTransitions++;}
        }
        if (actions.length) await screenshot('journey');
        view.uncapturedTransitions=Math.max(0,states-4);
        const dimensions = await page.evaluate(() => ({
          viewport: window.innerWidth, document: document.documentElement.scrollWidth,
          controls: document.querySelectorAll('button,input,select,textarea,a[href]').length
        }));
        view.overflow = dimensions.document > dimensions.viewport + 1;
        view.controls = dimensions.controls;
        view.title = await page.title();
        view.finalOutline = clip(await page.locator('body').ariaSnapshot(), 6000);
        await page.keyboard.press('Tab');
        view.keyboardFocus = await page.locator(':focus').evaluate(element => ({tag: element.tagName, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0,100)})).catch(() => null);
      } catch (error) {
        signal.throwIfAborted();
        view.errors.push(clip(error.message, 1500));
      } finally {await context.close();}
      if (view.errors.length || view.overflow) report.ok = false;
      report.views.push(view);
    }
    return report;
  } finally {
    signal.removeEventListener('abort', abort);
    await browser.close();
  }
}

export function compareProbe(actual,op,expected,tolerance=0.01){
 if(op==='eq')return actual===expected;
 if(typeof actual!=='number'||typeof expected!=='number'||!Number.isFinite(actual)||!Number.isFinite(expected))return false;
 return op==='gt'?actual>expected:op==='gte'?actual>=expected:op==='lt'?actual<expected:op==='lte'?actual<=expected:op==='near'?Math.abs(actual-expected)<=tolerance:false;
}
export function probePath(state,path){
 const keys=String(path).split('.');
 if(keys.length>12||keys.some(key=>['__proto__','constructor','prototype'].includes(key)))throw new Error('Invalid state path');
 return keys.reduce((value,key)=>value?.[key],state);
}
export async function captureGame(args,{config={},signal,saveImage,viewports=['desktop']}){
 const url=previewURL(args.url);url.searchParams.set('gvs_test','1');
 if(!Array.isArray(args.actions)||!args.actions.length||args.actions.length>32)throw new Error('Provide 1–32 real game actions/assertions.');
 const chromium=await browserRuntime(config),executablePath=await browserExecutable(config);
 const browser=await chromium.launch({headless:true,args:renderArgs,...(executablePath?{executablePath}:{}),timeout:20000});
 const abort=()=>{browser.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 const report={url:url.href,scenario:clip(args.scenario,500),ok:true,engine:'',renderMode:'software-angle',coverage:[],interactions:0,assertions:0,advancedFrames:0,images:[],views:[],mode:'browser-runtime'};
 try{
  for(const viewport of viewports){
   const size=viewport==='mobile'?{width:390,height:844}:{width:1280,height:800};
   const context=await browser.newContext({viewport:size,serviceWorkers:'block',reducedMotion:'reduce'});
   await context.route('**/*',route=>{try{const u=new URL(route.request().url());if(['data:','blob:','about:'].includes(u.protocol)||LOOPBACK.has(u.hostname)&&!['3080','18199'].includes(u.port))return route.continue();}catch{}return route.abort();});
   const page=await context.newPage();const view={viewport,...size,overflow:false,errors:[],steps:[]};const covered=new Set();
   await observeCanvas(page);
   page.on('pageerror',error=>view.errors.push(clip(error.message,1000)));
   const state=()=>page.evaluate(async()=>{
    const bridge=window.__gvsGame;
    if(!bridge||bridge.version!==1||typeof bridge.engine!=='string'||typeof bridge.state!=='function'||typeof bridge.step!=='function'||typeof bridge.reset!=='function')throw new Error('A real test-build __gvsGame v1 bridge is required; screenshots alone cannot verify physics.');
    const value=await bridge.state();if(!Number.isFinite(value.tick))throw new Error('Game state needs numeric tick.');return {engine:bridge.engine,state:JSON.parse(JSON.stringify(value))};
   });
   const capture=async stage=>{
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const data=await page.screenshot({type:'jpeg',quality:82,animations:'disabled',timeout:10000});
    await canvasErrors(page,view);
    const attachment=await saveImage({data,mediaType:'image/jpeg',name:`gvs-game-${viewport}-${stage}.jpg`});report.images.push({viewport,stage,attachment});
   };
   try{
    const response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:20000});if(!response||response.status()>=400)throw new Error('Game preview is unavailable.');
    const initial=await state();report.engine=initial.engine;view.initialState=initial.state;await capture('initial');
    for(const action of args.actions){
     signal.throwIfAborted();
     if(action.kind==='reset')await page.evaluate(async scenario=>window.__gvsGame.reset(scenario),action.scenario??'default');
     else if(action.kind==='step'||action.kind==='hold'){
      if(!Number.isInteger(action.frames)||action.frames<1||action.frames>600)throw new Error('Advance 1–600 actual simulation frames.');
      const before=(await state()).state.tick;
      if(action.kind==='hold')await page.keyboard.down(action.key);
      try{await page.evaluate(async frames=>window.__gvsGame.step(frames),action.frames);}finally{if(action.kind==='hold')await page.keyboard.up(action.key);}
      const after=(await state()).state.tick;if(after<before+action.frames)throw new Error('The bridge did not advance actual simulation ticks.');
      report.advancedFrames+=action.frames;
     }else if(action.kind==='press')await page.keyboard.press(action.key);
     else if(action.kind==='pointer'){
      if(!Number.isFinite(action.x)||!Number.isFinite(action.y)||action.x<0||action.x>1||action.y<0||action.y>1)throw new Error('Pointer coordinates are viewport fractions from 0 to 1.');
      await page.mouse.move(action.x*size.width,action.y*size.height);if(action.click)await page.mouse.click(action.x*size.width,action.y*size.height);
     }else if(action.kind==='assert'){
      if(!['collision','gameplay','controls','camera'].includes(action.category))throw new Error('Classify the assertion as collision, gameplay, controls or camera.');
      const actual=probePath((await state()).state,action.path);
      if(!compareProbe(actual,action.op,action.value,action.tolerance))throw new Error(`${action.category}: ${action.path} observed ${JSON.stringify(actual)}, expected ${action.op} ${JSON.stringify(action.value)}.`);
      covered.add(action.category);report.assertions++;
     }else throw new Error(`Unknown game action ${action.kind}`);
     if(action.kind!=='assert')report.interactions++;
     view.steps.push({...action,passed:true});
    }
    view.finalState=(await state()).state;await capture('journey');
    view.overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   }catch(error){signal.throwIfAborted();view.errors.push(clip(error.message,2000));await capture('failure').catch(()=>{});}
   finally{await context.close();}
   view.coverage=[...covered];if(view.errors.length||view.overflow)report.ok=false;report.views.push(view);
  }
  report.coverage=['collision','gameplay','controls','camera'].filter(category=>report.views.every(view=>view.coverage.includes(category)));
  report.ok=report.ok&&report.advancedFrames>0&&report.assertions>0;
  return report;
 }finally{signal.removeEventListener('abort',abort);await browser.close();}
}
