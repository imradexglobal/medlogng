// Lab order detail: the bench's working screen for ONE order.
// Each ordered test ("item") carries its own workflow state; actions here
// collect / receive / reject / open result entry / validate / release, and the
// professional report + request slip print from this page.
// Route: #/laboratory/orders/:id
import { shell, toast, wireToast, openModal, closeModal } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  getLabOrder, collectItems, receiveItems, rejectItem, recollectItem,
  cancelItem, validateItem, releaseItem, releaseOrder, updateLabStatus,
  myLabCaps,
} from '../services/laboratoryService.js'
import { getLabSettings } from '../services/labCatalogueService.js'
import { createInvoiceForLabOrder } from '../services/billingService.js'
import { can } from '../features/admin/roles.js'
import { myActiveMembership } from '../services/authService.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'
import { fmtDate } from '../utils/format.js'
import { ITEM_STATUS, ITEM_STATUS_META } from '../features/labs/domain.js'
import { printDocument } from '../lib/print.js'
import { labReportHtml, labRequestStructuredHtml } from '../lib/labPrintTemplates.js'
import { mountResultImages } from '../components/resultImages.js'
import { staffLabel } from '../lib/staffName.js'

const naira = (kobo) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG')

function priorityPill(p) {
  const cls = p === 'STAT' ? 'bad' : p === 'Urgent' ? 'warn' : ''
  return '<span class="pill ' + cls + '">' + esc(p || 'Routine') + '</span>'
}

const ORDER_STATUS_META = {
  order: { label: 'Placed', cls: 'warn' },
  accepted: { label: 'Accepted', cls: 'info' },
  'specimen-collected': { label: 'Specimen collected', cls: 'info' },
  processing: { label: 'Processing', cls: 'info' },
  completed: { label: 'Completed', cls: 'ok' },
  verified: { label: 'Verified / released', cls: 'ok' },
  rejected: { label: 'Rejected', cls: 'bad' },
  cancelled: { label: 'Cancelled', cls: 'bad' },
}

function orderBadge(s) {
  const m = ORDER_STATUS_META[s] || { label: s, cls: '' }
  return '<span class="pill ' + esc(m.cls) + '">' + esc(m.label) + '</span>'
}

function itemStatusLabel(s) {
  const m = ITEM_STATUS_META[s] || { label: s, cls: '' }
  return { label: m.label, cls: m.cls }
}

export async function LabOrderView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myLabCaps()
  const lid = params.id
  let order = null
  let labSettings = null
  let loadError = null

  shell(app, {
    active: '/laboratory',
    title: 'Lab order',
    subtitle: '',
    actions: '<a class="btn ghost" href="#/laboratory">← Laboratory</a>',
    body: '<div id="order-detail">Loading…</div>',
  })
  wireToast(app)

  async function reload() {
    const root = document.getElementById('order-detail')
    try {
      order = await getLabOrder(lid)
      loadError = null
      if (!order) loadError = new Error('That lab order no longer exists.')
    } catch (e) {
      loadError = e
    }
    if (!labSettings) {
      try { labSettings = await getLabSettings(activeOrg) } catch { labSettings = null }
    }
    render()
  }

  function itemActions(it) {
    const btn = (act, label, cls = 'ghost sm') => '<button class="btn ' + cls + '" data-act="' + act + '" data-item="' + esc(it.item_id) + '">' + esc(label) + '</button>'
    const bits = []
    const statusOrder = [ITEM_STATUS.ORDERED, ITEM_STATUS.SAMPLE_COLLECTED, ITEM_STATUS.RECEIVED, ITEM_STATUS.RESULT_ENTERED, ITEM_STATUS.VALIDATED, ITEM_STATUS.RELEASED]
    const cur = statusOrder.indexOf(it.status)
    const stepper = statusOrder.map((st, i) => {
      let cls = 'step'
      if (i < cur) cls += ' done'
      else if (i === cur) cls += ' now'
      return '<span class="' + cls + '">' + esc(st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) + '</span>'
    }).join('<span class="arro">›</span>')
    if (it.status === 'ordered') {
      if (caps.canCollect) bits.push(btn('collect', 'Mark collected'))
      bits.push(btn('cancel-item', 'Cancel test'))
    } else if (it.status === 'sample_collected') {
      if (caps.canCollect) {
        bits.push(btn('receive', 'Receive at lab', 'sm'))
        bits.push(btn('reject', 'Reject / recollect', 'ghost sm'))
      }
    } else if (it.status === 'received') {
      if (caps.canResult) bits.push('<a class="btn sm" href="#/laboratory/orders/' + esc(lid) + '/items/' + esc(it.item_id) + '">Enter result</a>')
      if (caps.canCollect) bits.push(btn('reject', 'Reject', 'ghost sm'))
    } else if (it.status === 'result_entered') {
      if (caps.canResult) bits.push('<a class="btn ghost sm" href="#/laboratory/orders/' + esc(lid) + '/items/' + esc(it.item_id) + '">Edit result</a>')
      if (caps.canVerify) bits.push(btn('validate', 'Validate', 'sm'))
    } else if (it.status === 'validated') {
      if (caps.canVerify) bits.push(btn('release', 'Release', 'sm'))
      if (caps.canResult) bits.push('<a class="btn ghost sm" href="#/laboratory/orders/' + esc(lid) + '/items/' + esc(it.item_id) + '">Re-open result</a>')
    } else if (it.status === 'rejected') {
      if (caps.canCollect) bits.push(btn('recollect', 'Send for recollection', 'sm'))
    }
    return '<div class="item-stepper" style="font-size:.7rem;color:var(--emr-muted);margin:6px 0 2px">' + stepper + '</div>' + bits.join(' ')
  }

  function render() {
    const root = document.getElementById('order-detail')
    if (!root) return
    if (loadError) {
      root.innerHTML = '<div class="card"><p class="sub">' + esc(friendlyWriteError(loadError)) + '</p><a class="btn ghost" href="#/laboratory">← Back</a></div>'
      return
    }
    if (!order) { root.innerHTML = '<div class="card">Loading…</div>'; return }

    const items = order.items || []
    const canBill = can(myActiveMembership(), 'billing.invoice')
    const billBtn = (canBill && order.facility !== 'external' && order.billingStatus === 'unbilled')
      ? '<button class="btn ghost" id="billBtn">Create invoice</button>' : ''
    const allValidated = items.some((it) => it.status === 'validated') && !items.some((it) => ['ordered', 'sample_collected', 'received', 'result_entered', 'rejected'].includes(it.status))

    root.innerHTML =
      '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">' +
      '<div><h3 style="margin:0">' + esc(order.orderNo) + ' · ' + esc(order.patientName || '—') + '</h3>' +
      '<div class="mut" style="font-size:.85rem;margin-top:4px">' +
      '<a href="#/patients/' + esc(order.patientId) + '">Patient chart</a> · ' +
      esc(order.tests.join(', ')) +
      (order.encounterId ? ' · encounter ' + esc(order.encounterId.slice(0, 8)) : '') +
      (order.admissionSessionId ? ' · ward session' : '') +
      '</div></div>' +
      '<div style="text-align:right">' + orderBadge(order.status) + ' ' + priorityPill(order.priority) +
      (order.facility === 'external' ? ' <span class="pill info">External</span>' : '') +
      (order.billingStatus === 'invoiced' ? ' <span class="pill ok">Invoiced</span>' : ' <span class="pill warn">Unbilled</span>') +
      '<div class="mut" style="font-size:.8rem;margin-top:4px">' + fmtDate(order.orderedAt) + (staffLabel(order.orderedByName) ? ' · ' + esc(staffLabel(order.orderedByName)) : '') + '</div>' +
      '</div></div>' +
      (order.note ? '<p style="margin:10px 0 0"><span class="mut">Clinical note:</span> ' + esc(order.note) + '</p>' : '') +
      '<div class="mrow" style="margin-top:12px">' +
      '<button class="btn ghost" id="printReqBtn">🖨 Request slip</button>' +
      (items.some((it) => it.status === 'released')
        ? '<button class="btn" id="printReportBtn">🖨 Report</button>'
        : '<button class="btn ghost" id="printReportBtn" disabled>🖨 Report</button>') +
      billBtn +
      (allValidated && caps.canVerify ? '<button class="btn" id="releaseAllBtn">Release all validated</button>' : '') +
      '</div>' +
      '</div>' +

      '<div class="card"><h3>Tests on this order</h3>' +
      items.map((it) =>
        '<div class="item-card" data-status="' + esc(it.status) + '">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">' +
        '<div><strong>' + esc(it.test_name) + '</strong> ' + (it.test_code ? '<span class="mut">' + esc(it.test_code) + '</span>' : '') +
        '<span class="pill ' + esc(it.statusCls) + '" style="margin-left:6px">' + esc(it.statusLabel) + '</span>' +
        (it.accession_no ? '<div class="mut" style="font-size:.78rem">Accession ' + esc(it.accession_no) + '</div>' : '') +
        (it.specimen_type ? '<div class="mut" style="font-size:.78rem">Specimen: ' + esc(it.specimen_type) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right"><div>' + (it.price_kobo ? naira(it.price_kobo) : '<span class="mut">—</span>') + '</div>' +
        '<div class="mrow" style="justify-content:flex-end;margin-top:6px">' + itemActions(it) + '</div></div>' +
        '</div>' +
        (it.collection && it.collection.reject_reason ? '<p class="sub" style="color:#b91c1c;margin:6px 0 0">Rejected: ' + esc(it.collection.reject_reason) + '</p>' : '') +
        (it.resultText ? '<div class="result-line">' + esc(it.resultText) + (it.result && it.result.draft ? ' <span class="pill warn">draft</span>' : '') + '</div>' : '') +
        (it.result && it.result.validated_by_name ? '<div class="mut" style="font-size:.78rem;margin-top:4px">Validated by ' + esc(staffLabel(it.result.validated_by_name)) + ' · ' + fmtDate(it.result.validated_at) + '</div>' : '') +
        (it.result && it.result.released_by_name ? '<div class="mut" style="font-size:.78rem">Released by ' + esc(staffLabel(it.result.released_by_name)) + ' · ' + fmtDate(it.result.released_at) + '</div>' : '') +
        '</div>').join('') +
      (items.length ? '' : '<p class="mut">No individual tests recorded (legacy order).</p>') +
      '</div>' +

      (items.some((it) => it.legacy) || !items.length
        ? '<div class="card"><h3>Legacy order actions</h3><p class="sub">This order predates per-test tracking. Step it with the original whole-order flow.</p>' +
        '<div class="mrow">' +
        (caps.canOrder ? '<button class="btn ghost sm" data-legacy="specimen-collected">Collect specimen</button>' +
          '<button class="btn ghost sm" data-legacy="processing">Start processing</button>' : '') +
        (caps.canResult ? '<button class="btn ghost sm" id="legacyResultBtn">Enter result</button>' : '') +
        (caps.canVerify ? '<button class="btn ghost sm" data-legacy="verified">Verify</button>' : '') +
        '</div></div>'
        : '') +

      '<div class="card"><h3>Result documents</h3>' +
      '<p class="sub">Attach a scan, photo or PDF of the physical result sheet.' + (order.facility === 'external' ? ' External order — attach the report the patient brings back.' : '') + '</p>' +
      '<div id="orderResultImages"></div></div>'

    mountResultImages(document.getElementById('orderResultImages'), {
      kind: 'lab', orderId: order.id, patientId: order.patientId,
    })

    root.querySelector('#printReqBtn').onclick = () => printDocument('Lab request', labRequestStructuredHtml(order, { hospitalName: authStore.getState().activeOrgName }))
    const pr = root.querySelector('#printReportBtn')
    if (pr) pr.onclick = () => printDocument('Lab report', labReportHtml(order, { hospitalName: authStore.getState().activeOrgName, labSettings }))
    const bill = root.querySelector('#billBtn')
    if (bill) {
      bill.onclick = async () => {
        try {
          const inv = await createInvoiceForLabOrder(order)
          toast('Invoice ' + inv.id.slice(0, 8) + ' created · ' + naira(inv.total_kobo))
          reload()
        } catch (e) { toast(friendlyWriteError(e, 'Billing failed')) }
      }
    }
    const relAll = root.querySelector('#releaseAllBtn')
    if (relAll) {
      relAll.onclick = async () => {
        try { await releaseOrder(order.id); toast('Validated tests released'); reload() }
        catch (e) { toast(friendlyWriteError(e, 'Release failed')) }
      }
    }

    root.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => runItemAction(b.getAttribute('data-act'), b.getAttribute('data-item'))
    })
    root.querySelectorAll('[data-legacy]').forEach((b) => {
      b.onclick = async () => {
        try { await updateLabStatus(order.id, b.getAttribute('data-legacy')); toast('Order updated'); reload() }
        catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
      }
    })
    const legacyResult = root.querySelector('#legacyResultBtn')
    if (legacyResult) legacyResult.onclick = () => openLegacyResultForm()
  }

  async function runItemAction(act, itemId) {
    try {
      if (act === 'collect') await collectItems(order.id, [itemId])
      else if (act === 'receive') await receiveItems(order.id, [itemId])
      else if (act === 'recollect') await recollectItem(order.id, itemId)
      else if (act === 'cancel-item') await cancelItem(order.id, itemId, 'cancelled at the bench')
      else if (act === 'validate') await validateItem(order.id, itemId)
      else if (act === 'release') await releaseItem(order.id, itemId)
      else if (act === 'reject') return openRejectDialog(itemId)
      toast('Updated')
      reload()
    } catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
  }

  function openRejectDialog(itemId) {
    openModal('Reject sample',
      '<p>A rejection returns the test to the collection queue with a recorded reason (audit trail).</p>' +
      '<div class="mut" style="margin-bottom:8px">Common reasons:</div>' +
      '<div class="reject-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
      ['Clotted sample', 'Insufficient volume', 'Mislabelled', 'Haemolysed', 'Wrong tube', 'Other'].map((r) =>
        '<button class="btn ghost sm reject-chip" data-reason="' + esc(r) + '">' + esc(r) + '</button>').join('') +
      '</div>' +
      '<label>Reason<textarea class="input" id="rejectReason" rows="2" placeholder="e.g. clotted sample, insufficient volume, mislabelled"></textarea></label>' +
      '<div class="mrow"><button class="btn ghost" data-close>Keep sample</button>' +
      '<button class="btn" id="rejectYes" style="background:var(--emr-bad)">Reject</button></div>')
    document.querySelectorAll('.reject-chip').forEach((b) => {
      b.onclick = () => {
        document.getElementById('rejectReason').value = b.getAttribute('data-reason') === 'Other' ? '' : b.getAttribute('data-reason')
        document.getElementById('rejectReason')?.focus()
      }
    })
    document.getElementById('rejectYes').onclick = async () => {
      const reason = document.getElementById('rejectReason').value.trim()
      if (!reason) { toast('A reason is required.'); return }
      closeModal()
      try { await rejectItem(order.id, itemId, reason); toast('Sample rejected'); reload() }
      catch (e) { toast(friendlyWriteError(e, 'Reject failed')) }
    }
  }

  function openLegacyResultForm() {
    const tests = order.tests.length ? order.tests : ['Result']
    openModal('Enter result (legacy order)',
      tests.map((t, i) => '<label>' + esc(t) + '<input class="input" id="legacyRes' + i + '"></label>').join('') +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="legacySave">Save result</button></div>')
    document.getElementById('legacySave').onclick = async () => {
      const result = {}
      tests.forEach((t, i) => { result[t] = document.getElementById('legacyRes' + i).value.trim() })
      closeModal()
      try {
        const { addLabResult } = await import('../services/laboratoryService.js')
        await addLabResult(order.id, result)
        toast('Result saved')
        reload()
      } catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
    }
  }

  reload()
}
