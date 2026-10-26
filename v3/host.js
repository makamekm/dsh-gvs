import {z} from 'zod';
export const inject=['sessionProjections'];
export function apply(ctx,config={}){
 const team=z.object({schema:z.literal(3),sessionId:z.string(),roles:z.array(z.object({name:z.string(),title:z.string(),state:z.string()}).passthrough()).max(12),tasks:z.array(z.object({id:z.string(),state:z.string()}).passthrough()).max(160)}).passthrough().nullable();
 ctx.sessionProjections.register({key:'gvsTeam',stateVersion:1,stateSchema:z.object({calls:z.record(z.string(),z.string()),value:team}),
  init:()=>({calls:{},value:null}),apply(state,event){
   if(event.type==='tool/call'&&event.data.name.startsWith('gvs_'))return {...state,calls:{...state.calls,[event.data.callId]:event.data.name}};
   if(event.type!=='tool/result'||!state.calls[event.data.message.toolCallId])return state;
   const calls={...state.calls};delete calls[event.data.message.toolCallId];let value=state.value;
   try{const content=event.data.message.content.find(part=>part.type==='text');const candidate=JSON.parse(content.text).gvsTeam;const result=team.safeParse(candidate);if(result.success)value=result.data;}catch{}
   return {calls,value};
  },wire:{viewSchema:team,view:state=>state.value}});
}
