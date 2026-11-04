import path from 'node:path';
import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { createRuntime } from './core/runtime.js';
import { EnvironmentSecrets } from './core/store.js';
import { tokenHash } from './gateway/server.js';

const directory = path.resolve(process.env.MODEL_BRIDGE_DATA_DIR ?? path.join(os.homedir(), '.model-bridge'));
await mkdir(directory, { recursive: true, mode: 0o700 });
if (!process.env.MODEL_BRIDGE_GATEWAY_KEY) {
  console.error('Set MODEL_BRIDGE_GATEWAY_KEY to a unique local client key. Provider API keys are referenced from config.json as env:VARIABLE_NAME.');
  process.exit(1);
}
const runtime = await createRuntime(directory, new EnvironmentSecrets(), os.homedir(), undefined, process.env.MODEL_BRIDGE_CODEX_BINARY);
const config = runtime.store.get();
config.clients = config.clients.filter(c => c.id !== 'cli');
config.clients.push({ id: 'cli', name: 'CLI client', tokenHash: tokenHash(process.env.MODEL_BRIDGE_GATEWAY_KEY) });
await runtime.store.save(config);
console.log(`Model Bridge listening on ${runtime.gateway.address}`);
console.log(`Configuration: ${path.join(directory, 'config.json')}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (stopping) return; stopping = true; void runtime.close().then(() => process.exit(0)); });
