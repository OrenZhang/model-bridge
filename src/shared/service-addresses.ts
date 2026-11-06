export type ServiceAddress = { address: string; label: string; recommended?: boolean; virtual?: boolean };
type AddressState = { address: string; lanAddresses?: string[]; lanInterfaces?: {address:string;displayName:string;virtual:boolean;recommended:boolean}[] };
export function serviceAddresses(state: AddressState): ServiceAddress[] {
  const lan: ServiceAddress[] = state.lanInterfaces?.map(item => ({address:item.address,label:`${item.address} · ${item.displayName}${item.virtual ? ' · 虚拟网卡' : ''}${item.recommended ? ' · 推荐' : ''}`,virtual:item.virtual,recommended:item.recommended})) ?? (state.lanAddresses ?? []).map((address,index)=>({address,label:`${address} · 网卡地址`,recommended:index===0}));
  return [...lan.filter(a=>!a.virtual),{address:state.address,label:`${state.address} · 仅本机`},...lan.filter(a=>a.virtual)];
}
export function preferredServiceAddress(state: AddressState) { return serviceAddresses(state).find(item=>item.recommended)?.address ?? state.address; }
