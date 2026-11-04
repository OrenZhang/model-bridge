import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'smol-toml';
import { ClientConfiguration } from '../src/clients/configure.js';
import { ConfigSchema } from '../src/core/config.js';
import { unknownTokens, usageTokens, estimatedCost, usageCsv } from '../src/core/usage.js';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const config = () => ConfigSchema.parse({ connections: [{ id: 'kimi', name: 'Kimi', auth: 'api-key', provider: 'kimi', baseUrl: 'https://example.invalid/v1', models: [{ id: 'coding', name: 'Coding', upstreamId: 'coding', protocols: ['responses'] }] }] });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 'model-bridge-client-')); dirs.push(dir); return { dir, clients: new ClientConfiguration(dir, path.join(dir, 'data')) }; }
describe('client configuration', () => {
  it('preserves unrelated Codex values, redacts preview and restores exact original content', async () => {
    const { dir, clients } = await setup(); const file = path.join(dir, '.codex/config.toml');
    await mkdir(path.dirname(file)); const original = '# my note\nmodel = "old"\n[mcp_servers.test]\ncommand = "sample"\n'; await writeFile(file, original);
    const plan = await clients.plan('codex', config(), 'http://127.0.0.1:18765', 'local-secret');
    expect(plan.preview).not.toContain('local-secret');
    await clients.apply(plan.id, config());
    const after: any = parse(await readFile(file, 'utf8')); expect(after.mcp_servers.test.command).toBe('sample'); expect(after.model).toBe('kimi/coding');
    expect(after.model_providers.model_bridge.requires_openai_auth).toBe(false);
    await clients.restore('codex'); expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('rejects stale previews and refuses to overwrite later user edits on restore', async () => {
    const { dir, clients } = await setup(); const file = path.join(dir, '.claude/settings.json'); await mkdir(path.dirname(file)); await writeFile(file, '{}');
    const plan = await clients.plan('claude', config(), 'http://127.0.0.1:18765', 'key'); await writeFile(file, '{"new":true}');
    await expect(clients.apply(plan.id, config())).rejects.toThrow('changed after preview');
    const current = await clients.plan('claude', config(), 'http://127.0.0.1:18765', 'key'); await clients.apply(current.id, config()); await writeFile(file, '{"userEdit":true}');
    await expect(clients.restore('claude')).rejects.toThrow('changed after installation');
  });
  it('exports minimal native and JSON configurations without unrelated secrets', async () => {
    const { dir, clients } = await setup();
    await mkdir(path.join(dir, '.codex')); await mkdir(path.join(dir, '.claude'));
    await writeFile(path.join(dir, '.codex/config.toml'), '[mcp_servers.private]\ncommand = "private-tool"\n[mcp_servers.private.env]\nSECRET = "unrelated-secret"\n');
    await writeFile(path.join(dir, '.claude/settings.json'), JSON.stringify({ env: { OTHER_SECRET: 'unrelated-secret', ANTHROPIC_API_KEY: 'previous-key' }, permissions: { allow: ['Read'] } }));
    for (const client of ['codex', 'claude'] as const) {
      const plan = await clients.plan(client, config(), 'http://127.0.0.1:18765', 'gateway-key');
      expect(JSON.stringify(plan)).not.toContain('gateway-key');
      expect(plan.preview).not.toContain('unrelated-secret');
      const native = clients.export(plan.id, 'native'); const portable = clients.export(plan.id, 'json');
      expect(native).toContain('gateway-key'); expect(native).not.toContain('unrelated-secret'); expect(native).not.toContain('previous-key');
      expect(JSON.parse(portable).configuration).toEqual(client === 'codex' ? parse(native) : JSON.parse(native));
      await clients.apply(plan.id, config());
      const installed = await readFile(plan.path, 'utf8'); expect(installed).toContain('unrelated-secret');
      if (client === 'claude') expect(JSON.parse(installed).env.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });
  it('restores the original baseline after repeated model switches', async () => {
    const { dir, clients } = await setup(); const file = path.join(dir, '.codex/config.toml');
    await mkdir(path.dirname(file)); const original = '# original profile\nmodel = "before-bridge"\n'; await writeFile(file, original);
    const initial = config();
    const first = await clients.plan('codex', initial, 'http://127.0.0.1:18765', 'key'); await clients.apply(first.id, initial);
    initial.connections[0]!.models.push({ ...initial.connections[0]!.models[0]!, id: 'second', upstreamId: 'second', name: 'Second' });
    const second = await clients.plan('codex', initial, 'http://127.0.0.1:18765', 'key', 'kimi/second'); await clients.apply(second.id, initial);
    expect(parse(await readFile(file, 'utf8')).model).toBe('kimi/second');
    await clients.restore('codex'); expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('supports authenticated SOCKS5 profiles without embedding passwords in configuration', () => {
    expect(ConfigSchema.parse({ proxies: [{ id: 'proxy', name: 'Local', url: 'socks5://127.0.0.1:1080', credentialRef: 'proxy-secret' }] }).proxies).toHaveLength(1);
    expect(() => ConfigSchema.parse({ proxies: [{ id: 'bad', name: 'Bad', url: 'http://user:password@localhost:1234' }] })).toThrow();
  });
});
describe('usage accounting', () => {
  it('keeps missing usage unknown and adds Anthropic cached input exactly once', () => {
    expect(usageTokens('responses', undefined)).toEqual(unknownTokens());
    const tokens = usageTokens('messages', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 });
    expect(usageTokens('messages', { output_tokens: 4 }, tokens)).toMatchObject({ input: 35, output: 4, cachedInput: 20, cacheWrite: 5 });
    expect(estimatedCost(config().connections[0]!.models[0]!, tokens)).toBeNull();
  });
  it('escapes spreadsheet formulas in exported CSV', () => {
    const csv = usageCsv([{ id: '1', startedAt: '2026-11-04T00:00:00Z', clientId: '=1+1', connectionId: 'x', provider: 'custom', model: 'x', upstreamModel: 'x', protocol: 'chat', status: 'success', durationMs: 1, firstByteMs: 1, tokens: unknownTokens(), estimatedCostUsd: null }]);
    expect(csv).toContain('"\'=1+1"');
  });
});
