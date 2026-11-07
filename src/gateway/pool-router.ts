import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { BridgeError, type Protocol } from '../core/config.js';
import { digest, routeFingerprint, reasoningScope, type ModelRoute } from '../core/model-pool.js';
import { controlledRequest } from '../shared/reasoning-modes.js';
import { atomicWrite } from '../core/store.js';
import { isGatewayReasoning, type ReasoningVault } from './reasoning.js';
import { upstreamProtocols } from '../shared/upstream-protocols.js';
const StateSchema = z.object({ version: z.literal(1), cursor: z.record(z.string(), z.number().int().nonnegative()), bindings: z.record(z.string(), z.object({ connectionId: z.string(), fingerprint: z.string(), updatedAt: z.number() })) });
type State = z.infer<typeof StateSchema>;
function envelopes(input: any) {
  const tokens: string[] = [];
  for (const item of Array.isArray(input.input) ? input.input : []) if (isGatewayReasoning(item.encrypted_content)) tokens.push(item.encrypted_content);
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    for (const detail of Array.isArray(message.reasoning_details) ? message.reasoning_details : []) if (isGatewayReasoning(detail.data)) tokens.push(detail.data);
    for (const block of Array.isArray(message.content) ? message.content : []) for (const value of [block.signature, block.data]) if (isGatewayReasoning(value)) tokens.push(value);
  }
  return tokens;
}
function sessionIdentity(input: any, session?: string) {
  if (session) return ['session', session];
  const messages = Array.isArray(input.input) ? input.input : input.messages;
  const first = typeof input.input === 'string' ? input.input : messages?.find?.((item: any) => item?.role === 'user' && item.content !== undefined)?.content;
  if (first === undefined) throw new BridgeError(400, 'pool_session_required', 'Include user history or X-Model-Bridge-Session for stable account routing.');
  const content = typeof first === 'string' ? [{ type: 'text', text: first }] : Array.isArray(first) ? first.map((part: any) => ['text', 'input_text', 'output_text'].includes(part.type) ? { type: 'text', text: part.text } : part) : first;
  return ['first-user', content];
}
function supportsRequest(route: ModelRoute, input: any, protocol: Protocol) {
  try { input = controlledRequest(route.connection,route.model,protocol,input); } catch { return false; }
  const model = route.model;
  if (input.tools?.length && !model.tools) return false;
  const messages = Array.isArray(input.input) ? input.input : input.messages;
  if (messages?.some?.((m:any)=>m.content?.some?.((p:any)=>['image','input_image','image_url'].includes(p.type))) && !model.images) return false;
  const effort = input.reasoning?.effort ?? input.reasoning_effort ?? input.output_config?.effort ?? input.thinking?.effort;
  const off = effort === 'none' || input.thinking?.type === 'disabled';
  if (off && model.thinking?.mode === 'only') return false;
  if (!off && (effort || input.thinking?.type === 'enabled' || input.thinking?.type === 'adaptive') && model.thinking?.mode === 'none') return false;
  if (effort && !off && model.thinking?.efforts.length && !model.thinking.efforts.includes(effort)) return false;
  if (effort && model.reasoning.length && !model.reasoning.includes(effort)) return false;
  return true;
}

function hasHistory(input: any) {
  const history = Array.isArray(input.input) ? input.input : input.messages;
  return input.previous_response_id || input.conversation || history?.some?.((item: any) =>
    ['assistant', 'tool'].includes(item?.role) ||
    ['reasoning', 'compaction', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'tool_search_call', 'tool_search_output', 'web_search_call'].includes(item?.type));
}

/** Earlier turns are transcript context after a model switch. Keep the active
 * turn intact so the selected model still receives its own tool and thinking state. */
function portableResponsesHistory(items: any[]) {
  const latestUser = items.findLastIndex(item => item?.role === 'user' && (!item.type || item.type === 'message'));
  if (latestUser <= 0) return undefined;
  const previousTurns = items.slice(0, latestUser);
  if (!hasHistory({ input: previousTurns })) return undefined;
  const history = previousTurns.flatMap(item => {
    switch (item?.type) {
      case 'reasoning':
      case 'compaction':
      case 'tool_search_call':
      case 'tool_search_output':
      case 'web_search_call':
        return [];
      case 'function_call':
      case 'custom_tool_call':
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const label = item.type.endsWith('_output') ? 'Tool result' : 'Tool call';
        const content = item.output ?? { name: item.name, namespace: item.namespace, arguments: item.arguments ?? item.input };
        return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[${label} ${item.call_id}] ${JSON.stringify(content)}` }] }];
      }
      default:
        if (item?.role === 'assistant' && (!item.type || item.type === 'message')) {
          return [{ type: 'message', role: 'assistant', content: item.content }];
        }
        return [item];
    }
  });
  const activeTurn = items.slice(latestUser);
  return { items: [...history, ...activeTurn], activeTurn };
}
export class PoolRouter {
  private state: State = { version: 1, cursor: {}, bindings: {} };
  private changes: Promise<unknown> = Promise.resolve();
  private cooldown = new Map<string, number>();
  constructor(private file?: string) {}
  async load() {
    if (this.file) try { this.state = StateSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Model pool routing state is invalid. Restore pool-routing.json before continuing existing conversations.'); }
    return this;
  }
  select(pool: string, candidates: ModelRoute[], input: any, client: string, protocol: Protocol, vault: ReasoningVault, session?: string, previousPools: string[] = [], options: { otherPools?: string[]; legacyFirstUser?: boolean } = {}) {
    const operation = this.changes.then(async () => {
      const identity = sessionIdentity(input, session);
      const bindingKey = (poolId: string, identityParts = identity) => digest(JSON.stringify([client, poolId, identityParts]));
      const key = bindingKey(pool);
      const historical = hasHistory(input);
      const legacyIdentity = options.legacyFirstUser && historical && Array.isArray(input.input)
        && input.input.some((item: any) => item?.role === 'user' && item.content !== undefined)
        ? sessionIdentity(input) : undefined;
      const boundFor = (poolId: string) => this.state.bindings[bindingKey(poolId)]
        ?? (legacyIdentity && this.state.bindings[bindingKey(poolId, legacyIdentity)]);
      const switched = protocol === 'responses' && Array.isArray(input.input) && historical && options.otherPools?.some(id => boundFor(id));
      const portableHistory = switched && !input.previous_response_id && !input.conversation ? portableResponsesHistory(input.input) : undefined;
      const portableInput = portableHistory?.items;
      if (portableInput) input = { ...input, input: portableInput };
      const tokens = envelopes(input);
      const currentBound = this.state.bindings[key];
      const samePool = boundFor(pool);
      const previous = previousPools.map(boundFor).filter(Boolean);
      if (!samePool && new Set(previous.map(b=>JSON.stringify([b!.connectionId,b!.fingerprint]))).size>1) throw new BridgeError(409,'pool_history_ambiguous','Multiple previous channels match this session. Start a new conversation.');
      const bound = samePool ?? previous[0];
      let selected: ModelRoute | undefined;
      if (bound) {
        selected = candidates.find(r => r.connection.id === bound.connectionId && routeFingerprint(r) === bound.fingerprint);
        if (!selected) throw new BridgeError(409, 'pool_account_unavailable', 'The original account changed or is unavailable. Restore it or start a new conversation.');
      }
      if (tokens.length) {
        const matches = candidates.filter(route => {
          try { const protocols = upstreamProtocols(route.connection, route.model.protocols);
            const upstream = protocols.includes(protocol) ? protocol : protocols[0]!;
            const context = vault.context(reasoningScope(client, route), upstream, route.connection.provider, route.model.upstreamId);
            tokens.forEach(token => context.open(token)); return true;
          } catch { return false; }
        });
        if (matches.length !== 1 || selected && selected.connection.id !== matches[0]!.connection.id) throw new BridgeError(400, 'invalid_reasoning_state', 'Original account is unavailable or reasoning history is invalid. Start a new conversation.');
        selected = matches[0];
      }
      if (!selected) {
        // An unrecognized continuation may contain native signed/opaque state.
        // Never send that state to an account chosen as if this were a new chat.
        if (historical && (!portableHistory || hasHistory({ input: portableHistory.activeTurn }))) throw new BridgeError(409, 'pool_history_unbound', 'Cannot identify the original account for this conversation. Start a new conversation.');
        const compatible = candidates.filter(r=>supportsRequest(r,input,protocol));
        if (!compatible.length) throw new BridgeError(400,'model_capability_unavailable','No enabled channel supports the requested tools, images or thinking level.');
        const available = compatible.filter(r => (this.cooldown.get(r.connection.id) ?? 0) <= Date.now()).sort((a, b) => a.connection.id.localeCompare(b.connection.id));
        if (!available.length) throw new BridgeError(503, 'pool_accounts_cooling_down', 'All accounts are temporarily unavailable. Retry later.');
        const cursor = this.state.cursor[pool] ?? 0;
        selected = available[cursor % available.length]!;
      }
      if (!supportsRequest(selected,input,protocol)) throw new BridgeError(400,'model_capability_unavailable','The original channel does not support this request. Start a new conversation to select another channel.');
      if ((this.cooldown.get(selected.connection.id) ?? 0) > Date.now()) throw new BridgeError(429, 'pool_account_cooling_down', 'The original account is temporarily unavailable. Retry this conversation later.');
      if (!currentBound) {
        const next = structuredClone(this.state);
        // Never evict an older binding: clients may resume a compacted history
        // containing only the latest user turn, which looks like a new chat.
        if (Object.keys(next.bindings).length >= 10000) throw new BridgeError(503, 'pool_capacity_reached', 'The model pool conversation limit has been reached. Preserve existing routing records before maintenance.');
        next.bindings[key] = { connectionId: selected.connection.id, fingerprint: routeFingerprint(selected), updatedAt: Date.now() };
        if (!bound && !tokens.length) next.cursor[pool] = ((next.cursor[pool] ?? 0) + 1) % 1000000000;
        if (this.file) await atomicWrite(this.file, JSON.stringify(next));
        this.state = next;
      }
      return { ...structuredClone(selected), portableInput };
    });
    this.changes = operation.catch(() => {});
    return operation;
  }
  rejected(connectionId: string, status: number, retryAfter?: string | null) {
    if (![401, 403, 429].includes(status)) return;
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : 60;
    this.cooldown.set(connectionId, Date.now() + Math.max(1, Math.min(Number.isFinite(seconds) ? seconds : 60, 3600)) * 1000);
  }
}
