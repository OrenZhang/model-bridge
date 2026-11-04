import { expect, it, vi } from 'vitest';
import { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/core/config.js';
import type { Network } from '../src/core/network.js';
import { UsageStore, type UsageRecord } from '../src/core/usage.js';
import { startGateway, tokenHash } from '../src/gateway/server.js';

function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('waits for usage persistence after the HTTP response and listener have closed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-bridge-shutdown-'));
  const writeStarted = latch<UsageRecord>(); const releaseWrite = latch<void>(); const listenerClosed = latch<void>();
  const usage = new UsageStore(directory); const append = usage.append.bind(usage);
  vi.spyOn(usage, 'append').mockImplementation(async record => {
    writeStarted.resolve(record);
    await releaseWrite.promise;
    await append(record);
  });
  const config = ConfigSchema.parse({ port: 0, clients: [{ id: 'client', name: 'Test client', tokenHash: tokenHash('test-key') }], connections: [{
    id: 'vendor', name: 'Fixture', provider: 'custom', auth: 'none', baseUrl: 'https://upstream.invalid/v1',
    models: [{ id: 'model', name: 'Fixture', upstreamId: 'upstream-model', protocols: ['responses'] }],
  }] });
  const network = { request: async () => new Response(JSON.stringify({ id: 'response-fixture', output: [], usage: { input_tokens: 11, output_tokens: 7 } }), { headers: { 'content-type': 'application/json' } }), close: async () => {} } as unknown as Network;
  const gateway = await startGateway({ config: () => config, secrets: { get: async () => undefined }, network, usage });
  let closing: Promise<void> | undefined;
  const originalClose = Server.prototype.close;
  const closeSpy = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
    return originalClose.call(this, error => { callback?.(error); listenerClosed.resolve(); });
  });
  try {
    const response = await fetch(gateway.address + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'vendor/model', input: 'fixture', stream: false }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'response-fixture', usage: { input_tokens: 11, output_tokens: 7 } });
    const record = await writeStarted.promise;
    expect(gateway.activeRequests()).toBe(0);
    let closeSettled = false;
    closing = gateway.close().then(() => { closeSettled = true; });
    await listenerClosed.promise;
    const file = path.join(directory, `${record.startedAt.slice(0, 10)}.jsonl`);
    // The listener is already closed, but the explicitly latched usage write has
    // not started disk I/O. No timeout or sleep determines whether close is ready.
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(closeSettled).toBe(false);
    releaseWrite.resolve();
    await closing;
    expect(closeSettled).toBe(true);
    const records = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: record.id, clientId: 'client', model: 'vendor/model', status: 'success', tokens: { input: 11, output: 7 } });
  } finally {
    releaseWrite.resolve();
    try { await (closing ?? gateway.close()); }
    finally { closeSpy.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  }
});
