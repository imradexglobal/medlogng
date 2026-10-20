// Shared payment modal — used by BillingView and InvoiceDetailView.
// Single place for amount validation (no overpayment without a credit note),
// method selection and the recordPayment call. When `editing` is true, the
// modal pre-fills from `existing` and returns the new values via onSuccess
// (the caller decides whether to call recordPayment or updatePayment).
import { formModal, closeModal, toast } from './shell.js'
import { recordPayment } from '../services/billingService.js'
import { friendlyWriteError } from '../utils/errors.js'
import { naira } from '../utils/format.js'

export function openPaymentModal({ invoice, onSuccess, onClose, editing = false, existing = null }) {
  const outstanding = Number(invoice.outstanding || 0)
  const id = invoice.id
  const patientName = invoice.patientName || '—'
  const invoiceId = invoice.invoiceId || id
  const currentAmount = existing ? Number(existing.amount || 0) : 0
  const currentMethod = existing ? existing.method || 'Cash' : 'Cash'
  const currentNotes = existing ? existing.notes || '' : ''

  formModal({
    title: editing
      ? 'Edit payment — ' + patientName + ' · ' + invoiceId.slice(0, 8)
      : 'Record payment — ' + naira(outstanding) + ' outstanding',
    submitLabel: editing ? 'Save changes' : 'Save payment',
    fields: [
      { name: 'amount', label: 'Amount ₦', required: true, placeholder: String(currentAmount || outstanding), value: existing ? String(currentAmount) : '' },
      { name: 'method', label: 'Method', type: 'select', options: ['Cash', 'Transfer', 'POS', 'NHIA'], value: currentMethod },
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
            notes: v.notes || '',
          })
          closeModal()
          toast('Payment recorded — ' + result.status)
          if (onSuccess) onSuccess(result)
        } else {
          closeModal()
          toast('Payment updated')
          if (onSuccess) onSuccess({
            amount_kobo: Math.round(amount * 100),
            method: v.method || 'Cash',
            notes: v.notes || '',
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
