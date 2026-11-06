import { parse, stringify } from 'yaml';

const protocols = new Set(['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'http', 'socks5']);
const allowed = new Set(['name', 'type', 'server', 'port', 'password', 'cipher', 'udp', 'uuid', 'alterId', 'tls', 'servername', 'sni', 'alpn', 'network', 'ws-opts', 'grpc-opts', 'http-opts', 'h2-opts', 'reality-opts', 'client-fingerprint', 'fingerprint', 'skip-cert-verify', 'packet-encoding', 'flow', 'obfs', 'obfs-password', 'up', 'down', 'token', 'congestion-controller', 'udp-relay-mode', 'reduce-rtt', 'request-timeout', 'heartbeat-interval', 'disable-sni', 'username', 'ip-version', 'smux', 'tfo']);
export function parseNodes(source: string): Record<string, any>[] {
  if (Buffer.byteLength(source) > 2_000_000) throw new Error('订阅或配置超过 2 MB。');
  let document: any;
  try { document = parse(source, { maxAliasCount: 30, uniqueKeys: true }); } catch { throw new Error('无法解析订阅，请使用 Clash / Mihomo YAML 格式。'); }
  const values = Array.isArray(document) ? document : document?.proxies;
  if (!Array.isArray(values) || !values.length || values.length > 1000) throw new Error('订阅中没有可用节点。请使用包含 proxies 节点的 Clash / Mihomo 订阅。');
  const names = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== 'object' || !protocols.has(value.type)) throw new Error('订阅含暂不支持的节点协议。');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\r\n,]/.test(value.name) || ['DIRECT', 'REJECT', 'GLOBAL', 'PASS', 'COMPATIBLE'].includes(value.name) || names.has(value.name)) throw new Error('订阅含重复或不适用的节点名称。');
    if (typeof value.server !== 'string' || !value.server || /[\s/]/.test(value.server) || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('订阅含无效的节点地址或端口。');
    const unsupported = Object.keys(value).filter(key => !allowed.has(key));
    if (unsupported.length) throw new Error(`节点包含暂不支持的字段：${unsupported.map(k => k.slice(0, 40)).join(', ')}。请使用标准节点订阅。`);
    const serialized = JSON.stringify(value);
    if (/"(?:private-key-file|certificate-file|ca-file|dialer-proxy|interface-name|routing-mark|plugin)"\s*:/.test(serialized)) throw new Error('节点不能引用本机文件、外部进程或其他网络接口。');
    names.add(value.name); return structuredClone(value);
  });
}
export function isolatedConfig(nodes: Record<string, any>[], selected: string, proxyPort: number, controlPort: number, password: string, controlSecret: string, automatic = false) {
  if (!nodes.some(node => node.name === selected)) throw new Error('所选节点已不存在，请重新选择。');
  // Build a fresh configuration. Subscription rules, listeners, DNS and TUN never enter the runtime.
  return stringify({ 'mixed-port': proxyPort, 'allow-lan': false, 'bind-address': '127.0.0.1', authentication: automatic ? nodes.map((_, i) => `mb-${i}:${password}`) : [`mb:${password}`], mode: 'rule', 'log-level': 'silent', ipv6: false,
    'external-controller': `127.0.0.1:${controlPort}`, secret: controlSecret,
    tun: { enable: false }, dns: { enable: false }, 'find-process-mode': 'off', 'geo-auto-update': false,
    profile: { 'store-selected': false, 'store-fake-ip': false }, proxies: nodes,
    // Separate authenticated tunnels keep in-flight streams on their original node.
    rules: automatic ? [...nodes.map((node, i) => `IN-USER,mb-${i},${node.name}`), 'MATCH,REJECT'] : [`MATCH,${selected}`] });
}
