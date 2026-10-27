const size=content=>Buffer.byteLength(JSON.stringify(content),'utf8');
const imagePart=image=>({type:'image',attachment:image.attachment});
export function assignmentDelivery(text,images,fallback){
 let selected=[...images],content=[{type:'text',text},...selected.map(imagePart)];
 if(size(content)<=120000)return {content,images:selected,compact:false};
 let clipped=Buffer.from(fallback,'utf8').subarray(0,60000).toString('utf8');
 const notice='COMPACT ASSIGNMENT: expanded evidence exceeded the native message budget. This is not reduced scope. Read gvs_task list taskId for the complete assignment/dependency results, gvs_goal status for all immutable human requirements, gvs_analysis status for reports, and gvs_visual for actual paged screenshots/layout findings. No omitted evidence is implicitly accepted.\n';
 content=[{type:'text',text:notice+clipped},...selected.map(imagePart)];
 while(size(content)>120000&&selected.length){selected.pop();content=[{type:'text',text:notice+clipped},...selected.map(imagePart)];}
 while(size(content)>120000){clipped=Buffer.from(clipped,'utf8').subarray(0,Math.floor(Buffer.byteLength(clipped,'utf8')*.8)).toString('utf8');content=[{type:'text',text:notice+clipped}];}
 return {content,images:selected,compact:true};
}
