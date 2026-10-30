// Billing data layer (direct Firestore, Spark plan: no backend).
// Invoices + payments + price catalogue + NHIA/HMO claims
// CRITICAL: Preserves existing billing calculations - do not change charge/discount logic
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit, startAfter,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'
import { fmtDate } from '../utils/format.js'
import { currentStaffName } from '../lib/staffName.js'

const INVOICES = 'invoices'
const PAYMENTS = 'payments'

// Live listeners are bounded to the 100 most recent rows (cost control);
// list* stays unbounded so a manual refresh still shows everything.
const LIVE_LIMIT = 100

// ---- capability check --------------------------------------------------------
export function myBillingCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canInvoice: can(me, 'billing.invoice'),
    canPayment: can(me, 'billing.payment'),
  }
}

// ---- invoice model shape ---------------------------------------------------
function toInvoiceRow(r) {
  const total = (r.total_kobo || 0) / 100  // convert kobo to naira for display
  const paid = (r.paid_kobo || 0) / 100
  const outstanding = Math.max(0, total - paid)
  return {
    id: r.id,
    invoiceId: r.invoice_id || r.id,
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    payer: r.payer || 'Self-pay',
    pa_code: r.pa_code || '',
    items: r.items || [],
    lines: Array.isArray(r.lines) ? r.lines : [],
    total: total,  // in naira (kobo-safe)
    paid: paid,    // in naira
    outstanding: outstanding,  // in naira
    status: r.status || 'unpaid',
    date: r.date || '',
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
// Single equality filter only (no composite index needed, works offline).
function buildOrgInvoicesQuery(orgId) {
  return query(collection(db, INVOICES), where('organization_id', '==', orgId))
}

function mapInvoiceDoc(d) {
  return toInvoiceRow({ ...d.data(), id: d.id })
}

// Client-side filter + sort shared by listOrgInvoices and
// subscribeOrgInvoices so live rows match one-shot rows exactly.
function applyInvoiceFilters(rows, filters = {}) {
  if (filters.status && filters.status !== 'all') rows = rows.filter((r) => r.status === filters.status)
  if (filters.payer && filters.payer !== 'all') rows = rows.filter((r) => r.payer === filters.payer)
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function listOrgInvoices(orgId, filters = {}) {
  const snap = await getDocs(buildOrgInvoicesQuery(orgId))
  return applyInvoiceFilters(snap.docs.map(mapInvoiceDoc), filters)
}

// Next chunk of the newest-first list (cursor-walked for infinite scroll).
// Needs index:
// invoices: organization_id ASC + created_at DESC.
export const INVOICES_PAGE = 25

export async function listOrgInvoicesPage(orgId, { pageSize = INVOICES_PAGE, cursor = null, ...filters } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, INVOICES),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: applyInvoiceFilters(docs.map(mapInvoiceDoc), filters), hasMore, cursor: next }
}

// Live query: same org scope + row shape as listOrgInvoices, but bounded to
// the 100 most recent (orderBy+limit needs the composite index in
// firestore.indexes.json — deploy it or the listener falls back to one-shot).
function buildOrgInvoicesLiveQuery(orgId) {
  return query(
    collection(db, INVOICES),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgInvoices(orgId, onRows, onError) {
  return watchQuery(
    buildOrgInvoicesLiveQuery(orgId),
    mapInvoiceDoc,
    (rows) => onRows(applyInvoiceFilters(rows)),
    onError,
  )
}

export async function listPatientInvoices(pid, { limitN = 50 } = {}) {
  const snap = await getDocs(query(collection(db, INVOICES), where('patient_id', '==', pid), limit(limitN)))
  const rows = snap.docs.map((d) => toInvoiceRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function listSessionInvoices(sid) {
  const snap = await getDocs(query(
    collection(db, INVOICES),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

export async function getInvoice(iid) {
  const snap = await getDoc(doc(db, INVOICES, iid))
  if (!snap.exists()) return null
  return toInvoiceRow({ ...snap.data(), id: snap.id })
}

// Payments recorded against a specific invoice
export async function listInvoicePayments(iid) {
  if (!iid) return []
  const snap = await getDocs(query(
    collection(db, PAYMENTS),
    where('invoice_id', '==', iid),
  ))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))
    return ms(b.paid_at) - ms(a.paid_at)
  })
}

// ---- create invoice -------------------------------------------------------
export async function createInvoice(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myBillingCaps()
  if (!caps.canInvoice) {
    throw new Error('Your role cannot create invoices (missing "billing.invoice" capability). Ask an administrator.')
  }

  const pid = input.patient_id
  if (!pid) throw new Error('Patient is required.')
  if (!input.item || !input.qty) throw new Error('Item and quantity are required.')

  const priceKobo = Math.round(Number(input.unit_price_kobo || 0) || 0)
  const qty = Math.max(1, Math.round(Number(input.qty) || 1))
  const totalKobo = priceKobo * qty
  const itemsText = input.item + ' · ' + qty + ' × ₦' + (priceKobo / 100).toLocaleString('en-NG')

  const invoiceId = doc(collection(db, INVOICES)).id
  const now = serverTimestamp()
  const invoice = {
    invoice_id: invoiceId,
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    payer: input.payer || 'Self-pay',
    pa_code: String(input.pa_code || '').trim(),
    items: itemsText,
    lines: [{
      label: input.item,
      category: 'Service',
      unit_price_kobo: priceKobo,
      qty,
    }],
    total_kobo: totalKobo,  // stored in kobo for precision
    paid_kobo: 0,  // initially 0
    status: 'unpaid',
    date: input.date || fmtDate(Date.now()),
    admission_session_id: input.admission_session_id || '',
    encounter_id: input.encounter_id || '',
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: now,
    updated_at: now,
  }

  await setDoc(doc(db, INVOICES, invoiceId), invoice)

  try {
    await logAudit({ action: 'invoice.created', organizationId: activeOrg, patientId: pid, details: 'Invoice ' + invoiceId + ' - ' + input.patient_name })
  } catch (e) {
    console.warn('[billing] audit append failed:', e?.message)
  }
  return { id: invoiceId, ...invoice }
}

// ---- create invoice from explicit lines (LIMS / Pharmacy / Manual integration) --
export async function createInvoiceFromLines(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myBillingCaps()
  if (!caps.canInvoice) {
    throw new Error('Your role cannot create invoices (missing "billing.invoice" capability). Ask an administrator.')
  }
  const pid = input.patient_id
  if (!pid) throw new Error('Patient is required.')
  const rawLines = Array.isArray(input.lines) ? input.lines : []
  if (!rawLines.length) throw new Error('An invoice needs at least one line.')

  const lines = []
  let totalKobo = 0
  for (const l of rawLines) {
    const label = String(l.label || '').trim()
    if (!label) throw new Error('Every invoice line needs a label.')
    const unit = Math.round(Number(l.unit_price_kobo) || 0)
    const qty = Math.max(1, Math.round(Number(l.qty) || 1))
    if (unit < 0) throw new Error('Line price cannot be negative: ' + label)
    totalKobo += unit * qty
    lines.push({
      label, category: String(l.category || 'Service').trim(),
      unit_price_kobo: unit, qty,
      ref_type: String(l.ref_type || '').trim(), ref_id: String(l.ref_id || '').trim(),
    })
  }

  const invoiceId = doc(collection(db, INVOICES)).id
  const now = serverTimestamp()
  const invoice = {
    invoice_id: invoiceId,
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    payer: input.payer || 'Self-pay',
    pa_code: String(input.pa_code || '').trim(),
    // Legacy TEXT summary (BillingView renders this as-is).
    items: lines.map((l) => l.label + (l.qty > 1 ? ' ×' + l.qty : '') + ' · ₦' + (l.unit_price_kobo / 100).toLocaleString('en-NG')).join('; '),
    lines,
    total_kobo: totalKobo,
    paid_kobo: 0,
    status: 'unpaid',
    date: input.date || fmtDate(Date.now()),
    admission_session_id: input.admission_session_id || '',
    encounter_id: input.encounter_id || '',
    source_type: String(input.source_type || '').trim(),
    source_id: String(input.source_id || '').trim(),
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: now,
    updated_at: now,
  }
  await setDoc(doc(db, INVOICES, invoiceId), invoice)
  try {
    await logAudit({
      action: 'invoice.created', organizationId: activeOrg, patientId: pid,
      details: 'Invoice ' + invoiceId + ' · ' + lines.length + ' line(s) · ₦' + (totalKobo / 100).toLocaleString('en-NG') + (input.source_type ? ' · ' + input.source_type : ''),
    })
  } catch (e) {
    console.warn('[billing] audit append failed:', e?.message)
  }
  return { id: invoiceId, ...invoice }
}

// Bill a lab order: one invoice line per ordered test, using each item's
// FROZEN price snapshot (catalogue price changes never rewrite history),
// then stamp the order with invoice_id + billing_status='invoiced'.
export async function createInvoiceForLabOrder(labOrder, opts = {}) {
  if (!labOrder || !labOrder.patientId) throw new Error('Lab order is required.')
  const items = Array.isArray(labOrder.items) && labOrder.items.length
    ? labOrder.items
    : (labOrder.tests || []).map((name) => ({ test_name: name, price_kobo: 0, item_id: '' }))
  const billable = items.filter((it) => it.status !== 'cancelled')
  if (!billable.length) throw new Error('This lab order has no billable tests.')
  const invoice = await createInvoiceFromLines({
    patient_id: labOrder.patientId,
    patient_name: labOrder.patientName || '',
    admission_session_id: labOrder.admissionSessionId || '',
    encounter_id: labOrder.encounterId || '',
    payer: opts.payer,
    pa_code: opts.pa_code || '',
    source_type: 'lab_order',
    source_id: labOrder.id,
    lines: billable.map((it) => ({
      label: it.test_name || 'Lab test',
      category: 'Lab',
      unit_price_kobo: Number(it.price_kobo) || 0,
      qty: 1,
      ref_type: 'lab_order_item',
      ref_id: it.item_id || '',
    })),
  })
  const { stampLabInvoice } = await import('./laboratoryService.js')
  await stampLabInvoice(labOrder.id, invoice.id)
  return invoice
}

// ---- record payment ------------------------------------------------------
export async function recordPayment(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myBillingCaps()
  if (!caps.canPayment) {
    throw new Error('Your role cannot record payments (missing "billing.payment" capability). Ask an administrator.')
  }

  const iid = input.invoice_id
  if (!iid) throw new Error('Invoice is required.')
  const amountKobo = Number(input.amount_kobo || input.amount || 0)

  // Get current invoice
  const invoice = await getInvoice(iid)
  if (!invoice) throw new Error('Invoice not found.')

  const currentPaid = invoice.raw?.paid_kobo || 0
  const newPaidKobo = currentPaid + amountKobo
  const totalKobo = invoice.raw?.total_kobo || 0
  const outstandingKobo = totalKobo - newPaidKobo

  // Determine status
  let status = 'unpaid'
  if (outstandingKobo <= 0) {
    status = 'paid'
  } else if (outstandingKobo < totalKobo) {
    status = 'part-paid'
  }

  await updateDoc(doc(db, INVOICES, iid), {
    paid_kobo: newPaidKobo,
    status: status,
    updated_at: serverTimestamp(),
  })

  // Record the payment transaction
  const paymentId = doc(collection(db, PAYMENTS)).id
  const receiptNumber = 'REC-' + paymentId.slice(0, 8).toUpperCase()
  await setDoc(doc(db, PAYMENTS, paymentId), {
    invoice_id: iid,
    invoice_number: iid,
    patient_id: invoice.patientId || '',
    patient_name: invoice.patientName || '',
    amount_kobo: amountKobo,
    amount_naira: amountKobo / 100,
    method: input.method || 'Cash',
    reference: input.reference || '',
    receipt_number: receiptNumber,
    paid_by: currentStaffName(),
    paid_at: serverTimestamp(),
    organization_id: activeOrg,
    notes: input.notes || '',
  })

  try {
    await logAudit({ action: 'payment.recorded', organizationId: activeOrg, patientId: invoice.patientId, details: 'Payment ' + paymentId + ' (' + receiptNumber + ') - ₦' + (amountKobo / 100).toLocaleString('en-NG') })
  } catch (e) {
    console.warn('[billing] audit append failed:', e?.message)
  }

  return {
    invoiceId: iid,
    paymentId: paymentId,
    receiptNumber: receiptNumber,
    receipt_number: receiptNumber,
    reference: input.reference || '',
    method: input.method || 'Cash',
    amount: amountKobo / 100,  // in naira
    newOutstanding: Math.max(0, outstandingKobo / 100),
    status: status,
  }
}

// ---- list payments for an org (unbounded for reporting) --------------------
export async function listOrgPayments(orgId) {
  if (!orgId) return []
  const snap = await getDocs(query(
    collection(db, PAYMENTS),
    where('organization_id', '==', orgId),
  ))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => {
    const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))
    return ms(b.paid_at) - ms(a.paid_at)
  })
}

// ---- paginated payments for org --------------------------------------------
export const PAYMENTS_PAGE = 30
export async function listOrgPaymentsPage(orgId, { pageSize = PAYMENTS_PAGE, cursor = null } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, PAYMENTS),
    where('organization_id', '==', orgId),
    orderBy('paid_at', 'desc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: docs.map((d) => ({ id: d.id, ...d.data() })), hasMore, cursor: next }
}

// ---- edit a previously saved payment -------------------------------------
// Adjusts the invoice's paid_kobo by the difference and updates the payment
// record (amount, method, reference, notes). The original payment is never deleted — the
// ledger stays intact because the invoice total is recomputed from the delta.
export async function updatePayment(paymentId, { amount_kobo, method, reference, notes }) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myBillingCaps()
  if (!caps.canPayment) {
    throw new Error('Your role cannot edit payments (missing "billing.payment" capability).')
  }

  const paymentSnap = await getDoc(doc(db, PAYMENTS, paymentId))
  if (!paymentSnap.exists()) throw new Error('Payment not found.')
  const payment = paymentSnap.data()
  if (payment.organization_id !== activeOrg) throw new Error('This payment belongs to a different hospital.')

  const newAmount = Math.round(Number(amount_kobo) || 0)
  if (newAmount < 0) throw new Error('Amount cannot be negative.')

  const oldAmount = Number(payment.amount_kobo || 0)
  const delta = newAmount - oldAmount

  // Get current invoice
  const invoice = await getInvoice(payment.invoice_id)
  if (!invoice) throw new Error('Linked invoice not found.')

  const currentPaid = invoice.raw?.paid_kobo || 0
  const newPaidKobo = currentPaid + delta
  const totalKobo = invoice.raw?.total_kobo || 0
  const outstandingKobo = totalKobo - newPaidKobo

  let status = 'unpaid'
  if (outstandingKobo <= 0) {
    status = 'paid'
  } else if (outstandingKobo < totalKobo) {
    status = 'part-paid'
  }

  // Update the invoice's paid_kobo by the delta
  await updateDoc(doc(db, INVOICES, payment.invoice_id), {
    paid_kobo: newPaidKobo,
    status: status,
    updated_at: serverTimestamp(),
  })

  // Update the payment record
  await updateDoc(doc(db, PAYMENTS, paymentId), {
    amount_kobo: newAmount,
    amount_naira: newAmount / 100,
    method: method || payment.method || 'Cash',
    reference: reference != null ? reference : (payment.reference || ''),
    notes: notes != null ? notes : (payment.notes || ''),
    updated_at: serverTimestamp(),
  })

  try {
    await logAudit({ action: 'payment.edited', organizationId: activeOrg, patientId: invoice.patientId, details: 'Payment ' + paymentId + ' · ₦' + (oldAmount / 100).toLocaleString('en-NG') + ' → ₦' + (newAmount / 100).toLocaleString('en-NG') })
  } catch (e) {
    console.warn('[billing] audit append failed:', e?.message)
  }

  return { invoiceId: payment.invoice_id, paymentId, amount: newAmount / 100, newOutstanding: Math.max(0, outstandingKobo / 100), status }
}
