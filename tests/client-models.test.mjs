import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../v3/client.js',import.meta.url),'utf8');
test('team and per-agent controls apply on change, reset inheritance and keep buttons separate',async()=>{
 const policy={schema:1,revision:0,defaults:{},overrides:{}},catalog={groups:[{id:'test',name:'Test',models:[{id:'large',name:'Large',reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]}},{id:'small',name:'Small'}]}]};
 const states=[false,'',null,{policy,coordinator:{provider:'test',model:'large',reasoningEffort:'high'},agents:[]},catalog,'',false],calls=[];let index=0,Board,plugin;
 const React={useEffect:()=>{},useState:initial=>{const i=index++;if(states[i]===undefined)states[i]=initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(value=>value!==false&&value!=null)})};
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load:definition=>{plugin=definition.factory(()=>React);}}}});
 plugin.apply({effect:()=>{},slots:{inject:(_name,fn)=>fn(),register:(_options,component)=>{Board=component;}}});
 const role={name:'qa',title:'QA',sessionId:'child'},team={roles:[role],tasks:[],status:'running'};
 const props={sessionId:'root',useSession:select=>select({}),useSessions:select=>select({projectionsBySession:{root:{values:{gvsTeam:team}}}}),useSessionStatus:select=>select(new Map()),t:key=>key,loadModelCatalog:async()=>catalog,async modelAction(_root,request){calls.push(request);return {...states[3],policy:{...policy,revision:request.revision+1,defaults:request.target==='team'?request.choice:{},overrides:request.target==='team'?{}:{qa:request.choice}}};}};
 function render(){index=0;const nodes=[];function walk(node,inButton=false){if(!node||typeof node!=='object')return;if(typeof node.type==='function'){walk(node.type(node.props),inButton);return;}assert.ok(!(node.type==='button'&&inButton),'No nested buttons');nodes.push(node);node.children.forEach(child=>walk(child,inButton||node.type==='button'));}walk(Board(props));return nodes;}
 let nodes=render();nodes.find(node=>node.type==='button'&&node.children.includes('models')).props.onClick();nodes=render();
 nodes.find(node=>node.props['aria-label']==='model').props.onChange({target:{value:'["test","small"]'}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls[0].target,'team');assert.deepEqual(JSON.parse(JSON.stringify(calls[0].choice)),{provider:'test',model:'small',reasoningEffort:null});
 nodes=render();nodes.find(node=>node.props['aria-label']==='target').props.onChange({target:{value:'qa'}});nodes=render();
 nodes.find(node=>node.props['aria-label']==='effort').props.onChange({target:{value:'@default'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls[1].target,'qa');assert.equal(calls[1].choice.reasoningEffort,null);
 nodes=render();nodes.find(node=>node.type==='button'&&node.children.includes('resetModels')).props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(Object.keys(calls[2].choice),[]);
});
