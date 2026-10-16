// Patient 360 profile — real Firestore reads/writes (offline-first, cached).
import { authStore } from '../store/authStore.js'
import { shell, setPage, skeletonCard, statusBadge, formModal, toast, closeModal, openModal, wireToast } from '../components/shell.js'
import { esc } from '../utils/sanitize.js'
import { emptyRow } from '../data/mockData.js'
import { can } from '../features/admin/roles.js'
import { myActiveMembership, getClinicalStaff } from '../services/authService.js'
import { payerOptions } from '../services/payerService.js'
import {
  getPatient, updatePatient, listPatientDocs, createPatientDoc, findOpenEncounterForPatient,
  myPatientCaps, friendlyPatientError, formatPhone,
} from '../services/patientService.js'
import {
  createAdmission, dischargeAdmission, listOrgWards, validateAdmissionInput, normalizeAdmission,
  ADMISSION_TYPES,
} from '../services/admissionService.js'
import { listOrgDrugs, requestMedicationLines, updateRequestItems } from '../services/pharmacyService.js'
import { openPrescriptionModal } from '../features/pharmacy/prescriptionModal.js'
import * as R from '../features/pharmacy/requests.js'
import { printDocument } from '../lib/print.js'
import { prescriptionHtml } from '../lib/prescriptionPrint.js'
import { enqueue } from '../services/clinicalOutbox.js'

const TABS = ['Dashboard', 'Personal Data', 'Blood & Allergies', 'Next of Kin', 'Timeline', 'Encounters', 'Vitals', 'Diagnoses', 'Medications', 'Labs', 'Admissions', 'Documents']
const SEXES = [{ value: '', label: 'Not set' }, 'Female', 'Male']
const BLOOD_GROUPS = [{ value: '', label: 'Not set' }, 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']

function ms(t) {
  return t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0)
}
function when(t) {
  const m = ms(t)
  return m ? new Date(m).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}
function s(v, fallback = '—') {
  const t = String(v == null ? '' : v).trim()
  return t || fallback
}

function table(cols, rows, htmlRow) {
  return '<div class="tblwrap"><table class="tbl"><tr>' + cols.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr>' +
    (rows.length ? rows.map(htmlRow).join('') : emptyRow(cols.length)) + '</table></div>'
}

export async function PatientDetailView(app, params = {}) {
  const pid = params.id
  const caps = myPatientCaps()
  const canVitals = can(myActiveMembership(), 'vitals.create')
  const canDx = can(myActiveMembership(), 'diagnosis.create')
  const canRx = can(myActiveMembership(), 'prescription.create')
  const canEncounter = can(myActiveMembership(), 'encounter.create')
  const canAdmit = can(myActiveMembership(), 'beds.manage')

  let p = null
  let loadError = null
  const backActions = '<a class="btn ghost" href="#/patients">← All patients</a>'

  // Paint the chrome and a skeleton FIRST, then read the record. Fetching
  // before painting left the router's blank "Loading…" screen on screen for
  // the whole query, which is what made the patients list blink on selection.
  shell(app, {
    active: '/patients',
    title: 'Patient',
    subtitle: 'Loading record…',
    actions: backActions,
    body: skeletonCard(5),
  })

  try {
    p = await getPatient(pid)
  } catch (e) {
    loadError = friendlyPatientError(e)
  }

  if (loadError) {
    setPage({
      title: 'Patient',
      subtitle: 'Could not load record',
      actions: backActions,
      body: '<div class="card"><p class="sub">' + esc(loadError) + '</p><button class="btn" id="rBtn">Retry</button></div>',
    })
    const rb = document.getElementById('rBtn')
    if (rb) rb.onclick = () => PatientDetailView(app, params)
    return
  }
  if (!p) {
    setPage({
      title: 'Patient not found',
      subtitle: 'No record matches ' + pid,
      actions: backActions,
      body: '<div class="card"><p class="sub">This patient record does not exist, or it belongs to a different hospital.</p></div>',
    })
    return
  }

  const ini = (p.name || '').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  const subtitle = [p.pid, p.mrn || 'no MRN', p.sex, p.age !== '' ? p.age + 'y' : '', p.payer]
    .filter(Boolean).join(' · ')

  const body =
    '<div class="phead"><span class="pavatar">' + esc(ini) + '</span>' +
    '<div style="flex:1;min-width:220px"><h2>' + esc(p.name) + ' ' + statusBadge(p.status) + '</h2>' +
    '<div class="meta">DOB ' + esc(p.dob || 'not recorded') + ' · ' + esc(formatPhone(p.phone, p.phone_key)) +
    ' · Registered ' + (p.registered ? new Date(p.registered).toLocaleDateString('en-NG') : '—') + '</div>' +
    '<div class="allergy">⚠ Allergy: <strong>' + esc(p.allergy_display || 'None known') + '</strong> — always confirm before prescribing</div></div>' +
    '<div><div class="kv" style="grid-template-columns:1fr 1fr">' +
    '<div><em>Payer</em><strong>' + esc(p.payer) + '</strong></div>' +
    '<div><em>Sync</em><strong style="font-size:.85rem">● ' + (navigator.onLine !== false ? 'Firestore' : 'Local cache') + '</strong></div>' +
    '</div></div></div>' +
    '<div class="tabs" id="ptabs">' + TABS.map((t, i) => '<button data-t="' + t + '" class="' + (i === 0 ? 'on' : '') + '">' + t + '</button>').join('') + '</div>' +
    '<div id="ppane"></div>'

  setPage({
    title: p.name,
    subtitle,
    actions:
      backActions +
      (caps.canUpdate ? '<button class="btn ghost" id="editBtn">Edit demographics</button>' : '') +
      (canEncounter ? '<button class="btn" id="encBtn">Start encounter</button>' : ''),
    body,
  })

  // Navigate to modern edit page
  const editBtn = document.getElementById('editBtn')
  if (editBtn) editBtn.onclick = () => { window.location.hash = '#/patients/' + pid + '/edit' }

  function openEdit() {
    window.location.hash = '#/patients/' + pid + '/edit'
  }

  const pane = document.getElementById('ppane')
  let renderSeq = 0

  // ---- pane builders (async where data must be fetched) ---------------------
  async function loadTab(name) {
    try {
      return await listPatientDocs(tabCollection(name), pid)
    } catch (e) {
      return { error: friendlyPatientError(e), rows: [] }
    }
  }

  function tabCollection(name) {
    return ({
      Dashboard: null,
      Timeline: 'encounters',
      Encounters: 'encounters',
      Vitals: 'vitals',
      Diagnoses: 'diagnoses',
      Medications: 'medication_requests',
      Labs: 'lab_orders',
      Admissions: 'admissions',
      Documents: 'documents',
    })[name]
  }

  // ---- Dashboard data loading & rendering -------------------------------------
  let dashboardFilter = 'vitals'

  async function loadDashboardData() {
    try {
      const [vitalsRes, encountersRes, diagnosesRes, medsRes, labsRes, admissionsRes, docsRes] = await Promise.all([
        listPatientDocs('vitals', pid),
        listPatientDocs('encounters', pid),
        listPatientDocs('diagnoses', pid),
        listPatientDocs('medication_requests', pid),
        listPatientDocs('lab_orders', pid),
        listPatientDocs('admissions', pid),
        listPatientDocs('documents', pid),
      ])

      const allVitals = vitalsRes.rows || []
      const latestVitals = allVitals[0] || null

      // Build unified timeline
      const timeline = buildUnifiedTimeline(
        encountersRes.rows || [],
        allVitals,
        diagnosesRes.rows || [],
        medsRes.rows || [],
        labsRes.rows || [],
        admissionsRes.rows || [],
        docsRes.rows || []
      )

      // Active diagnoses (status === 'Active')
      const activeDiagnoses = (diagnosesRes.rows || []).filter(d => (d.status || 'Active') === 'Active')

      // Current medications: medicines from scripts that are active or partly
      // issued. Legacy rows carry their medicine at the top level rather than in
      // `items`, so normalizeRequest is what makes both shapes comparable.
      const activeMeds = (medsRes.rows || []).filter(m => {
        const script = R.normalizeRequest(m)
        return script.status === 'Dispensed' || script.status === 'Partially dispensed'
      })

      // Allergies from patient record
      const allergies = Array.isArray(p.allergy) ? p.allergy : (p.allergy ? String(p.allergy).split(/[,;]/).map(s => s.trim()).filter(Boolean) : [])

      return {
        latestVitals,
        allVitals,
        timeline,
        activeDiagnoses,
        activeMeds,
        allergies,
      }
    } catch (e) {
      console.error('[dashboard] load failed:', e)
      toast('Could not load dashboard: ' + friendlyPatientError(e))
      return { latestVitals: null, allVitals: [], timeline: [], activeDiagnoses: [], activeMeds: [], allergies: [] }
    }
  }

  function buildUnifiedTimeline(encounters, vitals, diagnoses, meds, labs, admissions, docs) {
    const entries = []

    // Encounters
    for (const e of encounters) {
      entries.push({
        type: 'encounter',
        timestamp: e.created_at,
        icon: '🏥',
        primary: s(e.encounter_type || e.type || e.reason || 'Encounter'),
        secondary: s(e.reason || e.chief_complaint || 'No reason recorded') + ' · ' + encLabel(e.status),
        status: e.status,
        clinician: s(e.clinician_name || e.clinician || e.created_by_name),
        raw: e,
      })
    }

    // Vitals
    for (const v of vitals) {
      const bp = (v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—')
      const parts = ['BP ' + bp]
      if (v.pulse) parts.push('P ' + v.pulse)
      if (v.temp_c) parts.push('T ' + v.temp_c + '°C')
      if (v.spo2) parts.push('SpO₂ ' + v.spo2 + '%')
      if (v.rr) parts.push('RR ' + v.rr)
      if (v.weight_kg) parts.push(v.weight_kg + ' kg')
      entries.push({
        type: 'vitals',
        timestamp: v.created_at,
        icon: '📍',
        primary: parts.join('  •  '),
        secondary: s(v.created_by_name || v.created_by),
        clinician: s(v.created_by_name || v.created_by),
        raw: v,
      })
    }

    // Diagnoses
    for (const d of diagnoses) {
      entries.push({
        type: 'diagnosis',
        timestamp: d.created_at,
        icon: '🩺',
        primary: s(d.condition || d.name || d.icd_code || 'Diagnosis'),
        secondary: (d.icd_code ? '[' + d.icd_code + '] ' : '') + s(d.status, 'Active') + ' · ' + s(d.created_by_name || d.created_by),
        status: d.status,
        clinician: s(d.created_by_name || d.created_by),
        raw: d,
      })
    }

    // Medications
    for (const m of meds) {
      entries.push({
        type: 'medication',
        timestamp: m.created_at,
        icon: '💊',
        primary: s(m.medicine || m.name) + ' ' + s(m.dosage) + (m.quantity ? ' ×' + m.quantity : ''),
        secondary: s(m.status, 'Requested') + ' · ' + s(m.created_by_name || m.created_by),
        status: m.status,
        clinician: s(m.created_by_name || m.created_by),
        raw: m,
      })
    }

    // Labs
    for (const l of labs) {
      entries.push({
        type: 'lab',
        timestamp: l.created_at,
        icon: '🧪',
        primary: s(l.test || l.test_panel || l.panel || 'Lab order'),
        secondary: s(l.stage || l.status, 'Ordered') + (l.priority ? ' · ' + l.priority : '') + ' · ' + s(l.created_by_name || l.created_by),
        status: l.stage || l.status,
        clinician: s(l.created_by_name || l.created_by),
        raw: l,
      })
    }

    // Admissions. Normalized so the timeline shows the same ward/bed/status the
    // bed board shows, and records the encounter that triggered the admission.
    for (const raw of admissions) {
      const a = normalizeAdmission(raw)
      entries.push({
        type: 'admission',
        timestamp: a.admissionDate || a.createdAt,
        icon: '🛏️',
        primary: s(a.wardName) + ' · ' + s(a.bedNumber),
        secondary: s(a.attendingProvider) + ' · ' + s(a.status === 'discharged' ? 'Discharged' : 'Admitted') +
          (a.encounterId ? ' · from encounter ' + a.encounterId.slice(0, 8) + '…' : ''),
        status: a.status,
        clinician: s(a.attendingProvider),
        raw: a,
      })
    }

    // Documents
    for (const d of docs) {
      entries.push({
        type: 'document',
        timestamp: d.created_at,
        icon: '📄',
        primary: s(d.name || d.filename || d.title || 'Document'),
        secondary: s(d.type || d.kind) + ' · ' + s(d.created_by_name || d.created_by),
        clinician: s(d.created_by_name || d.created_by),
        raw: d,
      })
    }

    // Sort by timestamp descending
    entries.sort((a, b) => ms(b.timestamp) - ms(a.timestamp))
    return entries
  }

  function encLabel(status) {
    const map = {
      arrived: 'Arrived',
      'vitals-taken': 'Vitals Taken',
      'in-consultation': 'In Consultation',
      diagnosed: 'Diagnosed',
      planned: 'Plan Set',
      closed: 'Closed',
      open: 'Open',
      active: 'Active',
      admitted: 'Admitted',
      discharged: 'Discharged',
    }
    return map[status?.toLowerCase?.()] || s(status, '—')
  }

  // Tone-matched pill per encounter status. The shared statusBadge() (shell.js)
  // keys off capitalised display labels and knows none of these, so it used to
  // print encounter statuses as bare uncoloured pills showing the raw key.
  function encBadge(status) {
    const tones = {
      arrived: 'warn', 'vitals-taken': 'info', 'in-consultation': 'info',
      diagnosed: 'info', planned: 'ok', closed: 'ok',
    }
    return '<span class="pill ' + (tones[status?.toLowerCase?.()] || '') + '">' + esc(encLabel(status)) + '</span>'
  }

  function vitalTrend(current, previous) {
    if (current == null || previous == null) return { text: '', class: '' }
    const diff = Number(current) - Number(previous)
    if (diff > 0) return { text: '↑' + diff, class: 'up' }
    if (diff < 0) return { text: '↓' + Math.abs(diff), class: 'down' }
    return { text: '→', class: 'stable' }
  }

  function buildDashboardPane() {
    const d = loadCache.Dashboard || { latestVitals: null, allVitals: [], timeline: [], activeDiagnoses: [], activeMeds: [], allergies: [] }
    const v = d.latestVitals
    const prevVitals = d.allVitals[1] || null

    // Vital cards data
    const vitalCards = []
    if (v) {
      vitalCards.push({ label: 'BP', value: (v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—'), primary: true, trend: vitalTrend(v.bp_systolic, prevVitals?.bp_systolic) })
      vitalCards.push({ label: 'Pulse', value: s(v.pulse) + ' bpm', trend: vitalTrend(v.pulse, prevVitals?.pulse) })
      vitalCards.push({ label: 'Temp', value: s(v.temp_c) + ' °C', trend: vitalTrend(v.temp_c, prevVitals?.temp_c) })
      vitalCards.push({ label: 'SpO₂', value: s(v.spo2) + '%', trend: vitalTrend(v.spo2, prevVitals?.spo2) })
      if (v.weight_kg) vitalCards.push({ label: 'Weight', value: s(v.weight_kg) + ' kg', trend: vitalTrend(v.weight_kg, prevVitals?.weight_kg) })
      if (v.bmi || (v.weight_kg && v.height_cm)) {
        const bmi = v.bmi || (v.weight_kg && v.height_cm ? (v.weight_kg / Math.pow(v.height_cm / 100, 2)).toFixed(1) : '—')
        vitalCards.push({ label: 'BMI', value: s(bmi), trend: vitalTrend(bmi, prevVitals?.bmi) })
      }
    } else {
      vitalCards.push({ label: 'BP', value: '—', primary: true })
      vitalCards.push({ label: 'Pulse', value: '—' })
      vitalCards.push({ label: 'Temp', value: '—' })
      vitalCards.push({ label: 'SpO₂', value: '—' })
    }

    // Filter options
    const filterOptions = [
      { value: 'vitals', label: 'Vitals/BP' },
      { value: 'all', label: 'All Clinical Events' },
      { value: 'encounters', label: 'Encounters Only' },
      { value: 'diagnoses', label: 'Diagnoses' },
      { value: 'medications', label: 'Medications' },
      { value: 'labs', label: 'Lab Orders/Results' },
      { value: 'admissions', label: 'Admissions' },
      { value: 'documents', label: 'Documents' },
    ]

    // Filter timeline based on selected filter
    let filteredTimeline = d.timeline
    if (dashboardFilter === 'vitals') {
      filteredTimeline = d.timeline.filter(e => e.type === 'vitals')
    } else if (dashboardFilter !== 'all') {
      filteredTimeline = d.timeline.filter(e => e.type === dashboardFilter)
    }

    // Render vital cards
    const vitalCardsHtml = vitalCards.map(c => `
      <div class="vital-card${c.primary ? ' primary' : ''}">
        <div class="vital-label">${esc(c.label)}</div>
        <div class="vital-value">${esc(c.value)}</div>
        ${c.trend ? '<div class="vital-trend ' + c.trend.class + '">' + esc(c.trend.text) + '</div>' : ''}
      </div>
    `).join('')

    // Render timeline feed
    const timelineHtml = filteredTimeline.length
      ? filteredTimeline.slice(0, 30).map(e => `
        <div class="feed-item" data-type="${esc(e.type)}">
          <div class="feed-icon">${e.icon}</div>
          <div class="feed-content">
            <div class="feed-primary">${esc(e.primary)}</div>
            <div class="feed-secondary">${esc(e.secondary)}</div>
          </div>
          <div class="feed-meta">
            <span>${esc(when(e.timestamp))}</span>
            ${e.clinician ? '<span>' + esc(e.clinician) + '</span>' : ''}
            ${e.status ? '<span class="pill">' + esc(encLabel(e.status)) + '</span>' : ''}
          </div>
        </div>
      `).join('')
      : '<div class="feed-empty"><p class="sub" style="text-align:center;padding:24px">No ' + (dashboardFilter === 'vitals' ? 'vitals' : dashboardFilter) + ' recorded yet.</p></div>'

    // Clinical summary sections
    const diagnosesHtml = d.activeDiagnoses.length
      ? d.activeDiagnoses.map(dx => `
        <div class="summary-item">
          <div class="summary-item-main">
            <span class="summary-item-label">${esc(dx.condition || dx.name || dx.icd_code || 'Diagnosis')}</span>
            <span class="summary-item-detail">${dx.icd_code ? '[' + esc(dx.icd_code) + ']' : ''} ${esc(dx.status || 'Active')} · ${esc(s(dx.created_by_name || dx.created_by))} · ${esc(when(dx.created_at))}</span>
          </div>
          <span class="pill ok">${esc(dx.status || 'Active')}</span>
        </div>
      `).join('')
      : '<p class="sub">No active diagnoses.</p>'

    // Flattened to one entry per medicine, since a prescription holds several.
    const activeLines = d.activeMeds.flatMap(m => R.toRequestItems(m).map(l => ({
      line: l,
      script: R.normalizeRequest(m),
      createdBy: m.created_by_name || m.created_by || '',
      createdAt: m.created_at,
    })))

    const medsHtml = activeLines.length
      ? activeLines.map(({ line: l, script, createdBy, createdAt }) => {
        const issued = R.toQty(l.dispensed_qty, 0)
        const owed = R.lineOutstanding(l)
        return `
        <div class="summary-item">
          <div class="summary-item-main">
            <span class="summary-item-label">${esc(l.medicine)}</span>
            <span class="summary-item-detail">${esc(l.dosage)} ${l.quantity ? '×' + l.quantity : ''} · ${esc(when(createdAt))} · ${esc(createdBy)}</span>
          </div>
          <span class="pill ${owed === 0 ? 'ok' : 'warn'}">${owed === 0 ? 'Dispensed' : issued + ' of ' + R.toQty(l.quantity, 0) + ' issued'}</span>
        </div>`
      }).join('')
      : '<p class="sub">No current medications.</p>'

    const allergiesHtml = d.allergies.length
      ? d.allergies.map(a => '<span class="allergy-tag-display">' + esc(a) + '</span>').join(' ')
      : '<span class="mut">None known</span>'

    // Quick actions (capability-gated)
    const quickActions = []
    if (canEncounter) quickActions.push('<button class="btn" id="dashEncBtn">Start Encounter</button>')
    if (canVitals) quickActions.push('<button class="btn" id="dashVitalsBtn">Record Vitals</button>')
    if (canDx) quickActions.push('<button class="btn ghost" id="dashDxBtn">+ Diagnosis</button>')
    if (canRx) quickActions.push('<button class="btn ghost" id="dashRxBtn">+ Prescription</button>')
    if (canAdmit) quickActions.push('<button class="btn ghost" id="dashAdmBtn">+ Admission</button>')

    return `
      <div class="dashboard-pane">
        <!-- Vitals Snapshot -->
        <div class="vitals-snapshot" role="region" aria-label="Latest vitals">
          ${vitalCardsHtml}
        </div>

        <div class="dashboard-grid">
          <!-- Left: Clinical Summary -->
          <div class="clinical-summary">
            <div class="summary-card">
              <div class="summary-header">
                <div class="summary-title">🩺 Active Diagnoses <span class="summary-count">${d.activeDiagnoses.length}</span></div>
              </div>
              <div class="summary-list">${diagnosesHtml}</div>
            </div>
            <div class="summary-card">
              <div class="summary-header">
                <div class="summary-title">💊 Current Medications <span class="summary-count">${activeLines.length}</span></div>
              </div>
              <div class="summary-list">${medsHtml}</div>
            </div>
            <div class="summary-card">
              <div class="summary-header">
                <div class="summary-title">⚠ Allergies <span class="summary-count">${d.allergies.length}</span></div>
              </div>
              <div class="summary-list" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${allergiesHtml}</div>
            </div>
          </div>

          <!-- Right: Progress Feed (Chat-style) -->
          <div class="progress-feed" role="region" aria-label="Clinical progress feed">
            <div class="feed-filter">
              <label class="fld" style="margin:0;display:flex;align-items:center;gap:8px">
                <span style="font-size:.75rem;color:var(--emr-muted);font-weight:600">Filter:</span>
                <select id="feedFilter" class="input" style="width:auto;min-width:200px;padding:6px 10px;font-size:.8rem">
                  ${filterOptions.map(opt => '<option value="' + opt.value + '"' + (dashboardFilter === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>').join('')}
                </select>
              </label>
            </div>
            <div class="feed-list" id="feedList">
              ${timelineHtml}
            </div>
            ${filteredTimeline.length > 30 ? '<div class="feed-load-more" style="text-align:center;padding:12px"><button class="btn ghost sm" id="feedLoadMore">Load More</button></div>' : ''}
          </div>
        </div>

        <!-- Quick Actions Bar -->
        ${quickActions.length ? '<div class="dashboard-actions" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--emr-line);display:flex;gap:8px;flex-wrap:wrap">' + quickActions.join('') + '</div>' : ''}
      </div>
    `
  }

function paneHtml(t) {
    if (t === 'Dashboard') {
      return buildDashboardPane()
    }
    if (t === 'Personal Data') {
      return '<div class="grid2x">' +
        '<div class="card"><h3>Personal details</h3>' +
        '<p class="sub">Source: this hospital\'s record.</p>' +
        '<div class="kv">' +
        '<div><em>Surname</em><strong>' + esc(s(p.surname, 'Not recorded')) + '</strong></div>' +
        '<div><em>Given name(s)</em><strong>' + esc(s(p.given_names, 'Not recorded')) + '</strong></div>' +
        '<div><em>Sex</em><strong>' + esc(s(p.sex, 'Not recorded')) + '</strong></div>' +
        '<div><em>Date of birth</em><strong>' + esc(s(p.dob, 'Not recorded')) + '</strong></div>' +
        '<div><em>Age</em><strong>' + esc(p.age !== '' ? p.age + ' years' : 'Not recorded') + '</strong></div>' +
        '<div><em>Phone</em><strong>' + esc(formatPhone(p.phone, p.phone_key)) + '</strong></div>' +
        '<div><em>Occupation</em><strong>' + esc(s(p.occupation, 'Not recorded')) + '</strong></div>' +
        '<div><em>Address</em><strong>' + esc(s(p.address, 'Not recorded')) + '</strong></div>' +
        '<div><em>Payer</em><strong>' + esc(s(p.payer, 'Not recorded')) + '</strong></div>' +
        '</div>' +
        (caps.canUpdate ? '<br/><button class="btn ghost" data-edit-pane>Edit demographics</button>' : '') +
        '</div>' +
        '<div>' +
        '<div class="card"><h3>Billing</h3><p class="sub">Outstanding balance: no invoices linked to this patient yet.</p>' +
        '<a class="btn ghost sm" href="#/billing?patient=' + encodeURIComponent(pid) + '&new=1">Open billing for ' + esc(p.name) + ' →</a></div>' +
        '<div class="card"><h3>Consent & access</h3><p class="sub">Recorded consents appear here. Cross-hospital access always requires reason + audit.</p>' +
        '<button class="btn ghost sm" id="consentBtn">Record consent</button></div>' +
        '</div></div>'
    }
    if (t === 'Blood & Allergies') {
      return '<div class="grid2x">' +
        '<div class="card"><h3>Blood group</h3>' +
        '<div class="kv">' +
        '<div><em>Blood group (ABO/Rh)</em><strong>' + esc(s(p.blood_group, 'Not recorded')) + '</strong></div>' +
        '<div><em>Genotype</em><strong>' + esc(s(p.genotype, 'Not recorded')) + '</strong></div>' +
        '</div>' +
        (caps.canUpdate ? '<br/><button class="btn ghost" data-edit-pane>Edit blood group</button>' : '') +
        '</div>' +
        '<div class="card"><h3>Allergies</h3>' +
        '<p class="sub">Always confirm before prescribing.</p>' +
        '<div class="allergy-tags-display">' +
        (Array.isArray(p.allergy) && p.allergy.length > 0
          ? p.allergy.map(a => '<span class="allergy-tag-display">' + esc(a) + '</span>').join('')
          : '<span class="mut">None known</span>') +
        '</div>' +
        (caps.canUpdate ? '<br/><button class="btn ghost" data-edit-pane>Edit allergies</button>' : '') +
        '</div>' +
        '</div>'
    }
    if (t === 'Next of Kin') {
      return '<div class="card"><h3>Next of kin details</h3>' +
        '<p class="sub">Emergency contact information.</p>' +
        '<div class="kv">' +
        '<div><em>Full name</em><strong>' + esc(s(p.next_of_kin_name, 'Not recorded')) + '</strong></div>' +
        '<div><em>Phone</em><strong>' + esc(formatPhone(p.next_of_kin_phone, p.next_of_kin_phone_key)) + '</strong></div>' +
        '<div><em>Address</em><strong>' + esc(s(p.next_of_kin_address, 'Not recorded')) + '</strong></div>' +
        '</div>' +
        (caps.canUpdate ? '<br/><button class="btn ghost" data-edit-pane>Edit next of kin</button>' : '') +
        '</div>'
    }
    if (t === 'Timeline') {
      const res = loadCache.Timeline
      const rows = (res && res.rows) || []
      if (res && res.error) return '<p class="sub">Could not load: ' + esc(res.error) + '</p>'
      return '<div class="timeline">' +
        (rows.length
          ? rows.map((e) => '<div class="titem"><div class="when">' + esc(when(e.created_at)) + '</div>' +
            '<strong>' + esc(s(e.encounter_type || e.type || e.reason || 'Encounter')) + '</strong>' +
            '<div class="mut">' + esc(s(e.clinician_name || e.clinician || e.note || e.title, 'No detail recorded')) + '</div></div>').join('')
          : '<p class="sub">No clinical events recorded yet for this patient.</p>') +
        '</div>'
    }
    // Tabular tabs
    const res = loadCache[t] || { rows: [], error: null }
    if (res.error) return '<p class="sub">Could not load: ' + esc(res.error) + '</p>'
    const rows = res.rows
    switch (t) {
      case 'Encounters':
        return table(['When', 'Type', 'Clinician', 'Status'], rows, (e) =>
          '<tr><td>' + esc(when(e.created_at)) + '</td><td><strong>' + esc(s(e.encounter_type || e.type || e.reason)) + '</strong></td>' +
          '<td>' + esc(s(e.clinician_name || e.clinician || e.created_by)) + '</td><td>' + encBadge(e.status) + '</td></tr>')
      case 'Vitals':
        return table(['When', 'BP', 'Pulse', 'Temp', 'SpO₂', 'By'], rows, (v) =>
          '<tr><td>' + esc(when(v.created_at)) + '</td>' +
          '<td><strong>' + esc((v.bp_systolic || '—') + '/' + (v.bp_diastolic || '—')) + '</strong></td>' +
          '<td>' + esc(s(v.pulse)) + '</td><td>' + esc(s(v.temp_c)) + '</td><td>' + esc(s(v.spo2)) + '</td>' +
          '<td class="mut">' + esc(s(v.created_by_name || v.created_by)) + '</td></tr>') +
          (canVitals ? '<br/><button class="btn" id="vitalsBtn">+ Record vitals</button>' : '')
      case 'Diagnoses':
        return table(['Condition', 'Recorded', 'Status'], rows, (d) =>
          '<tr><td><strong>' + esc(s(d.condition || d.name || d.icd_code)) + '</strong>' +
          (d.icd_code ? '<div class="mut">' + esc(d.icd_code) + '</div>' : '') + '</td>' +
          '<td>' + esc(when(d.created_at)) + '</td><td>' + statusBadge(s(d.status, 'Active')) + '</td></tr>') +
          (canDx ? '<br/><button class="btn ghost" id="dxBtn">+ Add diagnosis</button>' : '')
      case 'Medications': {
        // ONE row per prescription. A request is a whole script for this
        // patient, so the chart reads it as a single order you can open — not a
        // row per pill. The row expands to every line it holds, prints for the
        // patient, and offers an edit while the script is still open.
        const scriptRows = rows.map((raw) => {
          const script = R.normalizeRequest(raw)
          const id = esc(script.id)
          const open = R.isOpenRequest(script.status) || script.status === R.REQUEST_STATUS.EXTERNAL
          const names = script.items.map((l) => l.medicine || 'item')
          const summary = (names.slice(0, 2).join(', ') || '—') +
            (names.length > 2 ? ' <span class="mut">+' + (names.length - 2) + ' more</span>' : '')
          const lines = script.items.map((l) => {
            const issued = R.toQty(l.dispensed_qty, 0)
            return '<tr><td><strong>' + esc(s(l.medicine)) + '</strong>' +
              (l.external ? ' <span class="pill info">external</span>' : '') + '</td>' +
              '<td>' + esc(s(l.dosage)) + '</td>' +
              '<td>' + esc(R.toQty(l.quantity, 0)) + (l.unit ? ' ' + esc(l.unit) : '') + '</td>' +
              '<td>' + (issued ? esc(issued) : '<span class="mut">—</span>') + '</td>' +
              '<td class="mut">' + esc(s(l.instructions)) + '</td></tr>'
          }).join('')
          return '<tr class="clickable" data-rx-row="' + id + '">' +
            '<td><span class="mut" data-rx-caret>▸</span> <span class="mut">Script ' + esc(String(script.id).slice(0, 8)) + '</span></td>' +
            '<td>' + summary + '</td>' +
            '<td>' + statusBadge(script.status) + '</td>' +
            '<td class="mut">' + esc(when(raw.created_at)) +
            (raw.created_by_name || raw.created_by ? '<div class="mut">' + esc(s(raw.created_by_name || raw.created_by)) + '</div>' : '') + '</td>' +
            '<td style="white-space:nowrap">' +
              '<button class="btn ghost sm" data-rx-print="' + id + '">🖨 Print</button>' +
              (canRx && open ? '<button class="btn ghost sm" data-rx-adjust="' + id + '">Adjust</button>' : '') +
            '</td></tr>' +
            '<tr data-rx-detail="' + id + '" style="display:none"><td colspan="5" style="background:#f8fafc">' +
            (lines
              ? '<div class="tblwrap"><table class="tbl" style="margin:6px 0">' +
                '<tr><th>Medicine</th><th>Dosage</th><th>Prescribed</th><th>Issued</th><th>Instructions</th></tr>' +
                lines + '</table></div>'
              : '<p class="sub" style="margin:8px 0">No medicines on this prescription.</p>') +
            '</td></tr>'
        }).join('')
        return '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Prescription</th><th>Medicines</th><th>Status</th><th>Ordered</th><th></th></tr>' +
          (scriptRows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No prescriptions yet.</td></tr>') +
          '</table></div>' +
          (canRx ? '<br/><button class="btn" id="rxBtn">+ New prescription</button>' : '')
      }
      case 'Labs':
        return table(['Order', 'Test', 'Stage', 'Ordered'], rows, (l) =>
          '<tr><td><strong>' + esc(s(l.id)) + '</strong></td><td>' + esc(s(l.test || l.test_panel || l.panel)) + '</td>' +
          '<td>' + statusBadge(s(l.stage || l.status, 'Ordered')) + '</td><td class="mut">' + esc(when(l.created_at)) + '</td></tr>')
      case 'Admissions':
        return table(['Ward · Bed', 'Since', 'Doctor', 'From encounter', 'Status'], rows, (raw) => {
          const a = normalizeAdmission(raw)
          return '<tr><td><strong>' + esc(s(a.wardName) + ' · ' + s(a.bedNumber)) + '</strong></td>' +
            '<td>' + esc(when(a.admissionDate || a.createdAt)) + '</td>' +
            '<td>' + esc(s(a.attendingProvider)) + '</td>' +
            '<td>' + (a.encounterId
              ? '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(a.encounterId) + '">View</a>'
              : '<span class="mut">—</span>') + '</td>' +
            '<td>' + statusBadge(a.status === 'discharged' ? 'Discharged' : 'Admitted') +
            (a.status === 'active' && canAdmit ? ' <button class="btn ghost sm" data-discharge-adm="' + esc(a.id) + '">Discharge</button>' : '') +
            '</td></tr>'
        }) +
          (canAdmit ? '<br/><button class="btn" id="admBtn">+ Admit patient</button>' : '')
      case 'Documents':
        return table(['File', 'Type', 'Added'], rows, (d) =>
          '<tr><td><strong>' + esc(s(d.name || d.filename || d.title)) + '</strong></td>' +
          '<td>' + esc(s(d.type || d.kind)) + '</td><td class="mut">' + esc(when(d.created_at)) + '</td></tr>')
      default:
        return ''
    }
  }

  const loadCache = {}

  async function render(t) {
    const seq = ++renderSeq
    pane.innerHTML = skeletonCard(4)
    if (t === 'Dashboard') {
      loadCache.Dashboard = await loadDashboardData()
    } else if (t !== 'Overview') {
      const coll = tabCollection(t)
      if (coll) loadCache[t] = await loadTab(t)
    }
    if (seq !== renderSeq) return
    pane.innerHTML = paneHtml(t)
    wirePane()
  }

  function openVitals() {
    formModal({
      title: 'Record vitals',
      submitLabel: 'Save vitals',
      fields: [
        { name: 'bp_systolic', label: 'BP systolic', type: 'number', placeholder: '120' },
        { name: 'bp_diastolic', label: 'BP diastolic', type: 'number', placeholder: '80' },
        { name: 'pulse', label: 'Pulse (bpm)', type: 'number', placeholder: '78' },
        { name: 'temp_c', label: 'Temp °C', type: 'number', placeholder: '36.8' },
        { name: 'spo2', label: 'SpO₂ %', type: 'number', placeholder: '98' },
        { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        await createPatientDoc('vitals', pid, {
          bp_systolic: num(v.bp_systolic), bp_diastolic: num(v.bp_diastolic),
          pulse: num(v.pulse), temp_c: num(v.temp_c), spo2: num(v.spo2),
          note: v.note || '',
        }, 'vitals.create')
        closeModal()
        toast('Vitals saved to Firestore')
        loadCache.Vitals = null
        await render('Vitals')
      },
    })
  }

  function openDiagnosis() {
    formModal({
      title: 'Add diagnosis',
      submitLabel: 'Save diagnosis',
      fields: [
        { name: 'condition', label: 'Condition', required: true, full: true, placeholder: 'e.g. Essential hypertension' },
        { name: 'icd_code', label: 'ICD-11 code', placeholder: 'e.g. I10' },
        { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Resolved', 'Chronic'] },
      ],
      onSubmit: async (v) => {
        await createPatientDoc('diagnoses', pid, {
          condition: v.condition, icd_code: v.icd_code || '', status: v.status || 'Active',
        }, 'diagnosis.create')
        closeModal()
        toast('Diagnosis saved to Firestore')
        loadCache.Diagnoses = null
        await render('Diagnoses')
      },
    })
  }

  // Same in-stock-only catalogue picker as the consultation workspace, so a
  // prescription written from the chart is dispensable by the pharmacy in the
  // same way. Catalogue loads on first open rather than with the page.
  let drugsCache = null
  async function loadCatalogue() {
    drugsCache = drugsCache || await listOrgDrugs(authStore.getState().activeOrg)
    return drugsCache
  }

  // Stored lines → the shape the prescription form prefills from. `quantity`
  // becomes `qty` so the field reads back as it was typed, and line_id rides
  // along so an edit lands on the same line instead of appending a duplicate.
  function toModalLines(script) {
    return script.items.map((l) => ({
      line_id: l.line_id,
      drug_id: l.drug_id || '',
      sku: l.sku || '',
      unit: l.unit || '',
      medicine: l.medicine || '',
      dosage: l.dosage || '',
      qty: l.quantity === '' || l.quantity == null ? '' : String(l.quantity),
      instructions: l.instructions || '',
      external: !!l.external,
      dispensed_qty: l.dispensed_qty,
    }))
  }

  // The chart-side print: the same document the pharmacy hands the patient.
  function printScript(raw) {
    const script = R.normalizeRequest(raw)
    printDocument('Prescription', prescriptionHtml({
      hospitalName: authStore.getState().activeOrgName,
      patientName: p.name,
      mrn: p.mrn,
      encounterId: script.encounterId,
      scriptId: script.id,
      status: script.status,
      items: script.items,
      prescribedBy: script.prescribedBy,
      prescribedAt: raw.created_at,
    }))
  }

  // Re-open a script that is still open as an editable form. Lines the pharmacy
  // has already issued come back locked, and a quantity can never be dragged
  // below what has already gone out (the service enforces both).
  async function adjustScript(raw) {
    if (!canRx) { toast('Your role cannot prescribe. Ask an administrator.'); return }
    const script = R.normalizeRequest(raw)
    let catalogue
    try {
      catalogue = await loadCatalogue()
    } catch (e) {
      toast('Could not load the pharmacy catalogue: ' + friendlyPatientError(e))
      return
    }
    openPrescriptionModal({
      drugs: catalogue,
      title: 'Adjust prescription',
      submitLabel: 'Save changes',
      hint: 'Edit this script. Medicines the pharmacy has already issued are locked and stay on the prescription.',
      initialLines: toModalLines(script),
      onSubmit: async (lines) => {
        try {
          await updateRequestItems(script.id, lines)
        } catch (e) {
          throw new Error(friendlyPatientError(e))
        }
        closeModal()
        toast('Prescription updated — ' + lines.length + ' medicine' + (lines.length === 1 ? '' : 's'))
        loadCache.Medications = null
        await render('Medications')
      },
    })
  }

  // The whole script is written in one submit, so a four-drug prescription
  // reaches the pharmacy as one order with four lines — and joins the script
  // already open for this patient rather than spawning a rival row per drug.
  async function openPrescription() {
    if (!canRx) { toast('Your role cannot prescribe. Ask an administrator.'); return }
    let catalogue
    try {
      catalogue = await loadCatalogue()
    } catch (e) {
      toast('Could not load the pharmacy catalogue: ' + friendlyPatientError(e))
      return
    }
    openPrescriptionModal({
      drugs: catalogue,
      title: 'New prescription',
      submitLabel: 'Send to pharmacy',
      onSubmit: async (lines) => {
        const rxArgs = { patientId: pid, patientName: p.name || '', lines }
        let created = false
        let queued = false
        try {
          ({ created } = await requestMedicationLines(rxArgs))
        } catch (e) {
          // The handoff must not vanish (e.g. offline: the "find open script"
          // read fails). Queue it durably instead of losing it.
          try {
            await enqueue('rx_mirror', rxArgs)
            queued = true
          } catch {
            throw new Error(friendlyPatientError(e))
          }
        }
        closeModal()
        const n = lines.length
        const plural = n === 1 ? '' : 's'
        const allExternal = lines.every((l) => l.external)
        toast(queued
          ? 'Prescription saved — will reach the pharmacy when the connection allows'
          : allExternal
            ? 'External prescription saved to the patient record — ' + n + ' medicine' + plural
            : (created
              ? 'Prescription sent to pharmacy queue — ' + n + ' medicine' + plural
              : n + ' medicine' + plural + ' added to the open prescription'))
        loadCache.Medications = null
        await render('Medications')
      },
    })
  }

  // Admitting from the patient chart used to write straight into the
  // `admissions` collection with its own vocabulary (ward/bed/doctor, status
  // 'Admitted'). That made the bed invisible to the Admissions page — it matched
  // neither 'active' nor 'discharged', so it held no bed on the board and could
  // be double-booked. It now goes through the canonical service, which writes
  // the ward_name/bed_number/attending_provider schema every reader expects and
  // enforces the bed-capacity and one-bed-per-patient checks.
  async function openAdmission() {
    const [wards, openEnc, staff] = await Promise.all([
      listOrgWards(authStore.getState().activeOrg).catch(() => []),
      findOpenEncounterForPatient(pid, authStore.getState().activeOrg).catch(() => null),
      getClinicalStaff(authStore.getState().activeOrg).catch(() => []),
    ])
    // The open encounter is what usually prompted the admission, so link it by
    // default (one-way, per FHIR `Encounter.partOf`).
    const linkedId = openEnc ? openEnc.id : ''
    // Same doctor source as the Admissions page: the org's active memberships,
    // with a free-text fallback so incomplete staff records cannot block a bed.
    const providerField = staff.length
      ? { name: 'attending_provider', label: 'Admitting doctor', type: 'select', options: staff }
      : { name: 'attending_provider', label: 'Admitting doctor', placeholder: 'e.g. Dr. N. Eze' }
    formModal({
      title: 'Admit patient',
      submitLabel: 'Confirm admission',
      fields: [
        wards.length
          ? { name: 'ward_name', label: 'Ward', type: 'select', options: wards.map((w) => w.name), required: true }
          : { name: 'ward_name', label: 'Ward', required: true, placeholder: 'e.g. Ward A' },
        { name: 'bed_number', label: 'Bed', required: true, placeholder: 'e.g. Bed 4' },
        { name: 'admission_type', label: 'Admission type', type: 'select', options: ADMISSION_TYPES },
        providerField,
        { name: 'admission_reason', label: 'Reason', full: true, placeholder: 'e.g. Observation' },
      ],
      onSubmit: async (v) => {
        const { activeOrg } = authStore.getState()
        const existing = await listPatientDocs('admissions', pid)
        const invalid = validateAdmissionInput(
          { ...v, encounter_id: linkedId },
          { wards, admissions: existing.rows.map(normalizeAdmission), encounter: openEnc },
        )
        if (invalid) throw new Error(invalid)
        await createAdmission({
          patient_id: pid,
          patient_name: p.name || '',
          ward_name: v.ward_name,
          bed_number: v.bed_number,
          admission_type: v.admission_type,
          admission_reason: v.admission_reason,
          attending_provider: v.attending_provider,
          encounter_id: linkedId,
        })
        closeModal()
        toast('Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)
        // Both caches are dropped: the Admissions tab shows the new bed and the
        // Dashboard timeline picks it up on the next visit.
        loadCache.Admissions = null
        loadCache.Dashboard = null
        await render('Admissions')
      },
    })
    // Tell the user the bed will be linked to their open encounter.
    const body = document.getElementById('modalBody')
    if (body && openEnc) {
      const note = document.createElement('p')
      note.className = 'sub'
      note.style.margin = '0 0 10px'
      note.textContent = 'Linked to open encounter ' + String(openEnc.id).slice(0, 8) + '… (' + (openEnc.status || 'open') + '). The encounter stays open for documentation.'
      body.prepend(note)
    }
  }

  function openDischarge(admissionId) {
    formModal({
      title: 'Discharge patient',
      submitLabel: 'Discharge',
      fields: [
        { name: 'reason', label: 'Discharge reason', required: true, full: true, placeholder: 'e.g. Recovered' },
        { name: 'notes', label: 'Discharge notes', full: true, placeholder: 'Follow-up instructions…' },
      ],
      onSubmit: async (v) => {
        await dischargeAdmission(admissionId, v)
        closeModal()
        toast('Patient discharged')
        loadCache.Admissions = null
        loadCache.Dashboard = null
        await render('Admissions')
      },
    })
  }

  function openEncounterBlockedModal(existing) {
    const ref = existing?.id ? String(existing.id).slice(0, 8) + '…' : ''
    const status = s(existing?.status || 'Open')
    const type = s(existing?.encounter_type || existing?.type || existing?.reason || 'Encounter')
    openModal('Open encounter already exists',
      '<p class="sub"><strong>' + esc(p.name || 'This patient') + '</strong> already has an open encounter' +
      (ref ? ' (' + esc(ref) : '') + (status ? ' · ' + esc(status) : '') + (ref ? ')' : '') +
      (type ? ' — ' + esc(type) : '') + '. Close it before opening a new one.</p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn ghost" id="goEncTab">View encounters</button>' +
      '<a class="btn" href="#/consultations' + (existing?.id ? '?enc=' + encodeURIComponent(existing.id) : '') + '" data-close>Go to Consultations →</a></div>')
    document.querySelectorAll('#modalBody [data-close]').forEach((b) => { b.onclick = closeModal })
    const goTab = document.getElementById('goEncTab')
    if (goTab) {
      goTab.onclick = async () => {
        closeModal()
        document.querySelectorAll('#ptabs button').forEach((x) => x.classList.toggle('on', x.getAttribute('data-t') === 'Encounters'))
        await render('Encounters')
      }
    }
  }

  async function openEncounter() {
    // Duplicate guard (UX): the service also rejects, but checking first
    // spares the user filling the form only to be told to close the old one.
    const { activeOrg } = authStore.getState()
    if (!activeOrg) { toast('No hospital selected'); return }
    try {
      const existing = await findOpenEncounterForPatient(pid, activeOrg)
      if (existing) {
        openEncounterBlockedModal(existing)
        return
      }
    } catch (e) {
      console.warn('[patient] open-encounter pre-check failed:', e?.message)
    }
    // Fetch clinical staff for dropdown
    getClinicalStaff(activeOrg).then((staff) => {
      const clinicianOptions = staff.length > 0 ? staff : [{ value: '', label: 'No clinical staff found — add staff in Administration' }]
      formModal({
        title: 'Start encounter',
        submitLabel: 'Open encounter',
        fields: [
          { name: 'encounter_type', label: 'Type', type: 'select', options: ['General Outpatient Department (GOPD) review', 'Follow-up', 'Antenatal', 'Emergency', 'Consultation'] },
          { name: 'clinician', label: 'Clinician', type: 'select', options: clinicianOptions, required: true },
          { name: 'reason', label: 'Reason', full: true, required: true, placeholder: 'e.g. Hypertension review' },
        ],
        onSubmit: async (v) => {
          await createPatientDoc('encounters', pid, {
            encounter_type: v.encounter_type, clinician_name: v.clinician || '',
            reason: v.reason,
            // Canonical status, matching what the Consultations queue walks.
            // `Open` was rejected by updateEncounterStatus's whitelist, so an
            // encounter opened here could never be advanced or closed.
            status: 'arrived',
          }, 'encounter.create')
          closeModal()
          toast('Encounter opened and saved to Firestore')
          loadCache.Encounters = null
          loadCache.Timeline = null
          await render('Encounters')
        },
      })
    }).catch((e) => {
      toast('Failed to load clinical staff: ' + friendlyPatientError(e))
    })
  }

  function openConsent() {
    formModal({
      title: 'Record consent',
      submitLabel: 'Save consent',
      fields: [
        { name: 'scope', label: 'Scope', type: 'select', options: ['Full record', 'Prescriptions only', 'Labs only', 'Organization-specific'] },
        { name: 'expiry', label: 'Expiry', type: 'select', options: ['1 year', 'Visit only', 'Until revoked'] },
        { name: 'note', label: 'Note', full: true, placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        await createPatientDoc('patient_consents', pid, {
          scope: v.scope, expiry: v.expiry, note: v.note || '',
        }, null)
        closeModal()
        toast('Consent recorded in Firestore')
      },
    })
  }

  function wirePane() {
    // Wire every edit button, not just the first: several tabs each render their
    // own, and the Blood & Allergies tab renders two in the same pane. An id
    // lookup returned only the first match, leaving "Edit allergies" dead.
    document.querySelectorAll('[data-edit-pane]').forEach((e1) => { e1.onclick = () => { openEdit() } })
    const c = document.getElementById('consentBtn'); if (c) c.onclick = openConsent
    const v = document.getElementById('vitalsBtn'); if (v) v.onclick = openVitals
    const d = document.getElementById('dxBtn'); if (d) d.onclick = openDiagnosis
    const r = document.getElementById('rxBtn'); if (r) r.onclick = openPrescription
    // Prescription rows: click to expand the script's lines, print it for the
    // patient, or adjust it while it is still open. The detail row always sits
    // directly under its own row, so finding it needs no id lookup.
    pane.querySelectorAll('[data-rx-row]').forEach((row) => {
      row.onclick = (ev) => {
        if (ev.target.closest('button')) return
        const detail = row.nextElementSibling
        if (!detail || !detail.hasAttribute('data-rx-detail')) return
        const show = detail.style.display === 'none'
        detail.style.display = show ? '' : 'none'
        const caret = row.querySelector('[data-rx-caret]')
        if (caret) caret.textContent = show ? '▾' : '▸'
      }
    })
    const scriptFor = (id) => (loadCache.Medications?.rows || []).find((x) => x.id === id)
    pane.querySelectorAll('[data-rx-print]').forEach((b) => {
      b.onclick = () => { const raw = scriptFor(b.getAttribute('data-rx-print')); if (raw) printScript(raw) }
    })
    pane.querySelectorAll('[data-rx-adjust]').forEach((b) => {
      b.onclick = () => { const raw = scriptFor(b.getAttribute('data-rx-adjust')); if (raw) adjustScript(raw) }
    })
    const a = document.getElementById('admBtn'); if (a) a.onclick = openAdmission
    // Discharge buttons rendered inside the Admissions tab rows.
    pane.querySelectorAll('[data-discharge-adm]').forEach((b) => {
      b.onclick = () => openDischarge(b.getAttribute('data-discharge-adm'))
    })

    // Dashboard-specific handlers
    const feedFilter = document.getElementById('feedFilter')
    if (feedFilter) {
      feedFilter.onchange = () => {
        dashboardFilter = feedFilter.value
        // Re-render just the feed list
        const d = loadCache.Dashboard || { timeline: [] }
        let filtered = d.timeline
        if (dashboardFilter === 'vitals') filtered = d.timeline.filter(e => e.type === 'vitals')
        else if (dashboardFilter !== 'all') filtered = d.timeline.filter(e => e.type === dashboardFilter)
        const listEl = document.getElementById('feedList')
        if (listEl) {
          listEl.innerHTML = filtered.length
            ? filtered.slice(0, 30).map(e => `
              <div class="feed-item" data-type="${esc(e.type)}">
                <div class="feed-icon">${e.icon}</div>
                <div class="feed-content">
                  <div class="feed-primary">${esc(e.primary)}</div>
                  <div class="feed-secondary">${esc(e.secondary)}</div>
                </div>
                <div class="feed-meta">
                  <span>${esc(when(e.timestamp))}</span>
                  ${e.clinician ? '<span>' + esc(e.clinician) + '</span>' : ''}
                  ${e.status ? '<span class="pill">' + esc(encLabel(e.status)) + '</span>' : ''}
                </div>
              </div>
            `).join('')
            : '<div class="feed-empty"><p class="sub" style="text-align:center;padding:24px">No ' + (dashboardFilter === 'vitals' ? 'vitals' : dashboardFilter) + ' recorded yet.</p></div>'
        }
      }
    }

    const loadMore = document.getElementById('feedLoadMore')
    if (loadMore) {
      loadMore.onclick = () => {
        const d = loadCache.Dashboard || { timeline: [] }
        let filtered = d.timeline
        if (dashboardFilter === 'vitals') filtered = d.timeline.filter(e => e.type === 'vitals')
        else if (dashboardFilter !== 'all') filtered = d.timeline.filter(e => e.type === dashboardFilter)
        const listEl = document.getElementById('feedList')
        if (listEl) {
          listEl.innerHTML = filtered.slice(0, filtered.length).map(e => `
            <div class="feed-item" data-type="${esc(e.type)}">
              <div class="feed-icon">${e.icon}</div>
              <div class="feed-content">
                <div class="feed-primary">${esc(e.primary)}</div>
                <div class="feed-secondary">${esc(e.secondary)}</div>
              </div>
              <div class="feed-meta">
                <span>${esc(when(e.timestamp))}</span>
                ${e.clinician ? '<span>' + esc(e.clinician) + '</span>' : ''}
                ${e.status ? '<span class="pill">' + esc(encLabel(e.status)) + '</span>' : ''}
              </div>
            </div>
          `).join('')
          loadMore.style.display = 'none'
        }
      }
    }

    // Dashboard quick actions
    const dashEnc = document.getElementById('dashEncBtn'); if (dashEnc) dashEnc.onclick = openEncounter
    const dashVitals = document.getElementById('dashVitalsBtn'); if (dashVitals) dashVitals.onclick = openVitals
    const dashDx = document.getElementById('dashDxBtn'); if (dashDx) dashDx.onclick = openDiagnosis
    const dashRx = document.getElementById('dashRxBtn'); if (dashRx) dashRx.onclick = openPrescription
    const dashAdm = document.getElementById('dashAdmBtn'); if (dashAdm) dashAdm.onclick = openAdmission

    wireToast(pane)
  }

  document.querySelectorAll('#ptabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#ptabs button').forEach((x) => x.classList.remove('on'))
      b.classList.add('on')
      render(b.getAttribute('data-t'))
    }
  })

  const encBtn = document.getElementById('encBtn')
  if (encBtn) encBtn.onclick = openEncounter

  await render('Dashboard')
}

function num(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}
