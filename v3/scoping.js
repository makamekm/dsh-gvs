// Per-agent prompt and tool scoping. Smaller local models follow a short, role-specific prompt and a
// small tool set far better than the whole coordinator manual: every agent sees only what its role and
// the project's actual surfaces can use. Hidden tools stay registered; runtime guards still decide.
import {COMMON,VERIFY_POLICY,USER,GAME} from './prompts.js';

export const LEAD_ONLY_TOOLS=['gvs_run','gvs_finish','gvs_resume','gvs_recover','gvs_pause','gvs_parallel','gvs_wait','gvs_checkpoint'];
const MCP_RESOURCES=['list_mcp_resources','read_mcp_resource','list_mcp_resource_templates'];
const WEB_TOOLS=['gvs_browser_check','gvs_responsive','gvs_user_testing','gvs_browser_capabilities'];
const QA_ONLY=['gvs_responsive','gvs_user_testing'];
const GAME_TOOLS=['gvs_game_check','gvs_native_game_check'];
const RENDERED_TOOLS=['gvs_visual','read_image'];
const MUTATING=['write','edit','pwsh','bash','gvs_plan_check','gvs_preview','gvs_native_game_check'];
const desktop=name=>name.startsWith('mcp__desktop__');
const browserDebug=name=>name.startsWith('browser_');

// Actual surfaces from project metadata; null when they are unknown and nothing may be hidden by surface.
export function projectSurfaces(run){
 const declared=run?.qaTarget?.surfaces??[],surfaces=declared.filter(surface=>surface!=='code-or-unknown');
 // The coordinator declared a code task and inspection found no rendered surface: nothing to click or render.
 if(!surfaces.length)return run?.kind==='code'&&declared.length?{web:false,native:false,game:false,rendered:false}:null;
 const game=run.kind?.startsWith('game')||surfaces.includes('native-game');
 return {web:surfaces.includes('web'),native:surfaces.includes('native-ui')||surfaces.includes('native-game'),game,rendered:game||surfaces.some(surface=>['web','native-ui','native-game'].includes(surface))};
}
function surfaceAllows(name,surfaces){
 if(!surfaces)return true;
 if(desktop(name))return surfaces.native;
 if(GAME_TOOLS.includes(name))return surfaces.game;
 if(WEB_TOOLS.includes(name)||browserDebug(name))return surfaces.web;
 if(name==='gvs_visual')return surfaces.rendered;
 return true;
}
// lead: the top-level coordinator; role/task: the teammate's persistent role and its running task.
export function toolVisible(name,{lead=false,run=null,role=null,task=null}={}){
 if(lead)return (name!=='gvs_checkpoint'||!!run?.marathon)&&surfaceAllows(name,projectSurfaces(run));
 if(LEAD_ONLY_TOOLS.includes(name)||MCP_RESOURCES.includes(name))return false;
 if(!role)return true;
 const capability=role.capability;
 if(name==='gvs_plan_check')return ['edit','verify'].includes(capability)&&(run?.requireCoordinatorPlan===true||!!task?.codePlan);
 if(name==='gvs_analysis'&&!['user','verify'].includes(capability))return false;
 if(['read','user'].includes(capability)&&MUTATING.includes(name))return false;
 if(capability==='read'&&(QA_ONLY.includes(name)||name==='gvs_browser_check'||name==='gvs_game_check'||desktop(name)||browserDebug(name)))return false;
 if(capability==='edit'&&(QA_ONLY.includes(name)||browserDebug(name)))return false;
 if(task?.reviewFocus==='source'&&(WEB_TOOLS.includes(name)||GAME_TOOLS.includes(name)||RENDERED_TOOLS.includes(name)||desktop(name)||browserDebug(name)))return false;
 return surfaceAllows(name,projectSurfaces(run));
}

// Teammates only list and complete their own tasks (other actions are forwarded proposals); they get a
// gvs_task schema without the coordinator's planning fields and with review fields only where they apply.
const TEAMMATE_TASK_FIELDS=['action','taskId','offset','limit','verdict','summary','findings','minorFindings','followUps','observations','checks','images','simple','scopePreserved'];
const REVIEW_TASK_FIELDS=['scopeReviewed','coveredRequirements','addressedIssues','inventory','analysisReports','historicalAnalysisReports','adapterReviewed','visualReview'];
export function teammateTaskSchema(parameters,{role=null,run=null}={}){
 const capability=role?.capability,keep=new Set(TEAMMATE_TASK_FIELDS);
 if(capability!=='edit')for(const field of REVIEW_TASK_FIELDS)keep.add(field);
 else{keep.add('addressedIssues');keep.add('coveredRequirements');}
 if(capability==='read')keep.delete('visualReview');
 const surfaces=projectSurfaces(run);if(surfaces&&!surfaces.rendered)keep.delete('visualReview');
 const properties=Object.fromEntries(Object.entries(parameters.properties??{}).filter(([key])=>keep.has(key)));
 if(properties.action)properties.action={...properties.action,enum:['list','complete']};
 return {...parameters,properties,required:(parameters.required??[]).filter(key=>keep.has(key))};
}
// Guidance that other plugins add for desktop or browser tools this scope cannot see; GVS sections stay.
const DESKTOP_GUIDANCE=/mcp__desktop__|desktop tools|Computer Use|real browser or PC/i,BROWSER_GUIDANCE=/browser tools|\bbrowser_[a-z]+|browser lane/i;
export function scopeSections(sections,tools){
 const desktopVisible=tools.some(tool=>desktop(tool.name)),browserVisible=tools.some(tool=>browserDebug(tool.name));
 return sections.filter(section=>{
  if(section.name?.startsWith('gvs-')||typeof section.text!=='string')return true;
  const families=[DESKTOP_GUIDANCE.test(section.text)&&'desktop',BROWSER_GUIDANCE.test(section.text)&&'browser'].filter(Boolean);
  return !families.length||families.some(family=>family==='desktop'?desktopVisible:browserVisible);
 });
}
export function scopeTools(tools,scope){
 return tools.filter(tool=>toolVisible(tool.name,scope)).map(tool=>!scope.lead&&tool.name==='gvs_task'&&tool.parameters?{...tool,parameters:teammateTaskSchema(tool.parameters,scope)}:tool);
}

// Stable role policy, delivered once in the teammate's system prompt instead of repeated in every assignment.
export function rolePolicy(run,role){
 if(!role)return COMMON;
 return [COMMON,role.capability==='edit'?'':VERIFY_POLICY,`ROLE ${role.name}: ${role.title}\nPURPOSE: ${role.purpose??''}\nCAPABILITY: ${role.capability}`,role.capability==='user'?USER:role.instructions??'',run?.kind?.startsWith('game')?GAME:''].filter(Boolean).join('\n');
}
