import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { ConfigSchema, type Protocol } from '../src/core/config.js';
import { Network } from '../src/core/network.js';
import { UsageStore } from '../src/core/usage.js';
import { startGateway, tokenHash } from '../src/gateway/server.js';
import { sse } from '../src/gateway/sse.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function stream(protocol: Protocol, res: ServerResponse, tool = false, complete = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (protocol === 'chat') {
    res.write(sse({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } : { content: '你好' } }] }));
    if (tool) res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] }));
    if (complete) { res.write(sse({ choices: [{ delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 3 } } })); res.write(sse('[DONE]')); }
  } else if (protocol === 'messages') {
    res.write(sse({ type: 'message_start', message: { usage: { input_tokens: 18, output_tokens: 0, cache_read_input_tokens: 3 } } }, 'message_start'));
    res.write(sse({ type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} } : { type: 'text', text: '' } }, 'content_block_start'));
    res.write(sse({ type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } : { type: 'text_delta', text: '你好' } }, 'content_block_delta'));
    if (complete) { res.write(sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop')); res.write(sse({ type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 9 } }, 'message_delta')); res.write(sse({ type: 'message_stop' }, 'message_stop')); }
  } else {
    res.write(sse({ type: 'response.created', response: { id: 'resp_1' } }, 'response.created'));
    if (tool) {
      res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '' } }, 'response.output_item.added'));
      res.write(sse({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a.ts"}' }, 'response.function_call_arguments.delta'));
    } else res.write(sse({ type: 'response.output_text.delta', output_index: 0, delta: '你好' }, 'response.output_text.delta'));
    if (complete) res.write(sse({ type: 'response.completed', response: { id: 'resp_1', output: tool ? [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }] : [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }], usage: { input_tokens: 21, output_tokens: 9, input_tokens_details: { cached_tokens: 3 } } } }, 'response.completed'));
  }
  res.end();
}
async function setup(upstream: Protocol, opts: { tool?: boolean; complete?: boolean; proxy?: boolean; listenHost?: '127.0.0.1' | '0.0.0.0' } = {}) {
  const requests: { body: any; headers: any; path?: string }[] = [];
  const upstreamServer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), headers: req.headers, path: req.url });
    stream(upstream, res, opts.tool, opts.complete ?? true);
  });
  await new Promise<void>(r => upstreamServer.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => upstreamServer.close(() => r())));
  const directory = await mkdtemp(path.join(tmpdir(), 'model-bridge-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = ConfigSchema.parse({ port: 0, clients: [{ id: 'codex', name: 'Codex', tokenHash: tokenHash('gateway-test-key') }], connections: [{ id: 'account', name: 'Test', provider: 'custom', auth: 'api-key', baseUrl: `http://127.0.0.1:${(upstreamServer.address() as any).port}/v1`, secretRef: 'key', models: [{ id: 'model', name: 'Model', upstreamId: 'vendor-model', protocols: [upstream], price: { input: 1, output: 2, cachedInput: 0.1 } }] }] });
  const secrets = { async get() { return 'upstream-test-key'; } };
  config.listenHost = opts.listenHost ?? '127.0.0.1';
  const network = new Network(() => config, secrets);
  const usage = new UsageStore(directory);
  const gateway = await startGateway({ config: () => config, secrets, network, usage }); cleanup.push(() => gateway.close());
  return { gateway, requests, config, usage };
}
const endpoint: Record<Protocol, string> = { responses: '/v1/responses', chat: '/v1/chat/completions', messages: '/v1/messages' };
function input(protocol: Protocol, streaming = true, tool = false) {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  return { model: 'account/model', stream: streaming, ...(protocol === 'responses' ? { input: 'Read a.ts' } : { messages: [{ role: 'user', content: 'Read a.ts' }] }),
    ...(protocol === 'messages' ? { max_tokens: 256 } : {}), ...(tool ? { tools: protocol === 'chat' ? [{ type: 'function', function: { name: 'read_file', parameters: schema } }] : protocol === 'messages' ? [{ name: 'read_file', input_schema: schema }] : [{ type: 'function', name: 'read_file', parameters: schema }] } : {}) };
}
async function send(address: string, protocol: Protocol, payload: any) { return fetch(address + endpoint[protocol], { method: 'POST', headers: { authorization: 'Bearer gateway-test-key', 'content-type': 'application/json' }, body: JSON.stringify(payload) }); }

describe('gateway protocol matrix', () => {
  it.each([['chat',false],['chat',true],['messages',false],['messages',true]] as const)('does not silently discard hosted web_search without an executor (%s, stream=%s)',async(upstream,streaming)=>{
    const {gateway,requests}=await setup(upstream);
    const r=await send(gateway.address,'responses',{...input('responses',streaming),tools:[{type:'web_search'},{type:'function',name:'web_search',parameters:{type:'object',properties:{}}}]});
    expect(r.status).toBe(400);expect((await r.json()).error.code).toBe('hosted_search_unavailable');expect(requests).toHaveLength(0);
  });
  it('rejects forced hosted search and search history without calling the upstream',async()=>{
    const {gateway,requests}=await setup('chat');
    for(const extra of[{tools:[{type:'web_search'}],tool_choice:{type:'web_search'}},{tools:[{type:'web_search_preview'}],tool_choice:'required'},{input:[{type:'web_search_call',id:'ws_1',status:'completed',action:{type:'search',query:'test'}}]}]){
      const r=await send(gateway.address,'responses',{...input('responses',false),...extra});expect(r.status).toBe(400);expect((await r.json()).error.code).toBe('hosted_search_unavailable');
    }
    expect(requests).toHaveLength(0);
  });
  it('keeps hosted search intact on a native Responses route',async()=>{
    const {gateway,requests}=await setup('responses');const r=await send(gateway.address,'responses',{...input('responses'),tools:[{type:'web_search'}]});expect(r.status).toBe(200);await r.text();expect(requests[0]!.body.tools).toEqual([{type:'web_search'}]);expect(r.headers.has('x-model-bridge-unavailable-tools')).toBe(false);
  });
  it('handles the Codex client tool_search declaration without discarding eagerly supplied functions',async()=>{
    const {gateway,requests}=await setup('chat');const r=await send(gateway.address,'responses',{...input('responses',false),tools:[{type:'tool_search',execution:'client',parameters:{type:'object',properties:{}}},{type:'function',name:'read_file',parameters:{type:'object',properties:{}}}]});
    expect(r.status).toBe(200);await r.text();expect(requests[0]!.body.tools.map((t:any)=>t.function.name)).toEqual(['mb_client_tool_search','read_file']);
  });
  it('preserves an ordinary client function named web_search',async()=>{
    const {gateway,requests}=await setup('chat');const r=await send(gateway.address,'responses',{...input('responses',false),tools:[{type:'function',name:'web_search',parameters:{type:'object',properties:{}}}]});
    expect(r.status).toBe(200);await r.text();expect(requests[0]!.body.tools[0].function.name).toBe('web_search');
  });
  it('rejects missing and server-executed dynamic discovery before contacting the upstream',async()=>{
    const {gateway,requests}=await setup('chat');
    for(const extra of[{tool_choice:{type:'tool_search'}},{input:[{type:'tool_search_output',execution:'server',call_id:'discovery_1',tools:[]}]}]){
      const r=await send(gateway.address,'responses',{...input('responses',false),...extra});expect(r.status).toBe(400);expect((await r.json()).error.code).toBe('tool_discovery_unavailable');
    }
    expect(requests).toHaveLength(0);
  });
  it('prefers Responses when included in multiple upstream protocols without changing the requested model',async()=>{
    const {gateway,config,requests}=await setup('responses');
    config.connections[0]!.upstreamProtocols=['chat','responses'];config.connections[0]!.models[0]!.protocols=['chat'];
    const response=await send(gateway.address,'responses',input('responses'));
    expect(response.status).toBe(200);expect(await response.text()).toContain('你好');expect(requests[0]!.path).toBe('/v1/responses');expect(requests[0]!.body.model).toBe('vendor-model');
  });
  it.each(['responses','messages','chat'] as const)('accepts %s at one chat-only connection and translates automatically',async source=>{
    const {gateway,config,requests}=await setup('chat');config.connections[0]!.upstreamProtocols=['chat'];
    const response=await send(gateway.address,source,input(source));
    expect(response.status).toBe(200);expect(await response.text()).toContain('你好');expect(requests[0]!.path).toBe('/v1/chat/completions');expect(requests[0]!.body.model).toBe('vendor-model');
  });
  for (const source of ['responses', 'messages', 'chat'] as const) for (const target of ['responses', 'messages', 'chat'] as const) {
    it(`${source} → ${target} streams text and records actual usage`, async () => {
      const { gateway, requests, usage } = await setup(target);
      const response = await send(gateway.address, source, input(source));
      expect(response.status).toBe(200); expect(await response.text()).toContain('你好');
      expect(requests[0]!.body.model).toBe('vendor-model');
      expect(JSON.stringify(requests[0]!.headers)).not.toContain('gateway-test-key');
      await vi.waitFor(async () => { const records = await usage.list(); expect(records).toHaveLength(1); expect(records[0]!.status).toBe('success'); expect(records[0]!.tokens).toMatchObject({ input: 21, output: 9, cachedInput: 3 }); });
    });
    if (source !== target) it(`${source} → ${target} preserves tool IDs and JSON arguments`, async () => {
      const { gateway } = await setup(target, { tool: true });
      const response = await send(gateway.address, source, input(source, false, true));
      const data: any = await response.json(); expect(response.status).toBe(200);
      const call = source === 'responses' ? data.output.find((o: any) => o.type === 'function_call') : source === 'messages' ? data.content.find((o: any) => o.type === 'tool_use') : data.choices[0].message.tool_calls[0];
      expect(call.call_id ?? call.id).toBe('call_1');
      expect(source === 'responses' ? JSON.parse(call.arguments) : source === 'messages' ? call.input : JSON.parse(call.function.arguments)).toEqual({ path: 'a.ts' });
    });
  }
  it('never converts a truncated upstream stream into success', async () => {
    const { gateway, usage } = await setup('chat', { complete: false });
    const response = await send(gateway.address, 'responses', input('responses'));
    const stream = await response.text(); expect(stream).toContain('upstream_stream_incomplete'); expect(stream).not.toContain('response.completed');
    await vi.waitFor(async () => expect((await usage.list())[0]?.status).toBe('error'));
  });
  it('does not discard unsupported state or content on cross-protocol routes', async () => {
    const { gateway, requests } = await setup('chat');
    const response = await send(gateway.address, 'responses', { ...input('responses'), previous_response_id: 'resp_old' });
    expect(response.status).toBe(400); expect(requests).toHaveLength(0);
  });
  it('enforces gateway authentication and blocks browser origins', async () => {
    const { gateway } = await setup('chat');
    expect((await fetch(gateway.address + '/v1/models')).status).toBe(401);
    expect((await fetch(gateway.address + '/v1/models', { headers: { origin: 'https://attacker.invalid', authorization: 'Bearer gateway-test-key' } })).status).toBe(403);
    const response = await fetch(gateway.address + '/codex/models', { headers: { authorization: 'Bearer gateway-test-key' } });
    const data: any = await response.json(); expect(data.models[0].slug).toBe('vendor-model');
    expect(data.models[0].input_modalities).toEqual(['text']);
  });
  it('never falls through to a different model when the requested one is missing', async () => {
    const { gateway, requests } = await setup('chat');
    const response = await send(gateway.address, 'responses', { ...input('responses'), model: 'missing/model' });
    expect(response.status).toBe(404); expect(requests).toHaveLength(0);
  });
  it('LAN mode exposes interface addresses and still requires a client key', async () => {
    const { gateway } = await setup('chat', { listenHost: '0.0.0.0' });
    expect(gateway.lanAddresses().every(address => !address.includes('0.0.0.0'))).toBe(true);
    expect(gateway.lanInterfaces().map(item=>item.address)).toEqual(gateway.lanAddresses());
    expect(gateway.lanInterfaces().every(item=>!!item.name && typeof item.virtual==='boolean')).toBe(true);
    const ip = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
    const address = ip ? `http://${ip}:${new URL(gateway.address).port}` : gateway.address;
    expect((await fetch(address + '/v1/models')).status).toBe(401);
    expect((await fetch(address + '/v1/models', { headers: { authorization: 'Bearer gateway-test-key' } })).status).toBe(200);
    expect((await fetch(address + '/v1/models', { headers: { authorization: 'Bearer gateway-test-key', origin: 'https://attacker.invalid' } })).status).toBe(403);
  });
});
