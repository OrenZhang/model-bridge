import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigStore, type SecretStore } from './store.js';
import { ConnectionSchema, ModelSchema, type Connection } from './config.js';
import { Network, type SystemProxyResolver } from './network.js';
import { UsageStore } from './usage.js';
import { startGateway, tokenHash } from '../gateway/server.js';
import { DeviceLogin } from '../auth/device-login.js';
import { ClientConfiguration } from '../clients/configure.js';

export async function createRuntime(directory: string, secrets: SecretStore, home: string, systemProxy?: SystemProxyResolver, codexExecutable?: string) {
  const store = await new ConfigStore(directory).load();
  const usage = new UsageStore(path.join(directory, 'usage'));
  const network = new Network(() => store.get(), secrets, systemProxy);
  const clients = new ClientConfiguration(home, directory);
  const logins = new Map<string, { signature: string; login: DeviceLogin }>();
  function login(connection: Connection) {
    const signature = JSON.stringify({ auth: connection.auth, proxy: connection.proxy, defaultProxy: store.get().defaultProxy, proxies: store.get().proxies });
    const previous = logins.get(connection.id);
    if (previous && previous.signature !== signature) { previous.login.close(); logins.delete(connection.id); }
    if (!logins.has(connection.id)) logins.set(connection.id, { signature, login: new DeviceLogin(path.join(directory, 'accounts', connection.id, 'codex'), connection, network, codexExecutable) });
    return logins.get(connection.id)!.login;
  }
  let usageWriteFailed = false;
  const gateway = await startGateway({ config: () => store.get(), secrets, network, usage,
    chatgptCredentials: c => login(c).credentials(), onUsageError: () => { usageWriteFailed = true; } });
  async function ensureClient(id: 'codex' | 'claude' | 'generic') {
    const ref = `client:${id}`; let token = await secrets.get(ref);
    if (!token) {
      if (!secrets.set) throw new Error('This runtime does not have a writable credential store.');
      token = `mb_${randomBytes(32).toString('base64url')}`; await secrets.set(ref, token);
    }
    const config = store.get();
    const existing = config.clients.find(c => c.id === id);
    if (!existing || existing.tokenHash !== tokenHash(token)) {
      config.clients = config.clients.filter(c => c.id !== id);
      config.clients.push({ id, name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Other agents', tokenHash: tokenHash(token) });
      await store.save(config);
    }
    return token;
  }
  async function saveConnection(raw: unknown, apiKey?: string) {
    const connection = ConnectionSchema.parse(raw);
    const config = store.get(); const previous = config.connections.find(c => c.id === connection.id);
    if (!connection.secretRef && previous?.secretRef) connection.secretRef = previous.secretRef;
    if (apiKey) { if (!secrets.set) throw new Error('Credentials are read-only.'); connection.secretRef = `connection:${connection.id}`; await secrets.set(connection.secretRef, apiKey); }
    config.connections = [...config.connections.filter(c => c.id !== connection.id), connection];
    await store.save(config); await clients.updateCatalog(config); return connection;
  }
  async function discover(id: string) {
    const config = store.get(); const connection = config.connections.find(c => c.id === id);
    if (!connection) throw new Error('Connection not found.');
    let found: any[];
    if (connection.auth === 'chatgpt-device') {
      await login(connection).credentials();
      const result = await login(connection).catalog();
      found = (result.data ?? []).map((m: any) => ({ id: m.model, name: m.displayName ?? m.model, reasoning: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), images: (m.inputModalities ?? []).includes('image') }));
    } else {
      const key = connection.secretRef ? await secrets.get(connection.secretRef) : undefined;
      const headers: Record<string, string> = { accept: 'application/json' };
      if (key) { headers.authorization = `Bearer ${key}`; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      const response = await network.request(connection, connection.baseUrl.replace(/\/+$/, '') + '/models', { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Model discovery returned HTTP ${response.status}. Add model IDs manually if this service has no model-list endpoint.`); }
      const data = await response.json() as any; found = (data.data ?? data.models ?? []).map((m: any) => ({ id: m.id ?? m.name, name: m.display_name ?? m.id ?? m.name }));
    }
    const defaultProtocols = connection.auth === 'chatgpt-device' ? ['responses'] : connection.provider === 'kimi' ? ['responses', 'messages', 'chat'] : connection.provider === 'minimax' || connection.provider === 'anthropic' ? ['messages'] : ['chat'];
    const existing = new Map(connection.models.map(m => [m.upstreamId, m]));
    connection.models = found.filter(m => typeof m.id === 'string').slice(0, 300).map(m => existing.get(m.id) ?? ModelSchema.parse({ id: m.id, name: m.name, upstreamId: m.id, protocols: defaultProtocols, ...(m.reasoning ? { reasoning: m.reasoning } : {}), images: m.images ?? false }));
    await saveConnection(connection); return connection.models;
  }
  await clients.updateCatalog(store.get());
  return { store, network, usage, clients, gateway, ensureClient, saveConnection, discover,
    loginFor(id: string) { const connection = store.get().connections.find(c => c.id === id && c.auth === 'chatgpt-device'); if (!connection) throw new Error('ChatGPT connection not found.'); return login(connection); },
    loginStates() { return Object.fromEntries([...logins.entries()].map(([id, value]) => [id, value.login.state])); },
    usageWriteFailed: () => usageWriteFailed,
    async close() { for (const { login } of logins.values()) login.close(); await gateway.close(); },
  };
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
