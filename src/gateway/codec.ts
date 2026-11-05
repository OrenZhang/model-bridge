import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, type Protocol } from '../core/config.js';
import { type Tokens, unknownTokens, usageTokens } from '../core/usage.js';
import { sse } from './sse.js';
import { isGatewayReasoning, reasoningText, type ReasoningContext, type ReasoningRecord } from './reasoning.js';

type Part = { type: 'text'; text: string } | { type: 'image'; url: string };
type Call = { id: string; name: string; arguments: string };
type Segment = { kind: 'part'; value: Part } | { kind: 'call'; value: Call } | { kind: 'reasoning'; value: ReasoningRecord };
type Message = { role: 'user' | 'assistant' | 'tool'; content: Part[]; calls?: Call[]; callId?: string; segments?: Segment[]; reasoning?: ReasoningRecord[] };
type Tool = { name: string; original: string; namespace?: string; custom: boolean; description: string; schema: any };
export type Delta = { kind: 'reasoning'; index: number; record: ReasoningRecord } | { kind: 'block_end'; index: number } | { kind: 'text'; text: string; index?: number } | { kind: 'tool'; index: number; id: string; name: string } | { kind: 'args'; index: number; text: string } | { kind: 'usage'; tokens: Tokens } | { kind: 'end'; reason: string };
export interface Canonical { system: string; messages: Message[]; tools: Tool[]; maxTokens?: number; temperature?: number; effort?: string; thinking?: any; summary?: string; toolChoice?: any; }
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
export function decodeRequest(protocol: Protocol, body: any, context?: ReasoningContext): Canonical {
  if (body.previous_response_id || body.conversation) unsupported('server-side conversation state');
  if (body.background) unsupported('background requests');
  if (body.n && body.n !== 1) unsupported('multiple candidates');
  if (body.response_format || body.text?.format || body.output_config?.format) unsupported('structured output');

  const result: Canonical = { system: body.instructions ?? '', messages: [], tools: [],
    maxTokens: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature, effort: body.reasoning?.effort ?? body.reasoning_effort ?? body.output_config?.effort, thinking: body.thinking, summary: body.reasoning?.summary, toolChoice: body.tool_choice };
  function readReasoning(native: ReasoningRecord, token?: unknown): ReasoningRecord {
    if (!isGatewayReasoning(token)) return native;
    if (!context) throw new BridgeError(400, 'reasoning_context_required', 'Reasoning history requires a gateway context.');
    return context.open(token);
  }
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
        else if (item.type === 'reasoning') result.messages.push({ role: 'assistant', content: [], reasoning: [readReasoning({ protocol, value: structuredClone(item) }, item.encrypted_content)] });
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
        const wrappers = (item.reasoning_details ?? []).filter((detail: any) => detail.type === 'model_bridge.reasoning');
        if (wrappers.some((detail: any) => !isGatewayReasoning(detail.data))) throw new BridgeError(400, 'invalid_reasoning_state', 'Invalid gateway reasoning history.');
        const reasoning: ReasoningRecord[] = wrappers.length ? wrappers.map((detail: any) => readReasoning({ protocol, value: {} }, detail.data)) :
          item.reasoning_content !== undefined || item.reasoning_details ? [{ protocol, value: { ...(item.reasoning_content !== undefined ? { reasoning_content: item.reasoning_content } : {}), ...(item.reasoning_details ? { reasoning_details: structuredClone(item.reasoning_details) } : {}) } }] : [];
        result.messages.push({ role: item.role, content: parts(item.content), callId: item.tool_call_id,
          reasoning, calls: item.tool_calls?.map((c: any) => ({ id: c.id, name: safeName(c.function.name), arguments: c.function.arguments })) });
      } else {
        if (!['user', 'assistant'].includes(item.role)) unsupported(`role ${String(item.role)}`);
        const content = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content;
        if (!Array.isArray(content)) throw new BridgeError(400, 'invalid_request', 'Invalid message content.');
        let pending: Message = { role: item.role, content: [] };
        const flush = () => { if (pending.content.length || pending.calls?.length || pending.reasoning?.length) result.messages.push(pending); pending = { role: item.role, content: [] }; };
        pending.segments = [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            const call = { id: block.id, name: safeName(block.name), arguments: JSON.stringify(block.input) };
            (pending.calls ??= []).push(call); (pending.segments ??= []).push({ kind: 'call', value: call });
          } else if (['thinking', 'redacted_thinking'].includes(block.type)) {
            const record = readReasoning({ protocol, value: structuredClone(block) }, block.signature ?? block.data);
            (pending.reasoning ??= []).push(record); (pending.segments ??= []).push({ kind: 'reasoning', value: record });
          }
          else if (block.type === 'tool_result') { flush(); result.messages.push({ role: 'tool', callId: block.tool_use_id, content: parts(block.content) }); }
          else for (const part of parts([block])) { pending.content.push(part); (pending.segments ??= []).push({ kind: 'part', value: part }); }
        }
        flush();
      }
    }
  }
  // Responses splits reasoning, messages and function calls into separate items. Providers
  // require them together in one assistant message, in exactly the emitted order.
  const merged: Message[] = [];
  for (const message of result.messages) {
    const segments = message.segments ?? [...(message.reasoning ?? []).map(value => ({ kind: 'reasoning' as const, value })), ...message.content.map(value => ({ kind: 'part' as const, value })), ...(message.calls ?? []).map(value => ({ kind: 'call' as const, value }))];
    const previous = merged.at(-1);
    if (previous?.role === 'assistant' && message.role === 'assistant') {
      previous.content.push(...message.content); (previous.calls ??= []).push(...message.calls ?? []); (previous.reasoning ??= []).push(...message.reasoning ?? []); previous.segments!.push(...segments);
    } else merged.push({ ...message, segments });
  }
  result.messages = merged;
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
export function encodeRequest(protocol: Protocol, request: Canonical, model: string, context?: ReasoningContext) {
  const body: any = { model, stream: true };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  applyThinking(body, protocol, request, model, context);
  const reasoning = (record: ReasoningRecord) => {
    if (record.protocol !== protocol) unsupported('foreign opaque reasoning history; start a new conversation for this route');
    return structuredClone(record.value);
  };
  if (request.toolChoice) {
    if (typeof request.toolChoice === 'string' && ['auto', 'none', 'required'].includes(request.toolChoice))
      body.tool_choice = protocol === 'messages' ? { type: request.toolChoice === 'required' ? 'any' : request.toolChoice } : request.toolChoice;
    else if (request.toolChoice.type === 'auto' || request.toolChoice.type === 'none' || request.toolChoice.type === 'any')
      body.tool_choice = protocol === 'messages' ? request.toolChoice : request.toolChoice.type === 'any' ? 'required' : request.toolChoice.type;
    else unsupported('forced named tool selection');
  }
  if (protocol === 'responses') {
    body.store = false; body.instructions = request.system; body.include = ['reasoning.encrypted_content'];
    if (request.maxTokens) body.max_output_tokens = request.maxTokens;
    body.tools = request.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }));
    body.input = request.messages.flatMap(m => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.callId, output: encodeParts('responses', m.content) }];
      return (m.segments ?? []).map(segment => segment.kind === 'reasoning' ? reasoning(segment.value) : segment.kind === 'call' ? { type: 'function_call', call_id: segment.value.id, name: segment.value.name, arguments: segment.value.arguments } : { type: 'message', role: m.role, content: encodeParts('responses', [segment.value], m.role === 'assistant') });
    });
  } else if (protocol === 'chat') {
    body.stream_options = { include_usage: true };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
    body.messages = [...(request.system ? [{ role: 'system', content: request.system }] : []), ...request.messages.map(m => ({ role: m.role,
      content: m.content.length ? encodeParts('chat', m.content) : null,
      ...Object.assign({}, ...(m.reasoning ?? []).map(reasoning)),
      ...(m.callId ? { tool_call_id: m.callId } : {}),
      ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }))];
  } else {
    body.system = request.system; body.max_tokens = request.maxTokens ?? 8192;
    body.tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
    body.messages = request.messages.map(m => ({ role: m.role === 'tool' ? 'user' : m.role,
      content: m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: m.callId, content: encodeParts('messages', m.content) }]
        : (m.segments ?? []).map(segment => {
          if (segment.kind === 'reasoning') return reasoning(segment.value);
          if (segment.kind === 'part') return encodeParts('messages', [segment.value])[0];
          const c = segment.value;
          let input: any; try { input = JSON.parse(c.arguments); } catch { throw new BridgeError(400, 'invalid_tool_arguments', 'Tool arguments must be valid JSON.'); }
          return { type: 'tool_use', id: c.id, name: c.name, input };
        }) }));
    // Anthropic accepts consecutive tool results as one user turn.
    body.messages = body.messages.reduce((out: any[], message: any) => {
      if (out.at(-1)?.role === message.role) out.at(-1).content.push(...message.content); else out.push(message);
      return out;
    }, []);
  }
  return body;
}

export function applyThinking(body: any, protocol: Protocol, request: Pick<Canonical, 'effort'|'thinking'|'summary'|'maxTokens'>, model: string, context?: ReasoningContext) {
  const effort = request.effort; const provider = context?.provider;
  const kimiCoding = /^k3(?:[.\-]|$)|^kimi-for-coding(?:-highspeed)?$/i.test(model);
  const kimiEffort = effort === 'none' ? 'none' : ['minimal', 'low'].includes(effort ?? '') ? 'low' : ['xhigh', 'max'].includes(effort ?? '') ? 'max' : 'high';
  if (protocol === 'responses') {
    if (effort || request.summary) body.reasoning = { ...body.reasoning, ...(effort ? { effort } : {}), ...(request.summary ? { summary: request.summary } : {}) };
    return;
  }
  if (protocol === 'chat') {
    if (provider === 'kimi') {
      // Kimi's own client uses thinking.effort on Coding endpoints.
      if (kimiCoding) body.thinking = { type: effort === 'none' || request.thinking?.type === 'disabled' ? 'disabled' : 'enabled', ...(effort !== 'none' && request.thinking?.type !== 'disabled' ? { keep: 'all', ...(effort && model !== 'kimi-for-coding-highspeed' ? { effort: kimiEffort } : {}) } : {}) };
      else if (/^kimi-k3/i.test(model) && effort) body.reasoning_effort = kimiEffort;
      else if (/k2\.6/i.test(model)) body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled', ...(effort !== 'none' ? { keep: 'all' } : {}) };
      // K2.7 and K2-thinking do not accept reasoning_effort; their reasoning is always on.
    } else if (provider === 'minimax') {
      if (effort && effort !== 'none' && /M3\.1/i.test(model)) body.reasoning_effort = effort === 'minimal' ? 'low' : effort;
      if (/M3(?!\.1)/i.test(model)) body.thinking = { type: effort === 'none' ? 'disabled' : 'adaptive' };
    } else if (effort) body.reasoning_effort = effort;
    return;
  }
  if (provider === 'minimax') {
    if (/M3\.1/i.test(model)) { body.thinking = { type: 'adaptive' }; if (effort && effort !== 'none') body.output_config = { effort: effort === 'minimal' ? 'low' : effort }; }
    else if (/M3/i.test(model)) body.thinking = { type: effort === 'none' ? 'disabled' : 'adaptive' };
    // M2.x always thinks. Do not pass unsupported effort/budget parameters.
  } else if (provider === 'kimi') {
    // Follow Kimi's Anthropic adapter: enable thinking without an Anthropic budget.
    body.thinking = { type: effort === 'none' || request.thinking?.type === 'disabled' ? 'disabled' : 'enabled' };
    if (effort && effort !== 'none' && (/^(?:kimi-)?k3/i.test(model) || model === 'kimi-for-coding')) body.output_config = { effort: kimiEffort };
  } else if (effort === 'none' || request.thinking?.type === 'disabled') {
    body.thinking = { type: 'disabled' };
  } else if (effort && effort !== 'none' || request.thinking) {
    if (/claude-(opus|sonnet)-4-[6789]/i.test(model)) { body.thinking = { type: 'adaptive' }; if (effort) body.output_config = { effort: effort === 'minimal' ? 'low' : effort === 'xhigh' ? 'max' : effort }; }
    else {
      const max = request.maxTokens ?? 8192;
      const desired = request.thinking?.budget_tokens ?? ({ minimal: 1024, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 32768 }[effort ?? 'medium'] ?? 4096);
      if (max <= 1024) throw new BridgeError(400, 'invalid_thinking_budget', 'Messages thinking requires max_tokens greater than 1024.');
      body.thinking = { type: 'enabled', budget_tokens: Math.min(desired, max - 1) };
    }
  }
}

export class UpstreamDecoder {
  tokens = unknownTokens(); ended = false;
  private tools = new Map<number, { id: string; name: string }>();
  private reasoning = new Map<number, ReasoningRecord>();
  private responseReasoning = new Map<string, number>();
  private toolArguments = new Map<number, string>();
  private stopReason = 'stop';
  constructor(private protocol: Protocol) {}
  private record(index: number, value: any): Delta {
    const record = { protocol: this.protocol, value }; this.reasoning.set(index, record);
    return { kind: 'reasoning', index, record: structuredClone(record) };
  }
  decode(data: string): Delta[] {
    if (data === '[DONE]') { this.ended = true; return [{ kind: 'end', reason: this.stopReason }]; }
    let event: any; try { event = JSON.parse(data); } catch { throw new BridgeError(502, 'invalid_upstream_event', 'Upstream returned an invalid stream event.'); }
    if (event.error || ['error', 'response.failed'].includes(event.type)) throw new BridgeError(502, 'upstream_stream_error', 'The upstream stream reported an error.');
    const result: Delta[] = [];
    const usage = event.usage ?? event.message?.usage ?? event.response?.usage;
    if (usage) { this.tokens = usageTokens(this.protocol, usage, this.tokens); result.push({ kind: 'usage', tokens: this.tokens }); }
    if (this.protocol === 'chat') {
      const choice = event.choices?.[0], delta = choice?.delta;
      if (delta?.reasoning_content !== undefined || delta?.reasoning_details) {
        const value = this.reasoning.get(-1)?.value ?? {};
        if (delta.reasoning_content !== undefined) value.reasoning_content = (value.reasoning_content ?? '') + string(delta.reasoning_content, 'reasoning_content');
        if (delta.reasoning_details) {
          if (!Array.isArray(delta.reasoning_details)) throw new BridgeError(502, 'invalid_reasoning_state', 'Invalid upstream reasoning details.');
          value.reasoning_details ??= [];
          for (const detail of delta.reasoning_details) {
            const existing = detail.index === undefined ? undefined : value.reasoning_details.find((d: any) => d.index === detail.index);
            if (!existing) value.reasoning_details.push(structuredClone(detail));
            else for (const [key, part] of Object.entries(detail)) existing[key] = ['text', 'data', 'signature'].includes(key) && typeof part === 'string' ? (existing[key] ?? '') + part : part;
          }
        }
        result.push(this.record(-1, value));
      }
      if (delta?.content) result.push({ kind: 'text', text: delta.content });
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
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          result.push({ kind: 'tool', index: event.index, id: block.id, name: block.name });
          const initial = block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '';
          this.toolArguments.set(event.index, initial);
          if (initial) result.push({ kind: 'args', index: event.index, text: initial });
        } else if (['thinking', 'redacted_thinking'].includes(block.type)) result.push(this.record(event.index, structuredClone(block)));
        else if (block.type === 'text' && block.text) result.push({ kind: 'text', index: event.index, text: block.text });
        else if (block.type !== 'text') unsupported(`upstream content ${block.type}`);
      }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') result.push({ kind: 'text', index: event.index, text: event.delta.text });
        if (event.delta.type === 'input_json_delta') { this.toolArguments.set(event.index, (this.toolArguments.get(event.index) ?? '') + event.delta.partial_json); result.push({ kind: 'args', index: event.index, text: event.delta.partial_json }); }
        if (['thinking_delta', 'signature_delta'].includes(event.delta.type)) {
          const value = this.reasoning.get(event.index)?.value;
          if (!value) throw new BridgeError(502, 'invalid_reasoning_stream', 'Thinking delta arrived without a thinking block.');
          const field = event.delta.type === 'thinking_delta' ? 'thinking' : 'signature';
          value[field] = (value[field] ?? '') + string(event.delta[field], field);
          result.push(this.record(event.index, value));
        }
      }
      if (event.type === 'content_block_stop') {
        if (this.toolArguments.get(event.index) === '') result.push({ kind: 'args', index: event.index, text: '{}' });
        result.push({ kind: 'block_end', index: event.index });
      }
      if (event.type === 'message_delta' && event.delta.stop_reason) this.stopReason = event.delta.stop_reason === 'tool_use' ? 'tool_calls' : event.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
      if (event.type === 'message_stop') { this.ended = true; result.push({ kind: 'end', reason: this.stopReason }); }
    } else {
      if (event.type === 'response.output_text.delta') result.push({ kind: 'text', index: event.output_index, text: event.delta });
      if (event.type === 'response.output_item.added') {
        if (event.item.type === 'function_call') result.push({ kind: 'tool', index: event.output_index, id: event.item.call_id, name: event.item.name });
        else if (event.item.type === 'reasoning') { this.responseReasoning.set(event.item.id, event.output_index); result.push(this.record(event.output_index, structuredClone(event.item))); }
        else if (event.item.type !== 'message') unsupported(`upstream output ${event.item.type}`);
      }
      if (event.type === 'response.reasoning_summary_text.delta') {
        const index = event.output_index ?? this.responseReasoning.get(event.item_id);
        const value = this.reasoning.get(index)?.value;
        if (!value) throw new BridgeError(502, 'invalid_reasoning_stream', 'Reasoning summary arrived without a reasoning item.');
        value.summary ??= []; const part = event.summary_index ?? 0;
        value.summary[part] ??= { type: 'summary_text', text: '' }; value.summary[part].text += event.delta;
        result.push(this.record(index, value));
      }
      if (event.type === 'response.output_item.done') {
        if (event.item.type === 'reasoning') result.push(this.record(event.output_index, structuredClone(event.item)));
        result.push({ kind: 'block_end', index: event.output_index });
      }
      if (event.type === 'response.function_call_arguments.delta') result.push({ kind: 'args', index: event.output_index, text: event.delta });
      if (['response.completed', 'response.incomplete'].includes(event.type)) {
        for (const [index, item] of (event.response.output ?? []).entries()) if (item.type === 'reasoning') result.push(this.record(index, structuredClone(item)));
        this.ended = true; this.stopReason = event.type === 'response.incomplete' ? 'length' : event.response.output?.some((o: any) => o.type === 'function_call') ? 'tool_calls' : 'stop';
        result.push({ kind: 'end', reason: this.stopReason });
      }
    }
    return result;
  }
  decodeJSON(response: any): Delta[] {
    if (response.error || response.type === 'error' || response.status === 'failed') throw new BridgeError(502, 'upstream_error', 'The upstream returned an error.');
    this.tokens = usageTokens(this.protocol, response.usage); const out: Delta[] = [{ kind: 'usage', tokens: this.tokens }];
    if (this.protocol === 'chat') {
      const message = response.choices?.[0]?.message; if (!message) throw new BridgeError(502, 'invalid_upstream_json', 'The upstream omitted its assistant message.');
      if (message.reasoning_content !== undefined || message.reasoning_details) out.push(this.record(-1, { ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}), ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}) }));
      if (message.content) out.push({ kind: 'text', text: message.content });
      for (const [index, call] of (message.tool_calls ?? []).entries()) out.push({ kind: 'tool', index, id: call.id, name: call.function.name }, { kind: 'args', index, text: call.function.arguments });
      this.stopReason = response.choices[0].finish_reason ?? 'stop';
    } else {
      for (const [index, block] of (this.protocol === 'messages' ? response.content ?? [] : response.output ?? []).entries()) {
        if (['thinking', 'redacted_thinking', 'reasoning'].includes(block.type)) out.push(this.record(index, structuredClone(block)));
        else if (block.type === 'tool_use' || block.type === 'function_call') out.push({ kind: 'tool', index, id: block.call_id ?? block.id, name: block.name }, { kind: 'args', index, text: block.type === 'tool_use' ? JSON.stringify(block.input) : block.arguments });
        else if (block.type === 'text') out.push({ kind: 'text', index, text: block.text });
        else if (block.type === 'message') for (const part of block.content ?? []) { if (part.type !== 'output_text') unsupported(`upstream content ${part.type}`); out.push({ kind: 'text', index, text: part.text }); }
        else unsupported(`upstream output ${block.type}`);
      }
      this.stopReason = response.stop_reason === 'tool_use' || response.output?.some((item: any) => item.type === 'function_call') ? 'tool_calls' : response.stop_reason === 'max_tokens' || response.status === 'incomplete' ? 'length' : 'stop';
    }
    this.ended = true; out.push({ kind: 'end', reason: this.stopReason }); return out;
  }
  end(): Delta { if (!this.ended) throw new BridgeError(502, 'upstream_stream_incomplete', 'The upstream stream ended before completion.'); return { kind: 'end', reason: this.stopReason }; }
}

type OutputNode = { kind: 'text'; id: string; text: string; index: number } |
  { kind: 'reasoning'; id: string; record: ReasoningRecord; index: number; text: string; size: number; sealed?: string } |
  { kind: 'call'; id: string; callId: string; name: string; arguments: string; custom: boolean; namespace?: string; index: number };
export class DownstreamEncoder {
  readonly id = `mb_${randomUUID().replaceAll('-', '')}`;
  private tokens = unknownTokens(); private nodes: OutputNode[] = [];
  private reasoning = new Map<number, Extract<OutputNode, { kind: 'reasoning' }>>();
  private calls = new Map<number, Extract<OutputNode, { kind: 'call' }>>();
  private texts = new Map<number, Extract<OutputNode, { kind: 'text' }>>();
  private completedBlocks = new Set<OutputNode>(); private messagePosition = 0;
  private seq = 0; private started = false; private ended = false; private reason = 'stop'; private outputBytes = 0; private reasoningBytes = 0;
  constructor(private protocol: Protocol, private model: string, private tools: Tool[], private context?: ReasoningContext) {}
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
    if (delta.kind === 'block_end') {
      for (const node of [this.reasoning.get(delta.index), this.texts.get(delta.index), this.calls.get(delta.index)]) if (node) this.completedBlocks.add(node);
      return this.protocol === 'messages' ? this.flushMessages() : '';
    }
    let out = this.start();
    if (delta.kind === 'reasoning') {
      if (!this.context) throw new BridgeError(502, 'reasoning_context_required', 'Translated thinking requires an authenticated reasoning context.');
      const text = reasoningText(delta.record); const old = this.reasoning.get(delta.index);
      if (old && this.protocol === 'messages' && old.index < this.messagePosition && JSON.stringify(old.record) !== JSON.stringify(delta.record)) throw new BridgeError(502, 'invalid_reasoning_stream', 'The upstream changed a completed thinking block.');
      const size = Buffer.byteLength(JSON.stringify(delta.record));
      this.reasoningBytes += size - (old?.size ?? 0);
      if (size > 2 * 1024 * 1024 || this.reasoningBytes > 8 * 1024 * 1024 || !old && this.reasoning.size >= 256) throw new BridgeError(502, 'reasoning_too_large', 'Reasoning history exceeds the size limit.');
      const node = old ?? { kind: 'reasoning' as const, id: `rs_${randomUUID().replaceAll('-', '')}`, index: this.nodes.length, text: '', size: 0, record: delta.record };
      const addition = text.startsWith(node.text) ? text.slice(node.text.length) : '';
      if (!old) {
        this.reasoning.set(delta.index, node); this.nodes.push(node);
        if (this.protocol === 'responses') out += this.event('response.output_item.added', { output_index: node.index, item: { id: node.id, type: 'reasoning', summary: [] } }) + this.event('response.reasoning_summary_part.added', { item_id: node.id, output_index: node.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      node.record = structuredClone(delta.record); node.text = text; node.size = size; node.sealed = undefined;
      if (addition) {
        if (this.protocol === 'responses') out += this.event('response.reasoning_summary_text.delta', { item_id: node.id, output_index: node.index, summary_index: 0, delta: addition });
        if (this.protocol === 'chat') out += this.chat({ reasoning_content: addition });
      }
      return out;
    }
    if (delta.kind === 'text') {
      this.outputBytes += delta.text.length;
      if (this.outputBytes > 16 * 1024 * 1024) throw new BridgeError(502, 'output_too_large', 'Translated output exceeds the size limit.');
      const index = delta.index ?? -1; let node = this.texts.get(index);
      if (!node) {
        node = { kind: 'text', id: `msg_${randomUUID().replaceAll('-', '')}`, text: '', index: this.nodes.length }; this.nodes.push(node); this.texts.set(index, node);
        if (this.protocol === 'responses') out += this.event('response.output_item.added', { output_index: node.index, item: { id: node.id, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }) + this.event('response.content_part.added', { item_id: node.id, output_index: node.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      }
      node.text += delta.text;
      if (this.protocol === 'chat') return out + this.chat({ content: delta.text });
      return out + (this.protocol === 'messages' ? '' : this.event('response.output_text.delta', { item_id: node.id, output_index: node.index, content_index: 0, delta: delta.text }));
    }
    if (delta.kind === 'tool') {
      if (this.calls.has(delta.index)) throw new BridgeError(502, 'invalid_tool_stream', 'Duplicate upstream tool index.');
      const spec = this.tools.find(t => t.name === delta.name); if (!spec) throw new BridgeError(502, 'unknown_tool', 'The upstream requested an undeclared tool.');
      const node: Extract<OutputNode, { kind: 'call' }> = { kind: 'call', id: `fc_${randomUUID().replaceAll('-', '')}`, callId: delta.id, name: spec.original, arguments: '', custom: spec.custom, namespace: spec.namespace, index: this.nodes.length };
      this.calls.set(delta.index, node); this.nodes.push(node);
      if (this.protocol === 'chat') return out + this.chat({ tool_calls: [{ index: delta.index, id: node.callId, type: 'function', function: { name: node.name, arguments: '' } }] });
      if (this.protocol === 'messages') return out;
      return out + this.event('response.output_item.added', { output_index: node.index, item: this.responseCall(node, false) });
    }
    const call = this.calls.get(delta.index); if (!call) throw new BridgeError(502, 'invalid_tool_stream', 'Tool arguments arrived before the tool declaration.');
    call.arguments += delta.text; if (call.arguments.length > 2097152) throw new BridgeError(502, 'tool_arguments_too_large', 'Tool arguments exceed the size limit.');
    if (this.protocol === 'chat') return out + this.chat({ tool_calls: [{ index: delta.index, function: { arguments: delta.text } }] });
    if (this.protocol === 'messages') return out;
    return out + (call.custom ? '' : this.event('response.function_call_arguments.delta', { item_id: call.id, output_index: call.index, delta: delta.text }));
  }
  // Messages blocks must close in order, with their final signature before stop.
  // Chat has no block boundaries and can send reasoning metadata last, so its
  // translated Messages blocks are released only once the response completes.
  private flushMessages(): string {
    let out = '';
    while (this.messagePosition < this.nodes.length && this.completedBlocks.has(this.nodes[this.messagePosition]!)) {
      const node = this.nodes[this.messagePosition++]!;
      const content_block = node.kind === 'reasoning' ? { type: 'thinking', thinking: '', signature: '' }
        : node.kind === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: node.callId, name: node.name, input: {} };
      out += sse({ type: 'content_block_start', index: node.index, content_block }, 'content_block_start');
      const delta = node.kind === 'reasoning' ? { type: 'thinking_delta', thinking: node.text }
        : node.kind === 'text' ? { type: 'text_delta', text: node.text } : { type: 'input_json_delta', partial_json: node.arguments };
      out += sse({ type: 'content_block_delta', index: node.index, delta }, 'content_block_delta');
      if (node.kind === 'reasoning') out += sse({ type: 'content_block_delta', index: node.index, delta: { type: 'signature_delta', signature: this.sealed(node) } }, 'content_block_delta');
      out += sse({ type: 'content_block_stop', index: node.index }, 'content_block_stop');
    }
    return out;
  }
  private sealed(node: Extract<OutputNode, { kind: 'reasoning' }>) { return node.sealed ??= this.context!.seal(node.record); }
  private responseCall(call: Extract<OutputNode, { kind: 'call' }>, completed: boolean): any {
    const base = { id: call.id, call_id: call.callId, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), status: completed ? 'completed' : 'in_progress' };
    if (!call.custom) return { ...base, type: 'function_call', arguments: completed ? call.arguments : '' };
    const input = completed ? JSON.parse(call.arguments).input : '';
    if (typeof input !== 'string') throw new BridgeError(502, 'invalid_tool_arguments', 'Custom tool input must be a string.');
    return { ...base, type: 'custom_tool_call', input };
  }
  private usage() {
    const t = this.tokens;
    return this.protocol === 'chat' ? { prompt_tokens: t.input ?? 0, completion_tokens: t.output ?? 0, total_tokens: (t.input ?? 0) + (t.output ?? 0) }
      : this.protocol === 'messages' ? { input_tokens: Math.max(0, (t.input ?? 0) - (t.cachedInput ?? 0) - (t.cacheWrite ?? 0)), output_tokens: t.output ?? 0, cache_read_input_tokens: t.cachedInput ?? 0, cache_creation_input_tokens: t.cacheWrite ?? 0 }
      : { input_tokens: t.input ?? 0, output_tokens: t.output ?? 0, total_tokens: (t.input ?? 0) + (t.output ?? 0), input_tokens_details: { cached_tokens: t.cachedInput ?? 0 }, output_tokens_details: { reasoning_tokens: t.reasoning ?? 0 } };
  }
  result(): any {
    this.validateCalls(); const calls = [...this.calls.values()]; const reasoning = [...this.reasoning.values()];
    if (this.protocol === 'chat') return { id: this.id, object: 'chat.completion', model: this.model, created: Math.floor(Date.now() / 1000), choices: [{ index: 0, message: { role: 'assistant', content: [...this.texts.values()].map(n => n.text).join('') || null,
      ...(reasoning.length ? { reasoning_content: reasoning.map(n => n.text).join('\n'), reasoning_details: reasoning.map(n => ({ type: 'model_bridge.reasoning', data: this.sealed(n) })) } : {}),
      ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.callId, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) }, finish_reason: this.reason }], usage: this.usage() };
    if (this.protocol === 'messages') return { id: this.id, type: 'message', role: 'assistant', model: this.model, content: this.nodes.map(n => n.kind === 'reasoning' ? { type: 'thinking', thinking: n.text, signature: this.sealed(n) } : n.kind === 'text' ? { type: 'text', text: n.text } : { type: 'tool_use', id: n.callId, name: n.name, input: JSON.parse(n.arguments) }), stop_reason: this.reason === 'tool_calls' ? 'tool_use' : this.reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: this.usage() };
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: this.model, status: this.reason === 'length' ? 'incomplete' : 'completed', output: this.nodes.map(n => n.kind === 'reasoning' ? { id: n.id, type: 'reasoning', summary: n.text ? [{ type: 'summary_text', text: n.text }] : [], encrypted_content: this.sealed(n) } : n.kind === 'text' ? { id: n.id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: n.text, annotations: [] }] } : this.responseCall(n, true)), usage: this.usage(), ...(this.reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
  }
  finish() {
    if (this.ended) return ''; this.ended = true; this.validateCalls(); let out = this.start();
    if (this.protocol === 'chat') {
      const reasoning = [...this.reasoning.values()]; if (reasoning.length) out += this.chat({ reasoning_details: reasoning.map(n => ({ type: 'model_bridge.reasoning', data: this.sealed(n) })) });
      return out + this.chat({}, this.reason) + sse({ id: this.id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: this.model, choices: [], usage: this.usage() }) + sse('[DONE]');
    }
    if (this.protocol === 'messages') {
      for (const node of this.nodes) this.completedBlocks.add(node);
      out += this.flushMessages();
      return out + sse({ type: 'message_delta', delta: { stop_reason: this.reason === 'tool_calls' ? 'tool_use' : this.reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: this.usage() }, 'message_delta') + sse({ type: 'message_stop' }, 'message_stop');
    }
    const response = this.result();
    for (const node of this.nodes) {
      if (node.kind === 'reasoning') out += this.event('response.reasoning_summary_text.done', { item_id: node.id, output_index: node.index, summary_index: 0, text: node.text }) + this.event('response.reasoning_summary_part.done', { item_id: node.id, output_index: node.index, summary_index: 0, part: { type: 'summary_text', text: node.text } });
      else if (node.kind === 'text') out += this.event('response.output_text.done', { item_id: node.id, output_index: node.index, content_index: 0, text: node.text }) + this.event('response.content_part.done', { item_id: node.id, output_index: node.index, content_index: 0, part: { type: 'output_text', text: node.text, annotations: [] } });
      else out += this.event(node.custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', { item_id: node.id, output_index: node.index, ...(node.custom ? { input: this.responseCall(node, true).input } : { arguments: node.arguments }) });
      out += this.event('response.output_item.done', { output_index: node.index, item: response.output[node.index] });
    }
    return out + this.event(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  }
  private validateCalls() {
    for (const call of this.calls.values()) {
      let args: unknown; try { args = JSON.parse(call.arguments); } catch { throw new BridgeError(502, 'invalid_tool_arguments', 'The upstream produced invalid tool arguments.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new BridgeError(502, 'invalid_tool_arguments', 'Tool arguments must be a JSON object.');
    }
  }
}
