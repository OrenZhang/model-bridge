import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, fetch } from 'undici';
import { z } from 'zod';
import { stringify } from 'yaml';
import { ConfigStore, atomicWrite, type SecretStore } from '../core/store.js';
import { ConnectionSchema, type Connection } from '../core/config.js';
import type { Network } from '../core/network.js';
import { isolatedConfig, parseNodes } from './config.js';
import { MihomoCore } from './core.js';
import { AiNodeSelection, aiProbeTarget } from './ai-selection.js';

async function freePort() {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
type Running = { child: ChildProcess; url: string; nodeUrls: string[]; directory: string; updatedAt: string; selected: string; selectionMode: 'auto' | 'manual'; selection?: AiNodeSelection };
export class ManagedNetworks {
  readonly core: MihomoCore;
  private running = new Map<string, Running>();
  private starting = new Map<string, Promise<string>>();
  private errors = new Map<string, string>();
  private changing = new Set<string>();
  private closed = false;
  private direct = new Agent();
  constructor(private data: string, private store: ConfigStore, private secrets: SecretStore, private network: Network, private canChange: (profileId: string) => boolean = () => true) {
    this.core = new MihomoCore(data, (url, max, official) => this.download(url, max, official));
  }
  overview() {
    return { core: this.core.status(), profiles: this.store.get().networkProfiles.map(profile => ({ ...profile, checks: this.running.get(profile.id)?.selection?.snapshot() ?? [], status: this.starting.has(profile.id) ? 'starting' : this.running.has(profile.id) ? 'running' : this.errors.has(profile.id) ? 'error' : 'stopped', error: this.errors.get(profile.id) })) };
  }
  private async download(initial: string, max: number, official = false) {
    let url = new URL(initial);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('请填写有效的 HTTPS 订阅地址。');
    const bootstrap = ConnectionSchema.parse({ id: 'network-download', name: 'Network download', provider: 'custom', auth: 'none', baseUrl: url.origin, proxy: { mode: 'system' } });
    try {
      for (let redirects = 0; redirects < 4; redirects++) {
        if (url.protocol !== 'https:' || (official && !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname))) throw new Error();
        const response = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'clash.meta/ModelBridge' }, dispatcher: await this.network.dispatcher(bootstrap, url.href), signal: AbortSignal.timeout(official ? 120000 : 30000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); await response.body?.cancel(); if (!location) throw new Error(); url = new URL(location, url); continue; }
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
        const chunks: Uint8Array[] = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error(); chunks.push(chunk); }
        return Buffer.concat(chunks);
      }
    } catch { throw new Error(official ? '内核下载失败，请检查系统网络，或离线导入指定版本的官方压缩包。' : '订阅下载失败，请检查地址和系统网络。已有订阅未被替换。'); }
    throw new Error('订阅重定向次数过多。');
  }
  async save(raw: unknown) {
    const input = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), name: z.string().min(1).max(100), source: z.enum(['subscription', 'config']), url: z.string().optional(), config: z.string().optional() }).parse(raw);
    const id = input.id ?? `network-${randomUUID().slice(0, 8)}`;
    if (this.changing.has(id)) throw new Error('此订阅正在更新。'); this.changing.add(id);
    try {
      const old = this.store.get().networkProfiles.find(p => p.id === id);
      const oldSecret = old ? JSON.parse(await this.secrets.get(old.secretRef) ?? '{}') : {};
      const url = input.url || oldSecret.url;
      const config = input.source === 'subscription' ? (await this.download(url, 2_000_000)).toString('utf8') : input.config || oldSecret.config;
      if (typeof config !== 'string') throw new Error('请导入 Clash / Mihomo 配置内容。');
      const nodes = parseNodes(config);
      if (!this.canChange(id)) throw new Error('正在处理模型请求、登录或模型获取，请完成后再更新网络配置。');
      if (!this.secrets.set) throw new Error('当前模式没有可写凭据存储。');
      const secretRef = `network:${id}`;
      await this.secrets.set(secretRef, JSON.stringify({ config: stringify({ proxies: nodes }), ...(input.source === 'subscription' ? { url } : {}) }));
      await this.stop(id);
      const profile = { id, name: input.name, source: input.source, nodes: nodes.map(node => node.name as string), selected: nodes.some(n => n.name === old?.selected) ? old!.selected : nodes[0]!.name as string, selectionMode: old?.selectionMode ?? 'auto' as const, secretRef, updatedAt: new Date().toISOString() };
      await this.store.update(current => { current.networkProfiles = [...current.networkProfiles.filter(p => p.id !== id), profile]; });
      this.errors.delete(id); return id;
    } finally { this.changing.delete(id); }
  }
  async refresh(id: string) { const p = this.store.get().networkProfiles.find(p => p.id === id); if (!p || p.source !== 'subscription') throw new Error('此配置不是订阅。'); return this.save({ id, name: p.name, source: p.source }); }
  async select(id: string, node: string) {
    if (!this.canChange(id) || this.changing.has(id) || this.starting.has(id)) throw new Error('请在当前请求完成后切换节点。');
    const profile = this.store.get().networkProfiles.find(p => p.id === id); if (!profile?.nodes.includes(node)) throw new Error('节点不存在。');
    this.changing.add(id);
    try { await this.stop(id); await this.store.update(current => { const p = current.networkProfiles.find(p => p.id === id)!; p.selected = node; p.selectionMode = 'manual'; }); this.errors.delete(id); }
    finally { this.changing.delete(id); }
  }
  async automatic(id: string) {
    if (!this.canChange(id) || this.changing.has(id) || this.starting.has(id)) throw new Error('请在当前请求完成后切换节点模式。');
    if (!this.store.get().networkProfiles.some(p => p.id === id)) throw new Error('订阅不存在。');
    this.changing.add(id);
    try { await this.stop(id); await this.store.update(current => { current.networkProfiles.find(p => p.id === id)!.selectionMode = 'auto'; }); this.errors.delete(id); }
    finally { this.changing.delete(id); }
  }
  async check(id: string) {
    const config = this.store.get();
    const connections = config.connections.filter(c => { const choice = c.proxy.mode === 'inherit' ? config.defaultProxy : c.proxy; return c.enabled && choice.mode === 'managed' && choice.profileId === id; });
    if (!connections.length) throw new Error('请先把此订阅绑定到一个 AI 连接，再检测。');
    await Promise.allSettled(connections.map(c => this.proxyUrl(id, c)));
    await this.running.get(id)?.selection?.checkAll();
  }
  async remove(id: string) {
    const config = this.store.get();
    if ([config.defaultProxy, ...config.connections.map(c => c.proxy)].some(p => p.mode === 'managed' && p.profileId === id)) throw new Error('请先从使用此订阅的模型连接中解除绑定。');
    await this.stop(id); await this.store.update(current => { current.networkProfiles = current.networkProfiles.filter(p => p.id !== id); });
  }
  async proxyUrl(id: string, connection?: Connection): Promise<string> {
    await this.ensureRunning(id);
    const running = this.running.get(id)!;
    return running.selection && connection ? running.selection.choose(aiProbeTarget(connection)) : running.url;
  }
  async updateProxies(id: string) {
    await this.ensureRunning(id);
    const running = this.running.get(id)!;
    const profile = this.store.get().networkProfiles.find(p => p.id === id)!;
    // GitHub probes use their own routes, without changing any AI target's node.
    return running.selectionMode === 'manual' ? [{ url: running.url, label: `订阅：${profile.name} / ${profile.selected}` }] : running.nodeUrls.map((url, index) => ({ url, label: `订阅：${profile.name} / ${profile.nodes[index]}` }));
  }
  failed(id: string, connection: Connection, proxy: string) { this.running.get(id)?.selection?.failed(aiProbeTarget(connection), proxy); }
  private async ensureRunning(id: string): Promise<string> {
    if (this.closed || this.changing.has(id)) throw new Error('内置网络正在停止或更新。');
    const profile = this.store.get().networkProfiles.find(p => p.id === id); if (!profile) throw new Error('内置网络配置不存在。');
    const running = this.running.get(id); if (running && running.updatedAt === profile.updatedAt && running.selected === profile.selected && running.selectionMode === profile.selectionMode) return running.url;
    if (this.starting.has(id)) return this.starting.get(id)!;
    const task = this.start(id).catch(error => { this.errors.set(id, error instanceof Error ? error.message : '内置网络启动失败。'); throw error; }).finally(() => this.starting.delete(id));
    this.starting.set(id, task); return task;
  }
  private async start(id: string) {
    await this.stop(id);
    const binary = await this.core.ensure(); if (this.closed) throw new Error('应用正在退出。');
    const profile = this.store.get().networkProfiles.find(p => p.id === id)!;
    const secret = JSON.parse(await this.secrets.get(profile.secretRef) ?? '{}'); const nodes = parseNodes(secret.config);
    const port = await freePort(), control = await freePort();
    const password = randomBytes(24).toString('hex'), controlSecret = randomBytes(24).toString('hex');
    const root = path.join(this.data, 'network-runtime'); await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(root, 'run-')); const config = path.join(directory, 'config.yaml');
    await atomicWrite(config, isolatedConfig(nodes, profile.selected, port, control, password, controlSecret, profile.selectionMode === 'auto'));
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
    const runner = fileURLToPath(new URL('./runner.js', import.meta.url)).replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const child = fork(runner, [binary, directory, config], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const nodeUrl = (i: number) => `http://mb-${i}:${password}@127.0.0.1:${port}`;
    const running: Running = { child, url: profile.selectionMode === 'auto' ? nodeUrl(0) : `http://mb:${password}@127.0.0.1:${port}`, nodeUrls: nodes.map((_, index) => nodeUrl(index)), directory, updatedAt: profile.updatedAt, selected: profile.selected, selectionMode: profile.selectionMode };
    let exited = false; child.once('error', () => { exited = true; });
    child.once('exit', () => { exited = true; void running.selection?.close(); if (this.running.get(id) === running) { this.running.delete(id); this.errors.set(id, '内置网络进程已停止，请重试。'); } });
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (exited || this.closed) throw new Error('内置网络启动失败，请检查订阅节点配置。');
        try {
          const response = await fetch(`http://127.0.0.1:${control}/version`, { headers: { authorization: `Bearer ${controlSecret}` }, dispatcher: this.direct, signal: AbortSignal.timeout(500) });
          await response.body?.cancel();
          if (response.ok) { if (profile.selectionMode === 'auto') running.selection = new AiNodeSelection(nodes.map(n => n.name), nodeUrl); this.running.set(id, running); this.errors.delete(id); return running.url; }
        } catch { /* The child may still be opening its listeners. */ }
        await delay(200);
      }
      throw new Error('内置网络启动超时。');
    } catch (error) { child.kill(); await rm(directory, { recursive: true, force: true }).catch(() => {}); throw error; }
  }
  private async stop(id: string) {
    const active = this.running.get(id); if (!active) return; this.running.delete(id);
    await active.selection?.close();
    if (active.child.exitCode === null) await new Promise<void>(resolve => { const timer = setTimeout(() => { active.child.kill('SIGKILL'); resolve(); }, 3000); active.child.once('exit', () => { clearTimeout(timer); resolve(); }); active.child.kill(); });
    await rm(active.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  async close() { this.closed = true; await Promise.allSettled(this.starting.values()); await Promise.all([...this.running.keys()].map(id => this.stop(id))); await this.direct.destroy(); }
}
