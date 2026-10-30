// Shared payment modal — used by BillingView and InvoiceDetailView.
// Single place for amount validation (no overpayment without a credit note),
// method selection, POS/transfer reference tracking, and the recordPayment call.
import { formModal, closeModal, toast } from './shell.js'
import { recordPayment } from '../services/billingService.js'
import { friendlyWriteError } from '../utils/errors.js'
import { naira } from '../utils/format.js'
import { printDocument } from '../lib/print.js'
import { receiptPrintHtml } from '../lib/billingPrint.js'
import { authStore } from '../store/authStore.js'

export function openPaymentModal({ invoice, onSuccess, onClose, editing = false, existing = null }) {
  const outstanding = Number(invoice.outstanding || 0)
  const id = invoice.id
  const patientName = invoice.patientName || '—'
  const invoiceId = invoice.invoiceId || id
  const currentAmount = existing ? Number(existing.amount || 0) : 0
  const currentMethod = existing ? existing.method || 'Cash' : 'Cash'
  const currentRef = existing ? existing.reference || '' : ''
  const currentNotes = existing ? existing.notes || '' : ''

  formModal({
    title: editing
      ? 'Edit payment — ' + patientName + ' · ' + invoiceId.slice(0, 8)
      : 'Record payment — ' + naira(outstanding) + ' outstanding',
    submitLabel: editing ? 'Save changes' : 'Save payment',
    fields: [
      { name: 'amount', label: 'Amount ₦', required: true, placeholder: String(currentAmount || outstanding), value: existing ? String(currentAmount) : String(outstanding > 0 ? outstanding : '') },
      { name: 'method', label: 'Method', type: 'select', options: ['Cash', 'Transfer', 'POS', 'NHIA'], value: currentMethod },
      { name: 'reference', label: 'Reference / POS RRN / Transfer ID', placeholder: 'e.g. POS terminal RRN, bank session ID…', value: currentRef },
      { name: 'notes', label: 'Receipt note', full: true, placeholder: '…', value: currentNotes },
    ],
    onSubmit: async (v) => {
      const amount = Number(v.amount)
      if (!editing && (!amount || amount <= 0)) {
        throw new Error('Amount must be greater than 0.')
      }
      if (editing && amount < 0) {
        throw new Error('Amount cannot be negative.')
      }
      if (!editing && amount > outstanding) {
        throw new Error('Amount exceeds the outstanding balance (' + naira(outstanding) + '). Record a credit note first if this is an overpayment.')
      }
      try {
        if (!editing) {
          const result = await recordPayment({
            invoice_id: id,
            amount_kobo: Math.round(amount * 100),
            method: v.method || 'Cash',
            reference: (v.reference || '').trim(),
            notes: (v.notes || '').trim(),
          })
          closeModal()
          toast('Payment recorded — ' + result.status + ' (' + result.receiptNumber + ')')

          // Automatically print official receipt upon successful payment
          try {
            const orgName = authStore.getState().activeOrgName || 'Hospital'
            const staffName = authStore.getState().user?.displayName || 'Cashier'
            const receiptHtml = receiptPrintHtml({
              hospitalName: orgName,
              payment: {
                receipt_number: result.receiptNumber,
                paid_at: Date.now(),
                amount_kobo: Math.round(amount * 100),
                method: v.method || 'Cash',
                reference: (v.reference || '').trim(),
                notes: (v.notes || '').trim(),
                paid_by: staffName,
              },
              invoice: {
                invoiceId: invoiceId,
                patientName: patientName,
                payer: invoice.payer || 'Self-pay',
                outstanding: result.newOutstanding,
              },
              receivedBy: staffName,
            })
            printDocument('Receipt-' + result.receiptNumber, receiptHtml)
          } catch (printErr) {
            console.warn('[payment] receipt auto-print failed:', printErr?.message)
          }

          if (onSuccess) onSuccess(result)
        } else {
          closeModal()
          toast('Payment updated')
          if (onSuccess) onSuccess({
            amount_kobo: Math.round(amount * 100),
            method: v.method || 'Cash',
            reference: (v.reference || '').trim(),
            notes: (v.notes || '').trim(),
          })
        }
      } catch (e) {
        throw new Error(friendlyWriteError(e))
      }
    },
    onClose: () => {
      if (onClose) onClose()
    },
  })

  document.getElementById('modalTitle').textContent = editing
    ? 'Edit payment — ' + patientName + ' · ' + invoiceId.slice(0, 8)
    : 'Record payment — ' + patientName + ' · ' + invoiceId.slice(0, 8)
}
