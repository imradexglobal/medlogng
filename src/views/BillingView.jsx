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
import { naira, fmtDate, fmtDateTime } from '../utils/format.js'
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
import { staffLabel, currentStaffName } from '../lib/staffName.js'
import { printDocument } from '../lib/print.js'
import { receiptPrintHtml, shiftReconciliationPrintHtml } from '../lib/billingPrint.js'

const TABS = ['Invoices', 'Payments', 'Price catalogue']
const DEFAULT_PAYER = 'Self-pay'

export default async function BillingView(app, params = {}) {
  const { activeOrg, activeOrgName } = authStore.getState()
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

  // Filters state
  let invSearch = ''
  let invStatusFilter = 'all'
  let invPayerFilter = 'all'
  let invDateFilter = 'all'

  let paySearch = ''
  let payMethodFilter = 'all'

  let priceSearch = ''
  let priceCatFilter = 'all'

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

  function reload() {
    invoices = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadPrices()
    loadPayments()
    loadMore().then(subscribeLive).catch((e) => {
      console.warn('[billing] load failed:', e?.message || e)
      toast('Could not load invoices — check your connection')
    })
  }

  function getFilteredInvoices() {
    let list = invoices
    const q = invSearch.trim().toLowerCase()
    if (q) {
      list = list.filter((i) => {
        const idMatch = (i.invoiceId || i.id || '').toLowerCase().includes(q)
        const nameMatch = (i.patientName || '').toLowerCase().includes(q)
        const payerMatch = (i.payer || '').toLowerCase().includes(q)
        return idMatch || nameMatch || payerMatch
      })
    }
    if (invStatusFilter !== 'all') {
      list = list.filter((i) => i.status === invStatusFilter)
    }
    if (invPayerFilter !== 'all') {
      list = list.filter((i) => i.payer === invPayerFilter)
    }
    if (invDateFilter !== 'all') {
      const now = Date.now()
      const dayMs = 24 * 60 * 60 * 1000
      list = list.filter((i) => {
        const t = i.createdAt || 0
        if (invDateFilter === 'today') return (now - t) < dayMs
        if (invDateFilter === 'week') return (now - t) < (7 * dayMs)
        if (invDateFilter === 'month') return (now - t) < (30 * dayMs)
        return true
      })
    }
    return list
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
    const filtered = getFilteredInvoices()

    const uniquePayers = Array.from(new Set(invoices.map((i) => i.payer).filter(Boolean)))

    const toolbarHtml =
      '<div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;background:#f9fafb;padding:10px 12px;border-radius:6px;border:1px solid #e5e7eb">' +
        '<input class="input" id="invSearchInput" placeholder="🔍 Search patient, invoice ID…" value="' + esc(invSearch) + '" style="max-width:240px" />' +
        '<select class="input" id="invStatusSelect" style="max-width:140px">' +
          '<option value="all"' + (invStatusFilter === 'all' ? ' selected' : '') + '>All statuses</option>' +
          '<option value="unpaid"' + (invStatusFilter === 'unpaid' ? ' selected' : '') + '>Unpaid</option>' +
          '<option value="part-paid"' + (invStatusFilter === 'part-paid' ? ' selected' : '') + '>Part-paid</option>' +
          '<option value="paid"' + (invStatusFilter === 'paid' ? ' selected' : '') + '>Paid</option>' +
        '</select>' +
        '<select class="input" id="invPayerSelect" style="max-width:140px">' +
          '<option value="all"' + (invPayerFilter === 'all' ? ' selected' : '') + '>All payers</option>' +
          uniquePayers.map((p) => '<option value="' + esc(p) + '"' + (invPayerFilter === p ? ' selected' : '') + '>' + esc(p) + '</option>').join('') +
        '</select>' +
        '<select class="input" id="invDateSelect" style="max-width:130px">' +
          '<option value="all"' + (invDateFilter === 'all' ? ' selected' : '') + '>All time</option>' +
          '<option value="today"' + (invDateFilter === 'today' ? ' selected' : '') + '>Today</option>' +
          '<option value="week"' + (invDateFilter === 'week' ? ' selected' : '') + '>This week</option>' +
          '<option value="month"' + (invDateFilter === 'month' ? ' selected' : '') + '>This month</option>' +
        '</select>' +
        ((invSearch || invStatusFilter !== 'all' || invPayerFilter !== 'all' || invDateFilter !== 'all')
          ? '<button class="btn ghost sm" id="clearInvFiltersBtn">Reset filters</button>'
          : '') +
        '<span class="mut" style="margin-left:auto;align-self:center;font-size:.85rem">' + filtered.length + ' matching</span>' +
      '</div>'

    const rows = filtered.map((i) => {
      const items = []
      if (i.status !== 'paid' && caps.canPayment) items.push({ label: 'Record payment', dataAction: 'pay' })
      if (canDeleteRecords() && Number(i.paid || 0) === 0) items.push({ label: 'Delete', tone: 'danger', dataAction: 'delete' })
      return '<tr><td><a class="btn ghost sm" href="#/billing/' + esc(i.id) + '"><strong>' + esc(i.invoiceId.slice(0, 8).toUpperCase()) + '</strong></a><div class="mut">' + esc(i.date || '') + '</div></td>' +
        '<td>' + (i.patientId ? '<a href="#/patients/' + encodeURIComponent(i.patientId) + '">' + esc(i.patientName) + '</a>' : esc(i.patientName)) + '</td>' +
        '<td>' + esc(i.payer) + (i.pa_code ? '<div class="mut" style="font-size:.78rem">PA: ' + esc(i.pa_code) + '</div>' : '') + '</td>' +
        '<td><strong>' + esc(naira(i.total)) + '</strong><div class="mut">paid ' + esc(naira(i.paid)) + '</div></td>' +
        '<td>' + statusBadge(i.status) + '</td>' +
        '<td>' + kebabCell({ rowId: i.id, items }) + '</td></tr>'
    }).join('')

    const emptyHtml = caps.canInvoice
      ? '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No matching invoices &middot; <button class="btn" id="invBtnEmpty">+ Create invoice</button></td></tr>'
      : '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No matching invoices</td></tr>'

    pane.innerHTML =
      toolbarHtml +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Patient</th><th>Payer</th><th>Total</th><th>Status</th><th style="width:120px">Actions</th></tr></thead><tbody>' +
      (rows || emptyHtml) + '</tbody></table><div class="loadmore" data-loadmore="1"></div></div>'

    // Wire filter events
    const searchInp = document.getElementById('invSearchInput')
    if (searchInp) {
      searchInp.oninput = (e) => { invSearch = e.target.value; render() }
    }
    const statusSel = document.getElementById('invStatusSelect')
    if (statusSel) {
      statusSel.onchange = (e) => { invStatusFilter = e.target.value; render() }
    }
    const payerSel = document.getElementById('invPayerSelect')
    if (payerSel) {
      payerSel.onchange = (e) => { invPayerFilter = e.target.value; render() }
    }
    const dateSel = document.getElementById('invDateSelect')
    if (dateSel) {
      dateSel.onchange = (e) => { invDateFilter = e.target.value; render() }
    }
    const clearBtn = document.getElementById('clearInvFiltersBtn')
    if (clearBtn) {
      clearBtn.onclick = () => {
        invSearch = ''
        invStatusFilter = 'all'
        invPayerFilter = 'all'
        invDateFilter = 'all'
        render()
      }
    }

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

    let list = payments || []
    const q = paySearch.trim().toLowerCase()
    if (q) {
      list = list.filter((p) => {
        const inv = invoices.find((i) => i.id === p.invoice_id)
        const patName = (p.patient_name || (inv ? inv.patientName : '')).toLowerCase()
        const rec = (p.receipt_number || p.id || '').toLowerCase()
        const invId = (p.invoice_id || '').toLowerCase()
        const ref = (p.reference || '').toLowerCase()
        return patName.includes(q) || rec.includes(q) || invId.includes(q) || ref.includes(q)
      })
    }
    if (payMethodFilter !== 'all') {
      list = list.filter((p) => (p.method || 'Cash').toLowerCase() === payMethodFilter.toLowerCase())
    }

    const toolbarHtml =
      '<div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;background:#f9fafb;padding:10px 12px;border-radius:6px;border:1px solid #e5e7eb">' +
        '<input class="input" id="paySearchInput" placeholder="🔍 Search receipt #, patient, ref…" value="' + esc(paySearch) + '" style="max-width:240px" />' +
        '<select class="input" id="payMethodSelect" style="max-width:140px">' +
          '<option value="all"' + (payMethodFilter === 'all' ? ' selected' : '') + '>All methods</option>' +
          '<option value="Cash"' + (payMethodFilter === 'Cash' ? ' selected' : '') + '>Cash</option>' +
          '<option value="Transfer"' + (payMethodFilter === 'Transfer' ? ' selected' : '') + '>Transfer</option>' +
          '<option value="POS"' + (payMethodFilter === 'POS' ? ' selected' : '') + '>POS</option>' +
          '<option value="NHIA"' + (payMethodFilter === 'NHIA' ? ' selected' : '') + '>NHIA</option>' +
        '</select>' +
        '<button class="btn ghost sm" id="shiftReconBtn" style="margin-left:auto">📊 Daily / Shift reconciliation</button>' +
      '</div>'

    const rows = list.map((p) => {
      const inv = invoices.find((i) => i.id === p.invoice_id)
      const patName = p.patient_name || (inv ? inv.patientName : '—')
      const paidBy = staffLabel(p.paid_by) || '—'
      const paidAt = p.paid_at ? fmtDateTime(p.paid_at) : '—'
      const amountNaira = (Number(p.amount_kobo) || (p.amount_naira ? p.amount_naira * 100 : 0)) / 100
      const recNo = p.receipt_number || ('REC-' + p.id.slice(0, 8).toUpperCase())

      return '<tr>' +
        '<td><strong>' + esc(recNo) + '</strong></td>' +
        '<td>' + (inv ? '<a href="#/billing/' + esc(inv.id) + '">' + esc(inv.invoiceId.slice(0, 8).toUpperCase()) + '</a>' : esc(p.invoice_id.slice(0, 8))) + '</td>' +
        '<td>' + esc(patName) + '</td>' +
        '<td><strong>' + esc(naira(amountNaira)) + '</strong></td>' +
        '<td><span class="pill neutral">' + esc(p.method || 'Cash') + '</span></td>' +
        '<td class="mut">' + esc(p.reference || '—') + '</td>' +
        '<td class="mut">' + esc(paidAt) + '</td>' +
        '<td>' + esc(paidBy) + '</td>' +
        '<td style="white-space:nowrap;gap:4px;display:flex">' +
          '<button class="btn ghost sm" data-print-pay="' + esc(p.id) + '">🖨️ Receipt</button>' +
          (canPay ? '<button class="btn ghost sm" data-edit-pay="' + esc(p.id) + '">Edit</button>' : '') +
        '</td></tr>'
    }).join('')

    pane.innerHTML =
      toolbarHtml +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Receipt #</th><th>Invoice</th><th>Patient</th><th>Amount</th><th>Method</th><th>Ref</th><th>Date</th><th>By</th><th style="width:130px"></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="9" class="mut" style="text-align:center;padding:22px 8px">No payments recorded</td></tr>') + '</tbody></table></div>'

    const searchInp = document.getElementById('paySearchInput')
    if (searchInp) searchInp.oninput = (e) => { paySearch = e.target.value; render() }
    const methSel = document.getElementById('payMethodSelect')
    if (methSel) methSel.onchange = (e) => { payMethodFilter = e.target.value; render() }
    const reconBtn = document.getElementById('shiftReconBtn')
    if (reconBtn) reconBtn.onclick = openShiftReconciliationModal

    pane.querySelectorAll('[data-print-pay]').forEach((b) => {
      b.onclick = () => {
        const payId = b.getAttribute('data-print-pay')
        const p = payments.find((x) => x.id === payId)
        if (!p) return
        const inv = invoices.find((i) => i.id === p.invoice_id) || {}
        printDocument('Receipt-' + (p.receipt_number || payId.slice(0, 8)), receiptPrintHtml({
          hospitalName: activeOrgName || 'Hospital',
          payment: p,
          invoice: inv,
          receivedBy: p.paid_by || currentStaffName(),
        }))
      }
    })
  }

  function renderPriceCatalogue() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const canManage = myPriceCaps().canManage

    let list = prices || []
    const q = priceSearch.trim().toLowerCase()
    if (q) {
      list = list.filter((p) => (p.name || '').toLowerCase().includes(q))
    }
    if (priceCatFilter !== 'all') {
      list = list.filter((p) => (p.category || 'Service').toLowerCase() === priceCatFilter.toLowerCase())
    }

    const toolbarHtml =
      '<div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:12px;background:#f9fafb;padding:10px 12px;border-radius:6px;border:1px solid #e5e7eb">' +
        '<input class="input" id="priceSearchInput" placeholder="🔍 Search service / item…" value="' + esc(priceSearch) + '" style="max-width:240px" />' +
        '<select class="input" id="priceCatSelect" style="max-width:140px">' +
          '<option value="all"' + (priceCatFilter === 'all' ? ' selected' : '') + '>All categories</option>' +
          '<option value="Service"' + (priceCatFilter === 'Service' ? ' selected' : '') + '>Service</option>' +
          '<option value="Consult"' + (priceCatFilter === 'Consult' ? ' selected' : '') + '>Consultation</option>' +
          '<option value="Lab"' + (priceCatFilter === 'Lab' ? ' selected' : '') + '>Laboratory</option>' +
          '<option value="Drug"' + (priceCatFilter === 'Drug' ? ' selected' : '') + '>Drug</option>' +
          '<option value="Bed"' + (priceCatFilter === 'Bed' ? ' selected' : '') + '>Ward bed</option>' +
          '<option value="Other"' + (priceCatFilter === 'Other' ? ' selected' : '') + '>Other</option>' +
        '</select>' +
        (canManage ? '<button class="btn sm" id="addPriceBtn" style="margin-left:auto">+ Add new price</button>' : '') +
      '</div>'

    const rows = list.map((p) => {
      const priceNaira = (Number(p.price_kobo) || 0) / 100
      const isZeroPrice = priceNaira === 0
      return '<tr' + (isZeroPrice ? ' style="background:#fef9c3"' : '') + '><td><strong>' + esc(p.name) + '</strong>' +
        (isZeroPrice ? ' <span class="pill warn" title="This item has a zero price — please update it">₦0 ⚠</span>' : '') +
        '</td><td><span class="pill neutral">' + esc(p.category || 'Service') + '</span></td>' +
        '<td><strong>' + (isZeroPrice ? '<span style="color:#b45309">₦0.00 — set price</span>' : esc(naira(priceNaira))) + '</strong></td>' +
        '<td>' + (canManage
          ? kebabCell({ rowId: p.id, items: [
              { label: 'Edit price', dataAction: 'edit-price' },
              { label: 'Delete', tone: 'danger', dataAction: 'del-price' }
            ] })
          : '—') + '</td></tr>'
    }).join('')

    pane.innerHTML =
      toolbarHtml +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Service / item</th><th>Category</th><th>Price</th><th style="width:100px">Actions</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No prices matching filter.</td></tr>') + '</tbody></table>' +
      (canManage
        ? '<div id="priceForm" class="card" style="margin-top:14px;display:none;background:#f8fafc;border:1px solid #cbd5e1">' +
          '<h4 style="margin:0 0 10px">Set Service Price</h4>' +
          '<div class="fgrid">' +
          '<label>Item name<input class="input" id="priceName" placeholder="e.g. Full Blood Count" /></label>' +
          '<label>Category<select class="input" id="priceCat">' +
          '<option value="Service">Service</option><option value="Consult">Consultation</option>' +
          '<option value="Lab">Laboratory</option><option value="Drug">Drug</option>' +
          '<option value="Bed">Ward bed</option><option value="Other">Other</option>' +
          '</select></label>' +
          '<label>Price (₦)<input class="input" id="priceAmt" type="number" step="0.01" min="0" placeholder="0.00" /></label>' +
          '</div>' +
          '<div class="mrow" style="margin-top:12px">' +
          '<button class="btn ghost" id="cancelPriceBtn">Cancel</button>' +
          '<button class="btn" id="savePriceBtn">Save price</button>' +
          '<input type="hidden" id="priceEditId" /></div></div>' :
          '<p class="sub" style="margin-top:10px">Ask your administrator to set up service prices.</p>')

    const searchInp = document.getElementById('priceSearchInput')
    if (searchInp) searchInp.oninput = (e) => { priceSearch = e.target.value; render() }
    const catSel = document.getElementById('priceCatSelect')
    if (catSel) catSel.onchange = (e) => { priceCatFilter = e.target.value; render() }

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

  // Daily / Shift Cashier Reconciliation Modal
  function openShiftReconciliationModal() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayMs = today.getTime()

    // Filter payments for today
    const todaysPayments = (payments || []).filter((p) => {
      const ms = p.paid_at ? (typeof p.paid_at.toMillis === 'function' ? p.paid_at.toMillis() : p.paid_at) : 0
      return ms >= todayMs
    })

    const byMethod = {}
    let totalCollected = 0
    todaysPayments.forEach((p) => {
      const m = p.method || 'Cash'
      const amt = Number(p.amount_kobo || (p.amount_naira ? p.amount_naira * 100 : 0)) / 100
      if (!byMethod[m]) byMethod[m] = { count: 0, total: 0 }
      byMethod[m].count++
      byMethod[m].total += amt
      totalCollected += amt
    })

    const summary = {
      count: todaysPayments.length,
      total: totalCollected,
      byMethod,
    }

    const summaryRows = Object.entries(byMethod).map(([m, d]) => {
      return '<tr><td><strong>' + esc(m) + '</strong></td>' +
        '<td style="text-align:center">' + d.count + '</td>' +
        '<td style="text-align:right"><strong>' + esc(naira(d.total)) + '</strong></td></tr>'
    }).join('')

    const modalBody =
      '<div class="card" style="margin-bottom:12px;background:#f8fafc">' +
        '<div class="grid2x">' +
          '<div><em>Date</em><strong>' + esc(fmtDate(Date.now())) + '</strong></div>' +
          '<div><em>Cashier</em><strong>' + esc(currentStaffName()) + '</strong></div>' +
          '<div><em>Transactions</em><strong>' + summary.count + ' receipts</strong></div>' +
          '<div><em>Total Collected</em><strong style="color:#047857;font-size:1.15rem">' + esc(naira(totalCollected)) + '</strong></div>' +
        '</div>' +
      '</div>' +
      '<table class="tbl" style="margin-bottom:14px"><thead><tr><th>Channel</th><th style="text-align:center">Txn Count</th><th style="text-align:right">Amount</th></tr></thead><tbody>' +
      (summaryRows || '<tr><td colspan="3" class="mut" style="text-align:center">No payments logged today yet.</td></tr>') +
      '</tbody></table>' +
      '<div class="mrow" style="justify-content:flex-end">' +
        '<button class="btn ghost" data-close>Close</button>' +
        '<button class="btn" id="printReconReportBtn">🖨️ Print Shift Handover Report</button>' +
      '</div>'

    openModal('Daily Cashier Shift Reconciliation', modalBody)

    const printBtn = document.getElementById('printReconReportBtn')
    if (printBtn) {
      printBtn.onclick = () => {
        printDocument('Shift-Reconciliation-' + fmtDate(Date.now()), shiftReconciliationPrintHtml({
          hospitalName: activeOrgName || 'Hospital',
          cashierName: currentStaffName(),
          dateStr: fmtDate(Date.now()),
          summary,
          payments: todaysPayments,
        }))
      }
    }
  }

  // Invoice creation modal
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

    // ---- invoice line items ----
    let lines = [{ item: itemOpts[0] || '', qty: 1, priceKobo: itemOpts[0] ? priceFor(prices, itemOpts[0]) : 0 }]

    function lineHtml(i) {
      const priceMatch = prices.find((p) => p.name === lines[i].item)
      const defaultPrice = (priceMatch ? priceMatch.price_kobo : lines[i].priceKobo)
      const itemOptions = itemOpts.map((it) =>
        '<option value="' + esc(it) + '"' + (it === lines[i].item ? ' selected' : '') + '>' + esc(it) + '</option>').join('')
      return '<tr data-line="' + i + '">' +
        '<td><select class="input" data-field="item" style="width:100%">' +
        '<option value="">— type custom item —</option>' + itemOptions +
        '</select><input class="input" data-field="item-text" type="text" placeholder="custom service or item…" style="width:100%;margin-top:4px;' + (!itemOpts.length || lines[i].item === '' ? '' : 'display:none') + '" /></td>' +
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
          if (s.value === '') { lines[i].item = ''; txt.style.display = ''; txt.focus() }
          else {
            txt.style.display = 'none'
            lines[i].item = s.value
            lines[i].priceKobo = priceFor(prices, s.value)
          }
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
      '<input class="input" id="invPatientFilter" placeholder="Search patient by name, MRN or mobile…" autocomplete="off" style="margin-bottom:6px">' +
      '<select class="input" id="invPatientSel"><option value="">— Select patient —</option>' +
      patientOpts.map((o) => '<option value="' + esc(o.value) + '" data-label="' + esc(o.label) + '"' + (o.value === (pre ? pre.pid : '') ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select></label>' +
      '<label>Payer<select class="input" id="invPayer">' +
      payerOpts.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === ((pre && pre.payer) || DEFAULT_PAYER) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
      '</select></label>' +
      '<label id="paCodeWrapper">Pre-authorization (PA) code<input class="input" id="invPaCode" placeholder="Required for HMO/NHIA claims…" /></label>' +
      '</div>' +
      '<div class="tblwrap" style="margin:10px 0"><table class="tbl"><thead><tr><th>Item / service</th><th>Qty</th><th>Unit price (₦)</th><th></th></tr></thead>' +
      '<tbody id="invLines"></tbody></table></div>' +
      '<div class="mrow" style="margin-top:8px;justify-content:space-between;align-items:center">' +
      '<button class="btn ghost sm" id="invAddLine">+ Add line</button>' +
      '<div style="text-align:right"><span class="mut">Total: </span><strong id="invTotal" style="font-size:1.15rem">₦0</strong></div>' +
      '</div>'

    openModal(fromConsult && pre ? 'New invoice — ' + pre.name : 'New invoice',
      modalHtml +
      '<div class="mrow" style="margin-top:14px"><button class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn" id="invSave">Create invoice →</button></div>')

    renderLines()
    const totalEl = document.getElementById('invTotal')
    function updateTotal() {
      const tKobo = lines.reduce((sum, l) => sum + (Number(l.priceKobo || 0) * Number(l.qty || 1)), 0)
      if (totalEl) totalEl.textContent = naira(tKobo / 100)
    }
    updateTotal()
    const origRenderLines = renderLines
    renderLines = () => { origRenderLines(); updateTotal() }

    const addLineBtn = document.getElementById('invAddLine')
    if (addLineBtn) {
      addLineBtn.onclick = () => {
        lines.push({ item: itemOpts[0] || '', qty: 1, priceKobo: itemOpts[0] ? priceFor(prices, itemOpts[0]) : 0 })
        renderLines()
      }
    }

    wireSearchableSelect(document.getElementById('invPatientFilter'), document.getElementById('invPatientSel'))

    document.getElementById('invSave').onclick = async () => {
      const payer = document.getElementById('invPayer').value || DEFAULT_PAYER
      const paCode = document.getElementById('invPaCode')?.value?.trim() || ''
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
          pa_code: paCode,
          source_type: 'manual',
          source_id: '',
          lines: validLines.map((l) => {
            const priceMatch = prices.find((p) => p.name === l.item)
            return {
              label: l.item,
              category: priceMatch?.category || 'Service',
              unit_price_kobo: Math.round(Number(l.priceKobo) || 0),
              qty: Math.max(1, Math.round(Number(l.qty) || 1)),
            }
          }),
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
            reference: result.reference || '',
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
        reference: pay.reference || '',
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
      if (!Number.isFinite(amt) || amt <= 0) { toast('Price must be greater than ₦0. Enter the actual amount charged.'); return }
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

  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
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

  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    subscribeLive()
  })

  await loadMore()
  subscribeLive()
}
