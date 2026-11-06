import {execFile} from 'node:child_process';import{promisify}from'node:util';import{mkdir,chmod}from'node:fs/promises';
if(process.platform==='darwin'){
 await mkdir('dist/desktop',{recursive:true});
 await promisify(execFile)('/usr/bin/cc',['-O2','-Wall','-Wextra','-Werror','-arch','arm64','-arch','x86_64','-mmacosx-version-min=12.0','src/native/mac-update-helper.c','-o','dist/desktop/mac-update-helper']);
 await chmod('dist/desktop/mac-update-helper',0o755);
}
