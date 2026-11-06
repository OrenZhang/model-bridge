import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { gt, prerelease, valid } from 'semver';
import type { UpdateCheckResult } from 'electron-updater';
import type { UpdateState } from '../shared/updates.js';
type DownloadCancellation = NonNullable<UpdateCheckResult['cancellationToken']>;

export const RELEASES_URL = 'https://github.com/OrenZhang/model-bridge/releases';
export interface ReleaseInfo {
  version: string; files: { url: string; sha512: string; size?: number }[];
  releaseNotes?: string | { version: string; note: string | null }[] | null;
  releaseDate?: string;
}
export interface UpdateEngine {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean; allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<{ cancellationToken?: DownloadCancellation } | null>;
  downloadUpdate(cancellation?: DownloadCancellation): Promise<unknown>;
}
export interface UpdateOptions {
  version: string; packaged: boolean; platform: NodeJS.Platform; arch: string; directory: string; engine: UpdateEngine;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  openInstaller: (file: string) => Promise<void>; installAndRestart: () => Promise<void>;
  changed?: (state: UpdateState) => void;
}

export function macInstaller(info: ReleaseInfo, arch: string) {
  if (!valid(info.version) || !['arm64', 'x64'].includes(arch)) throw new Error('更新版本或处理器架构无效。');
  const file = info.files.find(f => f.url === `Model-Bridge-${info.version}-mac-${arch}.dmg`);
  if (!file || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error('此版本没有适合当前 Mac 的安装包或校验信息。');
  return { ...file, address: `${RELEASES_URL}/download/v${info.version}/${encodeURIComponent(file.url)}` };
}
async function digest(file: string) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

export class DesktopUpdates {
  private state: UpdateState;
  private info?: ReleaseInfo;
  private downloaded?: { file: string; sha512: string };
  private checking?: Promise<void>;
  private downloading?: Promise<void>;
  private controller?: AbortController;
  private cancellation?: DownloadCancellation;
  private closed = false;
  constructor(private options: UpdateOptions) {
    this.state = { currentVersion: options.version, installMode: options.platform === 'darwin' ? 'installer' : 'restart', phase: options.packaged ? 'idle' : 'development' };
    const engine = options.engine;
    engine.autoDownload = false; engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = !!prerelease(options.version); engine.allowDowngrade = false;
    engine.on('update-available', (info: ReleaseInfo) => {
      if (this.closed) return;
      if (!valid(info.version)) { this.fail(new Error('发布版本信息无效。'), 'check'); return; }
      if (!gt(info.version, options.version)) { this.info = undefined; this.set({ phase: 'current', latestVersion: undefined, notes: undefined }); return; }
      this.info = info;
      const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : info.releaseNotes?.map(n => n.note ?? '').join('\n\n') ?? '';
      this.set({ phase: 'available', latestVersion: info.version, notes: notes.slice(0, 20000), message: undefined, retry: undefined, percent: undefined });
    });
    engine.on('update-not-available', () => { this.info = undefined; this.set({ phase: 'current', latestVersion: undefined, notes: undefined, checkedAt: new Date().toISOString(), message: undefined, retry: undefined }); });
    engine.on('download-progress', progress => this.set({ phase: 'downloading', percent: progress.percent, transferred: progress.transferred, total: progress.total }));
    engine.on('update-downloaded', () => { if (this.state.installMode === 'restart') this.set({ phase: 'downloaded', percent: 100 }); });
    engine.on('error', error => {
      if (this.state.phase === 'installing') this.fail(error, 'install');
      // Awaited check/download calls own their errors and retry state.
    });
  }
  snapshot() { return { ...this.state }; }
  private set(update: Partial<UpdateState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...update }; this.options.changed?.(this.snapshot());
  }
  private fail(error: unknown, retry: 'check' | 'download' | 'install') {
    const raw = error instanceof Error ? error.message : '操作失败';
    const message = /404|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|No published versions/.test(raw) ? '当前更新通道尚未发布安装包，可稍后重试。' : raw.slice(0, 500);
    this.set({ phase: 'error', message, retry });
  }
  check(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.closed || !this.options.packaged || ['downloading', 'downloaded', 'installing'].includes(this.state.phase)) return Promise.resolve();
    this.set({ phase: 'checking', message: undefined, retry: undefined });
    this.checking = this.options.engine.checkForUpdates().then(result => {
      if (!result) throw new Error('请使用已安装的 NSIS、AppImage 或 Debian 版本检查更新。');
      this.cancellation = result.cancellationToken;
      this.set({ checkedAt: new Date().toISOString() });
    }).catch(error => { this.fail(error, 'check'); }).finally(() => { this.checking = undefined; });
    return this.checking;
  }
  download(): Promise<void> {
    if (this.downloading) return this.downloading;
    if (this.closed || !this.options.packaged || !this.info || !['available', 'error'].includes(this.state.phase)) return Promise.resolve();
    this.set({ phase: 'downloading', percent: 0, message: undefined, retry: undefined });
    this.downloading = (this.state.installMode === 'installer' ? this.downloadMac() : this.options.engine.downloadUpdate(this.cancellation).then(() => {}))
      .catch(error => { this.fail(error, 'download'); }).finally(() => { this.downloading = undefined; });
    return this.downloading;
  }
  private async downloadMac() {
    const asset = macInstaller(this.info!, this.options.arch);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.options.directory, asset.url);
    const partial = `${file}.${randomUUID()}.part`;
    this.controller = new AbortController();
    // The URL is constructed from our fixed repository and a validated asset name.
    try {
      const response = await this.options.fetch(asset.address, { signal: this.controller.signal });
      if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）。`);
      const hash = createHash('sha512'); let transferred = 0; let lastUpdate = 0;
      const meter = new Transform({ transform: (chunk, _, done) => {
        transferred += chunk.length; hash.update(chunk);
        if (asset.size && transferred > asset.size) { done(new Error('安装包大小与发布信息不符。')); return; }
        if (Date.now() - lastUpdate > 200) {
          lastUpdate = Date.now(); this.set({ transferred, total: asset.size, percent: asset.size ? Math.min(99, transferred / asset.size * 100) : 0 });
        }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: this.controller.signal });
      if ((asset.size !== undefined && transferred !== asset.size) || hash.digest('base64') !== asset.sha512) throw new Error('安装包校验失败，请重新下载。');
      await rename(partial, file);
      this.downloaded = { file, sha512: asset.sha512 };
      this.set({ phase: 'downloaded', percent: 100, transferred, total: transferred });
    } finally { await rm(partial, { force: true }); this.controller = undefined; }
  }
  async install() {
    if (this.closed || !(this.state.phase === 'downloaded' || (this.state.phase === 'error' && this.state.retry === 'install'))) return;
    this.set({ phase: 'installing', message: undefined, retry: undefined });
    try {
      if (this.state.installMode === 'installer') {
        if (!this.downloaded || await digest(this.downloaded.file).catch(() => '') !== this.downloaded.sha512) { this.downloaded = undefined; throw new Error('安装包已更改或丢失，请重新下载。'); }
        await this.options.openInstaller(this.downloaded.file);
        this.set({ phase: 'downloaded', message: '安装包已打开。退出 Model Bridge 后，将新版拖入“应用程序”替换，再重新启动。' });
      } else await this.options.installAndRestart();
    } catch (error) { this.fail(error, this.state.installMode === 'installer' && !this.downloaded ? 'download' : 'install'); }
  }
  close() { this.closed = true; this.controller?.abort(); this.cancellation?.cancel(); }
}
