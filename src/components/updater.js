// In-app auto-update banner (Electron only).
// Listens to `auto-update-status` events forwarded by electron/main.js and
// shows: checking → available [Update now] → downloading % bar → ready [Restart now].
// Safe no-op on web / Capacitor builds where window.medilog is undefined.
import { BUILD_ID } from '../buildInfo.js'

let booted = false
let els = null
let state = { checking: false, available: false, downloading: false, ready: false, progress: 0, version: '', error: '' }
let currentVersion = BUILD_ID || ''
let dismissed = false

function fmtBytes(n) {
  if (!n) return ''
  const mb = n / 1024 / 1024
  return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}

function ensureBanner() {
  if (els?.root?.isConnected) return els
  const root = document.createElement('div')
  root.id = 'update-banner'
  root.hidden = true
  root.innerHTML =
    '<div class="upd-icon">⟳</div>' +
    '<div class="upd-body">' +
      '<strong id="upd-title">Checking for updates…</strong>' +
      '<span id="upd-sub" class="upd-sub"></span>' +
      '<div id="upd-bar" class="upd-bar" hidden><div id="upd-fill" class="upd-fill"></div></div>' +
    '</div>' +
    '<div class="upd-actions">' +
      '<button id="upd-primary" class="btn sm">Update now</button>' +
      '<button id="upd-later" class="btn ghost sm">Later</button>' +
    '</div>'
  document.body.appendChild(root)
  els = {
    root,
    title: root.querySelector('#upd-title'),
    sub: root.querySelector('#upd-sub'),
    bar: root.querySelector('#upd-bar'),
    fill: root.querySelector('#upd-fill'),
    primary: root.querySelector('#upd-primary'),
    later: root.querySelector('#upd-later'),
  }
  els.primary.onclick = onPrimary
  els.later.onclick = () => {
    dismissed = true
    render()
  }
  return els
}

async function onPrimary() {
  const m = window.medilog
  if (!m) {
    if (state.ready) window.location.reload();
    return;
  }
  try {
    if (state.ready) {
      els.primary.disabled = true
      els.primary.textContent = 'Restarting…'
      await m.quitAndInstall()
    } else if (state.available) {
      state.downloading = true
      state.progress = 0
      dismissed = false
      render()
      els.primary.disabled = true
      els.primary.textContent = 'Starting…'
      const res = await m.downloadUpdate()
      if (res?.error) {
        state = { ...state, downloading: false, error: res.error }
        render()
      }
    } else {
      // Idle pill clicked → manual re-check (useful when testing).
      dismissed = false
      state = { checking: true, available: false, downloading: false, ready: false, progress: 0, version: '', error: '' }
      render()
      await m.checkForUpdates()
    }
  } catch (e) {
    state = { ...state, downloading: false, error: e?.message || 'Update failed' }
    render()
  }
}

function render() {
  ensureBanner()
  const { checking, available, downloading, ready, progress, version, error } = state
  const show = checking || (available && !dismissed) || downloading || ready || error
  els.root.hidden = !show
  if (!show) {
    ensurePill()
    return
  }
  els.bar.hidden = !downloading
  els.later.style.display = ready || downloading ? 'none' : ''
  els.primary.disabled = false

  if (error && !available) {
    els.root.dataset.tone = 'bad'
    els.title.textContent = 'Update check failed'
    els.sub.textContent = String(error).slice(0, 160)
    els.primary.textContent = 'Retry'
    state.available = false // so next primary click re-checks
    els.primary.onclick = async () => {
      state = { checking: true, available: false, downloading: false, ready: false, progress: 0, version: '', error: '' }
      render()
      try { await window.medilog.checkForUpdates() } catch (e) {}
    }
    return
  }
  els.primary.onclick = onPrimary

  if (ready) {
    els.root.dataset.tone = 'ok'
    els.title.textContent = 'Update ready' + (version ? ' · v' + version : '')
    els.sub.textContent = 'Download complete. Restart to install v' + (version || 'latest') + '.'
    els.primary.textContent = 'Restart now'
  } else if (downloading) {
    els.root.dataset.tone = 'info'
    els.title.textContent = 'Downloading update… ' + (progress || 0) + '%'
    els.sub.textContent = state.transferred && state.total
      ? fmtBytes(state.transferred) + ' of ' + fmtBytes(state.total)
      : 'Keep the app open — installing right after.'
    els.fill.style.width = (progress || 0) + '%'
    els.primary.textContent = 'Downloading…'
    els.primary.disabled = true
  } else if (available) {
    els.root.dataset.tone = 'warn'
    els.title.textContent = 'Update available' + (version ? ' · v' + version : '')
    els.sub.textContent = 'You are on v' + currentVersion + (version ? ' → v' + version : '') + '. Click to download and install.'
    els.primary.textContent = 'Update now'
  } else if (checking) {
    els.root.dataset.tone = ''
    els.title.textContent = 'Checking for updates…'
    els.sub.textContent = 'Current version v' + currentVersion
    els.primary.textContent = 'Checking…'
    els.primary.disabled = true
  }
  ensurePill()
}

// Small persistent version pill (bottom-left) so testers can always see the
// running version and manually re-check, even when the banner is hidden.
function ensurePill() {
  let pill = document.getElementById('upd-pill')
  if (!pill) {
    pill = document.createElement('button')
    pill.id = 'upd-pill'
    pill.title = 'Check for updates'
    pill.onclick = () => {
      dismissed = false
      if (!window.medilog) return
      state = { checking: true, available: false, downloading: false, ready: false, progress: 0, version: '', error: '' }
      render()
      window.medilog.checkForUpdates().catch(() => {})
    }
    document.body.appendChild(pill)
  }
  pill.textContent = 'v' + currentVersion + (window.medilog ? ' · check for updates' : '')
  pill.style.display = window.medilog ? '' : 'none'
}

export function initUpdater() {
  if (booted) return
  booted = true
  ensureBanner()
  ensurePill()
  try {
    window.__medilogUpdate = (s = {}) => {
      dismissed = false
      state = {
        checking: !!s.checking,
        available: !!s.available || !!s.ready,
        downloading: !!s.downloading,
        ready: !!s.ready,
        progress: Math.round(s.progress ?? (s.ready ? 100 : 0)),
        version: s.version ? String(s.version).replace(/^v/, '') : state.version,
        error: s.error || '',
        transferred: s.transferred,
        total: s.total,
      }
      render()
      return state
    }
  } catch (e) {}
  const m = window.medilog
  if (!m) return // web build — pill hidden, banner never shows
  try { console.log('[updater] build', BUILD_ID, '| runtime', m) } catch (e) {}

  m.getAppVersion?.().then((v) => {
    if (v) { currentVersion = String(v); ensurePill() }
  }).catch(() => {})

  m.onUpdateStatus?.((s) => {
    dismissed = false
    state = {
      checking: !!s.checking,
      available: !!s.available,
      downloading: !!s.downloading || (!!s.available && (s.progress || 0) > 0 && !s.ready),
      ready: !!s.ready,
      progress: Math.round(s.progress || 0),
      version: s.version ? String(s.version).replace(/^v/, '') : '',
      error: s.error || '',
      transferred: s.transferred,
      total: s.total,
    }
    // download-progress with 100% but no `ready` yet → keep bar, don't flip to "available"
    if (state.downloading && state.progress >= 100 && !state.ready) state.downloading = true
    render()
  })

  // Dev/test hook: simulate states from the console without publishing:
  //   __medilogUpdate({available:true, version:'1.0.1'})
  //   __medilogUpdate({downloading:true, progress:42, available:true})
  //   __medilogUpdate({ready:true, version:'1.0.1'})
  try {
    window.__medilogUpdate = (s = {}) => {
      dismissed = false
      state = {
        checking: !!s.checking,
        available: !!s.available || !!s.ready,
        downloading: !!s.downloading,
        ready: !!s.ready,
        progress: Math.round(s.progress ?? (s.ready ? 100 : 0)),
        version: s.version ? String(s.version).replace(/^v/, '') : state.version,
        error: s.error || '',
        transferred: s.transferred,
        total: s.total,
      }
      render()
      return state
    }
  } catch (e) {}
}
