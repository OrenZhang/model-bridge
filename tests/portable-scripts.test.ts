import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'smol-toml';
import { ClientConfiguration } from '../src/clients/configure.js';
import { ConfigSchema } from '../src/core/config.js';
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), 'mb-script-')); directories.push(root); const home = path.join(root, '接收端 with spaces'); await mkdir(home); return { root, home }; }
const config = ConfigSchema.parse({ connections: [{ id: 'kimi', name: 'Kimi', provider: 'kimi', baseUrl: 'https://example.invalid/v1', models: [{ id: 'coding', name: 'Coding', upstreamId: 'coding', protocols: ['chat'] }] }] });
async function execute(script: string, root: string, home: string) {
  const windows = process.platform === 'win32';
  const file = path.join(root, windows ? 'install.ps1' : 'install.sh');
  await writeFile(file, (windows ? '\ufeff' : '') + script);
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(windows ? 'powershell.exe' : '/bin/bash', windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : [file], { cwd: root, env: { ...process.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home } });
    let output = ''; child.stdout.on('data', part => output += part); child.stderr.on('data', part => output += part);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
}
it.each(['codex', 'claude'] as const)('executes the exported %s script, backs up and merges on the current OS', async client => {
  const { root, home } = await setup(); const clients = new ClientConfiguration(root, path.join(root, 'data'));
  const file = path.join(home, client === 'codex' ? 'config.toml' : 'settings.json');
  const original = client === 'codex' ? 'model = "native"\n[model_providers.other]\nname = "Other"\n[mcp_servers.example]\ncommand = "example"\n' : JSON.stringify({ permissions: { allow: ['Read'] }, env: { CUSTOM: 'keep', ANTHROPIC_API_KEY: 'original-private-key' }, mcpServers: { example: { command: 'example' } } });
  await writeFile(file, original); await writeFile(path.join(home, 'auth.json'), 'original-auth');
  // Shell metacharacters must remain data in both export formats.
  const token = "fixture-'\"`$(touch SHOULD_NOT_EXIST)-密钥";
  const bundle = clients.portable(client, config, 'http://192.168.31.21:18765', token);
  const script = bundle.scripts[process.platform === 'win32' ? 'windows' : 'macos'];
  const installed = await execute(script, root, home);
  expect(installed.code, installed.output).toBe(0);
  const current: any = client === 'codex' ? parse(await readFile(file, 'utf8')) : JSON.parse(await readFile(file, 'utf8'));
  if (client === 'codex') {
    expect(current.mcp_servers.example.command).toBe('example'); expect(current.model_providers.other.name).toBe('Other');
    expect(current.model_providers.model_bridge.experimental_bearer_token).toBe(token);
    expect(current.model_providers.model_bridge.base_url).toBe('http://192.168.31.21:18765/v1');
    expect(JSON.parse(await readFile(current.model_catalog_json, 'utf8')).models[0].slug).toBe('kimi/coding');
  } else {
    expect(current.permissions.allow).toEqual(['Read']); expect(current.mcpServers.example.command).toBe('example');
    expect(current.env.CUSTOM).toBe('keep'); expect(current.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(current.env.ANTHROPIC_AUTH_TOKEN).toBe(token);
  }
  expect(await readFile(path.join(home, 'auth.json'), 'utf8')).toBe('original-auth');
  const backups = await readdir(path.join(home, 'model-bridge-backups'));
  expect(await readFile(path.join(home, 'model-bridge-backups', backups[0]!, path.basename(file)), 'utf8')).toBe(original);
  const repeat = await execute(script, root, home); expect(repeat.code, repeat.output).toBe(0);
  expect(await readdir(path.join(home, 'model-bridge-backups'))).toHaveLength(2);
  expect(await readdir(root)).not.toContain('SHOULD_NOT_EXIST');
}, 30_000);
it('refuses malformed settings without replacing them or touching auth', async () => {
  const { root, home } = await setup(); const clients = new ClientConfiguration(root, root);
  const file = path.join(home, 'config.toml'); await writeFile(file, 'invalid = [');
  const bundle = clients.portable('codex', config, 'http://192.168.31.21:18765', 'fixture');
  expect((await execute(bundle.scripts[process.platform === 'win32' ? 'windows' : 'macos'], root, home)).code).not.toBe(0);
  expect(await readFile(file, 'utf8')).toBe('invalid = [');
  expect(await readdir(home)).toEqual(['config.toml']);
}, 30_000);
