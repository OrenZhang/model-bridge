import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';

export interface InstallPayload { client: 'codex' | 'claude'; configuration: string; catalog?: string }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
async function read(file: string) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${file}`);
    return await readFile(file, 'utf8');
  } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

/** Standalone offline installer. Never reads or replaces the client's auth.json. */
export async function installPortable(payload: InstallPayload) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Please install Node.js 18 or newer first.');
  if (payload.client !== 'codex' && payload.client !== 'claude') throw new Error('Unknown client.');
  const directory = path.resolve(payload.client === 'codex' ? process.env.CODEX_HOME || path.join(os.homedir(), '.codex') : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, '.model-bridge-install.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const file = path.join(directory, payload.client === 'codex' ? 'config.toml' : 'settings.json');
    const before = await read(file);
    const current = before === null ? {} : payload.client === 'codex' ? parse(before) : JSON.parse(before);
    const generated = payload.client === 'codex' ? parse(payload.configuration) : JSON.parse(payload.configuration);
    if (!object(current) || !object(generated)) throw new Error('Client settings must be an object.');
    let content: string;
    const catalogFile = path.join(directory, 'model-bridge-models.json');
    let previousCatalog: string | null = null;
    if (payload.client === 'codex') {
      if (!payload.catalog || !Array.isArray(JSON.parse(payload.catalog).models)) throw new Error('Missing Codex model catalog.');
      if (current.model_providers !== undefined && !object(current.model_providers)) throw new Error('Invalid model_providers.');
      for (const key of ['model_provider', 'model', 'web_search']) current[key] = generated[key];
      current.model_catalog_json = catalogFile;
      current.model_providers = { ...current.model_providers, model_bridge: generated.model_providers.model_bridge };
      previousCatalog = await read(catalogFile);
      content = stringify(current);
    } else {
      if (current.env !== undefined && !object(current.env)) throw new Error('Invalid Claude Code env settings.');
      current.env = { ...current.env, ...generated.env };
      delete current.env.ANTHROPIC_API_KEY;
      content = JSON.stringify(current, null, 2) + '\n';
    }
    const backup = path.join(directory, 'model-bridge-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
    await mkdir(backup, { recursive: true, mode: 0o700 });
    if (before !== null) await writeFile(path.join(backup, path.basename(file)), before, { mode: 0o600, flag: 'wx' });
    if (previousCatalog !== null) await writeFile(path.join(backup, path.basename(catalogFile)), previousCatalog, { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ file, existed: before !== null, catalogFile: payload.client === 'codex' ? catalogFile : null, catalogExisted: previousCatalog !== null }, null, 2), { mode: 0o600, flag: 'wx' });
    if (await read(file) !== before || (payload.client === 'codex' && await read(catalogFile) !== previousCatalog)) throw new Error('Settings changed during installation. Please run again.');
    if (payload.client === 'codex') await atomic(catalogFile, payload.catalog!);
    try {
      if (await read(file) !== before) throw new Error('Settings changed during installation. Please run again.');
      await atomic(file, content);
    } catch (error) {
      if (payload.client === 'codex') {
        if (previousCatalog === null) await rm(catalogFile, { force: true });
        else await atomic(catalogFile, previousCatalog);
      }
      throw error;
    }
    console.log(`Model Bridge configured: ${file}\nBackup: ${backup}\nRestart ${payload.client === 'codex' ? 'Codex' : 'Claude Code'} to use the gateway.`);
    return { file, backup };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
