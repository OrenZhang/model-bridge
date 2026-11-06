import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DesktopUpdates, macInstaller, type ReleaseInfo, type UpdateEngine } from '../src/desktop/updates.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const data = Buffer.from('fixture installer content');
const release: ReleaseInfo = { version: '0.1.0-alpha.2', files: [{ url: 'Model-Bridge-0.1.0-alpha.2-mac-arm64.dmg', sha512: createHash('sha512').update(data).digest('base64'), size: data.length }], releaseNotes: '<script>unsafe</script> Plain release notes' };
class Engine extends EventEmitter implements UpdateEngine {
  autoDownload = true; autoInstallOnAppQuit = true; allowPrerelease = false; allowDowngrade = true;
  checkForUpdates = vi.fn(async () => { this.emit('update-available', release); return {}; });
  downloadUpdate = vi.fn(async () => { this.emit('download-progress', { percent: 75, transferred: 75, total: 100 }); this.emit('update-downloaded'); });
}
async function fixture(platform: NodeJS.Platform = 'darwin', packaged = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-updates-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const engine = new Engine(); const fetch = vi.fn(async () => new Response(data)); const openInstaller = vi.fn(async () => {}); const installAndRestart = vi.fn(async () => {});
  const updates = new DesktopUpdates({ version: '0.1.0-alpha.1', platform, arch: 'arm64', packaged, directory, engine, fetch, openInstaller, installAndRestart });
  cleanups.push(async () => updates.close()); return { updates, engine, directory, fetch, openInstaller, installAndRestart };
}

it('checks releases without silently downloading or installing, preserves prerelease and downgrade policy', async () => {
  const f = await fixture();
  expect(f.engine.autoDownload).toBe(false); expect(f.engine.autoInstallOnAppQuit).toBe(false);
  expect(f.engine.allowPrerelease).toBe(true); expect(f.engine.allowDowngrade).toBe(false);
  await f.updates.check(); expect(f.updates.snapshot()).toMatchObject({ phase: 'available', latestVersion: release.version, installMode: 'installer' });
  expect(f.fetch).not.toHaveBeenCalled(); expect(f.engine.downloadUpdate).not.toHaveBeenCalled(); expect(f.openInstaller).not.toHaveBeenCalled();
});
it('downloads the matching Mac installer, verifies SHA-512 and opens only on explicit install', async () => {
  const f = await fixture(); await f.updates.check();
  await Promise.all([f.updates.download(), f.updates.download()]);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.fetch.mock.calls[0]![0]).toBe('https://github.com/OrenZhang/model-bridge/releases/download/v0.1.0-alpha.2/Model-Bridge-0.1.0-alpha.2-mac-arm64.dmg');
  expect(f.updates.snapshot()).toMatchObject({ phase: 'downloaded', percent: 100 });
  const file = path.join(f.directory, release.files[0]!.url); expect(await readFile(file)).toEqual(data);
  expect(f.openInstaller).not.toHaveBeenCalled(); await f.updates.install(); expect(f.openInstaller).toHaveBeenCalledWith(file); expect(f.installAndRestart).not.toHaveBeenCalled();
});
it('removes corrupt partial downloads, reports the failure and allows a clean retry', async () => {
  const f = await fixture(); await f.updates.check();
  f.fetch.mockResolvedValueOnce(new Response('corrupt'));
  await f.updates.download(); expect(f.updates.snapshot()).toMatchObject({ phase: 'error', retry: 'download' });
  expect(await readdir(f.directory)).toEqual([]); await f.updates.install(); expect(f.openInstaller).not.toHaveBeenCalled();
  await f.updates.download(); expect(f.updates.snapshot().phase).toBe('downloaded');
});
it('checks the installer again before opening and requires redownload after tampering', async () => {
  const f = await fixture(); await f.updates.check(); await f.updates.download();
  await writeFile(path.join(f.directory, release.files[0]!.url), 'tampered'); await f.updates.install();
  expect(f.updates.snapshot()).toMatchObject({ phase: 'error', retry: 'download' }); expect(f.openInstaller).not.toHaveBeenCalled();
});
it.each(['win32', 'linux'] as const)('uses the platform updater and retries a blocked install on %s', async platform => {
  const f = await fixture(platform); await f.updates.check(); await f.updates.download();
  expect(f.engine.downloadUpdate).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.updates.snapshot()).toMatchObject({ phase: 'downloaded', installMode: 'restart' });
  f.installAndRestart.mockRejectedValueOnce(new Error('Active model request'));
  await f.updates.install(); expect(f.updates.snapshot()).toMatchObject({ phase: 'error', retry: 'install' });
  await f.updates.install(); expect(f.installAndRestart).toHaveBeenCalledTimes(2);
});
it('allows retry after a release-check failure and coalesces concurrent checks', async () => {
  const f = await fixture(); f.engine.checkForUpdates.mockRejectedValueOnce(new Error('No published versions on GitHub'));
  await Promise.all([f.updates.check(), f.updates.check()]); expect(f.engine.checkForUpdates).toHaveBeenCalledOnce();
  expect(f.updates.snapshot()).toMatchObject({ phase: 'error', retry: 'check', message: '当前更新通道尚未发布安装包，可稍后重试。' });
  await f.updates.check(); expect(f.updates.snapshot().phase).toBe('available');
});
it('does not check in development or accept events after shutdown', async () => {
  const f = await fixture('darwin', false); await f.updates.check(); expect(f.engine.checkForUpdates).not.toHaveBeenCalled();
  f.updates.close(); f.engine.emit('update-available', release); expect(f.updates.snapshot().phase).toBe('development');
});
it('rejects mismatched architecture, unsafe asset paths and missing checksum metadata', () => {
  expect(() => macInstaller(release, 'x64')).toThrow('安装包');
  expect(() => macInstaller({ ...release, files: [{ ...release.files[0]!, url: 'https://evil.invalid/setup.dmg' }] }, 'arm64')).toThrow('安装包');
  expect(() => macInstaller({ ...release, version: '../setup' }, 'arm64')).toThrow('版本');
  expect(() => macInstaller({ ...release, files: [{ ...release.files[0]!, sha512: '' }] }, 'arm64')).toThrow('校验');
});
it('reports installer launch errors from the engine without disabling retry', async () => {
  const f = await fixture('win32'); await f.updates.check(); await f.updates.download();
  f.installAndRestart.mockImplementationOnce(async () => { f.engine.emit('error', new Error('Installer launch failed')); });
  await f.updates.install(); expect(f.updates.snapshot()).toMatchObject({ phase: 'error', retry: 'install', message: 'Installer launch failed' });
  await f.updates.install(); expect(f.installAndRestart).toHaveBeenCalledTimes(2);
});
it('does not offer a same-version or older release for download', async () => {
  const f = await fixture();
  f.engine.checkForUpdates.mockImplementationOnce(async () => { f.engine.emit('update-available', { ...release, version: '0.1.0-alpha.1' }); return {}; });
  await f.updates.check(); expect(f.updates.snapshot().phase).toBe('current'); await f.updates.download(); expect(f.fetch).not.toHaveBeenCalled();
});
