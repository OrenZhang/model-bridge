import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('modelBridge', {
  call: (operation: string, payload?: unknown) => ipcRenderer.invoke('model-bridge', operation, payload),
});
