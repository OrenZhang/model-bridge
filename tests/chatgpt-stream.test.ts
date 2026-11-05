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
