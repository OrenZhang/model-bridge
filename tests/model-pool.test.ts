import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigSchema } from '../src/core/config.js';
import { catalogRoutes, modelGroups, reasoningScope } from '../src/core/model-pool.js';
import { PoolRouter } from '../src/gateway/pool-router.js';
import { ReasoningVault } from '../src/gateway/reasoning.js';
import { codexCatalog } from '../src/core/catalog.js';
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
function config() { return ConfigSchema.parse({ connections: ['a', 'b'].map(id => ({ id, name: id, provider: 'kimi', auth: 'none', baseUrl: 'https://same.invalid/v1', models: [{ id: 'local', name: 'Same model', upstreamId: 'same', protocols: ['chat'] }] })) }); }
function fixture() { const c = config(); const [id, candidates] = [...modelGroups(c)][0]!; return { config: c, id, candidates, vault: new ReasoningVault() }; }
it('groups only compatible accounts; never double weights the same verified identity', () => {
  const c = config(); expect(catalogRoutes(c)).toHaveLength(1); expect(catalogRoutes(c)[0]!.accounts).toBe(2);
  c.connections[1]!.models[0]!.images = true; expect(catalogRoutes(c)).toHaveLength(2);
  c.connections[1]!.models[0]!.images = false; c.connections[1]!.baseUrl = 'https://different.invalid/v1'; expect(catalogRoutes(c)).toHaveLength(2);
  c.connections[1]!.baseUrl = c.connections[0]!.baseUrl; c.connections.forEach(c => { c.accountId = 'same-workspace'; c.accountEmail = 'same@example.invalid'; });
  expect(catalogRoutes(c)[0]!.accounts).toBe(1);
  c.connections[1]!.accountEmail='another@example.invalid'; expect(catalogRoutes(c)[0]!.accounts).toBe(2);
});
it('advertises client discovery for translated channels but not unknown native Responses implementations',()=>{
  const c=config();expect(codexCatalog(c).models[0]!.supports_search_tool).toBe(true);
  c.connections[1]!.upstreamProtocols=['responses'];expect(codexCatalog(c).models[0]!.supports_search_tool).toBe(false);
});
it('round robins concurrent independent conversations and pins their continuations', async () => {
  const { id, candidates, vault } = fixture(); const router = new PoolRouter();
  const routes = await Promise.all(Array.from({length:20}, (_,n) => router.select(id,candidates,{input:'Same initial prompt'},'client','responses',vault,`session-${n}`)));
  expect(routes.map(r=>r.connection.id)).toEqual(Array.from({length:20}, (_,n)=>n%2?'b':'a'));
  for (let n=0;n<20;n++) expect((await router.select(id,candidates,{input:[{role:'assistant',content:'tool continuation'}]},'client','responses',vault,`session-${n}`)).connection.id).toBe(routes[n]!.connection.id);
});
it('persists bindings across restart without saving prompts, session IDs, or tokens', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'mb-pool-')); directories.push(dir); const file=path.join(dir,'pool-routing.json');
  const { id,candidates,vault }=fixture(); const first=await new PoolRouter(file).load();
  const selected=await first.select(id,candidates,{input:'private prompt'},'client','responses',vault,'private-session');
  const restored=await new PoolRouter(file).load();
  expect((await restored.select(id,candidates,{input:[{role:'assistant',content:'continuation'}]},'client','responses',vault,'private-session')).connection.id).toBe(selected.connection.id);
  const saved=await readFile(file,'utf8'); expect(saved).not.toContain('private prompt'); expect(saved).not.toContain('private-session');
  expect((await restored.select(id,candidates,{input:'new'},'client','responses',vault,'new-session')).connection.id).toBe('b');
  await expect(restored.select(id,candidates.filter(r=>r.connection.id!=='a'),{input:'private prompt'},'client','responses',vault,'private-session')).rejects.toMatchObject({code:'pool_account_unavailable'});
});
it('recovers original thinking account, rejects tampering and other clients, and never silently changes accounts', async () => {
  const {id,candidates,vault}=fixture(); const router=new PoolRouter();
  const original=candidates[1]!; const token=vault.context(reasoningScope('client',original),'chat','kimi','same').seal({protocol:'chat',value:{reasoning_content:'signed reasoning'}});
  const input={input:[{role:'user',content:'history'},{type:'reasoning',encrypted_content:token}]};
  expect((await router.select(id,candidates,input,'client','responses',vault)).connection.id).toBe('b');
  await expect(router.select(id,candidates,input,'other-client','responses',vault)).rejects.toMatchObject({code:'invalid_reasoning_state'});
  await expect(router.select(id,[candidates[0]!],input,'client','responses',vault)).rejects.toMatchObject({code:'pool_account_unavailable'});
  await expect(new PoolRouter().select(id,candidates,{input:[{role:'assistant',content:'old native history'}]},'client','responses',vault,'unrecognized')).rejects.toMatchObject({code:'pool_history_unbound'});
});
it('keeps pinned accounts on rate limits and excludes unavailable accounts for new conversations', async () => {
  const {id,candidates,vault}=fixture(); const router=new PoolRouter();
  await router.select(id,candidates,{input:'one'},'client','responses',vault,'one');
  router.rejected('a',429,'60');
  expect((await router.select(id,candidates,{input:'two'},'client','responses',vault,'two')).connection.id).toBe('b');
  await expect(router.select(id,candidates,{input:'one'},'client','responses',vault,'one')).rejects.toMatchObject({code:'pool_account_cooling_down'});
  router.rejected('b',401);
  await expect(router.select(id,candidates,{input:'three'},'client','responses',vault,'three')).rejects.toMatchObject({code:'pool_accounts_cooling_down'});
});
it.each(['tool_search_call','tool_search_output','web_search_call'])('does not treat unbound %s history as a new conversation',async type=>{
  const {id,candidates,vault}=fixture();
  await expect(new PoolRouter().select(id,candidates,{input:[{role:'user',content:'old question'},{type,call_id:'original-call'}]},'client','responses',vault,'unknown-session')).rejects.toMatchObject({code:'pool_history_unbound'});
});
it('separates client affinity and rejects changed account identities', async () => {
  const {id,candidates,vault}=fixture(); const router=new PoolRouter();
  expect((await router.select(id,candidates,{input:'same'},'one','responses',vault,'session')).connection.id).toBe('a');
  expect((await router.select(id,candidates,{input:'same'},'two','responses',vault,'session')).connection.id).toBe('b');
  candidates[0]!.connection.accountId='new-person';
  await expect(router.select(id,candidates,{input:'same'},'one','responses',vault,'session')).rejects.toMatchObject({code:'pool_account_unavailable'});
});

it('recognizes native continuations when plain user text becomes a content block', async () => {
  const {id,candidates,vault}=fixture(); const router=new PoolRouter();
  const first=await router.select(id,candidates,{input:'hello'},'client','responses',vault);
  const next=await router.select(id,candidates,{input:[{role:'user',content:[{type:'input_text',text:'hello'}]},{role:'assistant',content:'prior reply'}]},'client','responses',vault);
  expect(next.connection.id).toBe(first.connection.id);
});

it('refuses to continue an account pool conversation after replacing its API credential', async () => {
  const {id,candidates,vault}=fixture(); const router=new PoolRouter();
  await router.select(id,candidates,{input:'initial'},'client','responses',vault,'key-change');
  candidates[0]!.connection.credentialVersion='replacement-key-revision';
  await expect(router.select(id,candidates,{input:'initial'},'client','responses',vault,'key-change')).rejects.toMatchObject({code:'pool_account_unavailable'});
});
