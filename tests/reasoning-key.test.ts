import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadReasoningVault } from '../src/core/reasoning-key.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
it('retains encrypted history across restarts using the desktop credential store', async () => {
  const values = new Map<string, string>();
  const secrets = { get: async (ref: string) => values.get(ref), set: async (ref: string, value: string) => { values.set(ref, value); } };
  const record = { protocol: 'messages' as const, value: { type: 'thinking', thinking: 'fixture', signature: 'original-signature' } };
  const first = await loadReasoningVault('unused', secrets);
  const sealed = first.context('client-and-route', 'messages').seal(record);
  const second = await loadReasoningVault('unused', secrets);
  expect(second.context('client-and-route', 'messages').open(sealed)).toEqual(record);
  expect(() => second.context('another-client', 'messages').open(sealed)).toThrow('different client');
});
it('keeps a private CLI key and refuses to silently replace a corrupt key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-reasoning-key-')); directories.push(directory);
  const secrets = { get: async () => undefined };
  const first = await loadReasoningVault(directory, secrets); const before = await readFile(path.join(directory, 'reasoning.key'), 'utf8');
  const sealed = first.context('route', 'chat').seal({ protocol: 'chat', value: { reasoning_content: 'fixture' } });
  const second = await loadReasoningVault(directory, secrets);
  expect(second.context('route', 'chat').open(sealed).value.reasoning_content).toBe('fixture');
  expect(await readFile(path.join(directory, 'reasoning.key'), 'utf8')).toBe(before);
  if (process.platform !== 'win32') expect((await stat(path.join(directory, 'reasoning.key'))).mode & 0o777).toBe(0o600);
  await writeFile(path.join(directory, 'reasoning.key'), 'corrupt');
  await expect(loadReasoningVault(directory, secrets)).rejects.toThrow('saved reasoning key is invalid');
});
