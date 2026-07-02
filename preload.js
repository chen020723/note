const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  setBgOpacity: (v) => ipcRenderer.invoke('set-bg-opacity', v),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('set-always-on-top', v),
  toggleEdge: (collapse) => ipcRenderer.invoke('toggle-edge', collapse),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setCollapsedPosition: (y) => ipcRenderer.invoke('set-collapsed-position', y),
  onEdgeState: (cb) => ipcRenderer.on('edge-state', (_, d) => cb(d)),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (_, d) => cb(d))
});
