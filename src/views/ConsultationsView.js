// Consultations / encounters queue + encounter workspace (offline-first, cached).
import { shell, formModal, toast, closeModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgEncounters, createEncounter, updateEncounterStatus, addDiagnosis, addPrescription, addLabOrder, myEncounterCaps,
  findOpenEncounterForPatient, recordEncounterVitals, updateEncounterNote, addTreatmentPlan, ENCOUNTER_TYPES, ENCOUNTER_STATUS_FLOW_META,
} from '../services/consultationService.js'
import { listOrgPatients, formatPhone } from '../services/patientService.js'
import { createLabOrder as createLabOrderDoc, myLabCaps } from '../services/laboratoryService.js'
import { myBillingCaps } from '../services/billingService.js'
import { myActiveMembership, getClinicalStaff } from '../services/authService.js'
import { can } from '../features/admin/roles.js'
import { navigate } from '../router.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

const MEDS = ['Amlodipine 5mg', 'Lisinopril 10mg', 'Artemether/Lumefantrine', 'Amoxicillin 500mg', 'Metformin 500mg']
const LAB_PANELS = ['FBC + ESR', 'Malaria RDT + Widal', 'Urinalysis + Culture', 'Lipid profile + HbA1c']

// Encounter statuses are stored lowercase, so the shared statusBadge() (whose
// keys are capitalised) rendered them as bare uncoloured pills. The label +
// tone mapping comes from features/encounters/domain.js, so this view can
// never drift out of sync with the workflow the service actually walks.
const STATUS_FLOW = ENCOUNTER_STATUS_FLOW_META

function encLabel(status) {
  const m = STATUS_FLOW.find((s) => s.key === status)
  return m ? m.label : (status || 'Unknown')
}

function encBadge(status) {
  const m = STATUS_FLOW.find((s) => s.key === status)
  if (!m) return '<span class="pill">' + esc(status || 'Unknown') + '</span>'
  return '<span class="pill ' + m.tone + '">' + esc(m.label) + '</span>'
}

function waitedFor(ts, endTs) {
  if (!ts) return '—'
  const end = endTs || Date.now()
  const secs = Math.max(0, Math.floor((end - ts) / 1000))
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (d) return d + 'd:' + h + 'h:' + m + 'm:' + s + 's'
  if (h) return h + 'h:' + m + 'm:' + s + 's'
  if (m) return m + 'm:' + s + 's'
  return s + 's'
}

export async function ConsultationsView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myEncounterCaps()
  const billingCaps = myBillingCaps()
  // Returned to from Billing ("← Back to encounter") or deep-linked.
  const wantEnc = String(params.enc || '')

  if (!activeOrg) {
    shell(app, {
      active: '/consultations',
      title: 'Consultations',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let encounters = []
  let patients = []
  let pIndex = new Map()
  let selectedEncounter = null

  shell(app, {
    active: '/consultations',
    title: 'Consultations',
    subtitle: 'Arrival → Encounter → Vitals → Consultation → Diagnosis → Plan → Close',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canCreate ? '<button class="btn" id="startBtn">+ Start encounter</button>' : ''),
    body:
      '<div class="grid2x"><div class="card"><div class="card-head"><h3>Encounter queue</h3><span class="pill info" id="enc-count">0 open</span></div>' +
      '<div class="toolbar" style="margin:0 0 8px"><input class="input" id="qSearch" placeholder="Search patient or MRN…" style="max-width:220px">' +
      '<select class="input" id="qStatus" style="max-width:170px"><option value="open" selected>Open encounters</option><option value="closed">Closed</option><option value="all">All</option>' +
      STATUS_FLOW.map((s) => '<option value="' + s.key + '">' + esc(s.label) + '</option>').join('') + '</select></div>' +
      '<div class="tblwrap"><table class="tbl" id="enc-tbl"><tr><th>Patient</th><th>MRN · contact</th><th>Waited</th><th>Status</th></tr>' +
      '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table></div></div>' +
      '<div class="card"><div class="card-head"><h3 id="encTitle">No encounter selected</h3><span id="encStatus">—</span></div>' +
      '<p class="sub">Select a patient from the queue to open the encounter workspace.</p>' +
      '<div class="flow" id="enc-flow">' + STATUS_FLOW.map((s) => '<span class="fstep">' + esc(s.step) + '</span><span class="farrow">→</span>').join('').replace(/<span class="farrow">→<\/span>$/, '') + '</div>' +
      '<div id="encWho"></div>' +
      '<div class="kv"><div><em>BP</em><strong id="v-bp">—</strong></div><div><em>Pulse</em><strong id="v-pulse">—</strong></div><div><em>Temp</em><strong id="v-temp">—</strong></div><div><em>SpO₂</em><strong id="v-spo2">—</strong></div></div><br/>' +
      '<label class="fld full"><span>Clinical note (SOAP)</span><textarea class="input" id="enc-note" rows="4" placeholder="S: … O: … A: … P: …"></textarea></label><div class="toolbar" style="margin-top:6px"><button class="btn sm" id="saveNoteB">Save note</button><span class="mut" id="noteState"></span></div><br/>' +
      '<div id="planBox" hidden><div class="fld full"><span>Treatment plan</span><div class="input" id="planView" style="white-space:pre-wrap"></div></div></div>' +
      '<div class="toolbar"><button class="btn ghost sm" id="vitalsB">+ Vitals</button><button class="btn ghost sm" id="dxB">+ Diagnosis</button><button class="btn ghost sm" id="rxB">+ Prescription</button><button class="btn ghost sm" id="labB">+ Lab order</button><button class="btn ghost sm" id="planB">+ Plan</button><button class="btn ghost sm" id="billB">+ Bill item</button>' +
      (caps.canEdit ? '<button class="btn ghost sm" id="advB">Advance →</button><button class="btn sm" id="closeEncB">Close encounter →</button>' : '') + '</div></div></div>',
  })

  // The queue only stores patient_name, so the readable identity (MRN, age,
  // phone, payer) is joined in from the org patient list. Falls back to the
  // encounter's own snapshot when the patient is not in this hospital's list.
  function patientMeta(e) {
    const p = pIndex.get(e.patientId)
    if (!p) {
      return { pid: e.patientId || '', name: e.patientName || 'Unknown patient', mrn: '—', sex: '', age: '', dob: '', phone: '', payer: '', allergy: '' }
    }
    return {
      pid: p.pid,
      name: p.name || e.patientName || 'Unnamed patient',
      mrn: p.mrn || p.pid,
      sex: p.sex || '',
      age: p.age,
      dob: p.dob || '',
      phone: formatPhone(p.phone, p.phone_key),
      payer: p.payer || '',
      allergy: p.allergy || '',
    }
  }

  async function load() {
    try {
      const [encs, pats] = await Promise.all([
        listOrgEncounters(activeOrg),
        listOrgPatients(activeOrg).catch(() => []),
      ])
      encounters = encs
      patients = pats
      pIndex = new Map(patients.map((p) => [p.pid, p]))
      if (!selectedEncounter && encounters.length) {
        selectedEncounter = (wantEnc && encounters.find((e) => e.id === wantEnc)) || encounters.find((e) => e.status !== 'closed') || encounters[0]
      }
      if (selectedEncounter) {
        const fresh = encounters.find((e) => e.id === selectedEncounter.id)
        if (fresh) selectedEncounter = fresh
      }
      renderQueue()
      renderWorkspace()
    } catch (e) {
      console.error('[consultations] list failed:', e)
      toast('Could not load encounters: ' + friendlyWriteError(e))
    }
  }

  let noteDirty = false
  function visibleEncounters() {
    const q = String(document.getElementById('qSearch')?.value || '').trim().toLowerCase()
    const mode = document.getElementById('qStatus')?.value || 'open'
    return encounters.filter((e) => {
      if (mode === 'open' && e.status === 'closed') return false
      if (mode === 'closed' && e.status !== 'closed') return false
      if (mode !== 'all' && mode !== 'open' && mode !== 'closed' && e.status !== mode) return false
      if (q) {
        const m = patientMeta(e)
        const hay = (m.name + ' ' + m.mrn + ' ' + m.pid).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }

  function renderQueue() {
    const tbl = document.getElementById('enc-tbl')
    const cnt = document.getElementById('enc-count')
    const openN = encounters.filter((e) => e.status !== 'closed').length
    if (cnt) cnt.textContent = openN + ' open · ' + encounters.length + ' total'
    if (!tbl) return
    const head = '<tr><th>Patient</th><th>MRN · contact</th><th>Waited</th><th>Status</th></tr>'
    const shown = visibleEncounters()
    const rows = shown.map((e) => {
      const m = patientMeta(e)
      const who = [m.age !== '' && m.age != null ? m.age + 'y' : '', m.sex].filter(Boolean).join(' · ')
      return '<tr class="clickable' + (selectedEncounter && selectedEncounter.id === e.id ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' +
        '<td><strong>' + esc(m.name) + '</strong><div class="mut">' + esc(m.pid.slice(0, 8)) + '</div></td>' +
        '<td><div>' + esc(m.mrn) + '</div><div class="mut">' + esc(who || 'No demographics on file') + '</div>' +
        (m.phone ? '<div class="mut">' + esc(m.phone) + '</div>' : '') + '</td>' +
        '<td class="mut">' + esc(waitedFor(e.createdAt, e.status === 'closed' ? e.updatedAt : 0)) + '</td>' +
        '<td>' + encBadge(e.status) + '</td></tr>'
    }).join('')
    tbl.innerHTML = head + (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No encounters match this filter</td></tr>')
    tbl.querySelectorAll('tr.clickable').forEach((r) => {
      r.onclick = () => {
        if (noteDirty && !window.confirm('You have an unsaved note. Switch encounters anyway?')) return
        noteDirty = false
        selectedEncounter = encounters.find((e) => e.id === r.getAttribute('data-id')) || null
        renderQueue()
        renderWorkspace()
      }
    })
  }

  function renderWorkspace() {
    const titleEl = document.getElementById('encTitle')
    const statusEl = document.getElementById('encStatus')
    const noteEl = document.getElementById('enc-note')
    const whoEl = document.getElementById('encWho')
    if (!selectedEncounter) {
      if (titleEl) titleEl.textContent = 'No encounter selected'
      if (statusEl) statusEl.textContent = '—'
      if (whoEl) whoEl.innerHTML = ''
      paintFlow(-1)
      return
    }
    const e = selectedEncounter
    const m = patientMeta(e)
    if (titleEl) titleEl.textContent = m.name
    if (statusEl) statusEl.innerHTML = encBadge(e.status)
    if (whoEl) {
      const demo = [m.age !== '' && m.age != null ? m.age + 'y' : '', m.sex].filter(Boolean).join(' · ') || '—'
      whoEl.innerHTML =
        '<div class="kv">' +
        '<div><em>MRN</em><strong style="font-size:.9rem">' + esc(m.mrn) + '</strong></div>' +
        '<div><em>Age / sex</em><strong style="font-size:.9rem">' + esc(demo) + '</strong></div>' +
        '<div><em>Payer</em><strong style="font-size:.9rem">' + esc(m.payer || '—') + '</strong></div>' +
        '<div><em>Phone</em><strong style="font-size:.9rem">' + esc(m.phone || '—') + '</strong></div>' +
        '</div>' +
        (m.allergy && m.allergy !== 'None known'
          ? '<div class="allergy" style="margin-top:10px">⚠ Allergy: <strong>' + esc(m.allergy) + '</strong> — confirm before prescribing</div>'
          : '') +
        '<div class="toolbar" style="margin:10px 0 12px">' +
        (m.pid ? '<a class="btn ghost sm" href="#/patients/' + encodeURIComponent(m.pid) + '">Open patient record →</a>' : '') +
        '<span class="mut">Encounter ' + esc(e.id.slice(0, 8)) + ' · ' + esc(encLabel(e.status)) + (e.type ? ' · ' + esc(e.type) : '') + (e.clinician ? ' · ' + esc(e.clinician) : '') + '</span>' +
        '</div>'
    }
    paintFlow(STATUS_FLOW.findIndex((s) => s.key === e.status))
    // Label Advance with where it actually goes, so the fallback is never a
    // blind step into an unknown stage.
    const advBtn = document.getElementById('advB')
    if (advBtn) {
      const ni = STATUS_FLOW.findIndex((s) => s.key === e.status) + 1
      const nextStep = STATUS_FLOW[ni]
      advBtn.textContent = nextStep && e.status !== 'closed' ? 'Advance → ' + nextStep.label : 'Advance →'
    }
    const vitals = e.vitals || {}
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '—' }
    set('v-bp', vitals.BP); set('v-pulse', vitals.Pulse); set('v-temp', vitals.Temp); set('v-spo2', vitals.SpO2)
    if (noteEl && document.activeElement !== noteEl) noteEl.value = e.chiefComplaint || e.diagnosis || ''
    // The saved plan is data, not an editor — show it read-only when present so
    // "Plan set" is backed by something the prescriber can actually read back.
    const planBox = document.getElementById('planBox')
    const planView = document.getElementById('planView')
    if (planBox && planView) {
      if (e.treatmentPlan) {
        planView.textContent = e.treatmentPlan
        planBox.hidden = false
      } else {
        planView.textContent = ''
        planBox.hidden = true
      }
    }
  }

  // Highlight the workflow step the encounter has actually reached.
  function paintFlow(idx) {
    document.querySelectorAll('#enc-flow .fstep').forEach((el, i) => {
      el.classList.toggle('done', idx > i)
      el.classList.toggle('now', idx === i)
    })
  }

  function openStartForm() {
    if (!patients.length) { toast('No patients registered yet — register a patient first.'); return }
    const patientOpts = patients.map((p) => ({ value: p.pid, label: p.name + ' · ' + (p.mrn || p.pid) }))
    // Fetch clinical staff for dropdown
    getClinicalStaff(activeOrg).then((staff) => {
      const clinicianOptions = staff.length > 0 ? staff : [{ value: '', label: 'No clinical staff found — add staff in Administration' }]
      formModal({
        title: 'Start encounter',
        submitLabel: 'Open encounter →',
        fields: [
          { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true, full: true },
          { name: 'type', label: 'Type', type: 'select', options: ENCOUNTER_TYPES },
          { name: 'clinician', label: 'Clinician', type: 'select', options: clinicianOptions, required: true },
        ],
        onSubmit: async (v) => {
          try {
            const sel = patients.find((p) => p.pid === v.patient_id)
            const created = await createEncounter({
              patient_id: v.patient_id,
              patient_name: sel ? sel.name : v.patient_id,
              status: 'arrived',
              type: v.type || '',
              clinician: v.clinician || '',
              chief_complaint: '',
            })
            closeModal()
            toast('Encounter started')
            selectedEncounter = { id: created.id, patientId: v.patient_id, patientName: sel ? sel.name : v.patient_id, status: 'arrived', vitals: {}, chiefComplaint: '', createdAt: Date.now() }
            await load()
          } catch (e) {
            throw new Error(friendlyWriteError(e))
          }
        },
      })
      // Live duplicate hint: as soon as a patient with an open encounter is
      // picked, warn inline so the user knows to close it first instead of
      // filling the rest of the form and hitting the service rejection.
      const pidSel = document.querySelector('#fmFields [name="patient_id"]')
      const errLine = () => document.getElementById('fmError')
      if (pidSel) {
        const checkPid = async () => {
          const el = errLine()
          const pid = String(pidSel.value || '')
          if (!pid) { if (el && el.dataset.dup === '1') { el.textContent = ''; delete el.dataset.dup } return }
          try {
            const existing = await findOpenEncounterForPatient(pid, activeOrg)
            if (existing && errLine()) {
              errLine().textContent =
                'This patient already has an open encounter (' + String(existing.id).slice(0, 8) + '… · ' + (existing.status || 'open') +
                '). Close it before opening a new one.'
              errLine().dataset.dup = '1'
            } else if (el && el.dataset.dup === '1') {
              el.textContent = ''
              delete el.dataset.dup
            }
          } catch { /* read failed (offline) — leave the service guard to decide */ }
        }
        pidSel.addEventListener('change', checkPid)
        checkPid()
      }
    }).catch((e) => {
      toast('Failed to load clinical staff: ' + friendlyWriteError(e))
    })
  }

  // Action buttons mirror the rules: the encounter write needs
  // `encounter.edit`; the mirrors need their own caps. Buttons the current
  // role cannot use are hidden instead of failing at write time.
  const me = myActiveMembership()
  const canDx = caps.canEdit && can(me, 'diagnosis.create')
  const canRx = caps.canEdit && can(me, 'prescription.create')
  const labCaps = myLabCaps()
  const canLab = caps.canEdit && labCaps.canOrder
  function hideIfNoCap(id, ok) {
    const el = document.getElementById(id)
    if (el && !ok) el.style.display = 'none'
  }
  hideIfNoCap('dxB', canDx)
  hideIfNoCap('rxB', canRx)
  hideIfNoCap('labB', canLab)
  // The plan has no dedicated capability; it is part of the encounter, so it
  // is gated on `encounter.edit` like the note and status updates.
  hideIfNoCap('planB', caps.canEdit)
  // Billing lives in its own module behind the `billing.invoice` capability, so
  // a doctor without it must not be offered a dead button.
  hideIfNoCap('billB', billingCaps.canInvoice)

  // "Bill item" used to be a bare <a href="#/billing">, which dropped the
  // clinician on an empty billing page and lost the patient. It now hands the
  // patient (and this encounter) to Billing, which opens the New invoice form
  // with both the patient and their saved payer already selected.
  function openBilling() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!billingCaps.canInvoice) { toast('Your role cannot raise invoices — a billing officer must do this.'); return }
    if (!selectedEncounter.patientId) { toast('This encounter is not linked to a patient.'); return }
    const q = new URLSearchParams({
      patient: selectedEncounter.patientId,
      new: '1',
      from: 'enc',
      enc: selectedEncounter.id,
    })
    navigate('/billing?' + q.toString())
  }

  function openDiagnosisForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canDx) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    formModal({
      title: 'Add diagnosis',
      submitLabel: 'Save',
      fields: [
        { name: 'diagnosis', label: 'Condition / ICD-11', required: true, full: true, placeholder: 'e.g. Malaria' },
        { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Resolved', 'Chronic'] },
      ],
      onSubmit: async (v) => {
        try {
          await addDiagnosis(selectedEncounter.id, v.diagnosis + ' (' + (v.status || 'Active') + ')')
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Diagnosis added')
        await load()
      },
    })
  }

  function openVitalsForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
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
        const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null }
        try {
          await recordEncounterVitals(selectedEncounter.id, {
            bp_systolic: num(v.bp_systolic), bp_diastolic: num(v.bp_diastolic),
            pulse: num(v.pulse), temp_c: num(v.temp_c), spo2: num(v.spo2), note: v.note || '',
          })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Vitals saved')
        await load()
      },
    })
  }

  function openMedicineForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canRx) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    formModal({
      title: 'New prescription',
      submitLabel: 'Prescribe',
      fields: [
        { name: 'medicine', label: 'Medicine', required: true, full: true, list: 'medList', listOptions: MEDS, placeholder: 'Search or type a medicine' },
        { name: 'dosage', label: 'Dosage', placeholder: 'e.g. 1 tab daily' },
        { name: 'qty', label: 'Qty', placeholder: '30' },
      ],
      onSubmit: async (v) => {
        if (!v.medicine) throw new Error('Medicine is required.')
        try {
          await addPrescription(selectedEncounter.id, v)
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Prescription added')
        await load()
      },
    })
  }

  function openPlanForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!caps.canEdit) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    // The plan has no capability of its own — it is part of the encounter, so
    // it shares `encounter.edit`. Pre-fill with the saved plan so this is an
    // edit rather than a blind overwrite.
    formModal({
      title: 'Treatment plan',
      submitLabel: 'Save plan',
      fields: [
        {
          name: 'plan', label: 'Plan', type: 'textarea', full: true, required: true,
          value: selectedEncounter.treatmentPlan || '',
          placeholder: 'Investigations, treatment, follow-up, referrals…',
        },
      ],
      onSubmit: async (v) => {
        if (!v.plan) throw new Error('Plan cannot be empty.')
        try {
          await addTreatmentPlan(selectedEncounter.id, v.plan)
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Plan saved')
        await load()
      },
    })
  }

  function openLabOrderForm() {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    if (!canLab) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
    formModal({
      title: 'New lab order',
      submitLabel: 'Place order →',
      fields: [
        { name: 'panel', label: 'Test panel', required: true, full: true, list: 'labList', listOptions: LAB_PANELS, placeholder: 'Search or type a panel' },
        { name: 'priority', label: 'Priority', type: 'select', options: ['Routine', 'Urgent', 'STAT'] },
      ],
      onSubmit: async (v) => {
        if (!v.panel) throw new Error('Test panel is required.')
        // Canonical lab_orders doc (appears in Laboratory queue + patient Labs
        // tab) plus an embedded reference on the encounter. The lab doc is
        // primary; if it fails, nothing is written to the encounter either.
        try {
          const lab = await createLabOrderDoc({
            patient_id: selectedEncounter.patientId,
            patient_name: selectedEncounter.patientName,
            encounter_id: selectedEncounter.id,
            test_panel: v.panel,
            priority: v.priority,
          })
          await addLabOrder(selectedEncounter.id, { lab_order_id: lab.id, test_panel: v.panel, priority: v.priority })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Lab order placed')
        await load()
      },
    })
  }

  document.getElementById('refreshBtn').onclick = load
  const startBtn = document.getElementById('startBtn')
  if (startBtn) startBtn.onclick = openStartForm
  document.getElementById('vitalsB').onclick = openVitalsForm
  document.getElementById('dxB').onclick = openDiagnosisForm
  document.getElementById('rxB').onclick = openMedicineForm
  document.getElementById('labB').onclick = openLabOrderForm
  document.getElementById('planB').onclick = openPlanForm
  document.getElementById('billB').onclick = openBilling
  const advB = document.getElementById('advB')
  if (advB) advB.onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    const idx = STATUS_FLOW.findIndex((s) => s.key === selectedEncounter.status)
    const nextIdx = idx < 0 ? 0 : idx + 1
    // `closed` is terminal; an unknown status (legacy `Open`) is advanced into
    // the flow at its first step rather than dead-ending.
    if (!STATUS_FLOW[nextIdx] || selectedEncounter.status === 'closed') { toast('Encounter is already at the final step'); return }
    const next = STATUS_FLOW[nextIdx].key
    try {
      await updateEncounterStatus(selectedEncounter.id, next)
      toast('Status → ' + STATUS_FLOW[nextIdx].label)
      await load()
    } catch (e) { toast(friendlyWriteError(e, 'Status update failed')) }
  }
  document.getElementById('saveNoteB').onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    const noteEl = document.getElementById('enc-note')
    try {
      await updateEncounterNote(selectedEncounter.id, noteEl ? noteEl.value : '')
      noteDirty = false
      const st = document.getElementById('noteState')
      if (st) st.textContent = 'Saved'
      toast('Note saved')
      await load()
    } catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
  }
  const noteEl0 = document.getElementById('enc-note')
  if (noteEl0) noteEl0.addEventListener('input', () => {
    noteDirty = true
    const st = document.getElementById('noteState')
    if (st) st.textContent = 'Unsaved changes'
  })
  const qSearch = document.getElementById('qSearch')
  if (qSearch) qSearch.addEventListener('input', renderQueue)
  const qStatus = document.getElementById('qStatus')
  if (qStatus) qStatus.addEventListener('change', renderQueue)
  const closeB = document.getElementById('closeEncB')
  if (closeB) closeB.onclick = async () => {
    if (!selectedEncounter) { toast('Select an encounter first'); return }
    try {
      await updateEncounterStatus(selectedEncounter.id, 'closed')
      toast('Encounter closed')
      await load()
    } catch (e) { toast(friendlyWriteError(e, 'Close failed')) }
  }
  wireToast(app)

  await load()

  // Live "Waited" clock: refresh only the Waited cells every second so the
  // countdown advances without a manual refresh. Self-cleans when navigation
  // replaces the queue table.
  const tick = setInterval(() => {
    const tbl = document.getElementById('enc-tbl')
    if (!tbl) { clearInterval(tick); return }
    const shown = visibleEncounters()
    tbl.querySelectorAll('tr.clickable').forEach((r, i) => {
      const e = shown[i]
      if (!e) return
      const td = r.cells[2]
      if (td) td.textContent = waitedFor(e.createdAt, e.status === 'closed' ? e.updatedAt : 0)
    })
  }, 1000)
}
