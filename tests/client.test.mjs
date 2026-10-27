import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../v3/client.js',import.meta.url),'utf8');
function render({tasks=[],native=[],live={},roles=[{name:'builder',title:'Builder',sessionId:'child',state:'running'}],present=true,parallel}={}){
 let plugin,Board;const React={useState:value=>[value,()=>{}],createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==false&&x!=null)})};
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load:definition=>{plugin=definition.factory(()=>React);}}}});
 plugin.apply({effect:()=>{},slots:{inject:(_name,fn)=>fn(),register:(_options,component)=>{Board=component;}}});
 const team={roles,tasks,status:'running',parallel,taskCounts:{done:0,total:tasks.length}},store={projectionsBySession:{root:{values:{gvsTeam:present?team:null,agentTeam:{tasks:native}}}}};let subscriptions=0;
 const useSessionStatus=select=>{subscriptions++;return select(new Map(Object.entries(live).map(([id,running])=>[id,{running}])));};
 const tree=Board({sessionId:'root',useSession:select=>select({}),useSessions:select=>select(store),useSessionStatus,t:key=>key});
 const nodes=[];function walk(node){if(!node||typeof node!=='object')return;if(typeof node.type==='function'){walk(node.type(node.props));return;}nodes.push(node);node.children.forEach(walk);}walk(tree);
 const text=node=>typeof node==='object'?node.children.map(text).join(' '):String(node);
 return {nodes,text:tree?text(tree):'',subscriptions,card:nodes.find(node=>node.props.className==='gvs-agent'),activity:nodes.find(node=>node.props.className==='gvs-activity')};
}
const task=(id,state,extra={})=>({id,title:`Task ${id}`,assignee:'builder',state,dependsOn:[],...extra});
test('live active assignment wins over stale blockers; absent runtime knowledge never claims work',()=>{
 const tasks=[task('old','blocked',{summary:'Old failure'}),task('new','running')];
 const working=render({tasks,live:{root:true,child:true}});assert.equal(working.card.props['data-state'],'running');assert.deepEqual(working.activity.children,['Task new']);
 assert.equal(render({tasks,live:{child:false}}).card.props['data-state'],'stopped');
 assert.equal(render({tasks}).card.props['data-state'],'assigned');
});
test('native reassignment refreshes restart status without concealing real blockers or future dependency waits',()=>{
 const restored=render({tasks:[task('recover','blocked',{summary:'Interrupted by service restart; inspect partial work before resuming.'}),task('future','waiting',{dependsOn:['dependency']}),task('dependency','waiting',{assignee:'qa'})],native:[{id:'recover',status:'in_progress'}],live:{child:true}});
 assert.equal(restored.card.props['data-state'],'running');assert.equal(restored.nodes.some(node=>node.props.className==='gvs-dependency'),false,'Future tasks must not replace the active assignment status');
 const genuine=render({tasks:[task('blocked','blocked',{summary:'Missing source'})],native:[{id:'blocked',status:'in_progress'}],live:{child:true}});assert.equal(genuine.card.props['data-state'],'blocked');
});
test('coordinator status subscribes even before the team projection arrives; User waits remain explicit',()=>{
 assert.equal(render({present:false}).subscriptions,1,'Unconditional hook preserves React hook order');
 const view=render({tasks:[task('current','running')],live:{root:true,child:true},roles:[{name:'builder',title:'Builder',sessionId:'child',waitingForUser:true}]});
 assert.equal(view.card.props['data-state'],'waiting');assert.ok(view.nodes.some(node=>node.props.role==='status'&&node.children.some(child=>typeof child==='string'&&child.includes('coordinator: running'))));
 assert.ok(view.nodes.some(node=>node.props.className==='gvs-dependency'&&node.children.includes('waitingUser')));
});
test('parallel capacity and actual file/resource waits are visible in the team panel',()=>{
 const view=render({parallel:{assigned:2,limit:4},tasks:[task('pending','waiting')],roles:[{name:'builder',title:'Builder',sessionId:'child',scheduling:{kind:'resources',conflicts:[{assignee:'qa',files:['ui'],resources:['project-runtime']}]}},{name:'qa',title:'QA'}]});
 assert.ok(view.nodes.some(node=>node.children.includes('slots: 2/4')));
 assert.ok(view.nodes.some(node=>node.props.className==='gvs-dependency'&&node.children.includes('waitFor: QA · ui, project-runtime')));
});
