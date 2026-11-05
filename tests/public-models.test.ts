import { expect, it } from 'vitest';
import { ConfigSchema, resolveRoute } from '../src/core/config.js';
import { publicModelRoutes, poolCandidates, modelGroupId } from '../src/core/model-pool.js';
import { PoolRouter } from '../src/gateway/pool-router.js';
import { ReasoningVault } from '../src/gateway/reasoning.js';
const config=()=>ConfigSchema.parse({connections:[{id:'official',name:'ChatGPT',provider:'openai',auth:'chatgpt-device',baseUrl:'https://chatgpt.com/backend-api/codex',models:[{id:'gpt',name:'GPT',upstreamId:'gpt-test',protocols:['responses']}]},{id:'paid',name:'API',provider:'openai',auth:'api-key',baseUrl:'https://api.openai.com/v1',models:[{id:'gpt',name:'GPT API',upstreamId:'gpt-test',protocols:['responses']}]}]});
it('offers natural names with readable collision suffixes and retains legacy routes',()=>{
  const c=config();const routes=publicModelRoutes(c);
  expect(routes.map(r=>r.id)).toEqual(['gpt-test','gpt-test~openai-api-key']);
  expect(resolveRoute(c,'gpt-test').connection.id).toBe('official');
  expect(resolveRoute(c,'gpt-test~openai-api-key').connection.id).toBe('paid');
  expect(resolveRoute(c,'official/gpt').connection.id).toBe('official');
  c.connections.reverse();expect(publicModelRoutes(c).find(r=>r.connection.id==='official')!.id).toBe('gpt-test');
  c.connections.find(r=>r.id==='official')!.models[0]!.enabled=false;
  expect(()=>resolveRoute(c,'gpt-test')).toThrow('unavailable');
  expect(publicModelRoutes(c).map(r=>r.id)).toEqual(['gpt-test~openai-api-key']);
});
it('uses the same persistent pool binding for natural names and old pool identifiers',async()=>{
  const c=config();c.connections=[c.connections[0]!,{...structuredClone(c.connections[0]!),id:'second'}];
  const route=publicModelRoutes(c)[0]!;expect(route.id).toBe('gpt-test');
  const candidates=poolCandidates(c,route.id)!;expect(candidates).toHaveLength(2);
  const pool=modelGroupId(route.connection,route.model);expect(poolCandidates(c,pool)).toEqual(candidates);
  const router=new PoolRouter();const vault=new ReasoningVault();
  const first=await router.select(pool,candidates,{input:'hello'},'client','responses',vault,'session');
  expect((await router.select(pool,poolCandidates(c,pool)!,{input:[{role:'assistant',content:'history'}]},'client','responses',vault,'session')).connection.id).toBe(first.connection.id);
});
it('never assigns a public name that shadows a different legacy route',()=>{
  const c=config();c.connections[1]!.models[0]!.upstreamId='official/gpt';
  expect(publicModelRoutes(c)[1]!.id).not.toBe('official/gpt');
  expect(resolveRoute(c,'official/gpt').connection.id).toBe('official');
});
