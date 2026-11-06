// Bundle only the target platform's pinned, unmodified official archive.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'src/network/mihomo-artifacts.json'), 'utf8'));
const key = `${process.platform}-${process.arch}`;
const artifact = manifest.artifacts[key];
if (!artifact) throw new Error(`Unsupported Mihomo target: ${key}`);
const directory = path.join(root, 'assets/mihomo'); await mkdir(directory, { recursive: true });
const file = path.join(directory, artifact.file);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let bytes = await readFile(file).catch(() => undefined);
if (!bytes || hash(bytes) !== artifact.sha256) {
  // Optional explicit proxy is for local packaging; CI downloads directly from GitHub.
  const { fetch, ProxyAgent } = await import('undici');
  const agent = process.env.MODEL_BRIDGE_BUILD_PROXY ? new ProxyAgent(process.env.MODEL_BRIDGE_BUILD_PROXY) : undefined;
  try {
    const r = await fetch(`https://github.com/MetaCubeX/mihomo/releases/download/${manifest.version}/${artifact.file}`, { dispatcher: agent, signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`Mihomo download failed: HTTP ${r.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of r.body) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Mihomo archive too large'); chunks.push(chunk); }
    bytes = Buffer.concat(chunks);
    if (hash(bytes) !== artifact.sha256) throw new Error('Mihomo SHA-256 mismatch');
    await writeFile(file, bytes);
  } finally { await agent?.destroy(); }
}
console.log(`Bundled verified Mihomo ${manifest.version} for ${key} (${bytes.length} bytes)`);
