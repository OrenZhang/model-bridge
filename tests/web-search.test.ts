import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/core/config.js';
import type { Network } from '../src/core/network.js';
import { UsageStore } from '../src/core/usage.js';
import { startGateway, tokenHash } from '../src/gateway/server.js';
import { sse } from '../src/gateway/sse.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('runs hosted search inside the gateway and replays its provenance through a client tool continuation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-web-search-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = ConfigSchema.parse({
    port: 0,
    webSearch: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8000' },
    clients: [{ id: 'test', name: 'test', tokenHash: tokenHash('test') }],
    connections: [{
      id: 'model', name: 'model', provider: 'custom', auth: 'none', baseUrl: 'https://upstream.invalid/v1',
      models: [{ id: 'model', upstreamId: 'model', name: 'model', protocols: ['chat'] }],
    }],
  });
  const modelRequests: any[] = [];
  const source = 'https://docs.example.com/search';
  let searchRequests = 0;
  const network = {
    request: async (_connection: unknown, url: string, request: { body: string; headers: Record<string, string> }) => {
      if (url.endsWith('/search')) {
        searchRequests++;
        expect(new URLSearchParams(request.body).get('q')).toBe('search test');
        expect(request.headers.authorization).toBeUndefined();
        return Response.json({ results: [
          { title: 'Verified result', url: source, content: 'Retrieved evidence' },
          { title: 'Excluded host', url: 'https://elsewhere.example.org/page', content: 'Filtered' },
          { title: 'Invalid link', url: 'javascript:alert(1)' },
        ] });
      }
      const body = JSON.parse(request.body);
      modelRequests.push(body);
      expect(body.tools[0].function.name).toBe('mb_gateway_web_search');
      if (modelRequests.length === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
        reasoning_content: 'first leg', tool_calls: [{ id: 'call_web', function: { name: 'mb_gateway_web_search', arguments: '{"query":"search test"}' } }],
      }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      const searchResult = body.messages.find((message: any) => message.tool_call_id === 'call_web');
      expect(JSON.stringify(searchResult)).toContain('Retrieved evidence');
      expect(JSON.stringify(searchResult)).not.toContain('Excluded host');
      expect(body.messages.find((message: any) => message.tool_calls?.[0]?.id === 'call_web').reasoning_content).toBe('first leg');
      if (modelRequests.length === 2) return Response.json({ choices: [{ message: { role: 'assistant', content: null,
        reasoning_content: 'client leg', tool_calls: [{ id: 'call_client', function: { name: 'lookup', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 7 } });
      expect(body.messages.some((message: any) => message.tool_call_id === 'call_client')).toBe(true);
      return new Response(
        sse({ choices: [{ delta: { content: 'Answer backed by search.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }) + sse('[DONE]'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
    close: async () => {},
  } as unknown as Network;
  const gateway = await startGateway({ config: () => config, secrets: { get: async () => undefined }, network, usage: new UsageStore(directory) });
  cleanup.push(() => gateway.close());
  const tools = [
    { type: 'web_search', filters: { allowed_domains: ['example.com'] } },
    { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
  ];
  const post = (input: unknown, stream = false, requestTools: unknown[] = tools) => fetch(gateway.address + '/v1/responses', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json', 'session-id': 'fixture' },
    body: JSON.stringify({ model: 'model', input, tools: requestTools, stream }),
  });
  const cached = await post('hello', false, [{ type: 'web_search', external_web_access: false }]);
  expect((await cached.json()).error.code).toBe('web_search_live_required');

  const user = { type: 'message', role: 'user', content: 'Search and use the lookup tool.' };
  const first = await post([user]);
  expect(first.status).toBe(200);
  const { output, usage } = await first.json();
  expect(output.find((item: any) => item.type === 'web_search_call').action.sources).toEqual([{ type: 'url', url: source }]);
  expect(output.filter((item: any) => item.type === 'function_call').map((item: any) => item.name)).toEqual(['lookup']);
  expect(usage.input_tokens).toBe(30);
  expect(usage.output_tokens).toBe(12);

  const next = await post([user, ...output, { type: 'function_call_output', call_id: 'call_client', output: 'Client evidence' }], true);
  expect(next.status).toBe(200);
  const stream = await next.text();
  expect(stream).toContain('response.output_text.annotation.added');
  expect(stream).toContain(source);
  expect(stream).toContain('response.completed');
  expect(searchRequests).toBe(1);
  expect(modelRequests).toHaveLength(3);
});

it('sends Tavily credentials only to its configured provider endpoint', async () => {
  const { WebSearch } = await import('../src/core/web-search.js');
  const network = {
    request: async (_connection: unknown, url: string, request: { body: string; headers: Record<string, string> }) => {
      expect(url).toBe('https://api.tavily.com/search');
      expect(request.headers.authorization).toBe('Bearer fixture-secret');
      expect(JSON.parse(request.body)).toMatchObject({ query: 'test query', include_domains: ['example.com'] });
      return Response.json({ results: [{ url: 'https://example.com/article', title: 'Article', content: 'Evidence' }] });
    },
  } as unknown as Network;
  const service = new WebSearch(network, { get: async ref => ref === 'search:test' ? 'fixture-secret' : undefined });
  const sources = await service.search({ provider: 'tavily', secretRef: 'search:test' }, 'test query', ['example.com'], new AbortController().signal);
  expect(sources).toEqual([{ url: 'https://example.com/article', title: 'Article', snippet: 'Evidence' }]);
});
