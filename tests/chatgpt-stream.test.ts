import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {ConfigSchema} from '../src/core/config.js';
import {startGateway,tokenHash} from '../src/gateway/server.js';
import {UsageStore} from '../src/core/usage.js';
import {sse} from '../src/gateway/sse.js';
import type {Network} from '../src/core/network.js';
it('accepts the Codex subscription endpoint SSE when Content-Type is omitted',async()=>{
const dir=await mkdtemp(path.join(os.tmpdir(),'mb-chatgpt-stream-'));
const config=ConfigSchema.parse({port:0,clients:[{id:'test',name:'Test',tokenHash:tokenHash('local-key')}],connections:[{id:'gpt',name:'Account',provider:'openai',auth:'chatgpt-device',baseUrl:'https://chatgpt.com/backend-api/codex',models:[{id:'coding',name:'Coding',upstreamId:'coding',protocols:['responses']}]}]});
const completed={id:'fixture',status:'completed',output:[],usage:{input_tokens:4,output_tokens:1}};
const data=sse({type:'response.created',response:{id:'fixture'}})+sse({type:'response.output_text.delta',delta:'OK'})+sse({type:'response.completed',response:completed});
const network={request:async()=>new Response(new TextEncoder().encode(data)),close:async()=>{}} as unknown as Network;
const gateway=await startGateway({config:()=>config,secrets:{get:async()=>undefined},network,usage:new UsageStore(dir),chatgptCredentials:async()=>({token:'fixture-upstream-token',accountId:'fixture-account'})});
try{const res=await fetch(gateway.address+'/v1/responses',{method:'POST',headers:{authorization:'Bearer local-key','content-type':'application/json'},body:JSON.stringify({model:'gpt/coding',input:'test',stream:true})});expect(res.status).toBe(200);expect(res.headers.get('content-type')).toContain('text/event-stream');expect(await res.text()).toContain('response.completed');}finally{await gateway.close();await rm(dir,{recursive:true,force:true});}
});
it.each(['chat','messages','responses'] as const)('adapts common %s client options to the ChatGPT plan schema',async protocol=>{
const dir=await mkdtemp(path.join(os.tmpdir(),'mb-chatgpt-client-'));
const config=ConfigSchema.parse({port:0,clients:[{id:'test',name:'Test',tokenHash:tokenHash('local-key')}],connections:[{id:'gpt',name:'Account',provider:'openai',auth:'chatgpt-device',baseUrl:'https://chatgpt.com/backend-api/codex',models:[{id:'coding',name:'Coding',upstreamId:'coding',protocols:['responses']}]}]});
let sent:any;
const network={request:async(_connection:any,_url:any,request:any)=>{
 sent=JSON.parse(request.body);
 if(['temperature','max_output_tokens','top_p','metadata'].some(k=>k in sent)||sent.input.some((m:any)=>m.role==='system'))return new Response('{}',{status:400});
 const output=[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}];
 return new Response(sse({type:'response.output_text.delta',output_index:0,delta:'OK'})+sse({type:'response.completed',response:{id:'fixture',status:'completed',output,usage:{input_tokens:4,output_tokens:1}}}),{headers:{'content-type':'text/event-stream'}});
},close:async()=>{}} as unknown as Network;
const gateway=await startGateway({config:()=>config,secrets:{get:async()=>undefined},network,usage:new UsageStore(dir),chatgptCredentials:async()=>({token:'fixture-token',accountId:'fixture-account'})});
try{
 const payload={model:'coding',stream:false,temperature:0.7,top_p:0.9,metadata:{fixture:'yes'},...(protocol==='responses'?{max_output_tokens:128,input:[{type:'message',role:'system',content:'Be concise'},{role:'user',content:'test'}]}:protocol==='messages'?{max_tokens:128,system:'Be concise',messages:[{role:'user',content:'test'}]}:{max_tokens:128,messages:[{role:'system',content:'Be concise'},{role:'user',content:'test'}]})};
 const endpoint=protocol==='chat'?'chat/completions':protocol;
 const res=await fetch(gateway.address+'/v1/'+endpoint,{method:'POST',headers:{authorization:'Bearer local-key','content-type':'application/json'},body:JSON.stringify(payload)});
 expect(res.status).toBe(200);expect(await res.text()).toContain('OK');expect(sent.stream).toBe(true);expect(sent.store).toBe(false);
 expect(JSON.stringify(sent)).toContain('Be concise');
 if(protocol==='responses'){
 const bad=await fetch(gateway.address+'/v1/responses',{method:'POST',headers:{authorization:'Bearer local-key','content-type':'application/json'},body:JSON.stringify({...payload,previous_response_id:'old-response'})});
 expect(bad.status).toBe(400);expect(await bad.text()).toContain('chatgpt_history_required');
 }
}finally{await gateway.close();await rm(dir,{recursive:true,force:true});}
});
