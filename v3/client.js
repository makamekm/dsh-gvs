window.__ModuleLoader__.load({id:'@makame/dsh-gvs',factory(require){
 const React=require('react'),h=React.createElement,NS='gvs.team';
 const en={team:'GVS team',plan:'Task plan',hide:'Hide plan',running:'Working',waiting:'Waiting',blocked:'Blocked',idle:'Standby',error:'Error',done:'Done',open:'Open agent chat',waitFor:'Waiting for',waitingUser:'Waiting for the User advocate',tasks:'tasks',automatic:'GVS · automatic team',goal:'Goal',verified:'Verified',paused:'Paused',ready:'Ready',noWork:'Waiting for new work'};
 const ru={team:'Команда GVS',plan:'План задач',hide:'Скрыть план',running:'В работе',waiting:'Ждёт',blocked:'Нужна помощь',idle:'Ожидает',error:'Ошибка',done:'Готово',open:'Открыть чат агента',waitFor:'Ждёт',waitingUser:'Ждёт ответа Пользователя',tasks:'задач',automatic:'GVS · команда под задачу',goal:'Цель',verified:'Проверено',paused:'Приостановлено',ready:'Можно начать',noWork:'Ожидает новую задачу'};
 const css=`
.gvs-team{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,840px);min-width:0;align-self:center;margin:0 auto 2px;padding:0;color:var(--dsw-alias-label-primary);font-size:12px}
.gvs-head{display:flex;align-items:center;gap:8px;min-height:28px;padding:0 3px 5px}.gvs-head strong{font-size:11px;font-weight:600;letter-spacing:.035em}.gvs-subtle{color:var(--dsw-alias-label-tertiary);font-size:11px}.gvs-head .gvs-plan{margin-left:auto}
.gvs-plan{font:inherit;font-size:11px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:4px 7px;border-radius:6px}.gvs-plan:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.gvs-roles{display:flex;gap:8px;overflow-x:auto;overflow-y:hidden;padding:1px 1px 6px;scroll-snap-type:x proximity;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}.gvs-roles::-webkit-scrollbar{height:4px}.gvs-roles::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:8px}.gvs-roles::-webkit-scrollbar-track{background:transparent}
.gvs-agent{box-sizing:border-box;appearance:none;text-align:left;font:inherit;display:flex;flex-direction:column;gap:7px;flex:0 0 218px;width:218px;min-width:0;height:114px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer;scroll-snap-align:start;transition:border-color .16s,background .16s}.gvs-agent:hover{border-color:var(--dsw-alias-label-quaternary);background:var(--dsw-alias-interactive-bg-hover)}.gvs-agent[data-state=running]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 38%,var(--dsw-alias-border-l2))}.gvs-agent:disabled{cursor:default;opacity:.7}
.gvs-agent:focus-visible,.gvs-plan:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.gvs-name{display:flex;align-items:center;gap:6px;min-width:0}.gvs-name strong{min-width:0;flex:1;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gvs-status{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:auto;white-space:nowrap}.gvs-dot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dsw-alias-label-quaternary)}.gvs-dot.running{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}.gvs-dot.blocked,.gvs-dot.error{background:var(--dsw-alias-state-error-primary)}
.gvs-activity{font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:34px}.gvs-dependency{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary)}.gvs-agent>.gvs-subtle{margin-top:auto;font-size:10px}.gvs-tasks{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);margin:6px 0;padding:10px 12px;max-height:190px;overflow:auto}.gvs-task{display:grid;grid-template-columns:15px minmax(0,1fr);gap:7px;padding:7px 0}.gvs-task+.gvs-task{border-top:1px solid var(--dsw-alias-border-l2)}.gvs-task p{margin:3px 0;color:var(--dsw-alias-label-tertiary);line-height:16px}.gvs-tasks>p{margin:0 0 5px;line-height:16px}
@media(max-width:540px){.gvs-agent{flex-basis:200px;width:200px;height:110px}.gvs-head{gap:6px}.gvs-team{max-width:var(--dsh-composer-card-max-width,100%)}}
@media(prefers-reduced-motion:reduce){.gvs-agent{transition:none}}
`;
 function Board({sessionId,useSession,useSessions,useSessionStatus,openAgent,t}){
  const [expanded,setExpanded]=React.useState(false),[error,setError]=React.useState('');
  const rootId=useSession(snapshot=>snapshot.subagent?.address.parentSessionId)??sessionId;
  const team=useSessions(state=>state.projectionsBySession[rootId]?.values.gvsTeam);
  const native=useSessions(state=>state.projectionsBySession[rootId]?.values.agentTeam);
  if(!team)return null;
  const tasks=team.tasks.map(task=>({...task,state:native?.tasks.find(item=>item.id===task.id)?.status==='completed'?'done':task.state}));
  const completed=tasks.filter(task=>task.state==='done').length;
  return h('section',{className:'gvs-team','aria-label':t('team')},h('style',null,css),
   h('div',{className:'gvs-head'},h('strong',null,t('team')),h('span',{className:'gvs-subtle'},`${team.roles.length} · ${completed}/${tasks.length}`),
    team.status!=='running'&&h('span',{className:'gvs-subtle'},t(team.status==='verified'?'verified':'paused')),h('button',{className:'gvs-plan',onClick:()=>setExpanded(value=>!value),'aria-expanded':expanded},t(expanded?'hide':'plan'))),
   h('div',{className:'gvs-roles'},...team.roles.map(role=>h(Agent,{key:role.name,role,roles:team.roles,tasks,rootId,sessionId,useSessionStatus,openAgent,t,onError:setError}))),
   error&&h('p',{role:'alert'},error),
   expanded&&h('div',{className:'gvs-tasks'},h('p',{className:'gvs-subtle'},`${t('goal')}: ${team.task}`),...tasks.map(task=>{
    const deps=task.dependsOn.map(id=>tasks.find(item=>item.id===id)).filter(task=>task&&task.state!=='done');
    return h('div',{className:'gvs-task',key:task.id},h('span',{'aria-hidden':true},task.state==='done'?'✓':task.state==='running'?'↻':'○'),h('div',null,h('strong',null,task.title),h('p',null,team.roles.find(role=>role.name===task.assignee)?.title??task.assignee),deps.length>0&&h('p',null,`${t('waitFor')}: ${deps.map(dep=>`${team.roles.find(role=>role.name===dep.assignee)?.title??dep.assignee} — ${dep.title}`).join('; ')}`),task.summary&&h('p',null,task.summary)));
   })));
 }
 function Agent({role,roles,tasks,rootId,sessionId,useSessionStatus,openAgent,t,onError}){
  const live=useSessionStatus(state=>role.sessionId?state.get(role.sessionId)?.running:false);
  const own=tasks.filter(task=>task.assignee===role.name),active=own.find(task=>task.state==='running'),blocked=own.find(task=>task.state==='blocked'),pending=own.find(task=>task.state==='waiting');
  const deps=(pending?.dependsOn??[]).map(id=>tasks.find(task=>task.id===id)).filter(task=>task&&task.state!=='done');
  const status=blocked?'blocked':active?(role.state==='waiting'?'waiting':live===false?'waiting':'running'):pending?'waiting':role.state==='blocked'?'blocked':role.state==='error'?'error':'idle';
  const activity=blocked?.summary??active?.title??pending?.title??t('noWork');
  return h('button',{className:'gvs-agent','data-state':status,disabled:!role.sessionId||role.sessionId===sessionId,title:`${t('open')}: ${role.title}\n${role.purpose}`,
   onClick:()=>{try{openAgent(rootId,role.sessionId);onError('');}catch(error){onError(error.message);}}},
   h('span',{className:'gvs-name'},h('span',{className:`gvs-dot ${status}`}),h('strong',null,role.title),h('span',{className:'gvs-status'},t(status))),
   h('span',{className:'gvs-activity'},activity),
   deps.length>0?h('span',{className:'gvs-dependency'},`${t('waitFor')}: ${deps.map(dep=>`${roles.find(role=>role.name===dep.assignee)?.title??dep.assignee} — ${dep.title}`).join('; ')}`):role.state==='waiting'&&role.activity.includes('Пользователя')?h('span',{className:'gvs-dependency'},t('waitingUser')):h('span',{className:'gvs-subtle'},`${own.filter(task=>task.state==='done').length} ${t('tasks')}`));
 }
 return {inject:['slots','locale','sessions','uiWorkspace'],apply(ctx){
  ctx.effect(()=>ctx.locale.register(NS,{en,ru}));
  const actions={openAgent(parentSessionId,childSessionId){ctx.uiWorkspace.openSession({parentSessionId,childSessionId,mode:'continuable'});}};
  ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'gvs-team',order:-20,locale:NS,inject:()=>actions},Board));
 }};
}});
