import {createHash} from 'node:crypto';
import {validateUserJourneys} from './journeys.js';

export const VISUAL_CHECKS=['overlap','clipping','spacing','alignment','readability','responsive','interaction'];

// Executed in the actual rendered page, not against JSX or a test-only layout.
export function collectLayout(){
 const controls='button,[role=button],input,textarea,select,a[href],[role=textbox]';
 const visible=el=>{const r=el.getBoundingClientRect();if(!(r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight)||el.closest('[hidden],[inert],[aria-hidden=true]'))return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)return false;}return true;};
 const dialogs=[...document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open],[role=menu]')].filter(visible);
 const root=dialogs.at(-1)??document.body,nodes=[],limit=240;
 const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 const key=el=>{const parts=[];for(let e=el;e&&e!==document.documentElement&&parts.length<12;e=e.parentElement){if(e.id){parts.unshift('#'+e.id);break;}const ui=e.getAttribute('data-ui'),index=e.parentElement?[...e.parentElement.children].indexOf(e)+1:1;parts.unshift((ui?'[data-ui='+JSON.stringify(ui)+']':e.tagName.toLowerCase())+':nth-child('+index+')');}return parts.join('>');};
 function add(el,type,bounds,label,suffix=''){
  if(nodes.length>=limit||!visible(el))return;
  const ancestors=[];let surface=null,clip=null;
  for(let p=el.parentElement;p;p=p.parentElement){
   const s=getComputedStyle(p),r=rect(p);ancestors.push(key(p));
   if(!surface&&p!==document.body&&(s.backgroundColor!=='rgba(0, 0, 0, 0)'&&s.backgroundColor!=='transparent'||parseFloat(s.borderTopWidth)>0))surface={key:key(p),rect:r};
   if((s.overflowX==='hidden'||s.overflowX==='clip'||s.overflowY==='hidden'||s.overflowY==='clip')&&r.width>0&&r.height>0){
    const next={x:s.overflowX==='hidden'||s.overflowX==='clip'?r.x:-1e7,y:s.overflowY==='hidden'||s.overflowY==='clip'?r.y:-1e7,right:s.overflowX==='hidden'||s.overflowX==='clip'?r.x+r.width:1e7,bottom:s.overflowY==='hidden'||s.overflowY==='clip'?r.y+r.height:1e7};
    clip=clip?{x:Math.max(clip.x,next.x),y:Math.max(clip.y,next.y),right:Math.min(clip.right,next.right),bottom:Math.min(clip.bottom,next.bottom)}:next;
   }
   if(p===root)break;
  }
  let hitBlocked=false;
  if(type==='control'&&!el.matches(':disabled,[aria-disabled=true]')&&getComputedStyle(el).pointerEvents!=='none'){
   const x=bounds.x+bounds.width/2,y=bounds.y+bounds.height/2;
   if(x>=0&&x<innerWidth&&y>=0&&y<innerHeight){const top=document.elementFromPoint(x,y);hitBlocked=!!top&&!el.contains(top)&&top!==el;}
  }
  nodes.push({key:key(el)+suffix,elementKey:key(el),ancestors,type,label:(label??'').trim().slice(0,90),rect:bounds,surface,clip,hitBlocked});
 }
 for(const el of root.querySelectorAll(controls))add(el,'control',rect(el),el.getAttribute('aria-label')||el.textContent||el.getAttribute('placeholder'));
 for(const el of root.querySelectorAll('img,svg,[role=img]'))if(!el.parentElement?.closest('img,svg,[role=img]'))add(el,'image',rect(el),el.getAttribute('alt')||el.getAttribute('aria-label')||el.getAttribute('data-ui')||el.tagName);
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node,seen=0;
 while((node=walker.nextNode())&&seen++<3000){
  const el=node.parentElement;if(!el||node.textContent.trim().length<2||el.closest('script,style,noscript,svg,[role=img]')||!visible(el))continue;
  const range=document.createRange();range.selectNodeContents(node);const r=range.getBoundingClientRect();
  if(r.width>1&&r.height>1)add(el,'text',{x:r.x,y:r.y,width:r.width,height:r.height},node.textContent,':text'+[...el.childNodes].indexOf(node));
 }
 return {schema:'gvs.layout/1',viewport:{width:innerWidth,height:innerHeight},scope:root===document.body?'page':'active-surface',nodes,truncated:nodes.length>=limit||seen>=3000};
}

export function analyzeLayout(snapshot){
 const warnings=[],add=(kind,nodes,metrics)=>warnings.push({kind,targets:nodes.map(n=>({key:n.key,label:n.label,type:n.type,rect:n.rect})),metrics});
 for(const n of snapshot.nodes){
  const r=n.rect,c=n.clip;
  if(c&&(r.x<c.x-2||r.y<c.y-2||r.x+r.width>c.right+2||r.y+r.height>c.bottom+2))add('clipping',[n],{clip:c});
  if(n.hitBlocked)add('occluded-control',[n],{centerHitBlocked:true});
  if(n.type==='text'&&n.surface){
   const s=n.surface.rect,gaps={left:r.x-s.x,right:s.x+s.width-r.x-r.width,top:r.y-s.y,bottom:s.y+s.height-r.y-r.height};
   if(Object.values(gaps).some(gap=>gap>=-1&&gap<4))add('edge-spacing',[n],{surface:n.surface.key,gaps});
  }
 }
 for(let i=0;i<snapshot.nodes.length;i++)for(let j=i+1;j<snapshot.nodes.length;j++){
  const a=snapshot.nodes[i],b=snapshot.nodes[j];
  if(a.elementKey===b.elementKey||a.ancestors.includes(b.elementKey)||b.ancestors.includes(a.elementKey))continue;
  const width=Math.min(a.rect.x+a.rect.width,b.rect.x+b.rect.width)-Math.max(a.rect.x,b.rect.x),height=Math.min(a.rect.y+a.rect.height,b.rect.y+b.rect.height)-Math.max(a.rect.y,b.rect.y);
  if(width>2&&height>2&&width*height>Math.min(a.rect.width*a.rect.height,b.rect.width*b.rect.height)*.05)add('overlap',[a,b],{width,height,area:width*height});
 }
 return warnings;
}

export function addLayoutCapture(view,snapshot,{imageId,stage,url}){
 view.layout??={schema:'gvs.layout/1',captures:[],warnings:[],truncated:false};
 const audit=view.layout;const ids=[];
 for(const warning of analyzeLayout(snapshot)){
  const id='layout-'+createHash('sha256').update(JSON.stringify([url,view.viewport,warning.kind,warning.targets.map(n=>[n.key,Object.values(n.rect).map(v=>Math.round(v))])])).digest('hex').slice(0,18);ids.push(id);
  const previous=audit.warnings.find(w=>w.id===id);
  if(previous){if(!previous.images.includes(imageId))previous.images.push(imageId);continue;}
  if(audit.warnings.length>=24){audit.truncated=true;continue;}
  audit.warnings.push({id,...warning,images:[imageId]});
 }
 audit.truncated ||= snapshot.truncated;
 audit.captures.push({stage,imageId,scope:snapshot.scope,warningIds:[...new Set(ids)].filter(id=>audit.warnings.some(w=>w.id===id))});
}

export function visualStates(run,task){
 const checks=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision),states=new Map();
 for(const check of checks)for(const view of check.views??[])for(const capture of view.layout?.captures??[]){
  const image=check.images.find(i=>i.attachment.attachmentId===capture.imageId);if(!image)continue;
  const state=states.get(capture.imageId)??{imageId:capture.imageId,image,contexts:[]};
  state.contexts.push({taskId:check.taskId,capturedBy:check.capturedBy,scenario:check.scenario,viewport:view.viewport,stage:capture.stage,scope:capture.scope,warningIds:capture.warningIds??[],truncated:view.layout.truncated===true});states.set(capture.imageId,state);
 }
 const required=new Set([...(task.receivedImages??[]),...checks.filter(c=>c.taskId===task.id).flatMap(c=>c.images).map(i=>i.attachment.attachmentId)]);
 return [...states.values()].filter(state=>required.has(state.imageId));
}

export function validateVisualReview(run,task,result){
 if(task.reviewFocus==='source'&&task.kind==='review'&&task.scope==='increment'&&Array.isArray(task.analysisIds)&&task.analysisIds.length===0)return [];
 if(!run.visualPolicy||!run.visualRequired||!['review','design-review','user-review'].includes(task.kind)||result.verdict!=='pass')return [];
 const review=result.visualReview;
 if(!review||VISUAL_CHECKS.some(id=>!review.checked?.includes(id)))throw new Error('Visual acceptance needs visualReview.checked: overlap, clipping, spacing, alignment, readability, responsive, interaction. Inspect real screenshots and states, not test totals or JSX.');
 const selected=new Set(result.images??[]),received=new Set(task.receivedImages??[]);
 const checks=run.visualChecks.filter(c=>c.ok&&c.revision===run.revision);
 const images=checks.flatMap(c=>c.images).filter(i=>selected.has(i.attachment.attachmentId)&&(received.has(i.attachment.attachmentId)||checks.some(c=>c.capturedBy===task.assignee&&c.images.some(image=>image.attachment.attachmentId===i.attachment.attachmentId))));
 if(!run.viewports.every(viewport=>images.some(i=>i.viewport===viewport)))throw new Error('Both QA and User must cite actual received current images for every planned viewport.');
 const audits=checks.flatMap(c=>c.views??[]).map(v=>v.layout).filter(Boolean);
 const audited=new Set(audits.flatMap(a=>a.captures.map(c=>c.imageId)));
 if(audits.some(a=>a.truncated&&a.captures.some(c=>selected.has(c.imageId)))&&(review.manualCoverage?.trim().length??0)<40)throw new Error('The automatic scan was bounded. Describe actual manualCoverage of the remaining pixels/states with screenshot evidence; do not equate a truncated scan with no defects.');
 if(run.kind==='ui'&&!run.viewports.every(viewport=>images.some(i=>i.viewport===viewport&&audited.has(i.attachment.attachmentId))))throw new Error('Capture fresh screenshots with the rendered layout audit; old image IDs alone cannot attest the new visual checks.');
 const required=visualStates(run,task),missing=required.filter(state=>!selected.has(state.imageId));
 if(missing.length)throw new Error(`Inspect all supplied/captured audited states, including initial dialogs and intermediate states; do not select only the clean final screenshot. Missing ${missing.length} of ${required.length} required images. Exact missing IDs (first 6): ${JSON.stringify(missing.slice(0,6).map(state=>({imageId:state.imageId,viewport:state.image.viewport,stages:[...new Set(state.contexts.map(c=>c.stage))]})))}. Read existing pixels with gvs_visual action:states taskId:${task.id}, imageId:<exact ID>, or offset/limit pages. Copy its literal imageIds into complete.images after inspection; do not guess hashes or recapture journeys to fix a citation error.`);
 const warnings=new Map();for(const audit of audits)for(const warning of audit.warnings)if(warning.images.some(id=>selected.has(id))){const previous=warnings.get(warning.id);warnings.set(warning.id,{...warning,images:[...new Set([...(previous?.images??[]),...warning.images])]});}
 const external=[];
 for(const warning of warnings.values()){
  const assessment=review.assessments?.find(a=>a.warningId===warning.id);
  if(!assessment||!warning.images.includes(assessment.imageId)||!selected.has(assessment.imageId)||(assessment.reason?.trim().length??0)<20)throw new Error(`Classify ${warning.id} (${warning.kind}) using its actual screenshot and a specific reason. Bounding boxes are candidates; intentional layering needs visible-pixel and hit-area justification.`);
  if(assessment.disposition==='defect')throw new Error(`Unfixed visual defect ${warning.id}: use revise/findings and repair plus independent recheck, not pass.`);
  if(assessment.disposition==='outside-scope'){
   if(task.scope!=='increment')throw new Error('A full review cannot move a visual defect outside the human goal. Return revise/findings.');
   external.push(`${warning.kind}: ${warning.targets.map(t=>t.label||t.key).join(' / ')}. ${assessment.reason} Evidence: ${assessment.imageId}`);
  }else if(assessment.disposition!=='intentional')throw new Error(`Unknown disposition for ${warning.id}`);
 }
 validateUserJourneys(run,task);
 return external;
}

export function visualReviewAccepted(run,task){try{validateVisualReview(run,task,task?.result??{});return !!task;}catch{return false;}}

export function visualAuditStatus(run){
 if(!run.visualPolicy||!run.visualRequired)return {ready:true,legacy:true,warnings:[]};
 const map=new Map();
 for(const check of run.visualChecks.filter(c=>c.ok&&c.revision===run.revision))for(const view of check.views??[])for(const warning of view.layout?.warnings??[]){
  const previous=map.get(warning.id);map.set(warning.id,{...warning,viewport:view.viewport,images:[...new Set([...(previous?.images??[]),...warning.images])]});
 }
 const reviews=run.tasks.filter(t=>t.reviewFocus!=='source'&&t.state==='done'&&t.result?.verdict==='pass'&&t.result.revision===run.revision&&['review','design-review','user-review'].includes(t.kind)&&visualReviewAccepted(run,t));
 const approved=(warning,role)=>reviews.some(t=>(role==='user'?t.assignee==='user':run.roles.some(r=>r.name===t.assignee&&r.capability==='verify'))&&t.result.visualReview?.assessments?.some(a=>a.warningId===warning.id&&a.disposition==='intentional'&&warning.images.includes(a.imageId)&&a.reason?.trim().length>=20));
 const warnings=[...map.values()].map(w=>({...w,qaReviewed:approved(w,'qa'),userReviewed:approved(w,'user')}));
 return {ready:warnings.every(w=>w.qaReviewed&&w.userReviewed),total:warnings.length,warnings};
}
