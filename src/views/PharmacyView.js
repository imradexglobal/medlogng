// Pharmacy with Firestore persistence (offline-first, cached).
import { shell, statusBadge, toast, wireToast, skeletonCard } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgDrugs, listOrgDispense, myPharmacyCaps,
  receiveBatch, dispense, reverseDispenseIssue,
  listOrgRequests, subscribeOrgRequests,
} from '../services/pharmacyService.js'
import { onCleanup } from '../lib/lifecycle.js'
import * as R from '../features/pharmacy/requests.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteDrug, deleteMedicationRequest } from '../services/deleteService.js'
import { isHospitalAdmin } from '../features/admin/roles.js'
import { myActiveMembership } from '../services/authService.js'
import { openWalkInSaleModal } from '../components/PharmacyWalkInModal.js'
import { navigate } from '../router.js'
import { staffLabel } from '../lib/staffName.js'

// "Receive" is the pharmacist's worklist: prescriptions awaiting dispensing,
// plus the intake action. It carries the dispense action because that is the tab
// a pharmacist actually works from.
const TABS = ['Inventory', 'Receive & dispense', 'Dispensing', 'Batches & expiry']

export async function PharmacyView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myPharmacyCaps()

  if (!activeOrg) {
    shell(app, {
      active: '/pharmacy',
      title: 'Pharmacy',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let drugs = []
  let dispenseRecords = []
  let medicationRequests = []
  let tab = 'Inventory'
  let loading = false

  // The queue is what is still owed, so it holds open AND partly-issued
  // scripts. All-external scripts are listed too (so the pharmacist can see the
  // whole record) but are never dispensed here, which is why they are not
  // counted in "Awaiting dispense".
  const pendingCount = () => medicationRequests.filter((r) => R.isOpenRequest(r.status)).length
  const queueFilter = (r) => R.isOpenRequest(r.status) || r.status === R.REQUEST_STATUS.EXTERNAL

  // One-shot full list + live window (newest 100) are merged by id, incoming
  // wins: the listener refreshes rows that change (a dispensed script leaves
  // the queue), while scripts older than the live window keep coming from the
  // one-shot read instead of silently vanishing.
  let requestBase = []
  function ingestRequests(rows) {
    const seen = new Set(rows.map((r) => r.id))
    requestBase = [...rows, ...requestBase.filter((r) => !seen.has(r.id))]
    medicationRequests = requestBase.filter(queueFilter)
    render()
  }

  const initialBody = loading
    ? '<div style="padding:24px">' + skeletonCard(4) + '</div>'
    : null

shell(app, {
    active: '/pharmacy',
    title: 'Pharmacy',
    subtitle: 'Catalogue · batches · stock · dispensing',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canDispense ? '<button class="btn" id="walkInSaleBtn" style="background:#0d9488;color:#fff">🛒 Walk-in Sale</button>' : '') +
      (caps.canDispense ? '<button class="btn" id="dispenseBtn">Dispense →</button>' : '') +
      (caps.canManageInventory ? '<button class="btn ghost" id="receiveBtn">Receive batch</button>' : '') +
      (caps.canManageInventory ? '<button class="btn" id="addDrugBtn">+ Add item</button>' : ''),
    body:
      '<div class="grid4"><div class="stat"><em>Awaiting dispense</em><strong id="ph-pending">0</strong><span>prescriptions queued</span></div>' +
      '<div class="stat"><em>SKUs</em><strong id="ph-skus">0</strong><span>catalogue</span></div>' +
      '<div class="stat"><em>Low stock</em><strong id="ph-low">0</strong><span>reorder suggested</span></div>' +
      '<div class="stat"><em>Out of stock</em><strong id="ph-out">0</strong><span>items unavailable</span></div>' +
      '<div class="stat"><em>Stock value</em><strong id="ph-value">₦0</strong><span>at catalogue price</span></div></div>' +
      '<div class="tabs" id="pht">' + TABS.map((t, i) => '<button data-t="' + esc(t) + '" class="' + (i === 0 ? 'on' : '') + '">' + esc(t) + '</button>').join('') + '</div>' +
      '<div class="card" id="phpane"></div>',
  })

  async function load() {
    try {
      const [d, disp, reqs] = await Promise.all([
        listOrgDrugs(activeOrg).catch(() => {
          console.warn('[pharmacy] drug list unavailable due to permissions')
          return []
        }),
        listOrgDispense(activeOrg).catch(() => []),
        // The queue is what is still owed, so it holds open AND partly-issued
        // scripts. All-external scripts ride along so the pharmacist sees the
        // whole record, but they carry no dispense action. Filtering here rather
        // than in the query because status is derived from the lines by
        // normalizeRequest, not stored.
        listOrgRequests(activeOrg).catch((e) => {
          console.warn('[pharmacy] request list unavailable:', e?.message)
          return null
        }),
      ])
      drugs = d
      dispenseRecords = disp
      if (reqs) ingestRequests(reqs)
      render()
    } catch (e) {
      console.error('[pharmacy] list failed:', e)
      toast('Could not load pharmacy data: ' + friendlyWriteError(e))
    }
  }

  // Live queue: a script placed by any clinician appears here the moment it is
  // written — no manual Refresh. The one-shot above stays as the offline /
  // error fallback and as the source of rows older than the live window.
  let unsubRequests = null
  function subscribeQueue() {
    if (unsubRequests) { unsubRequests(); unsubRequests = null }
    unsubRequests = subscribeOrgRequests(activeOrg,
      (rows) => ingestRequests(rows),
      (e) => {
        console.warn('[pharmacy] live queue unavailable; one-shot only:', e?.message || e)
      })
  }

  function render() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v) }
    set('ph-pending', pendingCount())
    set('ph-skus', drugs.length)
    set('ph-low', drugs.filter((d) => d.stock > 0 && d.stock < 20).length)
    set('ph-out', drugs.filter((d) => d.stock === 0).length)
    // This tile used to be a "Balance (collected − given out)" that no code
    // ever wrote, so it was pinned at 0. Pharmacy records no money — a
    // dispensation stores items/qty only, and charges live in Billing. Stock
    // value is the figure actually derivable from this screen's data, so show
    // that rather than a plausible-looking number that is always zero.
    const stockValue = drugs.reduce((sum, d) => sum + Number(d.stock || 0) * Number(d.price || 0), 0)
    const stockCost = drugs.reduce((sum, d) => sum + Number(d.stock || 0) * Number(d.purchase_price || 0), 0)
    set('ph-value', '₦' + stockValue.toLocaleString('en-NG', { maximumFractionDigits: 0 }) +
      ' · cost ₦' + stockCost.toLocaleString('en-NG', { maximumFractionDigits: 0 }))
    document.querySelectorAll('#pht button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-t') === tab)
    })
    if (tab === 'Inventory') renderInventory()
    else if (tab === 'Receive & dispense') renderReceive()
    else if (tab === 'Dispensing') renderDispensing()
    else renderBatches()
  }

  // Scripts the pharmacy has finished issuing. They are not part of the working
  // queue above, but they are the only place a reversal can start.
  function historyHtml() {
    const done = requestBase
      .filter((r) => r.status === R.REQUEST_STATUS.DISPENSED)
      .slice(0, 10)
    if (!done.length) return ''
    const rows = done.map((r) =>
      '<tr><td><strong>' + esc(r.patientName || '—') + '</strong>' +
        (r.encounterId ? '<div class="mut">' + esc(r.encounterId.slice(0, 10)) + '</div>' : '') + '</td>' +
      '<td>' + esc(r.items.map((l) => l.medicine || 'item').slice(0, 2).join(', ')) +
        (r.lineCount > 2 ? ' +' + (r.lineCount - 2) + ' more' : '') + '</td>' +
      '<td>' + esc(r.dispensed) + ' / ' + esc(r.total) + '</td>' +
      '<td style="white-space:nowrap">' + statusBadge(r.status) +
        kebabCell({ rowId: r.id, items: [
          ...(caps.canDispense ? [{ label: 'Open →', dataAction: 'open' }] : []),
          ...(isHospitalAdmin(myActiveMembership()) && canDeleteRecords() ? [{ label: 'Delete (Admin)', tone: 'danger', dataAction: 'delete-req' }] : []),
        ] }) +
      '</td></tr>'
    ).join('')
    return '<p class="eyebrow" style="margin:18px 0 8px">Recently dispensed</p>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>Medicines</th><th>Issued</th><th>Status</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<p class="sub" style="margin-top:8px">Open one to reverse an issued medicine — its units go back on the shelf and the prescriber can edit it again.</p>'
  }

  // The prescription queue, one row per prescription SCRIPT. Each row opens to
  // show every line the prescriber wrote, so the pharmacist works an order the
  // way the prescriber wrote it rather than row-by-row per medicine.
  function renderReceive() {
    const pane = document.getElementById('phpane')
    if (!pane) return
    const rows = medicationRequests.map((r) => {
      const owed = r.outstanding
      const blocked = r.items.some((l) => {
        const drug = l.drug_id ? drugs.find((d) => d.id === l.drug_id) : null
        return drug && Number(drug.stock || 0) < R.lineOutstanding(l)
      })
      return '<tr><td><strong>' + esc(r.patientName || '—') + '</strong>' +
        (r.encounterId ? '<div class="mut">' + esc(r.encounterId.slice(0, 10)) + '</div>' : '') + '</td>' +
        // The medicines are summarised inline so the queue is scannable, and
        // the full list is one click away rather than requiring it to be read here.
        '<td>' + esc(r.items.map((l) => l.medicine || 'item').slice(0, 2).join(', ')) +
        (r.lineCount > 2 ? ' +' + (r.lineCount - 2) + ' more' : '') + '</td>' +
        '<td>' + r.lineCount + '</td>' +
        '<td>' + (r.total ? esc(r.dispensed) + ' / ' + esc(r.total) : '—') + '</td>' +
        '<td>' + statusBadge(r.status) + (blocked ? ' <span class="pill bad">short</span>' : '') + '</td>' +
        '<td>' + kebabCell({ rowId: r.id, items: [
          ...(caps.canDispense && owed > 0 ? [{ label: 'Open →', dataAction: 'open' }] : (caps.canDispense ? [{ label: 'View →', dataAction: 'open' }] : [])),
          ...(isHospitalAdmin(myActiveMembership()) && canDeleteRecords() ? [{ label: 'Delete (Admin)', tone: 'danger', dataAction: 'delete-req' }] : []),
        ] }) + '</td></tr>'
    }).join('')
    pane.innerHTML =
      (caps.canManageInventory
        ? '<div class="mrow" style="margin-bottom:12px"><button class="btn ghost" data-receive-new>+ Receive batch</button>' +
          '<span class="sub">Add incoming stock to a catalogue item.</span></div>'
        : '') +
      '<p class="eyebrow" style="margin:0 0 8px">Prescriptions awaiting dispensing</p>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>Medicines</th><th>Lines</th><th>Issued</th><th>Status</th><th style="width:100px">Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No prescriptions waiting. <a class="btn" href="#/pharmacy/receive">+ Add prescription</a></td></tr>') + '</tbody></table></div>' +
      '<p class="sub" style="margin-top:10px">One row per prescription. Open it to see every medicine and issue them one line at a time.</p>' +
      // A dispensed script leaves the working queue above, but the pharmacy
      // still needs a way back into one: opening it here is how an issued
      // medicine gets reversed (units returned, line unlocked for the
      // prescriber).
      historyHtml()
    const nb = pane.querySelector('[data-receive-new]')
    if (nb) nb.onclick = () => navigate('/pharmacy/receive')
    wireKebabs(pane, (rowId, action) => {
      if (action === 'open') navigate('/pharmacy/requests/' + rowId)
      if (action === 'delete-req') {
        const r = requestBase.find((x) => x.id === rowId) || medicationRequests.find((x) => x.id === rowId)
        confirmDelete('prescription for ' + (r?.patientName || 'patient'), () => deleteMedicationRequest(rowId, { force: true }), load)
      }
    })
  }

  function renderInventory() {
    const pane = document.getElementById('phpane')
    if (!pane) return
    const rows = drugs.map((d) => {
      const cost = Number(d.purchase_price || 0)
      const sell = Number(d.price || 0)
      const margin = sell > 0 && cost > 0 ? (((sell - cost) / sell) * 100).toFixed(0) + '%' : '—'
      return '<tr><td><strong>' + esc(d.name) + '</strong><div class="mut">' + esc(d.sku || '') + ' · ' + esc(d.batch || '') + '</div></td>' +
      '<td>' + esc(String(d.stock)) + ' ' + esc(d.unit || 'tabs') + '</td>' +
      '<td>' + esc(d.expiry || '—') + '</td>' +
      '<td>₦' + esc(String(cost.toFixed(2))) + '</td>' +
      '<td>₦' + esc(String(sell.toFixed(2))) + '</td>' +
      '<td class="mut">' + esc(margin) + '</td>' +
      '<td>' + statusBadge(d.status) + '</td>' +
      '<td>' + kebabCell({ rowId: d.id, items: (caps.canManageInventory
        ? [{ label: 'Edit', dataAction: 'edit' }, { label: 'Delete', tone: 'danger', dataAction: 'delete' }]
        : []) }) + '</td></tr>'
    }).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Medicine</th><th>Stock</th><th>Expiry</th><th>Cost ₦</th><th>Sell ₦</th><th>Margin</th><th>Status</th><th style="width:100px">Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="8" class="mut" style="text-align:center;padding:22px 8px">No drugs in catalogue. <a class="btn" href="#/pharmacy/drugs/new">+ Add first medicine</a></td></tr>') + '</tbody></table></div>' +
      '<p class="sub" style="margin-top:10px">Prescribe ≠ Dispense — prescriptions queue on the Receive tab for a pharmacist to issue.</p>'
    wireKebabs(pane, (rowId, action) => {
      if (action === 'edit') navigate('/pharmacy/drugs/' + rowId)
      if (action === 'delete') {
        const drug = drugs.find((d) => d.id === rowId)
        confirmDelete('medicine ' + (drug ? drug.name : 'this item'), () => deleteDrug(rowId, { force: true }), load)
      }
    })
  }

  function renderDispensing() {
    const pane = document.getElementById('phpane')
    if (!pane) return
    // dispensations.items is a JSON string written by dispense(); rendering it
    // raw dumped a JSON blob into the Items column.
    const itemsText = (raw) => {
      if (!raw) return '—'
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return String(raw)
        return parsed.map((it) => it.qty + ' × ' + (it.name || it.sku || 'item')).join(', ')
      } catch {
        return String(raw)
      }
    }
    const rows = dispenseRecords.map((d) =>
      '<tr><td><strong>' + esc(d.id.slice(0, 8)) + '</strong></td>' +
      '<td>' + esc(d.patientName || '—') + '</td>' +
      '<td>' + esc(itemsText(d.items)) + '</td>' +
      '<td class="mut">' + esc(staffLabel(d.by) || '—') + '</td>' +
      '<td>' + statusBadge(d.status) + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Ticket</th><th>Patient</th><th>Items</th><th>By</th><th>Status</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No dispense records. <a class="btn" href="#/pharmacy/receive">+ Dispense medication</a></td></tr>') + '</tbody></table></div>'
  }

  function renderBatches() {
    const pane = document.getElementById('phpane')
    if (!pane) return
    const withBatch = drugs.filter((d) => d.batch)
    const rows = withBatch.map((d) =>
      '<tr><td><strong>' + esc(d.batch) + '</strong></td><td>' + esc(d.name) + '</td>' +
      '<td>' + esc(String(d.stock)) + ' ' + esc(d.unit || 'tabs') + '</td>' +
      '<td>' + esc(d.expiry || '—') + '</td><td>' + statusBadge(d.status) + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Batch</th><th>Medicine</th><th>Qty</th><th>Expiry</th><th>Status</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No batch data. <a class="btn" href="#/pharmacy/drugs/new">+ Add medicine to catalogue</a></td></tr>') + '</tbody></table></div>'
  }

  document.getElementById('refreshBtn').onclick = load
  const addBtn = document.getElementById('addDrugBtn')
  if (addBtn) addBtn.onclick = () => navigate('/pharmacy/drugs/new')
  const receiveBtn = document.getElementById('receiveBtn')
  if (receiveBtn) receiveBtn.onclick = () => navigate('/pharmacy/receive')
  const walkInBtn = document.getElementById('walkInSaleBtn')
  if (walkInBtn) {
    walkInBtn.onclick = () => openWalkInSaleModal({ drugs, onSuccess: load })
  }
  const dispenseBtn = document.getElementById('dispenseBtn')
  if (dispenseBtn) {
    dispenseBtn.onclick = () => {
      tab = 'Receive & dispense'
      render()
      if (!medicationRequests.length) toast('No prescriptions waiting to be dispensed.')
      else if (medicationRequests.length === 1) navigate('/pharmacy/requests/' + medicationRequests[0].id)
    }
  }
  document.querySelectorAll('#pht button').forEach((b) => {
    b.onclick = () => { tab = b.getAttribute('data-t'); render() }
  })
  wireToast(app)

  subscribeQueue()
  onCleanup(() => {
    if (unsubRequests) { unsubRequests(); unsubRequests = null }
  })

  await load()
}
