// MediLog NG Host — the "one PC runs the hospital building" mode.
//
// Activated only when the marker file electron/host.flag is present in the
// install (the separate MediLogHost-Setup.exe build ships it; the normal
// desktop installer does not, so single-PC users see zero change).
//
// Responsibilities:
//   - first-run wizard flow (import service-account key, open firewall)
//   - start the LAN hub (hub/server.js) in-process: serves the EMR to the
//     whole building on one port AND queues offline handoffs durably
//   - tray icon with a truthful status (internet / queue / firestore)
//   - "Start with Windows" toggle so the PC can be left on 24/7
//
// Everything user-specific lives in Electron's userData folder (never in the
// install dir, which may be read-only or wiped by an update):
//   userData/host-config.json         port / project / bind address
//   userData/keys/service-account.json  the imported Firebase key
//   userData/hub-data/queue.json        the durable handoff queue
//
// AUTH: there is NO shared secret. Ward PCs authenticate with the signed-in
// user's Firebase ID token, and the hub checks that user's hospital membership
// server-side. Older installs may still have a `token` field in
// host-config.json; loadHostConfig() deletes it so the obsolete secret is not
// kept on disk.

const { app, Tray, Menu, BrowserWindow, dialog, shell, nativeImage, ipcMain } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

const HOST_PORT_DEFAULT = 8787

// 32x32 MediLog NG custom logo embedded so tray icon is always truthful even if assets are missing.
const TRAY_ICON_PNG =
  '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'

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
    if (process.env.MEDILOG_HOST === '1' || process.env.HOST_MODE === '1') {
      return true
    }
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
  let cfg = null
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return null }
  if (!cfg || typeof cfg !== 'object') return null
  // Migration: the shared secret is obsolete. Delete it from disk so it cannot
  // be reused, and never pass it to the hub.
  if ('token' in cfg) {
    delete cfg.token
    try { saveHostConfig(cfg) } catch { /* read-only / transient — harmless */ }
  }
  return cfg
}

function saveHostConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  const clean = { ...cfg }
  delete clean.token
  fs.writeFileSync(configPath(), JSON.stringify(clean, null, 2))
}

// Setup is complete when a config exists AND the key was imported.
function needsSetup() {
  if (!app.isPackaged && !fs.existsSync(keyFilePath())) {
    try {
      const devKey = path.join(projectRoot(), 'hub', 'keys', 'service-account.json')
      if (fs.existsSync(devKey)) {
        importKeyFrom(devKey)
      }
    } catch { /* dev key import failed, will prompt */ }
  }
  if (!loadHostConfig()) return true
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

// hub/netinfo.js is ESM; Electron's main process is CommonJS, so load it with
// a dynamic import and cache the module. Using the SAME classifier as the hub
// means the tray/wizard and the server can never advertise different addresses.
let netinfoModule = null
async function netinfo() {
  if (!netinfoModule) {
    const root = projectRoot()
    netinfoModule = await import(pathToFileURL(path.join(root, 'hub', 'netinfo.js')).href)
  }
  return netinfoModule
}

// Returns usable IPv4 LAN addresses, best first. Never includes loopback,
// APIPA (169.254.x.x) or common virtual adapters — see hub/netinfo.js.
async function lanAddresses() {
  try {
    const mod = await netinfo()
    return mod.listLanAddresses(os.networkInterfaces())
  } catch {
    return []
  }
}

function localUrl(port) {
  return 'http://127.0.0.1:' + (Number(port) || HOST_PORT_DEFAULT)
}

// '' when this PC has no usable LAN address. Deliberately NOT a fallback to
// 127.0.0.1: another device cannot reach that, and showing it would send the
// operator chasing a phantom problem.
async function lanUrl(port) {
  const addrs = await lanAddresses()
  const p = Number(port) || HOST_PORT_DEFAULT
  return addrs.length ? 'http://' + addrs[0] + ':' + p : ''
}

// Honest explanation when no LAN URL can be produced. Shown in the wizard.
function lanDiagnostics() {
  return [
    'No usable IPv4 LAN address was detected on this PC.',
    'Run ipconfig and look for "IPv4 Address" on the Wi-Fi or Ethernet adapter you use.',
    'If it shows 169.254.x.x, the adapter never received a DHCP address — reconnect it or set a static address.',
    'The hub is still running for this PC only at the local address below.',
  ]
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

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// Opens the firewall with ONE elevated command: Windows shows its normal
// permission prompt (UAC) once; the admin clicks Yes.
//
// Scope is deliberately Domain + Private only. A hospital LAN is a trusted
// private network; adding a Public-profile rule would also expose the hub on
// coffee-shop Wi-Fi. If the network is misclassified as Public, fixing the
// network profile is the answer — not weakening this rule.
//
// The rule is removed and re-created, so changing the port or re-running setup
// always converges (an "already exists" rule can never fail setup), and the
// elevation is a single UAC prompt.
function isFirewallRuleActive() {
  return new Promise((resolve) => {
    const checkScript = "$r = Get-NetFirewallRule -DisplayName 'MediLog NG Host' -ErrorAction SilentlyContinue; if ($r -and $r.Enabled -eq 'True') { exit 0 } else { exit 1 }"
    const enc = Buffer.from(checkScript, 'utf16le').toString('base64')
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { windowsHide: true, timeout: 5000 },
      (err) => {
        resolve(!err)
      },
    )
  })
}

async function openFirewall(port) {
  const p = Number(port) || HOST_PORT_DEFAULT

  const alreadyActive = await isFirewallRuleActive()
  if (alreadyActive) {
    return { ok: true, port: p, alreadyActive: true }
  }

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-NetFirewallRule -DisplayName 'MediLog NG Host' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue",
    "New-NetFirewallRule -DisplayName 'MediLog NG Host' -Direction Inbound -Protocol TCP -LocalPort " + p + " -Action Allow -Profile Domain,Private | Out-Null"
  ].join('; ')

  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  const runner =
    'try { ' +
    "$p = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','" + encoded + "') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; " +
    'if ($p -and $p.ExitCode -eq 0) { exit 0 } else { exit 1 } ' +
    '} catch { exit 1 }'

  const runnerEnc = Buffer.from(runner, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', runnerEnc],
      { windowsHide: true, timeout: 90000 },
      async (err) => {
        const activeNow = await isFirewallRuleActive()
        if (activeNow || !err) {
          resolve({ ok: true, port: p })
          return
        }
        resolve({
          ok: false,
          port: p,
          message: 'Windows permission prompt was declined or administrator rights are required.',
        })
      },
    )
  })
}

// ---- hub lifecycle ---------------------------------------------------------

let hubHandle = null

async function startHubRuntime() {
  if (hubHandle) return hubHandle
  const cfg = loadHostConfig() || {}
  if (!fs.existsSync(keyFilePath())) {
    throw new Error('The service-account key file is missing from the host data folder. Run the setup wizard again.')
  }
  const port = Number(cfg.port) || HOST_PORT_DEFAULT
  const host = String(cfg.host || '0.0.0.0')
  const root = projectRoot()

  if (app.isPackaged) {
    const unpackedModules = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    if (fs.existsSync(unpackedModules)) {
      process.env.NODE_PATH = process.env.NODE_PATH ? (unpackedModules + path.delimiter + process.env.NODE_PATH) : unpackedModules
      try { require('module').Module._initPaths() } catch { /* ignore */ }
    }
  }

  const { startHub } = await import(pathToFileURL(path.join(root, 'hub', 'server.js')).href)

  // startHub rejects with an operator-friendly message for EADDRINUSE / EACCES
  // / EADDRNOTAVAIL (see hub/netinfo.js describeListenError), so the wizard can
  // show the real cause instead of "listen EADDRINUSE :::8787".
  hubHandle = await startHub({
    host,
    port,
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
let updateReadyInfo = null
let currentWindowGetter = null
let currentPort = HOST_PORT_DEFAULT

function trayIcon() {
  try {
    const candidates = [
      path.join(projectRoot(), 'public', 'logo.png'),
      path.join(projectRoot(), 'dist', 'logo.png'),
      path.join(projectRoot(), 'public', 'icon.png'),
      path.join(projectRoot(), 'dist', 'icon.png'),
      path.join(__dirname, '..', 'public', 'logo.png'),
      path.join(__dirname, '..', 'dist', 'logo.png'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'dist', 'logo.png'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'public', 'logo.png'),
    ]
    for (const iconFile of candidates) {
      if (iconFile && fs.existsSync(iconFile)) {
        const img = nativeImage.createFromPath(iconFile)
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
      }
    }
  } catch {}
  return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64')).resize({ width: 16, height: 16 })
}

function setLoginItem(enabled) {
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath })
}

function updateTrayStatus(statusText) {
  if (statusItem) statusItem.label = 'Status: ' + statusText
  if (tray) tray.setToolTip('MediLog NG Host — ' + statusText)
}

function rebuildTrayMenu() {
  if (!tray) return
  const getWindow = currentWindowGetter || (() => null)
  const items = []
  if (updateReadyInfo) {
    items.push({
      label: '⚡ Restart & Install Update (v' + (updateReadyInfo.version || 'new') + ')',
      click: () => {
        if (typeof updateReadyInfo.onRestart === 'function') {
          updateReadyInfo.onRestart()
        }
      },
    })
    items.push({ type: 'separator' })
  }
  items.push(
    statusItem || { label: 'Status: starting…', enabled: false },
    { type: 'separator' },
    { label: 'Open MediLog NG', click: () => openHostWindow() },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!app.getLoginItemSettings().openAtLogin,
      click: (item) => setLoginItem(item.checked),
    },
    { label: 'Open data folder', click: () => { fs.mkdirSync(dataDir(), { recursive: true }); shell.openPath(dataDir()) } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function setUpdateReady(version, onRestart) {
  updateReadyInfo = { version, onRestart }
  rebuildTrayMenu()
  try {
    tray?.displayBalloon?.({
      title: 'MediLog NG Host Update Ready',
      content: 'Version ' + version + ' is downloaded. Click the tray icon to restart and apply.',
    })
  } catch {}
}

let currentReopenHandler = null

function openHostWindow() {
  const w = currentWindowGetter ? currentWindowGetter() : null
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  } else if (typeof currentReopenHandler === 'function') {
    currentReopenHandler()
  }
}

function createTray(getWindow, port, onReopen) {
  if (tray) return tray
  currentWindowGetter = getWindow
  currentReopenHandler = onReopen
  currentPort = port || HOST_PORT_DEFAULT
  tray = new Tray(trayIcon())
  tray.setToolTip('MediLog NG Host')
  statusItem = { label: 'Status: starting…', enabled: false }
  rebuildTrayMenu()
  tray.on('click', () => openHostWindow())
  return tray
}

function destroyTray() {
  if (tray) {
    try { tray.destroy() } catch {}
    tray = null
  }
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
    if (tray) {
      const tip = updateReadyInfo ? `MediLog NG Host — [UPDATE READY] ${text}` : `MediLog NG Host — ${text}`
      tray.setToolTip(tip.slice(0, 127))
    }
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
  ipcMain.handle('host-get-info', async () => {
    if (!app.isPackaged && !fs.existsSync(keyFilePath())) {
      try {
        const devKey = path.join(projectRoot(), 'hub', 'keys', 'service-account.json')
        if (fs.existsSync(devKey)) {
          importKeyFrom(devKey)
        }
      } catch {}
    }
    const cfg = loadHostConfig()
    const port = Number(cfg?.port) || HOST_PORT_DEFAULT
    const addresses = await lanAddresses()
    const lan = addresses.length ? 'http://' + addresses[0] + ':' + port : ''
    const firewallOpen = await isFirewallRuleActive()
    return {
      needsSetup: needsSetup(),
      port,
      localUrl: localUrl(port),
      lanUrl: lan,
      addresses,
      keyImported: fs.existsSync(keyFilePath()),
      firewallOpen,
      running: !!hubHandle,
      // Only present when something needs explaining.
      diagnostics: lan ? [] : lanDiagnostics(),
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
      if (!fs.existsSync(keyFilePath())) {
        return { ok: false, error: 'Import the Firebase key file first.' }
      }
      const cfg = loadHostConfig() || {}
      cfg.port = Number(cfg.port) || HOST_PORT_DEFAULT
      cfg.host = cfg.host || '0.0.0.0'
      cfg.projectId = cfg.projectId || 'medlogng'
      cfg.configuredAt = new Date().toISOString()
      saveHostConfig(cfg)
      const handle = await startHubRuntime()
      return {
        ok: true,
        localUrl: handle.localUrl || localUrl(cfg.port),
        lanUrl: handle.lanUrl || '',
        addresses: handle.lanAddresses || [],
        diagnostics: (handle.lanAddresses || []).length ? [] : lanDiagnostics(),
      }
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
  destroyTray,
  startStatusPoll,
  stopStatusPoll,
  registerHostIpc,
  updateTrayStatus,
  setUpdateReady,
  lanUrl,
  lanAddresses,
  localUrl,
  dataDir,
  HOST_PORT_DEFAULT,
}
