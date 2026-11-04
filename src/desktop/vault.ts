import { safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { atomicWrite, type SecretStore } from '../core/store.js';

export class DesktopVault implements SecretStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  private async read(): Promise<Record<string, string>> {
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('The operating system credential store is unavailable.');
    try { return JSON.parse((await safeStorage.decryptStringAsync(await readFile(this.file))).result); }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Error('Could not open the encrypted credential store.'); }
  }
  async get(ref: string) { if (ref.startsWith('env:')) return process.env[ref.slice(4)]; await this.writes; return (await this.read())[ref]; }
  async set(ref: string, value: string) {
    const operation = this.writes.then(async () => {
      const values = await this.read(); values[ref] = value;
      await atomicWrite(this.file, await safeStorage.encryptStringAsync(JSON.stringify(values)));
    });
    this.writes = operation.catch(() => {}); await operation;
  }
}
