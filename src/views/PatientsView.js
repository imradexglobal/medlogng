// Patients registry — real Firestore reads/writes (offline-first, cached).
import { shell, statusBadge, toast, wireToast, formModal, closeModal } from '../components/shell.js'
import { navigate } from '../router.js'
import { authStore } from '../store/authStore.js'
import { listOrgPatientsPage, myPatientCaps, friendlyPatientError, formatPhone,
  searchPatientsGlobally, parseSearchTerm, matchesPatient,
  getPatient, findOpenEncounterForPatient, patientHasClinicalTrail,
} from '../services/patientService.js'
import { createLoadMore } from '../components/loadMore.js'
import { payerOptions } from '../services/payerService.js'
import { createEncounter, ENCOUNTER_TYPES } from '../services/consultationService.js'
import { getClinicalStaff } from '../services/authService.js'
import { esc } from '../utils/sanitize.js'
import { fmtDate } from '../utils/format.js'
import { friendlyWriteError } from '../utils/errors.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { deletePatient } from '../services/deleteService.js'

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
  // Infinite scroll state: rows accumulate, and `cursor` is the last document
  // of the chunk we hold — hand it back to fetch the next one.
  let cursor = null
  let hasMore = false
  let loading = false
  let searchTerm = ''
  let parsed = parseSearchTerm('')
  let chip = 'All'
  let payerChips = []
  let isSearching = false
  let searchResults = []
  // The search box drives a full read of the registry, so keystrokes are
  // debounced and every in-flight run is tagged — a slow early request must
  // not overwrite the results of a later one.
  let searchTimer = null
  let searchSeq = 0
  let selectedPids = new Set()

  shell(app, {
    active: '/patients',
    title: 'Patients',
    subtitle: 'Registry · search searches all hospitals',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canCreate ? '<button class="btn" id="regBtn">+ Register patient</button>' : '') +
      '<button class="btn ghost" id="exportBtn">Export CSV</button>',
    body:
      '<div class="card"><div class="toolbar">' +
      '<div class="search"><input id="q" class="input" placeholder="Search all hospitals — name, ID, MRN or phone…" /></div>' +
      '<div class="chips" id="chips"></div></div>' +
      '<div id="ptbl"></div>' +
      '<p class="sub" id="pcount" style="margin-top:10px">Loading…</p>' +
      '</div>' +
      (caps.canCreate ? '' : '<p class="sub">Your role cannot register patients — an administrator must grant the <strong>patient.create</strong> capability.</p>'),
  })

  const tableHost = document.getElementById('ptbl')
  const countEl = document.getElementById('pcount')
  const chipsHost = document.getElementById('chips')

  const more = createLoadMore(loadMore)

  // Fetch the next chunk and append it. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && rows.length === 0
    loading = true
    more.setLoading(true)
    // Keep the current table laid out (dimmed) while the next chunk loads —
    // clearing it made the whole card shrink and pop back.
    tableHost.querySelector('.tblwrap')?.classList.add('is-loading')
    try {
      const [pg, names] = await Promise.all([
        listOrgPatientsPage(activeOrg, { cursor }),
        first ? payerOptions().catch(() => []) : Promise.resolve([]),
      ])
      // Dedupe on patient_id: a row written between two chunk reads shifts the
      // cursor stream and can repeat the boundary document.
      const seen = new Set(rows.map((r) => r.pid))
      rows = first ? pg.rows : [...rows, ...pg.rows.filter((r) => !seen.has(r.pid))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) payerChips = names.map((o) => o.value).filter((n) => n && n !== 'Not set')
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
    } catch (e) {
      console.error('[patients] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) {
        tableHost.innerHTML = '<div class="card"><p class="sub">Could not load patients: ' + esc(friendlyPatientError(e)) + '</p>' +
          '<button class="btn" id="retryBtn">Retry</button></div>'
        countEl.textContent = ''
        const rb = document.getElementById('retryBtn')
        if (rb) rb.onclick = () => { cursor = null; loadMore() }
      } else {
        // The rows already on screen stay usable; the loader offers a retry.
        more.setError('Could not load more — retry')
      }
    } finally {
      tableHost.querySelector('.tblwrap')?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole list (refresh button).
  function reload() {
    rows = []
    cursor = null
    hasMore = false
    more.reset()
    loadMore()
  }

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
      more.destroy()
      return
    }
    if (searchTerm) {
      more.destroy()
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
      '<div class="tblwrap"><table class="tbl"><thead><tr><th style="width:36px"><input type="checkbox" id="selectAll" title="Select all" /></th><th>Patient</th><th>IDs</th><th>Contact</th><th>Payer</th><th>Status</th><th>Registered</th><th style="width:70px">Actions</th></tr></thead><tbody>' +
      (shown.length
        ? shown.map((r) =>
          '<tr class="clickable" data-pid="' + r.pid + '">' +
          '<td><input type="checkbox" class="rowSel" data-pid="' + esc(r.pid) + '" /></td>' +
          '<td><strong>' + esc(r.name) + '</strong><div class="mut">' +
            (r.sex ? esc(r.sex) + ' · ' : '') + (r.age !== '' ? r.age + 'y · ' : '') + esc(r.dob || 'no DOB') + '</div></td>' +
          '<td><strong>' + esc(r.pid) + '</strong><div class="mut">' + esc(r.mrn) + '</div></td>' +
          '<td>' + esc(formatPhone(r.phone, r.phone_key)) + '</td>' +
          '<td>' + esc(r.payer) + '</td>' +
          '<td>' + statusBadge(r.status) + '</td>' +
          '<td class="mut">' + (r.registered ? fmtDate(r.registered) : '—') + '</td>' +
          '<td>' + kebabCell({ rowId: r.pid, items: [{ label: 'Delete', tone: 'danger', dataAction: 'delete' }] }) + '</td>' +
          '</tr>').join('')
        : '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">' +
          (rows.length ? 'No patients match this filter' : 'No patients registered yet') + '</td></tr>') +
      '</tbody></table><div class="loadmore" data-loadmore="1"></div></div>'
    countEl.textContent = rows.length
      ? shown.length + ' patient' + (shown.length === 1 ? '' : 's') +
        (shown.length !== rows.length ? ' (filtered from ' + rows.length + ')' : '')
      : (rows.length ? 'No patients match this filter.' : 'No patients registered yet.')
    // Row selection + pre-check delete
    const selectAll = tableHost.querySelector('#selectAll')
    if (selectAll) {
      selectAll.onchange = () => {
        const checked = selectAll.checked
        tableHost.querySelectorAll('.rowSel').forEach((cb) => { cb.checked = checked })
        updateSelection()
      }
    }
    tableHost.querySelectorAll('.rowSel').forEach((cb) => {
      cb.onchange = updateSelection
    })

    tableHost.querySelectorAll('tr[data-pid]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('.kebab-trigger, .kebab-item, .rowSel')) return
        window.location.hash = '#/patients/' + tr.getAttribute('data-pid')
      }
    })

    // Pre-check delete: if the patient has clinical trail, block with a clear
    // message instead of opening the delete confirmation.
    wireKebabs(tableHost, async (rowId, action) => {
      if (action !== 'delete') return
      const patient = shown.find((r) => r.pid === rowId)
      const { activeOrg } = authStore.getState()
      const trail = await patientHasClinicalTrail(rowId, activeOrg)
      if (!trail.deletable) {
        toast('Cannot delete — ' + trail.trail.join(', ') + ' in this hospital. History is never deleted.')
        return
      }
      confirmDelete(patient ? patient.name : 'this patient', () => deletePatient(rowId), reload)
    })
    more.mount(tableHost.querySelector('.tblwrap'))

    function updateSelection() {
      const cbs = tableHost.querySelectorAll('.rowSel')
      selectedPids.clear()
      cbs.forEach((cb) => { if (cb.checked) selectedPids.add(cb.getAttribute('data-pid')) })
      if (selectAll) selectAll.checked = cbs.length > 0 && [...cbs].every((cb) => cb.checked)
    }
  }

  function renderSearchResults() {
    const shown = searchResults.filter((r) => {
      if (chip === 'Active' && r.status !== 'Active') return false
      if (chip !== 'All' && chip !== 'Active' && String(r.payer || '').toLowerCase() !== chip.toLowerCase()) return false
      // Same matcher the service used, so a result the registry returned is
      // never discarded here. Matching on the formatted '+234 803…' string used
      // to drop every phone hit, which is why mobile search found nothing.
      return matchesPatient(r, parsed)
    })
    tableHost.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th style="width:36px"><input type="checkbox" id="selectAllSearch" title="Select all" /></th><th>Patient</th><th>MRN</th><th>Phone</th><th>Sex / Age</th><th>Payer</th><th>Source</th><th>Actions</th></tr></thead><tbody>' +
      (shown.length
        ? shown.map((r) =>
          '<tr class="clickable" data-pid="' + esc(r.pid) + '">' +
          '<td><input type="checkbox" class="rowSel" data-pid="' + esc(r.pid) + '" /></td>' +
          '<td><strong>' + esc(r.name) + '</strong><div class="mut">' + esc(r.pid.slice(0, 8)) + '…</div></td>' +
          '<td>' + esc(r.mrn) + '</td>' +
          '<td>' + esc(formatPhone(r.phone, r.phone_key)) + '</td>' +
          '<td>' + esc(r.sex || '—') + (r.age !== '' ? ' · ' + r.age + 'y' : '') + '</td>' +
          '<td>' + esc(r.payer) + '</td>' +
          '<td>' + (r.isLocal
            ? '<span class="pill ok">Your Hospital</span>'
            : '<span class="pill info">Other Hospital</span>') + '</td>' +
          '<td>' + kebabCell({ rowId: esc(r.pid), items: [
            { label: 'Start Encounter', dataAction: 'encounter' },
            { label: 'Delete', tone: 'danger', dataAction: 'delete' }
          ] }) + '</td>' +
          '</tr>').join('')
        : '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">No patients found</td></tr>') +
      '</tbody></table></div>'
    const localCount = searchResults.filter((r) => r.isLocal).length
    const cloudCount = searchResults.filter((r) => !r.isLocal).length
    countEl.textContent = searchResults.length
      ? 'Found ' + searchResults.length + ' — ' + localCount + ' from your hospital, ' + cloudCount + ' from other hospitals'
      : parsed.isPhone
        // A clerk who mistypes a digit needs to know partial numbers are fine.
        ? 'No patient has that mobile number. Partial numbers work — try the first 4 or more digits.'
        : 'No patients found.'
    // Row selection + pre-check delete
    const selectAllSearch = tableHost.querySelector('#selectAllSearch')
    if (selectAllSearch) {
      selectAllSearch.onchange = () => {
        const checked = selectAllSearch.checked
        tableHost.querySelectorAll('.rowSel').forEach((cb) => { cb.checked = checked })
        updateSelection()
      }
    }
    tableHost.querySelectorAll('.rowSel').forEach((cb) => {
      cb.onchange = updateSelection
    })

    tableHost.querySelectorAll('tr[data-pid]').forEach((tr) => {
      // closest(), not e.target: a click can land on an icon or a <strong>
      // nested inside the encounter button, and e.target would then miss the
      // [data-enc] guard entirely and navigate away instead of opening the
      // encounter form.
      tr.onclick = (e) => {
        if (e.target.closest('.kebab-trigger, .kebab-item, .rowSel')) return
        window.location.hash = '#/patients/' + tr.getAttribute('data-pid')
      }
    })

    // Pre-check delete: block if the patient has clinical trail.
    wireKebabs(tableHost, async (rowId, action) => {
      if (action === 'encounter') {
        openEncounterModal(rowId)
        return
      }
      if (action !== 'delete') return
      const patient = shown.find((r) => r.pid === rowId)
      const { activeOrg } = authStore.getState()
      const trail = await patientHasClinicalTrail(rowId, activeOrg)
      if (!trail.deletable) {
        toast('Cannot delete — ' + trail.trail.join(', ') + ' in this hospital. History is never deleted.')
        return
      }
      confirmDelete(patient ? patient.name : 'this patient', () => deletePatient(rowId), runSearch)
    })

    function updateSelection() {
      const cbs = tableHost.querySelectorAll('.rowSel')
      selectedPids.clear()
      cbs.forEach((cb) => { if (cb.checked) selectedPids.add(cb.getAttribute('data-pid')) })
      if (selectAllSearch) selectAllSearch.checked = cbs.length > 0 && [...cbs].every((cb) => cb.checked)
    }
  }

  async function runSearch() {
    if (!searchTerm) {
      searchResults = []
      renderLocalList()
      return
    }
    const query = parsed
    const seq = ++searchSeq
    isSearching = true
    render()
    try {
      const { local, cloud } = await searchPatientsGlobally(query)
      if (seq !== searchSeq) return // a newer keystroke already won
      // Defensive de-dupe: a patient of this hospital must never be re-listed
      // as an "Other Hospital" hit, whatever the registry returns.
      const localPids = new Set(rows.map((r) => r.pid))
      searchResults = [
        ...local.map((r) => ({ ...r, isLocal: true })),
        ...cloud.filter((r) => !localPids.has(r.pid)).map((r) => ({ ...r, isLocal: false })),
      ]
    } catch (e) {
      if (seq !== searchSeq) return
      console.error('[search] failed:', e)
      searchResults = []
      toast('Search failed: ' + friendlyPatientError(e))
    }
    if (seq !== searchSeq) return
    isSearching = false
    render()
  }

  document.getElementById('refreshBtn').onclick = () => {
    if (searchTerm) {
      runSearch()
    } else {
      // Fresh data: drop every chunk loaded so far and walk again from the top.
      reload()
    }
  }
  const regBtn = document.getElementById('regBtn')
  if (regBtn) regBtn.onclick = () => { navigate('/patients/new') }

  const exportBtn = document.getElementById('exportBtn')
  if (exportBtn) exportBtn.onclick = () => exportCsv(rows)

  const q = document.getElementById('q')
  q.oninput = () => {
    searchTerm = q.value.trim()
    parsed = parseSearchTerm(searchTerm)
    searchTerm = parsed.term.toLowerCase()
    clearTimeout(searchTimer)
    if (searchTerm) {
      searchTimer = setTimeout(runSearch, 500)
    } else {
      searchSeq++
      isSearching = false
      searchResults = []
      renderLocalList()
    }
  }
  renderChips()
  wireToast(app)

  await loadMore()

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

  // Export the currently loaded patient rows to CSV.
  function exportCsv(data) {
    if (!data.length) { toast('No patients to export.'); return }
    const headers = ['Name', 'MRN', 'PID', 'Phone', 'Sex', 'Age', 'Payer', 'Status', 'Registered']
    const escCsv = (v) => String(v == null ? '' : v).replace(/"/g, '""')
    const lines = [headers.join(',')]
    for (const r of data) {
      lines.push([
        escCsv(r.name), escCsv(r.mrn), escCsv(r.pid),
        escCsv(formatPhone(r.phone, r.phone_key)), escCsv(r.sex),
        escCsv(r.age !== '' ? r.age + 'y' : '—'), escCsv(r.payer),
        escCsv(r.status), escCsv(r.registered ? fmtDate(r.registered) : '—'),
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'medilog-patients-' + new Date().toISOString().slice(0, 10) + '.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast('Exported ' + data.length + ' patient(s) to CSV')
  }
}
