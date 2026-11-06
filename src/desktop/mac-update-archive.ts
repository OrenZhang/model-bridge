import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

// Inspect central-directory paths and link destinations before ditto extracts.
// Update archives are bounded ZIPs produced by our release pipeline, not ZIP64.
export async function validateMacArchive(file: string, root = 'Model Bridge.app') {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset: number, length: number) => {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error('更新包 ZIP 结构损坏。');
      const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('更新包 ZIP 内容不完整。'); return buffer;
    };
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557)); let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('更新包不是支持的单卷 ZIP。');
    const entries = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (!entries || entries === 0xffff || entries > 20000 || length > 16 * 1024 * 1024 || offset === 0xffffffff) throw new Error('更新包 ZIP 目录超出支持范围。');
    const central = await read(offset, length); const names = new Set<string>(); const links = new Map<string, string>(); let cursor = 0; let hasInfo = false;
    const inside = (name: string) => name === root || name.startsWith(root + '/');
    const key = (name: string) => name.normalize('NFD').toLowerCase();
    for (let i = 0; i < entries; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('更新包 ZIP 目录无效。');
      const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20), nameLength = central.readUInt16LE(cursor + 28), extra = central.readUInt16LE(cursor + 30), comment = central.readUInt16LE(cursor + 32);
      const attrs = central.readUInt32LE(cursor + 38), localOffset = central.readUInt32LE(cursor + 42);
      if (cursor + 46 + nameLength + extra + comment > central.length || (flags & 1) || ![0, 8].includes(method)) throw new Error('更新包含不支持的压缩内容。');
      const rawName = new TextDecoder('utf-8', { fatal: true }).decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
      const header = await read(localOffset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== method || header.readUInt16LE(26) !== nameLength || !(await read(localOffset + 30, nameLength)).equals(central.subarray(cursor + 46, cursor + 46 + nameLength))) throw new Error('更新包 ZIP 本地路径与目录不一致。');
      const name = rawName.replace(/\/$/, ''); const parts = name.split('/'); const type = (attrs >>> 16) & 0xf000;
      if (/[\\\x00-\x1f]/.test(name) || parts.some(p => !p || p === '.' || p === '..') || (!inside(name) && name !== '__MACOSX' && !name.startsWith('__MACOSX/')) || ![0, 0x4000, 0x8000, 0xa000].includes(type)) throw new Error('更新包含越界路径或特殊文件。');
      if (names.has(key(name))) throw new Error('更新包含重复或大小写冲突的路径。'); names.add(key(name));
      if (name === `${root}/Contents/Info.plist`) hasInfo = true;
      if (type === 0xa000) {
        if (!inside(name) || compressed > 65536) throw new Error('更新包含不安全的符号链接。');
        const data = await read(localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), compressed);
        const target = new TextDecoder('utf-8', { fatal: true }).decode(method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data);
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        if (path.posix.isAbsolute(target) || /[\\\x00-\x1f]/.test(target) || !inside(resolved)) throw new Error('更新包符号链接指向应用目录之外。');
        links.set(key(name), key(resolved));
      }
      cursor += 46 + nameLength + extra + comment;
    }
    if (!hasInfo || cursor !== central.length) throw new Error('更新包缺少应用信息或目录不完整。');
    // Reject link cycles, including a parent link redirected through another link.
    for (const name of names) {
      let current = name; const seen = new Set<string>();
      for (let depth = 0; depth <= links.size; depth++) {
        if (seen.has(current)) throw new Error('更新包含循环符号链接。'); seen.add(current);
        const parts = current.split('/'); let replaced = false;
        for (let i = 1; i <= parts.length; i++) {
          const target = links.get(parts.slice(0, i).join('/')); if (!target) continue;
          current = path.posix.join(target, ...parts.slice(i)); replaced = true; break;
        }
        if (!replaced) break;
        if (depth === links.size) throw new Error('更新包符号链接层级过深。');
      }
    }
    return { entries, links: links.size };
  } finally { await handle.close(); }
}
