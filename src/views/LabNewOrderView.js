// Full-page laboratory order entry (replaces the old modal form).
// Catalogue-driven: tests come from lab_test_catalogue with frozen prices and
// configuration snapshots taken at order time; free-text tests remain allowed
// for anything not in the catalogue. Arrives with context via query params:
//   #/laboratory/new?patient=<pid>&encounter=<eid>&session=<sid>
import { shell, toast, wireToast, wireSearchableSelect } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { createLabOrder, myLabCaps } from '../services/laboratoryService.js'
import { subscribeOrgTests, seedStarterCatalogue, myLabAdminCaps } from '../services/labCatalogueService.js'
import { addLabOrder } from '../services/consultationService.js'
import { listOrgPatientsAll, formatPhone } from '../services/patientService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { printDocument } from '../lib/print.js'
import { labRequestStructuredHtml } from '../lib/labPrintTemplates.js'
import { PRIORITIES, buildAccessionNo } from '../features/labs/domain.js'

const naira = (kobo) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG')

function ageLabel(dob) {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d.getTime())) return ''
  const ref = new Date()
  let age = ref.getFullYear() - d.getFullYear()
  const m = ref.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && ref.getDate() < d.getDate())) age -= 1
  return age + 'y'
}

export async function LabNewOrderView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myLabCaps()
  const adminCaps = myLabAdminCaps()

  if (!caps.canOrder) {
    shell(app, {
      active: '/laboratory',
      title: 'New lab order',
      body: '<div class="card"><p class="sub">Your role cannot order laboratory tests (missing <code>lab.order</code> capability). Ask an administrator.</p><a class="btn ghost" href="#/laboratory">← Back to laboratory</a></div>',
    })
    wireToast(app)
    return
  }

  const state = {
    patient: null,
    patients: [],
    patientLoadError: null,
    tests: [],
    testQuery: '',
    selected: new Map(),   // testId -> test row
    adhoc: [],            // free-text test names
    priority: 'Routine',
    facility: 'internal',
    note: '',
    submitting: false,
    done: null,           // created order row after submit
    seeding: false,
    turnaroundEstimate: 0,
    submitHint: '',
  }
  let unsubs = []

  const encounterId = params.encounter || ''
  const sessionId = params.session || ''

  shell(app, {
    active: '/laboratory',
    title: 'New lab order',
    subtitle: 'Catalogue prices and result configuration are frozen onto the order at this moment',
    actions: '<a class="btn ghost" href="#/laboratory">← Back to laboratory</a>',
    body: '<div id="order-page">Loading…</div>',
  })
  wireToast(app)

  // ---- data -----------------------------------------------------------------
  async function loadPatients() {
    try {
      const r = await listOrgPatientsAll(activeOrg)
      state.patients = r
      state.patientLoadError = null
    } catch (e) {
      state.patientLoadError = e
      state.patients = []
    }
  }

  function subscribeTests() {
    unsubs.forEach((u) => u())
    unsubs = []
    if (!activeOrg) return
    unsubs.push(subscribeOrgTests(activeOrg, (rows) => { state.tests = rows; render() }, (e) => {
      console.warn('[lab-new-order] catalogue live load failed:', e?.message || e)
      render()
    }))
  }

  // ---- derived ---------------------------------------------------------------
  function filteredTests() {
    const q = state.testQuery.toLowerCase()
    const active = state.tests.filter((t) => t.active)
    if (!q) return active
    return active.filter((t) =>
      t.name.toLowerCase().includes(q) ||
      (t.code || '').toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q))
  }

  function groupedTests() {
    const groups = new Map()
    for (const t of filteredTests()) {
      const c = t.category || 'Other'
      if (!groups.has(c)) groups.set(c, [])
      groups.get(c).push(t)
    }
    return [...groups.entries()]
  }

  function totalKobo() {
    let sum = 0
    for (const t of state.selected.values()) sum += Number(t.priceKobo) || 0
    return sum
  }

  function turnaroundEstimate() {
    let max = 0
    for (const t of state.selected.values()) {
      const h = Number(t.turnaround_hours) || 0
      if (h > max) max = h
    }
    return max
  }

  function submitHint() {
    if (!state.patient) return 'Select a patient.'
    if (!state.selected.size && !state.adhoc.length) return 'Select at least one test.'
    return ''
  }

  // ---- render ----------------------------------------------------------------
  function render() {
    const root = document.getElementById('order-page')
    if (!root) return
    if (state.done) { renderDone(root); return }

    state.turnaroundEstimate = turnaroundEstimate()
    state.submitHint = submitHint()

    const selectedIds = new Set(state.selected.keys())
    const catBody = state.tests.length === 0
      ? '<p class="mut">No catalogue tests yet. ' +
        (adminCaps.canManageCatalogue
          ? '<button class="btn ghost sm" id="seedBtn"' + (state.seeding ? ' disabled' : '') + '>' + (state.seeding ? 'Loading…' : 'Load standard starter tests') + '</button>'
          : 'Ask an administrator to set up the test catalogue — you can still enter tests as free text below.') +
        '</p>'
      : groupedTests().map(([cat, list]) =>
        '<div class="cat-group"><h4 class="cat-head">' + esc(cat) + '</h4>' +
        list.map((t) => {
          const on = selectedIds.has(t.id)
          return '<label class="cat-row' + (on ? ' on' : '') + '">' +
            '<input type="checkbox" data-test="' + esc(t.id) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="cat-name"><strong>' + esc(t.name) + '</strong> ' + (t.code ? '<span class="mut">' + esc(t.code) + '</span>' : '') +
            (t.specimenType ? '<div class="mut" style="font-size:.78rem">' + esc(t.specimenType) + (t.componentCount ? ' · ' + t.componentCount + ' analyte(s)' : '') + '</div>' : '') +
            '</span>' +
            '<span class="cat-price">' + (t.priceKobo ? naira(t.priceKobo) : '—') + '</span>' +
            '</label>'
        }).join('') + '</div>').join('')

    const patientPanel = state.patient
      ? '<div class="card sel-patient"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<div><strong>' + esc(state.patient.name) + '</strong> <span class="mut">' + esc(state.patient.mrn || state.patient.pid) + '</span>' +
        '<div class="mut" style="font-size:.82rem">' + esc(state.patient.sex || 'sex n/r') +
        (state.patient.dob ? ' · ' + esc(ageLabel(state.patient.dob)) : '') + '</div>' +
        (state.patient.phone ? '<div class="mut" style="font-size:.82rem">' + esc(formatPhone(state.patient.phone, state.patient.phone_key)) + '</div>' : '') +
        '</div><button class="btn ghost sm" id="clearPatient">Change</button></div></div>'
      : '<div class="card"><label class="fld full"><span>Patient</span>' +
        '<input class="input" id="patientFilter" aria-label="Search patients by name, ID or mobile" placeholder="Search patient by name, ID or mobile…" autocomplete="off" style="margin-bottom:6px">' +
        '<select class="input" id="patientSel"><option value="">— Select patient —</option>' +
        state.patients.map((p) => {
          const label = p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key)
          return '<option value="' + esc(p.pid) + '" data-label="' + esc(label) + '">' + esc(label) + '</option>'
        }).join('') +
        '</select></label>' +
        (state.patientLoadError ? '<p class="sub">Could not load patients: ' + esc(friendlyWriteError(state.patientLoadError)) + '</p>' : '') +
        (state.patients.length === 0 && !state.patientLoadError ? '<p class="mut">No patients registered yet.</p>' : '') +
        '</div>'

    root.innerHTML =
      patientPanel +
      '<div class="card"><div class="card-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<h3>Tests</h3>' +
      '<div class="search" style="min-width:220px;flex:1;max-width:340px"><input class="input" id="testSearch" placeholder="Filter catalogue (name, code, category)…" value="' + esc(state.testQuery) + '"></div>' +
      '</div><div id="catBodyContainer">' + catBody + '</div>' +
      '<h4 class="cat-head" style="margin-top:12px">Other tests (not in catalogue)</h4>' +
      '<textarea class="input" id="adhocInput" rows="2" placeholder="One per line, or comma separated — e.g. Ferritin">' + esc(state.adhoc.join('\n')) + '</textarea>' +
      '</div>' +
      '<div class="card"><h3>Order details</h3>' +
      '<div class="frow"><label>Priority<select class="input" id="prioritySel">' +
      PRIORITIES.map((p) => '<option' + (p === state.priority ? ' selected' : '') + '>' + esc(p) + '</option>').join('') +
      '</select></label>' +
      '<label>Lab facility<select class="input" id="facilitySel">' +
      '<option value="internal"' + (state.facility === 'internal' ? ' selected' : '') + '>Internal (in-house laboratory)</option>' +
      '<option value="external"' + (state.facility === 'external' ? ' selected' : '') + '>External (print order for the patient)</option>' +
      '</select></label></div>' +
      '<label>Clinical note / indication<textarea class="input" id="noteInput" rows="2">' + esc(state.note) + '</textarea></label>' +
      '<div class="order-sum">' +
      '<span><strong>' + (state.selected.size + state.adhoc.length) + '</strong> test(s) selected · catalogue subtotal <strong>' + naira(totalKobo()) + '</strong>' +
      (state.turnaroundEstimate ? ' · est. turnaround ' + state.turnaroundEstimate + 'h' : '') +
      (state.adhoc.length ? ' <span class="mut">(free-text tests are priced at billing)</span>' : '') + '</span>' +
      (state.submitHint ? '<span class="mut" style="color:var(--emr-bad);font-size:.8rem;margin-left:8px">' + esc(state.submitHint) + '</span>' : '') +
      '<button class="btn" id="submitBtn"' + ((state.patient && (state.selected.size || state.adhoc.length)) ? '' : ' disabled') + '>' +
      (state.submitting ? 'Placing order…' : 'Place order →') + '</button>' +
      '<button class="btn ghost" id="draftBtn"' + ((state.patient && (state.selected.size || state.adhoc.length)) ? '' : ' disabled') + '>' +
      (state.submitting ? '…' : 'Save draft') + '</button>' +
      '</div></div>'

    wire(root)
  }

  function renderCatalogue() {
    const container = document.getElementById('catBodyContainer')
    if (!container) return
    const selectedIds = new Set(state.selected.keys())
    const catBody = state.tests.length === 0
      ? '<p class="mut">No catalogue tests yet. ' +
        (adminCaps.canManageCatalogue
          ? '<button class="btn ghost sm" id="seedBtn"' + (state.seeding ? ' disabled' : '') + '>' + (state.seeding ? 'Loading…' : 'Load standard starter tests') + '</button>'
          : 'Ask an administrator to set up the test catalogue — you can still enter tests as free text below.') +
        '</p>'
      : groupedTests().map(([cat, list]) =>
        '<div class="cat-group"><h4 class="cat-head">' + esc(cat) + '</h4>' +
        list.map((t) => {
          const on = selectedIds.has(t.id)
          return '<label class="cat-row' + (on ? ' on' : '') + '">' +
            '<input type="checkbox" data-test="' + esc(t.id) + '"' + (on ? ' checked' : '') + '>' +
            '<span class="cat-name"><strong>' + esc(t.name) + '</strong> ' + (t.code ? '<span class="mut">' + esc(t.code) + '</span>' : '') +
            (t.specimenType ? '<div class="mut" style="font-size:.78rem">' + esc(t.specimenType) + (t.componentCount ? ' · ' + t.componentCount + ' analyte(s)' : '') + '</div>' : '') +
            '</span>' +
            '<span class="cat-price">' + (t.priceKobo ? naira(t.priceKobo) : '—') + '</span>' +
            '</label>'
        }).join('') + '</div>').join('')
    container.innerHTML = catBody
    container.querySelectorAll('[data-test]').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.getAttribute('data-test')
        const row = state.tests.find((x) => x.id === id)
        if (cb.checked && row) state.selected.set(id, row)
        else state.selected.delete(id)
        render()
      }
    })
  }

  function wire(root) {
    const sel = root.querySelector('#patientSel')
    if (sel) {
      wireSearchableSelect(root.querySelector('#patientFilter'), sel)
      function applyPatient() {
        const found = state.patients.find((p) => p.pid === sel.value) || null
        if (found) { state.patient = found; render() }
      }
      sel.onchange = applyPatient
      sel.addEventListener('click', applyPatient)
    }

    const cp = root.querySelector('#clearPatient')
    if (cp) cp.onclick = () => { state.patient = null; render() }

    const ts = root.querySelector('#testSearch')
    if (ts) {
      let t
      ts.oninput = () => {
        clearTimeout(t)
        t = setTimeout(() => { state.testQuery = ts.value.trim(); renderCatalogue() }, 500)
      }
    }
    root.querySelectorAll('[data-test]').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.getAttribute('data-test')
        const row = state.tests.find((x) => x.id === id)
        if (cb.checked && row) state.selected.set(id, row)
        else state.selected.delete(id)
        render()
      }
    })
    const ad = root.querySelector('#adhocInput')
    if (ad) {
      ad.onchange = () => {
        const names = ad.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
        // Dedupe (case-insensitive), preserve order.
        const seen = new Set()
        state.adhoc = names.filter((n) => {
          const k = n.toLowerCase()
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        render()
      }
    }
    const pri = root.querySelector('#prioritySel')
    if (pri) pri.onchange = () => { state.priority = pri.value }
    const fac = root.querySelector('#facilitySel')
    if (fac) fac.onchange = () => { state.facility = fac.value }
    const note = root.querySelector('#noteInput')
    if (note) note.onchange = () => { state.note = note.value }

    const seed = root.querySelector('#seedBtn')
    if (seed) {
      seed.onclick = async () => {
        state.seeding = true
        render()
        try {
          const created = await seedStarterCatalogue()
          toast(created.length + ' starter tests loaded — review prices and add reference ranges in the catalogue')
        } catch (e) { toast(friendlyWriteError(e, 'Could not load starter tests')) }
        state.seeding = false
        render()
      }
    }

    const submit = root.querySelector('#submitBtn')
    if (submit) submit.onclick = () => onSubmit(false)
    const draftBtn = root.querySelector('#draftBtn')
    if (draftBtn) draftBtn.onclick = () => onSubmit(true)
  }

  async function onSubmit(draft) {
    if (!state.patient) { toast('Select a patient first.'); return }
    if (!state.selected.size && !state.adhoc.length) { toast('Select at least one test.'); return }
    if (state.submitting) return
    state.submitting = true
    render()
    try {
      // Flush any half-edited fields the user never blurred.
      const noteEl = document.getElementById('noteInput')
      const adEl = document.getElementById('adhocInput')
      const note = noteEl ? noteEl.value.trim() : state.note
      const adhoc = adEl ? adEl.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) : state.adhoc

      const created = await createLabOrder({
        patient_id: state.patient.pid,
        patient_name: state.patient.name,
        encounter_id: encounterId,
        admission_session_id: sessionId,
        test_ids: [...state.selected.keys()],
        tests: adhoc,
        facility: state.facility,
        priority: state.priority,
        note,
        source: encounterId || sessionId ? 'hospital' : 'standalone',
      })
      // Encounter snapshot (best-effort): the consultation screen reads the
      // order summary from the encounter; a lab_scientist without
      // encounter.edit still succeeds — the canonical doc is lab_orders.
      if (encounterId) {
        try {
          await addLabOrder(encounterId, {
            lab_order_id: created.id,
            test_panel: created.test_panel,
            tests: created.tests,
            priority: state.priority,
          })
        } catch (e) {
          console.warn('[lab-new-order] encounter snapshot skipped:', e?.message || e)
        }
      }
      const row = await import('../services/laboratoryService.js').then((m) => m.getLabOrder(created.id))
      state.done = row || { ...created, id: created.id, items: created.items, orderNo: created.order_no }
      state.submitting = false
      toast(draft ? 'Draft saved' : 'Lab order placed')
      render()
    } catch (e) {
      state.submitting = false
      render()
      toast(friendlyWriteError(e, 'Could not place the order'))
    }
  }

  function renderDone(root) {
    const o = state.done
    root.innerHTML =
      '<div class="card" style="text-align:center;padding:28px">' +
      '<div style="font-size:2rem">✓</div>' +
      '<h3>Lab order placed</h3>' +
      '<p class="sub">' + esc(o.orderNo || o.id) + ' · ' + esc(o.patientName || state.patient?.name || '') + '</p>' +
      '<ul style="list-style:none;padding:0;margin:12px auto;max-width:520px;text-align:left">' +
      ((o.items && o.items.length ? o.items : []).map((it) =>
        '<li style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9">' +
        '<span>' + esc(it.test_name) + (it.test_code ? ' <span class="mut">' + esc(it.test_code) + '</span>' : '') + '</span>' +
        '<span class="mut">' + esc(it.specimen_type || '') + '</span>' +
        '<span>' + (it.price_kobo ? naira(it.price_kobo) : '<span class="mut">priced at billing</span>') + '</span></li>').join('')) +
      '</ul>' +
      '<p class="sub">Subtotal <strong>' + naira(o.totalKobo) + '</strong>' + (o.facility === 'external' ? ' · external order — print the slip for the patient' : '') + '</p>' +
      '<div class="mrow" style="justify-content:center">' +
      '<button class="btn" id="printReqBtn">🖨 Print request slip</button>' +
      '<a class="btn ghost" href="#/laboratory/orders/' + esc(o.id) + '">Open order →</a>' +
      '<button class="btn ghost" id="againBtn">Order another</button>' +
      '</div></div>'

    root.querySelector('#printReqBtn').onclick = () => {
      printDocument('Lab request', labRequestStructuredHtml(o, {
        hospitalName: authStore.getState().activeOrgName,
        patient: { mrn: state.patient?.mrn || '' },
      }))
    }
    root.querySelector('#againBtn').onclick = () => {
      state.done = null
      state.selected.clear()
      state.adhoc = []
      state.note = ''
      render()
    }
  }

  // ---- boot ------------------------------------------------------------------
  onCleanup(() => unsubs.forEach((u) => u()))
  await loadPatients()
  if (params.patient) {
    state.patient = state.patients.find((p) => p.pid === params.patient) || null
    if (!state.patient) {
      // The param may reference a patient outside the first page — try by id.
      try {
        const { getPatient } = await import('../services/patientService.js')
        const p = await getPatient(params.patient)
        if (p) state.patient = p
      } catch { /* fall through to the picker */ }
    }
  }
  render()
  subscribeTests()
}
