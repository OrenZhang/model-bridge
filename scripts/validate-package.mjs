import { readdir, stat } from 'node:fs/promises';
import { listPackage } from '@electron/asar';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(process.argv[2] || 'release');
async function archives(dir, depth=0) { const found=[]; if(depth>5)return found;for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isFile()&&e.name==='app.asar')found.push(p);else if(e.isDirectory()&&!['Frameworks','app.asar.unpacked'].includes(e.name))found.push(...await archives(p,depth+1));}return found; }
const [archive]=await archives(root); if(!archive)throw Error('Packaged app.asar not found');
const entries=listPackage(archive);
if(entries.some(p=>/codex-code-mode-host|codex-path[\\/]|codex-resources[\\/]|^[\\/]dist[\\/].*\.map$/.test(p)))throw Error('Unnecessary authentication or debug resources still packaged');
const triples={'darwin-arm64':'aarch64-apple-darwin','darwin-x64':'x86_64-apple-darwin','win32-x64':'x86_64-pc-windows-msvc','linux-x64':'x86_64-unknown-linux-musl','linux-arm64':'aarch64-unknown-linux-musl'};
const key=`${process.platform}-${process.arch}`;
const binary=path.join(archive+'.unpacked','node_modules','@openai',`codex-${key}`,'vendor',triples[key],'bin',process.platform==='win32'?'codex.exe':'codex');
console.log(`Packaged Codex authentication executable: ${(await stat(binary)).size} bytes`);
const child=spawn(process.execPath,['scripts/validate-codex-providers.mjs','--mock-pools'],{stdio:'inherit',env:{...process.env,MODEL_BRIDGE_VALIDATION_CODEX_BINARY:binary}});
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw Error('Packaged Codex integration validation failed');
console.log('PASS: trimmed package preserves Codex app-server, model catalog, multi-turn and tool calls');
