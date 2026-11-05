import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigSchema } from '../src/core/config.js';
import { ClientConfiguration } from '../src/clients/configure.js';
import { codexBinary } from '../src/auth/codex-binary.js';

it('the portable export loads every provider in real Codex from an unrelated working directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mb-codex-catalog-'));
  const config = ConfigSchema.parse({ connections: ['kimi', 'minimax'].map(provider => ({ id: provider, name: provider, provider, auth: 'none', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'test-model', name: `${provider} Test`, upstreamId: 'test-model', protocols: ['chat'] }] })) });
  const configuration = new ClientConfiguration(root, path.join(root, 'data'));
  const bundle = configuration.portable('codex', config, 'http://192.168.31.21:18765', 'isolated-test-key');
  const codexHome = path.join(root, 'remote codex home'); await mkdir(codexHome);
  for (const [filename, content] of Object.entries(bundle.files)) await writeFile(path.join(codexHome, filename), content);
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  for (const key of ['OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[key];
  const child = spawn(codexBinary(), ['app-server', '--listen', 'stdio://'], { cwd: root, env, stdio: 'pipe', windowsHide: true });
  const childClosed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stderr.resume();
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const message = JSON.parse(line); const p = pending.get(message.id); if (!p) return; pending.delete(message.id); if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result); } catch {} });
  child.on('error', error => { for (const p of pending.values()) p.reject(error); });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Codex exited before returning its model catalog.')); });
  const rpc = (method: string, params: any) => new Promise<any>((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n'); });
  try {
    await rpc('initialize', { clientInfo: { name: 'model_bridge_test', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const catalog = await rpc('model/list', { includeHidden: false });
    expect(catalog.data.map((model: any) => model.model)).toEqual(expect.arrayContaining(['kimi/test-model', 'minimax/test-model']));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childClosed; lines.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 30000);
