import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/ui', { recursive: true });
await build({ entryPoints: ['src/ui/app.ts'], bundle: true, outfile: 'dist/ui/app.js', platform: 'browser', target: 'es2022' });
await build({ entryPoints: ['src/desktop/preload.cts'], bundle: true, outfile: 'dist/desktop/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'] });
for (const file of ['index.html', 'style.css']) await copyFile(`src/ui/${file}`, `dist/ui/${file}`);
