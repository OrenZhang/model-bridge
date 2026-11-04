import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConnectionSchema } from '../src/core/config.js';
import { DeviceLogin } from '../src/auth/device-login.js';
import type { Network } from '../src/core/network.js';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); mocked.spawn.mockReset(); });
async function setup(verificationUrl = 'https://auth.openai.com/codex/device', network: Partial<Network> = { proxyUrl: async () => undefined }) {
  const processes: any[] = [];
  mocked.spawn.mockImplementation(() => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    child.send = (message: any) => child.stdout.write(JSON.stringify(message) + '\n');
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());
      if (message.id) queueMicrotask(() => child.send({ id: message.id, result: message.method === 'account/login/start' ? { loginId: 'login-' + processes.indexOf(child), userCode: 'TEST-CODE', verificationUrl } : message.method === 'account/read' ? { account: { type: 'chatgpt', email: 'test@example.invalid' } } : {} }));
      done();
    } }); processes.push(child); return child;
  });
  const home = await mkdtemp(path.join(os.tmpdir(), 'mb-device-test-')); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const connection = ConnectionSchema.parse({ id: 'test', name: 'Test', provider: 'openai', auth: 'chatgpt-device', baseUrl: 'https://chatgpt.com/backend-api/codex' });
  const login = new DeviceLogin(home, connection, network as Network, 'mock-codex'); cleanup.push(() => login.close());
  return { login, processes };
}
it('ignores an old helper exit after cancellation and a new login', async () => {
  const { login, processes } = await setup();
  expect((await login.login()).phase).toBe('waiting');
  await login.cancel(); expect(processes[0].kill).toHaveBeenCalled();
  expect((await login.login()).phase).toBe('waiting');
  processes[0].emit('exit', 0);
  processes[1].send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } });
  await vi.waitFor(() => expect(login.state).toEqual({ phase: 'authenticated', account: 'test@example.invalid' }));
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
