import assert from 'node:assert/strict'
import {
  invoicePrintHtml,
  receiptPrintHtml,
  shiftReconciliationPrintHtml,
  inpatientStatementHtml,
} from '../../src/lib/billingPrint.js'

// 1. Test invoicePrintHtml
const invHtml = invoicePrintHtml({
  hospitalName: 'Grace Valley Specialist Hospital',
  invoice: {
    id: 'inv_123',
    invoiceId: 'inv_123',
    patientName: 'Adaobi Okonkwo',
    payer: 'NHIA',
    pa_code: 'NHIA-2026-9921',
    status: 'part-paid',
    total: 25000,
    paid: 10000,
    outstanding: 15000,
    date: '28/10/2026',
  },
  lines: [
    { label: 'Consultation - Consultant Physician', category: 'Consult', qty: 1, unit_price_kobo: 1000000 },
    { label: 'Full Blood Count', category: 'Lab', qty: 1, unit_price_kobo: 500000 },
    { label: 'Ward Bed - 2 Nights', category: 'Bed', qty: 2, unit_price_kobo: 500000 },
  ],
  payments: [
    { id: 'pay_1', receipt_number: 'REC-001A', amount_kobo: 1000000, method: 'POS', reference: 'POS-RRN-99812' }
  ],
  generatedBy: 'Chinedu Eze',
})

assert.ok(invHtml.includes('Grace Valley Specialist Hospital'), 'renders hospital name')
assert.ok(invHtml.includes('Adaobi Okonkwo'), 'renders patient name')
assert.ok(invHtml.includes('NHIA-2026-9921'), 'renders PA code')
assert.ok(invHtml.includes('Consultation - Consultant Physician'), 'renders itemized line')
assert.ok(invHtml.includes('REC-001A'), 'renders receipt in payment history')
assert.ok(invHtml.includes('POS-RRN-99812'), 'renders POS reference')

// 2. Test receiptPrintHtml
const recHtml = receiptPrintHtml({
  hospitalName: 'Grace Valley Specialist Hospital',
  payment: {
    id: 'pay_999',
    receipt_number: 'REC-PAY999',
    amount_kobo: 1500000,
    method: 'Transfer',
    reference: 'NIP/GTB/00998231',
    paid_by: 'Cashier Amarachi',
  },
  invoice: {
    invoiceId: 'inv_123',
    patientName: 'Adaobi Okonkwo',
    outstanding: 0,
    payer: 'Self-pay',
  },
  receivedBy: 'Cashier Amarachi',
})

assert.ok(recHtml.includes('REC-PAY999'), 'receipt number present')
assert.ok(recHtml.includes('Transfer'), 'payment method present')
assert.ok(recHtml.includes('NIP/GTB/00998231'), 'transfer ref present')
assert.ok(recHtml.includes('₦15,000'), 'amount formatted in naira')
assert.ok(recHtml.includes('Adaobi Okonkwo'), 'patient present')

// 3. Test shiftReconciliationPrintHtml
const shiftHtml = shiftReconciliationPrintHtml({
  hospitalName: 'Grace Valley Specialist Hospital',
  cashierName: 'Cashier Amarachi',
  dateStr: '28/10/2026',
  summary: {
    count: 3,
    total: 35000,
    byMethod: {
      Cash: { count: 1, total: 10000 },
      POS: { count: 1, total: 15000 },
      Transfer: { count: 1, total: 10000 },
    },
  },
  payments: [
    { id: 'p1', receipt_number: 'REC-1', patient_name: 'Patient A', method: 'Cash', amount_kobo: 1000000 },
    { id: 'p2', receipt_number: 'REC-2', patient_name: 'Patient B', method: 'POS', reference: 'RRN-11', amount_kobo: 1500000 },
    { id: 'p3', receipt_number: 'REC-3', patient_name: 'Patient C', method: 'Transfer', reference: 'REF-22', amount_kobo: 1000000 },
  ],
})

assert.ok(shiftHtml.includes('DAILY RECONCILIATION'), 'shift title present')
assert.ok(shiftHtml.includes('Cashier Amarachi'), 'cashier present')
assert.ok(shiftHtml.includes('₦35,000'), 'total collected formatted')
assert.ok(shiftHtml.includes('POS'), 'method breakdown present')

// 4. Test inpatientStatementHtml
const stmtHtml = inpatientStatementHtml({
  hospitalName: 'Grace Valley Specialist Hospital',
  admission: {
    patientName: 'Emeka Nwosu',
    mrn: 'MRN-2026-004',
    wardName: 'Male Medical Ward',
    bedNumber: 'Bed 04',
    admissionDate: '24/10/2026',
    attendingProvider: 'Dr. Alabi',
  },
  invoices: [
    { id: 'inv_1', invoice_id: 'inv_1', total_kobo: 5000000, paid_kobo: 2000000, items: 'Admission bed & nursing' },
    { id: 'inv_2', invoice_id: 'inv_2', total_kobo: 3000000, paid_kobo: 3000000, items: 'Pharmacy dispensation' },
  ],
})

assert.ok(stmtHtml.includes('INPATIENT STATEMENT'), 'statement title present')
assert.ok(stmtHtml.includes('Male Medical Ward'), 'ward present')
assert.ok(stmtHtml.includes('₦80,000'), 'total billed 50k+30k=80k')
assert.ok(stmtHtml.includes('₦50,000'), 'total paid 20k+30k=50k')
assert.ok(stmtHtml.includes('₦30,000'), 'balance 80k-50k=30k')

console.log('billing print: all assertions passed')
