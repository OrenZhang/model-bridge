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
    try {
      const raw = JSON.parse(await readFile(path.join(this.directory, 'config.json'), 'utf8'));
      this.current = ConfigSchema.parse(raw);
      if (!Object.hasOwn(raw, 'hiddenModels')) {
        const disabled = new Map<string, boolean>();
        for (const connection of this.current.connections) for (const model of connection.models) disabled.set(model.upstreamId, (disabled.get(model.upstreamId) ?? true) && !model.enabled);
        this.current.hiddenModels = [...disabled].filter(([,hidden])=>hidden).map(([id])=>id);
      }
    }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Invalid Model Bridge configuration. Restore a valid config.json.'); }
    return this;
  }
  get() { return structuredClone(this.current); }
  async save(value: unknown) {
    const next = ConfigSchema.parse(value);
    return this.update(() => next);
  }
  async update(change: (current: Config) => Config | void) {
    const operation = this.writes.then(async () => {
      const draft = this.get(); const next = ConfigSchema.parse(change(draft) ?? draft);
      await atomicWrite(path.join(this.directory, 'config.json'), JSON.stringify(next, null, 2));
      this.current = next;
      return this.get();
    });
    this.writes = operation.then(() => {}, () => {});
    return operation;
  }
}
export interface SecretStore { get(ref: string): Promise<string | undefined>; set?(ref: string, value: string): Promise<void>; }
export class EnvironmentSecrets implements SecretStore {
  async get(ref: string) { return ref.startsWith('env:') ? process.env[ref.slice(4)] : undefined; }
}
