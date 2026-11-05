import {spawn} from'node:child_process';import{mkdtemp,readFile,stat,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{setTimeout as delay}from'node:timers/promises';
if(process.platform!=='linux')throw new Error('This smoke test requires Linux.');
const dir=await mkdtemp(path.join(os.tmpdir(),'model-bridge-linux-'));const binary=path.resolve('release',process.arch==='arm64'?'linux-arm64-unpacked':'linux-unpacked','model-bridge');
let stderr='';let desktopReady=false;const child=spawn(binary,['--no-sandbox'],{env:{...process.env,MODEL_BRIDGE_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});const closed=new Promise(resolve=>{child.on('close',resolve);child.on('error',e=>{stderr+=e.message;resolve(-1)})});child.stdout.on('data',data=>{if(data.toString().includes('Model Bridge desktop ready'))desktopReady=true;});child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-8000)});
try{
 let ready=false;const deadline=Date.now()+45000;
 while(Date.now()<deadline&&child.exitCode===null){
  try{const config=JSON.parse(await readFile(path.join(dir,'config.json'),'utf8'));const encrypted=await stat(path.join(dir,'credentials.enc'));if(desktopReady&&config.clients?.length===3&&encrypted.size>64){const response=await fetch('http://127.0.0.1:18765/healthz',{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break}}}catch{}
  await delay(250);
 }
 if(!ready)throw new Error('Linux desktop did not initialize its encrypted credential vault and gateway. '+stderr);
 console.log(JSON.stringify({platform:process.platform,arch:process.arch,desktopStarted:true,encryptedVaultInitialized:true,localGatewayHealthy:true}));
}finally{
 if(child.exitCode===null)child.kill('SIGTERM');let done=false;void closed.then(()=>{done=true});await Promise.race([closed,delay(5000)]);if(!done){child.kill('SIGKILL');await closed}await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
