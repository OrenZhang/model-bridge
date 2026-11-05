import { PoolRouter } from '../gateway/pool-router.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ConfigStore, type SecretStore } from './store.js';
import { ConnectionSchema, ModelSchema, BridgeError, type Connection } from './config.js';
import { Network, type SystemProxyResolver } from './network.js';
import { UsageStore } from './usage.js';
import { startGateway, tokenHash } from '../gateway/server.js';
import { minimaxPresetModels } from '../auth/provider-models.js';
import { ProviderLogin } from '../auth/provider-login.js';
import { DeviceLogin } from '../auth/device-login.js';
import { ClientConfiguration } from '../clients/configure.js';
import { LocalCodexAccounts } from '../auth/local-codex.js';
import { ManagedNetworks } from '../network/managed.js';
import { loadReasoningVault } from './reasoning-key.js';

export async function createRuntime(directory: string, secrets: SecretStore, home: string, systemProxy?: SystemProxyResolver, codexExecutable?: string) {
  const store = await new ConfigStore(directory).load();
  // Migrate identity hints from our own isolated helper cache before publishing
  // pooled models. This does not read or modify the user's Codex directory.
  for (const connection of store.get().connections.filter(c => c.auth === 'chatgpt-device' && (!c.accountId || !c.accountEmail))) {
    let auth: any;
    try { auth = JSON.parse(await readFile(path.join(directory, 'accounts', connection.id, 'codex', 'auth.json'), 'utf8')); }
    catch { continue; } // One unreadable account must not prevent managing others.
    let email: unknown;
    try { email = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] ?? '', 'base64url').toString('utf8')).email; } catch { /* Hint only; actual credentials are checked on use. */ }
    if (typeof auth.tokens?.account_id === 'string') await store.update(config => { const current = config.connections.find(c => c.id === connection.id)!; current.accountId = auth.tokens.account_id; if (typeof email === 'string') current.accountEmail = email; });
  }

  const usage = new UsageStore(path.join(directory, 'usage'));
  let managed: ManagedNetworks;
  const network = new Network(() => store.get(), secrets, systemProxy, id => managed.proxyUrl(id));
  const clients = new ClientConfiguration(home, directory, process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : undefined);
  const localAccounts = new LocalCodexAccounts(home, process.env.CODEX_HOME, directory, () => store.get(), secrets);
  const logins = new Map<string, { signature: string; login: DeviceLogin }>();
  const subscriptions = new Map<string, { signature: string; login: ProviderLogin }>();
  function subscription(connection: Connection) {
    const signature = JSON.stringify([connection.auth, connection.provider, connection.region, connection.baseUrl, connection.proxy, store.get().defaultProxy, store.get().proxies, store.get().networkProfiles]);
    const previous = subscriptions.get(connection.id);
    if (previous && previous.signature !== signature) { previous.login.close(); subscriptions.delete(connection.id); }
    if (!subscriptions.has(connection.id)) {
      const helper = new ProviderLogin(connection, network, secrets);
      helper.on('authorized', state => {
        if (state.phase === 'authenticated') {
          const update = store.update(config => { const current = config.connections.find(c => c.id === connection.id && c.auth === 'subscription' && c.region === connection.region && c.provider === connection.provider); if (!current) return; current.accountId = state.accountId; current.accountEmail = state.account; current.credentialVersion = randomBytes(12).toString('hex'); })
            .then(config => clients.updateCatalog(config)).then(() => scheduleDiscovery(connection.id)).catch(() => { discoveries.set(connection.id, { phase: 'error', message: '账号已登录，但身份信息保存失败，请重试。' }); });
          identityUpdates.add(update); void update.finally(() => identityUpdates.delete(update));
        }
      });
      subscriptions.set(connection.id, { signature, login: helper });
    }
    const helper = subscriptions.get(connection.id)!.login;
    helper.updateConnection(connection);
    return helper;
  }
  const discoveries = new Map<string, { phase: 'loading' | 'ready' | 'error'; message?: string; count?: number; source?: 'preset' }>();
  const discoveryTasks = new Map<string, Promise<unknown>>();
  const rediscover = new Set<string>();
  const keyVersions = new Map<string, number>();
  const identityUpdates = new Set<Promise<unknown>>();
  let closed = false;
  function login(connection: Connection) {
    const signature = JSON.stringify({ auth: connection.auth, loginMethod: connection.loginMethod, proxy: connection.proxy, defaultProxy: store.get().defaultProxy, proxies: store.get().proxies, networks: store.get().networkProfiles });
    const previous = logins.get(connection.id);
    if (previous && previous.signature !== signature) { previous.login.close(); logins.delete(connection.id); }
    if (!logins.has(connection.id)) {
      const helper = new DeviceLogin(path.join(directory, 'accounts', connection.id, 'codex'), connection, network, codexExecutable);
      let authenticated = false;
      helper.on('state', state => {
        const newlyAuthenticated = state.phase === 'authenticated' && !authenticated;
        authenticated = state.phase === 'authenticated';
        if (newlyAuthenticated && typeof state.accountId === 'string') {
          const update = store.update(config => { const current = config.connections.find(c => c.id === connection.id); if (current) { current.accountId = state.accountId; if (state.method && typeof state.account === 'string' && state.account !== 'ChatGPT') current.accountEmail = state.account; } })
            .then(config => clients.updateCatalog(config)).then(() => scheduleDiscovery(connection.id)).catch(() => {
              discoveries.set(connection.id, { phase: 'error', message: '账号已登录，但身份信息保存失败，请重新连接。' });
            });
          identityUpdates.add(update); void update.finally(() => identityUpdates.delete(update));
        }
      });
      logins.set(connection.id, { signature, login: helper });
    }
    return logins.get(connection.id)!.login;
  }
  let usageWriteFailed = false;
  const poolRouter = await new PoolRouter(path.join(directory, 'pool-routing.json')).load();
  const reasoningVault = await loadReasoningVault(directory, secrets);
  const gatewayOptions = { config: () => store.get(), secrets, network, usage, reasoningVault, poolRouter, chatgptCredentials: (c: Connection) => login(c).credentials(), subscriptionCredentials: async (c: Connection) => {
    const current = store.get().connections.find(value => value.id === c.id);
    if (!current || current.credentialVersion !== c.credentialVersion) throw new BridgeError(409, 'account_identity_changed', '账号登录状态已改变，请开始新对话。');
    const credentials = await subscription(current).credentials();
    if (store.get().connections.find(value => value.id === c.id)?.credentialVersion !== current.credentialVersion) throw new BridgeError(409, 'account_identity_changed', '账号登录状态已改变，请开始新对话。');
    return credentials;
  }, onUsageError: () => { usageWriteFailed = true; } };
  let gateway = await startGateway(gatewayOptions);
  managed = new ManagedNetworks(directory, store, secrets, network, () => gateway.activeRequests() === 0 && discoveryTasks.size === 0 && ![...logins.values(), ...subscriptions.values()].some(value => ['starting', 'waiting'].includes(value.login.state.phase)));
  async function ensureClient(id: 'codex' | 'claude' | 'generic') {
    const ref = `client:${id}`; let token = await secrets.get(ref);
    if (!token) {
      if (!secrets.set) throw new Error('This runtime does not have a writable credential store.');
      token = `mb_${randomBytes(32).toString('base64url')}`; await secrets.set(ref, token);
    }
    const config = store.get();
    const existing = config.clients.find(c => c.id === id);
    if (!existing || existing.tokenHash !== tokenHash(token)) {
      await store.update(current => { current.clients = current.clients.filter(c => c.id !== id); current.clients.push({ id, name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Other agents', tokenHash: tokenHash(token!) }); });
    }
    return token;
  }
  async function saveConnection(raw: unknown, apiKey?: string, autoDiscover = false) {
    const connection = ConnectionSchema.parse(raw);
    const previous = store.get().connections.find(c => c.id === connection.id);
    const authChanged = !!previous && [previous.auth, previous.provider, previous.region, previous.baseUrl].join('\0') !== [connection.auth, connection.provider, connection.region, connection.baseUrl].join('\0');
    if (authChanged) { delete connection.accountId; delete connection.accountEmail; delete connection.credentialVersion; delete connection.secretRef; }
    if (!['chatgpt-device', 'subscription'].includes(connection.auth)) { delete connection.accountId; delete connection.accountEmail; }
    if (apiKey && connection.auth !== 'api-key') throw new Error('API Key 只能用于 API Key 类型的连接。');
    if (apiKey) { if (!secrets.set) throw new Error('Credentials are read-only.'); connection.credentialVersion = randomBytes(12).toString('hex'); connection.secretRef = `connection:${connection.id}:${connection.credentialVersion}`; await secrets.set(connection.secretRef, apiKey); keyVersions.set(connection.id, (keyVersions.get(connection.id) ?? 0) + 1); }
    const config = await store.update(current => {
      const previous = current.connections.find(c => c.id === connection.id);
      if (!authChanged && !connection.secretRef && previous?.secretRef) connection.secretRef = previous.secretRef;
      if (!authChanged && !apiKey && previous?.credentialVersion) connection.credentialVersion = previous.credentialVersion;
      current.connections = [...current.connections.filter(c => c.id !== connection.id), connection];
    });
    if (authChanged) { logins.get(connection.id)?.login.close(); logins.delete(connection.id); subscriptions.get(connection.id)?.login.close(); subscriptions.delete(connection.id); }
    await clients.updateCatalog(config);
    if (autoDiscover && (!['chatgpt-device', 'subscription'].includes(connection.auth) || (connection.auth === 'subscription' ? subscriptions : logins).get(connection.id)?.login.state.phase === 'authenticated')) scheduleDiscovery(connection.id);
    return connection;
  }
  async function fetchModels(id: string) {
    const keyVersion = keyVersions.get(id) ?? 0;
    const config = store.get(); const connection = config.connections.find(c => c.id === id);
    if (!connection) throw new Error('Connection not found.');
    let found: any[];
    if (connection.auth === 'chatgpt-device') {
      await login(connection).credentials();
      const result = await login(connection).catalog();
      found = (result.data ?? []).map((m: any) => ({ id: m.model, name: m.displayName ?? m.model, reasoning: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), images: (m.inputModalities ?? []).includes('image') }));
    } else if (connection.auth === 'subscription' && connection.provider === 'minimax') {
      await subscription(connection).credentials();
      found = minimaxPresetModels(connection) ?? [];
      discoveries.set(id, { phase: 'loading', source: 'preset', message: '使用 MiniMax 官方预置目录；实际权限以套餐为准。' });
    } else {
      const key = connection.auth === 'subscription' ? (await subscription(connection).credentials()).token : connection.secretRef ? await secrets.get(connection.secretRef) : undefined;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (key) { headers.authorization = `Bearer ${key}`; if (connection.auth !== 'subscription') headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      headers['user-agent'] = 'ModelBridge/0.1.0';
      const response = await network.request(connection, connection.baseUrl.replace(/\/+$/, '') + '/models', { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        const preset = [404, 405].includes(response.status) ? minimaxPresetModels(connection) : undefined;
        if (!preset) throw new Error(`Model discovery returned HTTP ${response.status}. Add model IDs manually if this service has no model-list endpoint.`);
        found = preset;
        discoveries.set(id, { phase: 'loading', source: 'preset', message: '服务商未提供模型列表，使用官方预置目录；实际权限以套餐为准。' });
      } else {
        const data = await response.json() as any; const list = data.data ?? data.models;
        if (!Array.isArray(list)) throw new Error('服务商没有返回可识别的模型目录，可手动添加模型 ID。');
        found = list.map((m: any) => ({ id: m.id ?? m.name, name: m.display_name ?? m.id ?? m.name, ...(connection.provider === 'kimi' ? { protocols: m.protocol === 'response' ? ['responses'] : m.protocol === 'anthropic' ? ['messages'] : ['chat'], images: m.modalities?.input?.includes('image') === true, tools: m.supports_tool_use !== false, contextWindow: Number(m.limit?.context ?? m.context_length) || 128000 } : {}) }));
      }
    }
    found = found.filter(m => typeof m.id === 'string' && m.id.length > 0).slice(0, 300);
    if (!found.length) throw new Error('服务商返回的模型列表为空，请检查账号权限或手动添加模型 ID。');
    const defaultProtocols = connection.models[0]?.protocols ?? (connection.auth === 'chatgpt-device' || connection.provider === 'openai' ? ['responses'] : connection.provider === 'kimi' ? ['responses', 'messages', 'chat'] : connection.provider === 'minimax' || connection.provider === 'anthropic' ? ['messages'] : ['chat']);
    if (closed) return [];
    const updated = await store.update(current => {
      const latest = current.connections.find(c => c.id === id);
      if (!latest || latest.baseUrl !== connection.baseUrl || latest.auth !== connection.auth || latest.secretRef !== connection.secretRef || (keyVersions.get(id) ?? 0) !== keyVersion) throw new Error('连接已更改，正在重新获取模型。');
      const existing = new Map(latest.models.map(m => [m.upstreamId, m]));
      for (const m of found) if (!existing.has(m.id)) existing.set(m.id, ModelSchema.parse({ id: m.id, name: m.name, upstreamId: m.id, protocols: m.protocols ?? defaultProtocols, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(typeof m.tools === 'boolean' ? { tools: m.tools } : {}), ...(m.reasoning ? { reasoning: m.reasoning } : {}), images: m.images ?? false }));
      latest.models = [...existing.values()];
    });
    await clients.updateCatalog(updated); return updated.connections.find(c => c.id === id)!.models;
  }
  function discover(id: string): Promise<any> {
    if (discoveryTasks.has(id)) return discoveryTasks.get(id)!;
    discoveries.set(id, { phase: 'loading' });
    const task = Promise.resolve().then(() => fetchModels(id)).then(models => { discoveries.set(id, { ...discoveries.get(id), phase: 'ready', count: models.length }); return models; }, error => { discoveries.set(id, { phase: 'error', message: error instanceof Error ? error.message : '自动获取失败，可重试或手动填写模型 ID。' }); throw error; }).finally(() => { discoveryTasks.delete(id); if (rediscover.delete(id)) scheduleDiscovery(id); });
    discoveryTasks.set(id, task); return task;
  }
  function scheduleDiscovery(id: string) {
    if (closed) return;
    if (discoveryTasks.has(id)) { rediscover.add(id); return; }
    void discover(id).catch(() => {});
  }
  await clients.updateCatalog(store.get());
  await Promise.allSettled(store.get().connections.filter(c => c.auth === 'subscription' && c.credentialVersion).map(async connection => {
    await subscription(connection).restore();
    if (subscription(connection).state.phase === 'authenticated' && connection.provider === 'minimax' && !connection.models.length) scheduleDiscovery(connection.id);
  }));
  let changingListener = false;
  return { store, network, usage, clients, get gateway() { return gateway; }, ensureClient, saveConnection, discover, scheduleDiscovery, localAccounts, managed,
    async setLanAccess(enabled: boolean) {
      if (changingListener || gateway.activeRequests() || discoveryTasks.size) throw new Error('正在处理请求，请完成后再更改服务监听设置。');
      changingListener = true; const previous = store.get().listenHost;
      try {
        await store.update(config => { config.listenHost = enabled ? '0.0.0.0' : '127.0.0.1'; });
        try { await gateway.close(); gateway = await startGateway(gatewayOptions); }
        catch (error) { await store.update(config => { config.listenHost = previous; }); gateway = await startGateway(gatewayOptions); throw error; }
      } finally { changingListener = false; }
    },
    async importLocalAccount(id: string) { const connection = await localAccounts.importAccount(id); await saveConnection(connection); scheduleDiscovery(connection.id); await localAccounts.scan(); return connection.id; },
    discoveryStates: () => Object.fromEntries(discoveries),
    async startLogin(id: string) {
      const connection = store.get().connections.find(c => c.id === id && ['chatgpt-device', 'subscription'].includes(c.auth));
      if (!connection) throw new Error('ChatGPT connection not found.');
      if (connection.loginMethod === 'browser' && [...logins].some(([other, value]) => other !== id && value.login.state.method === 'browser' && ['starting', 'waiting'].includes(value.login.state.phase))) throw new Error('请先完成或取消另一个账号的浏览器登录，再登录此账号。');
      return connection.auth === 'subscription' ? subscription(connection).login() : login(connection).login();
    },
    loginFor(id: string) { const connection = store.get().connections.find(c => c.id === id && ['chatgpt-device', 'subscription'].includes(c.auth)); if (!connection) throw new Error('ChatGPT connection not found.'); return connection.auth === 'subscription' ? subscription(connection) : login(connection); },
    loginStates() { return Object.fromEntries([...logins.entries(), ...subscriptions.entries()].map(([id, value]) => [id, value.login.state])); },
    usageWriteFailed: () => usageWriteFailed,
    async close() { closed = true; for (const { login } of [...logins.values(), ...subscriptions.values()]) login.close(); await gateway.close(); await managed.close(); await Promise.allSettled(discoveryTasks.values()); await Promise.allSettled(identityUpdates); },
  };
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
