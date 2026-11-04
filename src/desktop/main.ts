import { app, BrowserWindow, ipcMain, session, shell, dialog, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { createRuntime, type Runtime } from '../core/runtime.js';
import { DesktopVault } from './vault.js';
import { usageCsv, usageView } from '../core/usage.js';
import { z } from 'zod';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('Model Bridge');
let runtime: Runtime | undefined; let window: BrowserWindow | undefined; let tray: Tray | undefined; let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => window?.show());
  app.on('before-quit', event => { if (quitting) return; event.preventDefault(); quitting = true; void runtime?.close().finally(() => app.quit()); if (!runtime) app.quit(); });
  void app.whenReady().then(async () => {
  try {
    const applicationIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'));
    if (process.platform === 'darwin') app.dock?.setIcon(applicationIcon);
    const data = process.env.MODEL_BRIDGE_DATA_DIR ? path.resolve(process.env.MODEL_BRIDGE_DATA_DIR) : app.getPath('userData');
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
    void active.localAccounts.scan();
    ipcMain.handle('model-bridge', async (event, operation: string, payload: any) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame) throw new Error('Invalid sender.');
      try {
        switch (operation) {
          case 'state': {
            const days = z.number().int().min(1).max(90).parse(payload?.days ?? 7);
            const filters = z.object({ clientId: z.string().optional(), provider: z.string().optional(), connectionId: z.string().optional(), model: z.string().optional() }).parse(payload?.filters ?? {});
            const records = await active.usage.list(days);
            const config = active.store.get(); const address = active.gateway.address;
            const [codex, claude] = await Promise.all(['codex', 'claude'].map(client => active.clients.status(client as 'codex' | 'claude', config, address)));
            return { config, address, clientStatuses: { codex, claude }, lanAddresses: active.gateway.lanAddresses(), managedNetworks: active.managed.overview(), logins: active.loginStates(), discoveries: active.discoveryStates(), localAccounts: active.localAccounts.list(), ...usageView(records, filters, days), usageWriteFailed: active.usageWriteFailed() };
          }
          case 'connection.save': return active.saveConnection(payload.connection, payload.apiKey ? z.string().max(20000).parse(payload.apiKey) : undefined, payload.autoDiscover !== false);
          case 'connection.discover': return active.discover(z.string().parse(payload.id));
          case 'connection.delete': {
            const config = active.store.get(); const id = z.string().parse(payload.id);
            const existing = config.connections.find(c => c.id === id);
            if (existing?.auth === 'chatgpt-device') await active.loginFor(id).logout();
            const updated = await active.store.update(current => { current.connections = current.connections.filter(c => c.id !== id); }); await active.clients.updateCatalog(updated); return true;
          }
          case 'device.login': return active.loginFor(z.string().parse(payload.id)).login();
          case 'device.cancel': return active.loginFor(z.string().parse(payload.id)).cancel();
          case 'device.open': { const url = active.loginFor(z.string().parse(payload.id)).state.verificationUrl; if (url) await shell.openExternal(url); return true; }
          case 'local.detect': return active.localAccounts.scan();
          case 'local.import': return active.importLocalAccount(z.string().parse(payload.id));
          case 'service.lan': return active.setLanAccess(z.boolean().parse(payload.enabled));
          case 'network.save': return active.managed.save(payload);
          case 'network.refresh': return active.managed.refresh(z.string().parse(payload.id));
          case 'network.select': return active.managed.select(z.string().parse(payload.id), z.string().parse(payload.node));
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
            if (!active.store.get().connections.some(c => c.enabled && c.models.some(m => m.enabled && `${c.id}/${m.id}` === model))) throw new Error('请先选择可用模型。');
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
          case 'usage.export': { const result = await dialog.showSaveDialog(window!, { defaultPath: 'model-bridge-usage.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (!result.canceled && result.filePath) await writeFile(result.filePath, '\ufeff' + usageCsv(await active.usage.list(90))); return !result.canceled; }
          case 'app.autostart': { const enabled = z.boolean().parse(payload.enabled); app.setLoginItemSettings({ openAtLogin: enabled }); return true; }
          default: throw new Error('Unknown operation.');
        }
      } catch (error) { throw new Error(error instanceof z.ZodError ? '配置格式有误，请检查地址、模型和代理设置。' : error instanceof Error ? error.message : '操作失败'); }
    });
    window = new BrowserWindow({ width: 1180, height: 800, minWidth: 920, minHeight: 640, title: 'Model Bridge', icon: applicationIcon, backgroundColor: '#f6f5f1', webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    await window.loadFile(path.join(directory, '../ui/index.html'));
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 3; y < 14; y++) for (let x = 2; x < 14; x++) {
      if (x < 5 || x > 10 || y < 6 || (x > 6 && x < 9 && y < 11)) {
        const offset = (y * 16 + x) * 4; pixels[offset] = 75; pixels[offset + 1] = 95; pixels[offset + 2] = 40; pixels[offset + 3] = 255;
      }
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }); icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Model Bridge'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Model Bridge', click: () => window?.show() }, { label: active.gateway.address, enabled: false }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
    tray.on('click', () => window?.show());
  } catch (error) { dialog.showErrorBox('Model Bridge 启动失败', error instanceof Error ? error.message : 'Unknown error'); quitting = true; await runtime?.close(); app.quit(); }
  });
}
