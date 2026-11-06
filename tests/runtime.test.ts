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
  expect(JSON.parse(await readFile(path.join(directory, 'codex-models.json'), 'utf8')).models[0].slug).toBe('discovered-model');
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

it('keeps the previous API credential active when saving its replacement configuration fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-key-replacement-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await atomicWrite(path.join(directory, 'config.json'), JSON.stringify({ port: 0 }));
  const values = new Map<string,string>();
  const runtime = await createRuntime(directory, {get:async ref=>values.get(ref),set:async(ref,value)=>{values.set(ref,value);}}, directory); cleanup.push(()=>runtime.close());
  const raw={id:'provider',name:'Provider',provider:'custom',baseUrl:'https://upstream.invalid/v1'};
  const old=await runtime.saveConnection(raw,'original-key');
  vi.spyOn(runtime.store,'update').mockRejectedValueOnce(new Error('disk full'));
  await expect(runtime.saveConnection({...old},'replacement-key')).rejects.toThrow('disk full');
  expect(runtime.store.get().connections[0]!.secretRef).toBe(old.secretRef);
  expect(values.get(old.secretRef!)).toBe('original-key');
});

async function credentialFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-key-discovery-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await atomicWrite(path.join(directory, 'config.json'), JSON.stringify({port:0,defaultProxy:{mode:'direct'}}));
  let requests=0; let rejected=false;
  const upstream=createServer((req,res)=>{requests++;res.setHeader('content-type','application/json');if(rejected||req.headers.authorization!=='Bearer fixture-deepseek-key'){res.writeHead(401);res.end('{}');}else res.end(JSON.stringify({data:[{id:'deepseek-test'}]}));});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));cleanup.push(()=>new Promise<void>(resolve=>{upstream.closeAllConnections();upstream.close(()=>resolve())}));
  const values=new Map<string,string>(); const runtime=await createRuntime(directory,{get:async ref=>values.get(ref),set:async(ref,value)=>{values.set(ref,value)}},directory);cleanup.push(()=>runtime.close());
  const raw={id:'deepseek',name:'DeepSeek',provider:'deepseek',auth:'api-key',baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`};
  return {runtime,raw,values,requests:()=>requests,reject:()=>{rejected=true}};
}
it('preserves a saved DeepSeek key when editing a path on the same origin, and normalizes a pasted Bearer prefix',async()=>{
  const f=await credentialFixture(); const saved=await f.runtime.saveConnection(f.raw,' Bearer fixture-deepseek-key ');
  const edited=await f.runtime.saveConnection({...saved,baseUrl:saved.baseUrl.replace('/v1','')},'');
  expect(edited.secretRef).toBe(saved.secretRef);expect(f.values.get(saved.secretRef!)).toBe('fixture-deepseek-key');
  expect((await f.runtime.discover(saved.id))[0]!.upstreamId).toBe('deepseek-test');
  await expect(f.runtime.saveConnection({...edited,baseUrl:'https://other.invalid/v1'})).rejects.toThrow('重新填写');
  expect(f.runtime.store.get().connections[0]!.baseUrl).toBe(edited.baseUrl);
});
it('rejects saving API authentication without a key instead of silently discovering anonymously',async()=>{
  const f=await credentialFixture();await expect(f.runtime.saveConnection(f.raw,' ')).rejects.toThrow('请填写 API Key');expect(f.requests()).toBe(0);
});
it('distinguishes official authentication rejection from a missing stored key without suggesting model IDs',async()=>{
  const f=await credentialFixture();const saved=await f.runtime.saveConnection(f.raw,'fixture-deepseek-key');f.reject();
  await expect(f.runtime.discover(saved.id)).rejects.toThrow('DeepSeek拒绝了此连接的 API Key（HTTP 401）');
  const count=f.requests();f.values.delete(saved.secretRef!);await expect(f.runtime.discover(saved.id)).rejects.toThrow('未保存或无法读取');expect(f.requests()).toBe(count);
});
