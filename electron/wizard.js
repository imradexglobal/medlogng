// First-run wizard renderer — plain DOM, talks to the main process through
// the preload bridge (window.medilog). No node integration here.

const $ = (id) => document.getElementById(id)
const api = window.medilog || {}

let info = { keyImported: false, tokenGenerated: false }

function renderInfo() {
  $('keyMsg').innerHTML = info.keyImported
    ? '<div class="ok">✓ Key imported — this PC can now talk to Firebase.</div>'
    : ''
  // Finish unlocks once the key is in; the token is generated on finish.
  $('btnFinish').disabled = !info.keyImported
}

async function refresh() {
  try {
    info = await api.hostGetInfo()
    if (!info.needsSetup && info.lanUrl) {
      $('addr').hidden = false
      $('addr').textContent = info.lanUrl
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
  $('fwMsg').innerHTML = '<div class="ok">Waiting for the Windows permission prompt…</div>'
  const r = await api.hostOpenFirewall()
  $('fwMsg').innerHTML = r?.ok
    ? '<div class="ok">✓ Firewall rule added.</div>'
    : '<div class="err">Could not add the rule (' + (r?.message || 'cancelled?') + '). You can run this later as administrator:<br>netsh advfirewall firewall add rule name="MediLog NG Host" dir=in action=allow protocol=TCP localport=8787</div>'
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
  $('addr').hidden = false
  $('addr').textContent = r.lanUrl
  $('finMsg').innerHTML = '<div class="ok">✓ Host is running. Give other PCs the address above.</div>'
  setTimeout(() => api.hostSetupDone(), 1200)
}

refresh()
