import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigSchema, emptyConfig, type Config } from './config.js';

export async function atomicWrite(file: string, contents: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}
export class ConfigStore {
  private current: Config = emptyConfig();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async load() {
    try { this.current = ConfigSchema.parse(JSON.parse(await readFile(path.join(this.directory, 'config.json'), 'utf8'))); }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Invalid Model Bridge configuration. Restore a valid config.json.'); }
    return this;
  }
  get() { return structuredClone(this.current); }
  async save(value: unknown) {
    const next = ConfigSchema.parse(value);
    const operation = this.writes.then(async () => {
      await atomicWrite(path.join(this.directory, 'config.json'), JSON.stringify(next, null, 2));
      this.current = next;
    });
    this.writes = operation.catch(() => {});
    await operation;
  }
}
export interface SecretStore { get(ref: string): Promise<string | undefined>; set?(ref: string, value: string): Promise<void>; }
export class EnvironmentSecrets implements SecretStore {
  async get(ref: string) { return ref.startsWith('env:') ? process.env[ref.slice(4)] : undefined; }
}
