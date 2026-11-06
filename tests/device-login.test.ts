import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConnectionSchema } from '../src/core/config.js';
import { DeviceLogin } from '../src/auth/device-login.js';
import type { Network } from '../src/core/network.js';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); mocked.spawn.mockReset(); });
async function setup(verificationUrl = 'https://auth.openai.com/codex/device', network: Partial<Network> = { proxyUrl: async () => undefined }, loginMethod: 'device' | 'browser' = 'device') {
  const processes: any[] = []; const requests: any[] = [];
  mocked.spawn.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    child.send = (message: any) => child.stdout.write(JSON.stringify(message) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString()); requests.push(message);
      if (message.id) queueMicrotask(() => child.send({ id: message.id, result: message.method === 'account/login/start' ? { loginId: 'login-' + processes.indexOf(child), ...(message.params.type === 'chatgpt' ? { authUrl: verificationUrl } : { userCode: 'TEST-CODE', verificationUrl }) } : message.method === 'account/read' ? { account: { type: 'chatgpt', email: 'test@example.invalid' } } : {} }));
      done();
    } }); processes.push(child); return child;
  });
  const home = await mkdtemp(path.join(os.tmpdir(), 'mb-device-test-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'test-account' } }));
  const connection = ConnectionSchema.parse({ loginMethod, id: 'test', name: 'Test', provider: 'openai', auth: 'chatgpt-device', baseUrl: 'https://chatgpt.com/backend-api/codex' });
  const login = new DeviceLogin(home, connection, network as Network, 'mock-codex'); cleanup.push(() => login.close());
  return { login, processes, requests, home };
}
it('ignores an old helper exit after cancellation and a new login', async () => {
  const { login, processes } = await setup();
  expect((await login.login()).phase).toBe('waiting');
  await login.cancel(); expect(processes[0].kill).toHaveBeenCalled();
  expect((await login.login()).phase).toBe('waiting');
  processes[0].emit('exit', 0);
  processes[1].send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } });
  await vi.waitFor(() => expect(login.state).toMatchObject({ phase: 'authenticated', account: 'test@example.invalid', accountId: 'test-account' }));
});
it('cancels while the network configuration is still resolving', async () => {
  let resolveProxy!: (value: undefined) => void;
  const resolving = new Promise<undefined>(resolve => { resolveProxy = resolve; });
  const { login, processes } = await setup(undefined, { proxyUrl: () => resolving });
  const operation = login.login(); await login.cancel(); resolveProxy(undefined); await operation;
  expect(login.state.phase).toBe('cancelled'); expect(processes).toHaveLength(0);
});
it('rejects device authorization links outside the expected identity provider', async () => {
  const { login } = await setup('https://attacker.invalid/authorize');
  expect((await login.login()).phase).toBe('error'); expect(login.state.verificationUrl).toBeUndefined();
});

it('uses the official browser RPC and accepts its validated callback authorization URL', async () => {
  const { login, requests, processes } = await setup('https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback', undefined, 'browser');
  expect(await login.login()).toMatchObject({ phase: 'waiting', method: 'browser' });
  expect(login.state.userCode).toBeUndefined();
  expect(requests.find(r => r.method === 'account/login/start').params).toEqual({ type: 'chatgpt' });
  processes[0].send({ method: 'account/login/completed', params: { loginId: 'login-0', success: true } });
  await vi.waitFor(() => expect(login.state.phase).toBe('authenticated'));
});
it('rejects unexpected browser authorization URLs', async () => {
  const { login } = await setup('https://auth.openai.com.attacker.invalid/login', undefined, 'browser');
  expect((await login.login()).phase).toBe('error');
  expect(login.state.verificationUrl).toBeUndefined();
});
it('keeps separate account credential directories and cancels only its own helper', async () => {
  const first = await setup(); await first.login.login();
  const second = await setup(); await second.login.login();
  expect(first.home).not.toBe(second.home);
  expect(mocked.spawn.mock.calls.at(-1)![2].env.CODEX_HOME).toBe(second.home);
  await first.login.cancel();
  expect(first.processes[0].kill).toHaveBeenCalled();
  expect(second.processes[0].kill).not.toHaveBeenCalled();
  expect(second.login.state.phase).toBe('waiting');
});
it('reads all model pages including picker-hidden models and preserves reasoning metadata',async()=>{
 const {login,requests,processes}=await setup();
 await login.login(); const child=processes[0];
 child.stdin._write=(chunk:any,_encoding:any,done:any)=>{const m=JSON.parse(chunk.toString());requests.push(m);const data=m.params.cursor?[{model:'second',hidden:true,supportedReasoningEfforts:[{reasoningEffort:'high'}]}]:[{model:'first'},{model:'first'}];queueMicrotask(()=>child.send({id:m.id,result:{data,nextCursor:m.params.cursor?null:'next'}}));done();};
 const result=await login.catalog();expect(result.data.map((m:any)=>m.model)).toEqual(['first','second']);expect(result.data[1].supportedReasoningEfforts[0].reasoningEffort).toBe('high');
 expect(requests.filter(r=>r.method==='model/list').map(r=>r.params)).toEqual([{includeHidden:true,limit:100},{includeHidden:true,limit:100,cursor:'next'}]);
});
it('rejects repeated model pagination cursors instead of returning an incomplete success',async()=>{
 const {login,processes}=await setup();await login.login();const child=processes[0];
 child.stdin._write=(chunk:any,_encoding:any,done:any)=>{const m=JSON.parse(chunk.toString());queueMicrotask(()=>child.send({id:m.id,result:{data:[],nextCursor:'same'}}));done();};
 await expect(login.catalog()).rejects.toThrow('分页异常');
});
