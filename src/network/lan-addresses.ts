import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { createSocket } from 'node:dgram';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

export type LanAddress = { address: string; ip: string; name: string; displayName: string; virtual: boolean; recommended: boolean };
type Adapter = { name: string; displayName?: string; virtual?: boolean; active?: boolean };
const execute = promisify(execFile);
const virtualName = /vethernet|hyper-v|vmware|virtualbox|\bvirtual\b|wsl|docker|tailscale|zerotier|wireguard|clash|mihomo|vpn|loopback|本地连接\*|^(?:utun|tun|tap|bridge|br-|veth|virbr|vmnet|wg|zt|ham|awdl|llw|gif|stf)\d*/i;
const privateIp = (ip: string) => /^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(ip);

export function lanAddressList(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>, port: number, preferredIp?: string, adapters: Adapter[] = []): LanAddress[] {
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? []).filter(item => item.family === 'IPv4' && !item.internal && item.address !== '0.0.0.0' && !item.address.startsWith('169.254.') && adapters.find(a => a.name.toLowerCase() === name.toLowerCase())?.active !== false).map(item => {
    const adapter = adapters.find(a => a.name.toLowerCase() === name.toLowerCase());
    return { address: `http://${item.address}:${port}`, ip: item.address, name, displayName: adapter?.displayName ?? name, virtual: adapter?.virtual ?? virtualName.test(name), recommended: false };
  }));
  addresses.sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(b.ip === preferredIp) - Number(a.ip === preferredIp) || Number(privateIp(b.ip)) - Number(privateIp(a.ip)) || a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  const seen = new Set<string>();
  const unique = addresses.filter(item => { if (seen.has(item.address)) return false; seen.add(item.address); return true; });
  if (unique[0]) unique[0].recommended = true;
  return unique;
}
async function defaultRouteIp(): Promise<string | undefined> {
  // UDP connect only asks the OS for a route; no packet or DNS request is sent.
  return new Promise(resolve => {
    const socket = createSocket('udp4'); let done = false;
    const finish = (ip?: string) => { if (done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {} resolve(ip); };
    const timer = setTimeout(() => finish(), 500);
    socket.on('error', () => finish());
    try { socket.connect(53, '1.1.1.1', () => { if (!done) finish(socket.address().address); }); } catch { finish(); }
  });
}
async function adapterDetails(names: string[]): Promise<Adapter[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); @(Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceDescription,HardwareInterface,Virtual,Status) | ConvertTo-Json -Compress'], { timeout: 2000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
      return (Array.isArray(result) ? result : [result]).filter(a => typeof a?.Name === 'string').map(a => ({ name: a.Name, displayName: a.Name, virtual: a.Virtual === true || a.HardwareInterface === false || virtualName.test(a.Name + ' ' + a.InterfaceDescription), active: !['Disconnected','Disabled','Not Present','LowerLayerDown'].includes(a.Status) }));
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execute('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 2000, maxBuffer: 1024 * 1024 });
      return [...stdout.matchAll(/Hardware Port: (.+)\r?\nDevice: (\S+)/g)].map(match => ({ name: match[2]!, displayName: `${match[1]} (${match[2]})`, virtual: virtualName.test(match[2]!) }));
    }
    if (process.platform === 'linux') return await Promise.all(names.map(async name => ({ name, virtual: await realpath('/sys/class/net/' + name).then(value => value.includes('/devices/virtual/')).catch(() => virtualName.test(name)) })));
  } catch { /* Interface names remain usable if platform metadata is unavailable. */ }
  return [];
}
export class LanAddresses {
  private preferred?: string;
  private adapters: Adapter[] = [];
  private checkedAt = 0;
  private refreshing?: Promise<void>;
  constructor(private port: number) {}
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all([defaultRouteIp(), adapterDetails(Object.keys(networkInterfaces()))]).then(([preferred, adapters]) => { this.preferred = preferred; this.adapters = adapters; this.checkedAt = Date.now(); }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  list() { if (Date.now() - this.checkedAt > 30000) void this.refresh(); return lanAddressList(networkInterfaces(), this.port, this.preferred, this.adapters); }
}
