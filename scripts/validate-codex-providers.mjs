#!/usr/bin/env node
import { publicModelRoutes } from '../dist/core/model-pool.js';
/** Real Codex 0.144.1 app-server integration, with isolated credentials and fixtures.
 * Run after npm run build using Node >=22.19:
 *   node scripts/validate-codex-providers.mjs --mock
 *   MODEL_BRIDGE_TEST_GATEWAY_URL=http://127.0.0.1:18765 MODEL_BRIDGE_TEST_GATEWAY_KEY=... node scripts/validate-codex-providers.mjs
 * MODEL_BRIDGE_TEST_ROUTE_METADATA is JSON keyed by route ID, each value containing
 * upstreamHost, upstreamModel and upstreamProtocol (chat or messages). A caller
 * invoking validation derives this metadata from the selected route without exposing credentials.
 * Credentials belong in environment variables, never CLI arguments or the report.
 * --mock tests the real Codex client and real gateway against deterministic upstreams;
 * it does not validate live Kimi/MiniMax service access.
 * Protocol: https://learn.chatgpt.com/docs/app-server
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stringify as toml } from 'smol-toml';
import { codexBinary } from '../dist/auth/codex-binary.js';
import { ConfigSchema } from '../dist/core/config.js';
import { Network } from '../dist/core/network.js';
import { UsageStore } from '../dist/core/usage.js';
import { startGateway, tokenHash } from '../dist/gateway/server.js';
import { SSEDecoder, sse } from '../dist/gateway/sse.js';

const thinkingProbe = process.argv.includes('--thinking-probe');
const mockPools = process.argv.includes('--mock-pools');
const mock = process.argv.includes('--mock') || mockPools;
const root = await mkdtemp(path.join(os.tmpdir(), 'model-bridge-codex-validation-'));
const cleanup = [];
const results = [];
const reportFile = process.env.MODEL_BRIDGE_VALIDATION_REPORT;
let routeMetadata = {};
try { routeMetadata = JSON.parse(process.env.MODEL_BRIDGE_TEST_ROUTE_METADATA ?? '{}'); } catch { /* Validated before any live request below. */ }
const nonce = () => randomBytes(10).toString('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function body(req) { const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts).toString(); }
async function listen(handler) {
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

async function simulatedUpstream() {
  const steps = new Map(); const replayChecks = { kimi: 0, minimax: 0 };
  const url = await listen(async (req, res) => {
    const input = JSON.parse(await body(req));
    const isMessages = req.url.endsWith('/messages');
    const provider = isMessages ? 'minimax' : 'kimi';
    const step = (steps.get(provider) ?? 0) + 1; steps.set(provider, step);
    const serialized = JSON.stringify(input.messages);
    const toolResults = isMessages ? input.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []) : input.messages.filter(m => m.role === 'tool');
    const thinking = 'Synthetic reasoning fixture. Preserve this history for tool continuation.';
    if (step > 1) {
      const signed = isMessages ? input.messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'thinking' && b.thinking === thinking && b.signature === 'fixture_signature_v1')) : input.messages.some(m => m.role === 'assistant' && m.reasoning_content === thinking);
      if (!signed || !toolResults.length) { json(res, 400, { error: { message: 'Missing intact thinking or tool-result history.' } }); return; }
      replayChecks[provider]++;
    }
    const tool = input.tools.find(t => (t.function?.name ?? t.name).endsWith('bridge_probe'));
    assert(tool, 'Mock upstream did not receive bridge_probe.');
    const name = tool.function?.name ?? tool.name;
    const calls = step === 1 ? [{ id: 'call_init', name, args: { operation: 'write', slot: 'a' } }] : step === 3 ? ['a', 'b'].map(slot => ({ id: `call_read_${slot}`, name, args: { operation: 'read', slot } })) : [];
    const markers = [...new Set(serialized.match(/marker-[a-f0-9]+/g) ?? [])];
    const receipts = [...new Set(serialized.match(/receipt-[a-f0-9]+/g) ?? [])];
    const text = [...markers, ...receipts].join(' ');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!isMessages) {
      const chunk = (delta, finish_reason = null) => res.write(sse({ id: `chatcmpl_${step}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }));
      chunk({ role: 'assistant' }); chunk({ reasoning_content: thinking });
      if (calls.length) calls.forEach((call, index) => {
        chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] });
        const args = JSON.stringify(call.args); const split = Math.floor(args.length / 2);
        chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, split) } }] });
        chunk({ tool_calls: [{ index, function: { arguments: args.slice(split) } }] });
      }); else chunk({ content: text });
      chunk({}, calls.length ? 'tool_calls' : 'stop');
      res.write(sse({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } } }));
      res.end(sse('[DONE]'));
    } else {
      const event = value => res.write(sse(value, value.type));
      event({ type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: input.model, content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture_signature_v1' } });
      event({ type: 'content_block_stop', index: 0 });
      if (calls.length) calls.forEach((call, i) => {
        const index = i + 1;
        event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } });
        const args = JSON.stringify(call.args); const split = Math.floor(args.length / 2);
        for (const partial_json of [args.slice(0, split), args.slice(split)]) event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
        event({ type: 'content_block_stop', index });
      }); else {
        event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
        event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
        event({ type: 'content_block_stop', index: 1 });
      }
      event({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 30 } });
      event({ type: 'message_stop' }); res.end();
    }
  });
  return { url, replayChecks };
}

async function createMockGateway() {
  const upstream = await simulatedUpstream(); const key = `validation-${nonce()}`;
  const config = ConfigSchema.parse({ port: 0, defaultProxy: { mode: 'direct' }, clients: [{ id: 'validation', name: 'Isolated validation', tokenHash: tokenHash(key) }], connections: [
    { id: 'kimi', provider: 'kimi', name: 'Kimi mock', auth: 'none', baseUrl: upstream.url + '/v1', models: [{ id: 'fixture', name: 'Fixture', upstreamId: 'kimi-k2.5', protocols: ['chat'], reasoning: ['low'] }] },
    { id: 'minimax', provider: 'minimax', name: 'MiniMax mock', auth: 'none', baseUrl: upstream.url + '/v1', models: [{ id: 'fixture', name: 'Fixture', upstreamId: 'MiniMax-M3', protocols: ['messages'], reasoning: ['low'] }] },
  ] });
  if (mockPools) config.connections.push(...config.connections.map(connection => ({ ...structuredClone(connection), id: connection.id + '-second', name: connection.name + ' second account' })));
  const secrets = { get: async () => undefined }; const network = new Network(() => config, secrets);
  const usage = new UsageStore(path.join(root, 'usage'));
  const gateway = await startGateway({ config: () => config, secrets, network, usage });
  cleanup.push(() => network.close()); cleanup.push(() => gateway.close());
  routeMetadata = Object.fromEntries(publicModelRoutes(config).map(({ id, model }) => [id, { upstreamHost: '127.0.0.1', upstreamModel: model.upstreamId, upstreamProtocol: model.protocols[0] }]));
  return { url: gateway.address, key, replayChecks: upstream.replayChecks, usage };
}

async function observeGateway(gateway, route, metrics) {
  return listen(async (req, res) => {
    const raw = await body(req);
    if (req.method === 'POST' && req.url === '/v1/responses') {
      const request = JSON.parse(raw);
      assert(request.model === route, 'Unexpected model route.');
      metrics.requests++;
      if (metrics.requests > 12) { json(res, 429, { error: { message: 'Validation request budget reached.' } }); return; }
      for (const item of Array.isArray(request.input) ? request.input : []) {
        if (item.type === 'reasoning' && item.encrypted_content?.startsWith('mb_r1.')) metrics.encryptedReasoningReplayed++;
        if (item.type === 'reasoning' && item.encrypted_content && !item.encrypted_content.startsWith('mb_r1.')) metrics.nativeReasoningReplayed++;
        if (item.type === 'function_call_output') metrics.toolResultsReplayed++;
      }
    }
    const upstream = await fetch(gateway.url + req.url, { method: req.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.key}`, ...(typeof req.headers.session_id === 'string' ? { session_id: req.headers.session_id } : {}) }, ...(raw ? { body: raw } : {}), signal: AbortSignal.timeout(120000) });
    metrics.httpStatuses.push(upstream.status);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    const parser = new SSEDecoder(({ data }) => {
      if (data === '[DONE]') return;
      let value; try { value = JSON.parse(data); } catch { return; }
      if (value.type === 'response.output_item.done' && value.item?.type === 'reasoning' && value.item.encrypted_content?.startsWith('mb_r1.')) metrics.encryptedReasoningReceived++;
      if (value.type === 'response.output_item.done' && value.item?.type === 'reasoning' && value.item.encrypted_content && !value.item.encrypted_content.startsWith('mb_r1.')) metrics.nativeReasoningReceived++;
      if (value.type === 'response.completed' && value.response?.usage) {
        const usage = value.response.usage;
        metrics.tokenUsage.input += usage.input_tokens ?? 0; metrics.tokenUsage.output += usage.output_tokens ?? 0;
        metrics.tokenUsage.reasoning += usage.output_tokens_details?.reasoning_tokens ?? 0;
      }
    });
    for await (const chunk of upstream.body) { if (upstream.headers.get('content-type')?.includes('text/event-stream')) parser.push(chunk); res.write(chunk); }
    parser.finish(); res.end();
  });
}

async function validateProvider(gateway, provider, route, catalog) {
  const metadata = routeMetadata[route];
  if (!metadata || !['chat', 'messages', 'responses'].includes(metadata.upstreamProtocol) || typeof metadata.upstreamHost !== 'string' || typeof metadata.upstreamModel !== 'string') { results.push({ provider, model: route, status: 'blocked', error: 'Validation requires selected-route metadata with upstreamHost, upstreamModel and upstreamProtocol.' }); return; }
  const metrics = { provider, model: route, upstreamHost: metadata.upstreamHost, upstreamModel: metadata.upstreamModel, upstreamProtocol: metadata.upstreamProtocol, downstreamProtocol: 'responses', thinkingProbe, validationKind: mock ? 'real-codex-simulated-upstream' : 'real-codex-live-gateway', gatewayHost: new URL(gateway.url).hostname, status: 'failed', turns: 0, toolCalls: 0, requests: 0, encryptedReasoningReceived: 0, encryptedReasoningReplayed: 0, nativeReasoningReceived: 0, nativeReasoningReplayed: 0, toolResultsReplayed: 0, tokenUsage: { input: 0, output: 0, reasoning: 0 }, httpStatuses: [] };
  results.push(metrics);
  const folder = path.join(root, provider + '-' + nonce()); const codexHome = path.join(folder, '.codex'); const workspace = path.join(folder, 'fixture');
  await mkdir(codexHome, { recursive: true, mode: 0o700 }); await mkdir(workspace, { recursive: true, mode: 0o700 });
  const address = await observeGateway(gateway, route, metrics);
  const catalogFile = path.join(codexHome, 'codex-models.json');
  await writeFile(catalogFile, JSON.stringify(catalog), { mode: 0o600 });
  await writeFile(path.join(codexHome, 'config.toml'), toml({ web_search: 'disabled', model_provider: 'model_bridge', model: route, model_catalog_json: catalogFile, model_providers: { model_bridge: { name: 'Model Bridge isolated validation', base_url: address + '/v1', wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, experimental_bearer_token: gateway.key, request_max_retries: 0, stream_max_retries: 0 } } }), { mode: 0o600 });
  const env = { ...process.env, CODEX_HOME: codexHome };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_IDENTITY_TOKEN_FILE', 'MODEL_BRIDGE_TEST_GATEWAY_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  env.NO_PROXY = 'localhost,127.0.0.1,::1'; env.no_proxy = env.NO_PROXY;
  const child = spawn(process.env.MODEL_BRIDGE_VALIDATION_CODEX_BINARY || codexBinary(), ['app-server', '--listen', 'stdio://'], { env, cwd: workspace, stdio: 'pipe', windowsHide: true });
  // Register immediately: exit can precede stdio closure, and close may occur
  // before validation reaches finally (including when spawning fails).
  const childClosed = new Promise(resolve => child.once('close', resolve));
  child.stderr.resume(); const pending = new Map(); let requestId = 0; let currentTurn;
  const marker = `marker-${nonce()}`; const receipt = `receipt-${nonce()}`; const probeFile = path.join(workspace, 'probe.json');
  const lines = createInterface({ input: child.stdout });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); send({ id, method, params });
  });
  child.on('error', error => { for (const request of pending.values()) request.reject(error); currentTurn?.reject(error); });
  child.on('exit', () => { for (const request of pending.values()) request.reject(new Error('Codex exited.')); currentTurn?.reject(new Error('Codex exited.')); });
  lines.on('line', line => { void (async () => {
    const message = JSON.parse(line);
    if (message.method && message.id !== undefined) {
      if (message.method !== 'item/tool/call' || message.params.tool !== 'bridge_probe') { send({ id: message.id, error: { code: -32601, message: 'Only the synthetic bridge_probe tool is allowed.' } }); return; }
      const args = message.params.arguments;
      assert(['write', 'read'].includes(args.operation) && ['a', 'b'].includes(args.slot), 'Unexpected probe arguments.');
      if (args.operation === 'write') await writeFile(probeFile, JSON.stringify({ marker, receipt }), { mode: 0o600 });
      const result = JSON.parse(await readFile(probeFile, 'utf8')); metrics.toolCalls++;
      send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ...result, slot: args.slot }) }] } }); return;
    }
    if (message.id !== undefined) { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.reject(new Error(`Codex RPC ${message.error.code}: ${message.error.message}`)) : request.resolve(message.result); return; }
    if (message.method === 'item/agentMessage/delta') currentTurn?.texts.push(message.params.delta ?? '');
    if (message.method === 'turn/completed') {
      const turn = message.params.turn;
      if (turn.status !== 'completed') currentTurn?.reject(new Error(`Codex turn ${turn.status}: ${turn.error?.message ?? 'unknown error'}`));
      else currentTurn?.resolve(currentTurn.texts.join(''));
    }
  })().catch(error => currentTurn?.reject(error)); });
  try {
    await rpc('initialize', { clientInfo: { name: 'model_bridge_validation', version: '0.1.0' }, capabilities: { experimentalApi: true } }); send({ method: 'initialized' });
    const { thread } = await rpc('thread/start', { model: route, modelProvider: 'model_bridge', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: 'This is an isolated synthetic integration test. Follow the user exactly. Use only bridge_probe for tools. Never run shell commands or access any other file. Keep final answers under 80 words.', dynamicTools: [{ type: 'function', name: 'bridge_probe', description: 'Write or read a synthetic fixture. The write operation generates a receipt which is only available from this tool. No arbitrary file access.', inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['write', 'read'] }, slot: { type: 'string', enum: ['a', 'b'] } }, required: ['operation', 'slot'], additionalProperties: false } }] });
    const prompts = [
      `[MB_TURN_1] Remember ${marker}. Call bridge_probe with operation write and slot a, then reply with the marker and exact receipt returned by the tool.`,
      '[MB_TURN_2] Call bridge_probe twice with operation read, once slot a and once slot b. You may run these together. Verify both receipts agree and reply with the original marker and receipt.',
      '[MB_TURN_3] Without using tools, recall the marker and receipt from the previous turns. Reply with both exact values.',
    ];
    if (thinkingProbe) {
      prompts[0] += ' Also compute 17*23 + 19*29, check the arithmetic, and include the checksum in your answer. Do not replace the requested tool call with mental simulation.';
      prompts[1] += ' Independently verify the previous checksum, then compute (checksum*37+11) modulo 997. Include this second checksum in your answer.';
      prompts[2] += ' Include the sum of both computed checksums in your answer.';
    }
    for (const [turnIndex, text] of prompts.entries()) {
      let timer; const completion = new Promise((resolve, reject) => { currentTurn = { resolve, reject, texts: [] }; timer = setTimeout(() => reject(new Error('Codex turn timed out after 120 seconds.')), 120000); });
      completion.catch(() => {});
      try {
        await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text }], effort: 'low', summary: 'none' });
        const answer = await completion;
        assert(answer.includes(marker) && answer.includes(receipt), 'Codex response did not preserve the tool receipt and multi-turn marker.');
        if (thinkingProbe && !mock) assert(answer.includes(['942', '967', '1909'][turnIndex]), 'Codex did not preserve the computed multi-turn checksums.');
        metrics.turns++;
      } finally { clearTimeout(timer); currentTurn = undefined; }
    }
    assert(metrics.toolCalls >= 3, 'Expected write and two read tool calls.');
    if (metadata.upstreamProtocol !== 'responses') assert(metrics.encryptedReasoningReceived > 0 && metrics.encryptedReasoningReplayed > 0, 'Opaque reasoning did not round-trip through the real Codex client.');
    assert(metrics.toolResultsReplayed >= 3, 'Codex did not replay all tool outputs.');
    if (mock) { metrics.upstreamThinkingReplayChecks = gateway.replayChecks[provider]; assert(metrics.upstreamThinkingReplayChecks >= 4, 'Original thinking/signatures were not restored upstream.'); }
    metrics.status = 'passed';
  } catch (error) {
    // Gateway and Codex errors contain only synthetic prompts, but cap the report.
    metrics.error = String(error.message).replaceAll(gateway.key, '[redacted]').slice(0, 500);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed; lines.close(); for (const request of pending.values()) request.reject(new Error('Validation completed.')); pending.clear();
  }
  // Anthropic-compatible usage does not separately report thinking tokens.
  // Responses compatibility currently emits zero for that absent field.
  if (metadata.upstreamProtocol === 'messages') {
    metrics.tokenUsage.reasoning = null;
    metrics.tokenUsageNote = 'Thinking tokens are included in output; upstream does not report a separate reasoning count.';
  }
  process.stdout.write(JSON.stringify(metrics) + '\n');
}

try {
  const gateway = mock ? await createMockGateway() : { url: process.env.MODEL_BRIDGE_TEST_GATEWAY_URL?.replace(/\/+$/, ''), key: process.env.MODEL_BRIDGE_TEST_GATEWAY_KEY };
  if (!gateway.url || !gateway.key) throw new Error('Live validation needs MODEL_BRIDGE_TEST_GATEWAY_URL and MODEL_BRIDGE_TEST_GATEWAY_KEY from a configured gateway; no credential values should be pasted into chat.');
  const headers = { authorization: `Bearer ${gateway.key}` };
  const [models, catalog] = await Promise.all(['/v1/models', '/codex/models'].map(async endpoint => { const response = await fetch(gateway.url + endpoint, { headers, signal: AbortSignal.timeout(10000) }); assert(response.ok, `Gateway catalog returned HTTP ${response.status}.`); return response.json(); }));
  const selected = process.env.MODEL_BRIDGE_VALIDATION_ROUTES ? JSON.parse(process.env.MODEL_BRIDGE_VALIDATION_ROUTES) : ['kimi', 'minimax'].map(provider => ({provider, route: process.env[`MODEL_BRIDGE_${provider.toUpperCase()}_MODEL_ROUTE`] ?? models.data.find(model => model.owned_by === provider)?.id}));
  assert(Array.isArray(selected) && selected.length > 0 && selected.length <= 8, 'Select between one and eight model routes.');
  for (const {provider, route} of selected) {
    assert(typeof provider === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(provider), 'Invalid provider label.');
    if (!route) { results.push({ provider, status: 'blocked', error: 'No configured model for this provider.', validationKind: 'real-codex-live-gateway' }); continue; }
    await validateProvider(gateway, provider, route, catalog);
  }
} catch (error) { results.push({ status: 'blocked', error: String(error.message).slice(0, 500) }); }
finally {
  for (const result of results.filter(result => result.status === 'blocked')) process.stdout.write(JSON.stringify(result) + '\n');
  const report = { createdAt: new Date().toISOString(), mockUpstream: mock, modelPools: mockPools, codexVersion: '0.144.1', results };
  if (reportFile) { await mkdir(path.dirname(reportFile), { recursive: true, mode: 0o700 }); await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  const cleanupErrors = [];
  for (const close of cleanup.reverse()) {
    try { await close(); } catch (error) { cleanupErrors.push(error); }
  }
  try {
    // Windows can briefly retain directory handles after process/stdio closure.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    cleanupErrors.push(new Error(`Could not remove validation directory ${root} after bounded retries.`, { cause: error }));
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Validation cleanup failed.');
  if (results.some(result => result.status !== 'passed') || !results.length) { process.stderr.write('Validation incomplete; inspect the metadata report. Simulated upstreams are never reported as live-provider verification.\n'); process.exitCode = 1; }
}
