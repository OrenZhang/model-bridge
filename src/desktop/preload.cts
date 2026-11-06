import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('modelBridge', {
  call: (operation: string, payload?: unknown) => ipcRenderer.invoke('model-bridge', operation, payload),
  onUpdate: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('model-bridge-update', handler);
    return () => ipcRenderer.removeListener('model-bridge-update', handler);
  },
});
