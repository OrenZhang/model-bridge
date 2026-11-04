import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, type Protocol } from '../core/config.js';
import { type Tokens, unknownTokens, usageTokens } from '../core/usage.js';
import { sse } from './sse.js';

type Part = { type: 'text'; text: string } | { type: 'image'; url: string };
type Call = { id: string; name: string; arguments: string };
type Message = { role: 'user' | 'assistant' | 'tool'; content: Part[]; calls?: Call[]; callId?: string };
type Tool = { name: string; original: string; namespace?: string; custom: boolean; description: string; schema: any };
export type Delta = { kind: 'text'; text: string } | { kind: 'tool'; index: number; id: string; name: string } | { kind: 'args'; index: number; text: string } | { kind: 'usage'; tokens: Tokens } | { kind: 'end'; reason: string };
export interface Canonical { system: string; messages: Message[]; tools: Tool[]; maxTokens?: number; temperature?: number; effort?: string; toolChoice?: any; }
const unsupported = (name: string): never => { throw new BridgeError(400, 'unsupported_feature', `This cross-protocol route does not support ${name}. Use a model with the native protocol.`); };
const string = (value: unknown, field: string): string => { if (typeof value !== 'string') throw new BridgeError(400, 'invalid_request', `Expected a string for ${field}.`); return value; };
const safeName = (name: string) => /^[\w-]{1,64}$/.test(name) ? name : `mb_${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
function parts(value: any): Part[] {
  if (value == null) return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw new BridgeError(400, 'invalid_request', 'Message content must be a string or an array.');
  return value.map(p => {
    if (['text', 'input_text', 'output_text'].includes(p.type)) return { type: 'text' as const, text: string(p.text, 'text') };
    if (p.type === 'image_url' || p.type === 'input_image') return { type: 'image' as const, url: string(p.image_url?.url ?? p.image_url, 'image URL') };
    if (p.type === 'image' && p.source?.type === 'base64') return { type: 'image' as const, url: `data:${p.source.media_type};base64,${p.source.data}` };
    if (p.type === 'image' && p.source?.type === 'url') return { type: 'image' as const, url: string(p.source.url, 'image URL') };
    return unsupported(`content block ${String(p.type)}`);
  });
}
const text = (value: any) => parts(value).map(p => p.type === 'text' ? p.text : unsupported('images in system instructions')).join('\n');
export function decodeRequest(protocol: Protocol, body: any): Canonical {
  if (body.previous_response_id || body.conversation) unsupported('server-side conversation state');
  if (body.background) unsupported('background requests');
  if (body.n && body.n !== 1) unsupported('multiple candidates');
  if (body.response_format || body.text?.format || body.output_config?.format) unsupported('structured output');
  if (body.reasoning?.summary && body.reasoning.summary !== 'none') unsupported('reasoning summaries');
  const result: Canonical = { system: body.instructions ?? '', messages: [], tools: [],
    maxTokens: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature, effort: body.reasoning?.effort ?? body.reasoning_effort, toolChoice: body.tool_choice };
  function addTool(t: any, namespace?: string) {
    if (t.type === 'namespace') { for (const child of t.tools ?? []) addTool(child, t.name); return; }
    const f = t.function ?? t;
    if (protocol !== 'messages' && !['function', 'custom'].includes(t.type)) unsupported(`tool type ${String(t.type)}`);
    if (protocol === 'messages' && t.type) unsupported(`server tool ${String(t.type)}`);
    const original = string(f.name, 'tool name');
    const tool: Tool = { name: safeName(namespace ? `${namespace}.${original}` : original), original, namespace,
      custom: t.type === 'custom', description: f.description ?? '', schema: f.parameters ?? f.input_schema ?? { type: 'object', properties: {} } };
    if (tool.custom) {
      tool.schema = { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false };
      if (t.format) tool.description += `\nInput format: ${JSON.stringify(t.format)}`;
    }
    const previous = result.tools.find(x => x.name === tool.name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(tool)) throw new BridgeError(400, 'duplicate_tool', 'Conflicting tool definitions.');
    if (!previous) result.tools.push(tool);
  }
  for (const tool of body.tools ?? []) addTool(tool);
  if (protocol === 'responses') {
    if (typeof body.input === 'string') result.messages.push({ role: 'user', content: parts(body.input) });
    else if (Array.isArray(body.input)) {
      for (const item of body.input) if (item.type === 'additional_tools') {
        if (item.role !== 'developer') unsupported('non-developer additional tools');
        for (const tool of item.tools ?? []) addTool(tool);
      }
      for (const item of body.input) {
        if (item.type === 'additional_tools') continue;
        if (item.type === 'message' || !item.type && item.role) {
          if (['system', 'developer'].includes(item.role)) result.system += '\n' + text(item.content);
          else if (['user', 'assistant'].includes(item.role)) result.messages.push({ role: item.role, content: parts(item.content) });
          else unsupported(`role ${String(item.role)}`);
        } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
          const name = safeName(item.namespace ? `${item.namespace}.${item.name}` : string(item.name, 'tool name'));
          result.messages.push({ role: 'assistant', content: [], calls: [{ id: string(item.call_id, 'call ID'), name,
            arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : string(item.arguments, 'tool arguments') }] });
        } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) result.messages.push({ role: 'tool', callId: string(item.call_id, 'call ID'), content: parts(item.output) });
        else unsupported(`Responses item ${String(item.type)}`);
      }
    } else throw new BridgeError(400, 'invalid_request', 'Responses input is required.');
  } else {
    if (!Array.isArray(body.messages)) throw new BridgeError(400, 'invalid_request', 'messages must be an array.');
    if (protocol === 'messages') result.system = text(body.system);
    for (const item of body.messages) {
      if (['system', 'developer'].includes(item.role)) { result.system += '\n' + text(item.content); continue; }
      if (protocol === 'chat') {
        if (!['user', 'assistant', 'tool'].includes(item.role)) unsupported(`role ${String(item.role)}`);
        if (item.reasoning_content) unsupported('provider-specific reasoning history');
        result.messages.push({ role: item.role, content: parts(item.content), callId: item.tool_call_id,
          calls: item.tool_calls?.map((c: any) => ({ id: c.id, name: safeName(c.function.name), arguments: c.function.arguments })) });
      } else {
        if (!['user', 'assistant'].includes(item.role)) unsupported(`role ${String(item.role)}`);
        const content = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content;
        if (!Array.isArray(content)) throw new BridgeError(400, 'invalid_request', 'Invalid message content.');
        let pending: Message = { role: item.role, content: [] };
        const flush = () => { if (pending.content.length || pending.calls?.length) result.messages.push(pending); pending = { role: item.role, content: [] }; };
        for (const block of content) {
          if (block.type === 'tool_use') (pending.calls ??= []).push({ id: block.id, name: safeName(block.name), arguments: JSON.stringify(block.input) });
          else if (block.type === 'tool_result') { flush(); result.messages.push({ role: 'tool', callId: block.tool_use_id, content: parts(block.content) }); }
          else pending.content.push(...parts([block]));
        }
        flush();
      }
    }
  }
  return result;
}
function encodeParts(protocol: Protocol, content: Part[], output = false): any[] {
  return content.map(p => {
    if (p.type === 'text') return { type: protocol === 'responses' ? output ? 'output_text' : 'input_text' : 'text', text: p.text };
    if (protocol === 'chat') return { type: 'image_url', image_url: { url: p.url } };
    if (protocol === 'responses') return { type: 'input_image', image_url: p.url };
    const data = /^data:([^;]+);base64,(.+)$/.exec(p.url);
    return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: p.url } };
  });
}
export function encodeRequest(protocol: Protocol, request: Canonical, model: string) {
  const body: any = { model, stream: true };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.effort) {
    if (protocol === 'responses') body.reasoning = { effort: request.effort };
    else if (protocol === 'chat') body.reasoning_effort = request.effort;
    else unsupported('cross-protocol reasoning-effort mapping to Messages');
  }
  if (request.toolChoice) {
    if (typeof request.toolChoice === 'string' && ['auto', 'none', 'required'].includes(request.toolChoice))
      body.tool_choice = protocol === 'messages' ? { type: request.toolChoice === 'required' ? 'any' : request.toolChoice } : request.toolChoice;
    else if (request.toolChoice.type === 'auto' || request.toolChoice.type === 'none' || request.toolChoice.type === 'any')
      body.tool_choice = protocol === 'messages' ? request.toolChoice : request.toolChoice.type === 'any' ? 'required' : request.toolChoice.type;
    else unsupported('forced named tool selection');
  }
  if (protocol === 'responses') {
    body.store = false; body.instructions = request.system;
    if (request.maxTokens) body.max_output_tokens = request.maxTokens;
    body.tools = request.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }));
    body.input = request.messages.flatMap(m => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: encodeParts('responses', m.content) }];
      const items: any[] = m.content.length ? [{ type: 'message', role: m.role, content: encodeParts('responses', m.content, m.role === 'assistant') }] : [];
      items.push(...(m.calls ?? []).map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments })));
      return items;
    });
  } else if (protocol === 'chat') {
    body.stream_options = { include_usage: true };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    body.messages = [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages.map(m => ({ role: m.role,
      content: m.content.length ? encodeParts('chat', m.content) : null,
      ...(m.callId ? { tool_call_id: m.callId } : {}),
      ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }))];
  } else {
    body.system = request.system; body.max_tokens = request.maxTokens ?? 8192;
    body.tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
    body.messages = request.messages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role,
      content: m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.callId, content: encodeParts('messages', m.content) }]
        : [...encodeParts('messages', m.content), ...(m.calls ?? []).map(c => {
          let input: any; try { input = JSON.parse(c.arguments); } catch { throw new BridgeError(400, 'invalid_tool_arguments', 'Tool arguments must be valid JSON.'); }
          return { type: 'tool_use', id: c.id, name: c.name, input };
        })] }));
  }
  return body;
}

export class UpstreamDecoder {
  tokens = unknownTokens(); ended = false;
  private tools = new Map<number, { id: string; name: string }>();
  private stopReason = 'stop';
  constructor(private protocol: Protocol) {}
  decode(data: string): Delta[] {
    if (data === '[DONE]') { this.ended = true; return [{ kind: 'end', reason: this.stopReason }]; }
    let event: any; try { event = JSON.parse(data); } catch { throw new BridgeError(502, 'invalid_upstream_event', 'Upstream returned an invalid stream event.'); }
    if (event.error || ['error', 'response.failed'].includes(event.type)) throw new BridgeError(502, 'upstream_stream_error', 'The upstream stream reported an error.');
    const result: Delta[] = [];
    const usage = event.usage ?? event.message?.usage ?? event.response?.usage;
    if (usage) { this.tokens = usageTokens(this.protocol, usage, this.tokens); result.push({ kind: 'usage', tokens: this.tokens }); }
    if (this.protocol === 'chat') {
      const choice = event.choices?.[0], delta = choice?.delta;
      if (delta?.content) result.push({ kind: 'text', text: delta.content });
      if (delta?.reasoning_content) unsupported('upstream reasoning deltas in a translated response');
      for (const call of delta?.tool_calls ?? []) {
        if (!this.tools.has(call.index)) {
          if (!call.id || !call.function?.name) throw new BridgeError(502, 'invalid_tool_stream', 'Tool stream is missing an ID or name.');
          this.tools.set(call.index, { id: call.id, name: call.function.name });
          result.push({ kind: 'tool', index: call.index, id: call.id, name: call.function.name });
        }
        if (call.function?.arguments) result.push({ kind: 'args', index: call.index, text: call.function.arguments });
      }
      if (choice?.finish_reason) { this.stopReason = choice.finish_reason; this.ended = true; }
    } else if (this.protocol === 'messages') {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use')
        result.push({ kind: 'tool', index: event.index, id: event.content_block.id, name: event.content_block.name });
      if (event.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(event.content_block.type)) unsupported('upstream thinking blocks in a translated response');
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') result.push({ kind: 'text', text: event.delta.text });
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') result.push({ kind: 'args', index: event.index, text: event.delta.partial_json });
      if (event.type === 'message_delta' && event.delta.stop_reason) this.stopReason = event.delta.stop_reason === 'tool_use' ? 'tool_calls' : event.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
      if (event.type === 'message_stop') { this.ended = true; result.push({ kind: 'end', reason: this.stopReason }); }
    } else {
      if (event.type === 'response.output_text.delta') result.push({ kind: 'text', text: event.delta });
      if (event.type === 'response.output_item.added') {
        if (event.item.type === 'function_call') result.push({ kind: 'tool', index: event.output_index, id: event.item.call_id, name: event.item.name });
        else if (event.item.type !== 'message') unsupported(`upstream output ${event.item.type}`);
      }
      if (event.type === 'response.function_call_arguments.delta') result.push({ kind: 'args', index: event.output_index, text: event.delta });
      if (['response.completed', 'response.incomplete'].includes(event.type)) {
        this.ended = true; this.stopReason = event.type === 'response.incomplete' ? 'length' : event.response.output?.some((o: any) => o.type === 'function_call') ? 'tool_calls' : 'stop';
        result.push({ kind: 'end', reason: this.stopReason });
      }
    }
    return result;
  }
  end(): Delta { if (!this.ended) throw new BridgeError(502, 'upstream_stream_incomplete', 'The upstream stream ended before completion.'); return { kind: 'end', reason: this.stopReason }; }
}

export class DownstreamEncoder {
  readonly id = `mb_${randomUUID().replaceAll('-', '')}`;
  private messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  private content = '';
  private tokens = unknownTokens();
  private calls = new Map<number, Call & { outputIndex: number; itemId: string; custom: boolean; namespace?: string }>();
  private nextIndex = 0; private textIndex: number | undefined; private seq = 0; private started = false; private ended = false; private reason = 'stop';
  constructor(private protocol: Protocol, private model: string, private tools: Tool[]) {}
  private event(type: string, value: any) { return sse({ type, sequence_number: this.seq++, ...value }, type); }
  private chat(delta: any, finish: string | null = null) { return sse({ id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] }); }
  start() {
    if (this.started) return ''; this.started = true;
    if (this.protocol === 'chat') return this.chat({ role: 'assistant', content: '' });
    if (this.protocol === 'messages') return sse({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }, 'message_start');
    return this.event('response.created', { response: { id: this.id, object: 'response', status: 'in_progress', model: this.model, output: [] } });
  }
  accept(delta: Delta): string {
    if (delta.kind === 'usage') { this.tokens = delta.tokens; return ''; }
    if (delta.kind === 'end') { this.reason = delta.reason; return ''; }
    let out = this.start();
    if (delta.kind === 'text') {
      this.content += delta.text;
      if (this.content.length > 16 * 1024 * 1024) throw new BridgeError(502, 'output_too_large', 'Translated output exceeds the size limit.');
      if (this.protocol === 'chat') return out + this.chat({ content: delta.text });
      if (this.textIndex === undefined) {
        this.textIndex = this.nextIndex++;
        out += this.protocol === 'messages'
          ? sse({ type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } }, 'content_block_start')
          : this.event('response.output_item.added', { output_index: this.textIndex, item: { id: this.messageId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }) + this.event('response.content_part.added', { item_id: this.messageId, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      return out + (this.protocol === 'messages'
        ? sse({ type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: delta.text } }, 'content_block_delta')
        : this.event('response.output_text.delta', { item_id: this.messageId, output_index: this.textIndex, content_index: 0, delta: delta.text }));
    }
    if (delta.kind === 'tool') {
      if (this.calls.has(delta.index)) throw new BridgeError(502, 'invalid_tool_stream', 'Duplicate upstream tool index.');
      const spec = this.tools.find(t => t.name === delta.name);
      if (!spec) throw new BridgeError(502, 'unknown_tool', 'The upstream requested an undeclared tool.');
      const call = { id: delta.id, name: spec.original, arguments: '', outputIndex: this.nextIndex++, itemId: `fc_${randomUUID().replaceAll('-', '')}`, custom: spec.custom, namespace: spec.namespace };
      this.calls.set(delta.index, call);
      if (this.protocol === 'chat') return out + this.chat({ tool_calls: [{ index: delta.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] });
      if (this.protocol === 'messages') return out + sse({ type: 'content_block_start', index: call.outputIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }, 'content_block_start');
      return out + this.event('response.output_item.added', { output_index: call.outputIndex, item: this.responseCall(call, false) });
    }
    const call = this.calls.get(delta.index);
    if (!call) throw new BridgeError(502, 'invalid_tool_stream', 'Tool arguments arrived before the tool declaration.');
    call.arguments += delta.text;
    if (call.arguments.length > 2097152) throw new BridgeError(502, 'tool_arguments_too_large', 'Tool arguments exceed the size limit.');
    if (this.protocol === 'chat') return out + this.chat({ tool_calls: [{ index: delta.index, function: { arguments: delta.text } }] });
    if (this.protocol === 'messages') return out + sse({ type: 'content_block_delta', index: call.outputIndex, delta: { type: 'input_json_delta', partial_json: delta.text } }, 'content_block_delta');
    return out + (call.custom ? '' : this.event('response.function_call_arguments.delta', { item_id: call.itemId, output_index: call.outputIndex, delta: delta.text }));
  }
  private responseCall(call: Call & { itemId: string; custom: boolean; namespace?: string }, completed: boolean) {
    const base = { id: call.itemId, call_id: call.id, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), status: completed ? 'completed' : 'in_progress' };
    if (!call.custom) return { ...base, type: 'function_call', arguments: completed ? call.arguments : '' };
    let input = '';
    if (completed) { try { input = JSON.parse(call.arguments).input; } catch { throw new BridgeError(502, 'invalid_tool_arguments', 'Invalid custom tool input.'); } if (typeof input !== 'string') throw new BridgeError(502, 'invalid_tool_arguments', 'Custom tool input must be a string.'); }
    return { ...base, type: 'custom_tool_call', input };
  }
  private usage() {
    const t = this.tokens;
    return this.protocol === 'chat' ? { prompt_tokens: t.input ?? 0, completion_tokens: t.output ?? 0, total_tokens: (t.input ?? 0) + (t.output ?? 0) }
      : this.protocol === 'messages' ? { input_tokens: Math.max(0, (t.input ?? 0) - (t.cachedInput ?? 0) - (t.cacheWrite ?? 0)), output_tokens: t.output ?? 0, cache_read_input_tokens: t.cachedInput ?? 0, cache_creation_input_tokens: t.cacheWrite ?? 0 }
      : { input_tokens: t.input ?? 0, output_tokens: t.output ?? 0, total_tokens: (t.input ?? 0) + (t.output ?? 0), input_tokens_details: { cached_tokens: t.cachedInput ?? 0 }, output_tokens_details: { reasoning_tokens: t.reasoning ?? 0 } };
  }
  result(): any {
    const calls = [...this.calls.values()];
    this.validateCalls();
    if (this.protocol === 'chat') return { id: this.id, object: 'chat.completion', model: this.model, created: Math.floor(Date.now()/1000), choices: [{ index: 0, message: { role: 'assistant', content: this.content || null, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }, finish_reason: this.reason }], usage: this.usage() };
    if (this.protocol === 'messages') return { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [...(this.content ? [{ type: 'text', text: this.content }] : []), ...calls.map(c => { let input: any; try { input = JSON.parse(c.arguments); } catch { throw new BridgeError(502, 'invalid_tool_arguments', 'The upstream produced invalid tool arguments.'); } return { type: 'tool_use', id: c.id, name: c.name, input }; })], stop_reason: this.reason === 'tool_calls' ? 'tool_use' : this.reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: this.usage() };
    const output: any[] = calls.map(c => ({ index: c.outputIndex, item: this.responseCall(c, true) }));
    if (this.textIndex !== undefined) output.push({ index: this.textIndex, item: { id: this.messageId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: this.content, annotations: [] }] } });
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now()/1000), model: this.model, status: this.reason === 'length' ? 'incomplete' : 'completed', output: output.sort((a,b) => a.index-b.index).map(x => x.item), usage: this.usage(), ...(this.reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
  }
  finish() {
    if (this.ended) return ''; this.ended = true;
    this.validateCalls();
    let out = this.start();
    if (this.protocol === 'chat') return out + this.chat({}, this.reason) + sse({ id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: this.model, choices: [], usage: this.usage() }) + sse('[DONE]');
    if (this.protocol === 'messages') {
      for (let index=0; index<this.nextIndex; index++) out += sse({ type: 'content_block_stop', index }, 'content_block_stop');
      return out + sse({ type: 'message_delta', delta: { stop_reason: this.reason === 'tool_calls' ? 'tool_use' : this.reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: this.usage() }, 'message_delta') + sse({ type: 'message_stop' }, 'message_stop');
    }
    const response = this.result();
    if (this.textIndex !== undefined) out += this.event('response.output_text.done', { item_id: this.messageId, output_index: this.textIndex, content_index: 0, text: this.content }) + this.event('response.content_part.done', { item_id: this.messageId, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: this.content, annotations: [] } });
    for (const call of this.calls.values()) {
      const item = this.responseCall(call, true);
      out += this.event(call.custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { item_id: call.itemId, output_index: call.outputIndex, ...(call.custom ? { input: (item as any).input } : { arguments: call.arguments }) });
    }
    for (let index=0; index<response.output.length; index++) out += this.event('response.output_item.done', { output_index: index, item: response.output[index] });
    return out + this.event(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  }
  private validateCalls() {
    for (const call of this.calls.values()) {
      let args: unknown; try { args = JSON.parse(call.arguments); } catch { throw new BridgeError(502, 'invalid_tool_arguments', 'The upstream produced invalid tool arguments.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BridgeError(502, 'invalid_tool_arguments', 'Tool arguments must be a JSON object.');
    }
  }
}
