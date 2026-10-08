// Patients registry — real Firestore reads/writes (offline-first, cached).
import { shell, statusBadge, toast, wireToast, formModal, closeModal } from '../components/shell.js'
import { navigate } from '../router.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgPatients, myPatientCaps, friendlyPatientError, formatPhone,
  searchPatientsGlobally, getPatient, findOpenEncounterForPatient,
} from '../services/patientService.js'
import { payerOptions } from '../services/payerService.js'
import { createEncounter, ENCOUNTER_TYPES } from '../services/consultationService.js'
import { getClinicalStaff } from '../services/authService.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'

const DEFAULT_PAYER = 'Self-pay'

export async function PatientsView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myPatientCaps()

  if (!activeOrg) {
    shell(app, {
      active: '/patients',
      title: 'Patients',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let rows = []
  let searchTerm = ''
  let chip = 'All'
  let payerChips = []
  let isSearching = false
  let searchResults = []

  shell(app, {
    active: '/patients',
    title: 'Patients',
    subtitle: 'Registry · search searches all hospitals',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canCreate ? '<button class="btn" id="regBtn">+ Register patient</button>' : ''),
    body:
      '<div class="card"><div class="toolbar">' +
      '<div class="search"><input id="q" class="input" placeholder="Search all hospitals — name, ID, MRN or phone…" /></div>' +
      '<div class="chips" id="chips"></div></div>' +
      '<div id="ptbl"></div>' +
      '<p class="sub" id="pcount" style="margin-top:10px">Loading…</p></div>' +
      (caps.canCreate ? '' : '<p class="sub">Your role cannot register patients — an administrator must grant the <strong>patient.create</strong> capability.</p>'),
  })

  const tableHost = document.getElementById('ptbl')
  const countEl = document.getElementById('pcount')
  const chipsHost = document.getElementById('chips')

  function renderChips() {
    const list = ['All', 'Active', ...payerChips]
    if (chip !== 'All' && chip !== 'Active' && !list.includes(chip)) chip = 'All'
    chipsHost.innerHTML = list.map((c) =>
      '<button class="chip' + (c === chip ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('')
    chipsHost.querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => { chip = c.getAttribute('data-c'); render() }
    })
  }

  function render() {
    renderChips()
    if (isSearching) {
      tableHost.innerHTML = '<div class="card"><p class="sub">Searching all hospitals…</p></div>'
      countEl.textContent = 'Searching…'
      return
    }
    if (searchTerm) {
      renderSearchResults()
      return
    }
    renderLocalList()
  }

  function renderLocalList() {
    const shown = rows.filter((r) => {
      if (chip === 'Active' && r.status !== 'Active') return false
      if (chip !== 'All' && chip !== 'Active' && String(r.payer || '').toLowerCase() !== chip.toLowerCase()) return false
      return true
    })
    tableHost.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>IDs</th><th>Contact</th><th>Payer</th><th>Status</th><th>Registered</th></tr></thead><tbody>' +
      (shown.length
        ? shown.map((r) =>
          '<tr class="clickable" data-pid="' + r.pid + '">' +
          '<td><strong>' + esc(r.name) + '</strong><div class="mut">' +
            (r.sex ? esc(r.sex) + ' · ' : '') + (r.age !== '' ? r.age + 'y · ' : '') + esc(r.dob || 'no DOB') + '</div></td>' +
          '<td><strong>' + esc(r.pid) + '</strong><div class="mut">' + esc(r.mrn) + '</div></td>' +
          '<td>' + esc(formatPhone(r.phone, r.phone_key)) + '</td>' +
          '<td>' + esc(r.payer) + '</td>' +
          '<td>' + statusBadge(r.status) + '</td>' +
          '<td class="mut">' + (r.registered ? new Date(r.registered).toLocaleDateString('en-NG') : '—') + '</td>' +
          '</tr>').join('')
        : '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No patients registered yet</td></tr>') +
      '</tbody></table></div>'
    countEl.textContent = rows.length
      ? 'Showing ' + shown.length + ' of ' + rows.length + (rows.length === 1 ? ' patient' : ' patients') + ' registered at your hospital'
      : 'No patients registered yet.'
    tableHost.querySelectorAll('tr[data-pid]').forEach((tr) => {
      tr.onclick = () => { window.location.hash = '#/patients/' + tr.getAttribute('data-pid') }
    })
  }

  function renderSearchResults() {
    const shown = searchResults.filter((r) => {
      if (chip === 'Active' && r.status !== 'Active') return false
      if (chip !== 'All' && chip !== 'Active' && String(r.payer || '').toLowerCase() !== chip.toLowerCase()) return false
      const q = searchTerm
      const hay = (r.name + ' ' + r.pid + ' ' + r.mrn + ' ' + r.phone).toLowerCase()
      return hay.includes(q)
    })
    tableHost.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>MRN</th><th>Phone</th><th>Sex / Age</th><th>Payer</th><th>Source</th><th>Actions</th></tr></thead><tbody>' +
      (shown.length
        ? shown.map((r) =>
          '<tr class="clickable" data-pid="' + esc(r.pid) + '">' +
          '<td><strong>' + esc(r.name) + '</strong><div class="mut">' + esc(r.pid.slice(0, 8)) + '…</div></td>' +
          '<td>' + esc(r.mrn) + '</td>' +
          '<td>' + esc(formatPhone(r.phone, r.phone_key)) + '</td>' +
          '<td>' + esc(r.sex || '—') + (r.age !== '' ? ' · ' + r.age + 'y' : '') + '</td>' +
          '<td>' + esc(r.payer) + '</td>' +
          '<td>' + (r.isLocal
            ? '<span class="pill ok">Your Hospital</span>'
            : '<span class="pill info">Other Hospital</span>') + '</td>' +
          '<td><div class="toolbar">' +
          '<button class="btn sm" data-enc="' + esc(r.pid) + '">Start Encounter</button>' +
          '</div></td>' +
          '</tr>').join('')
        : '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">No patients found</td></tr>') +
      '</tbody></table></div>'
    const localCount = searchResults.filter((r) => r.isLocal).length
    const cloudCount = searchResults.filter((r) => !r.isLocal).length
    countEl.textContent = searchResults.length
      ? 'Found ' + searchResults.length + ' — ' + localCount + ' from your hospital, ' + cloudCount + ' from other hospitals'
      : 'No patients found.'
    tableHost.querySelectorAll('tr[data-pid]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.dataset.enc) return
        window.location.hash = '#/patients/' + tr.getAttribute('data-pid')
      }
    })
    tableHost.querySelectorAll('[data-enc]').forEach((btn) => {
      btn.onclick = () => openEncounterModal(btn.getAttribute('data-enc'))
    })
  }

  async function load() {
    countEl.textContent = 'Loading patients…'
    tableHost.innerHTML = ''
    try {
      const [list, names] = await Promise.all([
        listOrgPatients(activeOrg),
        payerOptions().catch(() => []),
      ])
      rows = list
      payerChips = names.map((o) => o.value).filter((n) => n && n !== 'Not set')
      render()
    } catch (e) {
      console.error('[patients] list failed:', e)
      tableHost.innerHTML = '<div class="card"><p class="sub">Could not load patients: ' + esc(friendlyPatientError(e)) + '</p>' +
        '<button class="btn" id="retryBtn">Retry</button></div>'
      countEl.textContent = ''
      const rb = document.getElementById('retryBtn')
      if (rb) rb.onclick = load
    }
  }

  async function runSearch() {
    if (!searchTerm) {
      searchResults = []
      renderLocalList()
      return
    }
    isSearching = true
    render()
    try {
      const parts = searchTerm.split(/\s+/)
      const surname = parts[0] || ''
      const given_names = parts.slice(1).join(' ') || ''
      const { local, cloud } = await searchPatientsGlobally(surname, given_names, '')
      const localPids = new Set(rows.map((r) => r.pid))
      searchResults = [
        ...local.map((r) => ({ ...r, isLocal: true })),
        ...cloud.map((r) => ({ ...r, isLocal: localPids.has(r.pid) })),
      ]
    } catch (e) {
      console.error('[search] failed:', e)
      searchResults = []
      toast('Search failed: ' + friendlyPatientError(e))
    }
    isSearching = false
    render()
  }

  document.getElementById('refreshBtn').onclick = () => {
    if (searchTerm) {
      runSearch()
    } else {
      load()
    }
  }
  const regBtn = document.getElementById('regBtn')
  if (regBtn) regBtn.onclick = () => { navigate('/patients/new') }

  const q = document.getElementById('q')
  q.oninput = () => {
    searchTerm = q.value.trim().toLowerCase()
    if (searchTerm) {
      runSearch()
    } else {
      searchResults = []
      renderLocalList()
    }
  }
  renderChips()
  wireToast(app)

  await load()

  async function openEncounterModal(pid) {
    const { activeOrg } = authStore.getState()
    if (!activeOrg) { toast('No hospital selected'); return }
    try {
      const existing = await findOpenEncounterForPatient(pid, activeOrg)
      if (existing) {
        toast('This patient already has an open encounter at your hospital.')
        return
      }
    } catch (e) {
      console.warn('[search] open-encounter check failed:', e?.message)
    }
    getClinicalStaff(activeOrg).then((staff) => {
      const clinicianOptions = staff.length > 0 ? staff : [{ value: '', label: 'No clinical staff found' }]
      formModal({
        title: 'Start Encounter',
        submitLabel: 'Open encounter →',
        fields: [
          { name: 'type', label: 'Type', type: 'select', options: ENCOUNTER_TYPES },
          { name: 'clinician', label: 'Clinician', type: 'select', options: clinicianOptions, required: true },
          { name: 'chief_complaint', label: 'Chief complaint', full: true, placeholder: 'e.g. Fever, headache…' },
        ],
        onSubmit: async (v) => {
          try {
            const patient = await getPatient(pid)
            const created = await createEncounter({
              patient_id: pid,
              patient_name: patient ? patient.name : '',
              status: 'arrived',
              type: v.type || '',
              clinician: v.clinician || '',
              chief_complaint: v.chief_complaint || '',
            })
            closeModal()
            toast('Encounter started')
            navigate('/consultations?enc=' + encodeURIComponent(created.id))
          } catch (e) {
            throw new Error(friendlyWriteError(e))
          }
        },
      })
    }).catch((e) => {
      toast('Failed to load clinical staff: ' + friendlyWriteError(e))
    })
  }
}
