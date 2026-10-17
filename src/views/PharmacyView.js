// Pharmacy with Firestore persistence (offline-first, cached).
import { shell, statusBadge, formModal, toast, closeModal, openModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgDrugs, createDrug, updateDrug, listOrgDispense, myPharmacyCaps,
  findDrugNameMatches, receiveBatch, dispense, reverseDispenseIssue,
  listOrgRequests, subscribeOrgRequests,
} from '../services/pharmacyService.js'
import { onCleanup } from '../lib/lifecycle.js'
import * as R from '../features/pharmacy/requests.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import {
  generateSku, drugCodeError, strengthError, packSizeError,
} from '../utils/sku.js'

// "Receive" is the pharmacist's worklist: prescriptions awaiting dispensing,
// plus the intake action. It carries the dispense action because that is the tab
// a pharmacist actually works from.
const TABS = ['Inventory', 'Receive & dispense', 'Dispensing', 'Batches & expiry']
const UNITS = ['tabs', 'caps', 'vials', 'sachets', 'ml', 'ampoules']

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

shell(app, {
    active: '/pharmacy',
    title: 'Pharmacy',
    subtitle: 'Catalogue · batches · stock · dispensing',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
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
        listOrgDrugs(activeOrg),
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
    set('ph-value', '₦' + stockValue.toLocaleString('en-NG', { maximumFractionDigits: 0 }))
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
        (caps.canDispense ? ' <button class="btn ghost sm" data-open-request="' + esc(r.id) + '">Open →</button>' : '') +
      '</td></tr>'
    ).join('')
    return '<p class="eyebrow" style="margin:18px 0 8px">Recently dispensed</p>' +
      '<div class="tblwrap"><table class="tbl"><tr><th>Patient</th><th>Medicines</th><th>Issued</th><th>Status</th></tr>' +
      rows + '</table></div>' +
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
        '<td>' + (caps.canDispense && owed > 0
          ? '<button class="btn sm" data-open-request="' + esc(r.id) + '">Open →</button>'
          : '<span class="mut">—</span>') + '</td></tr>'
    }).join('')
    pane.innerHTML =
      (caps.canManageInventory
        ? '<div class="mrow" style="margin-bottom:12px"><button class="btn ghost" data-receive-new>+ Receive batch</button>' +
          '<span class="sub">Add incoming stock to a catalogue item.</span></div>'
        : '') +
      '<p class="eyebrow" style="margin:0 0 8px">Prescriptions awaiting dispensing</p>' +
      '<div class="tblwrap"><table class="tbl"><tr><th>Patient</th><th>Medicines</th><th>Lines</th><th>Issued</th><th>Status</th><th></th></tr>' +
      (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No prescriptions waiting</td></tr>') +
      '</table></div>' +
      '<p class="sub" style="margin-top:10px">One row per prescription. Open it to see every medicine and issue them one line at a time.</p>' +
      // A dispensed script leaves the working queue above, but the pharmacy
      // still needs a way back into one: opening it here is how an issued
      // medicine gets reversed (units returned, line unlocked for the
      // prescriber).
      historyHtml()
    const nb = pane.querySelector('[data-receive-new]')
    if (nb) nb.onclick = () => openReceiveForm()
    pane.querySelectorAll('[data-open-request]').forEach((b) => {
      b.onclick = () => openRequestDetail(b.getAttribute('data-open-request'))
    })
  }

  // A whole prescription script, opened for dispensing. Lines still owed carry
  // a quantity box seeded with what is outstanding; lines already issued show a
  // Reverse button, which puts the units back on the shelf and unlocks the
  // medicine for the prescriber. Stock is checked live so a line that cannot be
  // filled is called out before anything is committed.
  function openRequestDetail(reqId) {
    // requestBase holds every script (queue + recently dispensed); the queue
    // view above is only the open ones, and a reversal starts from the closed
    // ones, so the lookup must not be limited to the queue.
    const req = requestBase.find((r) => r.id === reqId) || medicationRequests.find((r) => r.id === reqId)
    if (!req) return
    if (!caps.canDispense) { toast('Your role cannot dispense medication.'); return }

    const lineRow = (l) => {
      const owed = R.lineOutstanding(l)
      const drug = l.drug_id ? drugs.find((d) => d.id === l.drug_id) : null
      const onHand = drug ? Number(drug.stock || 0) : 0
      const short = owed > 0 && (!drug || onHand < owed)
      const settled = owed === 0
      // An external line is bought outside the hospital. It is shown for the
      // record but cannot be issued here, so it gets no quantity box — issuing
      // is what would wrongly decrement in-house stock.
      if (l.external) {
        return '<tr style="opacity:.7">' +
          '<td><strong>' + esc(l.medicine || 'Unnamed item') + '</strong> <span class="pill info">external</span>' +
          (l.sku ? '<div class="mut">' + esc(l.sku) + '</div>' : '') + '</td>' +
          '<td>' + esc(l.dosage || '—') + '</td>' +
          '<td>' + esc(R.toQty(l.quantity, 0)) + ' ' + esc(l.unit || '') + '</td>' +
          '<td>—</td><td>—</td>' +
          '<td><span class="mut">External pharmacy</span></td></tr>'
      }
      // An issued line can be reversed: units back on the shelf, dispensed_qty
      // back to zero, so the medicine unlocks for the prescriber again.
      const reverseBtn = '<button type="button" class="btn ghost sm" data-reverse-line="' + esc(l.line_id) + '">↩ Reverse</button>'
      const issueCell = settled
        ? reverseBtn
        : (short
          ? '<span class="pill bad">only ' + esc(onHand) + ' on hand</span>'
          : '<input class="input" type="number" min="1" max="' + esc(owed) + '" value="' + esc(owed) +
            '" data-qty-for="' + esc(l.line_id) + '" style="width:96px" />') +
          (R.toQty(l.dispensed_qty, 0) > 0 ? ' ' + reverseBtn : '')
      return '<tr' + (settled ? ' style="opacity:.55"' : '') + '>' +
        '<td><strong>' + esc(l.medicine || 'Unnamed item') + '</strong>' +
        (l.sku ? '<div class="mut">' + esc(l.sku) + '</div>' : '') + '</td>' +
        '<td>' + esc(l.dosage || '—') + '</td>' +
        '<td>' + esc(R.toQty(l.quantity, 0)) + ' ' + esc(l.unit || '') + '</td>' +
        '<td>' + esc(R.toQty(l.dispensed_qty, 0)) + '</td>' +
        '<td>' + esc(owed) + '</td>' +
        '<td style="white-space:nowrap">' + issueCell + '</td></tr>'
    }

    const anyOwed = req.items.some((l) => !l.external && R.lineOutstanding(l) > 0)
    openModal('Prescription — ' + (req.patientName || 'patient'),
      '<div class="tblwrap"><table class="tbl"><tr><th>Medicine</th><th>Dose</th><th>Prescribed</th><th>Issued</th><th>Owed</th><th>Issue now</th></tr>' +
      req.items.map(lineRow).join('') + '</table></div>' +
      '<p class="modal-hint">Issued quantities go straight to stock. An issued medicine can be reversed — the units return to the shelf and the line unlocks for the prescriber.</p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Close</button>' +
      (anyOwed ? '<button class="btn" id="reqDispense">Dispense selected lines →</button>' : '') + '</div>')

    document.querySelectorAll('#modalBody [data-reverse-line]').forEach((b) => {
      b.onclick = async () => {
        const lineId = b.getAttribute('data-reverse-line')
        const line = req.items.find((l) => l.line_id === lineId)
        const issued = R.toQty(line?.dispensed_qty, 0)
        const ok = window.confirm(
          'Reverse ' + issued + ' × ' + (line?.medicine || 'this medicine') + '?\n\n' +
          'The units go back on the shelf and this medicine becomes editable again.')
        if (!ok) return
        b.disabled = true
        try {
          const res = await reverseDispenseIssue({ requestId: req.id, lineId })
          closeModal()
          toast('Reversed ' + res.qty + ' × ' + res.medicine + ' — ' + res.newStock +
            ' now on the shelf · prescription is ' + res.status)
          await load()
        } catch (err) {
          b.disabled = false
          toast('Could not reverse: ' + friendlyWriteError(err))
        }
      }
    })

    const dispenseBtn = document.getElementById('reqDispense')
    if (dispenseBtn) dispenseBtn.onclick = async (e) => {
      const btn = e.currentTarget
      const issued = []
      for (const l of req.items) {
        const owed = R.lineOutstanding(l)
        if (owed === 0) continue
        const box = document.querySelector('#modalBody [data-qty-for="' + l.line_id + '"]')
        if (!box) continue
        const qty = Number(box.value)
        if (!Number.isFinite(qty) || qty <= 0) continue
        if (qty > owed) throw new Error('Cannot issue more than the ' + owed + ' still owed for ' + l.medicine + '.')
        issued.push({ drugId: l.drug_id, requestedQty: qty, lineId: l.line_id, medicine: l.medicine })
      }
      if (!issued.length) { toast('Enter a quantity on at least one line.'); return }
      const unresolved = issued.filter((i) => !i.drugId)
      if (unresolved.length) {
        toast('Not matched to catalogue: ' + unresolved.map((i) => i.medicine).join(', '))
        return
      }
      btn.disabled = true
      try {
        const res = await dispense({
          items: issued.map(({ drugId, requestedQty, lineId }) => ({ drugId, requestedQty, lineId })),
          patientId: req.patientId,
          patientName: req.patientName,
          medicationRequestId: req.id,
        })
        closeModal()
        const p = res.requestProgress
        toast(p && p.outstanding === 0
          ? 'Prescription fully dispensed for ' + req.patientName
          : 'Issued ' + issued.reduce((n, i) => n + i.requestedQty, 0) + ' unit(s) — ' +
            (p ? p.outstanding : '?') + ' still owed')
        await load()
      } catch (err) {
        btn.disabled = false
        toast('Could not dispense: ' + friendlyWriteError(err))
      }
    }
  }

  function renderInventory() {
    const pane = document.getElementById('phpane')
    if (!pane) return
    const rows = drugs.map((d) =>
      '<tr><td><strong>' + esc(d.name) + '</strong><div class="mut">' + esc(d.sku || '') + ' · ' + esc(d.batch || '') + '</div></td>' +
      '<td>' + esc(String(d.stock)) + ' ' + esc(d.unit || 'tabs') + '</td>' +
      '<td>' + esc(d.expiry || '—') + '</td>' +
      '<td>₦' + esc(String(d.price)) + '</td>' +
      '<td>' + statusBadge(d.status) + '</td>' +
      '<td>' + (caps.canManageInventory ? '<button class="btn ghost sm" data-adjust="' + esc(d.id) + '">Adjust</button>' : '') + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><tr><th>Medicine</th><th>Stock</th><th>Expiry</th><th>Price</th><th>Status</th><th></th></tr>' +
      (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No drugs in catalogue</td></tr>') +
      '</table></div>' +
      '<p class="sub" style="margin-top:10px">Prescribe ≠ Dispense — prescriptions queue on the Receive tab for a pharmacist to issue.</p>'
    pane.querySelectorAll('[data-adjust]').forEach((b) => {
      b.onclick = () => openAdjustForm(b.getAttribute('data-adjust'))
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
      '<td class="mut">' + esc(d.by || '—') + '</td>' +
      '<td>' + statusBadge(d.status) + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><tr><th>Ticket</th><th>Patient</th><th>Items</th><th>By</th><th>Status</th></tr>' +
      (rows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No dispense records</td></tr>') +
      '</table></div>'
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
      '<div class="tblwrap"><table class="tbl"><tr><th>Batch</th><th>Medicine</th><th>Qty</th><th>Expiry</th><th>Status</th></tr>' +
      (rows || '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No batch data</td></tr>') +
      '</table></div>'
  }

  // Stock intake against a catalogue item. Backs both the header "Receive batch"
// button and the Receive tab — previously that button rendered for anyone who
// could manage inventory and had no handler at all.
function openReceiveForm() {
    if (!caps.canManageInventory) {
      toast('Your role cannot receive stock. Ask an administrator.')
      return
    }
    if (!drugs.length) {
      toast('Add a catalogue item first — stock is received against an item.')
      return
    }
    const options = drugs.map((d) => ({ value: d.id, label: d.name + ' (on hand: ' + Number(d.stock || 0) + ')' }))
    formModal({
      title: 'Receive batch',
      submitLabel: 'Receive stock →',
      fields: [
        { name: 'drugId', label: 'Medicine', type: 'select', options, searchable: true, searchPlaceholder: 'Type to filter⬦' },
        { name: 'qty', label: 'Quantity received', required: true, placeholder: '100' },
        { name: 'batch', label: 'Batch number', required: true, placeholder: 'B-001' },
        { name: 'expiry', label: 'Expiry (YYYY-MM-DD)', required: true, placeholder: '2027-01-01' },
        { name: 'supplier', label: 'Supplier', placeholder: 'Optional' },
        { name: 'invoice_ref', label: 'Invoice ref', placeholder: 'Optional' },
      ],
      onSubmit: async (v) => {
        const qty = Number(v.qty)
        if (!(qty > 0)) throw new Error('Quantity must be greater than zero.')
        if (!v.batch) throw new Error('Batch number is required.')
        if (!v.expiry) throw new Error('Expiry date is required.')
        const res = await receiveBatch({
          drugId: v.drugId,
          qty,
          batch: v.batch.trim(),
          expiry: v.expiry.trim(),
          supplier: v.supplier.trim(),
          invoice_ref: v.invoice_ref.trim(),
        })
        const drug = drugs.find((d) => d.id === v.drugId)
        closeModal()
        toast('Received ' + qty + ' × ' + (drug?.name || 'item') + ' — on hand now ' + res.newStock)
        await load()
      },
    })
  }

  function openAdjustForm(id) {
    const drug = drugs.find((d) => d.id === id)
    if (!drug) return
    formModal({
      title: 'Adjust stock — ' + drug.name,
      submitLabel: 'Update',
      fields: [
        { name: 'stock', label: 'New stock quantity', required: true, placeholder: String(drug.stock || 0) },
        { name: 'price', label: 'Price ₦', placeholder: String(drug.price || 0) },
        { name: 'batch', label: 'Batch', placeholder: drug.batch || '' },
        { name: 'expiry', label: 'Expiry (YYYY-MM-DD)', placeholder: drug.expiry || '' },
      ],
      onSubmit: async (v) => {
        try {
          await updateDrug(drug.id, {
            name: drug.name,
            drug_code: drug.drug_code,
            strength: drug.strength,
            pack_size: drug.pack_size,
            sku: drug.sku,
            unit: drug.unit,
            stock: Number(v.stock),
            price: v.price !== '' ? Number(v.price) : drug.price,
            batch: v.batch || drug.batch,
            expiry: v.expiry || drug.expiry,
            status: Number(v.stock) === 0 ? 'Out' : (Number(v.stock) < 20 ? 'Low' : 'OK'),
            supplier: drug.supplier,
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Stock adjusted for ' + drug.name)
        await load()
      },
    })
  }

  function openAddDrugForm() {
    // Tracks whether the user has already acknowledged a "similar name"
    // warning. Reset on every field change so a new edit re-triggers the check.
    let similarAcknowledged = false

    // Live name-check state: debounce timer + sequence counter to discard
    // stale Firestore responses when the user keeps typing.
    let nameCheckTimer = null
    let nameCheckSeq = 0

    // Update the hint element under the Drug name input. Uses textContent so
    // drug names can never inject HTML.
    function setHint(cls, msg) {
      const hint = document.querySelector('#fmFields [data-hint="name"]')
      if (!hint) return
      hint.className = 'fldhint' + (cls ? ' ' + cls : '')
      hint.textContent = msg || ''
      hint.hidden = !msg
    }

    // Run the uniqueness check against Firestore. `seq` guards against
    // stale responses — only the latest sequence writes to the DOM.
    async function checkNameLive(name) {
      const seq = ++nameCheckSeq
      const trimmed = (name || '').trim()
      if (trimmed.length < 2) { setHint('', ''); return }

      setHint('', 'Checking⬦')
      try {
        const { exact, similar } = await findDrugNameMatches(activeOrg, trimmed)
        if (seq !== nameCheckSeq) return // stale — user kept typing

        if (exact) {
          setHint('bad', 'Already exists: "' + exact.name + '". Choose a different name.')
        } else if (similar.length > 0) {
          setHint('warn', 'Similar to "' + similar[0].name + '"' + (similar.length > 1 ? ' (and ' + (similar.length - 1) + ' more)' : '') + '— double-check the spelling.')
        } else {
          setHint('ok', 'No match found — this name is free.')
        }
      } catch {
        // Network hiccup: fail quietly. The save-time re-check still guards.
        if (seq !== nameCheckSeq) return
        setHint('', '')
      }
    }

    formModal({
      title: 'Add catalogue item',
      submitLabel: 'Save item →',
      fields: [
        { name: 'name', label: 'Drug name', required: true, full: true, placeholder: 'e.g. Enrofloxacin', hint: true },
        { name: 'drug_code', label: 'Drug code', required: true, placeholder: 'PCM (3–6 chars)' },
        { name: 'strength', label: 'Strength', required: true, placeholder: 'e.g. 500mg' },
        { name: 'pack_size', label: 'Pack size', required: true, placeholder: 'e.g. 10' },
        {
          name: 'sku', label: 'SKU (Stock Keeping Unit)', full: true,
          preview: (v) => generateSku(v.drug_code, v.strength, v.pack_size),
        },
        { name: 'unit', label: 'Unit', type: 'select', options: UNITS },
        { name: 'price', label: 'Price ₦', placeholder: '1800' },
        { name: 'stock', label: 'Opening stock', placeholder: '100' },
        { name: 'batch', label: 'Batch', placeholder: 'B-001' },
        { name: 'expiry', label: 'Expiry (YYYY-MM-DD)', placeholder: '2027-01-01' },
      ],
      onInput: (v) => {
        // Any edit resets the similar-name acknowledgement.
        similarAcknowledged = false

        // Debounced live name check: 600 ms after the last keystroke.
        clearTimeout(nameCheckTimer)
        nameCheckTimer = setTimeout(() => checkNameLive(v.name), 600)
      },
      onSubmit: async (v) => {
        // --- validate required SKU parts ---
        const codeErr = drugCodeError(v.drug_code)
        if (codeErr) throw new Error(codeErr)
        const strErr = strengthError(v.strength)
        if (strErr) throw new Error(strErr)
        const packErr = packSizeError(v.pack_size)
        if (packErr) throw new Error(packErr)

        if (!v.name) throw new Error('Drug name is required.')

        // --- generate SKU ---
        const sku = generateSku(v.drug_code, v.strength, v.pack_size)
        if (!sku) throw new Error('Could not generate SKU. Check drug code, strength, and pack size.')

        // --- name uniqueness check (authoritative — runs regardless of live hint) ---
        const { exact, similar } = await findDrugNameMatches(activeOrg, v.name)

        // Hard reject: 100% identical name (case-insensitive).
        if (exact) {
          throw new Error('A drug with this name already exists: "' + exact.name + '". Choose a different name.')
        }

        // Soft warn: similar name (likely typo). User must click Save again.
        if (similar.length > 0 && !similarAcknowledged) {
          similarAcknowledged = true
          const names = similar.map((d) => '"' + d.name + '"').join(', ')
          throw new Error('Similar drug name(s) found: ' + names + '. If this is intentional, click Save again to proceed.')
        }

        // --- save ---
        try {
          await createDrug({
            name: v.name,
            drug_code: v.drug_code.trim().toUpperCase(),
            strength: v.strength,
            pack_size: v.pack_size,
            sku,
            unit: v.unit || 'tabs',
            price: Number(v.price) || 0,
            stock: Number(v.stock) || 0,
            batch: v.batch,
            expiry: v.expiry,
            status: (Number(v.stock) || 0) === 0 ? 'Out' : ((Number(v.stock) || 0) < 20 ? 'Low' : 'OK'),
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Drug added · SKU ' + sku)
        await load()
      },
    })

    // Immediate check on blur (tab/click away) — don't wait for the debounce.
    const nameInput = document.querySelector('#fmFields [name="name"]')
    if (nameInput) {
      nameInput.onblur = () => {
        clearTimeout(nameCheckTimer)
        checkNameLive(nameInput.value)
      }
    }
  }

  document.getElementById('refreshBtn').onclick = load
  const addBtn = document.getElementById('addDrugBtn')
  if (addBtn) addBtn.onclick = openAddDrugForm
  const receiveBtn = document.getElementById('receiveBtn')
  if (receiveBtn) receiveBtn.onclick = openReceiveForm
  const dispenseBtn = document.getElementById('dispenseBtn')
  if (dispenseBtn) {
    // Dispensing is driven from the queue, so the header button jumps there
      // and opens the only waiting script when there is exactly one.
      dispenseBtn.onclick = () => {
        tab = 'Receive & dispense'
        render()
        if (!medicationRequests.length) toast('No prescriptions waiting to be dispensed.')
        else if (medicationRequests.length === 1) openRequestDetail(medicationRequests[0].id)
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
