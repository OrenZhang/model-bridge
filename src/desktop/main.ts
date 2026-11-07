import { managedModels, models } from '../core/catalog.js';
import { app, BrowserWindow, ipcMain, session, shell, dialog, Tray, Menu, nativeImage, powerSaveBlocker, type MenuItemConstructorOptions } from 'electron';
import electronUpdater from 'electron-updater';
import { DesktopUpdates, RELEASES_URL } from './updates.js';
import { updateProxyRules, chooseUpdateProxy, environmentUpdateProxies, type UpdateProxy } from './update-network.js';
import { UpdateTransport } from './update-transport.js';
import { macApplication, macUpdateAttempt, macUpdateRollbackNotice, prepareMacUpdate } from './mac-updater.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { createRuntime, type Runtime } from '../core/runtime.js';
import { DesktopVault } from './vault.js';
import { usageCsv, usageView, usageSummary, USAGE_RETENTION_DAYS } from '../core/usage.js';
import { resolveClientAddress } from '../clients/configure.js';
import { atomicWrite } from '../core/store.js';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import { ConnectionSchema, SearchConfigSchema } from '../core/config.js';
import { WebSearch } from '../core/web-search.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Model Bridge');
let runtime: Runtime | undefined; let window: BrowserWindow | undefined; let tray: Tray | undefined; let quitting = false;
let updates: DesktopUpdates | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;
let updateAttempt: Awaited<ReturnType<typeof macUpdateAttempt>>;
let desktopReady = false;
let awakeBlocker: number | undefined;
function showWindow() { if (process.platform === 'darwin') void app.dock?.show(); else window?.setSkipTaskbar(false); window?.show(); window?.focus(); }
function hideWindow() { window?.hide(); if (process.platform === 'darwin') app.dock?.hide(); else window?.setSkipTaskbar(true); }

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    showWindow();
    // A user may open the newly swapped app just before the helper launches it.
    // Accept the helper's authenticated startup context on the existing instance.
    if (process.platform === 'darwin' && app.isPackaged && args.includes('--model-bridge-update')) void app.whenReady().then(async () => {
      const data = process.env.MODEL_BRIDGE_DATA_DIR ? path.resolve(process.env.MODEL_BRIDGE_DATA_DIR) : app.getPath('userData');
      const attempt = await macUpdateAttempt(args, path.join(data, 'updates'), macApplication(process.execPath), app.getVersion());
      if (attempt) { updateAttempt = attempt; if (desktopReady) await attempt.ready(); }
    }).catch(() => {});
  });
  app.on('activate', showWindow);
  app.on('will-quit', () => { if (awakeBlocker !== undefined) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = undefined; } });
  app.on('before-quit', event => { if (quitting) return; event.preventDefault(); quitting = true; updates?.close(); clearInterval(updateTimer); void runtime?.close().finally(() => app.quit()); if (!runtime) app.quit(); });
  void app.whenReady().then(async () => {
  try {
    // Keep the gateway reachable while the window is hidden in the tray.
    // Display sleep remains allowed; the assertion ends with the application.
    awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
    const applicationIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));
    if (process.platform === 'darwin') app.dock?.setIcon(applicationIcon);
    const data = process.env.MODEL_BRIDGE_DATA_DIR ? path.resolve(process.env.MODEL_BRIDGE_DATA_DIR) : app.getPath('userData');
    if (process.platform === 'darwin' && app.isPackaged && process.argv.includes('--model-bridge-update')) {
      updateAttempt = await macUpdateAttempt(process.argv, path.join(data, 'updates'), macApplication(process.execPath), app.getVersion());
      if (!updateAttempt) throw new Error('更新启动信息无效。');
    }
    const vault = new DesktopVault(path.join(data, 'credentials.enc'));
    runtime = await createRuntime(data, vault, os.homedir(), async destination => {
      const resolution = await session.defaultSession.resolveProxy(destination);
      const first = resolution.split(';')[0]?.trim();
      if (!first || first === 'DIRECT') return undefined;
      const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+(.+)$/.exec(first);
      if (!match) throw new Error('The system proxy type is unsupported. Configure an HTTP or SOCKS5 proxy.');
      return `${match[1] === 'PROXY' ? 'http' : match[1] === 'HTTPS' ? 'https' : 'socks5'}://${match[2]}`;
    }, process.env.MODEL_BRIDGE_CODEX_BINARY);
    for (const client of ['codex', 'claude', 'generic'] as const) await runtime.ensureClient(client);
    const active = runtime;
    const { autoUpdater } = electronUpdater;
    const updateTransport = new UpdateTransport(autoUpdater.netSession);
    autoUpdater.on('login', updateTransport.login);
    let probeSequence = 0;
    updates = new DesktopUpdates({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      directory: path.join(data, 'updates'), engine: autoUpdater,
      fetch: updateTransport.fetch,
      prepareNetwork: async target => {
        const candidates: UpdateProxy[] = [];
        try { const url = updateProxyRules(await session.defaultSession.resolveProxy(target)); if (url) candidates.push({ url, label: '系统代理' }); } catch { /* Other configured proxies remain available. */ }
        candidates.push(...environmentUpdateProxies(process.env));
        const config = active.store.get();
        for (const profile of config.proxies) {
          try {
            const connection = ConnectionSchema.parse({ id: 'update-probe', name: 'Update probe', provider: 'custom', auth: 'none', baseUrl: 'https://github.com', proxy: { mode: 'proxy', profileId: profile.id } });
            const url = await active.network.proxyUrl(connection, target);
            if (url) candidates.push({ url, label: `独立代理：${profile.name}` });
          } catch { /* A missing credential in one proxy must not block updating. */ }
        }
        const probe = async (candidate: UpdateProxy, parent: AbortSignal) => {
          const transport = new UpdateTransport(session.fromPartition(`update-probe-${process.pid}-${++probeSequence}`, { cache: false }));
          try {
            await transport.apply(candidate);
            const response = await transport.fetch(target, { headers: { range: 'bytes=0-16383' }, signal: AbortSignal.any([parent, AbortSignal.timeout(4500)]) });
            const ok = [200, 206].includes(response.status);
            if (ok && response.body) { const reader = response.body.getReader(); await reader.read(); await reader.cancel(); }
            else await response.body?.cancel();
            return ok;
          } catch { return false; }
          finally { await transport.session.closeAllConnections(); }
        };
        let selected = await chooseUpdateProxy(candidates, probe);
        if (!selected) {
          for (const profile of config.networkProfiles) {
            try { selected = await chooseUpdateProxy(await active.managed.updateProxies(profile.id), probe); } catch { /* Try the next subscription. */ }
            if (selected) break;
          }
        }
        await updateTransport.apply(selected);
        return { mode: selected ? 'proxy' : 'direct', label: selected?.label ?? '直连（未检测到可用代理）' };
      },
      directNetwork: () => updateTransport.apply(),
      readyToInstall: () => active.gateway.activeRequests() === 0,
      installMacUpdate: async (archive, version, sha512) => {
        if (active.gateway.activeRequests()) throw new Error('仍有模型请求进行中，请等待完成后再安装更新。');
        const prepared = await prepareMacUpdate({ archive, sha512, version, currentVersion: app.getVersion(), currentApp: macApplication(process.execPath), applicationId: 'io.github.orenzhang.modelbridge', updatesDirectory: path.join(data, 'updates') });
        try {
          if (active.gateway.activeRequests()) throw new Error('仍有模型请求进行中，请等待完成后再安装更新。');
          await prepared.start(); app.quit();
        } catch (error) { await prepared.discard(); throw error; }
      },
      installAndRestart: async () => {
        if (active.gateway.activeRequests()) throw new Error('仍有模型请求进行中，请等待完成后再安装更新。');
        // Use the normal before-quit handler to drain the gateway. If launching
        // the installer fails, keep the running gateway and the retry UI alive.
        autoUpdater.quitAndInstall(false, true);
      },
      changed: state => { if (window && !window.isDestroyed()) window.webContents.send('model-bridge-update', state); },
    });
    const updateRecovery = process.platform === 'darwin' && app.isPackaged ? await macUpdateRollbackNotice(process.argv, path.join(data, 'updates'), macApplication(process.execPath), app.getVersion()).catch(() => undefined) : undefined;
    if (updateRecovery) updates.reportRecovery(updateRecovery);
    void active.localAccounts.scan();
    ipcMain.handle('model-bridge', async (event, operation: string, payload: any) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame) throw new Error('Invalid sender.');
      try {
        switch (operation) {
          case 'update.check': await updates!.check(); return updates!.snapshot();
          case 'update.check-install': await updates!.checkAndInstall(); return updates!.snapshot();
          case 'update.download': void updates!.download(); return updates!.snapshot();
          case 'update.install': await updates!.install(); return updates!.snapshot();
          case 'update.releases': await shell.openExternal(RELEASES_URL); return true;
          case 'state': {
            const days = z.number().int().min(1).max(USAGE_RETENTION_DAYS).parse(payload?.days ?? USAGE_RETENTION_DAYS);
            const filters = z.object({ clientId: z.string().optional(), provider: z.string().optional(), connectionId: z.string().optional(), model: z.string().optional() }).parse(payload?.filters ?? {});
            const records = await active.usage.list(days);
            const config = active.store.get(); const address = active.gateway.address;
            const view=usageView(records,filters,days);
            const [codex, claude] = await Promise.all(['codex', 'claude'].map(client => active.clients.status(client as 'codex' | 'claude', config, address)));
            const modelCatalog = models(config).map(entry => ({ id: entry.id, name: entry.model.name, provider: entry.connection.provider, tools: entry.model.tools, members: entry.members.map(r => ({ connectionId: r.connection.id, modelId: r.model.id, name: r.connection.name, model: r.model.upstreamId })) }));
            return { config, update: updates!.snapshot(), accessKeys:config.clients.filter(c=>!['codex','claude','generic'].includes(c.id)).map(c=>({id:c.id,name:c.name,enabled:c.enabled,...usageSummary(records.filter(r=>r.clientId===c.id))})), address, modelCatalog, managedModels: managedModels(config).map(entry => ({ id: entry.id, name: entry.model.name, provider: entry.connection.provider, enabled: entry.enabled, mixed: entry.mixed, exposedAccounts: entry.exposedAccounts, members: entry.members.map(m => ({connectionId:m.connection.id,modelId:m.model.id,name:m.connection.name,model:m.model.upstreamId})) })), clientStatuses: { codex, claude }, lanAddresses: active.gateway.lanAddresses(), lanInterfaces: active.gateway.lanInterfaces(), managedNetworks: active.managed.overview(), logins: active.loginStates(), connectionChecks: active.connectionStates(), discoveries: active.discoveryStates(), localAccounts: active.localAccounts.list(), ...view,usageOptions:{...view.usageOptions,clientId:[...new Set([...(view.usageOptions.clientId??[]),...config.clients.map(c=>c.id)])]}, usageWriteFailed: active.usageWriteFailed() };
          }
          case 'connection.save': return active.saveConnection(payload.connection, payload.apiKey ? z.string().max(20000).parse(payload.apiKey) : undefined, payload.autoDiscover !== false);
          case 'model.exposure': return active.setModelExposure(z.string().parse(payload.id), z.boolean().parse(payload.enabled));
          case 'connection.discover': return active.discover(z.string().parse(payload.id));
          case 'connection.delete': {
            const config = active.store.get(); const id = z.string().parse(payload.id);
            const existing = config.connections.find(c => c.id === id);
            if (existing && ['chatgpt-device', 'subscription'].includes(existing.auth)) await active.loginFor(id).logout();
            const updated = await active.store.update(current => { current.connections = current.connections.filter(c => c.id !== id); }); await active.clients.updateCatalog(updated); return true;
          }
          case 'device.login': {
            const state = await active.startLogin(z.string().parse(payload.id));
            if (state.phase === 'waiting' && state.method === 'browser' && state.verificationUrl) await shell.openExternal(state.verificationUrl);
            return state;
          }
          case 'device.cancel': return active.loginFor(z.string().parse(payload.id)).cancel();
          case 'device.open': { const url = active.loginFor(z.string().parse(payload.id)).state.verificationUrl; if (url) await shell.openExternal(url); return true; }
          case 'local.detect': return active.localAccounts.scan();
          case 'local.import': return active.importLocalAccount(z.string().parse(payload.id));
          case 'access.create': return active.createAccessKey(z.string().trim().min(1).max(100).parse(payload.name));
          case 'access.update': return active.updateAccessKey(z.string().parse(payload.id),z.object({name:z.string().trim().min(1).max(100).optional(),enabled:z.boolean().optional()}).parse(payload));
          case 'access.copy': {const {clipboard}=await import('electron');clipboard.writeText(await active.accessKey(z.string().parse(payload.id)));return true;}
          case 'service.lan': return active.setLanAccess(z.boolean().parse(payload.enabled));
          case 'search.save': {
            const form = z.object({
              provider: z.enum(['off', 'searxng', 'tavily']), baseUrl: z.string().optional(),
              apiKey: z.string().trim().max(512).optional(),
            }).parse(payload);
            const replacement = form.provider === 'tavily' && form.apiKey ? `search:tavily:${randomUUID()}` : undefined;
            if (replacement) await vault.set(replacement, form.apiKey!);
            await active.store.update(current => {
              if (form.provider === 'off') {
                delete current.webSearch;
              } else if (form.provider === 'searxng') {
                current.webSearch = SearchConfigSchema.parse({ provider: 'searxng', baseUrl: form.baseUrl?.trim() });
              } else {
                const secretRef = replacement ?? (current.webSearch?.provider === 'tavily' ? current.webSearch.secretRef : undefined);
                if (!secretRef) throw new Error('请输入 Tavily API Key。');
                current.webSearch = { provider: 'tavily', secretRef };
              }
            });
            return true;
          }
          case 'search.test': {
            const settings = active.store.get().webSearch;
            if (!settings) throw new Error('请先保存搜索服务。');
            const sources = await new WebSearch(active.network, vault).search(settings, 'SQLite write-ahead logging', [], new AbortController().signal);
            if (!sources.length) throw new Error('搜索服务已连接，但测试查询没有返回来源。');
            return sources.length;
          }
          case 'network.save': return active.managed.save(payload);
          case 'network.refresh': return active.managed.refresh(z.string().parse(payload.id));
          case 'network.select': return active.managed.select(z.string().parse(payload.id), z.string().parse(payload.node));
          case 'network.auto': return active.managed.automatic(z.string().parse(payload.id));
          case 'network.check': return active.managed.check(z.string().parse(payload.id));
          case 'network.remove': return active.managed.remove(z.string().parse(payload.id));
          case 'network.install': return active.managed.core.ensure();
          case 'network.install-offline': {
            const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Mihomo 官方压缩包', extensions: ['gz', 'zip'] }] });
            if (result.canceled || !result.filePaths[0]) return false;
            if ((await stat(result.filePaths[0])).size > 64 * 1024 * 1024) throw new Error('压缩包过大。');
            await active.managed.core.ensure(await readFile(result.filePaths[0])); return true;
          }
          case 'network.read-config': {
            const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Clash / Mihomo 配置', extensions: ['yaml', 'yml', 'json'] }] });
            if (result.canceled || !result.filePaths[0]) return null;
            if ((await stat(result.filePaths[0])).size > 2_000_000) throw new Error('配置文件超过 2 MB。');
            return readFile(result.filePaths[0], 'utf8');
          }
          case 'proxy.save': {
            const config = active.store.get();
            const profile = payload.profile;
            if (payload.credentials) { profile.credentialRef = `proxy:${profile.id}`; const credentials = z.object({ username: z.string().max(1000), password: z.string().max(1000) }).parse(payload.credentials); await vault.set(profile.credentialRef, JSON.stringify(credentials)); }
            await active.store.update(current => { current.proxies = [...current.proxies.filter(p => p.id !== profile.id), profile]; }); return true;
          }
          case 'proxy.default': { await active.store.update(config => { config.defaultProxy = payload; }); return true; }
          case 'client.preview': { const client = z.enum(['codex', 'claude']).parse(payload.client); return active.clients.plan(client, active.store.get(), active.gateway.address, await active.ensureClient(client), payload.model); }
          case 'client.gateway': {
            const client = z.enum(['codex', 'claude']).parse(payload.client);
            const result = await active.clients.enableGateway(client, () => active.store.get(), active.gateway.address, await active.ensureClient(client));
            await active.localAccounts.scan(); return result;
          }
          case 'client.original': {
            const client = z.enum(['codex', 'claude']).parse(payload.client);
            const result = await active.clients.restoreOriginalMode(client, active.gateway.address);
            await active.localAccounts.scan(); return result;
          }
          case 'client.switch': {
            const { client, model } = z.object({ client: z.enum(['codex', 'claude']), model: z.string().min(1) }).parse(payload);
            const result = await active.clients.switchService(client, () => active.store.get(), active.gateway.address, await active.ensureClient(client), model);
            await active.localAccounts.scan(); return result;
          }
          case 'client.portable-preview':
          case 'client.copy-portable':
          case 'client.export-portable': {
            const client = z.enum(['codex', 'claude']).parse(payload.client);
            const address = resolveClientAddress(z.string().parse(payload.address), active.gateway.address, active.gateway.lanAddresses());
            const bundle = active.clients.portable(client, active.store.get(), address, await active.accessKey(z.string().parse(payload.keyId)));
            if (operation === 'client.portable-preview') return { client, address: bundle.address, filename: bundle.filename, preview: bundle.preview, requiresCatalog: !!bundle.catalog, filenames: Object.keys(bundle.files), instructions: bundle.instructions };
            if (operation === 'client.copy-portable') {
              const part = z.enum(['config', 'catalog', 'macos', 'linux', 'windows']).parse(payload.part);
              if (part === 'catalog' && !bundle.catalog) throw new Error('此客户端不需要单独的模型目录。');
              const { clipboard } = await import('electron'); clipboard.writeText(part === 'catalog' ? bundle.catalog! : part === 'config' ? bundle.configuration : bundle.scripts[part]); return true;
            }
            const result = await dialog.showSaveDialog(window!, { defaultPath: `${client}-model-bridge.zip`, filters: [{ name: '客户端配置与模型目录', extensions: ['zip'] }] });
            if (result.canceled || !result.filePath) return false;
            const archive = zipSync(Object.fromEntries(Object.entries(bundle.files).map(([name, contents]) => [name, strToU8(contents)])));
            await atomicWrite(result.filePath, archive); return true;
          }
          case 'client.copy-config': {
            const { clipboard } = await import('electron'); clipboard.writeText(active.clients.export(z.string().parse(payload.id), z.enum(['native', 'json']).parse(payload.format))); return true;
          }
          case 'client.export-config': {
            const format = z.enum(['native', 'json']).parse(payload.format); const client = z.enum(['codex', 'claude']).parse(payload.client);
            const contents = active.clients.export(z.string().parse(payload.id), format);
            const extension = format === 'native' && client === 'codex' ? 'toml' : 'json';
            const result = await dialog.showSaveDialog(window!, { defaultPath: `${client}-model-bridge.${extension}`, filters: [{ name: '客户端配置', extensions: [extension] }] });
            if (!result.canceled && result.filePath) await writeFile(result.filePath, contents, { mode: 0o600 }); return !result.canceled;
          }
          case 'client.copy-generic':
          case 'client.export-generic': {
            const model = z.string().parse(payload.model); const protocol = z.enum(['responses', 'messages', 'chat']).parse(payload.protocol);
            if (!models(active.store.get()).some(entry => entry.id === model || entry.members.some(member => `${member.connection.id}/${member.model.id}` === model))) throw new Error('请先选择可用模型。');
            const address = payload.address && active.gateway.lanAddresses().includes(payload.address) ? payload.address : active.gateway.address;
            const contents = JSON.stringify({ base_url: address + (protocol === 'messages' ? '' : '/v1'), api_key: await active.ensureClient('generic'), model, protocol }, null, 2) + '\n';
            if (operation === 'client.copy-generic') { const { clipboard } = await import('electron'); clipboard.writeText(contents); return true; }
            const result = await dialog.showSaveDialog(window!, { defaultPath: 'model-bridge-agent.json', filters: [{ name: 'JSON 配置', extensions: ['json'] }] });
            if (!result.canceled && result.filePath) await writeFile(result.filePath, contents, { mode: 0o600 }); return !result.canceled;
          }
          case 'client.apply': { const result = await active.clients.apply(z.string().parse(payload.id), active.store.get()); await active.localAccounts.scan(); return result; }
          case 'client.restore': { const result = await active.clients.restore(z.enum(['codex', 'claude']).parse(payload.client)); await active.localAccounts.scan(); return result; }
          case 'client.copy-key': { const { clipboard } = await import('electron'); clipboard.writeText(await active.ensureClient('generic')); return true; }
          case 'client.copy-address': {
            const protocol = z.enum(['responses', 'messages', 'chat']).parse(payload.protocol);
            const kind = z.enum(['base', 'endpoint']).parse(payload.kind);
            const paths = { responses: '/v1/responses', messages: '/v1/messages', chat: '/v1/chat/completions' };
            const address = payload.address && active.gateway.lanAddresses().includes(payload.address) ? payload.address : active.gateway.address;
            const { clipboard } = await import('electron'); clipboard.writeText(address + (kind === 'endpoint' ? paths[protocol] : protocol === 'messages' ? '' : '/v1')); return true;
          }
          case 'usage.export': { const result = await dialog.showSaveDialog(window!, { defaultPath: 'model-bridge-usage.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (!result.canceled && result.filePath) await writeFile(result.filePath, '\ufeff' + usageCsv(await active.usage.list())); return !result.canceled; }
          case 'app.autostart': { const enabled = z.boolean().parse(payload.enabled); app.setLoginItemSettings({ openAtLogin: enabled }); return true; }
          default: throw new Error('Unknown operation.');
        }
      } catch (error) { throw new Error(error instanceof z.ZodError ? '配置格式有误，请检查地址、模型和代理设置。' : error instanceof Error ? error.message : '操作失败'); }
    });
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 920, minHeight: 640, title: 'Model Bridge', icon: applicationIcon, backgroundColor: '#f6f5f1', webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); hideWindow(); } });
    await window.loadFile(path.join(directory, '../ui/index.html'));
    if (app.isPackaged) {
      if (!updateRecovery) void updates.check();
      updateTimer = setInterval(() => { void updates?.check(); }, 6 * 60 * 60 * 1000).unref();
    }
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 3; y < 14; y++) for (let x = 2; x < 14; x++) {
      if (x < 5 || x > 10 || y < 6 || (x > 6 && x < 9 && y < 11)) {
        const offset = (y * 16 + x) * 4; pixels[offset] = 75; pixels[offset + 1] = 95; pixels[offset + 2] = 40; pixels[offset + 3] = 255;
      }
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }); icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Model Bridge'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Model Bridge', click: showWindow }, { label: active.gateway.address, enabled: false }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
    tray.on('click', showWindow);
    const menus: MenuItemConstructorOptions[] = [{ role: 'editMenu' }, { label: '窗口', submenu: [{ label: '显示窗口', click: showWindow }, { label: '隐藏到托盘', click: hideWindow }] }];
    if (process.platform === 'darwin') menus.unshift({ label: 'Model Bridge', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '隐藏到菜单栏', accelerator: 'Command+Q', click: hideWindow }] });
    Menu.setApplicationMenu(Menu.buildFromTemplate(menus));
    desktopReady = true; await updateAttempt?.ready();
    console.info('Model Bridge desktop ready');
  } catch (error) {
    if (process.argv.includes('--model-bridge-update')) {
      await updateAttempt?.failed(error).catch(() => {}); quitting = true; await runtime?.close(); app.exit(1); return;
    }
    dialog.showErrorBox('Model Bridge 启动失败', error instanceof Error ? error.message : 'Unknown error'); quitting = true; await runtime?.close(); app.quit();
  }
  });
}
