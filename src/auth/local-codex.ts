import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { atomicWrite, type SecretStore } from '../core/store.js';
import type { Config, Connection } from '../core/config.js';

interface Source { id: string; home: string; }
export interface LocalCodexInfo {
  id: string; directory: string; present: boolean; provider: string; model?: string;
  kind: 'chatgpt' | 'api-key' | 'none'; email?: string; plan?: string;
  canImport: boolean; connectionId?: string; imported: boolean; message?: string;
}
type KeyringReader = (home: string) => Promise<string | null>;
async function readKeyring(home: string) {
  const canonical = await realpath(home).catch(() => home);
  const key = 'cli|' + createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const { AsyncEntry } = await import('@napi-rs/keyring');
  return new AsyncEntry('Codex Auth', key).getPassword(AbortSignal.timeout(5000));
}
function claims(token: unknown): any {
  if (typeof token !== 'string') return {};
  try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return {}; }
}
async function text(file: string) { try { if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('Local file exceeds size limit.'); return await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } }
export class LocalCodexAccounts {
  private sources: Source[];
  private cached: LocalCodexInfo[] = [];
  constructor(home: string, override: string | undefined, private data: string, private config: () => Config, private secrets: SecretStore, private keyring: KeyringReader = readKeyring) {
    this.sources = [...new Set([override ? path.resolve(override) : undefined, path.join(home, '.codex')].filter((p): p is string => !!p))].map((directory, index) => ({ id: `local-${index}`, home: directory }));
  }
  private async load(source: Source) {
    const configText = await text(path.join(source.home, 'config.toml'));
    const settings: any = configText ? parse(configText) : {};
    let raw: string | null = null;
    const mode = settings.cli_auth_credentials_store ?? 'file';
    if (mode === 'auto' || mode === 'keyring') raw = await this.keyring(source.home).catch(() => null);
    if (!raw && mode !== 'keyring') raw = await text(path.join(source.home, 'auth.json'));
    return { settings, auth: raw ? JSON.parse(raw) : {}, present: !!raw || !!configText, raw };
  }
  private identify(source: Source, loaded: Awaited<ReturnType<LocalCodexAccounts['load']>>) {
    const { auth, settings } = loaded;
    const token = auth.tokens;
    const chatgpt = token && typeof token.access_token === 'string' && typeof token.refresh_token === 'string' && typeof token.account_id === 'string';
    const apiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 0;
    const jwt = claims(token?.id_token); const extra = jwt['https://api.openai.com/auth'] ?? {};
    // JWT claims are display hints only. They do not authorize a request.
    const email = typeof jwt.email === 'string' ? jwt.email : undefined;
    const identity = chatgpt ? token.account_id + ':' + (email ?? '') : source.home;
    const known = chatgpt ? this.config().connections.find(c => c.auth === 'chatgpt-device' && c.accountId === token.account_id && c.accountEmail === email) : undefined;
    const connectionId = known?.id ?? 'codex-' + createHash('sha256').update(identity).digest('hex').slice(0, 14);
    const info: LocalCodexInfo = { id: source.id, directory: source.home, present: loaded.present, provider: settings.model_provider ?? 'openai', model: settings.model, kind: chatgpt ? 'chatgpt' : apiKey ? 'api-key' : 'none', canImport: !!(chatgpt || apiKey), connectionId, imported: this.config().connections.some(c => c.id === connectionId), ...(email ? { email } : {}), ...(typeof extra.chatgpt_plan_type === 'string' ? { plan: extra.chatgpt_plan_type } : {}) };
    if (!info.canImport) info.message = '未找到可复用的登录凭据。可通过设备码添加账号；新版系统凭据格式可能需要重新授权。';
    return info;
  }
  async scan() {
    this.cached = await Promise.all(this.sources.map(async source => {
      try { return this.identify(source, await this.load(source)); }
      catch { return { id: source.id, directory: source.home, present: true, provider: 'unknown', kind: 'none' as const, canImport: false, imported: false, message: '本机 Codex 配置或凭据暂不可读，请检查文件和系统凭据权限。' }; }
    }));
    return this.cached;
  }
  list() { return this.cached.map(info => ({ ...info, imported: this.config().connections.some(c => c.id === info.connectionId) })); }
  async importAccount(sourceId: string): Promise<Connection> {
    const source = this.sources.find(s => s.id === sourceId); if (!source) throw new Error('请重新检测本机 Codex 账号。');
    const loaded = await this.load(source); const info = this.identify(source, loaded);
    if (!info.canImport) throw new Error(info.message);
    const existing = this.config().connections.find(c => c.id === info.connectionId); if (existing) return existing;
    const connection: Connection = { id: info.connectionId!, name: info.email ? `Codex · ${info.email}` : '本机 Codex 账号', provider: 'openai', auth: info.kind === 'chatgpt' ? 'chatgpt-device' : 'api-key', baseUrl: info.kind === 'chatgpt' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.com/v1', loginMethod: 'browser', region: 'cn', ...(info.kind === 'chatgpt' ? { accountId: loaded.auth.tokens.account_id, ...(info.email ? { accountEmail: info.email } : {}) } : {}), reasoningModes:{}, proxy: { mode: 'inherit' }, enabled: true, models: [] };
    if (info.kind === 'chatgpt') {
      const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: loaded.auth.tokens, last_refresh: loaded.auth.last_refresh };
      await atomicWrite(path.join(this.data, 'accounts', connection.id, 'codex', 'auth.json'), JSON.stringify(auth));
    } else {
      if (!this.secrets.set) throw new Error('当前模式没有可写凭据存储。');
      connection.secretRef = `connection:${connection.id}`; await this.secrets.set(connection.secretRef, loaded.auth.OPENAI_API_KEY);
    }
    return connection;
  }
}
