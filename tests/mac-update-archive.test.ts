import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path'; import os from 'node:os';
import { strToU8, zipSync } from 'fflate';
import { validateMacArchive } from '../src/desktop/mac-update-archive.js';
const dirs: string[] = [];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function archive(entries:Record<string,any>) {const dir=await mkdtemp(path.join(os.tmpdir(),'mb-zip-'));dirs.push(dir);const file=path.join(dir,'update.zip');await writeFile(file,zipSync(entries));return file;}
const info = {'Model Bridge.app/Contents/Info.plist':strToU8('fixture')};
const link = (target:string) => [strToU8(target),{os:3,attrs:0xa1ff0000}];
it('accepts a normal app and internal framework symlinks',async()=>{const file=await archive({...info,'Model Bridge.app/Contents/Frameworks/A':strToU8('framework'),'Model Bridge.app/Contents/Frameworks/Current':link('A')});expect(await validateMacArchive(file)).toEqual({entries:3,links:1});});
it.each(['../outside','/absolute','Other.app/file','Model Bridge.app/../outside','Model Bridge.app/Contents/../../outside'])('rejects unsafe entry %s before extracting',async name=>{await expect(validateMacArchive(await archive({...info,[name]:strToU8('x')}))).rejects.toThrow();});
it.each(['/tmp/outside','../../../../outside'])('rejects an escaping link %s',async target=>{await expect(validateMacArchive(await archive({...info,'Model Bridge.app/Contents/link':link(target)}))).rejects.toThrow('符号链接');});
it('rejects link cycles and case-insensitive path collisions',async()=>{
 await expect(validateMacArchive(await archive({...info,'Model Bridge.app/A':link('B'),'Model Bridge.app/B':link('A')}))).rejects.toThrow('循环');
 await expect(validateMacArchive(await archive({...info,'Model Bridge.app/a':strToU8('1'),'Model Bridge.app/A':strToU8('2')}))).rejects.toThrow('冲突');
});
it('rejects incomplete archives and archives without the expected app',async()=>{
 await expect(validateMacArchive(await archive({'Model Bridge.app/file':strToU8('x')}))).rejects.toThrow('应用信息');
 const file=await archive(info);await writeFile(file,'not a ZIP');await expect(validateMacArchive(file)).rejects.toThrow();
});
