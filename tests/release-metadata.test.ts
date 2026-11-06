import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';
import { mergeReleaseUpdates } from '../scripts/merge-release-updates.mjs';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'mb-release-')); directories.push(root); const input = path.join(root, 'artifacts'); await mkdir(input); return { input, output: path.join(root, 'upload') }; }
async function architecture(input: string, arch: string, version = '0.1.0-alpha.2', corrupt = false) {
  const dir = path.join(input, arch); await mkdir(dir);
  const name = `Model-Bridge-${version}-mac-${arch}.dmg`; const content = Buffer.from(arch);
  await writeFile(path.join(dir, name), content);
  await writeFile(path.join(dir, 'alpha-mac.yml'), stringify({ version, files: [{ url: name, sha512: createHash('sha512').update(corrupt ? 'wrong' : content).digest('base64'), size: content.length }], path: name, releaseDate: '2026-11-06T00:00:00Z' }));
  return name;
}
it('merges both Mac architectures into one channel file and retains verified installers', async () => {
  const f = await fixture(); const arm = await architecture(f.input, 'arm64'); const intel = await architecture(f.input, 'x64');
  expect(await mergeReleaseUpdates(f.input, f.output)).toEqual({ packages: 2, manifests: 1 });
  const info = parse(await readFile(path.join(f.output, 'alpha-mac.yml'), 'utf8'));
  expect(info.files.map(x => x.url).sort()).toEqual([arm, intel].sort()); expect(await readFile(path.join(f.output, arm), 'utf8')).toBe('arm64');
});
it('blocks publishing mixed versions or installers with the wrong checksum', async () => {
  const f = await fixture(); await architecture(f.input, 'arm64'); await architecture(f.input, 'x64', '0.1.0-alpha.3');
  await expect(mergeReleaseUpdates(f.input, f.output)).rejects.toThrow('Mixed release versions');
  const bad = await fixture(); await architecture(bad.input, 'arm64', undefined, true);
  await expect(mergeReleaseUpdates(bad.input, bad.output)).rejects.toThrow('checksum');
});
it('blocks missing installer assets', async () => {
  const f = await fixture(); const name = await architecture(f.input, 'arm64'); await rm(path.join(f.input, 'arm64', name));
  await expect(mergeReleaseUpdates(f.input, f.output)).rejects.toThrow('Missing release asset');
});
it('publishes a preview-channel alias when GitHub builds emit only latest metadata', async () => {
  const f = await fixture(); await architecture(f.input, 'arm64');
  const dir = path.join(f.input, 'arm64'); const info = await readFile(path.join(dir, 'alpha-mac.yml'), 'utf8');
  await rm(path.join(dir, 'alpha-mac.yml')); await writeFile(path.join(dir, 'latest-mac.yml'), info);
  expect(await mergeReleaseUpdates(f.input, f.output)).toEqual({ packages: 1, manifests: 2 });
  expect(await readFile(path.join(f.output, 'alpha-mac.yml'), 'utf8')).toBe(await readFile(path.join(f.output, 'latest-mac.yml'), 'utf8'));
});
