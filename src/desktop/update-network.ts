export function updateProxyRules(resolution: string): string | undefined {
  for (const item of resolution.split(';')) {
    const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s/@]+:\d+)$/.exec(item.trim());
    if (match) return `${({PROXY:'http',HTTPS:'https',SOCKS5:'socks5',SOCKS:'socks4'} as Record<string,string>)[match[1]!]}://${match[2]}`;
  }
  return undefined;
}

export type UpdateProxy = { url: string; label: string };
export function updateProxyRoute(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks:'].includes(url.protocol) || !url.hostname || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Unsupported update proxy');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 1080));
  return { rules: `${url.protocol === 'socks:' ? 'socks5:' : url.protocol}//${url.hostname}:${port}`, host: url.hostname, port, username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}
export function environmentUpdateProxies(env: NodeJS.ProcessEnv): UpdateProxy[] {
  return [...new Set(['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'].map(key => env[key]).filter((value): value is string => !!value))].flatMap(url => {
    try { updateProxyRoute(url); return [{ url, label: '环境代理' }]; } catch { return []; }
  });
}
// Select a working route with bounded concurrency. Stop the remaining probes as
// soon as one succeeds; no full installer is downloaded during detection.
export async function chooseUpdateProxy(candidates: UpdateProxy[], probe: (candidate: UpdateProxy, signal: AbortSignal) => Promise<boolean>): Promise<UpdateProxy | undefined> {
  const unique = [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()];
  const controller = new AbortController(); let index = 0; let selected: UpdateProxy | undefined;
  const deadline = setTimeout(() => controller.abort(), 8000); deadline.unref();
  const worker = async () => {
    while (!controller.signal.aborted) {
      const candidate = unique[index++]; if (!candidate) return;
      try { if (await probe(candidate, controller.signal) && !selected) { selected = candidate; controller.abort(); } } catch { /* Try the next configured route. */ }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker)); }
  finally { clearTimeout(deadline); }
  return selected;
}
