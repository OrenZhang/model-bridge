import { expect, it, vi, afterEach } from 'vitest';
import { AiNodeSelection, aiProbeTarget, aiResponseAvailable, type Probe, type ProbeTarget } from '../src/network/ai-selection.js';
import { ConnectionSchema, ConfigSchema } from '../src/core/config.js';
import { isolatedConfig } from '../src/network/config.js';
import { parse } from 'yaml';
const selectors: AiNodeSelection[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(selectors.splice(0).map(s => s.close())); });
const target = aiProbeTarget(ConnectionSchema.parse({ id: 'a', name: 'A', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }));
function selector(probe: Probe, interval = 300000, now?: () => number) { const s = new AiNodeSelection(['blocked-fast', 'slow', 'fast'], i => `http://mb-${i}:secret@127.0.0.1:3210`, probe, interval, now); selectors.push(s); return s; }
it('chooses the lowest latency only among available AI nodes and coalesces the initial scan', async () => {
  const probe = vi.fn<Probe>(async url => ({ available: !url.includes('mb-0:'), latencyMs: url.includes('mb-2:') ? 15 : 90 }));
  const s = selector(probe); const urls = await Promise.all([s.choose(target), s.choose(target), s.choose(target)]);
  expect(urls.every(u => u.includes('mb-2:'))).toBe(true); expect(probe).toHaveBeenCalledTimes(3);
  expect(s.snapshot()[0]).toMatchObject({ selected: 'fast', available: 2, total: 3 });
});
it('keeps different AI destinations independent even with the same subscription', async () => {
  const second: ProbeTarget = { ...target, key: 'other', label: 'Other', url: 'https://other.invalid/models' };
  const s = selector(async (url, t) => ({ available: t.key === target.key ? url.includes('mb-2:') : url.includes('mb-1:'), latencyMs: 10 }));
  expect(await s.choose(target)).toContain('mb-2:'); expect(await s.choose(second)).toContain('mb-1:');
});
it('fails closed when no AI node is available; zero, HTML or invalid measurements never create a direct fallback', async () => {
  const s = selector(async () => ({ available: false, latencyMs: 1 }));
  await expect(s.choose(target)).rejects.toMatchObject({ code: 'no_ai_proxy_available' });
  const invalid = selector(async () => ({ available: true, latencyMs: NaN }));
  await expect(invalid.choose(target)).rejects.toMatchObject({ code: 'no_ai_proxy_available' });
});
it('switches subsequent requests after failure and does not immediately reselect the failed node', async () => {
  let time = 1000;
  const s = selector(async url => ({ available: !url.includes('mb-0:'), latencyMs: url.includes('mb-2:') ? 10 : 20 }), 300000, () => time);
  const old = await s.choose(target); s.failed(target, old); await s.checkAll();
  expect(await s.choose(target)).toContain('mb-1:'); expect(old).toContain('mb-2:');
  time += 61000; await s.checkAll(); expect(await s.choose(target)).toContain('mb-2:');
});
it('periodically refreshes availability and stops probes after close', async () => {
  vi.useFakeTimers(); let prefer = 2;
  const probe = vi.fn<Probe>(async url => ({ available: url.includes(`mb-${prefer}:`), latencyMs: 10 }));
  const s = selector(probe, 1000); await s.choose(target); prefer = 1;
  await vi.advanceTimersByTimeAsync(1000); expect(await s.choose(target)).toContain('mb-1:');
  await s.close(); const calls = probe.mock.calls.length; await vi.advanceTimersByTimeAsync(3000); expect(probe).toHaveBeenCalledTimes(calls);
});
it('validates AI-shaped responses rather than treating HTTP reachability as AI availability', () => {
  const auth = JSON.stringify({ error: { type: 'invalid_request_error', message: 'Missing bearer authentication in header' } });
  expect(aiResponseAvailable(target, 401, 'application/json', auth)).toBe(true);
  for (const status of [403, 429, 500, 502, 302]) expect(aiResponseAvailable(target, status, 'application/json', auth)).toBe(false);
  expect(aiResponseAvailable(target, 200, 'text/html', '<html>login</html>')).toBe(false);
  expect(aiResponseAvailable(target, 200, 'application/json', '{"ok":true}')).toBe(false);
  expect(aiResponseAvailable(target, 401, 'application/json', '{"error":"proxy authentication required"}')).toBe(false);
  expect(aiResponseAvailable(target, 200, 'application/json', '{"data":[]}')).toBe(true);
});
it('uses a non-generating MiniMax subscription probe and handles documented unauthenticated provider shapes', () => {
  const minimax = aiProbeTarget(ConnectionSchema.parse({ id: 'mm', name: 'MM', provider: 'minimax', auth: 'subscription', baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1' }));
  expect(minimax.method).toBe('POST'); expect(minimax.url).toMatch(/\/messages$/);
  expect(aiResponseAvailable(minimax, 401, 'application/json', '{"code":401,"message":"token is required"}')).toBe(true);
  const apiKey = aiProbeTarget(ConnectionSchema.parse({ id: 'mm-key', name: 'MM key', provider: 'minimax', baseUrl: 'https://api.minimax.io/anthropic/v1' }));
  expect(apiKey.url).toMatch(/\/messages$/);
  expect(aiResponseAvailable(apiKey, 401, 'application/json', JSON.stringify({error:{type:'authorized_error',message:'Please carry the API secret key in the Authorization field'}}))).toBe(true);
  const deepseek = { ...target, provider: 'deepseek' as const };
  expect(aiResponseAvailable(deepseek, 401, 'text/plain', 'Authentication Fails (governor)')).toBe(true);
  expect(aiResponseAvailable(target, 401, 'text/plain', 'Authentication Fails (governor)')).toBe(false);
});
it('routes each authenticated auto tunnel to one node and rejects unmatched traffic', () => {
  const nodes = [{ name: 'One', type: 'http', server: 'localhost', port: 8001 }, { name: 'Two', type: 'http', server: 'localhost', port: 8002 }];
  const config = parse(isolatedConfig(nodes, 'One', 3001, 3002, 'secret', 'control', true));
  expect(config.authentication).toEqual(['mb-0:secret', 'mb-1:secret']);
  expect(config.rules).toEqual(['IN-USER,mb-0,One', 'IN-USER,mb-1,Two', 'MATCH,REJECT']);
  const profile = { id: 'network', name: 'Network', source: 'config', nodes: ['One'], selected: 'One', secretRef: 'private', updatedAt: 'now' };
  expect(ConfigSchema.parse({ networkProfiles: [profile] }).networkProfiles[0]!.selectionMode).toBe('auto');
  expect(ConfigSchema.parse({ networkProfiles: [{ ...profile, selectionMode: 'manual' }] }).networkProfiles[0]!.selectionMode).toBe('manual');
});
it('aborts a running scan on shutdown and never returns an unchecked node', async () => {
  const s = selector(async (_u, _t, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ available: false }), { once: true })));
  const choice = s.choose(target); const result = expect(choice).rejects.toMatchObject({ code: 'no_ai_proxy_available' });
  await s.close(); await result;
});
