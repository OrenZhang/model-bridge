import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/core/runtime.js';
import { ConfigStore } from '../src/core/store.js';
import { subscriptionEndpoints } from '../src/auth/provider-login.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.each(['kimi', 'minimax'] as const)('discovers and calls %s through its regional subscription endpoint with vault credentials', async provider => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-subscription-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory).load();
  const endpoints = subscriptionEndpoints(provider, 'global');
  const model = provider === 'kimi' ? 'kimi-for-coding' : 'MiniMax-M2.7';
  await store.save({ port: 0, connections: [{ id: provider, name: provider, provider, auth: 'subscription', region: 'global', baseUrl: endpoints.base, credentialVersion: 'fixture-authorized' }] });
  const values = new Map<string, string>([[`subscription:${provider}:global:${provider}`, JSON.stringify({ access: 'private-subscription-token', refresh: 'private-refresh', expires: Date.now() + 3600000 })]]);
  const runtime = await createRuntime(directory, { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } }, directory); cleanup.push(() => runtime.close());
  let requests = 0;
  vi.spyOn(runtime.network, 'request').mockImplementation(async (_connection, url, init) => {
    expect(url.startsWith(endpoints.base + '/')).toBe(true);
    const headers = new Headers(init?.headers); expect(headers.get('authorization')).toBe('Bearer private-subscription-token');
    if (url.endsWith('/models')) {
      if (provider === 'minimax') return new Response('', { status: 404 });
      return Response.json({ data: [{ id: model, protocol: 'anthropic', display_name: 'Fixture', limit: { context: 200000 }, supports_tool_use: true, modalities: { input: ['text'] } }] });
    }
    expect(url).toBe(endpoints.base + '/messages' + (provider === 'kimi' ? '?beta=true' : ''));
    expect(headers.get('x-api-key')).toBeNull();
    const body = JSON.parse(String(init?.body)); expect(body.model).toBe(model);
    if (provider === 'kimi') expect(body.thinking).toEqual({ type: 'adaptive' });
    requests++;
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'SUBSCRIPTION_OK' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 3 } });
  });
  await runtime.discover(provider);
  if (provider === 'minimax') expect(runtime.discoveryStates().minimax?.source).toBe('preset');
  else expect(runtime.store.get().connections[0]!.models[0]!.protocols).toEqual(['messages']);
  const token = await runtime.ensureClient('codex');
  const response = await fetch(runtime.gateway.address + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: provider + '/' + model, input: 'Reply with the fixture.', reasoning: { effort: 'medium' }, stream: false }) });
  expect(response.status).toBe(200); expect(await response.text()).toContain('SUBSCRIPTION_OK'); expect(requests).toBe(1);
  // A provider authorization failure must remain an error, never become a preset success.
  vi.mocked(runtime.network.request).mockResolvedValue(new Response('', { status: 401 }));
  if (provider === 'kimi') {
    await expect(runtime.discover(provider)).rejects.toThrow('401'); expect(runtime.discoveryStates()[provider]?.phase).toBe('error');
  } else {
    const rejected = await fetch(runtime.gateway.address + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: provider + '/' + model, input: 'test', stream: false }) });
    expect(rejected.status).toBe(401);
  }
});

it('keeps MiniMax authorization visible through discovery and restart without resetting account identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-login-lifecycle-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory).load();
  const baseUrl = subscriptionEndpoints('minimax', 'cn').base;
  await store.save({ port: 0, connections: [{ id: 'minimax', name: 'Fixture', provider: 'minimax', auth: 'subscription', baseUrl }] });
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key), set: async (key: string, value: string) => { values.set(key, value); } };
  const runtime = await createRuntime(directory, secrets, directory); let current = runtime; cleanup.push(() => current.close());
  const calls: string[] = [];
  vi.spyOn(runtime.network, 'request').mockImplementation(async (_connection, url) => {
    calls.push(url);
    if (url.endsWith('/device/code')) return Response.json({ device_code: 'private-device', user_code: 'USER', verification_uri: 'https://account.minimax.cn/device', interval: 1, expires_in: 600 });
    if (url.endsWith('/token')) return Response.json({ access_token: 'opaque-private-access', refresh_token: 'private-refresh', token_type: 'Bearer', scope: 'agent.default', expires_in: 3600 });
    return new Response('', { status: 503 });
  });
  expect((await runtime.startLogin('minimax')).phase).toBe('waiting');
  await vi.waitFor(() => expect(runtime.discoveryStates().minimax?.phase).toBe('ready'), { timeout: 4000 });
  expect(runtime.loginStates().minimax?.phase).toBe('authenticated');
  expect(runtime.store.get().connections[0]!.models.length).toBeGreaterThan(0);
  expect(calls).not.toContain(baseUrl + '/models');
  const version = runtime.store.get().connections[0]!.credentialVersion;
  const helper = runtime.loginFor('minimax');
  await runtime.discover('minimax'); expect(runtime.loginFor('minimax')).toBe(helper);
  expect(runtime.loginStates().minimax?.phase).toBe('authenticated');
  await runtime.close(); current = await createRuntime(directory, secrets, directory);
  expect(current.loginStates().minimax?.phase).toBe('authenticated');
  expect(current.store.get().connections[0]!.credentialVersion).toBe(version);
  expect(current.store.get().connections[0]!.models.length).toBeGreaterThan(0);
}, 10000);

it('fills missing thinking controls on existing plan models without rewriting native client settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-plan-migration-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory).load();
  await store.save({ port: 0, connections: [{ id: 'minimax', name: 'Plan', provider: 'minimax', auth: 'subscription', baseUrl: subscriptionEndpoints('minimax').base, models: [{ id: 'custom-alias', name: 'Keep my label', upstreamId: 'MiniMax-M3.1-Flash', protocols: ['messages'], enabled: false, price: { input: 1, output: 2 } }, { id: 'existing', name: 'Existing', upstreamId: 'MiniMax-M3', protocols: ['messages'], reasoning: ['none'] }] }] });
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  await mkdir(path.join(directory, '.codex')); await writeFile(path.join(directory, '.codex', 'config.toml'), 'model = "original"\n');
  const runtime = await createRuntime(directory, {get:async()=>undefined}, directory); cleanup.push(()=>runtime.close());
  const [migrated, explicit] = runtime.store.get().connections[0]!.models;
  expect(migrated).toMatchObject({id:'custom-alias',name:'Keep my label',enabled:false,price:{input:1,output:2},reasoning:['medium','low','high','xhigh','max']});
  expect(explicit!.reasoning).toEqual(['none']);
  expect(await readFile(path.join(directory, '.codex', 'config.toml'), 'utf8')).toBe('model = "original"\n');
});
