import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MihomoCore, artifacts } from '../src/network/core.js';
it('has pinned official core archives for every desktop release target', () => {
  for (const key of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
    expect(artifacts[key]?.sha256).toMatch(/^[0-9a-f]{64}$/); expect(artifacts[key]?.file).toContain('v1.19.32');
  }
});
it('rejects a corrupted bundled core without executing it or silently downloading a replacement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mb-core-unit-')); let downloads = 0;
  try {
    const bundles = path.join(directory, 'bundles'); await mkdir(bundles);
    const core = new MihomoCore(directory, async () => { downloads++; throw new Error('not allowed'); }, bundles);
    await writeFile(path.join(bundles, core.artifact!.file), 'invalid official archive');
    expect(core.status().bundled).toBe(true); await expect(core.ensure()).rejects.toThrow('校验失败');
    expect(core.status()).toMatchObject({ downloading: false, installed: false, error: expect.stringContaining('校验失败') });
    expect(downloads).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
