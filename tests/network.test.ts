import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { ConfigSchema } from '../src/core/config.js';
import { Network } from '../src/core/network.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const requests: string[] = []; const tunnels: string[] = [];
  const upstream = createServer((req, res) => { requests.push(req.url!); res.end('connected'); });
  const proxy = createServer((req, res) => {
    tunnels.push(req.url!);
    const forwarded = request(new URL(req.url!), { method: req.method }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
    forwarded.on('error', () => res.destroy()); req.pipe(forwarded);
  });
  proxy.on('connect', (req, socket, head) => {
    tunnels.push(req.url!); const port = Number(req.url!.split(':').at(-1));
    const remote = connect(port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); socket.pipe(remote); remote.pipe(socket); });
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy());
  });
  for (const server of [upstream, proxy]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  }
  const url = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const config = ConfigSchema.parse({ proxies: [{ id: 'test-proxy', name: 'Test', url: `http://127.0.0.1:${(proxy.address() as any).port}` }], connections: [{ id: 'test', name: 'Test', provider: 'custom', auth: 'none', baseUrl: url, proxy: { mode: 'proxy', profileId: 'test-proxy' } }] });
  const network = new Network(() => config, { get: async () => undefined }); cleanup.push(() => network.close());
  return { network, config, url, requests, tunnels };
}
it('uses an HTTP proxy for the selected account', async () => {
  const { network, config, url, requests, tunnels } = await setup();
  expect(await (await network.request(config.connections[0]!, url + '/models')).text()).toBe('connected');
  expect(requests).toEqual(['/models']); expect(tunnels).toHaveLength(1);
});
it('explicit direct mode ignores ambient proxy variables', async () => {
  const { network, config, url, tunnels } = await setup();
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1'); vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
  const connection = { ...config.connections[0]!, proxy: { mode: 'direct' as const } };
  expect(await (await network.request(connection, url)).text()).toBe('connected'); expect(tunnels).toHaveLength(0);
});
it('a failed account proxy does not fall back to a direct connection', async () => {
  const { network, config, url, requests } = await setup(); config.proxies[0]!.url = 'http://127.0.0.1:1';
  await expect(network.request(config.connections[0]!, url)).rejects.toMatchObject({ code: 'upstream_connection_failed' }); expect(requests).toHaveLength(0);
});
it('a broken managed subscription cannot affect explicit direct or independent proxy connections',async()=>{
 const {config,url,tunnels}=await setup();
 config.networkProfiles.push({id:'broken',name:'Broken',source:'config',nodes:['node'],selected:'node',selectionMode:'auto',secretRef:'private',updatedAt:'now'});config.defaultProxy={mode:'managed',profileId:'broken'};
 const managed=vi.fn(async()=>{throw new Error('subscription unavailable')});
 const isolated=new Network(()=>config,{get:async()=>undefined},undefined,managed);cleanup.push(()=>isolated.close());
 await expect(isolated.request({...config.connections[0]!,proxy:{mode:'managed',profileId:'broken'}},url)).rejects.toMatchObject({code:'upstream_connection_failed'});
 expect(await(await isolated.request({...config.connections[0]!,proxy:{mode:'direct'}},url)).text()).toBe('connected');
 expect(await(await isolated.request(config.connections[0]!,url)).text()).toBe('connected');expect(managed).toHaveBeenCalledTimes(1);expect(tunnels).toHaveLength(1);
});
