import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/core/runtime.js';
import { atomicWrite, ConfigStore } from '../src/core/store.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('automatically discovers models after saving credentials and updates the Codex catalog', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-discovery-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await atomicWrite(path.join(directory, 'config.json'), JSON.stringify({ port: 0, defaultProxy: { mode: 'direct' } }));
  const upstream = createServer((req, res) => { expect(req.headers.authorization).toBe('Bearer fixture-api-key'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'discovered-model' }] })); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const values = new Map<string, string>();
  const runtime = await createRuntime(directory, { get: async ref => values.get(ref), set: async (ref, value) => { values.set(ref, value); } }, directory); cleanup.push(() => runtime.close());
  await runtime.saveConnection({ id: 'provider', name: 'Provider', provider: 'custom', auth: 'api-key', baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1` }, 'fixture-api-key', true);
  await vi.waitFor(() => expect(runtime.discoveryStates().provider).toMatchObject({ phase: 'ready', count: 1 }));
  expect(runtime.store.get().connections[0]!.models[0]!.upstreamId).toBe('discovered-model');
  expect(JSON.parse(await readFile(path.join(directory, 'codex-models.json'), 'utf8')).models[0].slug).toBe('provider/discovered-model');
});
it('serializes concurrent configuration changes without losing another account', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-config-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = await new ConfigStore(directory).load();
  await Promise.all(['a', 'b'].map(id => store.update(config => { config.clients.push({ id, name: id, tokenHash: '1'.repeat(64) }); })));
  expect(store.get().clients.map(client => client.id)).toEqual(['a', 'b']);
});
it('keeps the current listener available if saving a LAN setting fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-listener-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await atomicWrite(path.join(directory, 'config.json'), JSON.stringify({ port: 0 }));
  const runtime = await createRuntime(directory, { get: async () => undefined }, directory); cleanup.push(() => runtime.close());
  const address = runtime.gateway.address;
  vi.spyOn(runtime.store, 'update').mockRejectedValueOnce(new Error('disk full'));
  await expect(runtime.setLanAccess(true)).rejects.toThrow('disk full');
  expect(runtime.store.get().listenHost).toBe('127.0.0.1');
  expect((await fetch(address + '/healthz')).status).toBe(200);
});
