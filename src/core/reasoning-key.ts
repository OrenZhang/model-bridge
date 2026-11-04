import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SecretStore } from './store.js';
import { ReasoningVault } from '../gateway/reasoning.js';

// Persist the sealing key so a restart does not invalidate an agent's conversation.
export async function loadReasoningVault(directory: string, secrets: SecretStore) {
  let encoded: string;
  if (secrets.set) {
    const saved = await secrets.get('gateway:reasoning-key');
    encoded = saved ?? randomBytes(32).toString('base64url');
    if (saved === undefined) await secrets.set('gateway:reasoning-key', encoded);
  } else {
    const file = path.join(directory, 'reasoning.key');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { encoded = await readFile(file, 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      encoded = randomBytes(32).toString('base64url');
      try { await writeFile(file, encoded, { flag: 'wx', mode: 0o600 }); }
      catch (writeError: any) { if (writeError.code !== 'EEXIST') throw writeError; encoded = await readFile(file, 'utf8'); }
    }
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded) || Buffer.from(encoded, 'base64url').byteLength !== 32) throw new Error('The saved reasoning key is invalid. Restore the original credential store before resuming conversations.');
  return new ReasoningVault(Buffer.from(encoded, 'base64url'));
}
