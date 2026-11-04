// Rebuild the original Model Bridge icon without platform-specific tools.
// The SVG and raster renderer share the same rounded tile and double arch geometry.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const destination = fileURLToPath(new URL('../assets/', import.meta.url));
await mkdir(destination, { recursive: true });
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>Model Bridge</title>
  <defs><linearGradient id="tile" x1="0" y1="64" x2="0" y2="960" gradientUnits="userSpaceOnUse"><stop stop-color="#36705c"/><stop offset="1" stop-color="#1f503f"/></linearGradient></defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#tile)"/>
  <path d="M268 680V464a122 122 0 0 1 244 0v216M512 464a122 122 0 0 1 244 0v216" fill="none" stroke="#f4f8f0" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
await writeFile(path.join(destination, 'icon.svg'), svg);

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(name, 4);
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name), data])));
  return Buffer.concat([header, data, trailer]);
}
const stemDistance = (x, y, center) => Math.hypot(x - center, y - Math.max(464, Math.min(680, y)));
const archDistance = (x, y, center) => y <= 464 ? Math.abs(Math.hypot(x - center, y - 464) - 122) : Infinity;
function render(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const samples = 4; const scale = 1024 / size;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let red = 0; let green = 0; let blue = 0; let coverage = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = (px + (sx + .5) / samples) * scale; const y = (py + (sy + .5) / samples) * scale;
      const qx = Math.abs(x - 512) - 248; const qy = Math.abs(y - 512) - 248;
      if (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) > 200) continue;
      coverage++;
      const mark = Math.min(stemDistance(x, y, 268), stemDistance(x, y, 512), stemDistance(x, y, 756), archDistance(x, y, 390), archDistance(x, y, 634)) <= 48;
      const t = (y - 64) / 896;
      red += mark ? 244 : 54 - 23 * t; green += mark ? 248 : 112 - 32 * t; blue += mark ? 240 : 92 - 29 * t;
    }
    const offset = py * (size * 4 + 1) + 1 + px * 4;
    if (coverage) { rows[offset] = Math.round(red / coverage); rows[offset + 1] = Math.round(green / coverage); rows[offset + 2] = Math.round(blue / coverage); }
    rows[offset + 3] = Math.round(255 * coverage / (samples * samples));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map(sizes.map(size => [size, render(size)]));
await writeFile(path.join(destination, 'icon.png'), images.get(1024));
await writeFile(path.join(destination, 'icon-256.png'), images.get(256));

const icoSizes = sizes.filter(size => size <= 256);
const icoHeader = Buffer.alloc(6); icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(icoSizes.length, 4);
let offset = 6 + 16 * icoSizes.length;
const icoDirectory = icoSizes.map(size => {
  const entry = Buffer.alloc(16); entry[0] = entry[1] = size === 256 ? 0 : size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(images.get(size).length, 8); entry.writeUInt32LE(offset, 12);
  offset += images.get(size).length; return entry;
});
await writeFile(path.join(destination, 'icon.ico'), Buffer.concat([icoHeader, ...icoDirectory, ...icoSizes.map(size => images.get(size))]));

const icnsTypes = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']];
const icnsEntries = icnsTypes.map(([size, type]) => {
  const bytes = images.get(size); const header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(bytes.length + 8, 4); return Buffer.concat([header, bytes]);
});
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns'); icnsHeader.writeUInt32BE(8 + icnsEntries.reduce((sum, bytes) => sum + bytes.length, 0), 4);
await writeFile(path.join(destination, 'icon.icns'), Buffer.concat([icnsHeader, ...icnsEntries]));
console.log('Generated assets/icon.svg, icon.png, icon-256.png, icon.ico and icon.icns');
