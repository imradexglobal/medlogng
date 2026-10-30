// Invoice detail — real Firestore reads/writes (offline-first, cached).
import { shell, statusBadge, toast, wireToast } from '../components/shell.js'
import { openPaymentModal } from '../components/PaymentModal.js'
import { getInvoice, listInvoicePayments, myBillingCaps } from '../services/billingService.js'
import { esc } from '../utils/sanitize.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteInvoice } from '../services/deleteService.js'
import { naira, fmtDate, fmtDateTime } from '../utils/format.js'
import { authStore } from '../store/authStore.js'
import { printDocument } from '../lib/print.js'
import { invoicePrintHtml, receiptPrintHtml } from '../lib/billingPrint.js'
import { currentStaffName } from '../lib/staffName.js'

export async function InvoiceDetailView(app, params = {}) {
  const caps = myBillingCaps()
  let inv = null
  let payments = []

  try {
    inv = await getInvoice(params.id)
    if (inv) {
      payments = await listInvoicePayments(inv.id).catch(() => [])
    }
  } catch (e) {
    inv = null
  }

  if (!inv) {
    shell(app, {
      active: '/billing',
      title: 'Invoice not found',
      subtitle: 'No invoice matches ' + esc(params.id || 'that ID'),
      actions: '<a class="btn" href="#/billing">← All invoices</a>',
      body: '<div class="card"><p class="sub">This invoice does not exist or has not been created yet.</p></div>',
    })
    return
  }

  const orgName = authStore.getState().activeOrgName || 'Hospital'
  const lines = (inv.raw && Array.isArray(inv.raw.lines) && inv.raw.lines.length)
    ? inv.raw.lines
    : []

  // Build line items table HTML
  let linesTableHtml = ''
  if (lines.length > 0) {
    linesTableHtml =
      '<div class="tblwrap"><table class="tbl"><thead><tr>' +
      '<th style="width:36px">#</th><th>Item / Service</th><th>Category</th>' +
      '<th style="width:60px;text-align:center">Qty</th>' +
      '<th style="width:110px;text-align:right">Unit price</th>' +
      '<th style="width:120px;text-align:right">Total</th></tr></thead><tbody>' +
      lines.map((l, idx) => {
        const unit = (Number(l.unit_price_kobo) || 0) / 100
        const qty = Number(l.qty) || 1
        return '<tr>' +
          '<td>' + (idx + 1) + '</td>' +
          '<td><strong>' + esc(l.label || l.item || 'Item') + '</strong></td>' +
          '<td>' + esc(l.category || 'Service') + '</td>' +
          '<td style="text-align:center">' + qty + '</td>' +
          '<td style="text-align:right">' + esc(naira(unit)) + '</td>' +
          '<td style="text-align:right"><strong>' + esc(naira(unit * qty)) + '</strong></td></tr>'
      }).join('') +
      '</tbody></table></div>'
  } else {
    linesTableHtml =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Item description</th><th style="width:130px;text-align:right">Total</th></tr></thead><tbody>' +
      '<tr><td>' + esc(typeof inv.items === 'string' ? inv.items : JSON.stringify(inv.items)) + '</td><td style="text-align:right"><strong>' + esc(naira(inv.total)) + '</strong></td></tr>' +
      '</tbody></table></div>'
  }

  // Build payment history table HTML
  let paymentsTableHtml = ''
  if (payments.length > 0) {
    paymentsTableHtml =
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Receipt #</th><th>Date</th><th>Method</th><th>Ref</th><th>Cashier</th><th style="text-align:right">Amount</th><th style="width:80px"></th></tr></thead><tbody>' +
      payments.map((p) => {
        const amt = Number(p.amount_kobo || (p.amount_naira ? p.amount_naira * 100 : 0)) / 100
        const dateStr = p.paid_at ? fmtDateTime(p.paid_at) : '—'
        const recNo = p.receipt_number || p.id.slice(0, 8).toUpperCase()
        return '<tr>' +
          '<td><strong>' + esc(recNo) + '</strong></td>' +
          '<td class="mut">' + esc(dateStr) + '</td>' +
          '<td><span class="pill neutral">' + esc(p.method || 'Cash') + '</span></td>' +
          '<td class="mut">' + esc(p.reference || '—') + '</td>' +
          '<td>' + esc(p.paid_by || '—') + '</td>' +
          '<td style="text-align:right"><strong>' + esc(naira(amt)) + '</strong></td>' +
          '<td><button class="btn ghost sm" data-print-rec="' + esc(p.id) + '">🖨️ Receipt</button></td></tr>'
      }).join('') +
      '</tbody></table></div>'
  } else {
    paymentsTableHtml = '<p class="sub" style="margin:10px 0">No payments recorded yet for this invoice.</p>'
  }

  const patientLink = inv.patientId
    ? '<a href="#/patients/' + encodeURIComponent(inv.patientId) + '" style="font-weight:700">' + esc(inv.patientName) + '</a>'
    : esc(inv.patientName)

  shell(app, {
    active: '/billing',
    title: 'Invoice #' + (inv.invoiceId || inv.id).slice(0, 8).toUpperCase(),
    subtitle: esc(inv.patientName) + ' · ' + esc(inv.date || fmtDate(inv.createdAt)) + ' · ' + esc(inv.payer),
    actions:
      '<a class="btn ghost" href="#/billing">← All invoices</a>' +
      '<button class="btn ghost" id="printInvBtn">🖨️ Print invoice</button>' +
      (caps.canPayment && inv.status !== 'paid' ? '<button class="btn" id="payBtnHeader">+ Record payment</button>' : '') +
      kebabCell({ rowId: inv.id, items: [
        ...(caps.canPayment && inv.status !== 'paid' ? [{ label: 'Record payment', dataAction: 'pay' }] : []),
        ...(canDeleteRecords() ? [{ label: 'Delete invoice', tone: 'danger', dataAction: 'delete' }] : [])
      ] }),
    body:
      '<div class="grid2x">' +
      // Column 1: Items and Invoice Details
      '<div>' +
        '<div class="card">' +
          '<div class="card-head"><h3>Invoice items</h3>' + statusBadge(inv.status) + '</div>' +
          linesTableHtml +
          '<div class="inv-total" style="margin-top:14px">' +
            '<div>' +
              '<div>Total billed: <strong>' + esc(naira(inv.total)) + '</strong></div>' +
              '<div>Total paid: <strong style="color:#047857">' + esc(naira(inv.paid)) + '</strong></div>' +
              '<div class="grand" style="color:' + (inv.outstanding > 0 ? '#b91c1c' : '#047857') + '">Balance due: ' + esc(naira(inv.outstanding)) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      // Column 2: Payment History & Account Info
      '<div>' +
        '<div class="card">' +
          '<div class="card-head"><h3>Payments</h3>' +
            (caps.canPayment && inv.status !== 'paid' ? '<button class="btn sm" id="payBtnSection">+ Add payment</button>' : '') +
          '</div>' +
          paymentsTableHtml +
        '</div>' +

        '<div class="card">' +
          '<h3>Patient & Payer Details</h3>' +
          '<div class="kv" style="margin-top:10px">' +
            '<div><em>Patient</em><strong>' + patientLink + '</strong></div>' +
            '<div><em>Payer</em><strong>' + esc(inv.payer || 'Self-pay') + '</strong></div>' +
            (inv.pa_code ? '<div><em>Pre-authorization (PA) code</em><strong>' + esc(inv.pa_code) + '</strong></div>' : '') +
            '<div><em>Invoice date</em><strong>' + esc(inv.date || fmtDate(inv.createdAt)) + '</strong></div>' +
            '<div><em>Source</em><strong>' + esc(inv.raw?.source_type || 'Direct') + '</strong></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>',
  })

  function openPayment() {
    openPaymentModal({
      invoice: inv,
      onSuccess: () => {
        InvoiceDetailView(app, params)
      },
    })
  }

  // Print invoice handler
  const printInvBtn = document.getElementById('printInvBtn')
  if (printInvBtn) {
    printInvBtn.onclick = () => {
      printDocument('Invoice-' + (inv.invoiceId || inv.id).slice(0, 8), invoicePrintHtml({
        hospitalName: orgName,
        invoice: inv,
        lines: lines.length ? lines : [{ label: inv.items, unit_price_kobo: (inv.total || 0) * 100, qty: 1 }],
        payments,
        generatedBy: currentStaffName(),
      }))
    }
  }

  const payBtnHeader = document.getElementById('payBtnHeader')
  if (payBtnHeader) payBtnHeader.onclick = openPayment

  const payBtnSection = document.getElementById('payBtnSection')
  if (payBtnSection) payBtnSection.onclick = openPayment

  // Wire individual receipt print buttons
  document.querySelectorAll('[data-print-rec]').forEach((b) => {
    b.onclick = () => {
      const payId = b.getAttribute('data-print-rec')
      const p = payments.find((x) => x.id === payId)
      if (!p) return
      printDocument('Receipt-' + (p.receipt_number || payId.slice(0, 8)), receiptPrintHtml({
        hospitalName: orgName,
        payment: p,
        invoice: inv,
        receivedBy: p.paid_by || currentStaffName(),
      }))
    }
  })

  wireKebabs(app, (rowId, action) => {
    if (action === 'pay') openPayment()
    if (action === 'delete') {
      confirmDelete('invoice ' + (inv.invoiceId || ''), () => deleteInvoice(rowId), () => { window.location.hash = '#/billing' })
    }
  })

  wireToast(app)
}
