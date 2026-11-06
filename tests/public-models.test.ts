import { expect, it } from 'vitest';
import { ConfigSchema, resolveRoute } from '../src/core/config.js';
import { publicModelRoutes, poolCandidates, modelGroupId, mergedModelId } from '../src/core/model-pool.js';
import { PoolRouter } from '../src/gateway/pool-router.js';
import { ReasoningVault } from '../src/gateway/reasoning.js';
const config=()=>ConfigSchema.parse({connections:[{id:'official',name:'ChatGPT',provider:'openai',auth:'chatgpt-device',baseUrl:'https://chatgpt.com/backend-api/codex',models:[{id:'gpt',name:'GPT',upstreamId:'gpt-test',protocols:['responses'],reasoning:['low','high']}]},{id:'paid',name:'API',provider:'custom',auth:'api-key',baseUrl:'https://proxy.invalid/v1',models:[{id:'gpt',name:'GPT API',upstreamId:'gpt-test',protocols:['chat']}]}]});
it('merges exactly the same model ID across providers, auth types and addresses without suffixes',()=>{
  const c=config();const routes=publicModelRoutes(c);
  expect(routes.map(r=>r.id)).toEqual(['gpt-test']);expect(routes[0]!.members).toHaveLength(2);
  expect(resolveRoute(c,'official/gpt').connection.id).toBe('official');
  c.connections.find(r=>r.id==='official')!.models[0]!.enabled=false;
  expect(publicModelRoutes(c).map(r=>r.id)).toEqual(['gpt-test']);expect(poolCandidates(c,'gpt-test')!.map(r=>r.connection.id)).toEqual(['paid']);
  c.connections[1]!.enabled=false;expect(()=>resolveRoute(c,'gpt-test')).toThrow('unavailable');
});
it('does not resolve a globally hidden model name through a conflicting legacy route',()=>{
 const c=config();c.hiddenModels=['official/gpt'];
 expect(poolCandidates(c,'official/gpt')).toBeUndefined();
 expect(()=>resolveRoute(c,'official/gpt')).toThrow('unavailable');
 expect(resolveRoute(c,'gpt-test').model.upstreamId).toBe('gpt-test');
});
it('balances merged channels, preserves affinity and migrates existing pool bindings',async()=>{
  const c=config();const route=publicModelRoutes(c)[0]!;const candidates=poolCandidates(c,route.id)!;
  const router=new PoolRouter();const vault=new ReasoningVault();const old=modelGroupId(candidates[0]!.connection,candidates[0]!.model);
  await router.select(old,[candidates[0]!],{input:'hello'},'client','responses',vault,'existing');
  await router.select(old,[candidates[0]!],{input:'hello'},'client','responses',vault,'removed-before-upgrade');
  const pool=mergedModelId(route.id);
  await expect(router.select(pool,[candidates[1]!],{input:'compacted user turn'},'client','responses',vault,'removed-before-upgrade',[old])).rejects.toMatchObject({code:'pool_account_unavailable'});
  expect((await router.select(pool,candidates,{input:[{role:'assistant',content:'history'}]},'client','responses',vault,'existing',[old])).connection.id).toBe('official');
  const selected=await Promise.all(Array.from({length:8},(_,n)=>router.select(pool,candidates,{input:'hello'},'client','responses',vault,`new-${n}`)));
  expect(selected.map(r=>r.connection.id)).toEqual(['official','paid','official','paid','official','paid','official','paid']);
  router.rejected('official',429,'60');
  expect((await router.select(pool,candidates,{input:'hello'},'client','responses',vault,'available')).connection.id).toBe('paid');
  await expect(router.select(pool,candidates,{input:'hello'},'client','responses',vault,'new-0')).rejects.toMatchObject({code:'pool_account_cooling_down'});
});
it('selects a channel with requested capabilities and never moves a pinned conversation to add capabilities',async()=>{
  const c=config();c.connections[0]!.models[0]!.images=true;c.connections[1]!.models[0]!.tools=false;
  const candidates=poolCandidates(c,'gpt-test')!;const router=new PoolRouter();const vault=new ReasoningVault();const pool=mergedModelId('gpt-test');
  const input={input:[{role:'user',content:[{type:'input_image',image_url:'https://image.invalid/a.png'}]}],tools:[{type:'function',name:'probe'}]};
  expect((await router.select(pool,candidates,input,'c','responses',vault,'image')).connection.id).toBe('official');
  expect((await router.select(pool,candidates,{input:'first'},'c','responses',vault,'b')).connection.id).toBe('paid');
  await expect(router.select(pool,candidates,input,'c','responses',vault,'b')).rejects.toMatchObject({code:'model_capability_unavailable'});
  c.connections[0]!.enabled=false;
  await expect(router.select(pool,poolCandidates(c,'gpt-test')!,{input:'continue'},'c','responses',vault,'image')).rejects.toMatchObject({code:'pool_account_unavailable'});
});
