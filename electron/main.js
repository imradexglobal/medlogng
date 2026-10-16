const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
let autoUpdater = null;
let updateAvailable = false;
let updateProgress = 0;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  console.log('[Electron] electron-updater not installed, auto-update disabled.');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

try {
  app.commandLine.appendSwitch('disk-cache-size', '104857600');
} catch (e) { /* flags must be set early; ignore if too late */ }

let mainWindow = null;
const START_URL = process.env.ELECTRON_START_URL || '';

const DEFAULT_ZOOM = 0.85;
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
let currentZoom = DEFAULT_ZOOM;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadZoom() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const z = JSON.parse(raw).zoom;
    if (typeof z === 'number' && z >= ZOOM_MIN && z <= ZOOM_MAX) currentZoom = z;
  } catch (e) { /* first run — keep default */ }
}

function saveZoom() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ zoom: currentZoom }));
  } catch (e) { console.log('[Electron] Could not save zoom setting.'); }
}

function applyZoom(notify) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomFactor(currentZoom);
  if (notify !== false) {
    try { mainWindow.webContents.send('zoom-changed', currentZoom); } catch (e) {}
  }
}

function setZoom(z) {
  currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  saveZoom();
  applyZoom();
  return currentZoom;
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'public', 'logo.svg');
  const winOpts = {
    width: 1280,
    height: 800,
    title: 'MedLogNg',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  try { if (fs.existsSync(iconPath)) winOpts.icon = iconPath; } catch (e) {}
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    applyZoom(false);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { require('electron').shell.openExternal(url); } catch (e) {}
    return { action: 'deny' };
  });

  if (START_URL) {
    mainWindow.loadURL(START_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  loadZoom();
  createWindow();

  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('zoom-in', () => setZoom(currentZoom + ZOOM_STEP));
  ipcMain.handle('zoom-out', () => setZoom(currentZoom - ZOOM_STEP));
  ipcMain.handle('zoom-reset', () => setZoom(DEFAULT_ZOOM));
  ipcMain.handle('zoom-get', () => currentZoom);
  ipcMain.handle('app-refresh', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  // Auto-update IPC handlers
  ipcMain.handle('auto-check-updates', async () => {
    if (!autoUpdater) return { error: 'autoUpdater not available' };
    try {
      // Manual flow: check only, UI decides when to download.
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('auto-download-update', async () => {
    if (!autoUpdater) return { error: 'autoUpdater not available' };
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('auto-quit-install', () => {
    if (!autoUpdater) return { error: 'autoUpdater not available' };
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('auto-get-status', () => {
    if (!autoUpdater) return { error: 'autoUpdater not available' };
    return {
      updateAvailable,
      updateProgress,
    };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

// Auto-update (GitHub releases) — manual download flow so the renderer can
// show progress + an "Update now" button. Listeners are registered BEFORE
// the first check so no event is missed.
  try {
    if (autoUpdater && !START_URL) {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on('checking-for-update', () => {
        updateAvailable = false;
        updateProgress = 0;
        mainWindow?.webContents.send('auto-update-status', { checking: true, progress: 0, available: false });
      });

      autoUpdater.on('update-available', (info) => {
        updateAvailable = true;
        updateProgress = 0;
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          progress: 0,
          available: true,
          version: info?.version,
          releaseNotes: info?.releaseNotes,
        });
      });

      autoUpdater.on('update-not-available', (info) => {
        updateAvailable = false;
        updateProgress = 0;
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          progress: 0,
          available: false,
          version: info?.version,
        });
      });

      autoUpdater.on('download-progress', (progressObj) => {
        updateProgress = Math.round(progressObj?.percent || 0);
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          downloading: true,
          progress: updateProgress,
          available: updateAvailable,
          bytesPerSecond: progressObj?.bytesPerSecond || 0,
          transferred: progressObj?.transferred || 0,
          total: progressObj?.total || 0,
        });
      });

      // electron-updater <6 emits `progress`, >=6 emits `download-progress`. Keep both.
      autoUpdater.on('progress', (progressObj) => {
        updateProgress = Math.round(progressObj?.percent || 0);
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          downloading: true,
          progress: updateProgress,
          available: updateAvailable,
        });
      });

      autoUpdater.on('update-downloaded', (info) => {
        updateAvailable = true;
        updateProgress = 100;
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          progress: 100,
          available: true,
          ready: true,
          version: info?.version,
          releaseNotes: info?.releaseNotes,
        });
      });

      autoUpdater.on('error', (err) => {
        mainWindow?.webContents.send('auto-update-status', {
          checking: false,
          progress: updateProgress,
          available: updateAvailable,
          error: (err && err.message) || String(err),
        });
      });

      // Give the window a moment to load before checking, so the banner exists.
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {});
      }, 3000);
    }
  } catch (e) {}
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
