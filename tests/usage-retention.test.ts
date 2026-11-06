import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageStore, unknownTokens, usageView, type UsageRecord } from '../src/core/usage.js';
import { createRuntime } from '../src/core/runtime.js';
import { ConfigStore } from '../src/core/store.js';

const DAY = 86400000;
const today = Date.parse('2026-11-06T12:00:00Z');
const dayAt = (time: number) => new Date(time).toISOString().slice(0, 10);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.useRealTimers(); }
});
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mb-usage-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function record(time: number): UsageRecord {
  return { id: String(time), startedAt: new Date(time).toISOString(), clientId: 'client', connectionId: 'account',
    provider: 'custom', model: 'model', upstreamModel: 'model', protocol: 'chat', status: 'success',
    durationMs: 1, firstByteMs: 1, tokens: unknownTokens(), estimatedCostUsd: null };
}
async function seed(dir: string, time: number) {
  await writeFile(path.join(dir, `${dayAt(time)}.jsonl`), JSON.stringify(record(time)) + '\n');
}

it('physically removes expired days and retains exactly the latest 60 UTC dates', async () => {
  const dir = await directory();
  await Promise.all(Array.from({ length: 91 }, (_, i) => seed(dir, today - i * DAY)));
  const store = new UsageStore(dir, () => today);
  const records = await store.list();
  expect(records).toHaveLength(60);
  expect(records[0]!.startedAt).toBe(new Date(today).toISOString());
  expect(records.at(-1)!.startedAt).toBe(new Date(today - 59 * DAY).toISOString());
  expect(await readdir(dir)).toHaveLength(60);
  expect(await store.list(365)).toEqual(records);
  expect(await store.list(7)).toHaveLength(7);
  const view = usageView(records, { clientId: 'client' }, 60);
  expect(view.filteredSummary.requests).toBe(60);
  expect(view.daily).toHaveLength(60);
});

it('keeps unrelated files, invalid dates, directories and symbolic links', async () => {
  const dir = await directory();
  await seed(dir, today - 60 * DAY);
  for (const name of ['notes.jsonl', '2026-02-30.jsonl', '2020-01-01.jsonl.backup']) await writeFile(path.join(dir, name), 'keep');
  await mkdir(path.join(dir, '2020-01-02.jsonl'));
  // Windows may require elevated privileges to create symbolic links.
  if (process.platform !== 'win32') await symlink('notes.jsonl', path.join(dir, '2020-01-03.jsonl'));
  await new UsageStore(dir, () => today).prune();
  expect((await readdir(dir)).sort()).toEqual(['notes.jsonl', '2026-02-30.jsonl', '2020-01-01.jsonl.backup', '2020-01-02.jsonl', ...(process.platform !== 'win32' ? ['2020-01-03.jsonl'] : [])].sort());
});

it('cleans up at UTC rollover and never recreates expired files from delayed writes', async () => {
  const dir = await directory();
  let now = Date.parse('2026-11-06T23:59:59Z');
  const store = new UsageStore(dir, () => now);
  const boundary = record(today - 59 * DAY);
  await store.append(boundary);
  now += 1000;
  await Promise.all([store.prune(), store.append(boundary), store.append(record(now)), store.prune()]);
  expect(await readdir(dir)).toEqual(['2026-11-07.jsonl']);
  expect(await store.list()).toEqual([record(now)]);
});

it('retries cleanup errors and allows a fresh installation with no usage directory', async () => {
  const dir = await directory();
  const location = path.join(dir, 'usage');
  await writeFile(location, 'blocks directory');
  const store = new UsageStore(location, () => today);
  await expect(store.prune()).rejects.toMatchObject({ code: 'ENOTDIR' });
  await rm(location);
  expect(await store.list()).toEqual([]);
  await store.append(record(today));
  expect(await store.list()).toEqual([record(today)]);
});

it('prunes on runtime startup and at midnight while idle, then cancels the timer on close', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(Date.parse('2026-11-06T23:59:59Z'));
  const dir = await directory();
  const usageDir = path.join(dir, 'usage');
  await mkdir(usageDir);
  await seed(usageDir, today - 60 * DAY);
  await seed(usageDir, today - 59 * DAY);
  const config = await new ConfigStore(dir).load();
  await config.save({ port: 0 });
  const runtime = await createRuntime(dir, { get: async () => undefined }, dir);
  cleanup.push(() => runtime.close());
  expect(await readdir(usageDir)).toEqual([`${dayAt(today - 59 * DAY)}.jsonl`]);
  const prune = vi.spyOn(runtime.usage, 'prune');
  await vi.advanceTimersByTimeAsync(1000);
  expect(prune).toHaveBeenCalledTimes(1);
  await prune.mock.results[0]!.value;
  expect(await readdir(usageDir)).toEqual([]);
  await expect(readFile(path.join(usageDir, `${dayAt(today - 59 * DAY)}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
  cleanup.pop();
  await runtime.close();
  expect(vi.getTimerCount()).toBe(0);
});
