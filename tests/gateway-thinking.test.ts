import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/core/config.js';
import { Network } from '../src/core/network.js';
import { UsageStore } from '../src/core/usage.js';
import { startGateway, tokenHash } from '../src/gateway/server.js';
import { sse, SSEDecoder } from '../src/gateway/sse.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const thinking = { type: 'thinking', thinking: 'Read both files before comparing.', signature: 'native-signature-fixture' };
const redacted = { type: 'redacted_thinking', data: 'native-redacted-fixture' };
const toolBlocks = ['a', 'b'].map(id => ({ type: 'tool_use', id: `call_${id}`, name: 'read_file', input: { path: `${id}.txt` } }));
const firstContent = [thinking, redacted, ...toolBlocks];
const finalContent = [{ type: 'thinking', thinking: 'The two tool results are consistent.', signature: 'native-final-signature' }, { type: 'text', text: 'Files A and B agree.' }];

function upstreamResponse(res: ServerResponse, json: boolean, final: boolean) {
  const content = final ? finalContent : firstContent;
  const message = { id: final ? 'msg_final' : 'msg_tools', type: 'message', role: 'assistant', model: 'vendor-thinking', content, stop_reason: final ? 'end_turn' : 'tool_use', usage: { input_tokens: 30, output_tokens: 20 } };
  if (json) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 } } }, 'message_start'));
  content.forEach((block: any, index) => {
    const initial = block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block.type === 'text' ? { type: 'text', text: '' } : block.type === 'tool_use' ? { ...block, input: {} } : block;
    res.write(sse({ type: 'content_block_start', index, content_block: initial }, 'content_block_start'));
    if (block.type === 'thinking') {
      res.write(sse({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }, 'content_block_delta'));
      for (const fragment of [block.signature.slice(0, 8), block.signature.slice(8)]) res.write(sse({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: fragment } }, 'content_block_delta'));
    } else if (block.type === 'text') res.write(sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }, 'content_block_delta'));
    else if (block.type === 'tool_use') {
      const args = JSON.stringify(block.input);
      for (const fragment of [args.slice(0, 5), args.slice(5)]) res.write(sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fragment } }, 'content_block_delta'));
    }
    res.write(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
  });
  res.write(sse({ type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 20 } }, 'message_delta'));
  res.end(sse({ type: 'message_stop' }, 'message_stop'));
}
async function setup(json = false) {
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
    upstreamResponse(res, json, body.messages.some((message: any) => message.content?.some?.((block: any) => block.type === 'tool_result')));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const directory = await mkdtemp(path.join(tmpdir(), 'model-bridge-thinking-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = ConfigSchema.parse({ port: 0, defaultProxy: { mode: 'direct' }, clients: ['alice', 'bob'].map(id => ({ id, name: id, tokenHash: tokenHash(`${id}-gateway-key`) })), connections: [{
    id: 'vendor', name: 'Signed thinking fixture', provider: 'anthropic', auth: 'none', baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, models: ['thinking', 'other'].map(id => ({ id, name: id, upstreamId: `vendor-${id}`, protocols: ['messages'] })),
  }] });
  const secrets = { get: async () => undefined }; const network = new Network(() => config, secrets);
  const gateway = await startGateway({ config: () => config, secrets, network, usage: new UsageStore(directory) }); cleanup.push(() => gateway.close());
  return { gateway, requests };
}
function payload(stream: boolean, history?: any[]) {
  return { model: 'vendor/thinking', stream, input: history ?? [{ role: 'user', content: 'Compare a.txt and b.txt using both file tools.' }], reasoning: { effort: 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'], max_output_tokens: 8192,
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
}
async function send(address: string, input: any, client = 'alice') {
  return fetch(address + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${client}-gateway-key`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
}
async function readResponse(response: Response, streaming: boolean) {
  expect(response.status).toBe(200);
  if (!streaming) return { result: await response.json() as any, events: [] as any[] };
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events: any[] = []; const reader = new SSEDecoder(event => events.push(JSON.parse(event.data)));
  reader.push(new TextEncoder().encode(await response.text())); reader.finish();
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(events[0].type).toBe('response.created');
  const result = events.find(event => event.type === 'response.completed')?.response;
  expect(result).toBeDefined(); return { result, events };
}
function replay(output: any[]) {
  return [{ role: 'user', content: 'Compare a.txt and b.txt using both file tools.' }, ...output, ...['a', 'b'].map(id => ({ type: 'function_call_output', call_id: `call_${id}`, output: id.toUpperCase() }))];
}

describe('HTTP thinking round trips with simulated signed Messages upstream', () => {
  for (const json of [false, true]) for (const streaming of [false, true]) {
    it(`${json ? 'JSON fallback' : 'SSE'} upstream → ${streaming ? 'streaming' : 'JSON'} Responses preserves signed history and parallel tools`, async () => {
      const { gateway, requests } = await setup(json);
      const first = await readResponse(await send(gateway.address, payload(streaming)), streaming);
      expect(requests[0].thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
      expect(requests[0].stream).toBe(true);
      expect(first.result.output.map((item: any) => item.type)).toEqual(['reasoning', 'reasoning', 'function_call', 'function_call']);
      expect(first.result.output[0].summary).toEqual([{ type: 'summary_text', text: thinking.thinking }]);
      expect(first.result.output[0].encrypted_content).toMatch(/^mb_r1\./);
      expect(first.result.output[1].encrypted_content).toMatch(/^mb_r1\./);
      expect(JSON.stringify(first)).not.toContain(thinking.signature); expect(JSON.stringify(first)).not.toContain(redacted.data);
      expect(first.result.output.slice(2).map((item: any) => [item.call_id, JSON.parse(item.arguments)])).toEqual([['call_a', { path: 'a.txt' }], ['call_b', { path: 'b.txt' }]]);
      if (streaming) {
        expect(first.events.some(event => event.type === 'response.reasoning_summary_text.delta' && event.delta === thinking.thinking)).toBe(true);
        expect(first.events.filter(event => event.type === 'response.output_item.done').map(event => event.item.type)).toEqual(['reasoning', 'reasoning', 'function_call', 'function_call']);
      }
      const final = await readResponse(await send(gateway.address, payload(streaming, replay(first.result.output))), streaming);
      expect(requests).toHaveLength(2);
      expect(requests[1].messages).toHaveLength(3);
      expect(requests[1].messages[1]).toEqual({ role: 'assistant', content: firstContent });
      expect(requests[1].messages[2]).toEqual({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'A' }] },
        { type: 'tool_result', tool_use_id: 'call_b', content: [{ type: 'text', text: 'B' }] },
      ] });
      expect(final.result.output.map((item: any) => item.type)).toEqual(['reasoning', 'message']);
      expect(final.result.output[1].content[0].text).toBe('Files A and B agree.');
      expect(final.result.usage).toMatchObject({ input_tokens: 30, output_tokens: 20 });
    });
  }
  it('rejects another client, changed model route, or tampered envelope before forwarding to upstream', async () => {
    const { gateway, requests } = await setup();
    const { result } = await readResponse(await send(gateway.address, payload(false)), false);
    const history = replay(result.output);
    const tampered = structuredClone(history); const token = tampered[1].encrypted_content;
    tampered[1].encrypted_content = token.slice(0, 15) + (token[15] === 'A' ? 'B' : 'A') + token.slice(16);
    for (const [client, input] of [
      ['bob', payload(false, history)],
      ['alice', { ...payload(false, history), model: 'vendor/other' }],
      ['alice', payload(false, tampered)],
    ] as const) {
      const response = await send(gateway.address, input, client);
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe('invalid_reasoning_state');
      expect(requests).toHaveLength(1);
    }
  });
});
