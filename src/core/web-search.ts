import { BridgeError, ConnectionSchema, type SearchConfig } from './config.js';
import type { Network } from './network.js';
import type { SecretStore } from './store.js';

export interface SearchSource { url: string; title: string; snippet: string; }
const maxResponseBytes = 2 * 1024 * 1024;
const maxResults = 5;

export class WebSearch {
  private active = 0;
  constructor(private network: Network, private secrets: SecretStore) {}

  async search(config: SearchConfig, query: string, domains: string[], signal: AbortSignal): Promise<SearchSource[]> {
    if (this.active >= 8) throw new BridgeError(429, 'web_search_busy', '联网搜索请求过多，请稍后重试。');
    this.active++;
    const timeout = AbortSignal.timeout(12000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const searxng = config.provider === 'searxng';
      const baseUrl = searxng ? config.baseUrl.replace(/\/+$/, '') : 'https://api.tavily.com';
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname);
      const connection = ConnectionSchema.parse({
        id: 'bridge-web-search', name: 'Web search', provider: 'custom', auth: 'none', baseUrl,
        proxy: { mode: loopback ? 'direct' : 'system' },
      });
      const headers: Record<string, string> = { accept: 'application/json' };
      let body: string;
      if (searxng) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams({ q: query, format: 'json', categories: 'general' }).toString();
      } else {
        const key = await this.secrets.get(config.secretRef);
        if (!key) throw new BridgeError(503, 'web_search_key_missing', '请在对外服务中设置 Tavily API Key。');
        headers.authorization = 'Bearer ' + key;
        headers['content-type'] = 'application/json';
        body = JSON.stringify({ query, max_results: maxResults, include_answer: false, ...(domains.length ? { include_domains: domains } : {}) });
      }
      const response = await this.network.request(connection, baseUrl + '/search', {
        method: 'POST', headers, body, signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BridgeError(502, 'web_search_rejected', `搜索服务返回 HTTP ${response.status}，请检查地址、JSON 格式设置或 API Key。`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > maxResponseBytes) throw new BridgeError(502, 'web_search_invalid_response', '搜索服务返回的数据过大。');
        chunks.push(chunk);
      }
      let data: any;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError(502, 'web_search_invalid_response', '搜索服务未返回 JSON。'); }
      if (!Array.isArray(data?.results)) throw new BridgeError(502, 'web_search_invalid_response', '搜索服务未返回结果列表。');
      if (searxng && !data.results.length && data.unresponsive_engines?.length) {
        throw new BridgeError(502, 'web_search_engines_unavailable', 'SearXNG 的搜索引擎未返回结果，请检查实例网络和引擎状态。');
      }
      const sources = new Map<string, SearchSource>();
      for (const result of data.results) {
        if (typeof result?.url !== 'string' || result.url.length > 2048) continue;
        let url: URL;
        try { url = new URL(result.url); } catch { continue; }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
        if (domains.length && !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) continue;
        if (sources.has(url.href)) continue;
        const title = typeof result.title === 'string' ? result.title.trim().slice(0, 300) : '';
        const snippet = typeof result.content === 'string' ? result.content.trim().slice(0, 1500) : '';
        sources.set(url.href, { url: url.href, title: title || url.hostname, snippet });
        if (sources.size === maxResults) break;
      }
      return [...sources.values()];
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw new BridgeError(504, 'web_search_timeout', '联网搜索超时，请稍后重试。');
      if (error instanceof BridgeError && error.code.startsWith('web_search_')) throw error;
      throw new BridgeError(502, 'web_search_unreachable', '无法连接配置的搜索服务。');
    } finally {
      this.active--;
    }
  }
}
