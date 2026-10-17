const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Apply the saved zoom as early as possible (preload runs before page
// scripts), so full loads start at the right zoom.
try {
  ipcRenderer.invoke('zoom-get').then((savedZoom) => {
    if (typeof savedZoom === 'number' && savedZoom > 0) {
      webFrame.setZoomFactor(savedZoom);
    }
  }).catch(() => {});
} catch (e) { /* main process applies it on load instead */ }

contextBridge.exposeInMainWorld('medilog', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  zoomIn: () => ipcRenderer.invoke('zoom-in'),
  zoomOut: () => ipcRenderer.invoke('zoom-out'),
  zoomReset: () => ipcRenderer.invoke('zoom-reset'),
  zoomGet: () => ipcRenderer.invoke('zoom-get'),
  refreshApp: () => ipcRenderer.invoke('app-refresh'),
  onZoomChanged: (cb) => {
    const listener = (_e, z) => cb(z);
    ipcRenderer.on('zoom-changed', listener);
    return () => ipcRenderer.removeListener('zoom-changed', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('auto-check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('auto-download-update'),
  quitAndInstall: () => ipcRenderer.invoke('auto-quit-install'),
  getUpdateStatus: () => ipcRenderer.invoke('auto-get-status'),
  onUpdateStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('auto-update-status', listener);
    return () => ipcRenderer.removeListener('auto-update-status', listener);
  },
  // ---- host-mode wizard (used by wizard.js; inert in the normal app) ----
  hostGetInfo: () => ipcRenderer.invoke('host-get-info'),
  hostImportKey: () => ipcRenderer.invoke('host-import-key'),
  hostOpenFirewall: () => ipcRenderer.invoke('host-open-firewall'),
  hostFinishSetup: () => ipcRenderer.invoke('host-finish-setup'),
  hostShowDataFolder: () => ipcRenderer.invoke('host-show-data-folder'),
  hostSetupDone: () => ipcRenderer.send('host-setup-done'),
});
