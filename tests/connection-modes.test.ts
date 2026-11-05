import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import os from'node:os';import path from'node:path';
import {ConfigSchema}from'../src/core/config.js';import {startGateway,tokenHash}from'../src/gateway/server.js';import {UsageStore}from'../src/core/usage.js';import type{Network}from'../src/core/network.js';
import {controlledRequest,modelModeOptions}from'../src/shared/reasoning-modes.js';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it.each(['responses','messages','chat'] as const)('applies selected connection modes after routing on %s ingress',async protocol=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'mb-modes-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
 const config=ConfigSchema.parse({port:0,clients:[{id:'test',name:'Test',tokenHash:tokenHash('client-key')}],connections:[
 {id:'k',name:'Kimi',provider:'kimi',auth:'subscription',baseUrl:'https://api.kimi.com/coding/v1',reasoningModes:{'kimi-for-coding':'high'},models:[{id:'k',name:'Kimi',upstreamId:'kimi-for-coding',protocols:['chat'],reasoning:['low','high','max'],thinking:{mode:'only',efforts:['low','high','max'],defaultEffort:'max'}}]},
 {id:'m',name:'MiniMax',provider:'minimax',auth:'subscription',baseUrl:'https://agent.minimax.cn/mavis/api/v1/llm/v1',reasoningModes:{'MiniMax-M3.1-Flash':'low'},models:[{id:'m',name:'MiniMax',upstreamId:'MiniMax-M3.1-Flash',protocols:['messages'],reasoning:['low','medium','high','xhigh','max']}]},
 {id:'d',name:'DeepSeek',provider:'deepseek',auth:'api-key',secretRef:'deepseek-key',baseUrl:'https://api.deepseek.com/v1',reasoningModes:{'deepseek-flash':'none'},models:[{id:'d',name:'DeepSeek',upstreamId:'deepseek-flash',protocols:['chat'],reasoning:['none','low','high','max']}]},
 {id:'g',name:'GPT',provider:'openai',auth:'chatgpt-device',baseUrl:'https://chatgpt.com/backend-api/codex',reasoningModes:{'gpt-5.6-sol':'xhigh'},models:[{id:'g',name:'GPT',upstreamId:'gpt-5.6-sol',protocols:['responses'],reasoning:['low','medium','high','xhigh']}]}
 ]});
 const requests=new Map<string,any>();
 const network={close:async()=>{},request:async(c:any,_url:any,init:any)=>{const body=JSON.parse(init.body);requests.set(c.id,body);
 const value=c.id==='m'?{id:'fixture',type:'message',content:[{type:'text',text:'OK'}],stop_reason:'end_turn'}:c.id==='g'?{id:'fixture',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]}:{id:'fixture',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]};
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 }} as unknown as Network;
 const gateway=await startGateway({config:()=>config,secrets:{get:async()=> 'fixture-provider-key'},network,usage:new UsageStore(dir),subscriptionCredentials:async()=>({token:'fixture-subscription-token'}),chatgptCredentials:async()=>({token:'fixture-chatgpt-token',accountId:'fixture-account'})});cleanup.push(()=>gateway.close());
 for(const model of ['kimi-for-coding','MiniMax-M3.1-Flash','deepseek-flash','gpt-5.6-sol']){
 const r=await fetch(gateway.address+(protocol==='chat'?'/v1/chat/completions':'/v1/'+protocol),{method:'POST',headers:{authorization:'Bearer client-key','content-type':'application/json'},body:JSON.stringify({model,stream:false,...(protocol==='responses'?{input:'test',reasoning:{effort:'medium'}}:{messages:[{role:'user',content:'test'}],max_tokens:2048,...(protocol==='chat'?{reasoning_effort:'medium'}:{output_config:{effort:'medium'}})})})});expect(r.status).toBe(200);expect(await r.text()).toContain('OK');
 }
 expect(requests.get('k').thinking).toEqual({type:'enabled',effort:'high',keep:'all'});
 expect(requests.get('m').thinking).toBeUndefined();expect(requests.get('m').output_config.effort).toBe('low');
 expect(requests.get('d').thinking).toEqual({type:'disabled'});expect(requests.get('d').reasoning_effort).toBeUndefined();
 expect(requests.get('g').reasoning.effort).toBe('xhigh');expect(requests.get('g').thinking).toBeUndefined();
});
it('offers exact provider modes and preserves opaque history when changing a connection mode',()=>{
 const k={provider:'kimi',auth:'subscription',reasoningModes:{m:'low'}};const model={upstreamId:'m',reasoning:['high','low','max'],thinking:{mode:'only' as const,efforts:['low','high','max'],defaultEffort:'max'}};
 expect(modelModeOptions(k,model)).not.toContain('medium');expect(modelModeOptions(k,model)).not.toContain('none');
 const history=[{type:'reasoning',encrypted_content:'opaque-fixture'}];const input={input:history,reasoning:{effort:'max',summary:'auto'}};
 const out=controlledRequest(k,model,'responses',input);expect(out.reasoning).toEqual({effort:'low',summary:'auto'});expect(out.input).toBe(history);expect(input.reasoning.effort).toBe('max');
 const updated=controlledRequest(k,model,'responses',{input:[...history,{type:'configuration_update',reasoning:{effort:'max'},text:{verbosity:'low'}}]});expect(updated.input[1]).toEqual({type:'configuration_update',text:{verbosity:'low'}});
 expect(controlledRequest({...k,reasoningModes:{m:'provider'}},model,'responses',input).reasoning).toEqual({summary:'auto'});
 expect(()=>controlledRequest({...k,reasoningModes:{m:'medium'}},model,'responses',input)).toThrow('不支持');
 expect(controlledRequest({provider:'deepseek',auth:'api-key',reasoningModes:{'deepseek-flash':'on'}},{upstreamId:'deepseek-flash',reasoning:['none','low','high','max']},'chat',{}).reasoning_effort).toBe('high');
 expect(modelModeOptions({provider:'minimax',auth:'subscription'},{upstreamId:'MiniMax-M3',reasoning:['medium','none']})).toEqual(['client','provider','on','none']);
});
