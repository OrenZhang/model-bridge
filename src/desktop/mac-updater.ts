import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validateMacArchive } from './mac-update-archive.js';

const run = promisify(execFile);
const Job = z.object({ format: z.literal(1), id: z.uuid(), token: z.uuid(), target: z.string(), incoming: z.string(), workspace: z.string(), oldVersion: z.string(), version: z.string(), oldPid: z.number().int().min(2), executable: z.string(), sourceInode: z.string() });
export type MacUpdateJob = z.infer<typeof Job>;
export function macApplication(executable: string) {
  const bundle = path.resolve(path.dirname(executable), '../..');
  if (!bundle.endsWith('.app') || path.basename(path.dirname(executable)) !== 'MacOS') throw new Error('请从已安装的 macOS 应用中更新。');
  return bundle;
}
async function checksum(file: string) { const hash = createHash('sha512'); for await (const data of createReadStream(file)) hash.update(data); return hash.digest('base64'); }
async function plist(app: string, field: string) { return (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${field}`, path.join(app, 'Contents/Info.plist')])).stdout.trim(); }
async function team(app: string) {
  try { const result = await run('/usr/bin/codesign', ['-dv', '--verbose=4', app]); return /^TeamIdentifier=([A-Z0-9]+)$/m.exec(result.stderr)?.[1]; }
  catch { return undefined; }
}
async function checkBundle(app: string, identifier: string, version: string, arch: string, expectedTeam?: string) {
  if (await plist(app, 'CFBundleIdentifier') !== identifier || await plist(app, 'CFBundleShortVersionString') !== version) throw new Error('更新包的应用标识或版本不匹配。');
  const executable = await plist(app, 'CFBundleExecutable');
  if (!executable || executable !== path.basename(executable) || /[\\\x00-\x1f]/.test(executable)) throw new Error('更新包的应用程序路径无效。');
  const binary = path.join(app, 'Contents/MacOS', executable);
  const architectures = (await run('/usr/bin/lipo', ['-archs', binary])).stdout.split(/\s+/);
  if (!architectures.includes(arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('更新包的处理器架构不匹配。');
  await access(binary, constants.X_OK);
  const signer = await team(app);
  if (expectedTeam && signer !== expectedTeam) throw new Error('更新包签名与现有应用的开发者不匹配。');
  if (signer) await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  // Link destinations have already been inspected in the ZIP; confirm extraction
  // produced only links resolving within the resulting app bundle as well.
  const root = await realpath(app); const pending = [app];
  while (pending.length) for (const item of await readdir(pending.pop()!, { withFileTypes: true })) {
    const file = path.join(item.parentPath, item.name);
    if (item.isSymbolicLink()) { const destination = await realpath(file); if (destination !== root && !destination.startsWith(root + path.sep)) throw new Error('更新包链接超出应用目录。'); }
    else if (item.isDirectory()) pending.push(file);
  }
  return executable;
}
export interface MacUpdateOptions {
  archive: string; sha512: string; version: string; currentVersion: string; currentApp: string; updatesDirectory: string;
  applicationId: string; arch?: string; pid?: number; helperDirectory?: string; startupTimeoutSeconds?: number;
}
export async function prepareMacUpdate(options: MacUpdateOptions) {
  if (process.platform !== 'darwin') throw new Error('此更新方式仅用于 macOS。');
  const target = await realpath(options.currentApp); const parent = path.dirname(target);
  if (!target.endsWith('.app') || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) throw new Error('请先将应用安装到本地可写目录，再进行一键更新。');
  try { await access(parent, constants.W_OK); } catch { throw new Error('应用安装目录不可写。请使用当前账号可写的应用目录后重试。'); }
  const source = await lstat(target, { bigint: true });
  if (!source.isDirectory() || await plist(target, 'CFBundleIdentifier') !== options.applicationId || await plist(target, 'CFBundleShortVersionString') !== options.currentVersion) throw new Error('当前应用已变化，请重新启动后检查更新。');
  const jobsPath = path.join(options.updatesDirectory, 'mac-jobs'); await mkdir(jobsPath, { recursive: true, mode: 0o700 });
  const jobsRoot = await realpath(jobsPath);
  const id = randomUUID(), directory = path.join(jobsRoot, id); await mkdir(directory, { mode: 0o700 });
  const workspace = await mkdtemp(path.join(parent, '.model-bridge-update-')); await chmod(workspace, 0o700);
  try {
    const payload = path.join(directory, 'payload.zip'); await run('/usr/bin/ditto', [options.archive, payload]); await chmod(payload, 0o600);
    if (await checksum(payload) !== options.sha512) throw new Error('安装包校验失败，请重新下载。');
    await validateMacArchive(payload);
    const helper = path.join(directory, 'helper');
    await writeFile(helper, await readFile(path.join(options.helperDirectory ?? path.dirname(fileURLToPath(import.meta.url)), 'mac-update-helper')), { flag: 'wx', mode: 0o700 });
    // Confirm the filesystem supports atomic directory exchange before quitting.
    const first = path.join(workspace, 'probe-a'), second = path.join(workspace, 'probe-b'); await mkdir(first); await mkdir(second);
    await run(helper, ['--swap', first, second]); await rm(first, { recursive: true }); await rm(second, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', payload, workspace], { timeout: 120000 }); await rm(payload);
    const incoming = path.join(workspace, 'Model Bridge.app');
    const executable = await checkBundle(incoming, options.applicationId, options.version, options.arch ?? process.arch, await team(target));
    const job = Job.parse({ format: 1, id, token: randomUUID(), target, incoming, workspace, oldVersion: options.currentVersion, version: options.version, oldPid: options.pid ?? process.pid, executable, sourceInode: String(source.ino) });
    await writeFile(path.join(directory, 'job.json'), JSON.stringify(job), { mode: 0o600 });
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ phase: 'prepared' }), { mode: 0o600 });
    let started = false;
    return { directory, job,
      async discard() { if (!started) { await rm(workspace, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); } },
      async start() {
        if (started) throw new Error('更新已经开始。');
        const log = await open(path.join(directory, 'helper.log'), 'a', 0o600);
        const child = spawn(helper, [String(job.oldPid), target, incoming, directory, job.token, String(options.startupTimeoutSeconds ?? 180), executable, job.sourceInode], { detached: true, stdio: ['ignore', log.fd, log.fd] });
        let spawnError: unknown; child.once('error', error => { spawnError = error; }); child.unref(); await log.close();
        try {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (spawnError) throw spawnError;
            const ready = await readFile(path.join(directory, 'helper-ready'), 'utf8').catch(() => '');
            if (ready === job.token) { await writeFile(path.join(directory, 'apply'), job.token, { mode: 0o600 }); started = true; return; }
            if (child.exitCode !== null) break;
            await delay(25);
          }
          throw new Error('更新助手启动失败，现有应用仍可继续使用。');
        } catch (error) { child.kill('SIGTERM'); throw error; }
      },
    };
  } catch (error) { await rm(workspace, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); throw error; }
}

async function readUpdateJob(args: string[], flag: string, updatesDirectory: string) {
  if (process.platform !== 'darwin') return;
  const index = args.indexOf(flag);
  if (index < 0) return;
  const directory = args[index + 1], token = args[index + 2]; if (!directory || !token) return;
  const jobsRoot = await realpath(path.join(updatesDirectory, 'mac-jobs')).catch(() => '');
  const actual = await realpath(directory).catch(() => '');
  if (!jobsRoot || path.dirname(actual) !== jobsRoot) return;
  const info = await lstat(actual); if (info.uid !== process.getuid?.() || (info.mode & 0o077)) return;
  const job = Job.parse(JSON.parse(await readFile(path.join(actual, 'job.json'), 'utf8')));
  if (job.id !== path.basename(actual) || job.token !== token) return;
  if (flag === '--model-bridge-update') {
    const state = JSON.parse(await readFile(path.join(actual, 'state.json'), 'utf8'));
    if (!['applying', 'awaiting-startup'].includes(state.phase)) return;
  }
  return { job, actual, token };
}
export async function macUpdateAttempt(args: string[], updatesDirectory: string, currentApp: string, version: string) {
  const found = await readUpdateJob(args, '--model-bridge-update', updatesDirectory);
  if (!found || found.job.version !== version || found.job.target !== await realpath(currentApp)) return;
  const { actual, token } = found;
  await writeFile(path.join(actual, 'launched'), `${token}\n${process.pid}\n`, { mode: 0o600 });
  return { async ready() { await writeFile(path.join(actual, 'ready'), token, { mode: 0o600 }); }, async failed(error?: unknown) {
    await writeFile(path.join(actual, 'startup-error.json'), JSON.stringify({ message: error instanceof Error ? error.message.slice(0, 500) : 'Startup failed' }), { mode: 0o600 }).catch(() => {});
    await writeFile(path.join(actual, 'failed'), token, { mode: 0o600 });
  } };
}
export async function macUpdateRollbackNotice(args: string[], updatesDirectory: string, currentApp: string, version: string) {
  const found = await readUpdateJob(args, '--model-bridge-update-rollback', updatesDirectory);
  if (!found || found.job.oldVersion !== version || found.job.target !== await realpath(currentApp)) return;
  const state = JSON.parse(await readFile(path.join(found.actual, 'state.json'), 'utf8'));
  if (['rolled-back', 'failed'].includes(state.phase)) return '更新未能完成，已保留或恢复原版本。账号与配置未被替换，可重新检查更新后重试。';
}
