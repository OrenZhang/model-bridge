import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import { ClientConfiguration, resolveClientAddress } from '../src/clients/configure.js';
import { ConfigSchema } from '../src/core/config.js';
import { unknownTokens, usageTokens, estimatedCost, usageCsv } from '../src/core/usage.js';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const config = () => ConfigSchema.parse({ connections: [{ id: 'kimi', name: 'Kimi', auth: 'api-key', provider: 'kimi', baseUrl: 'https://example.invalid/v1', models: [{ id: 'coding', name: 'Coding', upstreamId: 'coding', protocols: ['responses'] }] }] });
async function setup() { const dir = await mkdtemp(path.join(os.tmpdir(), 'model-bridge-client-')); dirs.push(dir); return { dir, clients: new ClientConfiguration(dir, path.join(dir, 'data')) }; }
describe('client configuration', () => {
  it.each(['codex', 'claude'] as const)('exports portable %s LAN settings without host paths, native secrets or local writes', async client => {
    const { dir, clients } = await setup(); const file = path.join(dir, client === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    await mkdir(path.dirname(file)); const original = 'private native contents that do not need to be parsed during export'; await writeFile(file, original);
    const settings = config(); settings.connections[0]!.secretRef = 'private-provider-key';
    settings.connections.push({ ...settings.connections[0]!, id: 'minimax', name: 'MiniMax', provider: 'minimax' });
    const portable = clients.portable(client, settings, 'http://192.168.31.21:18765', 'exported-gateway-key');
    const exported: any = client === 'codex' ? parse(portable.configuration) : JSON.parse(portable.configuration);
    expect(portable.preview).not.toContain('exported-gateway-key'); expect(portable.configuration).toContain('exported-gateway-key');
    expect(JSON.stringify(portable.files)).not.toContain(dir); expect(JSON.stringify(portable.files)).not.toContain('private-provider-key');
    expect(JSON.stringify(portable.files)).not.toContain(original); expect(await readFile(file, 'utf8')).toBe(original);
    await expect(readFile(path.join(dir, 'data/codex-models.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (client === 'codex') {
      expect(exported.model_catalog_json).toBe('codex-models.json');
      expect(exported.web_search).toBe('disabled');
      expect(exported.model_providers.model_bridge).toMatchObject({ base_url: 'http://192.168.31.21:18765/v1', requires_openai_auth: false });
      expect(Object.keys(portable.files)).toEqual(['config.toml', 'codex-models.json', 'README.txt', 'install-macos.sh', 'install-windows.ps1']);
      expect(JSON.parse(portable.catalog!).models.map((model: any) => model.slug)).toEqual(['kimi/coding', 'minimax/coding']);
    } else {
      expect(exported.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://192.168.31.21:18765', ANTHROPIC_AUTH_TOKEN: 'exported-gateway-key' });
      expect(portable.catalog).toBeUndefined(); expect(Object.keys(portable.files)).toEqual(['settings.json', 'README.txt', 'install-macos.sh', 'install-windows.ps1']);
    }
  });
  it('rejects wildcard and stale LAN export destinations instead of silently copying loopback', async () => {
    const { clients } = await setup(); const local = 'http://127.0.0.1:18765'; const lan = 'http://192.168.31.21:18765';
    expect(resolveClientAddress(local, local, [])).toBe(local);
    expect(resolveClientAddress(lan, local, [lan])).toBe(lan);
    expect(() => resolveClientAddress(lan, local, [])).toThrow('局域网地址');
    expect(() => resolveClientAddress('http://0.0.0.0:18765', local, [])).toThrow();
    expect(() => clients.portable('codex', config(), 'http://0.0.0.0:18765', 'key')).toThrow('0.0.0.0');
    expect(() => clients.portable('codex', ConfigSchema.parse({}), local, 'key')).toThrow('至少一个');
  });
  it('enables the entire Codex model catalog and restores original authentication settings without changing login files', async () => {
    const { dir, clients } = await setup(); const codexDirectory = path.join(dir, '.codex'); await mkdir(codexDirectory);
    const file = path.join(codexDirectory, 'config.toml'); const authFile = path.join(codexDirectory, 'auth.json');
    const original = '# native login\nmodel_provider = "openai"\nmodel = "native-model"\n[mcp_servers.test]\ncommand = "original-tool"\n';
    const originalAuth = '{"tokens":{"access_token":"fixture-native-access","refresh_token":"fixture-native-refresh"}}';
    await writeFile(file, original); await writeFile(authFile, originalAuth);
    const settings = config();
    settings.connections.push({ ...settings.connections[0]!, id: 'minimax', name: 'MiniMax', provider: 'minimax' });
    settings.connections.push({ ...settings.connections[0]!, id: 'openai', name: 'OpenAI', provider: 'openai' });
    const address = 'http://127.0.0.1:18765';
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await clients.enableGateway('codex', () => settings, address, 'gateway-key')).toMatchObject({ mode: 'bridge', canRestore: true });
      const installed: any = parse(await readFile(file, 'utf8'));
      expect(installed.model_provider).toBe('model_bridge');
      expect(installed.web_search).toBe('disabled');
      expect(installed.model_providers.model_bridge).toMatchObject({ base_url: address + '/v1', requires_openai_auth: false, experimental_bearer_token: 'gateway-key' });
      expect(installed.mcp_servers.test.command).toBe('original-tool');
      const catalog = JSON.parse(await readFile(installed.model_catalog_json, 'utf8'));
      expect(catalog.models.map((entry: any) => entry.slug)).toEqual(['kimi/coding', 'minimax/coding', 'openai/coding']);
      expect(await readFile(authFile, 'utf8')).toBe(originalAuth);
      await clients.restore('codex');
      expect(await readFile(file, 'utf8')).toBe(original); expect(await readFile(authFile, 'utf8')).toBe(originalAuth);
    }
  });
  it('keeps an available gateway default model without narrowing the catalog to that provider', async () => {
    const { dir, clients } = await setup(); const settings = config(); const address = 'http://127.0.0.1:18765';
    settings.connections.push({ ...settings.connections[0]!, id: 'minimax', name: 'MiniMax', provider: 'minimax' });
    await clients.switchService('codex', () => settings, address, 'gateway-key', 'minimax/coding');
    expect(await clients.enableGateway('codex', () => settings, address, 'gateway-key')).toMatchObject({ model: 'minimax/coding' });
    expect(JSON.parse(await readFile(path.join(dir, 'data/codex-models.json'), 'utf8')).models.map((entry: any) => entry.slug)).toEqual(['kimi/coding', 'minimax/coding']);
    settings.connections[1]!.enabled = false;
    expect(await clients.enableGateway('codex', () => settings, address, 'gateway-key')).toMatchObject({ model: 'kimi/coding' });
  });
  it('refuses unified mode with no available agent model before changing client settings', async () => {
    const { dir, clients } = await setup(); const file = path.join(dir, '.codex/config.toml'); await mkdir(path.dirname(file));
    const original = 'model_provider = "openai"\n'; await writeFile(file, original);
    const settings = config(); settings.connections[0]!.models[0]!.tools = false;
    await expect(clients.enableGateway('codex', () => settings, 'http://127.0.0.1:18765', 'gateway-key')).rejects.toThrow('请先添加至少一个已启用且支持工具调用的模型');
    expect(await readFile(file, 'utf8')).toBe(original);
    await expect(readFile(path.join(dir, 'data/codex-backup.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['codex', 'claude'] as const)('restores original %s authentication after model changes while keeping unrelated edits', async client => {
    const { dir, clients } = await setup(); const address = 'http://127.0.0.1:18765'; const settings = config();
    const file = path.join(dir, client === 'codex' ? '.codex/config.toml' : '.claude/settings.json'); await mkdir(path.dirname(file));
    const original = client === 'codex' ? 'model_provider = "openai"\nmodel = "original-model"\n' : '{"env":{"ANTHROPIC_API_KEY":"original-key","ANTHROPIC_MODEL":"original-model"}}';
    await writeFile(file, original);
    const login = path.join(path.dirname(file), client === 'codex' ? 'auth.json' : '.credentials.json'); await writeFile(login, 'original-login-file');
    for (const reenable of [false, true]) {
      await clients.enableGateway(client, () => settings, address, 'gateway-key');
      const installed = await readFile(file, 'utf8'); const edited: any = client === 'codex' ? parse(installed) : JSON.parse(installed);
      edited.unrelated_setting = 'keep-user-edit';
      if (client === 'codex') edited.model = 'changed-in-client'; else edited.env.ANTHROPIC_MODEL = 'changed-in-client';
      await writeFile(file, client === 'codex' ? stringify(edited) : JSON.stringify(edited));
      expect(await clients.status(client, settings, address)).toMatchObject({ mode: 'bridge', canRestore: true });
      if (reenable) await clients.enableGateway(client, () => settings, address, 'gateway-key');
      await clients.restoreOriginalMode(client, address);
      const restoredText = await readFile(file, 'utf8'); const restored: any = client === 'codex' ? parse(restoredText) : JSON.parse(restoredText);
      expect(restored.unrelated_setting).toBe('keep-user-edit');
      if (client === 'codex') {
        expect(restored.model_provider).toBe('openai'); expect(restored.model).toBe('original-model');
        expect(restored.model_catalog_json).toBeUndefined(); expect(restored.model_providers?.model_bridge).toBeUndefined();
      } else {
        expect(restored.env).toEqual({ ANTHROPIC_API_KEY: 'original-key', ANTHROPIC_MODEL: 'original-model' });
      }
      expect(await readFile(login, 'utf8')).toBe('original-login-file');
    }
  });
  it('does not replace an externally selected gateway when returning to original mode', async () => {
    const { dir, clients } = await setup(); const address = 'http://127.0.0.1:18765'; const settings = config();
    await clients.enableGateway('codex', () => settings, address, 'gateway-key');
    const file = path.join(dir, '.codex/config.toml'); const external = (await readFile(file, 'utf8')).replace(address, 'http://127.0.0.1:19999'); await writeFile(file, external);
    await expect(clients.restoreOriginalMode('codex', address)).rejects.toThrow('已切换到其他连接');
    expect(await readFile(file, 'utf8')).toBe(external);
  });
  it.each(['live', 'cached', undefined] as const)('restores the original web_search=%s preference after edits and repeated gateway activation', async webSearch => {
    const { dir, clients } = await setup(); const address = 'http://127.0.0.1:18765'; const settings = config();
    const file = path.join(dir, '.codex/config.toml'); await mkdir(path.dirname(file));
    await writeFile(file, stringify({ model_provider: 'openai', model: 'native-model', ...(webSearch ? { web_search: webSearch } : {}), mcp_servers: { local: { command: 'original-tool' } } }));
    for (const reenable of [false, true]) {
      await clients.enableGateway('codex', () => settings, address, 'gateway-key');
      const installed: any = parse(await readFile(file, 'utf8'));
      expect(installed.web_search).toBe('disabled');
      installed.mcp_servers.local.command = reenable ? 'second-user-edit' : 'first-user-edit';
      installed.web_search = 'cached';
      await writeFile(file, stringify(installed));
      if (reenable) {
        await clients.enableGateway('codex', () => settings, address, 'gateway-key');
        const reapplied: any = parse(await readFile(file, 'utf8'));
        expect(reapplied.web_search).toBe('disabled');
        expect(reapplied.mcp_servers.local.command).toBe('second-user-edit');
      }
      await clients.restoreOriginalMode('codex', address);
      const restored: any = parse(await readFile(file, 'utf8'));
      expect(restored.web_search).toBe(webSearch);
      expect(Object.hasOwn(restored, 'web_search')).toBe(webSearch !== undefined);
      expect(restored.model_provider).toBe('openai'); expect(restored.model).toBe('native-model');
      expect(restored.mcp_servers.local.command).toBe(reenable ? 'second-user-edit' : 'first-user-edit');
    }
  });
  it.each(['codex', 'claude'] as const)('recognizes %s gateway mode when its default model was removed manually', async client => {
    const { dir, clients } = await setup(); const settings = config(); const address = 'http://127.0.0.1:18765';
    await clients.enableGateway(client, () => settings, address, 'gateway-key');
    const file = path.join(dir, client === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    const contents = await readFile(file, 'utf8'); const edited: any = client === 'codex' ? parse(contents) : JSON.parse(contents);
    if (client === 'codex') delete edited.model; else delete edited.env.ANTHROPIC_MODEL;
    await writeFile(file, client === 'codex' ? stringify(edited) : JSON.stringify(edited));
    expect(await clients.status(client, settings, address)).toMatchObject({ mode: 'bridge', modelAvailable: false, canRestore: true });
    await clients.restoreOriginalMode(client, address);
    expect((await clients.status(client, settings, address)).mode).not.toBe('bridge');
  });
  it('reports native defaults without creating client settings or exposing paths', async () => {
    const { dir, clients } = await setup();
    const codex = await clients.status('codex', config(), 'http://127.0.0.1:18765');
    const claude = await clients.status('claude', config(), 'http://127.0.0.1:18765');
    expect(codex).toEqual({ client: 'codex', mode: 'unconfigured', serviceName: '官方 OpenAI / ChatGPT', canRestore: false });
    expect(claude).toEqual({ client: 'claude', mode: 'unconfigured', serviceName: '默认 Anthropic', canRestore: false });
    expect(JSON.stringify([codex, claude])).not.toContain(dir);
    await expect(readFile(path.join(dir, '.codex/config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['codex', 'claude'] as const)('switches %s services serially and restores the original service', async client => {
    const { dir, clients } = await setup(); const file = path.join(dir, client === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    await mkdir(path.dirname(file));
    const original = client === 'codex' ? '# original\nmodel = "native-model"\n' : '{"env":{"ANTHROPIC_MODEL":"native-model","UNRELATED_SECRET":"private-value"}}';
    await writeFile(file, original);
    const settings = config();
    settings.connections.push({ ...settings.connections[0]!, id: 'minimax', name: 'MiniMax', provider: 'minimax' });
    const first = clients.switchService(client, () => settings, 'http://127.0.0.1:18765', 'gateway-key', 'kimi/coding');
    const second = clients.switchService(client, () => settings, 'http://127.0.0.1:18765', 'gateway-key', 'minimax/coding');
    expect(await first).toMatchObject({ mode: 'bridge', serviceName: 'Kimi', connectionId: 'kimi', model: 'kimi/coding', canRestore: true });
    expect(await second).toMatchObject({ mode: 'bridge', serviceName: 'MiniMax', connectionId: 'minimax', model: 'minimax/coding', canRestore: true });
    const status = await clients.status(client, settings, 'http://127.0.0.1:18765');
    expect(JSON.stringify(status)).not.toContain('gateway-key'); expect(JSON.stringify(status)).not.toContain('private-value');
    settings.connections[1]!.enabled = false;
    expect(await clients.status(client, settings, 'http://127.0.0.1:18765')).toMatchObject({ mode: 'bridge', modelAvailable: false });
    expect((await clients.status(client, settings, 'http://127.0.0.1:18765')).connectionId).toBeUndefined();
    settings.connections[1]!.enabled = true;
    const switching = clients.switchService(client, () => settings, 'http://127.0.0.1:18765', 'gateway-key', 'kimi/coding');
    const restoring = clients.restore(client); await Promise.all([switching, restoring]);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await clients.status(client, settings, 'http://127.0.0.1:18765')).toMatchObject({ mode: 'external', model: 'native-model', canRestore: false });
  });
  it.each(['codex', 'claude'] as const)('reads external %s changes and does not confuse another gateway with this service', async client => {
    const { clients } = await setup(); const settings = config(); const address = 'http://127.0.0.1:18765';
    const plan = await clients.plan(client, settings, address, 'gateway-key', 'kimi/coding'); await clients.apply(plan.id, settings);
    const installed = await readFile(plan.path, 'utf8');
    await writeFile(plan.path, installed.replace(address, 'http://127.0.0.1:19999'));
    expect(await clients.status(client, settings, address)).toMatchObject({ mode: 'external', canRestore: false });
    expect((await clients.status(client, settings, address)).connectionId).toBeUndefined();
    if (client === 'codex') {
      await writeFile(plan.path, installed.replace('model_provider = "model_bridge"', 'model_provider = "openai"'));
      expect(await clients.status(client, settings, address)).toMatchObject({ mode: 'external' });
    }
    await writeFile(plan.path, 'malformed secret-value {');
    const unreadable = await clients.status(client, settings, address);
    expect(unreadable).toMatchObject({ mode: 'error', canRestore: false });
    expect(JSON.stringify(unreadable)).not.toContain('secret-value');
  });
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
      if (client === 'codex') expect(parse(native).web_search).toBe('disabled');
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
