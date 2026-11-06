import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawn } from 'node:child_process';import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, chmod, readdir, writeFile } from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';import os from 'node:os';import path from 'node:path';
import { prepareMacUpdate,macUpdateAttempt } from '../src/desktop/mac-updater.js';
const run=promisify(execFile);const cleanup:(()=>Promise<unknown>)[]=[];let template:string;let compiled:string;
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
describe.skipIf(process.platform!=='darwin')('native macOS update transaction',()=>{
 beforeAll(async()=>{template=await mkdtemp(path.join(os.tmpdir(),'mb-native-fixture-'));compiled=path.join(template,'fixture');await run('/usr/bin/cc',['-w','-arch',process.arch==='arm64'?'arm64':'x86_64','-framework','Cocoa','tests/fixtures/mac-update-app.m','-o',compiled]);},20000);
 afterAll(async()=>{if(template)await rm(template,{recursive:true,force:true});});
 async function fixture(mode='ready'){
  const raw=await mkdtemp(path.join(os.tmpdir(),'mb-native-update-'));const root=await realpath(raw);cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const target=path.join(root,'installed','Model Bridge.app'),newApp=path.join(root,'new','Model Bridge.app');const id='io.github.orenzhang.modelbridge.fixture'+randomUUID().replaceAll('-','');
  async function bundle(app:string,version:string,identifier=id){await mkdir(path.join(app,'Contents/MacOS'),{recursive:true});await mkdir(path.join(app,'Contents/Resources'));await copyFile(compiled,path.join(app,'Contents/MacOS/fixture'));await chmod(path.join(app,'Contents/MacOS/fixture'),0o755);await writeFile(path.join(app,'Contents/Resources/mode.txt'),mode);await writeFile(path.join(app,'Contents/Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>Model Bridge update fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>`);}
  await bundle(target,'0.1.0-alpha.1');await bundle(newApp,'0.1.0-alpha.2');
  const archive=path.join(root,'payload.zip');await run('/usr/bin/ditto',['-c','-k','--keepParent',newApp,archive]);
  const sha512=createHash('sha512').update(await readFile(archive)).digest('base64');
  const updatesDirectory=path.join(root,'data','updates');await mkdir(path.dirname(updatesDirectory),{recursive:true});const config=path.join(root,'data','config.json');await writeFile(config,'account fixture must remain unchanged');
  const old=spawn('/bin/sleep',['60']);const oldClosed=new Promise(resolve=>old.once('close',resolve));cleanup.push(async()=>{old.kill();await oldClosed;});
  const options={archive,sha512,version:'0.1.0-alpha.2',currentVersion:'0.1.0-alpha.1',currentApp:target,updatesDirectory,applicationId:id,pid:old.pid!,helperDirectory:path.resolve('dist/desktop'),startupTimeoutSeconds:5};
  async function killFixture(dir:string){for(const name of ['launched','old-restarted'])try{const contents=await readFile(path.join(dir,name),'utf8');const pid=Number(contents.split('\n')[1]);if(pid>1)process.kill(pid,'SIGTERM');}catch{}}
  return{root,target,config,options,stopOld:async()=>{old.kill();await oldClosed;},registerCleanup:(directory:string)=>cleanup.push(()=>killFixture(directory))};
 }
 it('waits for quit, atomically replaces the app, restarts it and preserves user data',async()=>{
  const f=await fixture();const prepared=await prepareMacUpdate(f.options);f.registerCleanup(prepared.directory);
  await prepared.start();expect(await readFile(path.join(f.target,'Contents/Info.plist'),'utf8')).toContain('0.1.0-alpha.1');
  await f.stopOld();await vi.waitFor(async()=>expect(JSON.parse(await readFile(path.join(prepared.directory,'state.json'),'utf8')).phase).toBe('success'),{timeout:15000,interval:100});
  expect(await readFile(path.join(f.target,'Contents/Info.plist'),'utf8')).toContain('0.1.0-alpha.2');expect(await readFile(f.config,'utf8')).toBe('account fixture must remain unchanged');
 },20000);
 it('restores and relaunches the original app when the new startup reports failure',async()=>{
  const f=await fixture('fail');const prepared=await prepareMacUpdate(f.options);f.registerCleanup(prepared.directory);await prepared.start();await f.stopOld();
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(path.join(prepared.directory,'state.json'),'utf8')).phase).toBe('rolled-back'),{timeout:15000,interval:100});
  await vi.waitFor(async()=>expect(await readFile(path.join(prepared.directory,'old-restarted'),'utf8')).toContain(prepared.job.token),{timeout:10000,interval:100});
  expect(await readFile(path.join(f.target,'Contents/Info.plist'),'utf8')).toContain('0.1.0-alpha.1');expect(await readFile(f.config,'utf8')).toBe('account fixture must remain unchanged');
 },25000);
 it('rolls back a hung startup after the deadline and restarts the original app',async()=>{
  const f=await fixture('hang');const prepared=await prepareMacUpdate({...f.options,startupTimeoutSeconds:1});f.registerCleanup(prepared.directory);await prepared.start();await f.stopOld();
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(path.join(prepared.directory,'state.json'),'utf8')).phase).toBe('rolled-back'),{timeout:15000,interval:100});
  await vi.waitFor(async()=>expect(await readFile(path.join(prepared.directory,'old-restarted'),'utf8')).toContain(prepared.job.token),{timeout:10000,interval:100});
  expect(await readFile(path.join(f.target,'Contents/Info.plist'),'utf8')).toContain('0.1.0-alpha.1');
 },25000);
 it('rejects the wrong version or CPU architecture without replacing the current app',async()=>{
  const f=await fixture();await expect(prepareMacUpdate({...f.options,version:'9.0.0'})).rejects.toThrow('版本不匹配');
  await expect(prepareMacUpdate({...f.options,arch:process.arch==='arm64'?'x64':'arm64'})).rejects.toThrow('架构不匹配');
  expect(await readFile(path.join(f.target,'Contents/Info.plist'),'utf8')).toContain('0.1.0-alpha.1');
 });
 it('rejects corrupted packages and unwritable install directories before starting a helper',async()=>{
  const f=await fixture();await expect(prepareMacUpdate({...f.options,sha512:'invalid'})).rejects.toThrow('校验');
  const parent=path.dirname(f.target);await chmod(parent,0o555);try{await expect(prepareMacUpdate(f.options)).rejects.toThrow('不可写');}finally{await chmod(parent,0o700);}
  expect((await readdir(parent)).filter(n=>n.startsWith('.model-bridge-update-'))).toEqual([]);
 });
 it('binds startup confirmation to the private job, nonce, app path and version',async()=>{
  const f=await fixture();const prepared=await prepareMacUpdate(f.options);cleanup.push(()=>prepared.discard());await writeFile(path.join(prepared.directory,'state.json'),JSON.stringify({phase:'awaiting-startup'}));
  expect(await macUpdateAttempt(['--model-bridge-update',prepared.directory,'wrong'],f.options.updatesDirectory,f.target,'0.1.0-alpha.2')).toBeUndefined();
  expect(await macUpdateAttempt(['--model-bridge-update',prepared.directory,prepared.job.token],f.options.updatesDirectory,f.target,'0.1.0-alpha.1')).toBeUndefined();
  const attempt=await macUpdateAttempt(['--model-bridge-update',prepared.directory,prepared.job.token],f.options.updatesDirectory,f.target,'0.1.0-alpha.2');expect(attempt).toBeDefined();await attempt!.ready();expect(await readFile(path.join(prepared.directory,'ready'),'utf8')).toBe(prepared.job.token);
 });
});
