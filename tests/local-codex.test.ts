import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalCodexAccounts } from '../src/auth/local-codex.js';
import { atomicWrite } from '../src/core/store.js';
import { ConfigSchema } from '../src/core/config.js';
const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', account_id: 'fixture-account', id_token: 'header.' + Buffer.from(JSON.stringify({ email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } })).toString('base64url') + '.signature' } };
async function setup(keyring?: () => Promise<string | null>) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mb-local-codex-')); directories.push(home);
  const config = ConfigSchema.parse({}); const secrets = new Map<string, string>();
  const accounts = new LocalCodexAccounts(home, undefined, path.join(home, 'bridge'), () => config, { get: async ref => secrets.get(ref), set: async (ref, value) => { secrets.set(ref, value); } }, keyring ?? (async () => null));
  return { home, config, accounts, secrets };
}
it('detects and imports an existing ChatGPT login without exposing tokens or changing its source', async () => {
  const { home, accounts, config } = await setup();
  const original = JSON.stringify(auth); await atomicWrite(path.join(home, '.codex/auth.json'), original);
  const state = await accounts.scan(); expect(state[0]).toMatchObject({ kind: 'chatgpt', email: 'fixture@example.invalid', canImport: true, imported: false });
  expect(JSON.stringify(state)).not.toContain('fixture-access-token'); expect(JSON.stringify(state)).not.toContain('fixture-refresh-token');
  const connection = await accounts.importAccount(state[0]!.id); config.connections.push(connection);
  const copy = JSON.parse(await readFile(path.join(home, 'bridge/accounts', connection.id, 'codex/auth.json'), 'utf8'));
  expect(copy.tokens).toEqual(auth.tokens); expect(await readFile(path.join(home, '.codex/auth.json'), 'utf8')).toBe(original);
  expect((await accounts.scan())[0]!.imported).toBe(true); expect((await accounts.importAccount(state[0]!.id)).id).toBe(connection.id);
});
it('uses the Codex credential-store setting and supports the direct system keyring format', async () => {
  const { home, accounts } = await setup(async () => JSON.stringify(auth));
  await atomicWrite(path.join(home, '.codex/config.toml'), 'cli_auth_credentials_store = "keyring"\nmodel_provider = "model_bridge"\n');
  expect((await accounts.scan())[0]).toMatchObject({ kind: 'chatgpt', provider: 'model_bridge', canImport: true });
});
it('cannot import an arbitrary renderer-supplied credential path', async () => {
  const { accounts } = await setup(); await expect(accounts.importAccount('../../unrelated/auth.json')).rejects.toThrow('重新检测');
});
