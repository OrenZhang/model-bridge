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
  await expect(runtime.discover(provider)).rejects.toThrow('401'); expect(runtime.discoveryStates()[provider]?.phase).toBe('error');
});
