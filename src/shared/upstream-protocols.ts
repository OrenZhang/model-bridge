export type UpstreamProtocol = 'responses' | 'messages' | 'chat';
type Source = { provider: string; auth: string; baseUrl: string; upstreamProtocols?: UpstreamProtocol[] };
export function defaultUpstreamProtocols(source: Source): UpstreamProtocol[] {
  if (source.auth === 'chatgpt-device') return ['responses'];
  if (source.auth === 'subscription') return [source.provider === 'minimax' ? 'messages' : 'chat'];
  if (source.provider === 'anthropic' || /\/anthropic(?:\/|$)/i.test(source.baseUrl)) return ['messages'];
  if (source.provider === 'openai') return ['responses', 'chat'];
  return ['chat'];
}
export function upstreamProtocols(source: Source, discovered?: UpstreamProtocol[]): UpstreamProtocol[] {
  if (source.auth === 'chatgpt-device') return ['responses'];
  if (source.auth !== 'subscription' && source.upstreamProtocols?.length) return source.upstreamProtocols;
  return discovered?.length ? discovered : defaultUpstreamProtocols(source);
}
