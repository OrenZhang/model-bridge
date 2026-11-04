import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import type { Config, Connection } from './config.js';
import { BridgeError } from './config.js';
import type { SecretStore } from './store.js';

export type SystemProxyResolver = (url: string) => Promise<string | undefined>;
export type ManagedProxyResolver = (profileId: string) => Promise<string>;
export class Network {
  private agents = new Map<string, Dispatcher>();
  constructor(private config: () => Config, private secrets: SecretStore, private systemProxy?: SystemProxyResolver, private managedProxy?: ManagedProxyResolver) {}
  async proxyUrl(connection: Connection, destination: string, forSubprocess = false): Promise<string | undefined> {
    const config = this.config();
    const choice = connection.proxy.mode === 'inherit' ? config.defaultProxy : connection.proxy;
    if (choice.mode === 'direct') return undefined;
    if (choice.mode === 'managed') {
      if (!this.managedProxy) throw new BridgeError(503, 'subscription_unavailable', '内置订阅网络当前不可用。');
      return this.managedProxy(choice.profileId);
    }
    if (choice.mode === 'system') {
      if (this.systemProxy) return this.systemProxy(destination);
      if (forSubprocess) return process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
      return undefined;
    }
    if (choice.mode !== 'proxy') throw new BridgeError(400, 'invalid_proxy', 'Invalid proxy configuration.');
    const profile = config.proxies.find(p => p.id === choice.profileId);
    if (!profile) throw new BridgeError(400, 'proxy_not_found', 'The selected proxy no longer exists.');
    const url = new URL(profile.url);
    if (profile.credentialRef) {
      const value = await this.secrets.get(profile.credentialRef);
      if (!value) throw new BridgeError(401, 'proxy_credentials_missing', 'Proxy credentials are unavailable.');
      const credentials = JSON.parse(value) as { username: string; password: string };
      url.username = credentials.username; url.password = credentials.password;
    }
    return url.href;
  }
  async dispatcher(connection: Connection, destination: string) {
    const config = this.config();
    const choice = connection.proxy.mode === 'inherit' ? config.defaultProxy : connection.proxy;
    const url = await this.proxyUrl(connection, destination);
    const key = url ?? (choice.mode === 'system' && !this.systemProxy ? 'environment' : 'direct');
    let agent = this.agents.get(key);
    if (!agent) {
      agent = key === 'direct' ? new Agent() : key === 'environment' ? new EnvHttpProxyAgent() : new ProxyAgent(key);
      this.agents.set(key, agent);
    }
    return agent;
  }
  async request(connection: Connection, url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) {
    try {
      return await fetch(url, { ...init, redirect: 'error', dispatcher: await this.dispatcher(connection, url) });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(502, 'upstream_connection_failed', 'Could not reach the upstream service through the configured network connection.');
    }
  }
  async close() { await Promise.all([...this.agents.values()].map(agent => agent.destroy())); this.agents.clear(); }
}
