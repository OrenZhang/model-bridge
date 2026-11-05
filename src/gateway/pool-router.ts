import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { BridgeError, type Protocol } from '../core/config.js';
import { digest, routeFingerprint, reasoningScope, type ModelRoute } from '../core/model-pool.js';
import { atomicWrite } from '../core/store.js';
import { isGatewayReasoning, type ReasoningVault } from './reasoning.js';
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
  const first = typeof input.input === 'string' ? input.input : messages?.find?.((item: any) => item.role === 'user')?.content;
  if (first === undefined) throw new BridgeError(400, 'pool_session_required', 'Include user history or X-Model-Bridge-Session for stable account routing.');
  const content = typeof first === 'string' ? [{ type: 'text', text: first }] : Array.isArray(first) ? first.map((part: any) => ['text', 'input_text', 'output_text'].includes(part.type) ? { type: 'text', text: part.text } : part) : first;
  return ['first-user', content];
}
function supportsRequest(route: ModelRoute, input: any) {
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
  select(pool: string, candidates: ModelRoute[], input: any, client: string, protocol: Protocol, vault: ReasoningVault, session?: string, previousPools: string[] = []) {
    const operation = this.changes.then(async () => {
      const key = digest(JSON.stringify([client, pool, sessionIdentity(input, session)]));
      const tokens = envelopes(input);
      const currentBound = this.state.bindings[key];
      const previous = previousPools.map(old=>this.state.bindings[digest(JSON.stringify([client,old,sessionIdentity(input,session)]))]).filter(Boolean);
      if (!currentBound && new Set(previous.map(b=>JSON.stringify([b!.connectionId,b!.fingerprint]))).size>1) throw new BridgeError(409,'pool_history_ambiguous','Multiple previous channels match this session. Start a new conversation.');
      const bound = currentBound ?? previous[0];
      let selected: ModelRoute | undefined;
      if (bound) {
        selected = candidates.find(r => r.connection.id === bound.connectionId && routeFingerprint(r) === bound.fingerprint);
        if (!selected) throw new BridgeError(409, 'pool_account_unavailable', 'The original account changed or is unavailable. Restore it or start a new conversation.');
      }
      if (tokens.length) {
        const matches = candidates.filter(route => {
          try { const upstream = route.model.protocols.includes(protocol) ? protocol : route.model.protocols[0]!;
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
        const history = Array.isArray(input.input) ? input.input : input.messages;
        if (input.previous_response_id || input.conversation || history?.some?.((m: any) => ['assistant', 'tool'].includes(m.role) || ['reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(m.type))) throw new BridgeError(409, 'pool_history_unbound', 'Cannot identify the original account for this conversation. Start a new conversation.');
        const compatible = candidates.filter(r=>supportsRequest(r,input));
        if (!compatible.length) throw new BridgeError(400,'model_capability_unavailable','No enabled channel supports the requested tools, images or thinking level.');
        const available = compatible.filter(r => (this.cooldown.get(r.connection.id) ?? 0) <= Date.now()).sort((a, b) => a.connection.id.localeCompare(b.connection.id));
        if (!available.length) throw new BridgeError(503, 'pool_accounts_cooling_down', 'All accounts are temporarily unavailable. Retry later.');
        const cursor = this.state.cursor[pool] ?? 0;
        selected = available[cursor % available.length]!;
      }
      if (!supportsRequest(selected,input)) throw new BridgeError(400,'model_capability_unavailable','The original channel does not support this request. Start a new conversation to select another channel.');
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
      return structuredClone(selected);
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
