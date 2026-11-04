import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
const [binary, directory, config] = process.argv.slice(2);
if (!binary || !directory || !config || !process.send) process.exit(1);
const child = spawn(binary, ['-d', directory, '-f', config], { windowsHide: true, stdio: 'ignore', env: process.env });
let stopping = false;
function stop() { if (stopping) return; stopping = true; child.kill(); setTimeout(() => child.kill('SIGKILL'), 1500).unref(); }
process.on('disconnect', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.once('error', () => { void rm(directory, { recursive: true, force: true }).finally(() => process.exit(1)); });
child.once('exit', code => { void rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).finally(() => process.exit(code ?? 0)); });
