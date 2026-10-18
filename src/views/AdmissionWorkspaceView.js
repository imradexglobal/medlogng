// Admission Session Workspace — inpatient stay UI.
// Uses the app's established design: shell(), card, card-head, kv, pill, btn,
// tblwrap, tbl, timeline, titem, toolbar, fgrid, fld.
// Readmission isolation: each stay gets a new admission_session_id (doc id).
import { shell, formModal, toast, closeModal, wireToast, openModal } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listSessionPlanItems, createPlanItem, updatePlanItem, updatePlanStatus, removePlanItem,
  buildSessionTimelineFn, nextRoundFn, myAdmissionSessionCaps,
} from '../services/admissionSessionService.js'
import {
  listSessionLabs, updateLabStatus, myLabCaps, normalizeTests, formatTestResult,
} from '../services/laboratoryService.js'
import {
  listSessionImaging, createImagingOrder, updateImagingOrderStatus, myImagingCaps,
  normalizeImagingItems, addImagingResult, verifyImagingOrder,
} from '../services/imagingService.js'
import {
  listSessionMedicationRequests, requestMedicationLines, listOrgDrugs,
} from '../services/pharmacyService.js'
import { openPrescriptionModal } from '../features/pharmacy/prescriptionModal.js'
import {
  listSessionInvoices, createInvoice, myBillingCaps,
} from '../services/billingService.js'
import { getAdmission, dischargeAdmission } from '../services/admissionService.js'
import { ADMISSION_ACTIVE } from '../features/admissions/domain.js'
import { planStatus, isPlanRemoved, PLAN_TYPES } from '../features/admissions/plan.js'
import { MODALITIES } from '../features/admissions/imaging.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'
import { mountResultImages } from '../components/resultImages.js'
import { enqueue } from '../services/clinicalOutbox.js'
import { printDocument } from '../lib/print.js'
import { labRequestHtml, labResultHtml, imagingRequestHtml, imagingResultHtml } from '../lib/labPrintTemplates.js'

export async function AdmissionWorkspaceView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const sid = String(params.id || '').trim()
  if (!sid) {
    shell(app, {
      active: '/admissions',
      title: 'Admissions & beds',
      subtitle: 'Admission session id required.',
      body: '<p class="sub">Admission session id required.</p><a class="btn" href="#/admissions">Back to admissions →</a>'
    })
    return
  }

  const caps = myAdmissionSessionCaps()
  const labCaps = myLabCaps()
  const imagingCaps = myImagingCaps()
  const billingCaps = myBillingCaps()

  // Load admission record
  const admission = await getAdmission(sid)
  if (!admission) {
    shell(app, {
      active: '/admissions',
      title: 'Admissions & beds',
      subtitle: 'Admission not found.',
      body: '<div class="card"><p class="sub">This admission could not be loaded.</p><a class="btn" href="#/admissions">Back to admissions →</a></div>'
    })
    return
  }

  // Load all session-scoped collections
  let [planItems, labs, imaging, meds, invoices] = await Promise.all([
    listSessionPlanItems(sid),
    listSessionLabs(sid),
    listSessionImaging(sid),
    listSessionMedicationRequests(sid),
    listSessionInvoices(sid),
  ])

  // Pharmacy catalogue, loaded lazily the first time the prescription form opens.
  let drugs = null

  // Helper: format Date from millis
  function fmt(ms) { return ms ? new Date(ms).toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' }) : '—' }

  function fmtDateTime(ms) {
    if (!ms) return '—'
    const d = new Date(ms)
    return d.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
  }

  // Firestore Timestamps (raw session docs) or plain millis -> millis.
  function msOf(t) {
    if (!t) return 0
    if (typeof t.toMillis === 'function') return t.toMillis()
    return typeof t === 'number' ? t : 0
  }

  // Status badge HTML (uses app's .pill class)
  function badge(s) {
    const map = { active: 'info', discharged: 'ok', removed: 'bad', order: 'neutral', completed: 'ok',
      planned: 'neutral', 'in-progress': 'info', cancelled: 'bad', verified: 'ok',
      accepted: 'info', 'specimen-collected': 'info', processing: 'info',
      'in-progress-imaging': 'info', unpaid: 'bad', 'part-paid': 'warn', paid: 'ok',
      requested: 'info', dispensed: 'ok', pending: 'warn', open: 'info' }
    const cls = map[s] || 'neutral'
    return '<span class="pill ' + cls + '">' + esc(s) + '</span>'
  }

  function labStatusOptions() {
    return ['order', 'accepted', 'specimen-collected', 'processing', 'completed', 'verified', 'cancelled']
  }
  function imagingStatusOptions() {
    return ['order', 'accepted', 'in-progress', 'completed', 'verified', 'cancelled']
  }

  // Re-load session data after a write, then re-render.
  async function reload() {
    ;[planItems, labs, imaging, meds, invoices] = await Promise.all([
      listSessionPlanItems(sid),
      listSessionLabs(sid),
      listSessionImaging(sid),
      listSessionMedicationRequests(sid),
      listSessionInvoices(sid),
    ])
    render()
  }

  // ---------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------
  function render() {
    const timeline = buildSessionTimelineFn(admission, planItems, labs, imaging, meds, invoices)

    const isActive = admission.status === ADMISSION_ACTIVE
    const canEditPlan = caps.canEditPlan
    const canDischarge = caps.canDischarge
    const canOrderLabs = labCaps.canOrder
    const canOrderImaging = imagingCaps.canOrder
    const canPrescribe = caps.canPrescribe
    const canBill = billingCaps.canInvoice

    // --- Overview card ---
    const overviewHTML =
      '<div class="card">' +
        '<div class="card-head"><h3>Patient overview</h3>' +
          '<span class="pill ' + (isActive ? 'info' : 'ok') + '">' + esc(admission.status || '—') + '</span></div>' +
        '<div class="kv">' +
          '<div><em>Patient</em><strong>' + esc(admission.patientName || '—') + '</strong></div>' +
          '<div><em>Ward · Bed</em><strong>' + esc(admission.wardName || '—') + ' · ' + esc(admission.bedNumber || '—') + '</strong></div>' +
          '<div><em>Admission type</em><strong>' + esc(admission.admissionType || '—') + '</strong></div>' +
          '<div><em>Admitted</em><strong>' + fmt(admission.admissionDate) + '</strong></div>' +
          '<div><em>Attending</em><strong>' + esc(admission.attendingProvider || '—') + '</strong></div>' +
          '<div><em>Reason</em><strong>' + esc(admission.admissionReason || '—') + '</strong></div>' +
          (admission.dischargeDate
            ? '<div><em>Discharged</em><strong>' + fmt(admission.dischargeDate) + '</strong></div>' +
              '<div><em>Discharge reason</em><strong>' + esc(admission.dischargeReason || '—') + '</strong></div>'
            : '') +
        '</div>' +
      '</div>'

    // --- Clinical Plan card ---
    const planByType = {}
    for (const t of PLAN_TYPES) planByType[t] = []
    planByType['removed'] = []
    for (const it of planItems || []) {
      const bucket = isPlanRemoved(it) ? 'removed' : (planStatus(it) === 'planned' ? it.type : planStatus(it))
      if (!planByType[bucket]) planByType[bucket] = []
      planByType[bucket].push(it)
    }

    function planRow(it) {
      const rev = (it.revisions && it.revisions.length > 1)
        ? '<span class="mut" style="margin-left:8px">edited ' + (it.revisions.length - 1) + ' time(s)</span>' : ''
      const status = planStatus(it)
      const editable = canEditPlan && status !== 'removed'
      const statusCell = editable
        ? '<select class="input" data-plan-status="' + esc(it.id) + '" style="min-width:140px;padding:6px 8px;font-size:.78rem">' +
            ['planned', 'in-progress', 'completed', 'cancelled']
              .map((s) => '<option value="' + s + '"' + (status === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
          '</select>'
        : badge(status)
      const actions = editable
        ? '<div style="white-space:nowrap">' +
            '<button class="btn ghost sm" data-edit-plan="' + esc(it.id) + '">Edit</button> ' +
            '<button class="btn ghost sm" data-remove-plan="' + esc(it.id) + '">Remove</button>' +
          '</div>'
        : ''
      return '<tr>' +
        '<td><span class="pill info">' + esc(it.type || '—') + '</span> <span class="mut">Round ' + esc(String(it.round || 1)) + '</span></td>' +
        '<td>' + esc(it.text || '—') + rev + '</td>' +
        '<td style="white-space:nowrap">' + statusCell + '</td>' +
        '<td style="text-align:right">' + actions + '</td></tr>'
    }

    const planRows = (planItems || []).map(planRow).join('')
    const planCard =
      '<div class="card">' +
        '<div class="card-head"><h3>Clinical plan</h3>' +
          (canEditPlan ? '<button class="btn sm" id="addPlanBtn">+ Add plan item</button>' : '') + '</div>' +
        '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Type · Round</th><th>Item</th><th>Status</th><th></th></tr>' +
          (planRows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No plan items yet.</td></tr>') +
        '</table></div>' +
      '</div>'

    // --- Labs card ---
    function labRow(l) {
      const tests = normalizeTests(l)
      const actions = canOrderLabs
        ? '<select class="input" data-lab-status="' + esc(l.id) + '" style="min-width:150px;padding:6px 8px;font-size:.78rem">' +
            labStatusOptions().map((s) => '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
          '</select>'
        : badge(l.status || 'order')
      return '<tr>' +
        '<td><strong>' + esc(l.test_panel || tests.join(', ') || '—') + '</strong>' + (l.facility === 'external' ? ' <span class="pill info">External</span>' : '') + (tests.length > 1 ? '<div class="mut">' + tests.length + ' tests</div>' : '') + '</td>' +
        '<td>' + esc(l.priority || 'Routine') + '</td>' +
        '<td>' + actions + '</td>' +
        '<td class="mut">' + fmtDateTime(l.ordered_at || l.created_at) + '</td>' +
        '<td style="text-align:right"><button class="btn ghost sm" data-lab-detail="' + esc(l.id) + '">Print</button></td></tr>'
    }
    const labsRows = (labs || []).map(labRow).join('')
    const labsCard =
      '<div class="card">' +
        '<div class="card-head"><h3>Laboratory</h3>' +
          (canOrderLabs ? '<button class="btn sm" id="addLabBtn">+ Order lab</button>' : '') + '</div>' +
        '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Tests</th><th>Priority</th><th>Status</th><th>Ordered</th><th></th></tr>' +
          (labsRows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No lab orders.</td></tr>') +
        '</table></div>' +
      '</div>'

    // --- Imaging card ---
    function imagingRow(i) {
      const items = normalizeImagingItems(i)
      const modalityLabel = [...new Set(items.map((it) => it.modality).filter(Boolean))].join(' / ') || i.modality || '—'
      const summary = items.length ? items.map((it) => [it.modality, it.study].filter(Boolean).join(' ')).join(', ') : (i.study || '—')
      const actions = canOrderImaging
        ? '<select class="input" data-imaging-status="' + esc(i.id) + '" style="min-width:150px;padding:6px 8px;font-size:.78rem">' +
            imagingStatusOptions().map((s) => '<option value="' + s + '"' + (i.status === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
          '</select>'
        : badge(i.status || 'order')
      return '<tr>' +
        '<td><strong>' + esc(modalityLabel) + '</strong>' + (i.facility === 'external' ? ' <span class="pill info">External</span>' : '') + '<div class="mut">' + esc(summary) + '</div></td>' +
        '<td>' + esc(i.priority || 'Routine') + '</td>' +
        '<td>' + actions + '</td>' +
        '<td class="mut">' + fmtDateTime(i.ordered_at || i.created_at) + '</td>' +
        '<td style="text-align:right"><button class="btn ghost sm" data-imaging-detail="' + esc(i.id) + '">Print</button></td></tr>'
    }
    const imagingRows = (imaging || []).map(imagingRow).join('')
    const imagingCard =
      '<div class="card">' +
        '<div class="card-head"><h3>Imaging</h3>' +
          (canOrderImaging ? '<button class="btn sm" id="addImagingBtn">+ Order imaging</button>' : '') + '</div>' +
        '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Modality · Study</th><th>Priority</th><th>Status</th><th>Ordered</th><th></th></tr>' +
          (imagingRows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No imaging orders.</td></tr>') +
        '</table></div>' +
      '</div>'

    // --- Medications card ---
    function medRow(m) {
      // medication_requests store items as an array of line objects
      const items = Array.isArray(m.items) ? m.items : []
      const lines = items.map((ln) => {
        const name = ln.medicine || ln.drug_id || '—'
        const dose = ln.dosage ? ' · ' + ln.dosage : ''
        const qty = ln.qty ? ' × ' + ln.qty : ''
        return '<div>' + esc(name) + dose + qty + '</div>'
      }).join('') || '<div class="mut">' + esc(m.line || m.medicine || '—') + '</div>'
      return '<tr>' +
        '<td>' + lines + '</td>' +
        '<td style="white-space:nowrap">' + badge(m.status || 'requested') + '</td>' +
        '<td class="mut">' + fmtDateTime(m.created_at) + '</td></tr>'
    }
    const medsRows = (meds || []).map(medRow).join('')
    const medsCard =
      '<div class="card">' +
        '<div class="card-head"><h3>Medications</h3>' +
          (canPrescribe ? '<button class="btn sm" id="addMedBtn">+ Prescribe</button>' : '') + '</div>' +
        '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Medicine</th><th>Status</th><th>Requested</th></tr>' +
          (medsRows || '<tr><td colspan="3" class="mut" style="text-align:center;padding:22px 8px">No prescriptions.</td></tr>') +
        '</table></div>' +
      '</div>'

    // --- Billing card ---
    function invRow(inv) {
      const total = (inv.total_kobo || 0) / 100
      return '<tr>' +
        '<td><strong>' + esc(inv.items || inv.item || '—') + '</strong></td>' +
        '<td>₦' + total.toLocaleString('en-NG') + '</td>' +
        '<td style="white-space:nowrap">' + badge(inv.status || 'unpaid') + '</td>' +
        '<td class="mut">' + fmt(inv.created_at) + '</td></tr>'
    }
    const invRows = (invoices || []).map(invRow).join('')
    const billingCard =
      '<div class="card">' +
        '<div class="card-head"><h3>Billing</h3>' +
          (canBill ? '<button class="btn sm" id="addInvBtn">+ Add charge</button>' : '') + '</div>' +
        '<div class="tblwrap"><table class="tbl">' +
          '<tr><th>Item</th><th>Amount</th><th>Status</th><th>Date</th></tr>' +
          (invRows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No charges.</td></tr>') +
        '</table></div>' +
      '</div>'

    // --- Discharge card ---
    const dischargeCard = isActive
      ? '<div class="card">' +
          '<div class="card-head"><h3>Discharge</h3></div>' +
          (canDischarge
            ? '<label class="fld full"><span>Discharge reason</span>' +
                '<input type="text" id="dischargeReason" class="input" placeholder="e.g. Recovered"></label>' +
              '<div class="mrow"><button class="btn" id="confirmDischarge">Discharge patient</button></div>' +
              '<p class="sub" style="margin-top:8px">This will release the bed and mark the admission as discharged.</p>'
            : '<p class="sub">You do not have permission to discharge patients.</p>') +
        '</div>'
      : '<div class="card"><div class="card-head"><h3>Discharge</h3><span class="pill ok">discharged</span></div>' +
          '<p class="sub">This admission is already discharged.</p></div>'

    // --- History timeline ---
    function timelineRowHTML(row) {
      const when = row.timestamp ? '<div class="when">' + fmtDateTime(row.timestamp) + '</div>' : ''
      return '<div class="titem"><strong>' + esc(row.title || '—') + '</strong> ' +
        (row.status ? badge(row.status) : '') + when + '</div>'
    }
    const historyCard =
      '<div class="card">' +
        '<div class="card-head"><h3>History</h3></div>' +
        '<div class="timeline">' +
          (timeline.length ? timeline.map(timelineRowHTML).join('') : '<p class="sub">No activity yet.</p>') +
        '</div>' +
      '</div>'

    const actions =
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      '<a class="btn ghost" href="#/admissions">← Back to admissions</a>'

    shell(app, {
      active: '/admissions',
      title: 'Admission workspace',
      subtitle: (admission.patientName || 'Patient') + ' · ' + (admission.wardName || '—') + ' · ' + (admission.bedNumber || '—'),
      actions,
      body:
        overviewHTML +
        planCard +
        labsCard +
        imagingCard +
        medsCard +
        billingCard +
        dischargeCard +
        historyCard,
    })

    wireEvents()
    wireToast(app)
  }

  // ---------------------------------------------------------------
  //  Event wiring
  // ---------------------------------------------------------------
  function wireEvents() {
    document.getElementById('refreshBtn').onclick = reload

    // Add plan item
    const addPlanBtn = document.getElementById('addPlanBtn')
    if (addPlanBtn) addPlanBtn.onclick = openAddPlanForm

    // Edit / remove plan items (delegated)
    document.querySelectorAll('[data-edit-plan]').forEach((b) => {
      b.onclick = () => openEditPlanForm(b.getAttribute('data-edit-plan'))
    })
    document.querySelectorAll('[data-remove-plan]').forEach((b) => {
      b.onclick = () => removePlan(b.getAttribute('data-remove-plan'))
    })

    // Plan status change (delegated)
    document.querySelectorAll('[data-plan-status]').forEach((sel) => {
      sel.onchange = () => updatePlan(sel.getAttribute('data-plan-status'), sel.value)
    })

    // Lab status change (delegated)
    document.querySelectorAll('[data-lab-status]').forEach((sel) => {
      sel.onchange = () => updateLab(sel.getAttribute('data-lab-status'), sel.value)
    })
    const addLabBtn = document.getElementById('addLabBtn')
    if (addLabBtn) addLabBtn.onclick = openAddLabForm

    // Imaging status change (delegated)
    document.querySelectorAll('[data-imaging-status]').forEach((sel) => {
      sel.onchange = () => updateImaging(sel.getAttribute('data-imaging-status'), sel.value)
    })
    const addImagingBtn = document.getElementById('addImagingBtn')
    if (addImagingBtn) addImagingBtn.onclick = openAddImagingForm

    // Detail / print modals (delegated)
    document.querySelectorAll('[data-lab-detail]').forEach((b) => {
      b.onclick = () => openLabDetail(b.getAttribute('data-lab-detail'))
    })
    document.querySelectorAll('[data-imaging-detail]').forEach((b) => {
      b.onclick = () => openImagingDetail(b.getAttribute('data-imaging-detail'))
    })

    const addMedBtn = document.getElementById('addMedBtn')
    if (addMedBtn) addMedBtn.onclick = openAddMedForm

    const addInvBtn = document.getElementById('addInvBtn')
    if (addInvBtn) addInvBtn.onclick = openAddInvoiceForm

    const dischargeBtn = document.getElementById('confirmDischarge')
    if (dischargeBtn) dischargeBtn.onclick = doDischarge
  }

  // ---------------------------------------------------------------
  //  CRUD: Plan items
  // ---------------------------------------------------------------
  function openAddPlanForm() {
    const nextRound = nextRoundFn(admission, planItems || [])
    formModal({
      title: 'Add plan item',
      submitLabel: 'Add item',
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: PLAN_TYPES, required: true },
        { name: 'round', label: 'Round', type: 'number', value: String(nextRound), required: true },
        { name: 'text', label: 'Plan item', full: true, required: true, placeholder: 'e.g. Start IV ceftriaxone 1g daily' },
      ],
      onSubmit: async (v) => {
        if (!v.text) throw new Error('Plan item text is required.')
        try {
          await createPlanItem(sid, {
            patient_id: admission.patientId,
            patient_name: admission.patientName,
            type: v.type,
            round: Number(v.round),
            text: v.text,
          })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Plan item added')
        reload()
      },
    })
  }

  function openEditPlanForm(itemId) {
    const it = (planItems || []).find((p) => p.id === itemId)
    if (!it) return
    formModal({
      title: 'Edit plan item',
      submitLabel: 'Save',
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: PLAN_TYPES, required: true, value: it.type || '' },
        { name: 'round', label: 'Round', type: 'number', required: true, value: String(it.round || 1) },
        { name: 'text', label: 'Plan item', full: true, required: true, value: it.text || '' },
      ],
      onSubmit: async (v) => {
        if (!v.text) throw new Error('Plan item text is required.')
        try {
          await updatePlanItem(sid, itemId, { type: v.type, round: Number(v.round), text: v.text })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Plan item updated')
        reload()
      },
    })
  }

  function removePlan(itemId) {
    const it = (planItems || []).find((p) => p.id === itemId)
    if (!it) return
    formModal({
      title: 'Remove plan item',
      body: '<p>Remove this plan item?</p><p class="sub"><strong>' + esc(it.text || '—') + '</strong></p>',
      submitLabel: 'Remove',
      onSubmit: async () => {
        try {
          await removePlanItem(sid, itemId, 'removed from workspace')
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Plan item removed')
        reload()
      },
    })
  }

  async function updatePlan(itemId, status) {
    try {
      await updatePlanStatus(sid, itemId, status)
      toast('Plan status → ' + status)
      reload()
    } catch (e) {
      toast(friendlyWriteError(e, 'Status update failed'))
      reload()
    }
  }

  // ---------------------------------------------------------------
  //  CRUD: Lab orders
  // ---------------------------------------------------------------
  function openAddLabForm() {
    // Order entry moved to the full-page LIMS form, which also attaches the
    // order to this ward session once placed.
    window.location.hash = '#/laboratory/new?patient=' + encodeURIComponent(admission.patientId) +
      '&session=' + encodeURIComponent(sid)
  }

  async function updateLab(labId, status) {
    try {
      await updateLabStatus(labId, status)
      toast('Lab status → ' + status)
      reload()
    } catch (e) {
      toast(friendlyWriteError(e, 'Status update failed'))
      reload()
    }
  }

  // ---------------------------------------------------------------
  //  CRUD: Imaging orders
  // ---------------------------------------------------------------
  function openAddImagingForm() {
    // One order may request several studies across different modalities (e.g. a
    // chest X-ray and a brain MRI). Four pair rows are offered; blank rows are
    // ignored, so a clinician fills only as many as the patient needs.
    const ROWS = 4
    const fields = []
    for (let i = 0; i < ROWS; i++) {
      fields.push({
        name: 'modality_' + i, label: i === 0 ? 'Modality' : 'Modality ' + (i + 1), type: 'select',
        options: [{ value: '', label: '— none —' }, ...MODALITIES],
      })
      fields.push({
        name: 'study_' + i, label: i === 0 ? 'Study / body part' : 'Study ' + (i + 1),
        placeholder: 'e.g. Chest PA view',
      })
    }
    fields.push({
      name: 'facility', label: 'Imaging facility', type: 'select',
      options: [
        { value: 'internal', label: 'Internal (in-house radiology)' },
        { value: 'external', label: 'External (print order for the patient)' },
      ],
    })
    fields.push({ name: 'indication', label: 'Indication', full: true, placeholder: 'e.g. Rule out pneumonia' })
    fields.push({ name: 'priority', label: 'Priority', type: 'select', options: ['Routine', 'Urgent', 'STAT'] })

    formModal({
      title: 'Order imaging',
      submitLabel: 'Place order',
      fields,
      onSubmit: async (v) => {
        const items = []
        for (let i = 0; i < ROWS; i++) {
          const modality = String(v['modality_' + i] || '').trim()
          const study = String(v['study_' + i] || '').trim()
          if (!modality && !study) continue
          if (!modality || !study) throw new Error('Row ' + (i + 1) + ': give both a modality and a study.')
          items.push({ modality, study })
        }
        if (!items.length) throw new Error('Add at least one modality and study.')
        try {
          await createImagingOrder({
            patient_id: admission.patientId,
            patient_name: admission.patientName,
            admission_session_id: sid,
            items,
            indication: v.indication || '',
            facility: v.facility,
            priority: v.priority || 'Routine',
          })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast(v.facility === 'external' ? 'External imaging order placed — print the request for the patient' : 'Imaging order placed')
        reload()
      },
    })
  }

  async function updateImaging(iid, status) {
    try {
      await updateImagingOrderStatus(iid, status)
      toast('Imaging status → ' + status)
      reload()
    } catch (e) {
      toast(friendlyWriteError(e, 'Status update failed'))
      reload()
    }
  }

  // ---------------------------------------------------------------
  //  Detail / print: Lab & Imaging
  // ---------------------------------------------------------------
  function openLabDetail(labId) {
    const l = (labs || []).find((x) => x.id === labId)
    if (!l) return
    const tests = normalizeTests(l)
    const external = l.facility === 'external'
    openModal('Lab order ' + esc(String(l.id).slice(0, 8)),
      '<div style="font-size:.88rem">' +
      '<div><span class="mut">Tests</span><br><strong>' + (tests.length ? tests.map((t) => esc(t)).join('<br>') : '—') + '</strong></div>' +
      '<div style="margin-top:6px"><span class="mut">Facility</span><br>' + (external ? '<span class="pill info">External — print & hand to patient</span>' : '<span class="mut">In-house laboratory</span>') + '</div>' +
      '<div style="margin-top:6px"><span class="mut">Priority</span><br>' + badge(l.priority || 'Routine') + ' ' + badge(l.status || 'order') + '</div>' +
      (formatTestResult(l.result) ? '<div style="margin-top:8px"><span class="mut">Result</span><br>' + esc(formatTestResult(l.result)) + '</div>' : '') +
      '</div>' +
      '<h4 style="margin:14px 0 6px">Result documents</h4><div id="wspLabImages"></div>' +
      '<div class="mrow"><button class="btn ghost" id="wspPrintLabReq">🖨 Request</button>' +
      (l.result ? '<button class="btn ghost" id="wspPrintLabRes">🖨 Result</button>' : '') +
      '<button class="btn ghost" data-close>Close</button></div>')

    mountResultImages(document.getElementById('wspLabImages'), { kind: 'lab', orderId: l.id, patientId: admission.patientId })
    const ctx = {
      hospitalName: authStore.getState().activeOrgName,
      patientName: admission.patientName,
      mrn: admission.mrn || '',
      orderId: l.id,
      tests,
      facility: external ? 'external' : 'internal',
      priority: l.priority,
      orderedByName: l.ordered_by_name,
      orderedAt: msOf(l.ordered_at || l.created_at),
      result: l.result,
      verifiedBy: l.verified_by_name,
      verifiedAt: msOf(l.verified_at),
    }
    document.getElementById('wspPrintLabReq').onclick = () => printDocument('Lab request', labRequestHtml(ctx))
    const resBtn = document.getElementById('wspPrintLabRes')
    if (resBtn) resBtn.onclick = () => printDocument('Lab report', labResultHtml(ctx))
  }

  function openImagingDetail(iid) {
    const i = (imaging || []).find((x) => x.id === iid)
    if (!i) return
    const items = normalizeImagingItems(i)
    const studies = items.map((it) => it.study).filter(Boolean)
    const external = i.facility === 'external'
    const pairsHtml = items.length
      ? '<table class="tbl" style="margin-top:2px"><tr><th>Modality</th><th>Study / body part</th></tr>' +
        items.map((it) => '<tr><td>' + esc(it.modality || '—') + '</td><td>' + esc(it.study || '—') + '</td></tr>').join('') + '</table>'
      : '<span class="mut">—</span>'
    openModal('Imaging order ' + esc(String(i.id).slice(0, 8)),
      '<div style="font-size:.88rem">' +
      '<div><span class="mut">Studies requested</span>' + pairsHtml + '</div>' +
      '<div style="margin-top:6px"><span class="mut">Facility</span><br>' + (external ? '<span class="pill info">External — print & hand to patient</span>' : '<span class="mut">In-house radiology</span>') + '</div>' +
      '<div style="margin-top:6px"><span class="mut">Priority</span><br>' + badge(i.priority || 'Routine') + ' ' + badge(i.status || 'order') + '</div>' +
      (i.indication ? '<div style="margin-top:8px"><span class="mut">Indication</span><br>' + esc(i.indication) + '</div>' : '') +
      (formatTestResult(i.result) ? '<div style="margin-top:8px"><span class="mut">Report</span><br>' + esc(formatTestResult(i.result)) + '</div>' : '') +
      '</div>' +
      '<h4 style="margin:14px 0 6px">Result documents</h4><div id="wspImagingImages"></div>' +
      '<div class="mrow"><button class="btn ghost" id="wspPrintImgReq">🖨 Print request</button>' +
      (imagingCaps.canOrder ? '<button class="btn ghost" id="wspImgReportBtn">✎ Enter report</button>' : '') +
      ((imagingCaps.canVerify && i.result && i.status !== 'verified') ? '<button class="btn ghost" id="wspImgVerifyBtn">✓ Verify</button>' : '') +
      (i.result ? '<button class="btn ghost" id="wspPrintImgRes">🖨 Print report</button>' : '') +
      '<button class="btn ghost" data-close>Close</button></div>')

    mountResultImages(document.getElementById('wspImagingImages'), { kind: 'imaging', orderId: i.id, patientId: admission.patientId })
    const ctx = {
      hospitalName: authStore.getState().activeOrgName,
      patientName: admission.patientName,
      mrn: admission.mrn || '',
      orderId: i.id,
      modality: i.modality,
      modalities: i.modalities,
      studies,
      items,
      facility: external ? 'external' : 'internal',
      priority: i.priority,
      indication: i.indication,
      orderedByName: i.ordered_by_name,
      orderedAt: msOf(i.ordered_at || i.created_at),
      result: i.result,
      verifiedBy: i.verified_by_name,
    }
    document.getElementById('wspPrintImgReq').onclick = () => printDocument('Imaging request', imagingRequestHtml(ctx))
    const reportBtn = document.getElementById('wspImgReportBtn')
    if (reportBtn) reportBtn.onclick = () => openImagingReportForm(i)
    const verifyBtn = document.getElementById('wspImgVerifyBtn')
    if (verifyBtn) verifyBtn.onclick = async () => {
      try {
        await verifyImagingOrder(i.id, authStore.getState().user?.email || '')
        closeModal()
        toast('Imaging report verified')
        reload()
      } catch (e) {
        toast(friendlyWriteError(e, 'Verification failed'))
      }
    }
    const resBtn = document.getElementById('wspPrintImgRes')
    if (resBtn) resBtn.onclick = () => printDocument('Imaging report', imagingResultHtml(ctx))
  }

  function openImagingReportForm(i) {
    formModal({
      title: 'Imaging report',
      submitLabel: 'Save report',
      fields: [
        { name: 'report', label: 'Findings / report', type: 'textarea', required: true, full: true, value: formatTestResult(i.result), placeholder: 'Radiologist findings…' },
      ],
      onSubmit: async (v) => {
        if (!v.report) throw new Error('Report text is required.')
        try {
          await addImagingResult(i.id, v.report)
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Imaging report saved')
        reload()
      },
    })
  }

  // ---------------------------------------------------------------
  //  CRUD: Medications
  // ---------------------------------------------------------------
  async function ensureDrugs() {
    if (drugs) return drugs
    drugs = await listOrgDrugs(activeOrg)
    return drugs
  }

  async function openAddMedForm() {
    let catalogue
    try {
      catalogue = await ensureDrugs()
    } catch (e) {
      toast('Could not load the pharmacy catalogue: ' + friendlyWriteError(e))
      return
    }
    openPrescriptionModal({
      drugs: catalogue,
      title: 'Prescribe medication',
      submitLabel: 'Prescribe',
      hint: 'One prescription for this stay — add every medicine and send them together.',
      onSubmit: async (lines) => {
        const rxArgs = {
          patientId: admission.patientId,
          patientName: admission.patientName,
          admissionSessionId: sid,
          lines,
        }
        let queued = false
        try {
          await requestMedicationLines(rxArgs)
        } catch (e) {
          // Handoff must not vanish — queue durably (e.g. offline read failure).
          try {
            await enqueue('rx_mirror', rxArgs)
            queued = true
          } catch {
            throw new Error(friendlyWriteError(e))
          }
        }
        closeModal()
        const n = lines.length
        const plural = n === 1 ? '' : 's'
        toast(queued
          ? 'Prescription saved — will reach the pharmacy when the connection allows'
          : lines.every((l) => l.external)
            ? 'External prescription saved — ' + n + ' medicine' + plural
            : 'Prescription sent to pharmacy — ' + n + ' medicine' + plural)
        reload()
      },
    })
  }

  // ---------------------------------------------------------------
  //  CRUD: Invoices
  // ---------------------------------------------------------------
  function openAddInvoiceForm() {
    formModal({
      title: 'Add charge',
      submitLabel: 'Add charge',
      fields: [
        { name: 'item', label: 'Item / service', required: true, full: true, placeholder: 'e.g. Ward bed (per day)' },
        { name: 'qty', label: 'Quantity', type: 'number', required: true, value: '1' },
        { name: 'payer', label: 'Payer', type: 'select', options: ['Self-pay', 'NHIA', 'HMO'] },
      ],
      onSubmit: async (v) => {
        if (!v.item) throw new Error('Item is required.')
        const qty = Number(v.qty)
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero.')
        try {
          await createInvoice({
            patient_id: admission.patientId,
            patient_name: admission.patientName,
            admission_session_id: sid,
            item: v.item,
            qty: qty,
            payer: v.payer || 'Self-pay',
          })
        } catch (e) { throw new Error(friendlyWriteError(e)) }
        closeModal()
        toast('Charge added')
        reload()
      },
    })
  }

  // ---------------------------------------------------------------
  //  Discharge
  // ---------------------------------------------------------------
  async function doDischarge() {
    const reasonEl = document.getElementById('dischargeReason')
    const reason = reasonEl ? reasonEl.value.trim() : ''
    if (!reason) { toast('Discharge reason is required.'); return }
    try {
      await dischargeAdmission(sid, { reason })
    } catch (e) {
      toast(friendlyWriteError(e, 'Discharge failed'))
      return
    }
    toast('Patient discharged — bed released')
    // Refresh admission status in memory
    admission.status = 'discharged'
    admission.dischargeDate = Date.now()
    admission.dischargeReason = reason
    reload()
  }

  render()
}
