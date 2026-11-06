import { createHash } from 'node:crypto';
import type { Config, Connection, Model } from './config.js';
import { upstreamProtocols } from '../shared/upstream-protocols.js';
export type ModelRoute = { connection: Connection; model: Model };
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function routeFingerprint(route: ModelRoute) {
  const { connection: c, model: m } = route;
  return digest(JSON.stringify([c.id, c.provider, c.auth, c.accountId, c.accountEmail, c.secretRef, c.credentialVersion, c.baseUrl, m.upstreamId, upstreamProtocols(c, m.protocols)]));
}
export function modelGroupId(connection: Connection, model: Model) {
  const key = JSON.stringify([connection.provider, connection.auth, connection.baseUrl.replace(/\/+$/, ''), model.upstreamId, [...model.protocols].sort(), model.tools, model.images, model.contextWindow, [...model.reasoning].sort(), ...(model.thinking ? [model.thinking] : [])]);
  return `@pool/${digest(key).slice(0, 24)}`;
}
export function modelGroups(config: Config) {
  const groups = new Map<string, ModelRoute[]>();
  for (const connection of config.connections.filter(c => c.enabled)) for (const model of connection.models.filter(m => m.enabled && !config.hiddenModels.includes(m.upstreamId))) {
    const id = modelGroupId(connection, model);
    const group = groups.get(id) ?? [];
    if (!group.some(r => (r.connection.accountId && r.connection.accountEmail ? JSON.stringify([r.connection.accountId, r.connection.accountEmail ?? '']) : r.connection.id) === (connection.accountId && connection.accountEmail ? JSON.stringify([connection.accountId, connection.accountEmail ?? '']) : connection.id))) group.push({ connection, model });
    groups.set(id, group);
  }
  return groups;
}
export function poolCandidates(config: Config, id: string) {
  if (config.hiddenModels.includes(id)) return undefined;
  return modelGroups(config).get(id) ?? publicModelRoutes(config).find(route => route.id === id)?.members;
}
export function catalogRoutes(config: Config) {
  return [...modelGroups(config)].flatMap(([id, members]) => members.length > 1
    ? [{ ...members[0]!, id, displayName: `${members[0]!.model.name} · ${members.length} 个账号`, accounts: members.length, members }]
    : members.map(route => ({ ...route, id: `${route.connection.id}/${route.model.id}`, displayName: `${route.connection.name} · ${route.model.name}`, accounts: 1, members: [route] })));
}
export const mergedModelId = (upstreamId: string) => `@model/${digest(upstreamId).slice(0, 24)}`;
/** Public names merge every enabled channel for exactly the same upstream model ID. */
export function publicModelRoutes(config: Config) {
  const groups = new Map<string, ModelRoute[]>();
  for (const members of modelGroups(config).values()) for (const member of members) {
    const list = groups.get(member.model.upstreamId) ?? [];
    const account = (r: ModelRoute) => JSON.stringify([r.connection.provider,r.connection.auth,r.connection.baseUrl.replace(/\/+$/,''),r.connection.accountId && r.connection.accountEmail ? [r.connection.accountId,r.connection.accountEmail] : r.connection.id]);
    if (!list.some(r=>account(r)===account(member))) list.push(member);
    groups.set(member.model.upstreamId, list);
  }
  return [...groups].map(([id,members]) => {
    const first = members[0]!;
    const model = { ...first.model, tools: members.some(r=>r.model.tools), images: members.some(r=>r.model.images), contextWindow: Math.min(...members.map(r=>r.model.contextWindow)), reasoning: [...new Set(members.flatMap(r=>r.model.reasoning))] };
    return {...first, model, id, routingId: mergedModelId(id), displayName: first.model.name, accounts:members.length, members};
  });
}
export function reasoningScope(client: string, route: ModelRoute) { return JSON.stringify([client, route.connection.id, route.connection.baseUrl, route.model.upstreamId, ...(route.connection.accountId ? [route.connection.accountId, route.connection.accountEmail ?? ''] : []), ...(route.connection.credentialVersion ? [route.connection.credentialVersion] : [])]); }
