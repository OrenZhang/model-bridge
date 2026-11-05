import { coSailHeaders } from './host-identity.js';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, type Connection } from '../core/config.js';
import type { Network } from '../core/network.js';
import type { SecretStore } from '../core/store.js';
import type { LoginState } from './device-login.js';

export function subscriptionEndpoints(provider: string, region: 'cn' | 'global' = 'cn') {
  if (provider === 'kimi') return { host: region === 'cn' ? 'https://auth.kimi.com' : 'https://auth.kimi.ai', device: '/api/oauth/device_authorization', token: '/api/oauth/token', client: '17e5f671-d194-4dfb-9706-5516cb48c098', base: region === 'cn' ? 'https://api.kimi.com/coding/v1' : 'https://api.kimi.ai/coding/v1' };
  if (provider === 'minimax') return { host: region === 'cn' ? 'https://account.minimax.cn' : 'https://account.minimax.io', device: '/oauth2/device/code', token: '/oauth2/token', client: 'mcode-public', base: region === 'cn' ? 'https://agent.minimax.cn/mavis/api/v1/llm/v1' : 'https://agent.minimax.io/mavis/api/v1/llm/v1' };
  throw new Error('This provider does not support subscription login.');
}
interface Tokens { access: string; refresh: string; expires: number; accountId?: string; account?: string; subject?: string }
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
function claims(token: string): any { try { return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()); } catch { return {}; } }
function tokenGrant(data: any, provider: string, previous?: Tokens): Tokens {
  const access = data.access_token; const refresh = data.refresh_token ?? (provider === 'minimax' ? previous?.refresh : undefined); const seconds = Number(data.expires_in);
  if (!text(access) || !text(refresh) || !Number.isFinite(seconds) || seconds <= 0 || data.token_type && String(data.token_type).toLowerCase() !== 'bearer') throw new Error('Invalid OAuth token response.');
  const hint = claims(access);
  const subject = text(hint.sub) ? hint.sub : undefined;
  const previousSubject = previous?.subject ?? (previous ? claims(previous.access).sub : undefined);
  if (provider === 'kimi' && previousSubject && subject && previousSubject !== subject) throw new BridgeError(409, 'account_identity_changed', '刷新返回了不同的 Kimi 账号，请重新授权。');
  const scopes = data.scope ?? hint.scope ?? hint.scp;
  if (provider === 'minimax' && (!(typeof scopes === 'string' ? scopes.split(/\s+/) : Array.isArray(scopes) ? scopes : []).includes('agent.default') || hint.aud && !(Array.isArray(hint.aud) ? hint.aud : [hint.aud]).includes('agent-backend'))) throw new Error('MiniMax did not grant the required agent-backend scope.');
  const accountId = provider === 'kimi' && previous?.accountId ? previous.accountId : text(hint.account_id ?? hint.sub) ? hint.account_id ?? hint.sub : previous?.accountId;
  return { access, refresh, expires: Date.now() + seconds * 1000, ...(accountId ? { accountId } : {}), ...(subject ? { subject } : {}), ...(previous?.account ? {account:previous.account} : text(hint.email) ? { account: hint.email } : {}) };
}

/** Independent per-connection OAuth session. Refresh credentials stay in the OS vault. */
export class ProviderLogin extends EventEmitter {
  state: LoginState = { phase: 'idle' };
  private endpoints;
  private controller?: AbortController;
  private refreshAbort = new AbortController();
  private generation = 0;
  private refreshTask?: Promise<Tokens>;
  private writes: Promise<unknown> = Promise.resolve();
  private ref: string;
  constructor(private connection: Connection, private network: Network, private secrets: SecretStore, private pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, signal) => delay(ms, undefined, { signal }), private identity:Record<string,string>=coSailHeaders(randomUUID(),connection.provider==='kimi')) {
    super(); this.endpoints = subscriptionEndpoints(connection.provider, connection.region);
    if (connection.baseUrl.replace(/\/+$/, '') !== this.endpoints.base) throw new Error('Subscription credentials require the official regional endpoint.');
    this.ref = `subscription:${connection.provider}:${connection.region}:${connection.id}`;
  }
  updateConnection(connection: Connection) {
    if ([connection.id, connection.auth, connection.provider, connection.region, connection.baseUrl].join('\0') !== [this.connection.id, this.connection.auth, this.connection.provider, this.connection.region, this.connection.baseUrl].join('\0')) throw new Error('Subscription connection changed.');
    this.connection = connection;
  }
  private accountState(tokens: Tokens): LoginState {
    return { phase: 'authenticated', method: 'device', account: tokens.account ?? (this.connection.provider === 'minimax' ? 'MiniMax' : 'Kimi'), accountId: tokens.accountId };
  }
  async restore() {
    if (this.state.phase !== 'idle') return;
    const generation = this.generation;
    try {
      const tokens = await this.loadCredentials();
      // Restoring saved credentials must not emit a new authorization event or rotate identity.
      if (generation === this.generation && this.state.phase === 'idle') this.publish(this.accountState(tokens));
    } catch {
      if (generation === this.generation && this.state.phase === 'idle' && this.connection.credentialVersion) this.publish({ phase: 'error', error: '无法恢复订阅登录，请检查网络或重新授权。' });
    }
  }
  private publish(state: LoginState) { this.state = state; this.emit('state', state); }
  private async form(endpoint: string, values: Record<string, string>, signal?: AbortSignal) {
    const response = await this.network.request(this.connection, this.endpoints.host + endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...this.identity }, body: new URLSearchParams(values).toString(), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
    const data = await response.json() as any;
    return { ok: response.ok, data, status: response.status };
  }
  private store(value: Tokens | null, generation: number) {
    const operation = this.writes.then(async () => {
      if (generation !== this.generation) return;
      if (!this.secrets.set) throw new Error('A writable credential vault is required.');
      await this.secrets.set(this.ref, value ? JSON.stringify(value) : '');
      if (generation !== this.generation) await this.secrets.set(this.ref, '');
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async login() {
    if (['starting', 'waiting'].includes(this.state.phase)) return this.state;
    const generation = ++this.generation;
    this.refreshAbort.abort(); this.refreshAbort = new AbortController(); this.refreshTask = undefined;
    const controller = new AbortController(); this.controller = controller;
    this.publish({ phase: 'starting', method: 'device' });
    try {
      const minimax = this.connection.provider === 'minimax';
      const verifier = randomBytes(32).toString('base64url');
      const start = await this.form(this.endpoints.device, { client_id: this.endpoints.client, ...(minimax ? { scope: 'agent.default', audience: 'agent-backend', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } : {}) }, controller.signal);
      if (generation !== this.generation) return this.state;
      const d = start.data; const accountVariant = minimax && !d.device_code && d.user_code && Number(d.expired_in) > 0;
      const code = d.device_code ?? (accountVariant ? d.user_code : undefined);
      const url = new URL(d.verification_uri_complete ?? d.verification_uri ?? d.verification_url);
      const domains = minimax ? ['minimax.cn', 'minimax.io'] : ['kimi.com', 'kimi.ai'];
      if (!start.ok || !text(code) || !text(d.user_code) || url.protocol !== 'https:' || url.username || url.password || url.port || !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('Invalid device authorization response.');
      const expiry = Number(d.expires_in ?? (accountVariant ? Number(d.expired_in) >= 1e12 ? (Number(d.expired_in) - Date.now()) / 1000 : d.expired_in : 600));
      if (!Number.isFinite(expiry) || expiry <= 0) throw new Error('Device authorization has expired.');
      this.publish({ phase: 'waiting', method: 'device', verificationUrl: url.href, userCode: d.user_code });
      void this.poll(generation, controller.signal, { [accountVariant ? 'user_code' : 'device_code']: code, ...(minimax ? { code_verifier: verifier } : {}) }, Math.max(1000, Math.min(60000, Number(d.interval ?? (accountVariant ? 5000 : 5)) * (accountVariant ? 1 : 1000) || 5000)), Date.now() + Math.min(expiry, 1800) * 1000).catch(() => {
        if (generation === this.generation && !controller.signal.aborted) this.publish({ phase: 'error', error: '订阅授权失败或已过期，请检查账号、套餐和网络后重新登录。' });
      });
    } catch { if (generation === this.generation) this.publish({ phase: 'error', error: '无法启动订阅登录，请检查此连接的网络设置。' }); }
    return this.state;
  }
  private async poll(generation: number, signal: AbortSignal, code: Record<string, string>, interval: number, expires: number) {
    while (Date.now() < expires) {
      await this.pause(interval, signal);
      const { ok, data } = await this.form(this.endpoints.token, { client_id: this.endpoints.client, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', ...code }, signal);
      if (generation !== this.generation) return;
      const status = data.error ?? data.status;
      if (status === 'slow_down') { interval += 5000; continue; }
      if (status === 'authorization_pending' || status === 'pending') continue;
      if (!ok || ['denied', 'access_denied', 'expired', 'expired_token'].includes(status)) throw new Error('Authorization denied or expired.');
      const tokens = tokenGrant(data, this.connection.provider);
      if (this.connection.provider === 'kimi') {
        try {
          const profile = await this.network.request(this.connection, this.endpoints.base + '/me', { headers: { authorization: `Bearer ${tokens.access}`, ...this.identity }, signal: AbortSignal.any([signal,AbortSignal.timeout(15000)]) });
          if (profile.ok) { const p = await profile.json() as any; if (text(p.user_id)) tokens.accountId = p.user_id; if (text(p.email ?? p.nickname)) tokens.account = p.email ?? p.nickname; }
          else await profile.body?.cancel();
        } catch { signal.throwIfAborted(); /* Profile hints are optional. */ }
      }
      await this.store(tokens, generation);
      if (generation === this.generation) {
        this.publish(this.accountState(tokens));
        this.emit('authorized', this.state);
      }
      return;
    }
    throw new Error('Authorization expired.');
  }
  async credentials() {
    const tokens = await this.loadCredentials();
    return { token: tokens.access };
  }
  private async loadCredentials(): Promise<Tokens> {
    if (['starting', 'waiting'].includes(this.state.phase)) throw new BridgeError(503, 'login_in_progress', '此账号正在重新授权，请完成或取消后重试。');
    if (this.refreshTask) return this.refreshTask;
    const generation = this.generation;
    const refreshSignal = this.refreshAbort.signal;
    const task = (async () => {
      const raw = await this.secrets.get(this.ref); let value: Tokens;
      try { value = JSON.parse(raw ?? 'null'); } catch { throw new BridgeError(401, 'login_required', '请先登录此订阅账号。'); }
      if (!value || !text(value.access) || !text(value.refresh) || !Number.isFinite(value.expires)) throw new BridgeError(401, 'login_required', '请先登录此订阅账号。');
      if (value.expires <= Date.now() + 60000) {
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = await this.form(this.endpoints.token, { client_id: this.endpoints.client, grant_type: 'refresh_token', refresh_token: value.refresh, ...(this.connection.provider === 'minimax' ? { scope: 'agent.default', audience: 'agent-backend' } : {}) }, refreshSignal);
            if (this.connection.provider !== 'kimi' || result.data.error === 'invalid_grant' || ![429, 500, 502, 503, 504].includes(result.status) || attempt === 2) break;
          } catch (error) { if (this.connection.provider !== 'kimi' || attempt === 2 || generation !== this.generation) throw error; }
          if (generation !== this.generation) throw new BridgeError(401, 'login_cancelled', '账号状态已更改，请重试。');
          await this.pause(1000 * 2 ** attempt, refreshSignal);
        }
        if (!result) throw new BridgeError(503, 'login_refresh_failed', '订阅凭据刷新失败，请稍后重试。');
        if (!result.ok || result.data.error === 'invalid_grant') throw new BridgeError(result.data.error === 'invalid_grant' || result.status === 400 || result.status === 401 || result.status === 403 ? 401 : 503, 'login_refresh_failed', '订阅凭据刷新失败，请稍后重试或重新登录。');
        const refreshed = tokenGrant(result.data, this.connection.provider, value);
        if (this.connection.accountId && refreshed.accountId && this.connection.accountId !== refreshed.accountId) throw new BridgeError(409, 'account_identity_changed', '订阅账号身份已更改，请重新连接后开始新对话。');
        value = refreshed; await this.store(value, generation);
      }
      if (this.connection.accountId && value.accountId && this.connection.accountId !== value.accountId) throw new BridgeError(409, 'account_identity_changed', '订阅账号身份已更改，请重新连接后开始新对话。');
      if (generation !== this.generation) throw new BridgeError(401, 'login_cancelled', '账号登录状态已更改，请重试。');
      return value;
    })();
    this.refreshTask = task;
    try { return await task; } finally { if (this.refreshTask === task) this.refreshTask = undefined; }
  }
  async cancel() { this.close(); return this.state; }
  close() { this.generation++; this.controller?.abort(); this.refreshAbort.abort(); if (['starting', 'waiting'].includes(this.state.phase)) this.publish({ phase: 'cancelled' }); }
  async logout() { this.close(); await this.store(null, this.generation); this.publish({ phase: 'idle' }); }
}
