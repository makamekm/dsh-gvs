import path from 'node:path';
export function isReportFile(file){
 const value=file.replaceAll('\\','/').toLowerCase(),name=path.posix.basename(value);
 return /\.(md|txt|log)$/.test(name)&&(/^(artifacts|test-results|playwright-report)\//.test(value)||/^(handoff|integration|notes|checkpoint)([-_.].*)?\.(md|txt|log)$/.test(name));
}
// Discover real files, never derive a filename such as HANDOFF.md from prose.
export async function taskArtifacts(task,io,{maxEntries=160,maxDepth=4}={}){
 const files=new Set(),missing=new Set(),warnings=[],seen=new Set();let scanned=0,truncated=task.writtenFilesTruncated===true;
 const candidates=[...(task.codePlan?.changes??[]).map(item=>item.path),...(task.writtenFiles??[]),...(task.writeScopes??[]).filter(scope=>scope!=='*')];
 async function walk(file,depth){
  const value=file.replaceAll('\\','/').replace(/\/\*\*$/,'').replace(/\/+$/,'');
  if(!value||seen.has(value)||path.isAbsolute(value)||/^[a-z]:/i.test(value)||value.split('/').includes('..'))return;
  seen.add(value);if(++scanned>maxEntries){truncated=true;return;}
  let info;try{info=await io.stat(value);}catch(error){if(['ENOENT','FS_NOT_FOUND'].includes(error.code)){missing.add(value);return;}warnings.push({path:value,error:error.message});return;}
  if(!info){missing.add(value);return;}
  if(info.type==='file'){files.add(value);return;}
  if(info.type!=='directory'){warnings.push({path:value,error:'Not following a non-regular artifact entry'});return;}
  if(depth>=maxDepth){truncated=true;return;}
  try{for(const child of await io.list(value)){if(scanned>=maxEntries){truncated=true;break;}await walk(value+'/'+child.name,depth+1);}}catch(error){warnings.push({path:value,error:error.message});}
 }
 for(const candidate of candidates.sort((a,b)=>Number(!/^(artifacts|test-results|playwright-report)[\\/]/i.test(a))-Number(!/^(artifacts|test-results|playwright-report)[\\/]/i.test(b)))){if(scanned>=maxEntries){truncated=true;break;}await walk(candidate,0);}
 return {taskId:task.id,state:task.state,files:[...files].sort(),missing:[...missing].filter(value=>!files.has(value)),warnings,truncated,next:task.state==='running'?'Producer is still working; only files listed here currently exist.':'Read the actual listed paths or the structured task result; do not invent report filenames.'};
}
