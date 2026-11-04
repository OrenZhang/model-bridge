import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { atomicWrite } from '../core/store.js';
import type { Config } from '../core/config.js';
import { codexCatalog, models } from '../core/catalog.js';

const digest = (text: string | null) => createHash('sha256').update(text === null ? '\0missing' : text).digest('hex');
async function read(file: string) { try { return await readFile(file, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } }
export type ClientName = 'codex' | 'claude';
const claudeManagedKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_API_KEY'];
function settingsObject(client: ClientName, text: string | null): any {
  const value = text === null ? {} : client === 'codex' ? parse(text) : JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client configuration.');
  return value;
}
function gatewayBase(client: ClientName, settings: any): unknown {
  return client === 'codex' ? settings.model_provider === 'model_bridge' ? settings.model_providers?.model_bridge?.base_url : undefined : settings.env?.ANTHROPIC_BASE_URL;
}
function pointsToGateway(client: ClientName, settings: any, address: string) {
  const base = gatewayBase(client, settings);
  return typeof base === 'string' && base.replace(/\/+$/, '') === address.replace(/\/+$/, '') + (client === 'codex' ? '/v1' : '');
}
function restoreFields(current: any, original: any, keys: string[]) {
  for (const key of keys) { if (Object.hasOwn(original, key)) current[key] = original[key]; else delete current[key]; }
}
function restoreManagedSettings(client: ClientName, current: any, original: any) {
  if (client === 'codex') {
    restoreFields(current, original, ['model_provider', 'model', 'model_catalog_json']);
    restoreFields(current.model_providers, original.model_providers ?? {}, ['model_bridge']);
    if (!Object.keys(current.model_providers).length && !Object.hasOwn(original, 'model_providers')) delete current.model_providers;
  } else {
    restoreFields(current.env, original.env ?? {}, claudeManagedKeys);
    if (!Object.keys(current.env).length && !Object.hasOwn(original, 'env')) delete current.env;
  }
  return client === 'codex' ? stringify(current) : JSON.stringify(current, null, 2) + '\n';
}
export interface ClientStatus {
  client: ClientName;
  mode: 'bridge' | 'external' | 'unconfigured' | 'error';
  serviceName: string;
  model?: string;
  connectionId?: string;
  modelAvailable?: boolean;
  canRestore: boolean;
  error?: string;
}
export interface ClientPlan { id: string; client: ClientName; path: string; beforeHash: string; content: string; preview: string; model: string; snippet: string; portable: string; }
export class ClientConfiguration {
  private plans = new Map<string, ClientPlan>();
  private catalogWrites: Promise<void> = Promise.resolve();
  private changes = new Map<ClientName, Promise<unknown>>();
  constructor(private home: string, private dataDirectory: string, private codexHome = path.join(home, '.codex')) {}
  private file(client: ClientName) { return client === 'codex' ? path.join(this.codexHome, 'config.toml') : path.join(this.home, '.claude', 'settings.json'); }
  private serialize<T>(client: ClientName, change: () => Promise<T>): Promise<T> {
    const next = (this.changes.get(client) ?? Promise.resolve()).then(change);
    this.changes.set(client, next.catch(() => {})); return next;
  }
  private async originalBackup(client: ClientName) {
    const pointer = JSON.parse((await read(path.join(this.dataDirectory, `${client}-backup.json`))) ?? 'null');
    if (!pointer) throw new Error('没有可恢复的原始客户端设置。');
    const backup = JSON.parse(await readFile(pointer.backupPath, 'utf8'));
    if (backup.path !== this.file(client) || (backup.before !== null && typeof backup.before !== 'string') || typeof backup.installedHash !== 'string' || !/^[a-f0-9]{64}$/.test(backup.installedHash)) throw new Error('原始客户端备份无效。');
    return backup as { path: string; before: string | null; installedHash: string };
  }
  async status(client: ClientName, config: Config, address: string): Promise<ClientStatus> {
    const defaultName = client === 'codex' ? '官方 OpenAI / ChatGPT' : '默认 Anthropic';
    try {
      const file = this.file(client); const before = await read(file);
      let canRestore = false; let validBackup = false;
      try {
        const backup = await this.originalBackup(client); validBackup = true;
        canRestore = backup.installedHash === digest(before);
      } catch { /* Missing or invalid backup must not make the client unreadable. */ }
      if (before === null) return { client, mode: 'unconfigured', serviceName: defaultName, canRestore };
      const existing = settingsObject(client, before);
      const model = client === 'codex' ? existing.model : existing.env?.ANTHROPIC_MODEL;
      const selectedModel = typeof model === 'string' && model ? model : undefined;
      const baseUrl = client === 'codex' ? existing.model_providers?.[existing.model_provider]?.base_url : existing.env?.ANTHROPIC_BASE_URL;
      const isBridge = pointsToGateway(client, existing, address);
      canRestore ||= validBackup && isBridge;
      if (isBridge) {
        const selected = models(config).find(entry => entry.id === selectedModel);
        return { client, mode: 'bridge', serviceName: selected?.connection.name ?? (selectedModel ? '原服务已移除或停用' : '统一模型（未选择默认模型）'), ...(selectedModel ? { model: selectedModel } : {}),
          ...(selected ? { connectionId: selected.connection.id } : {}), modelAvailable: !!selected, canRestore };
      }
      const native = client === 'codex' ? (!existing.model_provider || existing.model_provider === 'openai') && !baseUrl : !baseUrl;
      return { client, mode: 'external', serviceName: native ? defaultName : '外部服务',
        ...(selectedModel ? { model: selectedModel } : {}), canRestore };
    } catch {
      return { client, mode: 'error', serviceName: '无法读取当前服务', canRestore: false, error: '客户端设置无法读取，请检查文件格式和权限。' };
    }
  }
  async switchService(client: ClientName, config: () => Config, address: string, token: string, model: string) {
    return this.serialize(client, async () => {
      const plan = await this.plan(client, config(), address, token, model);
      try { await this.applyPlan(plan.id, config()); }
      finally { this.plans.delete(plan.id); }
      return this.status(client, config(), address);
    });
  }
  async enableGateway(client: ClientName, config: () => Config, address: string, token: string) {
    return this.serialize(client, async () => {
      const settings = config(); const current = await this.status(client, settings, address);
      const available = models(settings).filter(entry => entry.model.tools);
      const target = (current.mode === 'bridge' ? available.find(entry => entry.id === current.model) : undefined) ?? available[0];
      if (!target) throw new Error('请先添加至少一个已启用且支持工具调用的模型，再启用统一模型模式。');
      const plan = await this.plan(client, settings, address, token, target.id);
      try { await this.applyPlan(plan.id, config()); }
      finally { this.plans.delete(plan.id); }
      return this.status(client, config(), address);
    });
  }
  async plan(client: ClientName, config: Config, address: string, token: string, selected?: string) {
    const target = selected ? models(config).find(m => m.id === selected && m.model.tools) : models(config).find(m => m.model.tools);
    if (!target) throw new Error('Add an enabled model with tool-call support before connecting a client.');
    const file = this.file(client);
    const before = await read(file);
    let content: string; let generated: any;
    if (client === 'codex') {
      const existing: any = before ? parse(before) : {};
      existing.model_provider = 'model_bridge'; existing.model = target.id;
      existing.model_catalog_json = path.join(this.dataDirectory, 'codex-models.json');
      existing.model_providers = { ...existing.model_providers, model_bridge: { name: 'Model Bridge', base_url: address + '/v1', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, experimental_bearer_token: token } };
      generated = { model_provider: existing.model_provider, model: existing.model, model_catalog_json: existing.model_catalog_json, model_providers: { model_bridge: existing.model_providers.model_bridge } };
      content = stringify(existing);
    } else {
      const existing = before ? JSON.parse(before) : {};
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Claude settings must be a JSON object.');
      existing.env = { ...existing.env, ANTHROPIC_BASE_URL: address, ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_MODEL: target.id, ANTHROPIC_DEFAULT_OPUS_MODEL: target.id,
        ANTHROPIC_DEFAULT_SONNET_MODEL: target.id, ANTHROPIC_DEFAULT_HAIKU_MODEL: target.id,
        CLAUDE_CODE_SUBAGENT_MODEL: target.id };
      delete existing.env.ANTHROPIC_API_KEY;
      generated = { env: Object.fromEntries(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].map(key => [key, existing.env[key]])) };
      content = JSON.stringify(existing, null, 2) + '\n';
    }
    const snippet = client === 'codex' ? stringify(generated) : JSON.stringify(generated, null, 2) + '\n';
    const portable = JSON.stringify({ client, format: client === 'codex' ? 'toml' : 'json', configuration: generated }, null, 2) + '\n';
    const plan = { id: randomUUID(), client, path: file, beforeHash: digest(before), content, model: target.id, snippet, portable,
      preview: snippet.split(token).join('<local gateway key>') };
    this.plans.set(plan.id, plan); return { id: plan.id, client, path: file, beforeHash: plan.beforeHash, preview: plan.preview, model: target.id };
  }
  export(planId: string, format: 'native' | 'json') { const plan = this.plans.get(planId); if (!plan) throw new Error('请重新生成客户端配置。'); return format === 'json' ? plan.portable : plan.snippet; }
  async apply(planId: string, config: Config) {
    const plan = this.plans.get(planId); if (!plan) throw new Error('Generate a new configuration preview first.');
    return this.serialize(plan.client, () => this.applyPlan(planId, config));
  }
  private async applyPlan(planId: string, config: Config) {
    const plan = this.plans.get(planId); if (!plan) throw new Error('Generate a new configuration preview first.');
    if (!models(config).some(m => m.id === plan.model && m.model.tools)) throw new Error('The selected model changed after preview. Generate a new preview.');
    const before = await read(plan.path);
    if (digest(before) !== plan.beforeHash) throw new Error('The client configuration changed after preview. Generate a new preview.');
    const backupPath = path.join(this.dataDirectory, 'backups', `${plan.client}-${Date.now()}-${randomUUID()}.json`);
    let original = before;
    try {
      const previous = await this.originalBackup(plan.client);
      const currentBase = gatewayBase(plan.client, settingsObject(plan.client, before));
      const installedBase = gatewayBase(plan.client, settingsObject(plan.client, plan.content));
      const sameGateway = typeof currentBase === 'string' && typeof installedBase === 'string' && currentBase.replace(/\/+$/, '') === installedBase.replace(/\/+$/, '');
      if (previous.installedHash === digest(before)) original = previous.before;
      else if (sameGateway) original = restoreManagedSettings(plan.client, settingsObject(plan.client, before), settingsObject(plan.client, previous.before));
    } catch { /* The first install has no previous baseline. */ }
    await atomicWrite(backupPath, JSON.stringify({ path: plan.path, before: original, installedHash: digest(plan.content) }, null, 2));
    await this.updateCatalog(config);
    await atomicWrite(plan.path, plan.content); this.plans.delete(planId);
    await atomicWrite(path.join(this.dataDirectory, `${plan.client}-backup.json`), JSON.stringify({ backupPath }));
    return { path: plan.path, backupPath };
  }
  async restore(client: ClientName) {
    return this.serialize(client, () => this.restoreClient(client));
  }
  async restoreOriginalMode(client: ClientName, address: string) {
    return this.serialize(client, async () => {
      const backup = await this.originalBackup(client); const before = await read(backup.path);
      if (digest(before) === backup.installedHash) return this.restoreClient(client);
      const current = settingsObject(client, before);
      if (!pointsToGateway(client, current, address)) throw new Error('客户端已切换到其他连接，不能覆盖当前设置。');
      const content = restoreManagedSettings(client, current, settingsObject(client, backup.before));
      if (digest(await read(backup.path)) !== digest(before)) throw new Error('客户端设置刚刚发生变化，请重新切换。');
      await atomicWrite(backup.path, content);
      return { path: backup.path };
    });
  }
  private async restoreClient(client: ClientName) {
    const pointer = JSON.parse((await read(path.join(this.dataDirectory, `${client}-backup.json`))) ?? 'null');
    if (!pointer) throw new Error('No Model Bridge backup is available for this client.');
    const backup = JSON.parse(await readFile(pointer.backupPath, 'utf8'));
    if (digest(await read(backup.path)) !== backup.installedHash) throw new Error('Client settings changed after installation. Restore manually from the backup to preserve those edits.');
    if (backup.before === null) {
      const { unlink } = await import('node:fs/promises'); await unlink(backup.path);
    } else await atomicWrite(backup.path, backup.before);
    return { path: backup.path };
  }
  async updateCatalog(config: Config) {
    const content = JSON.stringify(codexCatalog(config));
    const write = this.catalogWrites.then(() => atomicWrite(path.join(this.dataDirectory, 'codex-models.json'), content));
    this.catalogWrites = write.catch(() => {}); await write;
  }
}
