import { describe, expect, it } from 'vitest';
import { decodeRequest, encodeRequest, DownstreamEncoder, UpstreamDecoder } from '../src/gateway/codec.js';
import { ReasoningVault, hasGatewayReasoning } from '../src/gateway/reasoning.js';
import type { Protocol } from '../src/core/config.js';
import { SSEDecoder } from '../src/gateway/sse.js';
const vault = new ReasoningVault(Buffer.alloc(32, 9));
const tool = { type: 'function', name: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
const tools = decodeRequest('responses', { input: 'question', tools: [tool] }).tools;
const native: Record<Protocol, any> = {
  chat: { choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'Check both sources.', reasoning_details: [{ type: 'reasoning.text', text: 'provider metadata', format: 'minimax', index: 0 }], tool_calls: ['one','two'].map(id => ({ id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ key: id }) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 34 } },
  messages: { content: [{ type: 'thinking', thinking: 'Check both sources.', signature: 'vendor-signature-must-be-exact' }, { type: 'redacted_thinking', data: 'private-opaque-vendor-data' }, ...['one','two'].map(id => ({ type: 'tool_use', id, name: 'lookup', input: { key: id } }))], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 34 } },
  responses: { output: [{ type: 'reasoning', id: 'provider-reasoning-id', summary: [{ type: 'summary_text', text: 'Check both sources.' }], encrypted_content: 'opaque-real-upstream-ciphertext' }, ...['one','two'].map(id => ({ type: 'function_call', call_id: id, name: 'lookup', arguments: JSON.stringify({ key: id }) }))], status: 'completed', usage: { input_tokens: 12, output_tokens: 34 } },
};
function nextRequest(protocol: Protocol, response: any) {
  if (protocol === 'responses') return { input: [{ role: 'user', content: 'question' }, ...response.output, ...['one','two'].map(id => ({ type: 'function_call_output', call_id: id, output: id + ' result' }))], tools: [tool] };
  if (protocol === 'chat') return { messages: [{ role: 'user', content: 'question' }, response.choices[0].message, ...['one','two'].map(id => ({ role: 'tool', tool_call_id: id, content: id + ' result' }))], tools: [{ type: 'function', function: { name: tool.name, parameters: tool.parameters } }] };
  return { messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: response.content }, { role: 'user', content: ['one','two'].map(id => ({ type: 'tool_result', tool_use_id: id, content: id + ' result' })) }], tools: [{ name: tool.name, input_schema: tool.parameters }] };
}
describe('thinking roundtrip across protocols', () => {
  for (const upstream of ['responses','messages','chat'] as const) for (const downstream of ['responses','messages','chat'] as const) if (upstream !== downstream) {
    it(`${upstream} → ${downstream} → ${upstream} preserves opaque history and parallel tool results`, () => {
      const context = vault.context('client-a/connection/model', upstream);
      const decoder = new UpstreamDecoder(upstream); const encoder = new DownstreamEncoder(downstream, 'connection/model', tools, context);
      for (const delta of decoder.decodeJSON(native[upstream])) encoder.accept(delta);
      const response = encoder.result(); const next = nextRequest(downstream, response);
      expect(hasGatewayReasoning(next)).toBe(true);
      const encoded = encodeRequest(upstream, decodeRequest(downstream, next, context), 'vendor-model', context);
      if (upstream === 'messages') {
        expect(encoded.messages[1].content).toEqual(native.messages.content);
        expect(encoded.messages[2].content.map((c: any) => c.tool_use_id)).toEqual(['one','two']);
      } else if (upstream === 'chat') {
        expect(encoded.messages[1].reasoning_content).toBe(native.chat.choices[0].message.reasoning_content);
        expect(encoded.messages[1].reasoning_details).toEqual(native.chat.choices[0].message.reasoning_details);
        expect(encoded.messages[1].tool_calls).toEqual(native.chat.choices[0].message.tool_calls);
        expect(encoded.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(['one','two']);
      } else {
        expect(encoded.input.find((item: any) => item.type === 'reasoning')).toEqual(native.responses.output[0]);
        expect(encoded.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id)).toEqual(['one','two']);
      }
    });
  }
  it('rejects altered, cross-client, cross-route and cross-protocol state', () => {
    const context = vault.context('client-a/route-a', 'messages');
    const sealed = context.seal({ protocol: 'messages', value: native.messages.content[0] });
    expect(() => vault.context('client-b/route-a', 'messages').open(sealed)).toThrow('different client or model route');
    expect(() => vault.context('client-a/route-b', 'messages').open(sealed)).toThrow('different client or model route');
    expect(() => vault.context('client-a/route-a', 'chat').open(sealed)).toThrow('different client or model route');
    const tampered = sealed.slice(0, 30) + (sealed[30] === 'A' ? 'B' : 'A') + sealed.slice(31);
    expect(() => context.open(tampered)).toThrow('invalid');
    expect(new ReasoningVault(Buffer.alloc(32, 9)).context('client-a/route-a', 'messages').open(sealed).value).toEqual(native.messages.content[0]);
    expect(sealed).not.toContain('vendor-signature');
  });
  it('does not invent signatures when handed unrelated native encrypted history', () => {
    const request = decodeRequest('responses', { input: [native.responses.output[0], { role: 'user', content: 'next' }] });
    expect(() => encodeRequest('messages', request, 'MiniMax-M3')).toThrow('foreign opaque reasoning');
  });
  it('enforces per-record state bounds', () => {
    expect(() => vault.context('scope', 'chat').seal({ protocol: 'chat', value: { reasoning_content: 'x'.repeat(2 * 1024 * 1024) } })).toThrow('size limit');
  });
});

it('streams thinking, signatures, redacted thinking and tool calls into valid ordered Responses items', () => {
  const context = vault.context('stream', 'messages', 'minimax', 'MiniMax-M3');
  const decoder = new UpstreamDecoder('messages'); const encoder = new DownstreamEncoder('responses', 'route/model', tools, context);
  let wire = '';
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'facts' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-part-1' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-part-2' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'encrypted-redacted' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'one', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"key":"one"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } }, { type: 'message_stop' },
  ];
  for (const event of events) for (const delta of decoder.decode(JSON.stringify(event))) wire += encoder.accept(delta);
  encoder.accept(decoder.end()); wire += encoder.finish();
  const parsed: any[] = []; const sse = new SSEDecoder(event => parsed.push(JSON.parse(event.data))); sse.push(Buffer.from(wire)); sse.finish();
  expect(parsed.filter(e => e.type === 'response.reasoning_summary_text.delta').map(e => e.delta).join('')).toBe('Check facts');
  const response = parsed.find(e => e.type === 'response.completed').response;
  expect(response.output.map((item: any) => item.type)).toEqual(['reasoning', 'reasoning', 'function_call']);
  expect(context.open(response.output[0].encrypted_content).value).toEqual({ type: 'thinking', thinking: 'Check facts', signature: 'sig-part-1-part-2' });
  expect(context.open(response.output[1].encrypted_content).value).toEqual({ type: 'redacted_thinking', data: 'encrypted-redacted' });
  expect(parsed.filter(e => e.type === 'response.output_item.done').map(e => e.output_index)).toEqual([0,1,2]);
});

it('keeps interleaved thinking and text in their original order', () => {
  const context = vault.context('ordered', 'messages');
  const decoder = new UpstreamDecoder('messages'); const encoder = new DownstreamEncoder('responses', 'model', tools, context);
  const blocks = [{ type: 'thinking', thinking: 'first', signature: 'sig1' }, { type: 'text', text: 'preface' }, { type: 'thinking', thinking: 'second', signature: 'sig2' }, { type: 'tool_use', id: 'one', name: 'lookup', input: { key: 'one' } }];
  for (const delta of decoder.decodeJSON({ content: blocks, stop_reason: 'tool_use' })) encoder.accept(delta);
  const request = { input: [{ role: 'user', content: 'question' }, ...encoder.result().output, { type: 'function_call_output', call_id: 'one', output: 'answer' }], tools: [tool] };
  expect(encodeRequest('messages', decodeRequest('responses', request, context), 'model', context).messages[1].content).toEqual(blocks);
});

it('maps provider-specific thinking controls without unsupported Messages reasoning_effort', () => {
  const request = decodeRequest('responses', { input: 'question', reasoning: { effort: 'xhigh', summary: 'auto' } });
  const minimax = encodeRequest('messages', request, 'MiniMax-M3.1-Flash', vault.context('scope', 'messages', 'minimax', 'MiniMax-M3.1-Flash'));
  expect(minimax.thinking).toEqual({ type: 'adaptive' }); expect(minimax.output_config).toEqual({ effort: 'xhigh' }); expect(minimax.reasoning_effort).toBeUndefined();
  const m2 = encodeRequest('messages', request, 'MiniMax-M2.7', vault.context('scope', 'messages', 'minimax', 'MiniMax-M2.7'));
  expect(m2.thinking).toBeUndefined(); expect(m2.output_config).toBeUndefined();
  const kimi = encodeRequest('chat', request, 'kimi-k3.1-pro', vault.context('scope', 'chat', 'kimi', 'kimi-k3.1-pro'));
  expect(kimi.reasoning_effort).toBe('max');
  const k2 = encodeRequest('chat', request, 'kimi-k2.7-code', vault.context('scope', 'chat', 'kimi', 'kimi-k2.7-code'));
  expect(k2.reasoning_effort).toBeUndefined();
  for (const model of ['kimi-for-coding', 'k3', 'k3-256k', 'k3.1-pro']) {
    expect(encodeRequest('chat', request, model, vault.context('scope', 'chat', 'kimi', model)).thinking).toEqual({ type: 'enabled', effort: 'max', keep: 'all' });
    const messages = encodeRequest('messages', request, model, vault.context('scope', 'messages', 'kimi', model));
    expect(messages.thinking).toEqual({ type: 'enabled' }); expect(messages.output_config).toEqual({ effort: 'max' }); expect(messages.reasoning_effort).toBeUndefined();
  }
  expect(encodeRequest('chat', request, 'kimi-for-coding-highspeed', vault.context('scope', 'chat', 'kimi')).reasoning_effort).toBeUndefined();
});

it('streams Kimi Chat thinking into Codex and restores the exact next-turn assistant reasoning', () => {
  const context = vault.context('kimi-stream', 'chat', 'kimi', 'kimi-k2.7-code');
  const decoder = new UpstreamDecoder('chat'); const encoder = new DownstreamEncoder('responses', 'kimi/model', tools, context);
  let wire = '';
  for (const event of [
    { choices: [{ delta: { reasoning_content: 'Need ' } }] },
    { choices: [{ delta: { reasoning_content: 'a lookup.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'lookup', arguments: '{"key":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"one"}' } }] }, finish_reason: 'tool_calls' }] },
  ]) for (const delta of decoder.decode(JSON.stringify(event))) wire += encoder.accept(delta);
  encoder.accept(decoder.end()); wire += encoder.finish();
  const events: any[] = []; const parser = new SSEDecoder(e => events.push(JSON.parse(e.data))); parser.push(Buffer.from(wire)); parser.finish();
  const response = events.find(e => e.type === 'response.completed').response;
  const result = encodeRequest('chat', decodeRequest('responses', { input: [...response.output, { type: 'function_call_output', call_id: 'one', output: 'result' }], tools: [tool] }, context), 'kimi-k2.7-code', context);
  expect(result.messages[0]).toMatchObject({ role: 'assistant', reasoning_content: 'Need a lookup.', tool_calls: [{ id: 'one', function: { name: 'lookup', arguments: '{"key":"one"}' } }] });
});

it('uses final upstream Responses encrypted state rather than partial summary fragments', () => {
  const context = vault.context('responses-stream', 'responses'); const decoder = new UpstreamDecoder('responses'); const encoder = new DownstreamEncoder('messages', 'model', tools, context);
  let wire = '';
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_native', type: 'reasoning', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Visible summary' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'rs_native', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Visible summary' }], encrypted_content: 'real-vendor-cipher' } },
    { type: 'response.completed', response: { status: 'completed', output: [{ id: 'rs_native', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Visible summary' }], encrypted_content: 'real-vendor-cipher' }] } },
  ]) for (const delta of decoder.decode(JSON.stringify(event))) wire += encoder.accept(delta);
  const result = encoder.result(); expect(result.content[0].thinking).toBe('Visible summary');
  expect(context.open(result.content[0].signature).value.encrypted_content).toBe('real-vendor-cipher');
  wire += encoder.finish(); expect(wire).toContain('signature_delta');
});

it('emits sequential Messages blocks and authenticates late Chat metadata before block closure', () => {
  const context = vault.context('chat-late-signature', 'chat'); const decoder = new UpstreamDecoder('chat'); const encoder = new DownstreamEncoder('messages', 'model', tools, context);
  let wire = '';
  for (const event of [
    { choices: [{ delta: { reasoning_content: 'Need a lookup.' } }] },
    { choices: [{ delta: { content: 'Checking now.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'lookup', arguments: '{}' } }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'late-native-state' }] }, finish_reason: 'tool_calls' }] },
  ]) for (const delta of decoder.decode(JSON.stringify(event))) wire += encoder.accept(delta);
  wire += encoder.finish();
  const events: any[] = []; const parser = new SSEDecoder(e => events.push(JSON.parse(e.data))); parser.push(Buffer.from(wire)); parser.finish();
  let active: number | undefined;
  for (const event of events) {
    if (event.type === 'content_block_start') { expect(active).toBeUndefined(); active = event.index; }
    if (event.type === 'content_block_delta') expect(event.index).toBe(active);
    if (event.type === 'content_block_stop') { expect(event.index).toBe(active); active = undefined; }
  }
  expect(active).toBeUndefined();
  const signature = events.find(e => e.delta?.type === 'signature_delta').delta.signature;
  expect(context.open(signature).value.reasoning_details[0].data).toBe('late-native-state');
});

it('accepts an empty Messages tool input only after a clean content_block_stop', () => {
  const decoder = new UpstreamDecoder('messages'); const encoder = new DownstreamEncoder('responses', 'model', tools, vault.context('scope', 'messages'));
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'one', name: 'lookup', input: {} } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ]) for (const delta of decoder.decode(JSON.stringify(event))) encoder.accept(delta);
  expect(encoder.result().output[0].arguments).toBe('{}');
});

it('rejects malformed gateway-specific Chat history markers instead of silently dropping them', () => {
  expect(() => decodeRequest('chat', { messages: [{ role: 'assistant', content: '', reasoning_details: [{ type: 'model_bridge.reasoning', data: 'bogus' }] }] }, vault.context('scope', 'chat'))).toThrow('Invalid gateway reasoning');
});
