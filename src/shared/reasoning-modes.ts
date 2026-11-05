export const modeValues = ['client','provider','on','none','minimal','low','medium','high','xhigh','max','ultra'] as const;
export type ReasoningMode = typeof modeValues[number];
export const modeLabels: Record<ReasoningMode,string> = {client:'跟随客户端',provider:'模型默认',on:'开启思考',none:'关闭思考',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高',ultra:'超高'};
export interface ModeModel {upstreamId:string;reasoning:string[];thinking?:{mode:'only'|'both'|'none';efforts:string[];defaultEffort?:string}}
export interface ModeConnection {provider:string;auth:string;reasoningModes?:Record<string,string>}
export function modelModeOptions(connection:ModeConnection,model:ModeModel):ReasoningMode[] {
 let levels=[...model.reasoning];let onOnly=false;
 if(model.thinking){
  if(model.thinking.mode==='none')return ['client','provider'];
  levels=model.thinking.efforts.filter(v=>modeValues.includes(v as ReasoningMode));onOnly=!levels.length;
  if(model.thinking.mode==='both')levels.push('none');
 } else if(connection.provider==='minimax'){
  if(model.upstreamId==='MiniMax-M3.1-Flash')levels=['low','medium','high','xhigh','max'];
  else if(model.upstreamId==='MiniMax-M3'){levels=['none'];onOnly=true;}
  else if(/^MiniMax-M2\.7(?:-highspeed)?$/.test(model.upstreamId)){levels=[];onOnly=true;}
 } else if(connection.provider==='kimi'&&!levels.length){
  if(/^(?:kimi-)?k3|^kimi-for-coding$/.test(model.upstreamId))levels=['low','high','max'];
  else if(/^kimi-k2\.7|^kimi-for-coding-highspeed$/.test(model.upstreamId)){levels=[];onOnly=true;}
  else if(/^kimi-k2\.6/.test(model.upstreamId)){levels=['none'];onOnly=true;}
 } else if(connection.provider==='deepseek'&&['deepseek-flash','deepseek-v4-pro'].includes(model.upstreamId))levels=['none','low','high','max'];
 else if(connection.provider==='openai'&&!levels.length){
  if(/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model.upstreamId))levels=['none','low','medium','high','xhigh','max'];
  if(/^gpt-6(?:\.1)?-(?:astra|sol|terra|luna)$/.test(model.upstreamId))levels=[...(['gpt-6-astra','gpt-6.1-sol'].includes(model.upstreamId)?[]:['none']),'low','medium','high','xhigh','max'];
 }
 if(!levels.length&&!onOnly)return ['client','provider'];
 if(levels.filter(v=>v!=='none').length===1&&levels.includes('medium')){levels=levels.filter(v=>v!=='medium');onOnly=true;}
 return ['client','provider','on',...levels.filter(v=>v!=='client'&&v!=='provider'&&v!=='on') as ReasoningMode[]];
}
export function controlledRequest(connection:ModeConnection,model:ModeModel,protocol:'responses'|'messages'|'chat',input:any){
 const mode=connection.reasoningModes?.[model.upstreamId]??'client';
 if(mode==='client')return input;
 if(!modelModeOptions(connection,model).includes(mode as ReasoningMode))throw new Error('此模型不支持连接中设置的推理模式，请在连接设置中重新选择。');
 const out={...input};delete out.thinking;delete out.reasoning_effort;
 if(out.reasoning){out.reasoning={...out.reasoning};delete out.reasoning.effort;if(!Object.keys(out.reasoning).length)delete out.reasoning;}
 if(out.output_config){out.output_config={...out.output_config};delete out.output_config.effort;if(!Object.keys(out.output_config).length)delete out.output_config;}
 if(Array.isArray(out.input)&&out.input.some((item:any)=>item.type==='configuration_update'&&item.reasoning))out.input=out.input.flatMap((item:any)=>{if(item.type!=='configuration_update'||!item.reasoning)return [item];const reasoning={...item.reasoning};delete reasoning.effort;const update={...item};if(Object.keys(reasoning).length)update.reasoning=reasoning;else delete update.reasoning;return Object.keys(update).some(k=>k!=='type')?[update]:[];});
 if(mode==='provider')return out;
 const effort=mode==='on'?(model.thinking?.defaultEffort??(connection.provider==='deepseek'?'high':model.reasoning.find(e=>e!=='none'))):mode;
 if(effort){if(protocol==='responses')out.reasoning={...out.reasoning,effort};else if(protocol==='chat')out.reasoning_effort=effort;else out.output_config={...out.output_config,effort};}
 if(protocol!=='responses')out.thinking={type:mode==='none'?'disabled':'enabled'};
 return out;
}
