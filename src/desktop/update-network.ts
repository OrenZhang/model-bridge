export function updateProxyRules(resolution: string): string | undefined {
  for (const item of resolution.split(';')) {
    const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s/@]+:\d+)$/.exec(item.trim());
    if (match) return `${({PROXY:'http',HTTPS:'https',SOCKS5:'socks5',SOCKS:'socks4'} as Record<string,string>)[match[1]!]}://${match[2]}`;
  }
  return undefined;
}
