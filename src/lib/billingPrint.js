// Printable billing documents (Invoices, Receipts, Inpatient Statements, Shift Reconciliation).
// Follows the same standalone HTML pattern as labPrintTemplates and dischargeSummaryHtml.
import { esc } from '../utils/sanitize.js'
import { fmtDate, fmtDateTime, naira } from '../utils/format.js'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter(Boolean)
    .map((r) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>')
    .join('') + '</table>'
}

/**
 * Printable A4 Hospital Invoice
 */
export function invoicePrintHtml({ hospitalName, invoice, lines = [], payments = [], generatedBy = '' }) {
  const meta = [
    ['Invoice number', (invoice.invoiceId || invoice.id || '').slice(0, 12).toUpperCase()],
    ['Invoice date', invoice.date || fmtDate(invoice.createdAt)],
    ['Patient name', invoice.patientName || '—'],
    ['Payer', invoice.payer || 'Self-pay'],
    ['Status', String(invoice.status || 'unpaid').toUpperCase()],
    invoice.pa_code ? ['Pre-authorization (PA) code', invoice.pa_code] : null,
  ]

  let itemsHtml = ''
  if (lines.length > 0) {
    itemsHtml = '<table class="p-tbl"><thead><tr>' +
      '<th style="width:36px">#</th>' +
      '<th>Item / Description</th>' +
      '<th style="width:90px">Category</th>' +
      '<th style="width:50px;text-align:center">Qty</th>' +
      '<th style="width:110px;text-align:right">Unit price (₦)</th>' +
      '<th style="width:120px;text-align:right">Total (₦)</th>' +
      '</tr></thead><tbody>' +
      lines.map((l, idx) => {
        const unit = Number(l.unit_price_kobo || 0) / 100
        const qty = Number(l.qty || 1)
        const lineTot = unit * qty
        return '<tr>' +
          '<td>' + (idx + 1) + '</td>' +
          '<td><strong>' + esc(l.label || l.item || 'Service') + '</strong></td>' +
          '<td>' + esc(l.category || 'Service') + '</td>' +
          '<td style="text-align:center">' + qty + '</td>' +
          '<td style="text-align:right">' + naira(unit) + '</td>' +
          '<td style="text-align:right"><strong>' + naira(lineTot) + '</strong></td>' +
          '</tr>'
      }).join('') +
      '</tbody></table>'
  } else {
    itemsHtml = '<table class="p-tbl"><thead><tr><th>Item / Description</th><th style="width:130px;text-align:right">Total (₦)</th></tr></thead><tbody>' +
      '<tr><td>' + esc(typeof invoice.items === 'string' ? invoice.items : 'Medical services') + '</td>' +
      '<td style="text-align:right"><strong>' + naira(invoice.total || 0) + '</strong></td></tr>' +
      '</tbody></table>'
  }

  const totalsHtml =
    '<div style="display:flex;justify-content:flex-end;margin:12px 0">' +
    '<table style="min-width:280px;border-collapse:collapse;font-size:11pt">' +
    '<tr><td style="padding:4px 8px;text-align:right">Total billed:</td><td style="padding:4px 8px;text-align:right;font-weight:700">' + naira(invoice.total || 0) + '</td></tr>' +
    '<tr><td style="padding:4px 8px;text-align:right">Total paid:</td><td style="padding:4px 8px;text-align:right;color:#047857;font-weight:700">' + naira(invoice.paid || 0) + '</td></tr>' +
    '<tr style="border-top:2px solid #000"><td style="padding:6px 8px;text-align:right;font-weight:800;font-size:12pt">Balance due:</td>' +
    '<td style="padding:6px 8px;text-align:right;font-weight:800;font-size:12pt;color:' + (invoice.outstanding > 0 ? '#b91c1c' : '#047857') + '">' + naira(invoice.outstanding || 0) + '</td></tr>' +
    '</table></div>'

  let paymentsHtml = ''
  if (payments.length > 0) {
    paymentsHtml = '<h4 class="p-h4" style="margin-top:16px">Payments received</h4>' +
      '<table class="p-tbl"><thead><tr><th>Receipt #</th><th>Date</th><th>Method</th><th>Reference</th><th style="text-align:right">Amount (₦)</th></tr></thead><tbody>' +
      payments.map((p) => {
        const amt = Number(p.amount_kobo || 0) / 100
        const dateStr = p.paid_at ? fmtDateTime(p.paid_at) : '—'
        return '<tr><td>' + esc(p.receipt_number || p.id.slice(0, 8).toUpperCase()) + '</td>' +
          '<td>' + esc(dateStr) + '</td>' +
          '<td>' + esc(p.method || 'Cash') + '</td>' +
          '<td>' + esc(p.reference || '—') + '</td>' +
          '<td style="text-align:right"><strong>' + naira(amt) + '</strong></td></tr>'
      }).join('') +
      '</tbody></table>'
  }

  return '' +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Billing Department · Official Patient Invoice</div>' +
      '</div>' +
      '<div class="p-doctitle">INVOICE</div>' +
    '</div>' +
    metaTable(meta) +
    '<h4 class="p-h4">Itemized charges</h4>' +
    itemsHtml +
    totalsHtml +
    paymentsHtml +
    '<div class="p-sign">' +
      '<div><div class="p-line"></div><div class="p-cap">Prepared by ' + esc(generatedBy || 'Cashier') + '</div></div>' +
      '<div><div class="p-line"></div><div class="p-cap">Patient / Sponsor Acknowledgement</div></div>' +
    '</div>' +
    '<div class="p-foot">Printed ' + esc(new Date().toLocaleString('en-GB')) + ' · MediLog NG EMR</div>'
}

/**
 * Printable Receipt (formatted cleanly for both standard A4 and 80mm thermal receipt roll printers)
 */
export function receiptPrintHtml({ hospitalName, payment, invoice = {}, receivedBy = '' }) {
  const amount = Number(payment.amount_kobo || (payment.amount_naira ? payment.amount_naira * 100 : 0)) / 100
  const receiptNo = payment.receipt_number || ('REC-' + (payment.id || '').slice(0, 8).toUpperCase())
  const paidAt = payment.paid_at ? fmtDateTime(payment.paid_at) : fmtDateTime(Date.now())
  const patientName = invoice.patientName || payment.patient_name || 'Patient'
  const invId = (invoice.invoiceId || invoice.id || payment.invoice_id || '').slice(0, 10).toUpperCase()
  const balance = invoice.outstanding != null ? invoice.outstanding : '—'

  return '' +
    '<div style="max-width:380px;margin:0 auto;padding:12px;font-family:monospace,\'Courier New\',serif;font-size:10pt;line-height:1.4">' +
      '<div style="text-align:center;margin-bottom:12px">' +
        '<strong style="font-size:14pt;display:block">' + esc(hospitalName || 'Hospital') + '</strong>' +
        '<span style="font-size:9pt;text-transform:uppercase;letter-spacing:1px">Payment Receipt</span><br/>' +
        '<span style="font-size:8.5pt">*** OFFICIAL RECEIPT ***</span>' +
      '</div>' +
      '<div style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin-bottom:10px">' +
        '<div><strong>Receipt No:</strong> ' + esc(receiptNo) + '</div>' +
        '<div><strong>Date & Time:</strong> ' + esc(paidAt) + '</div>' +
        '<div><strong>Patient:</strong> ' + esc(patientName) + '</div>' +
        '<div><strong>Invoice No:</strong> ' + esc(invId) + '</div>' +
        '<div><strong>Payer:</strong> ' + esc(invoice.payer || 'Self-pay') + '</div>' +
        '<div><strong>Method:</strong> ' + esc(payment.method || 'Cash') + '</div>' +
        (payment.reference ? '<div><strong>Ref / Auth:</strong> ' + esc(payment.reference) + '</div>' : '') +
      '</div>' +
      '<div style="margin:12px 0">' +
        '<div style="display:flex;justify-content:space-between;font-size:12pt;font-weight:800;margin:8px 0">' +
          '<span>AMOUNT PAID:</span><span>' + naira(amount) + '</span>' +
        '</div>' +
        (typeof balance === 'number'
          ? '<div style="display:flex;justify-content:space-between;font-size:9pt;color:#333">' +
            '<span>Invoice balance:</span><span>' + naira(balance) + '</span></div>'
          : '') +
      '</div>' +
      (payment.notes ? '<div style="font-size:8.5pt;margin-top:6px;font-style:italic">Note: ' + esc(payment.notes) + '</div>' : '') +
      '<div style="border-top:1px dashed #000;padding-top:8px;margin-top:12px;text-align:center;font-size:8.5pt">' +
        '<div>Received by: <strong>' + esc(payment.paid_by || receivedBy || 'Cashier') + '</strong></div>' +
        '<div style="margin-top:6px">Please present this receipt at Pharmacy / Laboratory for verification.</div>' +
        '<div style="margin-top:4px;color:#666">Thank you for your payment.</div>' +
      '</div>' +
    '</div>'
}

/**
 * Printable Shift / Daily Cashier Reconciliation Report
 */
export function shiftReconciliationPrintHtml({ hospitalName, cashierName, dateStr, summary, payments = [] }) {
  const methodRows = Object.entries(summary.byMethod || {}).map(([m, data]) => {
    return '<tr><td><strong>' + esc(m) + '</strong></td>' +
      '<td style="text-align:center">' + data.count + '</td>' +
      '<td style="text-align:right"><strong>' + naira(data.total) + '</strong></td></tr>'
  }).join('')

  return '' +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Billing Department · Cashier Shift Handover & Daily Balancing</div>' +
      '</div>' +
      '<div class="p-doctitle">DAILY RECONCILIATION</div>' +
    '</div>' +
    '<table class="p-meta">' +
      '<tr><td class="k">Cashier / Staff</td><td>' + esc(cashierName || 'Cashier') + '</td></tr>' +
      '<tr><td class="k">Period / Date</td><td>' + esc(dateStr || fmtDate(Date.now())) + '</td></tr>' +
      '<tr><td class="k">Total Transactions</td><td>' + summary.count + ' payment(s)</td></tr>' +
      '<tr><td class="k">Total Collected</td><td><strong>' + naira(summary.total) + '</strong></td></tr>' +
    '</table>' +
    '<h4 class="p-h4">Collection by Payment Channel</h4>' +
    '<table class="p-tbl"><thead><tr><th>Payment Channel</th><th style="width:100px;text-align:center">Txn Count</th><th style="width:150px;text-align:right">Amount (₦)</th></tr></thead><tbody>' +
    (methodRows || '<tr><td colspan="3" class="mut" style="text-align:center">No payments in this period</td></tr>') +
    '<tr style="font-weight:800;background:#f3f4f6"><td>TOTAL</td><td style="text-align:center">' + summary.count + '</td><td style="text-align:right">' + naira(summary.total) + '</td></tr>' +
    '</tbody></table>' +
    '<h4 class="p-h4" style="margin-top:16px">Transaction Journal</h4>' +
    '<table class="p-tbl" style="font-size:9.5pt"><thead><tr><th>Receipt #</th><th>Time</th><th>Patient</th><th>Method</th><th>Ref</th><th style="text-align:right">Amount (₦)</th></tr></thead><tbody>' +
    payments.map((p) => {
      const amt = Number(p.amount_kobo || 0) / 100
      const timeStr = p.paid_at ? fmtDateTime(p.paid_at) : '—'
      return '<tr>' +
        '<td>' + esc(p.receipt_number || p.id.slice(0, 8).toUpperCase()) + '</td>' +
        '<td>' + esc(timeStr) + '</td>' +
        '<td>' + esc(p.patient_name || p.patientName || '—') + '</td>' +
        '<td>' + esc(p.method || 'Cash') + '</td>' +
        '<td>' + esc(p.reference || '—') + '</td>' +
        '<td style="text-align:right"><strong>' + naira(amt) + '</strong></td>' +
        '</tr>'
    }).join('') +
    '</tbody></table>' +
    '<div class="p-sign">' +
      '<div><div class="p-line"></div><div class="p-cap">Cashier Handover Signature</div></div>' +
      '<div><div class="p-line"></div><div class="p-cap">Supervisor / Auditor Acceptance</div></div>' +
    '</div>' +
    '<div class="p-foot">Printed ' + esc(new Date().toLocaleString('en-GB')) + ' · MediLog NG EMR</div>'
}

/**
 * Printable Consolidated Inpatient Statement of Account
 */
export function inpatientStatementHtml({ hospitalName, admission, invoices = [], payments = [], generatedBy = '' }) {
  const totalBilled = invoices.reduce((s, i) => s + (Number(i.total_kobo || 0) / 100), 0)
  const totalPaid = invoices.reduce((s, i) => s + (Number(i.paid_kobo || 0) / 100), 0)
  const balance = totalBilled - totalPaid

  const meta = [
    ['Patient Name', admission.patientName || '—'],
    ['MRN', admission.mrn || '—'],
    ['Ward / Bed', (admission.wardName || '—') + ' · ' + (admission.bedNumber || '—')],
    ['Admission Date', admission.admissionDate ? fmtDate(admission.admissionDate) : '—'],
    ['Discharge Date', admission.dischargeDate ? fmtDate(admission.dischargeDate) : 'Active Inpatient'],
    ['Attending Clinician', admission.attendingProvider || '—'],
  ]

  let invoiceRows = invoices.map((inv, idx) => {
    const invBilled = Number(inv.total_kobo || 0) / 100
    const invPaid = Number(inv.paid_kobo || 0) / 100
    const invBal = invBilled - invPaid
    const desc = inv.items || (Array.isArray(inv.lines) ? inv.lines.map((l) => l.label).join(', ') : 'Inpatient charges')
    return '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td>' + esc(inv.invoice_id ? inv.invoice_id.slice(0, 8).toUpperCase() : inv.id.slice(0, 8).toUpperCase()) + '</td>' +
      '<td>' + esc(inv.date || fmtDate(inv.created_at)) + '</td>' +
      '<td>' + esc(desc) + '</td>' +
      '<td style="text-align:right">' + naira(invBilled) + '</td>' +
      '<td style="text-align:right">' + naira(invPaid) + '</td>' +
      '<td style="text-align:right"><strong>' + naira(invBal) + '</strong></td>' +
      '</tr>'
  }).join('')

  return '' +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Inpatient Financial Statement · Admission Session</div>' +
      '</div>' +
      '<div class="p-doctitle">INPATIENT STATEMENT</div>' +
    '</div>' +
    metaTable(meta) +
    '<h4 class="p-h4">Itemized Admission Charges</h4>' +
    '<table class="p-tbl"><thead><tr>' +
      '<th style="width:30px">#</th><th>Invoice #</th><th>Date</th><th>Description</th>' +
      '<th style="width:100px;text-align:right">Billed (₦)</th><th style="width:100px;text-align:right">Paid (₦)</th><th style="width:100px;text-align:right">Balance (₦)</th>' +
    '</tr></thead><tbody>' +
    (invoiceRows || '<tr><td colspan="7" class="mut" style="text-align:center">No charges logged for this admission.</td></tr>') +
    '</tbody></table>' +
    '<div style="display:flex;justify-content:flex-end;margin:14px 0">' +
      '<table style="min-width:300px;border-collapse:collapse;font-size:11pt">' +
        '<tr><td style="padding:4px 8px;text-align:right">Total Billed:</td><td style="padding:4px 8px;text-align:right;font-weight:700">' + naira(totalBilled) + '</td></tr>' +
        '<tr><td style="padding:4px 8px;text-align:right">Total Payments Received:</td><td style="padding:4px 8px;text-align:right;color:#047857;font-weight:700">' + naira(totalPaid) + '</td></tr>' +
        '<tr style="border-top:2px solid #000"><td style="padding:6px 8px;text-align:right;font-weight:800;font-size:12pt">Net Inpatient Balance:</td>' +
        '<td style="padding:6px 8px;text-align:right;font-weight:800;font-size:12pt;color:' + (balance > 0 ? '#b91c1c' : '#047857') + '">' + naira(balance) + '</td></tr>' +
      '</table>' +
    '</div>' +
    '<div class="p-sign">' +
      '<div><div class="p-line"></div><div class="p-cap">Billing Officer ' + esc(generatedBy || '') + '</div></div>' +
      '<div><div class="p-line"></div><div class="p-cap">Patient / Sponsor Signature</div></div>' +
    '</div>' +
    '<div class="p-foot">Printed ' + esc(new Date().toLocaleString('en-GB')) + ' · MediLog NG EMR</div>'
}
