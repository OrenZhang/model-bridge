import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Model, Protocol } from './config.js';

export interface Tokens { input: number | null; output: number | null; cachedInput: number | null; cacheWrite: number | null; reasoning: number | null; }
export const unknownTokens = (): Tokens => ({ input: null, output: null, cachedInput: null, cacheWrite: null, reasoning: null });
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function usageTokens(protocol: Protocol, usage: any, previous = unknownTokens()): Tokens {
  if (!usage || typeof usage !== 'object') return previous;
  const value = { ...previous };
  if (protocol === 'messages') {
    const input = count(usage.input_tokens), cached = count(usage.cache_read_input_tokens), write = count(usage.cache_creation_input_tokens);
    if (input !== null) value.input = input + (cached ?? 0) + (write ?? 0);
    if (cached !== null) value.cachedInput = cached;
    if (write !== null) value.cacheWrite = write;
    if (count(usage.output_tokens) !== null) value.output = usage.output_tokens;
  } else {
    const input = count(usage.input_tokens ?? usage.prompt_tokens), output = count(usage.output_tokens ?? usage.completion_tokens);
    if (input !== null) value.input = input;
    if (output !== null) value.output = output;
    const cached = count(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
    const reasoning = count(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens);
    if (cached !== null) value.cachedInput = cached;
    if (reasoning !== null) value.reasoning = reasoning;
  }
  return value;
}
export interface UsageRecord {
  id: string; startedAt: string; clientId: string; connectionId: string; provider: string;
  model: string; upstreamModel: string; protocol: Protocol; status: 'success' | 'error' | 'cancelled';
  durationMs: number; firstByteMs: number | null; tokens: Tokens; estimatedCostUsd: number | null;
  errorCode?: string;
}
export function estimatedCost(model: Model, tokens: Tokens) {
  if (!model.price || tokens.input === null || tokens.output === null || (tokens.cacheWrite ?? 0) > 0) return null;
  if (model.price.cachedInput !== undefined && tokens.cachedInput === null) return null;
  const cached = Math.min(tokens.input, tokens.cachedInput ?? 0);
  return ((tokens.input - cached) * model.price.input + cached * (model.price.cachedInput ?? model.price.input) + tokens.output * model.price.output) / 1e6;
}
export class UsageStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private directory: string) {}
  async append(record: UsageRecord) {
    const operation = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(path.join(this.directory, `${record.startedAt.slice(0, 10)}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
    });
    this.writes = operation.catch(() => {}); await operation;
  }
  async list(days = 7) {
    await this.writes;
    const result: UsageRecord[] = [];
    for (let i = 0; i < Math.min(Math.max(1, days), 90); i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      try {
        const contents = await readFile(path.join(this.directory, `${day}.jsonl`), 'utf8');
        for (const line of contents.split('\n').filter(Boolean)) {
          try { result.push(JSON.parse(line)); } catch { /* An incomplete final write must not hide earlier records. */ }
        }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
export function usageSummary(records: UsageRecord[]) {
  return {
    requests: records.length, successful: records.filter(r => r.status === 'success').length,
    inputTokens: records.reduce((n, r) => n + (r.tokens.input ?? 0), 0),
    outputTokens: records.reduce((n, r) => n + (r.tokens.output ?? 0), 0),
    cachedTokens: records.reduce((n, r) => n + (r.tokens.cachedInput ?? 0), 0),
    unknownUsage: records.filter(r => r.tokens.input === null || r.tokens.output === null).length,
    estimatedCostUsd: records.reduce((n, r) => n + (r.estimatedCostUsd ?? 0), 0),
    unpricedRequests: records.filter(r => r.estimatedCostUsd === null).length,
  };
}
export type UsageFilters = Partial<Pick<UsageRecord, 'clientId' | 'provider' | 'connectionId' | 'model'>>;
export function usageView(records: UsageRecord[], filters: UsageFilters, days: number) {
  const keys = ['clientId', 'provider', 'connectionId', 'model'] as const;
  const filtered = records.filter(record => keys.every(key => !filters[key] || record[key] === filters[key]));
  const dailyCounts = new Map<string, number>();
  for (const record of filtered) { const day = record.startedAt.slice(0, 10); dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1); }
  return { summary: usageSummary(records), filteredSummary: usageSummary(filtered), records: filtered.slice(0, 200),
    usageOptions: Object.fromEntries(keys.map(key => [key, [...new Set(records.map(record => record[key]))].sort()])),
    daily: Array.from({ length: Math.min(days, 7) }, (_, i) => { const date = new Date(Date.now() - (Math.min(days, 7) - 1 - i) * 86400000).toISOString().slice(0, 10); return { date, count: dailyCounts.get(date) ?? 0 }; }),
  };
}
export function usageCsv(records: UsageRecord[]) {
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" : '') + s.replaceAll('"', '""') + '"'; };
  return [['Time (UTC)', 'Client', 'Provider', 'Account', 'Model', 'Status', 'Input tokens', 'Output tokens', 'Cached tokens', 'Estimated USD', 'Latency ms'],
    ...records.map(r => [r.startedAt, r.clientId, r.provider, r.connectionId, r.model, r.status, r.tokens.input, r.tokens.output, r.tokens.cachedInput, r.estimatedCostUsd, r.durationMs])].map(row => row.map(cell).join(',')).join('\r\n');
}
