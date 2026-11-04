// Real Mihomo smoke test: loopback-only fake upstream and proxy, no provider credentials.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRuntime } from '../dist/core/runtime.js';
import { atomicWrite } from '../dist/core/store.js';

const directory = process.env.MODEL_BRIDGE_SMOKE_DATA ?? await mkdtemp(path.join(os.tmpdir(), 'mb-network-smoke-'));
await mkdir(directory, { recursive: true });
let proxied = 0;
const upstream = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] })); });
const proxy = createServer((req, res) => { proxied++; const outgoing = request(req.url, { method: req.method }, result => { res.writeHead(result.statusCode, result.headers); result.pipe(res); }); req.pipe(outgoing); outgoing.on('error', () => res.destroy()); });
const sockets = new Set();
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('connect', (req, socket, head) => {
  proxied++; const target = connect(Number(req.url.split(':').at(-1)), '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); socket.pipe(target); target.pipe(socket); });
  socket.on('close', () => target.destroy()); socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
});
for (const server of [upstream, proxy]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await atomicWrite(path.join(directory, 'config.json'), JSON.stringify({ port: 0 }));
const secrets = new Map();
const runtime = await createRuntime(directory, { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); } }, directory, async () => process.env.MODEL_BRIDGE_SMOKE_PROXY || undefined);
try {
  console.log('Installing/checking official Mihomo helper...');
  await runtime.managed.core.ensure();
  const id = await runtime.managed.save({ name: 'Loopback smoke', source: 'config', config: `proxies:\n  - name: LocalTest\n    type: http\n    server: 127.0.0.1\n    port: ${proxy.address().port}\n` });
  await runtime.saveConnection({ id: 'smoke', name: 'Smoke', provider: 'custom', auth: 'none', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, proxy: { mode: 'managed', profileId: id } });
  const models = await runtime.discover('smoke');
  assert.equal(models[0].upstreamId, 'smoke-model'); assert.ok(proxied > 0);
  assert.equal(runtime.managed.overview().profiles[0].status, 'running');
  console.log('PASS: actual Mihomo process -> selected node -> model discovery; only loopback listeners.');
} finally {
  await runtime.close(); for (const socket of sockets) socket.destroy();
  for (const server of [upstream, proxy]) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (!process.env.MODEL_BRIDGE_SMOKE_DATA) await rm(directory, { recursive: true, force: true });
}
