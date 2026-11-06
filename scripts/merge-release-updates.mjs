import { readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function mergeReleaseUpdates(input, output) {
  await mkdir(output, { recursive: true });
  const manifests = new Map();
  const packages = new Set();
  for (const entry of await readdir(input, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(entry.parentPath ?? entry.path, entry.name);
    if (/^(alpha|beta|latest)(?:-mac|-linux(?:-arm64)?)?\.yml$/.test(entry.name)) {
      const data = parse(await readFile(source, 'utf8'));
      if (!data.version || !Array.isArray(data.files) || !data.files.length) throw new Error(`Invalid update manifest: ${entry.name}`);
      const merged = manifests.get(entry.name);
      if (merged && merged.version !== data.version) throw new Error('Mixed release versions.');
      if (merged) {
        for (const file of data.files) {
          const previous = merged.files.find(f => f.url === file.url);
          if (previous && previous.sha512 !== file.sha512) throw new Error(`Conflicting checksum: ${file.url}`);
          if (!previous) merged.files.push(file);
        }
      } else manifests.set(entry.name, data);
    } else if (/\.(dmg|zip|exe|AppImage|deb|blockmap)$/.test(entry.name)) {
      if (packages.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
      await copyFile(source, path.join(output, entry.name)); packages.add(entry.name);
    }
  }
  for (const [name, manifest] of manifests) {
    for (const file of manifest.files) {
      if (!packages.has(file.url)) throw new Error(`Missing release asset: ${file.url}`);
      const hash = createHash('sha512');
      for await (const chunk of createReadStream(path.join(output, file.url))) hash.update(chunk);
      if (hash.digest('base64') !== file.sha512) throw new Error(`Invalid asset checksum: ${file.url}`);
    }
    await writeFile(path.join(output, name), stringify(manifest));
  }
  if (!manifests.size || !packages.size) throw new Error('No release packages or update manifests found.');
  return { packages: packages.size, manifests: manifests.size };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await mergeReleaseUpdates(process.argv[2] ?? 'release-artifacts', process.argv[3] ?? 'release-upload'));
}
