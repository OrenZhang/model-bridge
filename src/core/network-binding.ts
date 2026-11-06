import type { Config, Connection } from './config.js';
export function networkBinding(config: Config, connection: Connection) {
  const choice = connection.proxy.mode === 'inherit' ? config.defaultProxy : connection.proxy;
  return { choice, profile: choice.mode === 'managed' ? config.networkProfiles.find(p => p.id === choice.profileId) : choice.mode === 'proxy' ? config.proxies.find(p => p.id === choice.profileId) : undefined };
}
