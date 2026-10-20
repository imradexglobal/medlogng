// Billing with Firestore persistence (offline-first, cached).
// CRITICAL: charge/discount math lives in billingService and is preserved.
import { shell, statusBadge, toast, closeModal, openModal, wireToast, wireSearchableSelect } from '../components/shell.js'
import { openPaymentModal } from '../components/PaymentModal.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgInvoicesPage, subscribeOrgInvoices, createInvoice, createInvoiceFromLines, recordPayment, updatePayment, listOrgPayments, myBillingCaps,
} from '../services/billingService.js'
import { listOrgPatientsAll, listOrgPatients, formatPhone, searchPatientsGlobally } from '../services/patientService.js'
import { payerOptions } from '../services/payerService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { naira } from '../utils/format.js'
import { esc } from '../utils/sanitize.js'
import { navigate } from '../router.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteInvoice } from '../services/deleteService.js'
import {
  listPrices, savePrice, deletePrice, catalogueItems, lineText, priceFor, myPriceCaps,
} from '../services/priceCatalogueService.js'
import { billingSummary } from '../services/billingSummary.js'
import { staffLabel } from '../lib/staffName.js'

const TABS = ['Invoices', 'Payments', 'Price catalogue']
const DEFAULT_PAYER = 'Self-pay'

// Billing is reachable with context from other screens:
//   #/billing?patient=<pid>&new=1&from=enc
// `patient` pre-selects the invoice patient (and their saved payer), `new=1`
// opens the New invoice form immediately, `from=enc` offers a way back to the
// encounter the charge came from.
export default async function BillingView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myBillingCaps()
  const presetPid = String(params.patient || '')
  const autoOpen = params.new === '1' || params.new === 'true'
  const fromEncounter = params.from === 'enc'

  if (!activeOrg) {
    shell(app, {
      active: '/billing',
      title: 'Billing',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let invoices = []
  let patients = []
  let prices = []
  let payments = []
  let payerOpts = []
  let tab = 'Invoices'
  let openedPreset = false
  let unsubs = []
  let watchedOrg = activeOrg
  // Infinite scroll: rows accumulate and `cursor` marks the end of what we hold.
  let cursor = null
  let hasMore = false
  let loading = false

  shell(app, {
    active: '/billing',
    title: 'Billing',
    subtitle: 'Invoices · payments in exact ₦ (kobo-safe)',
    actions:
      (fromEncounter ? '<a class="btn ghost" href="#/consultations' + (params.enc ? '?enc=' + encodeURIComponent(params.enc) : '') + '">← Back to encounter</a>' : '') +
      '<button class="btn ghost" id="refreshBtn" aria-label="Refresh billing list">↻ Refresh</button>' +
      (caps.canInvoice ? '<button class="btn" id="invBtn" aria-label="Create a new invoice">+ New invoice</button>' : ''),
    body:
      '<div class="grid4"><div class="stat"><em>Billed</em><strong id="bill-billed">₦0</strong><span id="bill-count">0 invoices</span></div>' +
      '<div class="stat"><em>Collected</em><strong id="bill-collected">₦0</strong><span id="bill-rate">collection rate 0%</span></div>' +
      '<div class="stat"><em>Outstanding</em><strong id="bill-outstanding">₦0</strong><span>open invoices</span></div>' +
      '<div class="stat"><em>Open</em><strong id="bill-open">0</strong><span>unpaid / part-paid</span></div></div>' +
      '<div class="tabs" id="bt">' + TABS.map((t, i) => '<button data-t="' + esc(t) + '" class="' + (i === 0 ? 'on' : '') + '">' + esc(t) + '</button>').join('') + '</div><div class="card" id="bpane"></div>',
  })

  const more = createLoadMore(loadMore)

  async function loadPrices() {
    try { prices = await listPrices(activeOrg).catch(() => []) } catch { prices = [] }
  }
  loadPrices()

  async function loadPayments() {
    try { payments = await listOrgPayments(activeOrg).catch(() => []) } catch { payments = [] }
  }
  loadPayments()

  // Append the next chunk of invoices. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && invoices.length === 0
    loading = true
    more.setLoading(true)
    document.querySelector('#bpane .tblwrap')?.classList.add('is-loading')
    try {
      const [pg, pats, payers] = await Promise.all([
        listOrgInvoicesPage(activeOrg, { cursor }),
        first ? listOrgPatientsAll(activeOrg).catch(() => []) : Promise.resolve(patients),
        first ? payerOptions().catch(() => []) : Promise.resolve([]),
      ])
      // A row written between two chunk reads shifts the cursor stream and can
      // repeat the boundary document.
      const seen = new Set(invoices.map((i) => i.id))
      invoices = first ? pg.rows : [...invoices, ...pg.rows.filter((i) => !seen.has(i.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) {
        patients = pats
        payerOpts = payers.length ? payers : [{ value: DEFAULT_PAYER, label: DEFAULT_PAYER }]
      }
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
      // The pre-selected patient only exists after the list resolves, so the
      // form is opened here rather than before the first paint.
      if (autoOpen && !openedPreset) {
        openedPreset = true
        if (!caps.canInvoice) {
          toast('Your role cannot create invoices — a billing officer must raise this charge.')
        } else {
          openInvoiceForm(presetPid)
        }
      }
    } catch (e) {
      console.error('[billing] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) toast('Could not load billing data: ' + friendlyWriteError(e))
      else more.setError('Could not load more — retry')
    } finally {
      document.querySelector('#bpane .tblwrap')?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole list.
  function reload() {
    invoices = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive)
  }

  function render() {
    const s = billingSummary(invoices)
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
    set('bill-billed', naira(s.billed))
    set('bill-count', s.count + (s.count === 1 ? ' invoice' : ' invoices'))
    set('bill-collected', naira(s.collected))
    set('bill-rate', 'collection rate ' + s.rate + '%')
    set('bill-outstanding', naira(s.outstanding))
    set('bill-open', String(s.open))
    document.querySelectorAll('#bt button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-t') === tab)
    })
    if (tab === 'Payments') renderPayments()
    else if (tab === 'Price catalogue') renderPriceCatalogue()
    else renderInvoices()
  }

  function renderInvoices() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const rows = invoices.map((i) => {
      const items = []
      if (i.status !== 'paid' && caps.canPayment) items.push({ label: 'Record payment', dataAction: 'pay' })
      if (canDeleteRecords()) items.push({ label: 'Delete', tone: 'danger', dataAction: 'delete' })
      return '<tr><td><a class="btn ghost sm" href="#/billing/' + esc(i.id) + '"><strong>' + esc(i.invoiceId.slice(0, 8)) + '</strong></a><div class="mut">' + esc(i.date || '') + '</div></td>' +
        '<td>' + esc(i.patientName) + '</td><td>' + esc(i.payer) + '</td>' +
        '<td><strong>' + esc(naira(i.total)) + '</strong><div class="mut">paid ' + esc(naira(i.paid)) + '</div></td>' +
        '<td>' + statusBadge(i.status) + '</td>' +
        '<td>' + kebabCell({ rowId: i.id, items }) + '</td></tr>'
    }).join('')
    const emptyHtml = caps.canInvoice
  ? '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No invoices yet &middot; <button class="btn" id="invBtnEmpty">+ Create first invoice</button></td></tr>'
  : '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No invoices yet</td></tr>';
    const rowsHtml = rows || emptyHtml;
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Patient</th><th>Payer</th><th>Total</th><th>Status</th><th style="width:120px">Actions</th></tr></thead><tbody>' +
      rowsHtml + '</tbody></table><div class="loadmore" data-loadmore="1"></div></div>'
    wireKebabs(pane, async (rowId, action) => {
      const inv = invoices.find((i) => i.id === rowId)
      if (!inv) return
      if (action === 'pay') {
        openPaymentForm(rowId)
        return
      }
      if (action === 'delete') {
        confirmDelete('invoice ' + (inv.invoiceId || ''), () => deleteInvoice(rowId), reload)
      }
    })
    more.mount(pane.querySelector('.tblwrap'))
    const invBtnEmpty = document.getElementById('invBtnEmpty')
    if (invBtnEmpty) invBtnEmpty.onclick = () => openInvoiceForm()
  }

  function renderPayments() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const canPay = myBillingCaps().canPayment
    const rows = (payments || []).map((p) => {
      const inv = invoices.find((i) => i.id === p.invoice_id)
      const paidBy = staffLabel(p.paid_by) || '—'
      const paidAt = p.paid_at ? new Date(typeof p.paid_at.toMillis === 'function' ? p.paid_at.toMillis() : p.paid_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' }) : '—'
      return '<tr><td>' + (inv ? '<strong>' + esc(inv.invoiceId.slice(0, 8)) + '</strong>' : esc(p.invoice_id.slice(0, 8))) + '</td>' +
        '<td>' + esc(inv ? inv.patientName : '—') + '</td>' +
        '<td>' + esc(naira(p.amount_kobo || 0)) + '</td>' +
        '<td>' + esc(p.method || 'Cash') + '</td>' +
        '<td class="mut">' + esc(paidAt) + '</td>' +
        '<td>' + esc(paidBy) + '</td>' +
        '<td style="white-space:nowrap">' + (canPay ? '<button class="btn ghost sm" data-edit-pay="' + esc(p.id) + '">Edit</button>' : '—') + '</td></tr>'
    }).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Patient</th><th>Amount</th><th>Method</th><th>Date</th><th>By</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">No payments recorded</td></tr>') + '</tbody></table></div>'
  }

  function renderPriceCatalogue() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const canManage = myPriceCaps().canManage
    const rows = (prices || []).map((p) =>
      '<tr><td><strong>' + esc(p.name) + '</strong></td><td>' + esc(p.category || 'Service') + '</td>' +
      '<td>' + esc(naira(p.price_kobo || 0)) + '</td>' +
      '<td>' + (canManage
        ? kebabCell({ rowId: p.id, items: [
            { label: 'Edit', dataAction: 'edit-price' },
            { label: 'Delete', tone: 'danger', dataAction: 'del-price' }
          ] })
        : '—') + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Service / item</th><th>Category</th><th>Price</th><th style="width:100px">Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No prices set yet. Add your first item below.</td></tr>') + '</tbody></table>' +
      (canManage
        ? '<div class="mrow" style="margin-top:12px"><button class="btn ghost" id="addPriceBtn">+ Add price</button></div>' +
          '<div id="priceForm" class="card" style="margin-top:10px;display:none">' +
          '<div class="fgrid">' +
          '<label>Item name<input class="input" id="priceName" /></label>' +
          '<label>Category<select class="input" id="priceCat">' +
          '<option value="Service">Service</option><option value="Consult">Consultation</option>' +
          '<option value="Lab">Laboratory</option><option value="Drug">Drug</option>' +
          '<option value="Bed">Ward bed</option><option value="Other">Other</option>' +
          '</select></label>' +
          '<label>Price (₦)<input class="input" id="priceAmt" type="number" step="0.01" min="0" /></label>' +
          '</div>' +
          '<div class="mrow" style="margin-top:10px">' +
          '<button class="btn ghost" id="cancelPriceBtn">Cancel</button>' +
          '<button class="btn" id="savePriceBtn">Save price</button>' +
          '<input type="hidden" id="priceEditId" /></div></div>' :
          '<p class="sub" style="margin-top:10px">Ask your administrator to set up service prices.</p>')
    wireKebabs(pane, async (rowId, action) => {
      const p = prices.find((x) => x.id === rowId)
      if (!p) return
      if (action === 'edit-price') {
        document.getElementById('priceEditId').value = p.id
        document.getElementById('priceName').value = p.name
        document.getElementById('priceCat').value = p.category || 'Service'
        document.getElementById('priceAmt').value = (p.price_kobo || 0) / 100
        document.getElementById('priceForm').style.display = ''
        return
      }
      if (action === 'del-price') {
        if (!window.confirm('Delete this price?')) return
        try {
          await deletePrice(rowId)
          prices = await listPrices(activeOrg).catch(() => [])
          renderPriceCatalogue()
          toast('Price deleted')
        } catch (e) { toast(friendlyWriteError(e)) }
      }
    })
  }

  // `presetPid` comes from #/billing?patient=… — used by the consultation
  // "Bill item" flow so the cashier does not re-pick the patient.
  async function openInvoiceForm(presetPid = '') {
    let patientList = patients
    let preSelectedPatient = null

    if (presetPid) {
      try {
        preSelectedPatient = patients.find((p) => p.pid === presetPid)
        if (!preSelectedPatient) {
          const { local, cloud } = await searchPatientsGlobally(presetPid)
          const found = [...local, ...cloud].find((p) => p.pid === presetPid)
          if (found) {
            preSelectedPatient = found
            if (!patients.some((p) => p.pid === found.pid)) {
              patientList = [...patients, found]
            } else {
              patientList = patients
            }
          }
        }
      } catch (e) {
        console.warn('[billing] failed to locate preset patient:', e?.message)
      }
    }

    if (!patientList.length && !preSelectedPatient) {
      toast('No patients registered yet — register a patient first.')
      return
    }

    const baseList = preSelectedPatient && !patientList.some((p) => p.pid === preSelectedPatient.pid)
      ? [...patientList, preSelectedPatient]
      : patientList
    const itemOpts = catalogueItems(prices)
    const pid = presetPid && baseList.some((p) => p.pid === presetPid) ? presetPid : ''
    const pre = baseList.find((p) => p.pid === pid)
    const fromConsult = !!presetPid || fromEncounter
    const selectedPatient = pre || null
    const patientOpts = baseList.map((p) => ({
      value: p.pid,
      label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
    }))

    // ---- invoice line items (each line: item, qty, adjustable unit price) ----
    let lines = [{ item: itemOpts[0] || '', qty: 1, priceKobo: itemOpts[0] ? priceFor(prices, itemOpts[0]) : 0 }]

    function lineHtml(i) {
      const priceMatch = prices.find((p) => p.name === lines[i].item)
      const defaultPrice = (priceMatch ? priceMatch.price_kobo : lines[i].priceKobo)
      const itemOptions = itemOpts.map((it) =>
        '<option value="' + esc(it) + '"' + (it === lines[i].item ? ' selected' : '') + '>' + esc(it) + '</option>').join('')
      return '<tr data-line="' + i + '">' +
        '<td><select class="input" data-field="item" style="width:100%">' +
        '<option value="">— type item —</option>' + itemOptions +
        '</select><input class="input" data-field="item-text" type="text" placeholder="custom item…" style="width:100%;margin-top:4px;' + (!itemOpts.length || lines[i].item === '' ? '' : 'display:none') + '" /></td>' +
        '<td><input class="input" data-field="qty" type="number" min="1" value="' + esc(lines[i].qty) + '" style="width:70px" /></td>' +
        '<td><input class="input" data-field="price" type="number" step="0.01" min="0" value="' + esc((defaultPrice / 100).toFixed(2)) + '" style="width:110px" /></td>' +
        '<td style="white-space:nowrap">' + (lines.length > 1
          ? '<button class="btn ghost sm" data-rem-line="' + i + '" style="color:#b91c1c">✕</button>'
          : '<span class="mut">—</span>') + '</td>' +
        '</tr>'
    }

    function renderLines() {
      const el = document.getElementById('invLines')
      if (!el) return
      el.innerHTML = lines.map((_, i) => lineHtml(i)).join('')
      el.querySelectorAll('select[data-field="item"]').forEach((s, i) => {
        s.onchange = () => {
          const td = s.parentElement
          const txt = td.querySelector('input[data-field="item-text"]')
          if (s.value === '') { lines[i].item = ''; txt.style.display = ''; txt.focus() } else { txt.style.display = 'none'; lines[i].item = s.value }
          renderLines()
        }
      })
      el.querySelectorAll('input[data-field="item-text"]').forEach((s, i) => {
        s.onchange = () => { lines[i].item = s.value.trim(); renderLines() }
        s.oninput = () => { lines[i].item = s.value.trim(); updateTotal() }
      })
      el.querySelectorAll('input[data-field="qty"]').forEach((s, i) => {
        s.onchange = () => { lines[i].qty = Math.max(1, Number(s.value) || 1); renderLines() }
      })
      el.querySelectorAll('input[data-field="price"]').forEach((s, i) => {
        s.onchange = () => { lines[i].priceKobo = Math.round(Number(s.value) * 100) || 0; renderLines() }
      })
      el.querySelectorAll('[data-rem-line]').forEach((b) => {
        b.onclick = () => { const n = Number(b.getAttribute('data-rem-line')); lines.splice(n, 1); if (!lines.length) lines.push({ item: '', qty: 1, priceKobo: 0 }); renderLines() }
      })
    }

    const modalHtml =
      '<div class="fgrid">' +
      '<label class="fld full"><span>Patient</span>' +
      '<input class="input" id="invPatientFilter" placeholder="Search patient by name, ID or mobile…" autocomplete="off" style="margin-bottom:6px">' +
      '<select class="input" id="invPatientSel"><option value="">— Select patient —</option>' +
      patientOpts.map((o) => '<option value="' + esc(o.value) + '" data-label="' + esc(o.label) + '"' + (o.value === (pre ? pre.pid : '') ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select></label>' +
      '<label>Payer<select class="input" id="invPayer">' +
      payerOpts.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === ((pre && pre.payer) || DEFAULT_PAYER) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select></label>' +
      '</div>' +
      '<div class="tblwrap" style="margin:10px 0"><table class="tbl"><thead><tr><th>Item / service</th><th>Qty</th><th>Unit price (₦)</th><th></th></tr></thead>' +
      '<tbody id="invLines"></tbody></table></div>' +
      '<div class="mrow" style="margin-top:8px"><button class="btn ghost" id="invAddLine">+ Add line</button>' +
      '<span class="mut">Total: <strong id="invTotal">₦0</strong></span></div>'

    openModal(fromConsult && pre ? 'New invoice — ' + pre.name : 'New invoice',
      modalHtml +
      '<div class="mrow" style="margin-top:14px"><button class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn" id="invSave">Create invoice →</button></div>')

    renderLines()
    const totalEl = document.getElementById('invTotal')
    function updateTotal() {
      const t = lines.reduce((sum, l) => sum + (Number(l.priceKobo || 0) * Number(l.qty || 1)), 0)
      if (totalEl) totalEl.textContent = naira(t)
    }
    updateTotal()
    // Recompute total whenever a line changes — wrap renderLines to also update total
    const origRenderLines = renderLines
    renderLines = () => { origRenderLines(); updateTotal() }

    // Wire buttons AFTER openModal() has inserted the HTML into the DOM.
    const addLineBtn = document.getElementById('invAddLine')
    if (addLineBtn) {
      addLineBtn.onclick = () => {
        lines.push({ item: itemOpts[0] || '', qty: 1, priceKobo: itemOpts[0] ? priceFor(prices, itemOpts[0]) : 0 })
        renderLines()
      }
    }

    // Patient searchable select (same filter-box + <select> pattern as the
    // consultation "Start encounter" modal — no floating dropdown to cover
    // the input). Selection is read from the select at save time.
    wireSearchableSelect(document.getElementById('invPatientFilter'), document.getElementById('invPatientSel'))

    document.getElementById('invSave').onclick = async () => {
      const payer = document.getElementById('invPayer').value || DEFAULT_PAYER
      const chosenPid = document.getElementById('invPatientSel').value
      const chosen = baseList.find((p) => p.pid === chosenPid) || (chosenPid && chosenPid === (selectedPatient && selectedPatient.pid) ? selectedPatient : null)
      if (!chosen) { toast('Select a patient.'); return }
      const patientId = chosen.pid
      const patientName = chosen.name
      const validLines = lines.filter((l) => l.item && l.item.trim())
      if (!validLines.length) { toast('Add at least one item.'); return }
      for (const l of validLines) {
        if (!Number.isFinite(Number(l.qty)) || Number(l.qty) < 1) { toast('Invalid quantity for ' + l.item); return }
        if (!Number.isFinite(Number(l.priceKobo)) || Number(l.priceKobo) < 0) { toast('Invalid price for ' + l.item); return }
      }
      try {
        await createInvoiceFromLines({
          patient_id: patientId,
          patient_name: patientName,
          payer: payer,
          source_type: 'manual',
          source_id: '',
          lines: validLines.map((l) => ({
            label: l.item,
            category: 'Service',
            unit_price_kobo: Math.round(Number(l.priceKobo) || 0),
            qty: Math.max(1, Math.round(Number(l.qty) || 1)),
          })),
        })
        closeModal()
        toast('Invoice created')
        reload()
      } catch (e) {
        throw new Error(friendlyWriteError(e))
      }
    }
  }

  function openPaymentForm(invoiceId) {
    const inv = invoices.find((i) => i.id === invoiceId)
    if (!inv) return
    openPaymentModal({
      invoice: inv,
      onSuccess: () => reload(),
    })
  }

  async function editPayment(paymentId) {
    const pay = payments.find((p) => p.id === paymentId)
    if (!pay) return
    const inv = invoices.find((i) => i.id === pay.invoice_id)
    const currentAmount = Number(pay.amount_kobo || 0) / 100
    openPaymentModal({
      invoice: inv || { id: pay.invoice_id, patientName: '—', outstanding: 0, total: 0, paid: 0 },
      onSuccess: async (result) => {
        try {
          await updatePayment(paymentId, {
            amount_kobo: result.amount_kobo,
            method: result.method || 'Cash',
            notes: result.notes || '',
          })
          toast('Payment updated')
          reload()
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
      },
      editing: true,
      existing: {
        amount: currentAmount,
        method: pay.method || 'Cash',
        notes: pay.notes || '',
      },
    })
  }

  document.querySelectorAll('#bt button').forEach((b) => {
    b.onclick = () => { tab = b.getAttribute('data-t'); render() }
  })
  document.getElementById('refreshBtn').onclick = reload
  const invBtn = document.getElementById('invBtn')
  if (invBtn) invBtn.onclick = () => { openInvoiceForm() }

  document.getElementById('bpane').addEventListener('click', async (e) => {
    const add = e.target.closest('#addPriceBtn')
    if (add) {
      document.getElementById('priceEditId').value = ''
      document.getElementById('priceName').value = ''
      document.getElementById('priceCat').value = 'Service'
      document.getElementById('priceAmt').value = ''
      document.getElementById('priceForm').style.display = ''
      return
    }
    const cancel = e.target.closest('#cancelPriceBtn')
    if (cancel) { document.getElementById('priceForm').style.display = 'none'; return }
    const save = e.target.closest('#savePriceBtn')
    if (save) {
      const id = document.getElementById('priceEditId').value.trim()
      const name = document.getElementById('priceName').value.trim()
      const cat = document.getElementById('priceCat').value
      const amt = Number(document.getElementById('priceAmt').value)
      if (!name) { toast('Item name is required.'); return }
      if (!Number.isFinite(amt) || amt < 0) { toast('Enter a valid price.'); return }
      try {
        if (id) await savePrice(activeOrg, { id, name, category: cat, priceKobo: Math.round(amt * 100) })
        else await savePrice(activeOrg, { name, category: cat, priceKobo: Math.round(amt * 100) })
        document.getElementById('priceForm').style.display = 'none'
        prices = await listPrices(activeOrg).catch(() => [])
        renderPriceCatalogue()
        toast('Price saved')
      } catch (e) { toast(friendlyWriteError(e)) }
      return
    }
    const editPay = e.target.closest('[data-edit-pay]')
    if (editPay) {
      const id = editPay.getAttribute('data-edit-pay')
      try { await editPayment(id) } catch (e) { toast(friendlyWriteError(e)) }
    }
  })

  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  // Live updates for invoices/payments. The patient picker stays one-shot
  // (registry is never live); a brand-new patient may only appear after reload.
  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    // The live feed only ever knows about the newest slice of the ledger. Once
    // the user has scrolled past it, leave the accumulated list alone rather
    // than truncating it back to one chunk.
    if (cursor != null) return
    unsubs.push(
      subscribeOrgInvoices(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(invoices.map((i) => i.id))
          invoices = rows.filter((i) => !seen.has(i.id)).concat(invoices)
          render()
        },
        (e) => {
          console.warn('[billing] live update failed; refreshing once:', e?.message || e)
          listOrgInvoicesPage(watchedOrg)
            .then((r) => { invoices = r.rows; render() })
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

  await loadMore()
  subscribeLive()
}