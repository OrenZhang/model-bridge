import { poolCandidates } from './model-pool.js';
import { z } from 'zod';

export const ProtocolSchema = z.enum(['responses', 'messages', 'chat']);
export type Protocol = z.infer<typeof ProtocolSchema>;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const ProxyChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }),
  z.object({ mode: z.literal('direct') }),
  z.object({ mode: z.literal('system') }),
  z.object({ mode: z.literal('proxy'), profileId: identifier }),
  z.object({ mode: z.literal('managed'), profileId: identifier }),
]);
export type ProxyChoice = z.infer<typeof ProxyChoiceSchema>;
export const ModelSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(200),
  upstreamId: z.string().min(1).max(200),
  protocols: z.array(ProtocolSchema).min(1),
  contextWindow: z.number().int().min(4096).max(10000000).default(128000),
  tools: z.boolean().default(true), images: z.boolean().default(false),
  reasoning: z.array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).default([]),
  enabled: z.boolean().default(true),
  price: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cachedInput: z.number().nonnegative().optional(), currency: z.literal('USD').default('USD') }).optional(),
});
export type Model = z.infer<typeof ModelSchema>;
export const ConnectionSchema = z.object({
  id: identifier, name: z.string().min(1).max(100),
  provider: z.enum(['openai', 'kimi', 'minimax', 'anthropic', 'custom']),
  auth: z.enum(['api-key', 'chatgpt-device', 'subscription', 'none']).default('api-key'),
  baseUrl: z.string().url().refine(value => {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  }, 'Use HTTPS, or HTTP on loopback; do not include credentials, query parameters or fragments.'),
  region: z.enum(['cn', 'global']).default('cn'),
  loginMethod: z.enum(['device', 'browser']).default('device'),
  accountId: z.string().min(1).optional(),
  accountEmail: z.string().optional(),
  credentialVersion: z.string().optional(),
  secretRef: z.string().min(1).optional(),
  proxy: ProxyChoiceSchema.default({ mode: 'inherit' }),
  enabled: z.boolean().default(true), models: z.array(ModelSchema).default([]),
}).superRefine((connection, ctx) => {
  if (connection.auth === 'chatgpt-device' && connection.provider !== 'openai')
    ctx.addIssue({ code: 'custom', message: 'ChatGPT device login requires the OpenAI provider.' });
  if (connection.auth === 'subscription') {
    const expected = connection.provider === 'kimi' ? (connection.region === 'cn' ? 'https://api.kimi.com/coding/v1' : 'https://api.kimi.ai/coding/v1') : connection.provider === 'minimax' ? (connection.region === 'cn' ? 'https://agent.minimax.cn/mavis/api/v1/llm/v1' : 'https://agent.minimax.io/mavis/api/v1/llm/v1') : undefined;
    if (!expected || connection.baseUrl.replace(/\/+$/, '') !== expected) ctx.addIssue({ code: 'custom', message: 'Subscription login requires the official provider and regional coding endpoint.' });
  }
  const ids = connection.models.map(m => m.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Model IDs must be unique within a connection.' });
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const ConfigSchema = z.object({
  version: z.literal(1).default(1), port: z.number().int().min(0).max(65535).default(18765),
  listenHost: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  defaultProxy: ProxyChoiceSchema.default({ mode: 'system' }),
  proxies: z.array(z.object({ id: identifier, name: z.string().min(1),
    url: z.string().url().refine(v => { const u = new URL(v); return ['http:', 'https:', 'socks5:', 'socks:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && ['', '/'].includes(u.pathname); }, 'Proxy URL must not contain credentials or a path.'),
    credentialRef: z.string().optional(),
  })).default([]),
  connections: z.array(ConnectionSchema).default([]),
  networkProfiles: z.array(z.object({ id: identifier, name: z.string().min(1).max(100), source: z.enum(['subscription', 'config']), nodes: z.array(z.string()).min(1), selected: z.string(), secretRef: z.string(), updatedAt: z.string() })).default([]),
  clients: z.array(z.object({ id: identifier, name: z.string().min(1), tokenHash: z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
}).superRefine((config, ctx) => {
  for (const [name, entries] of Object.entries({ connections: config.connections, proxies: config.proxies, networkProfiles: config.networkProfiles, clients: config.clients }))
    if (new Set(entries.map(e => e.id)).size !== entries.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${name} IDs.` });
  if (config.defaultProxy.mode === 'inherit') ctx.addIssue({ code: 'custom', message: 'The global proxy cannot inherit itself.' });
  for (const choice of [config.defaultProxy, ...config.connections.map(c => c.proxy)])
    if (choice.mode === 'proxy' && !config.proxies.some(p => p.id === choice.profileId)) ctx.addIssue({ code: 'custom', message: 'Selected proxy does not exist.' });
    else if (choice.mode === 'managed' && !config.networkProfiles.some(p => p.id === choice.profileId)) ctx.addIssue({ code: 'custom', message: 'Selected subscription does not exist.' });
  for (const profile of config.networkProfiles) if (!profile.nodes.includes(profile.selected)) ctx.addIssue({ code: 'custom', message: 'Selected subscription node does not exist.' });
});
export type Config = z.infer<typeof ConfigSchema>;
export const emptyConfig = (): Config => ConfigSchema.parse({});
export const routeId = (connection: Connection, model: Model) => `${connection.id}/${model.id}`;
export function resolveRoute(config: Config, id: string) {
  const pooled = poolCandidates(config, id);
  if (pooled?.length) return structuredClone(pooled[0]!);
  for (const connection of config.connections) {
    if (!connection.enabled) continue;
    const model = connection.models.find(m => m.enabled && routeId(connection, m) === id);
    if (model) return { connection: structuredClone(connection), model: structuredClone(model) };
  }
  throw new BridgeError(404, 'model_not_found', 'Model is unavailable. Refresh the model list and select an enabled model.');
}
export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
