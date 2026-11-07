import { afterEach, expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { catalogRoutes, publicModelRoutes } from '../src/core/model-pool.js';
import { startGateway, tokenHash } from '../src/gateway/server.js';
import { UsageStore } from '../src/core/usage.js';
import type { Network } from '../src/core/network.js';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const cleanups: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
it('routes real HTTP tool continuations to the same account and records actual per-account usage',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'mb-pool-http-'));cleanups.push(()=>rm(directory,{recursive:true,force:true}));
  const config=ConfigSchema.parse({port:0,clients:[{id:'client',name:'client',tokenHash:tokenHash('fixture-key')}],connections:['a','b'].map(id=>({id,name:id,provider:'kimi',auth:'none',baseUrl:'https://upstream.invalid/v1',models:[{id:'same',name:'Same',upstreamId:'same',protocols:['chat']}]}))});
  const calls:{account:string;input:any}[]=[];
  const network={request:async(connection:any,_url:any,request:any)=>{
    const input=JSON.parse(request.body);calls.push({account:connection.id,input});
    const toolOutput=input.messages.find((m:any)=>m.role==='tool');
    if(toolOutput)expect(input.messages.find((m:any)=>m.role==='assistant').reasoning_content).toBe('original-thinking-'+connection.id);
    return new Response(JSON.stringify({id:'fixture',choices:[{message:{role:'assistant',content:toolOutput?'done':null,reasoning_content:'original-thinking-'+connection.id,...(!toolOutput?{tool_calls:[{id:'call_probe',type:'function',function:{name:'probe',arguments:'{}'}}]}:{})},finish_reason:toolOutput?'stop':'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}),{headers:{'content-type':'application/json'}});
  },close:async()=>{}} as unknown as Network;
  const usage=new UsageStore(directory);const gateway=await startGateway({config:()=>config,secrets:{get:async()=>undefined},network,usage});cleanups.push(()=>gateway.close());
  config.connections[1]!.provider='custom';config.connections[1]!.baseUrl='https://different.invalid/v1';
  const model=publicModelRoutes(config)[0]!.id;const legacy=`a/same`;
  const post=async(session:string,input:any,selected=model)=>{const r=await fetch(gateway.address+'/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json','x-model-bridge-session':session},body:JSON.stringify({model:selected,input,stream:false,tools:[{type:'function',name:'probe',parameters:{type:'object',properties:{}}}]})});expect(r.status).toBe(200);return r.json() as Promise<any>};
  const first=await post('chat-one','first');await post('chat-two','first');
  await post('chat-one',[{role:'user',content:'first'},...first.output,{type:'function_call_output',call_id:'call_probe',output:'tool result'} ]);
  expect(calls.map(c=>c.account)).toEqual(['a','b','a']);
  const records=await usage.list();expect(records.map(r=>r.connectionId).sort()).toEqual(['a','a','b']);
  expect(records.every(r=>[model,legacy].includes(r.model)&&r.tokens.input===10)).toBe(true);
});

it('switches Responses models within a thread while preserving the active tool state and legacy bindings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-switch-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = ConfigSchema.parse({
    port: 0,
    clients: [{ id: 'client', name: 'client', tokenHash: tokenHash('fixture-key') }],
    connections: ['a', 'b'].map(id => ({
      id, name: id, provider: 'custom', auth: 'none', baseUrl: 'https://upstream.invalid/v1',
      models: [{ id, name: id, upstreamId: id, protocols: ['chat'] }],
    })),
  });
  const calls: { account: string; input: any }[] = [];
  const network = {
    request: async (connection: any, _url: string, request: any) => {
      calls.push({ account: connection.id, input: JSON.parse(request.body) });
      const response = { choices: [{ message: { role: 'assistant', content: 'reply from ' + connection.id,
        reasoning_content: 'private thinking from ' + connection.id }, finish_reason: 'stop' }] };
      return Response.json(response);
    },
    close: async () => {},
  } as unknown as Network;
  const gateway = await startGateway({ config: () => config, secrets: { get: async () => undefined }, network, usage: new UsageStore(directory) });
  cleanups.push(() => gateway.close());
  const post = (model: string, input: any[], session?: string) => fetch(gateway.address + '/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-key', 'content-type': 'application/json', ...(session ? { 'session-id': session } : {}) },
    body: JSON.stringify({ model, input }),
  });
  const initial = [{ role: 'user', content: 'first prompt' }];
  const first = await (await post('a', initial)).json();
  const oldCall = { type: 'function_call', name: 'probe', call_id: 'old_call', arguments: '{}' };
  const oldResult = { type: 'function_call_output', call_id: 'old_call', output: 'old tool result' };
  const next = [...initial, ...first.output, oldCall, oldResult, { role: 'user', content: 'switch to b' }];
  const switched = await post('b', next, 'codex-thread');
  expect(switched.status).toBe(200);
  const second = await switched.json();
  expect(JSON.stringify(calls[1]!.input.messages)).toContain('old tool result');
  expect(JSON.stringify(calls[1]!.input.messages)).not.toMatch(/private thinking|tool_call_id/);

  const continuation = await post('b', [...next, ...second.output,
    { ...oldCall, call_id: 'active_call' }, { ...oldResult, call_id: 'active_call' }], 'codex-thread');
  expect(continuation.status).toBe(200);
  await continuation.json();
  const messages = calls[2]!.input.messages;
  expect(messages.find((message: any) => message.tool_calls)?.reasoning_content).toBe('private thinking from b');
  expect(messages.find((message: any) => message.role === 'tool')?.tool_call_id).toBe('active_call');

  const back = await post('a', [...next, ...second.output, { role: 'user', content: 'switch back' }], 'codex-thread');
  expect(back.status).toBe(200);
  await back.json();
  expect(calls.map(call => call.account)).toEqual(['a', 'b', 'b', 'a']);
  expect(JSON.stringify(calls[3]!.input.messages)).not.toContain('private thinking');

  const unrelated = await post('b', [...first.output, { role: 'user', content: 'switch to b' }], 'unrelated');
  expect(unrelated.status).toBe(400);
  expect((await unrelated.json()).error.code).toBe('invalid_reasoning_state');
  const activeForeignState = await post('b', [...initial, ...first.output], 'codex-thread');
  expect(activeForeignState.status).toBe(400);
  expect((await activeForeignState.json()).error.code).toBe('invalid_reasoning_state');
});
