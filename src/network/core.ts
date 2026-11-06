import { createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import manifest from './mihomo-artifacts.json' with { type: 'json' };
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { atomicWrite } from '../core/store.js';

export const coreVersion = manifest.version;
export const artifacts: Record<string, { file: string; sha256: string }> = manifest.artifacts;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class MihomoCore {
  readonly artifact = artifacts[`${process.platform}-${process.arch}`];
  readonly binary: string;
  private installing?: Promise<string>;
  private error?: string;
  private bundled: string;
  constructor(directory: string, private download: (url: string, maxBytes: number, official?: boolean) => Promise<Buffer>, bundleDirectory = fileURLToPath(new URL('../../assets/mihomo/', import.meta.url))) {
    this.bundled = path.join(bundleDirectory, this.artifact?.file ?? 'unsupported');
    this.binary = path.join(directory, 'mihomo', coreVersion, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  }
  status() { return { installed: existsSync(this.binary), downloading: !!this.installing, version: coreVersion, supported: !!this.artifact, asset: this.artifact?.file, bundled: existsSync(this.bundled), error: this.error }; }
  async ensure(archive?: Buffer) {
    if (this.installing) return this.installing;
    this.error = undefined;
    this.installing = this.install(archive).catch(error => { this.error = error instanceof Error ? error.message : '内核安装失败。'; throw error; }).finally(() => { this.installing = undefined; }); return this.installing;
  }
  private async install(archive?: Buffer) {
    if (!this.artifact) throw new Error('当前系统架构尚不支持内置网络内核。');
    if (!archive && existsSync(this.binary)) {
      const expected = await readFile(this.binary + '.sha256', 'utf8').catch(() => '');
      if (hash(await readFile(this.binary)) === expected) return this.binary;
    }
    const bytes = archive ?? (existsSync(this.bundled) ? await readFile(this.bundled) : await this.download(`https://github.com/MetaCubeX/mihomo/releases/download/${coreVersion}/${this.artifact.file}`, 64 * 1024 * 1024, true));
    if (hash(bytes) !== this.artifact.sha256) throw new Error('内核校验失败，请使用指定版本的官方压缩包。');
    let binary: Uint8Array;
    if (this.artifact.file.endsWith('.zip')) {
      const files = Object.entries(unzipSync(bytes)).filter(([name]) => name.endsWith('.exe'));
      if (files.length !== 1) throw new Error('官方内核压缩包格式不正确。'); binary = files[0]![1];
    } else binary = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
    await atomicWrite(this.binary, binary); await chmod(this.binary, 0o700); await atomicWrite(this.binary + '.sha256', hash(binary)); return this.binary;
  }
}
