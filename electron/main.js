const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const host = require('./host');
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

function appIconPath() {
  const ico = path.join(__dirname, '..', 'public', 'icon.ico');
  if (fs.existsSync(ico)) return ico;
  const png = path.join(__dirname, '..', 'public', 'logo.png');
  if (fs.existsSync(png)) return png;
  return null;
}

function createWindow(startUrl) {
  const winIcon = appIconPath();
  const winOpts = {
    width: 1280,
    height: 800,
    title: 'MediLog NG',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (winIcon) winOpts.icon = winIcon;
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    applyZoom(false);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { require('electron').shell.openExternal(url); } catch (e) {}
    return { action: 'deny' };
  });

  if (startUrl) {
    // Host mode: load the EMR from the local hub server (same code path a
    // ward PC uses) so the host exercises exactly what the building sees.
    mainWindow.loadURL(startUrl);
  } else if (START_URL) {
    mainWindow.loadURL(START_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ---- host mode (MediLogHost-Setup.exe only) --------------------------------
let wizardWindow = null;

function createWizardWindow() {
  wizardWindow = new BrowserWindow({
    width: 560,
    height: 700,
    resizable: false,
    title: 'MediLog NG Host — Setup',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { wizardWindow.setMenuBarVisibility(false); } catch (e) {}
  wizardWindow.loadFile(path.join(__dirname, 'wizard.html'));
  wizardWindow.on('closed', () => {
    wizardWindow = null;
    // Abandoned setup (no config written yet): nothing to run — exit instead
    // of idling invisibly.
    try { if (host.needsSetup()) app.quit(); } catch (e) {}
  });
}

async function startHostExperience() {
  host.registerHostIpc();

  ipcMain.on('host-setup-done', () => {
    try { if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close(); } catch (e) {}
    const cfg = host.loadHostConfig();
    const port = (cfg && cfg.port) || host.HOST_PORT_DEFAULT;
    createWindow(host.localUrl(port));
    host.createTray(() => mainWindow, port);
    host.startStatusPoll(port);
  });

  if (host.needsSetup()) {
    createWizardWindow();
    return;
  }
  try {
    await host.startHubRuntime();
  } catch (e) {
    dialog.showErrorBox(
      'MediLog NG Host',
      'Could not start the host server:\n' + ((e && e.message) || e) + '\n\nSetup will open so the key can be re-imported.'
    );
    createWizardWindow();
    return;
  }
  const cfg = host.loadHostConfig();
  const port = (cfg && cfg.port) || host.HOST_PORT_DEFAULT;
  createWindow(host.localUrl(port));
  host.createTray(() => mainWindow, port);
  host.startStatusPoll(port);
}

app.whenReady().then(async () => {
  loadZoom();
  if (host.isHostMode()) {
    await startHostExperience();
  } else {
    createWindow();
  }

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
      if (host.isHostMode()) {
        try { autoUpdater.channel = 'host'; } catch (e) {}
      }
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

// Auto-update (GitHub releases)
  try {
    if (autoUpdater && !START_URL) {
      const isHost = host.isHostMode();
      if (isHost) {
        // Host builds use the 'host' channel so they check host.yml instead of latest.yml
        try { autoUpdater.channel = 'host'; } catch (e) {}
      }
      // Automatically download updates
      autoUpdater.autoDownload = true;
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
        if (isHost) {
          host.updateTrayStatus('Downloading update v' + (info?.version || '') + '…');
        }
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
        if (isHost) {
          host.updateTrayStatus('Downloading update: ' + updateProgress + '%');
        }
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
        if (isHost) {
          host.setUpdateReady(info?.version, () => {
            autoUpdater.quitAndInstall(false, true);
          });
        }
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
});

app.on('window-all-closed', () => {
  // Host mode lives in the tray: closing the window must NOT stop the server
  // the rest of the building depends on. Quit from the tray menu.
  if (host.isHostMode()) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  host.stopStatusPoll();
  host.stopHubRuntime().catch(() => {});
});
