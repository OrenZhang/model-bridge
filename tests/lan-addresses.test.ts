import { expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { lanAddressList } from '../src/network/lan-addresses.js';
import { serviceAddresses, preferredServiceAddress } from '../src/shared/service-addresses.js';
const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({address,internal,family:'IPv4',netmask:'255.255.255.0',mac:'00:00:00:00:00:00',cidr:address+'/24'});
it('names adapters, recommends the active physical LAN and places virtual interfaces last',()=>{
 const list=lanAddressList({'vEthernet (WSL)':[ipv4('172.26.192.1')],Ethernet:[ipv4('192.168.1.20')],'Wi-Fi':[ipv4('10.11.40.160')],lo:[ipv4('127.0.0.1',true)],unconfigured:[ipv4('169.254.1.2')]},18765,'10.11.40.160');
 expect(list.map(item=>item.ip)).toEqual(['10.11.40.160','192.168.1.20','172.26.192.1']);expect(list[0]).toMatchObject({name:'Wi-Fi',recommended:true,virtual:false});expect(list[2]!.virtual).toBe(true);
 const state={address:'http://127.0.0.1:18765',lanInterfaces:list};
 expect(preferredServiceAddress(state)).toBe('http://10.11.40.160:18765');
 expect(serviceAddresses(state).map(item=>item.address)).toEqual([list[0]!.address,list[1]!.address,state.address,list[2]!.address]);
 expect(serviceAddresses(state).at(-1)!.label).toContain('vEthernet (WSL) · 虚拟网卡');
});
it('prefers physical LAN over a VPN default route without guessing from the IP subnet',()=>{
 const list=lanAddressList({Ethernet:[ipv4('172.26.192.2')],tun0:[ipv4('10.0.0.2')]},18765,'10.0.0.2');
 expect(list[0]).toMatchObject({ip:'172.26.192.2',virtual:false,recommended:true});
});
it('uses OS adapter metadata and falls back gracefully when only virtual or local addresses exist',()=>{
 const list=lanAddressList({en0:[ipv4('192.168.1.2')],Ethernet:[ipv4('10.0.0.1')]},1234,'10.0.0.1',[{name:'en0',displayName:'Wi-Fi (en0)',virtual:false},{name:'Ethernet',virtual:true}]);
 expect(list[0]!.displayName).toBe('Wi-Fi (en0)');expect(list[1]!.virtual).toBe(true);
 expect(preferredServiceAddress({address:'http://127.0.0.1:1234',lanInterfaces:[]})).toBe('http://127.0.0.1:1234');
 expect(lanAddressList({tun0:[ipv4('10.0.0.1')]},1234)[0]!.recommended).toBe(true);
 expect(lanAddressList({Ethernet:[ipv4('10.0.0.1')]},1234,undefined,[{name:'Ethernet',active:false}])).toEqual([]);
});
