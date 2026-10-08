// Laboratory with Firestore persistence (offline-first, cached).
import { shell, formModal, toast, closeModal, wireToast, openModal } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgLabs, createLabOrder, updateLabStatus, addLabResult, addLabVerification, myLabCaps,
} from '../services/laboratoryService.js'
import { listOrgPatients } from '../services/patientService.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

const TEST_PANELS = ['FBC + ESR', 'Malaria RDT + Widal', 'Urinalysis + Culture', 'Lipid profile + HbA1c']
const PRIORITIES = ['Routine', 'Urgent', 'STAT']
const STAGES = ['All', 'order', 'accepted', 'specimen-collected', 'processing', 'completed', 'verified', 'cancelled']
const PAGE_SIZE = 20

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
  let stageFilter = 'All'
  let searchQuery = ''
  let currentPage = 1
  let loadError = false

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
      '<div class="toolbar"><div class="search" style="flex:1;max-width:340px"><input class="input" id="searchInput" placeholder="Search patient, test, or ID…" value="' + esc(searchQuery) + '"></div><div class="chips" id="stages">' + STAGES.map((s, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-stage="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div></div>' +
      '<div id="loadError" class="card" style="display:none;text-align:center;padding:24px"><p class="sub">Failed to load lab orders.</p><button class="btn ghost" id="retryBtn">Retry</button></div>' +
      '<div class="tblwrap"><table class="tbl" id="lab-tbl"><tr><th>Order</th><th>Patient</th><th>Test</th><th>Stage</th><th>Priority</th><th>Date</th><th>Result</th><th></th></tr>' +
      '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table></div>' +
      '<div class="toolbar" id="pager" style="justify-content:space-between;display:none"><span class="mut" id="pageInfo" style="font-size:.8rem"></span><div><button class="btn ghost sm" id="prevPage">← Prev</button> <button class="btn ghost sm" id="nextPage">Next →</button></div></div></div>',
  })

  async function load() {
    loadError = false
    document.getElementById('loadError').style.display = 'none'
    try {
      const [labs, pats] = await Promise.all([
        listOrgLabs(activeOrg),
        listOrgPatients(activeOrg).catch(() => []),
      ])
      labOrders = labs
      patients = pats
      render()
    } catch (e) {
      console.error('[laboratory] list failed:', e)
      loadError = true
      document.getElementById('loadError').style.display = ''
      toast('Could not load lab orders: ' + friendlyWriteError(e))
    }
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    set('lab-pending', labOrders.filter((l) => l.status === 'order').length)
    set('lab-processing', labOrders.filter((l) => l.status === 'processing').length)
    set('lab-awaiting', labOrders.filter((l) => l.status === 'completed').length)
    set('lab-verified', labOrders.filter((l) => l.status === 'verified').length)

    const tbl = document.getElementById('lab-tbl')
    if (!tbl) return
    const head = '<tr><th>Order</th><th>Patient</th><th>Test</th><th>Stage</th><th>Priority</th><th>Date</th><th>Result</th><th></th></tr>'

    const q = searchQuery.toLowerCase()
    const filtered = labOrders.filter((l) => {
      if (stageFilter !== 'All' && l.status !== stageFilter) return false
      if (!q) return true
      return (l.patientName || '').toLowerCase().includes(q) ||
        (l.testPanel || '').toLowerCase().includes(q) ||
        (l.id || '').toLowerCase().includes(q)
    })

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    currentPage = Math.min(currentPage, totalPages)
    const start = (currentPage - 1) * PAGE_SIZE
    const shown = filtered.slice(start, start + PAGE_SIZE)

    const canStep = caps.canOrder || caps.canVerify
    const rows = shown.map((l) => {
      let action = ''
      if (!canStep) action = ''
      else if (l.status === 'order') action = '<button class="btn ghost sm" data-act="accepted" data-id="' + esc(l.id) + '">Accept</button> <button class="btn ghost sm" data-act="cancel" data-id="' + esc(l.id) + '" title="Cancel order">✕</button>'
      else if (l.status === 'accepted') action = '<button class="btn ghost sm" data-act="specimen-collected" data-id="' + esc(l.id) + '">Collect specimen</button>'
      else if (l.status === 'specimen-collected') action = '<button class="btn ghost sm" data-act="processing" data-id="' + esc(l.id) + '">Start processing</button>'
      else if (l.status === 'processing') action = '<button class="btn ghost sm" data-act="completed" data-id="' + esc(l.id) + '">Complete</button>'
      else if (l.status === 'completed') action = '<button class="btn ghost sm" data-act="verify" data-id="' + esc(l.id) + '">Verify</button>'
      const resultDisplay = l.result ? '<span class="pill ok">' + esc(String(l.result).slice(0, 20)) + (String(l.result).length > 20 ? '…' : '') + '</span>' : '<span class="mut">—</span>'
      return '<tr class="clickable" data-detail="' + esc(l.id) + '">' +
        '<td><strong>' + esc(l.id.slice(0, 8)) + '</strong><div class="mut">' + esc(l.encounterId || '') + '</div></td>' +
        '<td><a href="#/patients/' + esc(l.patientId) + '"><strong>' + esc(l.patientName) + '</strong></a></td>' +
        '<td>' + esc(l.testPanel) + '</td>' +
        '<td>' + labStatusBadge(l.status) + '</td>' +
        '<td>' + priorityPill(l.priority) + '</td>' +
        '<td class="mut">' + fmtDate(l.orderedAt) + '</td>' +
        '<td>' + resultDisplay + '</td>' +
        '<td>' + action + '</td></tr>'
    }).join('')

    tbl.innerHTML = head + (rows || '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">No lab orders found</td></tr>')

    const pager = document.getElementById('pager')
    if (filtered.length > PAGE_SIZE) {
      pager.style.display = ''
      document.getElementById('pageInfo').textContent = 'Showing ' + (start + 1) + '–' + Math.min(start + PAGE_SIZE, filtered.length) + ' of ' + filtered.length
      document.getElementById('prevPage').disabled = currentPage <= 1
      document.getElementById('nextPage').disabled = currentPage >= totalPages
    } else {
      pager.style.display = 'none'
    }

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
      row.onclick = () => openDetailModal(row.getAttribute('data-detail'))
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
        await load()
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
        await load()
      } catch (e) { toast(friendlyWriteError(e, 'Cancel failed')) }
    }
  }

  function openDetailModal(id) {
    const l = labOrders.find((x) => x.id === id)
    if (!l) return
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
      ? '<div style="margin-top:12px;padding:12px;background:#f0fdfa;border-radius:10px;border:1px solid #86efac"><strong style="color:#166534">Result:</strong> <span style="font-size:1.1rem">' + esc(String(l.result)) + '</span>' + (l.verifiedBy ? '<div class="mut" style="margin-top:4px">Verified by ' + esc(l.verifiedBy) + '</div>' : '') + '</div>'
      : ''

    openModal('Lab order ' + esc(l.id.slice(0, 8)),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-size:.88rem">' +
      '<div><span class="mut">Patient</span><br><strong>' + esc(l.patientName) + '</strong></div>' +
      '<div><span class="mut">Test panel</span><br><strong>' + esc(l.testPanel) + '</strong></div>' +
      '<div><span class="mut">Priority</span><br>' + priorityPill(l.priority) + '</div>' +
      '<div><span class="mut">Status</span><br>' + labStatusBadge(l.status) + '</div>' +
      (l.encounterId ? '<div style="grid-column:1/-1"><span class="mut">Encounter</span><br><span class="mut">' + esc(l.encounterId) + '</span></div>' : '') +
      '</div>' +
      '<div style="margin-top:14px">' + (timelineHtml || '<p class="mut">No timeline entries yet</p>') + '</div>' +
      resultSection +
      '<div class="mrow"><button class="btn ghost" data-close>Close</button></div>')
  }

  function openVerifyForm(id) {
    formModal({
      title: 'Verify result',
      submitLabel: 'Verify',
      fields: [
        { name: 'result', label: 'Result value', required: true, placeholder: 'e.g. 12.5 g/dL', full: true },
        { name: 'reviewer', label: 'Reviewer', placeholder: 'Scientist name' },
      ],
      onSubmit: async (v) => {
        try {
          await addLabResult(id, v.result)
          await addLabVerification(id, v.reviewer || '', v.reviewer || '')
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Lab result verified')
        await load()
      },
    })
  }

  function openOrderForm() {
    if (!patients.length) { toast('No patients registered yet — register a patient first.'); return }
    const patientOpts = patients.map((p) => ({ value: p.pid, label: p.name + ' · ' + (p.mrn || p.pid) }))
    formModal({
      title: 'New lab order',
      submitLabel: 'Place order →',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true, full: true },
        { name: 'test_panel', label: 'Test panel', type: 'select', options: TEST_PANELS, required: true },
        { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
        { name: 'note', label: 'Clinical note', full: true, placeholder: 'Indication…' },
      ],
      onSubmit: async (v) => {
        try {
          const sel = patients.find((p) => p.pid === v.patient_id)
          await createLabOrder({
            patient_id: v.patient_id,
            patient_name: sel ? sel.name : v.patient_id,
            test_panel: v.test_panel,
            priority: v.priority,
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Lab order placed')
        await load()
      },
    })
  }

  document.querySelectorAll('#stages .chip').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('#stages .chip').forEach((x) => x.classList.remove('on'))
      c.classList.add('on')
      stageFilter = c.getAttribute('data-stage')
      currentPage = 1
      render()
    }
  })

  let searchTimer
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim()
      currentPage = 1
      render()
    }, 250)
  })

  document.getElementById('refreshBtn').onclick = load
  document.getElementById('retryBtn').onclick = load
  document.getElementById('prevPage').onclick = () => { currentPage--; render() }
  document.getElementById('nextPage').onclick = () => { currentPage++; render() }
  const orderBtn = document.getElementById('orderBtn')
  if (orderBtn) orderBtn.onclick = openOrderForm
  wireToast(app)

  await load()
}
