import { PoolRouter } from './pool-router.js';
import { kimiSubscriptionThinking } from '../auth/kimi-models.js';
import { chatgptPayload } from '../auth/chatgpt-payload.js';
import { minimaxSubscriptionThinking } from '../auth/minimax-thinking.js';
import { modelGroupId, poolCandidates, reasoningScope } from '../core/model-pool.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { BridgeError, resolveRoute, type Config, type Connection, type Protocol } from '../core/config.js';
import { codexCatalog, openaiCatalog, anthropicCatalog } from '../core/catalog.js';
import { Network } from '../core/network.js';
import type { SecretStore } from '../core/store.js';
import { UsageStore, unknownTokens, usageTokens, estimatedCost, type Tokens } from '../core/usage.js';
import { decodeRequest, encodeRequest, UpstreamDecoder, DownstreamEncoder } from './codec.js';
import { SSEDecoder, sse } from './sse.js';
import { ReasoningVault, hasGatewayReasoning } from './reasoning.js';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const paths: Record<Protocol, string> = { responses: '/responses', messages: '/messages', chat: '/chat/completions' };
const protocolAt = (pathname: string): Protocol | undefined => pathname === '/v1/responses' ? 'responses' : pathname === '/v1/messages' ? 'messages' : pathname === '/v1/chat/completions' ? 'chat' : undefined;
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new BridgeError(413, 'request_too_large', 'Request exceeds 8 MiB.'); chunks.push(chunk); }
  let parsed: any; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError(400, 'invalid_json', 'Request body must contain valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BridgeError(400, 'invalid_request', 'Expected a JSON object.');
  return parsed;
}
function json(res: ServerResponse, status: number, value: any) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
function errorBody(protocol: Protocol | undefined, error: BridgeError) { return protocol === 'messages' ? { type: 'error', error: { type: error.code, message: error.message } } : { error: { type: error.code, code: error.code, message: error.message } }; }
async function write(res: ServerResponse, value: string | Uint8Array) {
  if (res.destroyed) throw new Error('Client disconnected.');
  if (res.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); }; const closed = () => { cleanup(); reject(new Error('Client disconnected.')); };
    const cleanup = () => { res.off('drain', done); res.off('close', closed); res.off('error', closed); };
    res.once('drain', done); res.once('close', closed); res.once('error', closed);
  });
}
export interface GatewayOptions {
  config: () => Config; secrets: SecretStore; network: Network; usage: UsageStore;
  subscriptionCredentials?: (connection: Connection) => Promise<{ token: string }>;
  chatgptCredentials?: (connection: Connection) => Promise<{ token: string; accountId: string; email?: string }>;
  onUsageError?: () => void;
  onConnectionResult?: (connection: Connection, result: { ok: boolean; status?: number; code?: string }) => void;
  reasoningVault?: ReasoningVault;
  poolRouter?: PoolRouter;
}
export async function startGateway(options: GatewayOptions) {
  const inflight = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  const poolRouter = options.poolRouter ?? new PoolRouter();
  const reasoningVault = options.reasoningVault ?? new ReasoningVault();
  let address = '';
  const server = createServer((req, res) => {
    const pending = handle(req, res); handlers.add(pending);
    void pending.finally(() => handlers.delete(pending)).catch(() => {});
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://localhost'); }
    catch { json(res, 400, { error: { code: 'invalid_url', message: 'Invalid request URL.' } }); return; }
    const protocol = protocolAt(url.pathname);
    const controller = new AbortController(); inflight.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const started = performance.now(); let firstByte: number | null = null;
    let tokens: Tokens = unknownTokens(); let status: 'success' | 'error' | 'cancelled' = 'error'; let errorCode: string | undefined;
    let route: ReturnType<typeof resolveRoute> | undefined; let clientId = ''; let selected = ''; const requestId = randomUUID();
    try {
      const host = req.headers.host?.split(':')[0];
      const local = req.socket.localAddress?.replace('::ffff:', '');
      const allowed = ['localhost', '127.0.0.1', ...(options.config().listenHost === '0.0.0.0' && local ? [local] : [])];
      if (!host || !allowed.includes(host) || req.headers.origin) throw new BridgeError(403, 'forbidden_origin', 'Only authenticated agent clients may access this gateway.');
      if (url.pathname === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', service: 'model-bridge' }); return; }
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');
      const hash = Buffer.from(tokenHash(token), 'hex');
      const client = options.config().clients.find(c => timingSafeEqual(hash, Buffer.from(c.tokenHash, 'hex')));
      if (!token || !client) throw new BridgeError(401, 'invalid_api_key', 'A valid Model Bridge client key is required.');
      clientId = client.id;
      if (req.method === 'GET' && url.pathname === '/v1/models') { json(res, 200, req.headers['anthropic-version'] ? anthropicCatalog(options.config()) : openaiCatalog(options.config())); return; }
      if (req.method === 'GET' && url.pathname === '/codex/models') { json(res, 200, codexCatalog(options.config())); return; }
      if (req.method !== 'POST' || !protocol) throw new BridgeError(404, 'not_found', 'Endpoint not found.');
      const input = await body(req);
      if (typeof input.model !== 'string') throw new BridgeError(400, 'model_required', 'Select a model from the gateway model list.');
      if (input.stream !== undefined && typeof input.stream !== 'boolean') throw new BridgeError(400, 'invalid_request', 'stream must be a boolean.');
      selected = input.model;
      const candidates = poolCandidates(options.config(), selected);
      const session = req.headers['x-model-bridge-session'] ?? req.headers['session_id'] ?? input.metadata?.user_id;
      route = candidates?.length ? await poolRouter.select(modelGroupId(candidates[0]!.connection,candidates[0]!.model), candidates, input, clientId, protocol, reasoningVault, typeof session === 'string' ? session : undefined) : resolveRoute(options.config(), selected);
      const { connection, model } = route;
      if (input.tools?.length && !model.tools) throw new BridgeError(400, 'tools_unsupported', 'This model does not support tool calls.');
      const upstream = model.protocols.includes(protocol) ? protocol : model.protocols[0]!;
      const translated = upstream !== protocol || hasGatewayReasoning(input);
      const reasoning = reasoningVault.context(reasoningScope(clientId, route), upstream, connection.provider, model.upstreamId);
      const canonical = translated ? decodeRequest(protocol, input, reasoning) : undefined;
      if (canonical && !model.images && canonical.messages.some(m => m.content.some(p => p.type === 'image'))) throw new BridgeError(400, 'images_unsupported', 'This model does not accept images.');
      let payload: any = canonical ? encodeRequest(upstream, canonical, model.upstreamId, reasoning) : { ...input, model: model.upstreamId };
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (upstream === 'messages') {
        headers['anthropic-version'] = !translated && typeof req.headers['anthropic-version'] === 'string' ? req.headers['anthropic-version'] : '2023-06-01';
        if (!translated && typeof req.headers['anthropic-beta'] === 'string') headers['anthropic-beta'] = req.headers['anthropic-beta'];
      }
      let endpoint = connection.baseUrl.replace(/\/+$/, '') + paths[upstream];
      if (connection.auth === 'chatgpt-device') {
        if (!options.chatgptCredentials) throw new BridgeError(503, 'device_login_unavailable', 'Device login is not configured in this gateway instance.');
        const credentials = await options.chatgptCredentials(connection);
        if (connection.accountId && credentials.accountId !== connection.accountId || connection.accountEmail && credentials.email !== connection.accountEmail) throw new BridgeError(409, 'account_identity_changed', 'The account identity changed. Reconnect this account before continuing.');
        endpoint = 'https://chatgpt.com/backend-api/codex/responses';
        if (upstream !== 'responses') throw new BridgeError(400, 'invalid_chatgpt_protocol', 'ChatGPT device connections must use Responses upstream.');
        headers.authorization = `Bearer ${credentials.token}`; headers['ChatGPT-Account-ID'] = credentials.accountId;
        headers.originator = 'model_bridge';
        payload = chatgptPayload(payload);
      } else if (connection.auth === 'subscription') {
        if (connection.provider === 'kimi') kimiSubscriptionThinking(payload, upstream, model, canonical ?? { effort: input.reasoning?.effort ?? input.reasoning_effort ?? input.output_config?.effort, thinking: input.thinking });
        if (connection.provider === 'minimax' && upstream === 'messages') minimaxSubscriptionThinking(payload, model.upstreamId, canonical ?? { effort: input.output_config?.effort, thinking: input.thinking });
        if (!options.subscriptionCredentials) throw new BridgeError(503, 'subscription_unavailable', 'Subscription login is unavailable.');
        const credentials = await options.subscriptionCredentials(connection);
        headers.authorization = `Bearer ${credentials.token}`;
        headers['user-agent'] = 'ModelBridge/0.1.0';
        if (connection.provider === 'kimi' && upstream === 'messages') {
          endpoint += '?beta=true';
          if (payload.thinking?.type === 'enabled') payload.thinking = { type: 'adaptive' };
        }
      } else if (connection.auth === 'api-key') {
        const key = connection.secretRef ? await options.secrets.get(connection.secretRef) : undefined;
        if (!key) throw new BridgeError(401, 'credentials_missing', 'Add an API key for the selected connection.');
        if (upstream === 'messages') { headers['x-api-key'] = key; if (connection.provider !== 'anthropic') headers.authorization = `Bearer ${key}`; }
        else headers.authorization = `Bearer ${key}`;
      }
      const destination = new URL(endpoint);
      if (['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname) && destination.port === new URL(address).port) throw new BridgeError(400, 'gateway_loop', 'An upstream connection cannot point back to this gateway.');
      if (upstream === 'chat' && payload.stream) payload.stream_options = { ...payload.stream_options, include_usage: true };
      const upstreamResponse = await options.network.request(connection, endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      firstByte = Math.round(performance.now() - started);
      if (!upstreamResponse.ok) { poolRouter.rejected(connection.id, upstreamResponse.status, upstreamResponse.headers.get('retry-after')); await upstreamResponse.body?.cancel(); throw new BridgeError(upstreamResponse.status >= 400 && upstreamResponse.status < 500 ? upstreamResponse.status : 502, 'upstream_rejected', `The upstream service returned HTTP ${upstreamResponse.status}. Check account access, limits and model configuration.`); }
      res.setHeader('x-model-bridge-request-id', requestId);
      if (!upstreamResponse.body) throw new BridgeError(502, 'empty_upstream_response', 'The upstream returned an empty response.');
      const contentType = upstreamResponse.headers.get('content-type');
      // ChatGPT's Codex endpoint can stream valid SSE without Content-Type.
      const streaming = contentType?.includes('text/event-stream') || (connection.auth === 'chatgpt-device' && !contentType);
      const encoder = canonical ? new DownstreamEncoder(protocol, selected, canonical.tools, reasoning) : undefined;
      const decoder = translated ? new UpstreamDecoder(upstream) : undefined;
      if (!streaming) {
        if (!translated && input.stream) { await upstreamResponse.body.cancel(); throw new BridgeError(502, 'upstream_stream_required', 'The selected route requires a streaming upstream response.'); }
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of upstreamResponse.body) { size += chunk.byteLength; if (size > 16 * 1024 * 1024) throw new BridgeError(502, 'upstream_response_too_large', 'Upstream response exceeds the size limit.'); chunks.push(chunk); }
        const bytes = Buffer.concat(chunks).toString('utf8');
        let result: any; try { result = JSON.parse(bytes); } catch { throw new BridgeError(502, 'invalid_upstream_json', 'The upstream returned invalid JSON.'); }
        if (result.error || result.type === 'error' || result.status === 'failed') throw new BridgeError(502, 'upstream_error', 'The upstream returned an error response.');
        if (encoder && decoder) {
          const chunks = decoder.decodeJSON(result).map(delta => encoder.accept(delta)); tokens = decoder.tokens;
          if (input.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            for (const chunk of chunks) if (chunk) await write(res, chunk);
            await write(res, encoder.finish()); res.end();
          } else json(res, 200, encoder.result());
          status = 'success'; return;
        }
        tokens = usageTokens(upstream, result.usage); json(res, 200, result); status = 'success'; return;
      }
      let nativeComplete = false; let nativeResult: any; let output: string[] = [];
      const observer = new SSEDecoder(event => {
        if (decoder && encoder) { for (const delta of decoder.decode(event.data)) output.push(encoder.accept(delta)); tokens = decoder.tokens; return; }
        if (event.data === '[DONE]') { nativeComplete = true; return; }
        let value: any; try { value = JSON.parse(event.data); } catch { throw new BridgeError(502, 'invalid_upstream_event', 'The upstream returned an invalid event.'); }
        if (value.error || value.type === 'error' || value.type === 'response.failed') throw new BridgeError(502, 'upstream_stream_error', 'The upstream stream failed.');
        tokens = usageTokens(upstream, value.usage ?? value.message?.usage ?? value.response?.usage, tokens);
        if (['response.completed', 'response.incomplete'].includes(value.type)) { nativeComplete = true; nativeResult = value.response; }
        if (value.type === 'message_stop' || value.choices?.[0]?.finish_reason) nativeComplete = true;
      });
      if (input.stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      for await (const chunk of upstreamResponse.body) {
        observer.push(chunk);
        if (input.stream) {
          if (encoder) { for (const item of output) if (item) await write(res, item); }
          else await write(res, chunk);
        }
        output = [];
      }
      observer.finish();
      if (encoder && decoder) {
        encoder.accept(decoder.end());
        if (input.stream) { for (const item of output) if (item) await write(res, item); await write(res, encoder.finish()); res.end(); }
        else json(res, 200, encoder.result());
      } else {
        if (!nativeComplete) throw new BridgeError(502, 'upstream_stream_incomplete', 'The upstream stream ended before completion.');
        if (input.stream) res.end();
        else if (nativeResult) json(res, 200, nativeResult);
        else throw new BridgeError(502, 'unexpected_upstream_stream', 'The upstream streamed a request that expected JSON.');
      }
      status = 'success';
    } catch (error) {
      status = controller.signal.aborted ? 'cancelled' : 'error';
      const failure = error instanceof BridgeError ? error : new BridgeError(500, 'gateway_error', 'The gateway could not complete the request.');
      errorCode = failure.code;
      if (route && status === 'error' && ['upstream_rejected', 'upstream_connection_failed', 'upstream_stream_incomplete', 'upstream_stream_required', 'credentials_missing', 'chatgpt_login_required', 'login_required', 'login_refresh_failed', 'account_identity_changed'].includes(failure.code)) options.onConnectionResult?.(route.connection, {ok:false,status:failure.status,code:failure.code});
      if (route && ['credentials_missing', 'chatgpt_login_required'].includes(failure.code)) poolRouter.rejected(route.connection.id, 401);
      if (!res.destroyed) {
        if (!res.headersSent) json(res, failure.status, errorBody(protocol, failure));
        else res.end(sse({ type: 'error', error: { type: failure.code, code: failure.code, message: failure.message } }, 'error'));
      }
    } finally {
      if (route && status === 'success') options.onConnectionResult?.(route.connection, {ok:true});
      controller.abort(); inflight.delete(controller);
      if (route && protocol) await options.usage.append({ id: requestId, startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(), clientId, connectionId: route.connection.id, provider: route.connection.provider, model: selected, upstreamModel: route.model.upstreamId, protocol, status, durationMs: Math.round(performance.now() - started), firstByteMs: firstByte, tokens, estimatedCostUsd: estimatedCost(route.model, tokens), ...(errorCode ? { errorCode } : {}) }).catch(() => options.onUsageError?.());
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.config().port, options.config().listenHost, resolve); });
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const port = (server.address() as AddressInfo).port;
  return { address, activeRequests: () => inflight.size,
    lanAddresses: () => options.config().listenHost === '0.0.0.0' ? [...new Set(Object.values(networkInterfaces()).flatMap(values => (values ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${port}`)))] : [],
    async close() {
      for (const controller of inflight) controller.abort();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      // HTTP completion precedes each handler's final usage write. Finish those
      // writes before quitting, rebinding the listener, or removing test data.
      await Promise.allSettled(handlers);
      await options.network.close();
    } };
}
