import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';

export function codexBinary() {
  const require = createRequire(import.meta.url);
  const platform = process.platform;
  const arch = process.arch;
  const triples: Record<string, string> = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' };
  const triple = triples[`${platform}-${arch}`];
  if (!triple) throw new Error('This CPU architecture does not have a bundled Codex authentication helper.');
  const root = path.dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`));
  const binary = path.join(root, 'vendor', triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
  const unpacked = binary.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  if (!existsSync(unpacked)) throw new Error('The Codex authentication helper is missing. Reinstall Model Bridge.');
  return unpacked;
}
