// Real pinned Mihomo; fake loopback AI services and three controlled proxy nodes.
// No user profile, account credentials, prompts or paid generations are accessed.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ConfigStore } from '../dist/core/store.js';
import { ConnectionSchema } from '../dist/core/config.js';
import { Network } from '../dist/core/network.js';
import { ManagedNetworks } from '../dist/network/managed.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-ai-selection-'));
const sockets = new Set(); const servers = []; const nodes = [];
function track(server) { servers.push(server); server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); }); return server; }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
let network, managed; let active = false;
try {
  for (let i = 0; i < 3; i++) {
    const node = { name: ['BlockedFast', 'SlowAvailable', 'FastAvailable'][i], delay: [1, 120, 15][i], broken: false, calls: 0 };
    const service = track(createServer((req, res) => {
      if (req.headers.authorization || req.headers['x-api-key']) { res.writeHead(500); res.end('unexpected credentials in test'); return; }
      const isProbe = req.url.endsWith('/models');
      if (!isProbe) node.calls++;
      setTimeout(() => {
        if (i === 0 || node.broken || (i === 2 && req.url.startsWith('/v2/'))) { res.writeHead(i === 0 ? 403 : 503, { 'content-type': 'text/html' }); res.end('not available'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (isProbe) res.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
        else if (req.url === '/v1/stream') { res.write(`stream-${node.name}:`); setTimeout(() => res.end('finished'), 350); }
        else res.end(JSON.stringify({ node: node.name }));
      }, node.delay);
    }));
    const servicePort = await listen(service);
    const proxy = track(createServer((req, res) => {
      const pathname = new URL(req.url).pathname;
      const outgoing = request(`http://127.0.0.1:${servicePort}${pathname}`, { method: req.method }, result => { res.writeHead(result.statusCode, result.headers); result.pipe(res); });
      req.pipe(outgoing); outgoing.on('error', () => res.destroy());
    }));
    proxy.on('connect', (_req, socket, head) => {
      const remote = connect(servicePort, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); });
      socket.on('close', () => remote.destroy()); socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    });
    node.port = await listen(proxy); nodes.push(node);
  }
  const store = await new ConfigStore(directory).load();
  const secrets = new Map(); const vault = { get: async key => secrets.get(key), set: async (key, value) => { secrets.set(key, value); } };
  network = new Network(() => store.get(), vault, undefined, (id, c) => managed.proxyUrl(id, c), (id, c, proxy) => managed.failed(id, c, proxy));
  managed = new ManagedNetworks(directory, store, vault, network, () => !active);
  managed.core.download = async () => { throw new Error('Test requires bundled core: network download forbidden'); };
  await managed.core.ensure();
  assert.equal(managed.core.status().installed, true);
  console.log('PASS: bundled archive installs with network download disabled');
  const id = await managed.save({ name: 'AI test', source: 'config', config: 'proxies:\n' + nodes.map(n => `  - { name: ${n.name}, type: http, server: 127.0.0.1, port: ${n.port} }`).join('\n') });
  const base = 'http://127.0.0.1:19888'; // Requested destination is redirected by controlled proxy nodes.
  const connection = ConnectionSchema.parse({ id: 'test', name: 'Test', provider: 'custom', auth: 'none', baseUrl: base + '/v1', proxy: { mode: 'managed', profileId: id } });
  const second = ConnectionSchema.parse({ ...connection, id: 'second', baseUrl: base + '/v2' });
  await store.update(c => { c.connections = [connection, second]; });
  const response = await network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}', signal: AbortSignal.timeout(15000) });
  assert.equal((await response.json()).node, 'FastAvailable');
  assert.equal(managed.overview().profiles[0].checks[0].available, 2);
  console.log('PASS: actual Mihomo IN-USER routing picks lowest latency AI-available node, excludes fast 403');
  const other = await network.request(second, base + '/v2/chat/completions', { method: 'POST', body: '{}' });
  assert.equal((await other.json()).node, 'SlowAvailable');
  assert.equal(managed.overview().profiles[0].checks.length, 2);
  console.log('PASS: separate AI service targets select different nodes in one subscription');
  const stream = await network.request(connection, base + '/v1/stream');
  const reader = stream.body.getReader(); const first = await reader.read(); assert.match(Buffer.from(first.value).toString(), /FastAvailable/);
  const before = nodes[2].calls; nodes[2].broken = true;
  const failed = await network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(failed.status, 503); await failed.body.cancel(); assert.equal(nodes[2].calls, before + 1);
  const next = await network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal((await next.json()).node, 'SlowAvailable');
  let tail = ''; for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += Buffer.from(chunk.value).toString(); }
  assert.equal(tail, 'finished');
  console.log('PASS: failure switches next request without replaying failed generation or breaking existing stream');
  active = true; await assert.rejects(managed.select(id, 'SlowAvailable'), /请求完成/); active = false;
  await managed.select(id, 'BlockedFast');
  assert.equal(store.get().networkProfiles[0].selectionMode, 'manual');
  const manual = await network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(manual.status, 403); await manual.body.cancel();
  console.log('PASS: manual selection is retained and rejects mode changes during active requests');
  await managed.automatic(id); nodes[2].broken = false;
  const restored = await network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal((await restored.json()).node, 'FastAvailable');
  nodes[1].broken = true; nodes[2].broken = true;
  await managed.check(id);
  const callsBefore = nodes.reduce((sum, node) => sum + node.calls, 0);
  await assert.rejects(network.request(connection, base + '/v1/chat/completions', { method: 'POST', body: '{}' }), { code: 'no_ai_proxy_available' });
  assert.equal(nodes.reduce((sum, node) => sum + node.calls, 0), callsBefore);
  console.log('PASS: all nodes unavailable returns a clear error without direct or unchecked fallback');
} finally {
  await managed?.close(); await network?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await rm(directory, { recursive: true, force: true });
}
