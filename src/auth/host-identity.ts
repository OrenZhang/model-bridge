import { arch, platform, release } from 'node:os';
export function coSailHeaders(deviceId:string, kimi=true):Record<string,string>{
 const name=platform()==='darwin'?'macOS':platform()==='win32'?'Windows':'Linux';
 return {'user-agent':'CoSail/0.1.0',...(kimi?{'X-Msh-Platform':'cosail','X-Msh-Version':'0.1.0','X-Msh-Device-Name':'CoSail','X-Msh-Device-Model':`${name} ${arch()}`,'X-Msh-Os-Version':release(),'X-Msh-Device-Id':deviceId}:{})};
}
