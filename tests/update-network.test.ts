import { expect, it } from 'vitest';
import { updateProxyRules, updateProxyRoute, environmentUpdateProxies, chooseUpdateProxy } from '../src/desktop/update-network.js';
it('detects supported system and PAC proxy routes without exposing credentials', () => {
  expect(updateProxyRules('PROXY 127.0.0.1:7890; DIRECT')).toBe('http://127.0.0.1:7890');
  expect(updateProxyRules('SOCKS5 localhost:1080')).toBe('socks5://localhost:1080');
  expect(updateProxyRules('DIRECT')).toBeUndefined();
  expect(updateProxyRules('PROXY user:password@example.com:7890')).toBeUndefined();
});
it('keeps proxy passwords out of Chromium rules and decodes them only for proxy authentication', () => {
  expect(updateProxyRoute('http://mb:encoded%40pass@127.0.0.1:17890')).toEqual({rules:'http://127.0.0.1:17890',host:'127.0.0.1',port:17890,username:'mb',password:'encoded@pass'});
  expect(() => updateProxyRoute('https://example.com/path')).toThrow();
  expect(environmentUpdateProxies({HTTPS_PROXY:'http://127.0.0.1:7890',HTTP_PROXY:'http://127.0.0.1:7890',ALL_PROXY:'file:///tmp/proxy'})).toEqual([{url:'http://127.0.0.1:7890',label:'环境代理'}]);
});
it('skips failed proxies, chooses a working route and cancels pending probes', async () => {
  const candidates = ['failed','working','pending'].map(label=>({url:'http://'+label+':7890',label}));let cancelled=false;
  const selected=await chooseUpdateProxy(candidates,async(c,signal)=>{
    if(c.label==='failed')return false;
    if(c.label==='working'){await new Promise(r=>setTimeout(r,10));return true;}
    return new Promise(resolve=>signal.addEventListener('abort',()=>{cancelled=true;resolve(false)},{once:true}));
  });
  expect(selected?.label).toBe('working');expect(cancelled).toBe(true);
  expect(await chooseUpdateProxy(candidates,async()=>false)).toBeUndefined();
});
