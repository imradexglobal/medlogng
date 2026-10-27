// First-run wizard renderer — plain DOM, talks to the main process through
// the preload bridge (window.medilog). No node integration here.
//
// There is no shared secret to show or copy: ward PCs sign in with their own
// Firebase account, and the hub checks their hospital membership. This screen
// only needs to explain where the app lives on the network.

const $ = (id) => document.getElementById(id)
const api = window.medilog || {}

let info = { keyImported: false }

function renderInfo() {
  $('keyMsg').innerHTML = info.keyImported
    ? '<div class="ok">✓ Key imported — this PC can now talk to Firebase.</div>'
    : ''
  // Finish unlocks once the key is in; the hub config is written on finish.
  $('btnFinish').disabled = !info.keyImported
}

function showAddresses({ lanUrl, localUrl, diagnostics } = {}) {
  $('addrWrap').hidden = false

  $('lanAddr').textContent = lanUrl || 'Not available yet'
  $('lanAddr').classList.toggle('missing', !lanUrl)

  $('localAddr').textContent = localUrl || ''

  const lines = Array.isArray(diagnostics) ? diagnostics.filter(Boolean) : []
  $('diag').hidden = lines.length === 0
  $('diag').textContent = lines.join('\n')
}

async function refresh() {
  try {
    info = await api.hostGetInfo()
    if (info.keyImported) {
      $('keyMsg').innerHTML = '<div class="ok">✓ Key already imported.</div>'
    }
    if (info.firewallOpen) {
      $('fwMsg').innerHTML = '<div class="ok">✓ Firewall rule active for the Domain and Private network profiles.</div>'
    }
    if (!info.needsSetup || info.running) {
      showAddresses(info)
    }
    renderInfo()
  } catch (e) {
    $('finMsg').innerHTML = '<div class="err">Could not read host info: ' + (e.message || e) + '</div>'
  }
}

$('btnKey').onclick = async () => {
  $('keyMsg').innerHTML = ''
  const r = await api.hostImportKey()
  if (r?.cancelled) return
  if (r?.ok) {
    info.keyImported = true
    renderInfo()
  } else {
    $('keyMsg').innerHTML = '<div class="err">' + (r?.error || 'Import failed.') + '</div>'
  }
}

$('btnFw').onclick = async () => {
  $('fwMsg').innerHTML = '<div class="ok">Waiting for the Windows permission prompt… (Click YES if prompted)</div>'
  const r = await api.hostOpenFirewall()
  const port = r?.port || 8787
  if (r?.ok) {
    $('fwMsg').innerHTML = '<div class="ok">✓ Firewall rule active for the Domain and Private network profiles.</div>'
  } else {
    $('fwMsg').innerHTML =
      '<div class="err">Could not add rule automatically (' + (r?.message || 'permission declined') + ').<br>' +
      'You can proceed to Step 3 anyway, or open an Administrator PowerShell and run:<br>' +
      '<code>New-NetFirewallRule -DisplayName "MediLog NG Host" -Direction Inbound -Protocol TCP -LocalPort ' +
      port + ' -Action Allow -Profile Domain,Private</code></div>'
  }
}

$('btnFinish').onclick = async () => {
  $('btnFinish').disabled = true
  $('finMsg').innerHTML = '<div class="ok">Starting the host server…</div>'
  const r = await api.hostFinishSetup()
  if (!r?.ok) {
    $('finMsg').innerHTML = '<div class="err">' + (r?.error || 'Setup failed.') + '</div>'
    $('btnFinish').disabled = false
    return
  }
  showAddresses(r)
  $('finMsg').innerHTML = r.lanUrl
    ? '<div class="ok">✓ Host is running. Other PCs on the same Wi-Fi/LAN can open the LAN address above.</div>'
    : '<div class="err">Host is running for this PC only — no usable LAN address was found. See the notes below.</div>'
  setTimeout(() => api.hostSetupDone(), r.lanUrl ? 1400 : 4000)
}

refresh()
