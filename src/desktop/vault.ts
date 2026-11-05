import { safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { atomicWrite, type SecretStore } from '../core/store.js';

export class DesktopVault implements SecretStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  private async read(): Promise<Record<string, string>> {
    if (!await safeStorage.isAsyncEncryptionAvailable() || process.platform==='linux' && ['basic_text','unknown'].includes(safeStorage.getSelectedStorageBackend())) throw new Error('系统凭据库不可用。Linux 请启用 GNOME Keyring / libsecret 或 KWallet，应用不使用 basic_text 保存密钥。');
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
