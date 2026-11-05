import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../src/core/runtime.js';
import { ConfigStore } from '../src/core/store.js';
import { managedModels } from '../src/core/catalog.js';
import { connectionState } from '../src/ui/connection-state.js';
import { ConfigSchema } from '../src/core/config.js';
const cleanup: (()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it('defaults to exposed, keeps hidden models editable, and excludes them from every exported catalog and direct route',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mb-exposure-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const store=await new ConfigStore(dir).load();
  await store.save({port:0,connections:['a','b'].map(id=>({id,name:id,provider:'custom',auth:'none',baseUrl:'https://provider.invalid/v1',models:[{id:'shared',name:'Shared',upstreamId:'shared',protocols:['chat']},...(id==='a'?[{id:'other',name:'Other',upstreamId:'other',protocols:['chat']}]:[])]}))});
  const values=new Map<string,string>();const runtime=await createRuntime(dir,{get:async r=>values.get(r),set:async(r,v)=>{values.set(r,v);}},dir);cleanup.push(()=>runtime.close());
  const token=await runtime.ensureClient('codex');const headers={authorization:'Bearer '+token};
  const entry=managedModels(runtime.store.get()).find(m=>m.model.upstreamId==='shared')!;
  expect(entry.enabled).toBe(true);expect(entry.exposedAccounts).toBe(2);
  await runtime.setModelExposure(entry.id,false);
  const admin=managedModels(runtime.store.get()).find(m=>m.id===entry.id)!;expect(admin.enabled).toBe(false);expect(admin.members).toHaveLength(2);
  const openai:any=await(await fetch(runtime.gateway.address+'/v1/models',{headers})).json();expect(openai.data.map((m:any)=>m.id)).toEqual(['other']);
  const anthropic:any=await(await fetch(runtime.gateway.address+'/v1/models',{headers:{...headers,'anthropic-version':'2023-06-01'}})).json();expect(anthropic.data.map((m:any)=>m.id)).toEqual(['other']);
  const codex:any=await(await fetch(runtime.gateway.address+'/codex/models',{headers})).json();expect(codex.models.map((m:any)=>m.slug)).toEqual(['other']);
  const portable=runtime.clients.portable('codex',runtime.store.get(),runtime.gateway.address,token);expect(JSON.parse(portable.catalog!).models.map((m:any)=>m.slug)).toEqual(['other']);
  for(const route of[entry.id,'a/shared','b/shared']){const r=await fetch(runtime.gateway.address+'/v1/responses',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model:route,input:'test'})});expect(r.status).toBe(404);}
  await runtime.setModelExposure(entry.id,true);expect(managedModels(runtime.store.get()).find(m=>m.id===entry.id)!.exposedAccounts).toBe(2);
  await runtime.store.update(c=>{c.connections[1]!.models[0]!.enabled=false;});expect(managedModels(runtime.store.get()).find(m=>m.id===entry.id)!.mixed).toBe(true);
  await runtime.setModelExposure(entry.id,true);expect(runtime.store.get().connections.every(c=>c.models.every(m=>m.enabled))).toBe(true);
});
it('includes repeated imports of the same account when hiding a model',()=>{
  const config=ConfigSchema.parse({connections:['a','b'].map(id=>({id,name:id,provider:'custom',auth:'none',baseUrl:'https://provider.invalid/v1',accountId:'same',accountEmail:'fixture@example.invalid',models:[{id:'shared',name:'Shared',upstreamId:'shared',protocols:['chat']}]}))});
  const entry=managedModels(config)[0]!;
  expect(entry.members).toHaveLength(2);
  for(const member of entry.members)member.model.enabled=false;
  expect(config.connections.every(c=>c.models.every(m=>!m.enabled))).toBe(true);
});
it('marks successful authorization/sync green, failures red, and pending/disabled connections neutral',()=>{
  const c={auth:'subscription',enabled:true,models:[]};
  expect(connectionState(c,{phase:'authenticated'}).tone).toBe('success');
  expect(connectionState(c,{phase:'error'}).tone).toBe('error');
  expect(connectionState(c,undefined,{phase:'error'}).tone).toBe('error');
  expect(connectionState(c,undefined,{phase:'ready'},{phase:'error',message:'fixture'}).tone).toBe('error');
  expect(connectionState(c,undefined,{phase:'error'},{phase:'ready'}).tone).toBe('success');
  expect(connectionState(c,{phase:'waiting'}).tone).toBe('pending');
  expect(connectionState({...c,enabled:false},{phase:'error'}).tone).toBe('neutral');
});
