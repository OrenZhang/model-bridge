import { build } from 'esbuild';
await build({ entryPoints: ['src/clients/portable-installer.ts'], bundle: true, outfile: 'dist/clients/portable-installer.cjs', platform: 'node', format: 'cjs', target: 'node18', minify: true, legalComments: 'inline' });
