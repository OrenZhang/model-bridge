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
export interface ClientPlan { id: string; client: ClientName; path: string; beforeHash: string; content: string; preview: string; model: string; snippet: string; portable: string; }
export class ClientConfiguration {
  private plans = new Map<string, ClientPlan>();
  private catalogWrites: Promise<void> = Promise.resolve();
  constructor(private home: string, private dataDirectory: string, private codexHome = path.join(home, '.codex')) {}
  async plan(client: ClientName, config: Config, address: string, token: string, selected?: string) {
    const target = selected ? models(config).find(m => m.id === selected && m.model.tools) : models(config).find(m => m.model.tools);
    if (!target) throw new Error('Add an enabled model with tool-call support before connecting a client.');
    const file = client === 'codex' ? path.join(this.codexHome, 'config.toml') : path.join(this.home, '.claude', 'settings.json');
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
    if (!models(config).some(m => m.id === plan.model && m.model.tools)) throw new Error('The selected model changed after preview. Generate a new preview.');
    const before = await read(plan.path);
    if (digest(before) !== plan.beforeHash) throw new Error('The client configuration changed after preview. Generate a new preview.');
    const backupPath = path.join(this.dataDirectory, 'backups', `${plan.client}-${Date.now()}-${randomUUID()}.json`);
    let original = before;
    try {
      const pointer = JSON.parse(await readFile(path.join(this.dataDirectory, `${plan.client}-backup.json`), 'utf8'));
      const previous = JSON.parse(await readFile(pointer.backupPath, 'utf8'));
      if (previous.path === plan.path && previous.installedHash === digest(before)) original = previous.before;
    } catch { /* The first install has no previous baseline. */ }
    await atomicWrite(backupPath, JSON.stringify({ path: plan.path, before: original, installedHash: digest(plan.content) }, null, 2));
    await this.updateCatalog(config);
    await atomicWrite(plan.path, plan.content); this.plans.delete(planId);
    await atomicWrite(path.join(this.dataDirectory, `${plan.client}-backup.json`), JSON.stringify({ backupPath }));
    return { path: plan.path, backupPath };
  }
  async restore(client: ClientName) {
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
