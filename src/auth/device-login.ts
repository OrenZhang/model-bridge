import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { BridgeError, type Connection } from '../core/config.js';
import type { Network } from '../core/network.js';
import { codexBinary } from './codex-binary.js';

export interface LoginState { phase: 'idle' | 'starting' | 'waiting' | 'authenticated' | 'error' | 'cancelled'; method?: 'device' | 'browser'; verificationUrl?: string; userCode?: string; account?: string; accountId?: string; error?: string; }
export class DeviceLogin extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private startup?: Promise<void>;
  private loginId?: string;
  private deadline?: ReturnType<typeof setTimeout>;
  private completedEarly = new Map<string, any>();
  private generation = 0;
  state: LoginState = { phase: 'idle' };
  constructor(readonly home: string, private connection: Connection, private network: Network, private executable?: string) { super(); }
  private publish(state: LoginState) { this.state = state; this.emit('state', this.state); }
  private async start() {
    if (this.startup) return this.startup;
    const generation = this.generation;
    this.startup = (async () => {
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      await writeFile(path.join(this.home, 'config.toml'), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n', { mode: 0o600 });
      const proxy = await this.network.proxyUrl(this.connection, 'https://auth.openai.com', true);
      if (generation !== this.generation) throw new Error('Login was cancelled.');
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.home };
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ACCESS_TOKEN', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_IDENTITY_TOKEN_AUDIENCE']) delete env[key];
      if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy });
      env.NO_PROXY = env.no_proxy = proxy ? 'localhost,127.0.0.1,::1' : '*';
      const child = spawn(this.executable ?? codexBinary(), ['app-server', '--listen', 'stdio://'], { env, stdio: 'pipe', windowsHide: true });
      this.child = child;
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (this.child !== child) return;
        let event: any; try { event = JSON.parse(line); } catch { return; }
        if (typeof event.id === 'number') {
          const pending = this.pending.get(event.id); if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(event.id);
          if (event.error) pending.reject(new Error('The Codex authentication service rejected the operation.'));
          else pending.resolve(event.result);
        } else if (event.method === 'account/login/completed') {
          if (!this.loginId && this.state.phase === 'starting') this.completedEarly.set(event.params.loginId, event.params);
          else if (event.params.loginId === this.loginId) void this.complete(event.params);
        }
      });
      const failed = () => {
        if (this.child !== child) return;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex authentication process stopped.')); }
        this.pending.clear(); this.startup = undefined; this.child = undefined;
        if (['starting', 'waiting'].includes(this.state.phase)) this.publish({ phase: 'error', error: 'Codex authentication stopped. Check the executable and proxy configuration.' });
      };
      child.on('error', failed); child.on('exit', failed);
      await this.rpc('initialize', { clientInfo: { name: 'model_bridge', title: 'Model Bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    })();
    try { await this.startup; } catch (error) { if (generation === this.generation) this.close(false); throw error; }
  }
  private rpc(method: string, params: any): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex authentication timed out.')); }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.child?.stdin.writable) { clearTimeout(timer); this.pending.delete(id); reject(new Error('Codex executable is unavailable.')); return; }
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async login() {
    if (['starting', 'waiting'].includes(this.state.phase)) return this.state;
    const generation = this.generation;
    const method = this.connection.loginMethod ?? 'device';
    this.publish({ phase: 'starting', method });
    try {
      await this.start();
      const result = await this.rpc('account/login/start', { type: method === 'browser' ? 'chatgpt' : 'chatgptDeviceCode' });
      if (generation !== this.generation) return this.state;
      const url = new URL(method === 'browser' ? result.authUrl : result.verificationUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port || (method === 'device' && typeof result.userCode !== 'string') || typeof result.loginId !== 'string')
        throw new Error('Unexpected device login response.');
      this.loginId = result.loginId;
      this.publish({ phase: 'waiting', method, verificationUrl: url.href, ...(method === 'device' ? { userCode: result.userCode } : {}) });
      this.deadline = setTimeout(() => { void this.cancel().finally(() => this.publish({ phase: 'error', error: 'Login expired. Start authorization again.' })); }, 10 * 60000);
      const early = this.completedEarly.get(this.loginId!); this.completedEarly.clear();
      if (early) await this.complete(early);
    } catch { if (this.state.phase !== 'cancelled' && generation === this.generation) this.publish({ phase: 'error', error: 'Could not start ChatGPT login. Check the bundled Codex helper and this account’s proxy configuration.' }); }
    return this.state;
  }
  private async complete(result: any) {
    const generation = this.generation;
    clearTimeout(this.deadline); this.loginId = undefined;
    if (!result.success) { this.publish({ phase: 'error', error: 'Authorization was declined or expired.' }); return; }
    try {
      const { account } = await this.rpc('account/read', { refreshToken: false });
      if (generation !== this.generation) return;
      if (!account || account.type !== 'chatgpt') throw new Error('Not a ChatGPT account.');
      const auth = JSON.parse(await readFile(path.join(this.home, 'auth.json'), 'utf8'));
      const accountId = auth.tokens?.account_id;
      if (typeof accountId !== 'string') throw new Error('Missing account identity.');
      if (generation !== this.generation) return;
      this.publish({ phase: 'authenticated', account: account.email ?? 'ChatGPT', accountId, method: this.connection.loginMethod });
    } catch { if (generation === this.generation) this.publish({ phase: 'error', error: 'Authorization completed but the account could not be verified.' }); }
  }
  async credentials() {
    const generation = this.generation;
    try {
      await this.start();
      const { account } = await this.rpc('account/read', { refreshToken: true });
      if (!account || account.type !== 'chatgpt') throw new Error();
      const auth = JSON.parse(await readFile(path.join(this.home, 'auth.json'), 'utf8'));
      if (typeof auth.tokens?.access_token !== 'string' || typeof auth.tokens?.account_id !== 'string') throw new Error();
      if (generation !== this.generation) throw new Error('Authentication was cancelled.');
      this.publish({ phase: 'authenticated', account: account.email ?? 'ChatGPT', accountId: auth.tokens.account_id });
      return { token: auth.tokens.access_token as string, accountId: auth.tokens.account_id as string, ...(typeof account.email === 'string' ? { email: account.email } : {}) };
    } catch {
      if (generation === this.generation) this.publish({ phase: 'error', error: '账号登录已失效，请重新登录此账号。' });
      throw new BridgeError(401, 'chatgpt_login_required', 'Complete ChatGPT login for this account.');
    }
  }
  async catalog() {
    await this.start();
    const models = new Map<string, any>(); const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Codex 没有返回有效的模型目录，请重新同步。');
      for (const model of result.data) if (typeof model.model === 'string') models.set(model.model, model);
      if (!result.nextCursor) return { data: [...models.values()], nextCursor: null };
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw new Error('Codex 模型目录分页异常，请重试。');
      cursor = result.nextCursor; cursors.add(result.nextCursor as string);
    }
    throw new Error('Codex 模型目录分页过多，请重试。');
  }
  async cancel() {
    this.publish({ phase: 'cancelled' });
    // This helper is dedicated to one account. Closing it also stops device-code polling.
    this.close();
  }
  async logout() { await this.cancel(); await this.start(); await this.rpc('account/logout', {}); this.publish({ phase: 'idle' }); this.close(); }
  close(invalidate = true) { if (invalidate) this.generation++; clearTimeout(this.deadline); this.loginId = undefined; this.completedEarly.clear(); this.child?.kill(); this.child = undefined; this.startup = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Authentication service stopped.')); } this.pending.clear(); }
}
