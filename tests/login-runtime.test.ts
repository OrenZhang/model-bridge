import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../src/core/store.js';
const helpers=vi.hoisted(()=>new Map<string,any>());
vi.mock('../src/auth/device-login.js',()=>({DeviceLogin:class extends EventEmitter {
  state:any={phase:'idle'};
  constructor(readonly home:string,private connection:any){super();helpers.set(connection.id,this);}
  async login(){this.state={phase:'waiting',method:this.connection.loginMethod};return this.state;}
  async cancel(){this.state={phase:'cancelled'};}
  close(){}
}}));
import { createRuntime } from '../src/core/runtime.js';
const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();helpers.clear();});
it('serializes only browser callback logins while preserving independent account homes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mb-login-runtime-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  await atomicWrite(path.join(dir,'config.json'),JSON.stringify({port:0,connections:['a','b','device'].map(id=>({id,name:id,provider:'openai',auth:'chatgpt-device',loginMethod:id==='device'?'device':'browser',baseUrl:'https://chatgpt.com/backend-api/codex'}))}));
  const runtime=await createRuntime(dir,{get:async()=>undefined},dir);cleanup.push(()=>runtime.close());
  await runtime.startLogin('a');
  await expect(runtime.startLogin('b')).rejects.toThrow('另一个账号');
  expect((await runtime.startLogin('device')).phase).toBe('waiting');
  await runtime.loginFor('a').cancel();
  expect((await runtime.startLogin('b')).phase).toBe('waiting');
  expect(helpers.get('a').home).not.toBe(helpers.get('b').home);
  expect(helpers.get('device').state.phase).toBe('waiting');
});
