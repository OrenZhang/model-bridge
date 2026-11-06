import { expect, it } from 'vitest';
import { ConfigSchema, ConnectionSchema } from '../src/core/config.js';
import { networkBinding } from '../src/core/network-binding.js';
it('unrelated subscription updates never change a direct, system or independent-proxy login binding',()=>{
 const config=ConfigSchema.parse({networkProfiles:[{id:'subscription',name:'Subscription',source:'config',nodes:['a','b'],selected:'a',secretRef:'private',updatedAt:'old'}],proxies:[{id:'independent',name:'Independent',url:'http://127.0.0.1:7890'}]});
 for(const proxy of [{mode:'direct'},{mode:'system'},{mode:'proxy',profileId:'independent'}] as const){const c=ConnectionSchema.parse({id:'account',name:'Account',provider:'openai',baseUrl:'https://api.openai.com/v1',proxy});const before=networkBinding(config,c);config.networkProfiles[0]!.selected='b';config.networkProfiles[0]!.updatedAt='new';expect(networkBinding(config,c)).toEqual(before);}
 const c=ConnectionSchema.parse({id:'bound',name:'Bound',provider:'openai',baseUrl:'https://api.openai.com/v1',proxy:{mode:'managed',profileId:'subscription'}});const before=structuredClone(networkBinding(config,c));config.networkProfiles[0]!.selected='a';expect(networkBinding(config,c)).not.toEqual(before);
});
