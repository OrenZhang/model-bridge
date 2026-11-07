#!/usr/bin/env node
// Synthetic local benchmark. Never loads real accounts, keys or client settings.
// Run with Node 22 after npm run build. These are not live-provider/LAN timings.
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {ConfigSchema} from '../dist/core/config.js';
import {PoolRouter} from '../dist/gateway/pool-router.js';
import {ReasoningVault} from '../dist/gateway/reasoning.js';
import {decodeRequest,encodeRequest} from '../dist/gateway/codec.js';

const root=await mkdtemp(path.join(os.tmpdir(),'model-bridge-routing-benchmark-'));
const vault=new ReasoningVault();
const config=ConfigSchema.parse({connections:Array.from({length:8},(_,i)=>({id:'synthetic-'+i,name:'Synthetic',provider:'custom',auth:'none',baseUrl:'https://example.invalid/v1',models:[{id:'fixture',name:'Fixture',upstreamId:'fixture',protocols:['chat']}]}))});
const candidates=config.connections.map(connection=>({connection,model:connection.models[0]}));
function summary(values){const sorted=[...values].sort((a,b)=>a-b);return Object.fromEntries([['p50',.5],['p95',.95],['p99',.99]].map(([name,p])=>[name,Number(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))].toFixed(3))]));}
const results=[];
try{
 for(const durable of [false,true])for(const existingBindings of [0,1000,5000])for(const concurrency of [1,16]){
  const file=path.join(root,randomBytes(6).toString('hex')+'.json');
  const bindings=Object.fromEntries(Array.from({length:existingBindings},(_,i)=>['synthetic-existing-'+i,{connectionId:'synthetic-0',fingerprint:'fixture',updatedAt:Date.now()}]));
  if(durable)await writeFile(file,JSON.stringify({version:1,cursor:{},bindings}),{mode:0o600});
  // The memory case deliberately has no old bindings: it isolates hot-path cost.
  if(!durable&&existingBindings)continue;
  const router=await new PoolRouter(durable?file:undefined).load();const samples=[];
  const started=performance.now();let counter=0;
  for(let batch=0;batch<128/concurrency;batch++)await Promise.all(Array.from({length:concurrency},async()=>{
   const id='synthetic-session-'+counter++;const begin=performance.now();
   await router.select('synthetic-pool',candidates,{input:'Synthetic question '+id},'synthetic-client','responses',vault,id);
   samples.push(performance.now()-begin);
  }));
  results.push({kind:'routing-only',durable,existingBindings,concurrency,samples:samples.length,milliseconds:summary(samples),operationsPerSecond:Number((samples.length/((performance.now()-started)/1000)).toFixed(1))});
 }
 const source=JSON.stringify({input:Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:'Synthetic conversation text. '.repeat(100)})),tools:Array.from({length:12},(_,i)=>({type:'function',name:'fixture_'+i,parameters:{type:'object',properties:{query:{type:'string'}}}}))});
 for(const target of ['chat','messages']){
  const samples=[];
  for(let i=0;i<550;i++){const begin=performance.now();JSON.stringify(encodeRequest(target,decodeRequest('responses',JSON.parse(source)),'fixture'));if(i>=50)samples.push(performance.now()-begin);}
  results.push({kind:'request-conversion-only',source:'responses',target,inputBytes:Buffer.byteLength(source),samples:samples.length,milliseconds:summary(samples)});
 }
 process.stdout.write(JSON.stringify({createdAt:new Date().toISOString(),runtime:process.version,platform:os.platform(),arch:os.arch(),cpus:os.cpus()[0]?.model,synthetic:true,notes:'Routing includes queued selection and atomic file replacement where durable=true. Conversion excludes response/SSE handling. Neither includes provider, HTTP, LAN or search latency; results are not an end-to-end SLA.',results},null,2)+'\n');
}finally{await rm(root,{recursive:true,force:true});}
