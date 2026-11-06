// Exercise the real desktop entry point with a separate profile and ephemeral port.
const { app, BrowserWindow, Tray } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const directory = mkdtempSync(path.join(os.tmpdir(), 'model-bridge-tray-'));
app.setPath('userData', directory);
process.env.MODEL_BRIDGE_DATA_DIR = directory;
writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ port: 0, defaultProxy: { mode: 'direct' } }));
let tray, menu, passed = false;
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (value) { tray = this; menu = value; return setContextMenu.call(this, value); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Tray validation timed out'); app.exit(1); }, 30000);
app.on('will-quit', () => {
  clearTimeout(timeout);
  rmSync(directory, { recursive: true, force: true });
  if (!passed) { console.error('Desktop exited before tray validation completed'); process.exitCode = 1; }
  else console.log('PASS: close hides window, background gateway remains healthy, tray restores window and exits normally');
});
(async () => {
  await import(pathToFileURL(path.resolve('dist/desktop/main.js')).href);
  while (!menu) await delay(50);
  const window = BrowserWindow.getAllWindows()[0];
  const address = menu.items.find(item => /^http:/.test(item.label)).label;
  assert.equal((await fetch(address + '/healthz')).status, 200);
  window.close();
  await delay(150);
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), false);
  assert.equal(tray.isDestroyed(), false);
  if (process.platform === 'darwin') assert.equal(app.dock.isVisible(), false);
  assert.equal((await fetch(address + '/healthz')).status, 200);
  const open = menu.items.find(item => item.label === '打开 Model Bridge');
  open.click(open, window, {});
  await delay(150);
  assert.equal(window.isVisible(), true);
  window.close();
  await delay(100);
  assert.equal((await fetch(address + '/healthz')).status, 200);
  passed = true;
  const quit = menu.items.find(item => item.label === '退出');
  quit.click(quit, window, {});
})().catch(error => { console.error(error); app.exit(1); });
