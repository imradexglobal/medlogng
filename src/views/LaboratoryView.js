// Laboratory with Firestore persistence (offline-first, cached).
import { shell, formModal, toast, closeModal, wireToast, openModal } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgLabsPage, subscribeOrgLabs, createLabOrder, updateLabStatus, addLabResult, addLabVerification, myLabCaps,
  LAB_TEST_OPTIONS, formatTestResult,
} from '../services/laboratoryService.js'
import { listOrgPatientsPage, formatPhone, matchesPatient } from '../services/patientService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { mountResultImages } from '../components/resultImages.js'
import { printDocument } from '../lib/print.js'
import { labRequestHtml, labResultHtml } from '../lib/labPrintTemplates.js'

const TEST_PANELS = LAB_TEST_OPTIONS
const PRIORITIES = ['Routine', 'Urgent', 'STAT']
const STAGES = ['All', 'order', 'accepted', 'specimen-collected', 'processing', 'completed', 'verified', 'cancelled']

function priorityPill(p) {
  const cls = p === 'STAT' ? 'bad' : p === 'Urgent' ? 'warn' : ''
  return '<span class="pill ' + cls + '">' + esc(p) + '</span>'
}

function labStatusBadge(s) {
  const map = {
    order: ['Placed', 'warn'],
    accepted: ['Accepted', 'info'],
    'specimen-collected': ['Specimen collected', 'info'],
    processing: ['Processing', 'info'],
    completed: ['Completed', 'ok'],
    verified: ['Verified', 'ok'],
    cancelled: ['Cancelled', 'bad'],
  }
  const m = map[s] || [s, '']
  return '<span class="pill ' + m[1] + '">' + esc(m[0]) + '</span>'
}

function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export async function LaboratoryView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myLabCaps()

  if (!activeOrg) {
    shell(app, {
      active: '/laboratory',
      title: 'Laboratory',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let labOrders = []
  let patients = []
  let patientIndex = new Map()
  let patientLoadError = null
  let stageFilter = 'All'
  let searchQuery = ''
  // Infinite scroll: rows accumulate and `cursor` marks the end of what we hold.
  let cursor = null
  let hasMore = false
  let loading = false
  let loadError = false
  let unsubs = []
  let watchedOrg = activeOrg

  shell(app, {
    active: '/laboratory',
    title: 'Laboratory',
    subtitle: 'Order → Accepted → Collected → Processing → Completed → Verified · entry ≠ verification',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canOrder ? '<button class="btn" id="orderBtn">+ New lab order</button>' : ''),
    body:
      '<div class="grid4"><div class="stat"><em>Pending</em><strong id="lab-pending">0</strong><span>orders placed</span></div>' +
      '<div class="stat"><em>Processing</em><strong id="lab-processing">0</strong><span>analysers online</span></div>' +
      '<div class="stat"><em>Awaiting verification</em><strong id="lab-awaiting">0</strong><span>needs scientist sign-off</span></div>' +
      '<div class="stat"><em>Verified</em><strong id="lab-verified">0</strong><span>verified results</span></div></div>' +
      '<div class="card"><div class="flow"><span class="fstep done">Order</span><span class="farrow">→</span><span class="fstep">Accepted</span><span class="farrow">→</span><span class="fstep">Specimen collected</span><span class="farrow">→</span><span class="fstep">Processing</span><span class="farrow">→</span><span class="fstep">Completed</span><span class="farrow">→</span><span class="fstep">Verified</span></div>' +
      '<div class="toolbar"><div class="search" style="flex:1;max-width:340px"><input class="input" id="searchInput" placeholder="Search patient, mobile, test, or ID…" value="' + esc(searchQuery) + '"></div><div class="chips" id="stages">' + STAGES.map((s, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-stage="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div></div>' +
      '<div id="loadError" class="card" style="display:none;text-align:center;padding:24px"><p class="sub">Failed to load lab orders.</p><button class="btn ghost" id="retryBtn">Retry</button></div>' +
      '<div class="tblwrap"><table class="tbl" id="lab-tbl"><tr><th>Order</th><th>Patient</th><th>Test</th><th>Stage</th><th>Priority</th><th>Date</th><th>Result</th><th></th></tr>' +
      '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table><div class="loadmore" data-loadmore="1"></div></div></div>',
  })

  const more = createLoadMore(loadMore)

  // Patients feed the order form and the search join. They are loaded on their
  // own read, separately from the lab queue: when the two were fetched in one
  // Promise.all a failed lab query left the patient list empty, which surfaced
  // as the misleading "No patients registered yet" toast on the order form.
  // Errors are kept (not swallowed) so the real cause — a missing index, an
  // offline device or a permissions problem — can be shown to the user.
  async function loadPatients() {
    try {
      const r = await listOrgPatientsPage(activeOrg, { pageSize: 100 })
      patients = r.rows
      patientIndex = new Map(patients.map((p) => [p.pid, p]))
      patientLoadError = null
    } catch (e) {
      console.error('[laboratory] patient load failed:', e)
      patientLoadError = e
      patients = []
      patientIndex = new Map()
    }
  }

  // Append the next chunk of the lab queue. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && labOrders.length === 0
    loading = true
    more.setLoading(true)
    const wrap = document.getElementById('lab-tbl')?.closest('.tblwrap')
    wrap?.classList.add('is-loading')
    if (first) {
      loadError = false
      document.getElementById('loadError').style.display = 'none'
    }
    try {
      const pg = await listOrgLabsPage(activeOrg, { cursor })
      // A row written between two chunk reads shifts the cursor stream and can
      // repeat the boundary document.
      const seen = new Set(labOrders.map((l) => l.id))
      labOrders = first ? pg.rows : [...labOrders, ...pg.rows.filter((l) => !seen.has(l.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
    } catch (e) {
      console.error('[laboratory] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) {
        loadError = true
        document.getElementById('loadError').style.display = ''
        toast('Could not load lab orders: ' + friendlyWriteError(e))
      } else {
        more.setError('Could not load more — retry')
      }
    } finally {
      wrap?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole list.
  function reload() {
    labOrders = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadPatients().then(render)
    loadMore().then(subscribeLive)
  }

  // Orders written before the patient_name field (or from a source that did not
  // snapshot it) still need a readable name, so fall back to the org registry.
  function patientName(l) {
    return l.patientName || (patientIndex.get(l.patientId) || {}).name || '—'
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    set('lab-pending', labOrders.filter((l) => l.status === 'order').length)
    set('lab-processing', labOrders.filter((l) => l.status === 'processing').length)
    set('lab-awaiting', labOrders.filter((l) => l.status === 'completed').length)
    set('lab-verified', labOrders.filter((l) => l.status === 'verified').length)

    const tbl = document.getElementById('lab-tbl')
    if (!tbl) return
    // A row loaded successfully: any earlier "failed to load" card is stale.
    if (labOrders.length) document.getElementById('loadError').style.display = 'none'
    const head = '<tr><th>Order</th><th>Patient</th><th>Test</th><th>Stage</th><th>Priority</th><th>Date</th><th>Result</th><th></th></tr>'

    const q = searchQuery.toLowerCase()
    const filtered = labOrders.filter((l) => {
      if (stageFilter !== 'All' && l.status !== stageFilter) return false
      if (!q) return true
      if ((l.patientName || '').toLowerCase().includes(q) ||
        (l.testPanel || '').toLowerCase().includes(q) ||
        (l.id || '').toLowerCase().includes(q)) return true
      // A lab order only stores the patient name, so the patient's own record
      // is joined in — otherwise their mobile number could never find the order.
      const p = patientIndex.get(l.patientId)
      return !!p && matchesPatient(p, q)
    })

    // Stage and search filters apply over everything loaded so far, and keep
    // narrowing as more chunks arrive.
    const shown = filtered

    const canStep = caps.canOrder || caps.canVerify
    const rows = shown.map((l) => {
      let action = ''
      if (!canStep) action = ''
      else if (l.status === 'order') action = '<button class="btn ghost sm" data-act="accepted" data-id="' + esc(l.id) + '">Accept</button> <button class="btn ghost sm" data-act="cancel" data-id="' + esc(l.id) + '" title="Cancel order">✕</button>'
      else if (l.status === 'accepted') action = '<button class="btn ghost sm" data-act="specimen-collected" data-id="' + esc(l.id) + '">Collect specimen</button>'
      else if (l.status === 'specimen-collected') action = '<button class="btn ghost sm" data-act="processing" data-id="' + esc(l.id) + '">Start processing</button>'
      else if (l.status === 'processing') action = '<button class="btn ghost sm" data-act="completed" data-id="' + esc(l.id) + '">Complete</button>'
      else if (l.status === 'completed') action = '<button class="btn ghost sm" data-act="verify" data-id="' + esc(l.id) + '">Verify</button>'
      const resultText = formatTestResult(l.result)
      const resultDisplay = resultText ? '<span class="pill ok">' + esc(resultText.slice(0, 20)) + (resultText.length > 20 ? '…' : '') + '</span>' : '<span class="mut">—</span>'
      return '<tr class="clickable" data-detail="' + esc(l.id) + '">' +
        '<td><strong>' + esc(l.id.slice(0, 8)) + '</strong><div class="mut">' + esc(l.encounterId || '') + '</div></td>' +
        '<td><a href="#/patients/' + esc(l.patientId) + '"><strong>' + esc(patientName(l)) + '</strong></a></td>' +
        '<td>' + esc(l.testPanel) + '</td>' +
        '<td>' + labStatusBadge(l.status) + '</td>' +
        '<td>' + priorityPill(l.priority) + '</td>' +
        '<td class="mut">' + fmtDate(l.orderedAt) + '</td>' +
        '<td>' + resultDisplay + '</td>' +
        '<td>' + action + '</td></tr>'
    }).join('')

    tbl.innerHTML = head + (rows || '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">No lab orders found</td></tr>')

    more.mount(tbl.closest('.tblwrap'))

    tbl.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation()
        const id = b.getAttribute('data-id')
        const act = b.getAttribute('data-act')
        try {
          if (act === 'verify') {
            if (!caps.canVerify && !caps.canOrder) { toast(friendlyWriteError({ code: 'permission-denied' })); return }
            openVerifyForm(id)
            return
          }
          if (act === 'cancel') {
            confirmCancel(id)
            return
          }
          const labels = { accepted: 'Accept order', 'specimen-collected': 'Collect specimen', processing: 'Start processing', completed: 'Complete processing' }
          confirmAction(id, act, labels[act] || 'Update')
        } catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
      }
    })

    tbl.querySelectorAll('[data-detail]').forEach((row) => {
      // The patient name is a real link inside the row, so the row click has to
      // stand aside for it — otherwise clicking the name navigates to the
      // patient AND opens the order detail on top of it.
      row.onclick = (e) => {
        if (e.target.closest('a')) return
        openDetailModal(row.getAttribute('data-detail'))
      }
    })
  }

  function confirmAction(id, act, label) {
    openModal('Confirm action',
      '<p>Are you sure you want to <strong>' + esc(label.toLowerCase()) + '</strong> this lab order?</p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn" id="confirmYes">' + esc(label) + '</button></div>')
    document.getElementById('confirmYes').onclick = async () => {
      closeModal()
      toast('Updating…')
      try {
        await updateLabStatus(id, act)
        toast('Lab order updated: ' + act)
        reload()
      } catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
    }
  }

  function confirmCancel(id) {
    openModal('Cancel lab order',
      '<p>Are you sure you want to <strong>cancel</strong> this lab order? This action cannot be undone.</p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Keep order</button>' +
      '<button class="btn" id="cancelYes" style="background:var(--emr-bad)">Cancel order</button></div>')
    document.getElementById('cancelYes').onclick = async () => {
      closeModal()
      try {
        await updateLabStatus(id, 'cancelled')
        toast('Lab order cancelled')
        reload()
      } catch (e) { toast(friendlyWriteError(e, 'Cancel failed')) }
    }
  }

  function openDetailModal(id) {
    const l = labOrders.find((x) => x.id === id)
    if (!l) return
    const tests = (l.tests && l.tests.length) ? l.tests : (l.testPanel ? [l.testPanel] : [])
    const timeline = [
      { label: 'Ordered', at: l.orderedAt, by: l.orderedByName },
      { label: 'Accepted', at: l.acceptedAt, by: '' },
      { label: 'Specimen collected', at: l.collectedAt, by: '' },
      { label: 'Processing', at: l.processedAt, by: '' },
      { label: 'Completed', at: l.completedAt, by: '' },
      { label: 'Verified', at: l.verifiedAt, by: l.verifiedBy },
    ].filter((t) => t.at)

    const timelineHtml = timeline.map((t) =>
      '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9">' +
      '<span class="pill ok" style="min-width:110px;text-align:center">' + esc(t.label) + '</span>' +
      '<span><strong>' + fmtDate(t.at) + '</strong>' + (t.by ? ' <span class="mut">by ' + esc(t.by) + '</span>' : '') + '</span></div>'
    ).join('')

    const resultSection = l.result
      ? '<div style="margin-top:12px;padding:12px;background:#f0fdfa;border-radius:10px;border:1px solid #86efac"><strong style="color:#166534">Result:</strong> <span style="font-size:1.05rem">' + esc(formatTestResult(l.result)) + '</span>' + (l.verifiedBy ? '<div class="mut" style="margin-top:4px">Verified by ' + esc(l.verifiedBy) + '</div>' : '') + '</div>'
      : ''

    openModal('Lab order ' + esc(l.id.slice(0, 8)),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:.88rem">' +
      '<div><span class="mut">Patient</span><br><strong>' + esc(patientName(l)) + '</strong></div>' +
      '<div><span class="mut">Tests</span><br><strong>' + (tests.length ? tests.map((t) => esc(t)).join('<br>') : '—') + '</strong></div>' +
      '<div><span class="mut">Priority</span><br>' + priorityPill(l.priority) + '</div>' +
      '<div><span class="mut">Status</span><br>' + labStatusBadge(l.status) + '</div>' +
      '<div><span class="mut">Facility</span><br>' + (l.facility === 'external' ? '<span class="pill info">External</span>' : '<span class="mut">In-house</span>') + '</div>' +
      (l.encounterId ? '<div style="grid-column:1/-1"><span class="mut">Encounter</span><br><span class="mut">' + esc(l.encounterId) + '</span></div>' : '') +
      '</div>' +
      resultSection +
      '<h4 style="margin:14px 0 6px">Result documents</h4>' +
      '<p class="sub" style="margin:0 0 6px">' + (l.facility === 'external'
        ? 'External order — attach the report the patient brings back (scan, photo or PDF).'
        : 'Attach a scan, photo or PDF of the result.') + '</p><div id="labResultImages"></div>' +
      '<div style="margin-top:14px">' + (timelineHtml || '<p class="mut">No timeline entries yet</p>') + '</div>' +
      '<div class="mrow"><button class="btn ghost" id="printRequestBtn">🖨 Print request</button>' +
      (l.result ? '<button class="btn ghost" id="printResultBtn">🖨 Print result</button>' : '') +
      '<button class="btn ghost" data-close>Close</button></div>')

    mountResultImages(document.getElementById('labResultImages'), {
      kind: 'lab', orderId: l.id, patientId: l.patientId,
    })

    const ctx = () => ({
      hospitalName: authStore.getState().activeOrgName,
      patientName: patientName(l),
      mrn: (patientIndex.get(l.patientId) || {}).mrn || '',
      orderId: l.id,
      tests,
      facility: l.facility,
      priority: l.priority,
      orderedByName: l.orderedByName,
      orderedAt: l.orderedAt,
      result: l.result,
      verifiedBy: l.verifiedBy,
      verifiedAt: l.verifiedAt,
    })
    document.getElementById('printRequestBtn').onclick = () => printDocument('Lab request', labRequestHtml(ctx()))
    const pr = document.getElementById('printResultBtn')
    if (pr) pr.onclick = () => printDocument('Lab report', labResultHtml(ctx()))
  }

  function openVerifyForm(id) {
    const l = labOrders.find((x) => x.id === id)
    const tests = (l && l.tests && l.tests.length) ? l.tests : [(l && l.testPanel) || 'Result']
    const fields = tests.map((t, i) => ({
      name: 'res' + i, label: t, full: true, placeholder: 'e.g. 12.5 g/dL',
    }))
    fields.push({ name: 'reviewer', label: 'Reviewer', placeholder: 'Scientist name' })
    formModal({
      title: 'Verify result',
      submitLabel: 'Verify',
      fields,
      onSubmit: async (v) => {
        const result = {}
        tests.forEach((t, i) => { result[t] = v['res' + i] || '' })
        try {
          await addLabResult(id, result)
          await addLabVerification(id, v.reviewer || '', v.reviewer || '')
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Lab result verified')
        reload()
      },
    })
  }

  async function openOrderForm() {
    // The registry read may have failed or not finished yet. Retry once on
    // demand before telling the user there are no patients — and if it really
    // failed, say why instead of blaming the registry.
    if (!patients.length) {
      toast('Loading patients…')
      await loadPatients()
      render()
    }
    if (!patients.length) {
      toast(patientLoadError
        ? 'Could not load patients: ' + friendlyWriteError(patientLoadError)
        : 'No patients registered yet — register a patient first.')
      return
    }
    // The label carries the mobile number so the picker's filter box can find
    // a patient by phone, not just by name.
    const patientOpts = patients.map((p) => ({
      value: p.pid,
      label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
    }))
    formModal({
      title: 'New lab order',
      submitLabel: 'Place order →',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true, full: true, searchable: patientOpts.length > 1, searchPlaceholder: 'Name, ID or mobile…' },
        { name: 'tests', label: 'Tests (select one or more)', type: 'checks', options: TEST_PANELS, full: true },
        { name: 'extra_tests', label: 'Other tests (comma separated)', full: true, placeholder: 'e.g. Ferritin, Vitamin D' },
        {
          name: 'facility', label: 'Lab facility', type: 'select',
          options: [
            { value: 'internal', label: 'Internal (in-house laboratory)' },
            { value: 'external', label: 'External (print order for the patient)' },
          ],
        },
        { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
        { name: 'note', label: 'Clinical note', full: true, placeholder: 'Indication…' },
      ],
      onSubmit: async (v) => {
        const extra = String(v.extra_tests || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
        const tests = [...(Array.isArray(v.tests) ? v.tests : []), ...extra]
        if (!v.patient_id) throw new Error('Select a patient.')
        if (!tests.length) throw new Error('Select at least one test.')
        try {
          const sel = patients.find((p) => p.pid === v.patient_id)
          await createLabOrder({
            patient_id: v.patient_id,
            patient_name: sel ? sel.name : v.patient_id,
            tests,
            facility: v.facility,
            priority: v.priority,
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast(v.facility === 'external' ? 'External lab order placed — print the request for the patient' : 'Lab order placed')
        reload()
      },
    })
  }

  document.querySelectorAll('#stages .chip').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('#stages .chip').forEach((x) => x.classList.remove('on'))
      c.classList.add('on')
      stageFilter = c.getAttribute('data-stage')
      render()
    }
  })

  let searchTimer
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim()
      render()
    }, 250)
  })

  document.getElementById('refreshBtn').onclick = reload
  document.getElementById('retryBtn').onclick = reload
  const orderBtn = document.getElementById('orderBtn')
  if (orderBtn) orderBtn.onclick = openOrderForm
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  // Live updates for the lab queue. The patient join stays one-shot (registry
  // is never live); a brand-new patient's contact details may only appear in
  // search after reload.
  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    // The live feed only ever knows about the newest slice of the queue. Once
    // the user has scrolled past it, leave the accumulated list alone rather
    // than truncating it back to one chunk.
    if (cursor != null) return
    unsubs.push(
      subscribeOrgLabs(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(labOrders.map((l) => l.id))
          labOrders = rows.filter((l) => !seen.has(l.id)).concat(labOrders)
          render()
        },
        (e) => {
          console.warn('[laboratory] live update failed; refreshing once:', e?.message || e)
          listOrgLabsPage(watchedOrg)
            .then((r) => { labOrders = r.rows; render() })
            .catch(() => {})
        }),
    )
  }

  onCleanup(() => {
    teardownListeners()
    unsubAuth()
  })

  // The app does not re-route on org change, so rebuild the listener when the
  // active hospital switches.
  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    subscribeLive()
  })

  reload()
  subscribeLive()
}
