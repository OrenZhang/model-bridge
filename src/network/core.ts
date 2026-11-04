import { createHash } from 'node:crypto';
import { chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { atomicWrite } from '../core/store.js';

export const coreVersion = 'v1.19.32';
// Digests from the official GitHub release assets, checked on 2026-11-04.
const artifacts: Record<string, { file: string; sha256: string }> = {
  'darwin-arm64': { file: 'mihomo-darwin-arm64-v1.19.32.gz', sha256: '3312a6780652c622890fd4357c6a853bbf865464fd047ac7b7f52dab8de18652' },
  'darwin-x64': { file: 'mihomo-darwin-amd64-compatible-v1.19.32.gz', sha256: '18b382df77bded2ad0fb3db27db5636cb15b20729d5ba995a357eeb9b46bf507' },
  'win32-x64': { file: 'mihomo-windows-amd64-compatible-v1.19.32.zip', sha256: '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0' },
  'win32-arm64': { file: 'mihomo-windows-arm64-v1.19.32.zip', sha256: '7a4f6e58af9a120920935f2150cf642d945085fdb3e753314505b334234e1d1e' },
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class MihomoCore {
  readonly artifact = artifacts[`${process.platform}-${process.arch}`];
  readonly binary: string;
  private installing?: Promise<string>;
  constructor(directory: string, private download: (url: string, maxBytes: number, official?: boolean) => Promise<Buffer>) {
    this.binary = path.join(directory, 'mihomo', coreVersion, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  }
  status() { return { installed: existsSync(this.binary), downloading: !!this.installing, version: coreVersion, supported: !!this.artifact, asset: this.artifact?.file }; }
  async ensure(archive?: Buffer) {
    if (this.installing) return this.installing;
    this.installing = this.install(archive).finally(() => { this.installing = undefined; }); return this.installing;
  }
  private async install(archive?: Buffer) {
    if (!this.artifact) throw new Error('当前系统架构尚不支持内置网络内核。');
    if (!archive && existsSync(this.binary)) {
      const expected = await readFile(this.binary + '.sha256', 'utf8').catch(() => '');
      if (hash(await readFile(this.binary)) === expected) return this.binary;
    }
    const bytes = archive ?? await this.download(`https://github.com/MetaCubeX/mihomo/releases/download/${coreVersion}/${this.artifact.file}`, 64 * 1024 * 1024, true);
    if (hash(bytes) !== this.artifact.sha256) throw new Error('内核校验失败，请使用指定版本的官方压缩包。');
    let binary: Uint8Array;
    if (this.artifact.file.endsWith('.zip')) {
      const files = Object.entries(unzipSync(bytes)).filter(([name]) => name.endsWith('.exe'));
      if (files.length !== 1) throw new Error('官方内核压缩包格式不正确。'); binary = files[0]![1];
    } else binary = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
    await atomicWrite(this.binary, binary); await chmod(this.binary, 0o700); await atomicWrite(this.binary + '.sha256', hash(binary)); return this.binary;
  }
}
