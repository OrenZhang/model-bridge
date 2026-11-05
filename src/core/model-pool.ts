import { createHash } from 'node:crypto';
import type { Config, Connection, Model } from './config.js';
export type ModelRoute = { connection: Connection; model: Model };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function routeFingerprint(route: ModelRoute) {
  const { connection: c, model: m } = route;
  return digest(JSON.stringify([c.id, c.provider, c.auth, c.accountId, c.accountEmail, c.secretRef, c.credentialVersion, c.baseUrl, m.upstreamId, m.protocols]));
}
export function modelGroupId(connection: Connection, model: Model) {
  const key = JSON.stringify([connection.provider, connection.auth, connection.baseUrl.replace(/\/+$/, ''), model.upstreamId, [...model.protocols].sort(), model.tools, model.images, model.contextWindow, [...model.reasoning].sort(), ...(model.thinking ? [model.thinking] : [])]);
  return `@pool/${digest(key).slice(0, 24)}`;
}
export function modelGroups(config: Config) {
  const groups = new Map<string, ModelRoute[]>();
  for (const connection of config.connections.filter(c => c.enabled)) for (const model of connection.models.filter(m => m.enabled)) {
    const id = modelGroupId(connection, model);
    const group = groups.get(id) ?? [];
    if (!group.some(r => (r.connection.accountId && r.connection.accountEmail ? JSON.stringify([r.connection.accountId, r.connection.accountEmail ?? '']) : r.connection.id) === (connection.accountId && connection.accountEmail ? JSON.stringify([connection.accountId, connection.accountEmail ?? '']) : connection.id))) group.push({ connection, model });
    groups.set(id, group);
  }
  return groups;
}
export function poolCandidates(config: Config, id: string) {
  return modelGroups(config).get(id) ?? publicModelRoutes(config).find(route => route.id === id && route.members.length > 1)?.members;
}
export function catalogRoutes(config: Config) {
  return [...modelGroups(config)].flatMap(([id, members]) => members.length > 1
    ? [{ ...members[0]!, id, displayName: `${members[0]!.model.name} · ${members.length} 个账号`, accounts: members.length, members }]
    : members.map(route => ({ ...route, id: `${route.connection.id}/${route.model.id}`, displayName: `${route.connection.name} · ${route.model.name}`, accounts: 1, members: [route] })));
}
/** Resolve names using the full saved catalog so hiding an account never redirects its name. */
export function publicModelRoutes(config: Config) {
  const all = structuredClone(config);
  for (const connection of all.connections) { connection.enabled = true; for (const model of connection.models) model.enabled = true; }
  const groups = [...modelGroups(all)];
  const rank = (route: ModelRoute) => ({'chatgpt-device':0,subscription:1,'api-key':2,none:3}[route.connection.auth]);
  groups.sort(([a, aa], [b, bb]) => rank(aa[0]!) - rank(bb[0]!) || a.localeCompare(b));
  const reserved = new Set(all.connections.flatMap(c => c.models.map(m => `${c.id}/${m.id}`)));
  const used = new Set([...reserved, ...groups.map(([id, members]) => members[0]!.model.upstreamId)]);
  const claimed = new Set<string>(); const names = new Map<string, string>();
  for (const [group, members] of groups) {
    const {connection,model} = members[0]!; const raw = model.upstreamId;
    let name = raw;
    if (claimed.has(raw) || reserved.has(raw) || raw.startsWith('@pool/')) {
      const suffix = connection.auth === 'chatgpt-device' ? 'chatgpt' : connection.auth === 'subscription' ? `${connection.provider}-plan` : `${connection.provider}-${connection.auth}`;
      name = `${raw}~${suffix}`;
      if (used.has(name)) name += `-${group.slice(6)}`;
      while (used.has(name)) name += '-model';
    }
    claimed.add(raw); used.add(name); names.set(group,name);
  }
  return catalogRoutes(config).map(route => ({...route,routingId:route.id,id:names.get(modelGroupId(route.connection,route.model))!,displayName:route.model.name}));
}
export function reasoningScope(client: string, route: ModelRoute) { return JSON.stringify([client, route.connection.id, route.connection.baseUrl, route.model.upstreamId, ...(route.connection.accountId ? [route.connection.accountId, route.connection.accountEmail ?? ''] : []), ...(route.connection.credentialVersion ? [route.connection.credentialVersion] : [])]); }
