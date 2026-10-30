// Printable billing documents — international standard edition.
// Covers: Hospital Invoice, Payment Receipt, Shift Reconciliation, Inpatient Statement.
// Pure string builders (no DOM). All monetary values in naira (already /100).
import { esc } from '../utils/sanitize.js'
import { fmtDate, fmtDateTime, naira } from '../utils/format.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

const CONFIDENTIAL = '<div class="p-confidential">CONFIDENTIAL — For the named patient and authorised personnel only. Unauthorised disclosure is prohibited.</div>'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter(Boolean)
    .map((r, i) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(String(r[1] ?? '—')) + '</td></tr>')
    .join('') + '</table>'
}

function printedAt() {
  return esc(new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' }))
}

function pageFooter(hospitalName, docType) {
  return '<div class="p-foot">' +
    esc(hospitalName || 'Hospital') + ' &nbsp;|&nbsp; ' + esc(docType) +
    ' &nbsp;|&nbsp; MediLog NG EMR &nbsp;|&nbsp; Printed ' + printedAt() +
    '</div>'
}

function signatureBlock(cols) {
  // cols: array of { label, name? }
  return '<div class="p-sign">' +
    cols.map((c) =>
      '<div>' +
      '<div class="p-line"></div>' +
      '<div class="p-cap">' + esc(c.label) + '</div>' +
      (c.name ? '<div class="p-cap-name">' + esc(c.name) + '</div>' : '') +
      '</div>'
    ).join('') +
    '</div>'
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Printable A4 Hospital Invoice — International Standard
 *
 * Supports: Proforma / Official Tax Invoice / Receipt subtype based on payment status.
 * Includes: Itemised charges, VAT row, payment history, PAID/BALANCE stamp.
 */
export function invoicePrintHtml({ hospitalName, invoice, lines = [], payments = [], generatedBy = '' }) {
  // Determine document subtype
  const outstanding = Number(invoice.outstanding || 0)
  const isPaid = outstanding <= 0
  const docSubtype = isPaid ? 'OFFICIAL TAX INVOICE — FULLY PAID' : 'OFFICIAL TAX INVOICE'

  const invNo = (invoice.invoiceId || invoice.id || '').slice(0, 14).toUpperCase()
  const invDate = invoice.date || fmtDate(invoice.createdAt)

  const meta = [
    ['Invoice Number', invNo],
    ['Invoice Date', invDate],
    ['Patient Name', invoice.patientName || '—'],
    ['MRN / File No.', invoice.mrn || invoice.patientId || '—'],
    ['Payer / Sponsor', invoice.payer || 'Self-pay'],
    invoice.pa_code ? ['Pre-Auth (PA) Code', invoice.pa_code] : null,
    ['Payment Status', isPaid ? 'PAID IN FULL' : ('OUTSTANDING: ' + naira(outstanding))],
    ['Billing Officer', generatedBy || '—'],
  ]

  // Itemised lines table
  let itemsHtml
  if (lines.length > 0) {
    const subtotal = lines.reduce((s, l) => s + (Number(l.unit_price_kobo || 0) / 100) * Number(l.qty || 1), 0)
    itemsHtml =
      '<table class="p-tbl"><thead><tr>' +
      '<th style="width:28px">#</th>' +
      '<th>Item / Description</th>' +
      '<th style="width:88px">Category</th>' +
      '<th class="num" style="width:40px">Qty</th>' +
      '<th class="num" style="width:100px">Unit Price (₦)</th>' +
      '<th class="num" style="width:110px">Line Total (₦)</th>' +
      '</tr></thead><tbody>' +
      lines.map((l, idx) => {
        const unit = Number(l.unit_price_kobo || 0) / 100
        const qty  = Number(l.qty || 1)
        const tot  = unit * qty
        return '<tr>' +
          '<td>' + (idx + 1) + '</td>' +
          '<td><strong>' + esc(l.label || l.item || 'Service') + '</strong>' +
          (l.description ? '<br><span style="font-size:9pt;color:#555">' + esc(l.description) + '</span>' : '') +
          '</td>' +
          '<td>' + esc(l.category || 'Service') + '</td>' +
          '<td class="num">' + qty + '</td>' +
          '<td class="num">' + naira(unit) + '</td>' +
          '<td class="num"><strong>' + naira(tot) + '</strong></td>' +
          '</tr>'
      }).join('') +
      '</tbody></table>'
  } else {
    itemsHtml =
      '<table class="p-tbl"><thead><tr>' +
      '<th>Item / Description</th><th class="num" style="width:130px">Total (₦)</th>' +
      '</tr></thead><tbody>' +
      '<tr><td>' + esc(typeof invoice.items === 'string' ? invoice.items : 'Medical services') + '</td>' +
      '<td class="num"><strong>' + naira(invoice.total || 0) + '</strong></td></tr>' +
      '</tbody></table>'
  }

  // Totals block
  const total   = Number(invoice.total || 0)
  const paid    = Number(invoice.paid  || 0)
  const totalsHtml =
    '<div class="p-totals"><table>' +
    '<tr><td>Subtotal</td><td class="num">' + naira(total) + '</td></tr>' +
    '<tr><td>VAT (0% — exempt)</td><td class="num">' + naira(0) + '</td></tr>' +
    '<tr><td>Total Amount Due</td><td class="num"><strong>' + naira(total) + '</strong></td></tr>' +
    '<tr><td>Total Received</td><td class="num" style="color:#166534"><strong>' + naira(paid) + '</strong></td></tr>' +
    '<tr class="grand"><td>Balance Due</td>' +
    '<td class="num" style="color:' + (outstanding > 0 ? '#991b1b' : '#166534') + '">' +
    '<strong>' + naira(outstanding) + '</strong></td></tr>' +
    '</table></div>' +
    // Stamp
    '<div style="text-align:right;margin:8px 0 16px">' +
    '<span class="p-stamp ' + (isPaid ? 'paid' : 'unpaid') + '">' +
    (isPaid ? 'PAID IN FULL ✓' : 'BALANCE DUE: ' + naira(outstanding)) +
    '</span></div>'

  // Payments received
  let paymentsHtml = ''
  if (payments.length > 0) {
    paymentsHtml =
      '<h4 class="p-h4">Payments Received</h4>' +
      '<table class="p-tbl"><thead><tr>' +
      '<th>Receipt No.</th><th>Date &amp; Time</th><th>Method</th><th>Reference</th>' +
      '<th class="num">Amount (₦)</th>' +
      '</tr></thead><tbody>' +
      payments.map((p) => {
        const amt = Number(p.amount_kobo || 0) / 100
        return '<tr>' +
          '<td><strong>' + esc(p.receipt_number || ('REC-' + p.id.slice(0, 8).toUpperCase())) + '</strong></td>' +
          '<td>' + esc(p.paid_at ? fmtDateTime(p.paid_at) : '—') + '</td>' +
          '<td>' + esc(p.method || 'Cash') + '</td>' +
          '<td>' + esc(p.reference || '—') + '</td>' +
          '<td class="num"><strong>' + naira(amt) + '</strong></td>' +
          '</tr>'
      }).join('') +
      '</tbody></table>'
  }

  return CONFIDENTIAL +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Billing &amp; Finance Department</div>' +
      '</div>' +
      '<div class="p-doctitle">INVOICE</div>' +
    '</div>' +
    '<p style="font-size:9pt;text-align:right;margin:0 0 6px;font-style:italic;color:#555">' + esc(docSubtype) + '</p>' +
    metaTable(meta) +
    '<h4 class="p-h4">Itemised Charges</h4>' +
    itemsHtml +
    totalsHtml +
    paymentsHtml +
    signatureBlock([
      { label: 'Prepared by', name: generatedBy },
      { label: 'Authorised by (Finance Officer)' },
      { label: 'Patient / Guarantor Signature' },
    ]) +
    pageFooter(hospitalName, 'Invoice ' + invNo)
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Printable Payment Receipt — fits A4 and is legible on 80 mm thermal roll.
 */
export function receiptPrintHtml({ hospitalName, payment, invoice = {}, receivedBy = '' }) {
  const amount    = Number(payment.amount_kobo || (payment.amount_naira ? payment.amount_naira * 100 : 0)) / 100
  const receiptNo = payment.receipt_number || ('REC-' + (payment.id || '').slice(0, 8).toUpperCase())
  const paidAt    = payment.paid_at ? fmtDateTime(payment.paid_at) : fmtDateTime(Date.now())
  const patientName = invoice.patientName || payment.patient_name || 'Patient'
  const invId     = (invoice.invoiceId || invoice.id || payment.invoice_id || '').slice(0, 12).toUpperCase()
  const balance   = invoice.outstanding != null ? invoice.outstanding : null

  // Narrow centred layout — max 420px so it prints well on thermal and A4
  return CONFIDENTIAL +
    '<div style="max-width:420px;margin:0 auto;font-family:\'Courier New\',Courier,monospace;font-size:10pt;line-height:1.5">' +
    // Header
    '<div style="text-align:center;border-bottom:2px solid #1a3a5c;padding-bottom:10px;margin-bottom:12px">' +
      '<div style="font-family:\'Segoe UI\',Arial,sans-serif;font-size:15pt;font-weight:900;color:#1a3a5c">' + esc(hospitalName || 'Hospital') + '</div>' +
      '<div style="font-size:8.5pt;letter-spacing:2px;text-transform:uppercase;margin-top:2px">OFFICIAL PAYMENT RECEIPT</div>' +
    '</div>' +
    // Receipt number + date prominently
    '<div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:9pt">' +
      '<div><strong>Receipt No.:</strong> ' + esc(receiptNo) + '</div>' +
      '<div><strong>Date:</strong> ' + esc(paidAt) + '</div>' +
    '</div>' +
    '<div style="border-top:1px dashed #888;border-bottom:1px dashed #888;padding:8px 0;margin-bottom:12px">' +
      '<div><strong>Patient:</strong> ' + esc(patientName) + '</div>' +
      '<div><strong>Invoice No.:</strong> ' + esc(invId || '—') + '</div>' +
      '<div><strong>Payer:</strong> ' + esc(invoice.payer || payment.payer || 'Self-pay') + '</div>' +
      '<div><strong>Payment Method:</strong> ' + esc(payment.method || 'Cash') + '</div>' +
      (payment.reference ? '<div><strong>Reference / Auth. Code:</strong> ' + esc(payment.reference) + '</div>' : '') +
    '</div>' +
    // Amount block
    '<div style="border:2px solid #1a3a5c;padding:10px 14px;margin-bottom:12px;text-align:center">' +
      '<div style="font-size:9pt;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Amount Received</div>' +
      '<div style="font-size:18pt;font-weight:900;font-family:\'Segoe UI\',Arial,sans-serif;color:#1a3a5c">' + naira(amount) + '</div>' +
      (balance !== null
        ? '<div style="font-size:9pt;margin-top:4px;color:' + (balance <= 0 ? '#166534' : '#991b1b') + '">' +
          (balance <= 0 ? 'Invoice balance: PAID IN FULL' : 'Remaining balance: ' + naira(balance)) +
          '</div>'
        : '') +
    '</div>' +
    (payment.notes ? '<div style="font-size:8.5pt;font-style:italic;margin-bottom:8px">Note: ' + esc(payment.notes) + '</div>' : '') +
    // Footer
    '<div style="border-top:1px dashed #888;padding-top:8px;font-size:8.5pt;text-align:center">' +
      '<div>Received by: <strong>' + esc(payment.paid_by || receivedBy || 'Cashier') + '</strong></div>' +
      '<div style="margin-top:6px">Please retain this receipt as proof of payment.</div>' +
      '<div style="margin-top:4px">Queries: contact Billing Department with receipt number.</div>' +
      '<div style="margin-top:10px;font-size:9pt;font-style:italic;color:#555">Thank you for choosing ' + esc(hospitalName || 'our hospital') + '.</div>' +
    '</div>' +
    '<div style="margin-top:16px;border-top:1px solid #bbb;padding-top:5px;font-size:8pt;text-align:center;color:#555">' +
    esc(hospitalName || 'Hospital') + ' &nbsp;|&nbsp; MediLog NG EMR &nbsp;|&nbsp; Printed ' + printedAt() +
    '</div>' +
    '</div>'
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Printable Shift / Daily Cashier Reconciliation Report
 */
export function shiftReconciliationPrintHtml({ hospitalName, cashierName, dateStr, summary, payments = [] }) {
  const methodRows = Object.entries(summary.byMethod || {}).map(([m, data]) =>
    '<tr>' +
    '<td><strong>' + esc(m) + '</strong></td>' +
    '<td class="num">' + data.count + '</td>' +
    '<td class="num"><strong>' + naira(data.total) + '</strong></td>' +
    '</tr>'
  ).join('')

  const meta = [
    ['Cashier / Staff', cashierName || 'Cashier'],
    ['Period / Date', dateStr || fmtDate(Date.now())],
    ['Total Transactions', String(summary.count) + ' payment(s)'],
    ['Total Collected (₦)', naira(summary.total)],
    ['Report Generated', printedAt()],
  ]

  const txnRows = payments.map((p) => {
    const amt = Number(p.amount_kobo || 0) / 100
    return '<tr>' +
      '<td>' + esc(p.receipt_number || p.id.slice(0, 8).toUpperCase()) + '</td>' +
      '<td>' + esc(p.paid_at ? fmtDateTime(p.paid_at) : '—') + '</td>' +
      '<td>' + esc(p.patient_name || p.patientName || '—') + '</td>' +
      '<td>' + esc(p.method || 'Cash') + '</td>' +
      '<td>' + esc(p.reference || '—') + '</td>' +
      '<td class="num"><strong>' + naira(amt) + '</strong></td>' +
      '</tr>'
  }).join('')

  return CONFIDENTIAL +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Billing Department · Cashier Shift Handover &amp; Daily Balancing</div>' +
      '</div>' +
      '<div class="p-doctitle">DAILY RECONCILIATION</div>' +
    '</div>' +
    metaTable(meta) +
    '<h4 class="p-h4">Collection by Payment Channel</h4>' +
    '<table class="p-tbl"><thead><tr>' +
    '<th>Payment Channel</th>' +
    '<th class="num" style="width:100px">Transactions</th>' +
    '<th class="num" style="width:150px">Amount (₦)</th>' +
    '</tr></thead><tbody>' +
    (methodRows || '<tr><td colspan="3" style="text-align:center;font-style:italic">No payments in this period.</td></tr>') +
    '<tr style="font-weight:800;background:#e8edf4"><td>TOTAL</td>' +
    '<td class="num">' + summary.count + '</td>' +
    '<td class="num">' + naira(summary.total) + '</td></tr>' +
    '</tbody></table>' +
    '<h4 class="p-h4" style="margin-top:16px">Transaction Journal</h4>' +
    '<table class="p-tbl" style="font-size:9.5pt"><thead><tr>' +
    '<th>Receipt #</th><th>Date &amp; Time</th><th>Patient</th><th>Method</th><th>Reference</th>' +
    '<th class="num">Amount (₦)</th>' +
    '</tr></thead><tbody>' +
    (txnRows || '<tr><td colspan="6" style="text-align:center;font-style:italic">No transactions recorded.</td></tr>') +
    '</tbody></table>' +
    signatureBlock([
      { label: 'Cashier Signature', name: cashierName },
      { label: 'Supervisor / Auditor Acceptance' },
    ]) +
    pageFooter(hospitalName, 'Daily Reconciliation — ' + (dateStr || fmtDate(Date.now())))
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Printable Consolidated Inpatient Statement of Account
 */
export function inpatientStatementHtml({ hospitalName, admission, invoices = [], payments = [], generatedBy = '' }) {
  const totalBilled = invoices.reduce((s, i) => s + (Number(i.total_kobo || 0) / 100), 0)
  const totalPaid   = invoices.reduce((s, i) => s + (Number(i.paid_kobo  || 0) / 100), 0)
  const balance     = totalBilled - totalPaid
  const isPaid      = balance <= 0

  const meta = [
    ['Patient Name',        admission.patientName || '—'],
    ['MRN / File No.',      admission.mrn || '—'],
    ['Ward / Bed',          (admission.wardName || '—') + ' · Bed ' + (admission.bedNumber || '—')],
    ['Admission Date',      admission.admissionDate ? fmtDate(admission.admissionDate) : '—'],
    ['Discharge Date',      admission.dischargeDate ? fmtDate(admission.dischargeDate) : 'Active Inpatient'],
    ['Attending Clinician', admission.attendingProvider || '—'],
    ['Statement Date',      fmtDate(Date.now())],
  ]

  const invoiceRows = invoices.map((inv, idx) => {
    const invBilled = Number(inv.total_kobo || 0) / 100
    const invPaid   = Number(inv.paid_kobo  || 0) / 100
    const invBal    = invBilled - invPaid
    const desc = inv.items || (Array.isArray(inv.lines) ? inv.lines.map((l) => l.label).join(', ') : 'Inpatient charges')
    return '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td><strong>' + esc((inv.invoice_id || inv.id || '').slice(0, 10).toUpperCase()) + '</strong></td>' +
      '<td>' + esc(inv.date || fmtDate(inv.created_at)) + '</td>' +
      '<td>' + esc(typeof desc === 'string' ? desc : 'Medical services') + '</td>' +
      '<td class="num">' + naira(invBilled) + '</td>' +
      '<td class="num">' + naira(invPaid) + '</td>' +
      '<td class="num"><strong style="color:' + (invBal > 0 ? '#991b1b' : '#166534') + '">' + naira(invBal) + '</strong></td>' +
      '</tr>'
  }).join('')

  return CONFIDENTIAL +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Inpatient Financial Statement · Admission Account</div>' +
      '</div>' +
      '<div class="p-doctitle">INPATIENT STATEMENT</div>' +
    '</div>' +
    metaTable(meta) +
    '<h4 class="p-h4">Itemised Admission Charges</h4>' +
    '<table class="p-tbl"><thead><tr>' +
    '<th style="width:28px">#</th><th>Invoice No.</th><th>Date</th><th>Description</th>' +
    '<th class="num" style="width:96px">Billed (₦)</th>' +
    '<th class="num" style="width:96px">Paid (₦)</th>' +
    '<th class="num" style="width:96px">Balance (₦)</th>' +
    '</tr></thead><tbody>' +
    (invoiceRows || '<tr><td colspan="7" style="text-align:center;font-style:italic">No charges recorded for this admission.</td></tr>') +
    '</tbody></table>' +
    '<div class="p-totals"><table>' +
    '<tr><td>Total Billed</td><td class="num"><strong>' + naira(totalBilled) + '</strong></td></tr>' +
    '<tr><td>Total Paid</td><td class="num" style="color:#166534"><strong>' + naira(totalPaid) + '</strong></td></tr>' +
    '<tr class="grand"><td>Net Balance</td>' +
    '<td class="num" style="color:' + (balance > 0 ? '#991b1b' : '#166534') + '"><strong>' + naira(balance) + '</strong></td></tr>' +
    '</table></div>' +
    '<div style="text-align:right;margin:6px 0 14px">' +
    '<span class="p-stamp ' + (isPaid ? 'paid' : 'unpaid') + '">' +
    (isPaid ? 'ACCOUNT SETTLED ✓' : 'BALANCE DUE: ' + naira(balance)) +
    '</span></div>' +
    signatureBlock([
      { label: 'Billing Officer', name: generatedBy },
      { label: 'Authorised by (Finance Manager)' },
      { label: 'Patient / Next-of-Kin / Guarantor' },
    ]) +
    pageFooter(hospitalName, 'Inpatient Statement')
}
