// MediLog NG Host — the "one PC runs the hospital building" mode.
//
// Activated only when the marker file electron/host.flag is present in the
// install (the separate MediLogHost-Setup.exe build ships it; the normal
// desktop installer does not, so single-PC users see zero change).
//
// Responsibilities:
//   - first-run wizard flow (import service-account key, open firewall,
//     generate the connection secret — never typed by a human)
//   - start the LAN hub (hub/server.js) in-process: serves the EMR to the
//     whole building on one port AND queues offline handoffs durably
//   - tray icon with a truthful status (internet / queue / firestore)
//   - "Start with Windows" toggle so the PC can be left on 24/7
//
// Everything user-specific lives in Electron's userData folder (never in the
// install dir, which may be read-only or wiped by an update):
//   userData/host-config.json         port + generated token
//   userData/keys/service-account.json  the imported Firebase key
//   userData/hub-data/queue.json        the durable handoff queue

const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, ipcMain } = require('electron')
const { exec } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const HOST_PORT_DEFAULT = 8787

// 16x16 green circle + white cross, embedded so no binary asset is required.
const TRAY_ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAE6SURBVDhPY8AF+PPjBfiz4x1AmCsrXgIqTBjwZsUk8GbH3ufLjvuPimOf82XFVkCVYQKQjbzZcdsxNaLj2OP86fEKUG0IQJxmCAa68DxDfDwHVCsDA19mbAY2hfgw0MJ2qHaQv2PfY1PkNaHtf/vW9f+jZk7EkANhkLcZQP7BJgnCIM0gsOT4IazyoBhi4MmMCUCXgNl8+NZ1sAGXHj8E80HiyOqAYVEAjjZkQRCG2YwOQOIoakHRyp8Vb4AiCMSZi2eDbX/49jVY44uPH8B8kDiyOpDrwYEIjNvvyBIwTCgM4CmUNyduOjYF+GIBlG7AmsEAmCiA/rmOrgg3jn2OkT8gYQFM71g1IDA4zWTFeEC1oQJQwgAqmo+uCYZBziYqZ4ISFyiEgfHcAMJ82TERPDnxGlBpJMDAAAChKILmySVDMwAAAABJRU5ErkJggg=='

function markerPath() {
  return path.join(__dirname, 'host.flag')
}

// Packaged builds: the host installer sets productName in the packaged
// package.json (electron-builder.extraMetadata) — 'MediLog NG Host' vs
// 'MediLog NG'. If metadata ever drifts, fall back to the executable's own
// name, which the installer always controls.
// Dev testing: drop a host.flag file next to this module (git-ignored).
function isHostMode() {
  try {
    if (app.isPackaged) {
      if (app.getName().toLowerCase().includes('host')) return true
      return path.basename(process.execPath).toLowerCase().includes('host')
    }
    return fs.existsSync(markerPath())
  } catch { return false }
}

function configPath() { return path.join(app.getPath('userData'), 'host-config.json') }
function keysDir() { return path.join(app.getPath('userData'), 'keys') }
function keyFilePath() { return path.join(keysDir(), 'service-account.json') }
function dataDir() { return path.join(app.getPath('userData'), 'hub-data') }

function loadHostConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return null }
}

function saveHostConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

function needsSetup() {
  const cfg = loadHostConfig()
  if (!cfg || !cfg.token) return true
  try { return !fs.existsSync(keyFilePath()) } catch { return true }
}

// The project root as it exists on real disk (hub + dist are asarUnpacked in
// the host build; dev mode runs straight from the repo).
function projectRoot() {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked')
    if (fs.existsSync(path.join(unpacked, 'hub', 'server.js'))) return unpacked
    return path.join(process.resourcesPath, 'app.asar')
  }
  return path.join(__dirname, '..')
}

function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address)
    }
  }
  return out
}

function localUrl(port) {
  return 'http://127.0.0.1:' + (port || HOST_PORT_DEFAULT)
}

function lanUrl(port) {
  const addrs = lanAddresses()
  return addrs.length ? 'http://' + addrs[0] + ':' + (port || HOST_PORT_DEFAULT) : localUrl(port)
}

function importKeyFrom(srcPath) {
  const raw = fs.readFileSync(srcPath, 'utf8')
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('That file is not valid JSON.') }
  if (!parsed.private_key || !parsed.project_id) {
    throw new Error('That file does not look like a Firebase service-account key (missing private_key/project_id).')
  }
  fs.mkdirSync(keysDir(), { recursive: true })
  fs.writeFileSync(keyFilePath(), raw, { mode: 0o600 })
  return { projectId: parsed.project_id }
}

// Opens the firewall with ONE elevated command: Windows shows its normal
// permission prompt (UAC) once; the admin clicks Yes.
function openFirewall(port) {
  const rule = 'advfirewall firewall add rule name="MediLog NG Host" dir=in action=allow protocol=TCP localport=' + port
  const ps = 'Start-Process -FilePath netsh -ArgumentList \'' + rule.replace(/'/g, "''") + '\' -Verb RunAs -Wait'
  return new Promise((resolve) => {
    exec('powershell.exe -NoProfile -NonInteractive -Command "' + ps.replace(/"/g, '`"') + '"',
      { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, message: String(stderr || err.message || err).slice(0, 300) })
        } else {
          resolve({ ok: true })
        }
      })
  })
}

// ---- hub lifecycle ---------------------------------------------------------

let hubHandle = null

async function startHubRuntime() {
  if (hubHandle) return hubHandle
  const cfg = loadHostConfig()
  if (!cfg || !cfg.token) throw new Error('Host setup is incomplete — run the setup wizard again.')
  if (!fs.existsSync(keyFilePath())) throw new Error('The service-account key file is missing from the host data folder.')
  const port = Number(cfg.port) || HOST_PORT_DEFAULT
  const root = projectRoot()
  const { startHub } = await import(pathToFileURL(path.join(root, 'hub', 'server.js')).href)
  hubHandle = await startHub({
    port,
    token: cfg.token,
    keyFile: keyFilePath(),
    queueFile: path.join(dataDir(), 'queue.json'),
    projectId: cfg.projectId || 'medlogng',
    staticDir: path.join(root, 'dist'),
  })
  return hubHandle
}

async function stopHubRuntime() {
  if (hubHandle) { try { await hubHandle.close() } catch { /* closing anyway */ } hubHandle = null }
}

// ---- tray ------------------------------------------------------------------

let tray = null
let statusItem = null
let pollTimer = null

function trayIcon() {
  return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'))
}

function setLoginItem(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath })
}

function createTray(getWindow, port) {
  if (tray) return tray
  tray = new Tray(trayIcon())
  tray.setToolTip('MediLog NG Host')
  statusItem = { label: 'Status: starting…', enabled: false }
  const menu = Menu.buildFromTemplate([
    statusItem,
    { type: 'separator' },
    { label: 'Open MediLog NG', click: () => { const w = getWindow(); if (w) { w.show(); w.focus() } } },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!app.getLoginItemSettings().openAtLogin,
      click: (item) => setLoginItem(item.checked),
    },
    { label: 'Open data folder', click: () => { fs.mkdirSync(dataDir(), { recursive: true }); shell.openPath(dataDir()) } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { const w = getWindow(); if (w) w.show() })
  return tray
}

async function pollOnce(port) {
  try {
    const res = await fetch(localUrl(port) + '/health', { signal: AbortSignal.timeout(2000) })
    const h = await res.json()
    const q = h.queue || {}
    let text
    if (!h.firestoreReady) text = 'Status: check the key file (Firestore not ready)'
    else if (!h.internet) text = q.queued ? 'Status: OFFLINE — ' + q.queued + ' change(s) safe here' : 'Status: offline (nothing waiting)'
    else if (q.error) text = 'Status: ' + q.error + ' failed op(s) — check the queue'
    else if (q.queued || q.sending) text = 'Status: syncing ' + ((q.queued || 0) + (q.sending || 0)) + ' change(s)…'
    else text = 'Status: all synced · internet OK'
    if (statusItem) statusItem.label = text
    if (tray) tray.setToolTip('MediLog NG Host — ' + text)
    return h
  } catch {
    if (statusItem) statusItem.label = 'Status: host server not responding'
    return null
  }
}

function startStatusPoll(port) {
  pollOnce(port)
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => pollOnce(port).catch(() => {}), 10000)
}

function stopStatusPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

// ---- IPC (wired by main.js in host mode) -----------------------------------

function registerHostIpc() {
  ipcMain.handle('host-get-info', () => {
    const cfg = loadHostConfig()
    const port = Number(cfg?.port) || HOST_PORT_DEFAULT
    return {
      needsSetup: needsSetup(),
      port,
      lanUrl: lanUrl(port),
      addresses: lanAddresses(),
      keyImported: fs.existsSync(keyFilePath()),
      tokenGenerated: !!(cfg && cfg.token),
    }
  })

  ipcMain.handle('host-import-key', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: 'Select the Firebase service-account key (JSON)',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true }
    try {
      const { projectId } = importKeyFrom(picked.filePaths[0])
      return { ok: true, projectId, file: path.basename(picked.filePaths[0]) }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('host-open-firewall', () => {
    const cfg = loadHostConfig()
    return openFirewall(Number(cfg?.port) || HOST_PORT_DEFAULT)
  })

  ipcMain.handle('host-finish-setup', async () => {
    try {
      let cfg = loadHostConfig() || {}
      if (!cfg.token) cfg.token = crypto.randomBytes(24).toString('hex') // 48 hex chars — never typed by a human
      cfg.port = Number(cfg.port) || HOST_PORT_DEFAULT
      cfg.projectId = cfg.projectId || 'medlogng'
      cfg.configuredAt = new Date().toISOString()
      saveHostConfig(cfg)
      await startHubRuntime()
      return { ok: true, lanUrl: lanUrl(cfg.port), localUrl: localUrl(cfg.port) }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  })

  ipcMain.handle('host-show-data-folder', () => {
    fs.mkdirSync(dataDir(), { recursive: true })
    shell.openPath(dataDir())
    return true
  })
}

module.exports = {
  isHostMode,
  needsSetup,
  loadHostConfig,
  saveHostConfig,
  startHubRuntime,
  stopHubRuntime,
  createTray,
  startStatusPoll,
  stopStatusPoll,
  registerHostIpc,
  lanUrl,
  localUrl,
  dataDir,
  HOST_PORT_DEFAULT,
}
