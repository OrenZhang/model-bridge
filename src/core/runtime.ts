import { networkBinding } from './network-binding.js';
import { PoolRouter } from '../gateway/pool-router.js';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigStore, type SecretStore } from './store.js';
import { ConnectionSchema, ModelSchema, BridgeError, type Connection } from './config.js';
import { Network, type SystemProxyResolver } from './network.js';
import { UsageStore } from './usage.js';
import { startGateway, tokenHash } from '../gateway/server.js';
import { coSailHeaders } from '../auth/host-identity.js';
import { kimiSubscriptionModel } from '../auth/kimi-models.js';
import { minimaxPresetModels } from '../auth/provider-models.js';
import { ProviderLogin } from '../auth/provider-login.js';
import { DeviceLogin } from '../auth/device-login.js';
import { ClientConfiguration } from '../clients/configure.js';
import { LocalCodexAccounts } from '../auth/local-codex.js';
import { ManagedNetworks } from '../network/managed.js';
import { managedModels } from './catalog.js';
import { loadReasoningVault } from './reasoning-key.js';

export async function createRuntime(directory: string, secrets: SecretStore, home: string, systemProxy?: SystemProxyResolver, codexExecutable?: string) {
  const store = await new ConfigStore(directory).load();
  if(!store.get().deviceId)await store.update(config=>{config.deviceId=randomUUID();});
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
  // Existing subscription entries predate the official thinking controls.
  // Fill missing capabilities without touching client settings, auth, or a user's explicit levels.
  const missingThinking = store.get().connections.some(c => c.auth === 'subscription' && c.provider === 'minimax' && c.models.some(m => !m.reasoning.length && minimaxPresetModels(c)?.some(p => p.id === m.upstreamId)));
  if (missingThinking) await store.update(config => {
    for (const connection of config.connections.filter(c => c.auth === 'subscription' && c.provider === 'minimax')) {
      const presets = minimaxPresetModels(connection);
      for (const model of connection.models.filter(m => !m.reasoning.length)) {
        const preset = presets?.find(p => p.id === model.upstreamId);
        if (preset?.reasoning) model.reasoning = ModelSchema.shape.reasoning.parse(preset.reasoning);
      }
    }
  });

  const usage = new UsageStore(path.join(directory, 'usage'));
  let usageWriteFailed = false;
  await usage.prune().catch(() => { usageWriteFailed = true; });
  let managed: ManagedNetworks;
  const network = new Network(() => store.get(), secrets, systemProxy, (id, connection) => managed.proxyUrl(id, connection), (id, connection, proxy) => managed.failed(id, connection, proxy));
  const clients = new ClientConfiguration(home, directory, process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : undefined);
  const localAccounts = new LocalCodexAccounts(home, process.env.CODEX_HOME, directory, () => store.get(), secrets);
  const logins = new Map<string, { signature: string; login: DeviceLogin }>();
  const subscriptions = new Map<string, { signature: string; login: ProviderLogin }>();
  const connectionChecks = new Map<string, {phase:'ready'|'error';message?:string}>();
  function subscription(connection: Connection) {
    const signature = JSON.stringify([connection.auth, connection.provider, connection.region, connection.baseUrl, networkBinding(store.get(), connection)]);
    const previous = subscriptions.get(connection.id);
    if (previous && previous.signature !== signature) { previous.login.close(); subscriptions.delete(connection.id); }
    if (!subscriptions.has(connection.id)) {
      const helper = new ProviderLogin(connection, network, secrets, undefined, coSailHeaders(store.get().deviceId!,connection.provider==='kimi'));
      helper.on('authorized', state => {
        if (state.phase === 'authenticated') {
          connectionChecks.delete(connection.id);
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
    const signature = JSON.stringify({ auth: connection.auth, loginMethod: connection.loginMethod, network: networkBinding(store.get(), connection) });
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
  const poolRouter = await new PoolRouter(path.join(directory, 'pool-routing.json')).load();
  const reasoningVault = await loadReasoningVault(directory, secrets);
  const gatewayOptions = { config: () => store.get(), secrets, network, usage, reasoningVault, poolRouter, chatgptCredentials: (c: Connection) => login(c).credentials(), subscriptionCredentials: async (c: Connection) => {
    const current = store.get().connections.find(value => value.id === c.id);
    if (!current || current.credentialVersion !== c.credentialVersion) throw new BridgeError(409, 'account_identity_changed', '账号登录状态已改变，请开始新对话。');
    const credentials = await subscription(current).credentials();
    if (store.get().connections.find(value => value.id === c.id)?.credentialVersion !== current.credentialVersion) throw new BridgeError(409, 'account_identity_changed', '账号登录状态已改变，请开始新对话。');
    return credentials;
  }, onConnectionResult: (connection: Connection, result: {ok:boolean;status?:number;code?:string}) => {
    const current = store.get().connections.find(c=>c.id===connection.id);
    if (!current || current.credentialVersion!==connection.credentialVersion || current.baseUrl!==connection.baseUrl) return;
    connectionChecks.set(connection.id,result.ok?{phase:'ready'}:{phase:'error',message:`最近调用失败${result.status ? '（HTTP '+result.status+'）' : ''}，请检查账号授权、模型权限和网络。`});
  }, onUsageError: () => { usageWriteFailed = true; } };
  let gateway = await startGateway(gatewayOptions);
  managed = new ManagedNetworks(directory, store, secrets, network, profileId => { const ids = store.get().connections.filter(c => { const choice = networkBinding(store.get(), c).choice; return choice.mode === 'managed' && choice.profileId === profileId; }).map(c => c.id); return gateway.activeRequests(ids) === 0 && !ids.some(id => discoveryTasks.has(id) || ['starting', 'waiting'].includes((logins.get(id) ?? subscriptions.get(id))?.login.state.phase ?? '')); });
  async function ensureClient(id: 'codex' | 'claude' | 'generic') {
    const ref = `client:${id}`; let token = await secrets.get(ref);
    if (!token) {
      if (!secrets.set) throw new Error('This runtime does not have a writable credential store.');
      token = `mb_${randomBytes(32).toString('base64url')}`; await secrets.set(ref, token);
    }
    const config = store.get();
    const existing = config.clients.find(c => c.id === id);
    if (!existing || existing.tokenHash !== tokenHash(token)) {
      await store.update(current => { current.clients = current.clients.filter(c => c.id !== id); current.clients.push({ id, enabled:true, name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Other agents', tokenHash: tokenHash(token!) }); });
    }
    return token;
  }
  async function accessKey(id:string) {
    const client=store.get().clients.find(c=>c.id===id&&c.enabled);
    if(!client)throw new Error('访问密钥不存在或已停用。');
    const token=await secrets.get(`client:${id}`);if(!token||tokenHash(token)!==client.tokenHash)throw new Error('访问密钥无法读取，请重新创建。');
    return token;
  }
  async function createAccessKey(name:string) {
    const id=`access-${randomBytes(6).toString('hex')}`;const token=`mb_${randomBytes(32).toString('base64url')}`;
    if(!secrets.set)throw new Error('凭据库不可写。');
    await secrets.set(`client:${id}`,token);
    await store.update(config=>{config.clients.push({id,name,enabled:true,tokenHash:tokenHash(token)});});return id;
  }
  async function updateAccessKey(id:string,update:{name?:string;enabled?:boolean}) {
    if(['codex','claude','generic'].includes(id))throw new Error('本机客户端密钥由应用管理。');
    await store.update(config=>{const client=config.clients.find(c=>c.id===id);if(!client)throw new Error('访问密钥不存在。');Object.assign(client,update);});
  }
  async function saveConnection(raw: unknown, apiKey?: string, autoDiscover = false) {
    const connection = ConnectionSchema.parse(raw);
    apiKey = apiKey?.trim();
    if (connection.provider === 'deepseek' && apiKey) apiKey = apiKey.replace(/^Bearer\s+/i, '').trim();
    const previous = store.get().connections.find(c => c.id === connection.id);
    const authChanged = !!previous && [previous.auth, previous.provider, previous.region, previous.auth === 'api-key' ? new URL(previous.baseUrl).origin : previous.baseUrl].join('\0') !== [connection.auth, connection.provider, connection.region, connection.auth === 'api-key' ? new URL(connection.baseUrl).origin : connection.baseUrl].join('\0');
    if (authChanged) { delete connection.accountId; delete connection.accountEmail; delete connection.credentialVersion; delete connection.secretRef; }
    if (connection.auth === 'api-key' && !apiKey && !(connection.secretRef || (!authChanged && previous?.secretRef))) throw new Error(authChanged ? '服务地址或认证方式已改变，请重新填写 API Key。' : '请填写 API Key，密钥不会自动使用其他连接的账号。');
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
    if (authChanged || apiKey) connectionChecks.delete(connection.id);
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
      found = (result.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ id: m.model, name: m.displayName ?? m.model, reasoning: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), images: (m.inputModalities ?? ['text', 'image']).includes('image') }));
    } else if (connection.auth === 'subscription' && connection.provider === 'minimax') {
      await subscription(connection).credentials();
      found = minimaxPresetModels(connection) ?? [];
      discoveries.set(id, { phase: 'loading', source: 'preset', message: '使用 MiniMax 官方预置目录；实际权限以套餐为准。' });
    } else {
      const key = connection.auth === 'subscription' ? (await subscription(connection).credentials()).token : connection.secretRef ? await secrets.get(connection.secretRef) : undefined;
      if (connection.auth === 'api-key' && !key) throw new Error('此连接的 API Key 未保存或无法读取，请重新填写后再同步。');
      const headers: Record<string, string> = { accept: 'application/json' };
      if (key) { headers.authorization = `Bearer ${key}`; if (connection.auth !== 'subscription') headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      Object.assign(headers,coSailHeaders(store.get().deviceId!,connection.provider==='kimi'));
      const response = await network.request(connection, connection.baseUrl.replace(/\/+$/, '') + '/models', { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        await response.body?.cancel();
        const preset = [404, 405].includes(response.status) ? minimaxPresetModels(connection) : undefined;
        if (!preset) {
          if (response.status === 401 && connection.auth === 'subscription') throw new Error('此订阅账号的授权已失效（HTTP 401），请重新登录后再同步模型。');
          if (response.status === 401) throw new Error(`${connection.provider === 'deepseek' ? 'DeepSeek' : '服务商'}拒绝了此连接的 API Key（HTTP 401）。请检查密钥是否来自当前服务地址、是否有效；手动添加模型不能解决鉴权失败。`);
          throw new Error(`获取模型失败（HTTP ${response.status}），请检查服务地址、账号权限和网络。`);
        }
        found = preset;
        discoveries.set(id, { phase: 'loading', source: 'preset', message: '服务商未提供模型列表，使用官方预置目录；实际权限以套餐为准。' });
      } else {
        const data = await response.json() as any; const list = data.data ?? data.models;
        if (!Array.isArray(list)) throw new Error('服务商没有返回可识别的模型目录，可手动添加模型 ID。');
        found = connection.auth === 'subscription' && connection.provider === 'kimi' ? list.map(kimiSubscriptionModel).filter(Boolean) : list.map((m: any) => ({ id: m.id ?? m.name, name: m.display_name ?? m.id ?? m.name, ...(connection.provider === 'deepseek' && ['deepseek-flash','deepseek-v4-pro'].includes(m.id) ? {protocols:['chat'],reasoning:['none','low','high','max']} : {}), ...(connection.provider === 'kimi' ? { protocols: m.protocol === 'response' ? ['responses'] : m.protocol === 'anthropic' ? ['messages'] : ['chat'], images: m.modalities?.input?.includes('image') === true, tools: m.supports_tool_use !== false, contextWindow: Number(m.limit?.context ?? m.context_length) || 128000 } : {}) }));
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
      for (const m of found) {
        const previous = existing.get(m.id);
        if (previous && connection.auth === 'subscription' && connection.provider === 'kimi') {
          const refreshed = ModelSchema.parse(m);
          Object.assign(previous, { protocols: refreshed.protocols, thinking: refreshed.thinking, reasoning: refreshed.reasoning, contextWindow: refreshed.contextWindow, tools: refreshed.tools, images: refreshed.images });
        }
        if (previous && connection.auth === 'chatgpt-device') Object.assign(previous, {reasoning: ModelSchema.shape.reasoning.parse(m.reasoning ?? []), images: m.images ?? previous.images});
        if (previous && connection.auth === 'subscription' && connection.provider === 'minimax' && m.reasoning) previous.reasoning = ModelSchema.shape.reasoning.parse(m.reasoning);
        if (!previous) existing.set(m.id, ModelSchema.parse({ id: m.id, name: m.name, upstreamId: m.id, protocols: m.protocols ?? defaultProtocols, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(typeof m.tools === 'boolean' ? { tools: m.tools } : {}), ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.thinking ? {thinking:m.thinking} : {}), images: m.images ?? false }));
      }
      latest.models = [...existing.values()];
    });
    await clients.updateCatalog(updated); return updated.connections.find(c => c.id === id)!.models;
  }
  function discover(id: string): Promise<any> {
    if (discoveryTasks.has(id)) return discoveryTasks.get(id)!;
    discoveries.set(id, { phase: 'loading' });
    const task = Promise.resolve().then(() => fetchModels(id)).then(models => { connectionChecks.delete(id); discoveries.set(id, { ...discoveries.get(id), phase: 'ready', count: models.length }); return models; }, error => { discoveries.set(id, { phase: 'error', message: error instanceof Error ? error.message : '自动获取失败，可重试或手动填写模型 ID。' }); throw error; }).finally(() => { discoveryTasks.delete(id); if (rediscover.delete(id)) scheduleDiscovery(id); });
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
  let usageCleanup: ReturnType<typeof setTimeout>;
  function scheduleUsageCleanup() {
    const now = Date.now();
    const nextDay = (Math.floor(now / 86400000) + 1) * 86400000;
    usageCleanup = setTimeout(() => {
      void usage.prune().catch(() => { usageWriteFailed = true; }).finally(() => { if (!closed) scheduleUsageCleanup(); });
    }, nextDay - now).unref();
  }
  scheduleUsageCleanup();
  return { store, network, usage, clients, get gateway() { return gateway; }, ensureClient, accessKey, createAccessKey, updateAccessKey, saveConnection, discover, scheduleDiscovery, localAccounts, managed,
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
    async setModelExposure(id: string, enabled: boolean) {
      const config = await store.update(current => {
        const entry = managedModels(current).find(m => m.id === id);
        if (!entry) throw new Error('模型目录已变化，请刷新后重试。');
        for (const member of entry.members) member.model.enabled = enabled;
      });
      await clients.updateCatalog(config);
    },
    discoveryStates: () => Object.fromEntries(discoveries),
    connectionStates: () => Object.fromEntries(connectionChecks),
    async startLogin(id: string) {
      connectionChecks.delete(id);
      const connection = store.get().connections.find(c => c.id === id && ['chatgpt-device', 'subscription'].includes(c.auth));
      if (!connection) throw new Error('ChatGPT connection not found.');
      if (connection.loginMethod === 'browser' && [...logins].some(([other, value]) => other !== id && value.login.state.method === 'browser' && ['starting', 'waiting'].includes(value.login.state.phase))) throw new Error('请先完成或取消另一个账号的浏览器登录，再登录此账号。');
      return connection.auth === 'subscription' ? subscription(connection).login() : login(connection).login();
    },
    loginFor(id: string) { const connection = store.get().connections.find(c => c.id === id && ['chatgpt-device', 'subscription'].includes(c.auth)); if (!connection) throw new Error('ChatGPT connection not found.'); return connection.auth === 'subscription' ? subscription(connection) : login(connection); },
    loginStates() { return Object.fromEntries([...logins.entries(), ...subscriptions.entries()].map(([id, value]) => [id, value.login.state])); },
    usageWriteFailed: () => usageWriteFailed,
    async close() { closed = true; clearTimeout(usageCleanup); for (const { login } of [...logins.values(), ...subscriptions.values()]) login.close(); await gateway.close(); await managed.close(); await Promise.allSettled(discoveryTasks.values()); await Promise.allSettled(identityUpdates); await usage.prune().catch(() => { usageWriteFailed = true; }); },
  };
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
