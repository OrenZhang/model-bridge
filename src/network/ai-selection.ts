import { ProxyAgent, fetch } from 'undici';
import { BridgeError, type Connection } from '../core/config.js';

export const AI_CHECK_INTERVAL = 5 * 60_000;
export type ProbeTarget = { key: string; label: string; url: string; method: 'GET' | 'POST'; provider: Connection['provider'] };
export type NodeResult = { node: string; available: boolean; latencyMs?: number; reason?: string };
export type Probe = (proxy: string, target: ProbeTarget, signal: AbortSignal) => Promise<Omit<NodeResult, 'node'>>;

export function aiProbeTarget(connection: Connection): ProbeTarget {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const url = connection.auth === 'chatgpt-device'
    ? 'https://chatgpt.com/backend-api/codex/models?client_version=0.167.0'
    : connection.provider === 'minimax' ? `${base}/${connection.auth === 'subscription' || base.includes('/anthropic/') || connection.models.some(m => m.protocols.includes('messages')) ? 'messages' : 'chat/completions'}` : `${base}/models`;
  const method = connection.provider === 'minimax' ? 'POST' : 'GET';
  return { key: `${connection.provider}:${method}:${url}`, label: `${connection.provider} · ${new URL(base).host}`, url, method, provider: connection.provider };
}

// An unauthenticated, provider-shaped authentication error proves API reachability,
// not account entitlement. No account keys, prompts or model generations are sent.
export function aiResponseAvailable(target: ProbeTarget, status: number, contentType: string, text: string) {
  if (status === 401 && target.provider === 'deepseek' && text.trim() === 'Authentication Fails (governor)') return true;
  if (!contentType.toLowerCase().includes('json')) return false;
  let value: any; try { value = JSON.parse(text); } catch { return false; }
  if (status === 200) return Array.isArray(value.data) || Array.isArray(value.models);
  if (status !== 401) return false;
  if (target.url.startsWith('https://chatgpt.com/')) return value.detail === 'Unauthorized';
  if (target.provider === 'minimax' && value.code === 401 && value.message === 'token is required') return true;
  return !!value.error && typeof value.error === 'object' &&
    ['authorized_error', 'invalid_request_error', 'authentication_error', 'invalid_authentication_error', 'invalid_api_key', 'unauthorized'].includes(value.error.type ?? value.error.code) &&
    typeof value.error.message === 'string' && /auth|api.?key|bearer|token|credential/i.test(value.error.message);
}

export const probeAiEndpoint: Probe = async (proxy, target, parent) => {
  const agent = new ProxyAgent(proxy);
  const started = performance.now();
  try {
    const response = await fetch(target.url, {
      method: target.method, redirect: 'manual', dispatcher: agent,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      ...(target.method === 'POST' ? { body: '{}' } : {}),
      signal: AbortSignal.any([parent, AbortSignal.timeout(4000)]),
    });
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024) return { available: false, reason: '检测响应过大' };
      chunks.push(chunk);
    }
    const available = aiResponseAvailable(target, response.status, response.headers.get('content-type') ?? '', Buffer.concat(chunks).toString('utf8'));
    return available ? { available, latencyMs: Math.max(1, Math.round(performance.now() - started)) } : { available, reason: `AI 接口未通过检测（HTTP ${response.status}）` };
  } catch { return { available: false, reason: '超时或连接失败' }; }
  finally { await agent.destroy(); }
};

type Context = { target: ProbeTarget; results: NodeResult[]; checkedAt?: string; task?: Promise<void>; cooldown: Map<string, number> };
export class AiNodeSelection {
  private contexts = new Map<string, Context>();
  private controller = new AbortController();
  private timer: ReturnType<typeof setInterval>;
  constructor(private nodes: string[], private url: (index: number) => string, private probe: Probe = probeAiEndpoint,
    interval = AI_CHECK_INTERVAL, private now: () => number = Date.now) {
    this.timer = setInterval(() => { void this.checkAll(); }, interval); this.timer.unref();
  }
  private best(context: Context) {
    return context.results.filter(result => result.available && (context.cooldown.get(result.node) ?? 0) <= this.now())
      .sort((a, b) => a.latencyMs! - b.latencyMs!)[0];
  }
  private context(target: ProbeTarget) {
    let context = this.contexts.get(target.key);
    if (!context) {
      if (this.contexts.size >= 32) throw new BridgeError(503, 'ai_probe_limit', '此订阅的 AI 检测目标过多。');
      context = { target, results: [], cooldown: new Map() }; this.contexts.set(target.key, context);
    }
    return context;
  }
  async choose(target: ProbeTarget) {
    if (this.controller.signal.aborted) throw new BridgeError(503, 'subscription_unavailable', '内置网络已停止。');
    const context = this.context(target);
    if (!context.checkedAt) await this.check(context);
    const best = this.best(context);
    if (!best) throw new BridgeError(503, 'no_ai_proxy_available', '此 AI 服务暂时没有通过检测的代理节点，请检查订阅或手动选择节点。');
    return this.url(this.nodes.indexOf(best.node));
  }
  failed(target: ProbeTarget, proxy: string) {
    const context = this.contexts.get(target.key); if (!context) return;
    const index = this.nodes.findIndex((_, i) => this.url(i) === proxy); if (index < 0) return;
    context.cooldown.set(this.nodes[index]!, this.now() + 60_000);
    // The next request uses the next healthy cached node; model requests are never replayed.
    void this.check(context);
  }
  async checkAll() { for (const context of this.contexts.values()) { if (this.controller.signal.aborted) break; await this.check(context); } }
  private check(context: Context) {
    if (context.task) return context.task;
    if (this.controller.signal.aborted) return Promise.resolve();
    context.task = (async () => {
      const results: NodeResult[] = new Array(this.nodes.length); let next = 0;
      const worker = async () => {
        while (!this.controller.signal.aborted) {
          const i = next++; if (i >= this.nodes.length) return;
          const node = this.nodes[i]!;
          if ((context.cooldown.get(node) ?? 0) > this.now()) { results[i] = { node, available: false, reason: '最近连接失败，稍后重测' }; continue; }
          try { const value = await this.probe(this.url(i), context.target, this.controller.signal); results[i] = { ...value, node, available: value.available && Number.isFinite(value.latencyMs) && value.latencyMs! >= 0 }; }
          catch { results[i] = { node, available: false, reason: '检测失败' }; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, this.nodes.length) }, worker));
      if (!this.controller.signal.aborted) { context.results = results; context.checkedAt = new Date(this.now()).toISOString(); }
    })().finally(() => { context.task = undefined; });
    return context.task;
  }
  snapshot() { return [...this.contexts.values()].map(context => ({ target: context.target.label, checking: !!context.task, selected: this.best(context)?.node, latencyMs: this.best(context)?.latencyMs, available: context.results.filter(r => r.available && (context.cooldown.get(r.node) ?? 0) <= this.now()).length, total: this.nodes.length, checkedAt: context.checkedAt })); }
  async close() { clearInterval(this.timer); this.controller.abort(); await Promise.allSettled([...this.contexts.values()].map(c => c.task)); }
}
