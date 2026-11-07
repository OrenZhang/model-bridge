import { BridgeError, type Protocol } from '../core/config.js';
import { unknownTokens, type Tokens } from '../core/usage.js';
import type { SearchSource } from '../core/web-search.js';
import { DownstreamEncoder, UpstreamDecoder, encodeRequest, gatewaySearchName, hostedSearch, type Canonical, type Delta, type SearchExecution } from './codec.js';
import type { ReasoningContext } from './reasoning.js';
import { SSEDecoder } from './sse.js';

export function searchPolicy(input: any) {
  const declarations = Array.isArray(input.tools) ? input.tools.filter((tool: any) => hostedSearch(tool?.type)) : [];
  if (!declarations.length) return undefined;
  if (declarations.length !== 1) throw new BridgeError(400, 'web_search_options', 'Declare a single web_search tool.');
  const tool = declarations[0];
  if (tool.external_web_access === false && !tool.type.includes('_preview')) {
    throw new BridgeError(400, 'web_search_live_required', 'Model Bridge 搜索需要联网。请将 Codex 的 web_search 设置为 live。');
  }
  const domains = tool.filters?.allowed_domains ?? [];
  if (!Array.isArray(domains) || domains.length > 100 ||
      domains.some(domain => typeof domain !== 'string' || domain.length > 253 || !/^[a-z0-9.-]+$/i.test(domain)) ||
      Object.keys(tool.filters ?? {}).some(key => key !== 'allowed_domains')) {
    throw new BridgeError(400, 'web_search_options', '当前搜索支持 allowed_domains 域名筛选。');
  }
  return { domains: domains.map((domain: string) => domain.toLowerCase()), required: hostedSearch(input.tool_choice?.type), disabled: input.tool_choice === 'none' || input.tool_choice?.type === 'none' };
}

interface SearchRunOptions {
  protocol: Protocol;
  canonical: Canonical;
  reasoning: ReasoningContext;
  model: string;
  upstreamModel: string;
  policy: NonNullable<ReturnType<typeof searchPolicy>>;
  payload: any;
  assumeSse: boolean;
  request: (payload: any) => Promise<ResponseLike>;
  search: (query: string, domains: string[]) => Promise<SearchSource[]>;
  emit: (event: string) => Promise<void>;
  reportUsage: (usage: Tokens) => void;
}

type ResponseLike = { headers: { get: (name: string) => string | null }; body: AsyncIterable<Uint8Array> | null };
type PendingSearch = { id: string; arguments: string };

function addUsage(total: Tokens, next: Tokens) {
  for (const key of Object.keys(total) as (keyof Tokens)[]) {
    const count = next[key];
    if (count !== null) total[key] = (total[key] ?? 0) + count;
  }
}

async function readRound(response: ResponseLike, decoder: UpstreamDecoder, consume: (delta: Delta) => string, emit: SearchRunOptions['emit'], assumeSse: boolean) {
  if (!response.body) throw new BridgeError(502, 'empty_upstream_response', 'The upstream returned an empty response.');
  const type = response.headers.get('content-type');
  if (!type?.includes('text/event-stream') && !(assumeSse && !type)) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) throw new BridgeError(502, 'upstream_response_too_large', 'The upstream response exceeds the size limit.');
      chunks.push(chunk);
    }
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BridgeError(502, 'invalid_upstream_json', 'The upstream returned invalid JSON.'); }
    for (const delta of decoder.decodeJSON(result)) await emit(consume(delta));
    return;
  }
  let pending: string[] = [];
  const parser = new SSEDecoder(event => {
    for (const delta of decoder.decode(event.data)) pending.push(consume(delta));
  });
  for await (const chunk of response.body) {
    parser.push(chunk);
    for (const event of pending) await emit(event);
    pending = [];
  }
  parser.finish();
  for (const event of pending) await emit(event);
}

function parseQuery(call: PendingSearch) {
  let query: unknown;
  try { query = JSON.parse(call.arguments)?.query; } catch { /* Validated below. */ }
  if (typeof query !== 'string' || !query.trim() || query.length > 500) {
    throw new BridgeError(502, 'invalid_search_query', 'The model produced an invalid web search query.');
  }
  return query.trim();
}

export async function runWebSearch(options: SearchRunOptions) {
  const { protocol, canonical, policy, payload, emit } = options;
  const encoder = new DownstreamEncoder('responses', options.model, canonical.tools, options.reasoning);
  const sources = [...(canonical.searchSources ?? [])];
  const tokens = unknownTokens();
  let executions = 0;
  if (protocol === 'messages') {
    if (payload.tool_choice?.type !== 'none') payload.tool_choice = { ...(payload.tool_choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
  } else payload.parallel_tool_calls = false;

  while (true) {
    const decoder = new UpstreamDecoder(protocol);
    const searches = new Map<number, PendingSearch>();
    let clientCalls = 0;
    await readRound(await options.request(payload), decoder, delta => {
      if (delta.kind === 'tool') {
        if (delta.name === gatewaySearchName) {
          if (searches.has(delta.index) || executions + searches.size >= 4) {
            throw new BridgeError(502, 'web_search_limit', '本轮联网搜索已达到四次上限。');
          }
          searches.set(delta.index, { id: delta.id, arguments: '' });
          return '';
        }
        clientCalls++;
      }
      if (delta.kind === 'args') {
        const search = searches.get(delta.index);
        if (search) {
          search.arguments += delta.text;
          if (search.arguments.length > 4096) throw new BridgeError(502, 'invalid_search_query', 'The model produced an oversized search query.');
          return '';
        }
      }
      return encoder.accept(delta);
    }, emit, options.assumeSse);
    encoder.accept(decoder.end());
    addUsage(tokens, decoder.tokens);
    options.reportUsage(tokens);

    if (!searches.size) {
      if (policy.required && !executions) throw new BridgeError(502, 'web_search_not_called', '模型未执行要求的联网搜索，请重试。');
      if (!clientCalls) await emit(encoder.appendSearchSources(sources));
      encoder.accept({ kind: 'usage', tokens });
      const result = encoder.result();
      await emit(encoder.finish());
      return result;
    }
    if (policy.disabled) throw new BridgeError(502, 'web_search_not_allowed', 'The model called web_search despite tool_choice none.');
    if (clientCalls) throw new BridgeError(502, 'web_search_mixed_tools', '模型在同一批次混合调用了联网搜索和客户端工具，请重试。');

    const completed: SearchExecution[] = [];
    for (const call of searches.values()) {
      const query = parseQuery(call);
      const found = await options.search(query, policy.domains);
      completed.push({ call: { ...call, name: gatewaySearchName }, query, sources: found });
      sources.push(...found);
      executions++;
    }
    const next = encoder.completeSearch(completed);
    await emit(next.events);
    const addition = encodeRequest(protocol, { system: '', tools: [], messages: next.messages }, options.upstreamModel, options.reasoning);
    if (protocol === 'responses') payload.input.push(...addition.input);
    else payload.messages.push(...addition.messages);
    if (payload.tool_choice) {
      payload.tool_choice = protocol === 'messages' ? { type: 'auto', disable_parallel_tool_use: true } : 'auto';
    }
  }
}
