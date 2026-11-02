// Hub-side delivery handlers — the server twin of the browser outbox.
//
// The browser outbox replays ops by re-running the browser service functions;
// the hub cannot (they import the browser SDK + auth store), so each op kind
// gets a small admin-SDK implementation here. The RULES are not duplicated:
// line normalisation and merge semantics are imported from the app's pure
// module `src/features/pharmacy/requests.js`, so browser and hub can never
// disagree about what "same medicine, same dosage" means.
//
// SECURITY: the Admin SDK bypasses Firestore Rules, so this file is the last
// line of defence. Every op carries an orgId + actor that were verified by
// hub/auth.js when the op was accepted; the client cannot supply either. Each
// write additionally proves the record belongs to that hospital:
//
//   patients/{id}                  must exist
//   encounters/{id}                organization_id must equal the op's org
//   admissions/{id}                organization_id must equal the op's org
//   organization_patients/{o}_{p}  link used when there is no encounter/stay
//
// Idempotency (safe re-delivery — the whole point of a relay):
//   rx_mirror  — every op carries a stable sync key; it is recorded on the
//                request doc in `sync_keys`, and a replay with a key we
//                already hold FOR THE SAME ORG is skipped before any write.
//   lab_snapshot — keyed by lab_order_id, same as the browser path.

import { FieldValue } from 'firebase-admin/firestore'
import { initFoundation } from './foundation.js'
import {
  toLine, mergeRequestLine, normalizeRequest, isOpenRequest, REQUEST_STATUS, toRequestItems, applyIssue, statusForProgress, requestProgress,
} from '../src/features/pharmacy/requests.js'
import {
  exceedsOrder, applyAdministration, buildDoseEvent, lineRemainingToGive, lineGiven,
} from '../src/features/pharmacy/administration.js'

// Data problems that retrying can never fix. The relay marks these 'error'
// instead of burning backoff cycles.
export class PermanentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermanentError'
    this.permanent = true
  }
}

const REQUESTS = 'medication_requests'
const ENCOUNTERS = 'encounters'
const ADMISSIONS = 'admissions'
const PATIENTS = 'patients'
const ORG_PATIENTS = 'organization_patients'
const LAB_ORDERS = 'lab_orders'
const INVOICES = 'invoices'
const PAYMENTS = 'payments'

// firebase-admin: emulator mode needs no key file (FIRESTORE_EMULATOR_HOST).
// Production refuses to create a client without credentials instead of
// starting and crashing on the first call (see foundation.js).
export function initFirestore(cfg) {
  const foundation = initFoundation(cfg)
  if (!foundation.db) throw new Error(foundation.error || 'Firestore is not configured')
  return foundation.db
}

// ---- ownership helpers -----------------------------------------------------

function orgOf(data) {
  return String(data?.organization_id || '')
}

async function getPatient(db, patientId) {
  const snap = await db.collection(PATIENTS).doc(patientId).get()
  if (!snap.exists) throw new PermanentError('patient ' + patientId + ' does not exist')
  return snap.data() || {}
}

// An encounter is only usable if it exists AND belongs to this hospital. A
// missing organization_id is rejected: it cannot be attributed to any tenant.
async function getOrgEncounter(db, orgId, encounterId, patientId = '') {
  const snap = await db.collection(ENCOUNTERS).doc(encounterId).get()
  if (!snap.exists) throw new PermanentError('encounter ' + encounterId + ' does not exist')
  const data = snap.data() || {}
  const rowOrg = orgOf(data)
  if (!rowOrg) throw new PermanentError('encounter ' + encounterId + ' has no organization (cannot verify ownership)')
  if (rowOrg !== orgId) throw new PermanentError('encounter belongs to a different hospital')
  if (patientId && data.patient_id && data.patient_id !== patientId) {
    throw new PermanentError('encounter does not belong to patient ' + patientId)
  }
  return { id: encounterId, data }
}

async function getOrgAdmission(db, orgId, admissionId, patientId = '') {
  const snap = await db.collection(ADMISSIONS).doc(admissionId).get()
  if (!snap.exists) throw new PermanentError('admission session ' + admissionId + ' does not exist')
  const data = snap.data() || {}
  const rowOrg = orgOf(data)
  if (!rowOrg) throw new PermanentError('admission session has no organization (cannot verify ownership)')
  if (rowOrg !== orgId) throw new PermanentError('admission session belongs to a different hospital')
  const rowPatient = String(data.patient_id || data.patientId || '')
  if (patientId && rowPatient && rowPatient !== patientId) {
    throw new PermanentError('admission session does not belong to patient ' + patientId)
  }
  return { id: admissionId, data }
}

// This hospital must have a care relationship with the patient before it can
// write clinical data for them. The canonical patient registry is shared (the
// agreed read model), so ownership is proven by the org's own link, by the
// patient having been registered here, or by an org-owned encounter/stay.
async function assertPatientAccess(db, orgId, patientId, { encounterId = '', admissionSessionId = '' } = {}) {
  const patient = await getPatient(db, patientId)
  if (encounterId) {
    await getOrgEncounter(db, orgId, encounterId, patientId)
    return patient
  }
  if (admissionSessionId) {
    await getOrgAdmission(db, orgId, admissionSessionId, patientId)
    return patient
  }
  if (orgOf(patient) === orgId) return patient
  const link = await db.collection(ORG_PATIENTS).doc(orgId + '_' + patientId).get()
  if (link.exists) return patient
  throw new PermanentError('patient ' + patientId + ' is not registered with this hospital')
}

function restoreMutationValues(value) {
  if (Array.isArray(value)) return value.map(restoreMutationValues)
  if (!value || typeof value !== 'object') return value
  if (value.__firestoreType === 'serverTimestamp') return FieldValue.serverTimestamp()
  if (value.__firestoreType === 'timestamp' && typeof value.value === 'string') {
    const date = new Date(value.value)
    if (!Number.isFinite(date.getTime())) throw new PermanentError('mutation contains an invalid timestamp')
    return date
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = restoreMutationValues(item)
  return out
}
function sameMutationValue(left, right) {
  if (right && typeof right === 'object' && right.__firestoreType === 'serverTimestamp') return true
  const normalize = (value) => {
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
    return value
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(restoreMutationValues(right)))
}

// Narrow shared write bridge for non-ledger documents. Transaction-sensitive
// pharmacy, payment, admission and append-only records use dedicated handlers.
export async function handleDocumentMutation(db, op) {
  const mutations = op.args?.mutations || []
  if (!mutations.length || !op.orgId) throw new PermanentError('document_mutation op is incomplete')
  if (mutations[0].collection === 'lab_orders' && op.authorizedCapability === 'billing.invoice') {
    const allowed = new Set(['invoice_id', 'billing_status', 'invoice_total_kobo', 'updated_at'])
    if (mutations.some((m) => Object.keys(m.data || {}).some((key) => !allowed.has(key)))) throw new PermanentError('billing staff may only update invoice stamps on a lab order')
  }
  if (mutations[0].collection === 'lab_orders' && op.authorizedCapability === 'billing.payment') {
    const allowed = new Set(['paid_kobo', 'payment_recorded_at', 'updated_at'])
    if (mutations.some((m) => Object.keys(m.data || {}).some((key) => !allowed.has(key)))) throw new PermanentError('payment staff may only update payment stamps on a lab order')
  }
  if (mutations[0].collection === 'encounters' && op.authorizedCapability === 'encounter.status.advance' &&
      mutations.some((m) => Object.keys(m.data || {}).some((key) => !['status', 'updated_at'].includes(key)))) {
    throw new PermanentError('status-only staff may only advance encounter status')
  }
  const refs = mutations.map((m) => db.collection(m.collection).doc(m.id))
  return db.runTransaction(async (tx) => {
    const snaps = await Promise.all(refs.map((ref) => tx.get(ref)))
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i]
      const snap = snaps[i]
      const existing = snap.exists ? snap.data() || {} : null
      if (existing && orgOf(existing) !== op.orgId) throw new PermanentError('record belongs to a different hospital')
      if (!existing && !['create', 'merge'].includes(mutation.action)) {
        if (mutation.action === 'delete') continue // an idempotent replay
        throw new PermanentError('record to update does not exist')
      }
      if (mutation.action === 'create' && existing) {
        if (existing.organization_id !== op.orgId) throw new PermanentError('record id already belongs to another hospital')
        // A repeated create must not overwrite data created by a concurrent writer.
        if (Object.entries(mutation.data || {}).every(([key, value]) => sameMutationValue(existing[key], value))) continue
        throw new PermanentError('record id already exists with different content')
      }
    }
    const actor = op.actor || {}
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i]
      const existing = snaps[i].exists ? snaps[i].data() || {} : null
      if (mutation.action === 'delete') {
        if (existing) tx.delete(refs[i])
      } else if (mutation.action === 'create') {
        if (!existing) tx.create(refs[i], {
          ...restoreMutationValues(mutation.data),
          organization_id: op.orgId,
          ...(actor.uid ? { created_by: actor.uid } : {}),
          ...(actor.name || actor.email ? { created_by_name: actor.name || actor.email } : {}),
          updated_at: FieldValue.serverTimestamp(),
        })
      } else if (mutation.action === 'merge') {
        tx.set(refs[i], { ...restoreMutationValues(mutation.data), organization_id: op.orgId,
          updated_at: FieldValue.serverTimestamp() }, { merge: true })
      } else {
        tx.update(refs[i], { ...restoreMutationValues(mutation.data), updated_at: FieldValue.serverTimestamp() })
      }
    }
    return { applied: mutations.length }
  })
}

// ---- rx_mirror -------------------------------------------------------------

async function findOpenRequest(db, { orgId, patientId, encounterId = '', admissionSessionId = '' }) {
  const col = db.collection(REQUESTS)
  // Same scope priority as the browser: admission stay > encounter > patient.
  let q = col.where('organization_id', '==', orgId)
  if (admissionSessionId) q = q.where('admission_session_id', '==', admissionSessionId)
  else if (encounterId) q = q.where('encounter_id', '==', encounterId)
  else if (patientId) q = q.where('patient_id', '==', patientId)
  else return null
  const snap = await q.get()
  const open = snap.docs
    .map((d) => normalizeRequest({ id: d.id, ...d.data() }))
    // The query is already org-scoped, but an inconsistent legacy doc must not
    // let one patient's script be appended to another patient's request.
    .filter((r) => !patientId || !r.patientId || r.patientId === patientId)
    .filter((r) => isOpenRequest(r.status) || r.status === REQUEST_STATUS.EXTERNAL)
  return open[0] || null
}

export async function handleRxMirror(db, op) {
  const args = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId) throw new PermanentError('op has no organization id')
  if (!args.patientId) throw new PermanentError('rx_mirror op has no patientId')

  await assertPatientAccess(db, orgId, args.patientId, {
    encounterId: args.encounterId || '',
    admissionSessionId: args.admissionSessionId || '',
  })

  const lines = (args.lines || [])
    .map((l, i) => toLine(l, i))
    .filter((l) => l.medicine || l.drug_id)
  if (!lines.length) throw new PermanentError('rx_mirror op has no usable medicine lines')

  const syncKey = op.clientOpKey || ''
  const col = db.collection(REQUESTS)

  // 1. Replay guard. No composite index: array-contains alone, then verify the
  //    hit belongs to this org. A key collision from another hospital (legacy
  //    `v1:*` keys are only unique per device) must not suppress this write.
  if (syncKey) {
    const dup = await col.where('sync_keys', 'array-contains', syncKey).get()
    const own = dup.docs.find((d) => orgOf(d.data()) === orgId)
    if (own) return { id: own.id, deduped: true, created: false }
  }

  // 2. Append to the open script, or open a new one — exactly what the
  //    browser function does.
  const existing = await findOpenRequest(db, {
    orgId,
    patientId: args.patientId,
    encounterId: args.encounterId,
    admissionSessionId: args.admissionSessionId,
  })

  if (existing) {
    let items = existing.items || existing.raw?.items || []
    for (const line of lines) items = mergeRequestLine(items, line)
    const updateData = { items, updated_at: FieldValue.serverTimestamp() }
    if (syncKey) updateData.sync_keys = FieldValue.arrayUnion(syncKey)
    if (args.admissionSessionId && existing.raw?.admission_session_id !== args.admissionSessionId) {
      updateData.admission_session_id = args.admissionSessionId
    }
    await col.doc(existing.id).update(updateData)
    return { id: existing.id, deduped: false, created: false }
  }

  const actor = op.actor && typeof op.actor === 'object' ? op.actor : {}
  const ref = col.doc()
  await ref.set({
    patient_id: args.patientId,
    patient_name: args.patientName || '',
    encounter_id: args.encounterId || '',
    admission_session_id: args.admissionSessionId || '',
    organization_id: orgId,
    items: lines,
    status: REQUEST_STATUS.REQUESTED,
    // Verified identity, never a browser-supplied actor.
    created_by: actor.uid || null,
    created_by_name: actor.name || actor.email || '',
    // Traceability: this script arrived via the hospital hub, not a browser.
    // Rows queued before the auth upgrade are marked separately so an operator
    // can see which writes predate verified identities.
    created_via: op.authVersion >= 2 ? 'lan-hub' : 'lan-hub-legacy',
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
    ...(syncKey ? { sync_keys: [syncKey] } : {}),
  })
  return { id: ref.id, deduped: false, created: true }
}

// ---- lab_snapshot ----------------------------------------------------------
// Server twin of consultationService.addLabOrder's append (the encounter copy
// of a lab order). The workflow-stage advance (advanceTo) intentionally stays
// browser-side: it encodes the SOAP wizard's transition rules, and a missing
// cosmetic stage advance during an outage is far safer than the hub guessing
// workflow state. Clinical data — the order itself — is written here.

export async function handleLabSnapshot(db, op) {
  const { encounterId, labOrder } = op.args || {}
  if (!encounterId) throw new PermanentError('lab_snapshot op has no encounterId')
  if (!labOrder || typeof labOrder !== 'object') throw new PermanentError('lab_snapshot op has no labOrder')
  if (!op.orgId) throw new PermanentError('op has no organization id')

  const { data } = await getOrgEncounter(db, op.orgId, encounterId)

  // If the canonical lab order already exists, it must belong to this
  // hospital. Absence is allowed: during an outage the browser's own create
  // may not have reached the cloud yet, and the snapshot is not the source of
  // truth for the lab workflow.
  const orderId = typeof labOrder.lab_order_id === 'string' ? labOrder.lab_order_id : ''
  if (orderId) {
    const orderSnap = await db.collection(LAB_ORDERS).doc(orderId).get()
    if (orderSnap.exists && orgOf(orderSnap.data()) !== op.orgId) {
      throw new PermanentError('lab order belongs to a different hospital')
    }
  }

  const id = orderId || ('lab_' + Date.now().toString(36))
  const existing = Array.isArray(data.lab_orders) ? data.lab_orders : []
  if (existing.some((o) => o && o.id === id)) return { id, deduped: true }

  const actor = op.actor && typeof op.actor === 'object' ? op.actor : {}
  await db.collection(ENCOUNTERS).doc(encounterId).update({
    lab_orders: [...existing, {
      ...labOrder,
      id,
      ordered_at: Date.now(),
      ...(actor.uid ? { ordered_by: actor.uid } : {}),
      ...(actor.name || actor.email ? { ordered_by_name: actor.name || actor.email } : {}),
    }],
    updated_at: FieldValue.serverTimestamp(),
  })
  return { id, deduped: false }
}

// ---- admission_create ------------------------------------------------------
// Create the admission and reserve its bed atomically at the LAN host. The
// browser may have an optimistic local copy already; stable IDs make relay
// delivery idempotent, while the claim doc prevents two devices taking one bed.
export async function handleAdmissionCreate(db, op) {
  const { admissionId, claimId, admission } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !admissionId || !claimId || !admission) throw new PermanentError('admission_create op is incomplete')
  if (admission.organization_id !== orgId) throw new PermanentError('admission belongs to a different hospital')
  await assertPatientAccess(db, orgId, admission.patient_id, { encounterId: admission.encounter_id || '' })
  const admissionRef = db.collection(ADMISSIONS).doc(admissionId)
  const claimRef = db.collection('bed_claims').doc(claimId)
  await db.runTransaction(async (tx) => {
    const [admissionSnap, claimSnap] = await Promise.all([tx.get(admissionRef), tx.get(claimRef)])
    if (admissionSnap.exists) {
      const existing = admissionSnap.data() || {}
      if (orgOf(existing) !== orgId || existing.patient_id !== admission.patient_id) {
        throw new PermanentError('admission id already belongs to another record')
      }
      if (existing.ward_name !== admission.ward_name || String(existing.bed_number) !== String(admission.bed_number) ||
          !claimSnap.exists || claimSnap.data()?.admission_id !== admissionId) {
        throw new PermanentError('admission already exists with a different or incomplete bed assignment')
      }
      return
    }
    if (claimSnap.exists && claimSnap.data()?.admission_id !== admissionId) {
      throw new PermanentError('bed is already reserved by another admission')
    }
    const actor = op.actor && typeof op.actor === 'object' ? op.actor : {}
    tx.set(admissionRef, {
      ...admission,
      created_by: actor.uid || null,
      created_by_name: actor.name || actor.email || '',
      created_via: 'lan-hub',
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    })
    tx.set(claimRef, {
      organization_id: orgId,
      ward_name: admission.ward_name,
      bed_number: admission.bed_number,
      admission_id: admissionId,
      patient_id: admission.patient_id,
      created_at: FieldValue.serverTimestamp(),
    })
  })
  return { id: admissionId, claimId, created: true }
}

export async function handleAdmissionDischarge(db, op) {
  const { admissionId, claimId, legacyClaimId, dischargeData } = op.args || {}
  const orgId = op.orgId || ''
  const admissionRef = db.collection(ADMISSIONS).doc(admissionId)
  const claimRefs = [...new Set([claimId, legacyClaimId].filter(Boolean))].map((id) => db.collection('bed_claims').doc(id))
  if (!orgId || !admissionId || !claimId || !dischargeData) throw new PermanentError('admission_discharge op is incomplete')
  return db.runTransaction(async (tx) => {
    const admissionSnap = await tx.get(admissionRef)
    const claimSnaps = await Promise.all(claimRefs.map((ref) => tx.get(ref)))
    if (!admissionSnap.exists) throw new PermanentError('admission no longer exists')
    const current = admissionSnap.data() || {}
    if (orgOf(current) !== orgId) throw new PermanentError('admission belongs to a different hospital')
    if (current.status === 'discharged' && current.discharge_type === dischargeData.discharge_type &&
        current.discharge_reason === dischargeData.discharge_reason) return { id: admissionId, deduped: true }
    if (current.status !== 'active') throw new PermanentError('admission is no longer active')
    const actor = op.actor || {}
    tx.update(admissionRef, {
      ...dischargeData,
      discharged_by: actor.uid || null,
      discharged_by_name: actor.name || actor.email || '',
      updated_at: FieldValue.serverTimestamp(),
    })
    for (let i = 0; i < claimRefs.length; i++) {
      if (!claimSnaps[i].exists) continue
      const claim = claimSnaps[i].data() || {}
      if (orgOf(claim) !== orgId || claim.admission_id !== admissionId) {
        throw new PermanentError('bed claim changed before discharge; review the bed board')
      }
      tx.delete(claimRefs[i])
    }
    return { id: admissionId, discharged: true }
  })
}

export async function handleAdmissionTransfer(db, op) {
  const { admissionId, oldClaimId, newClaimId, legacyOldClaimId, wardName, bedNumber, reason, transferAt } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !admissionId || !oldClaimId || !newClaimId || !wardName || !bedNumber || !reason) {
    throw new PermanentError('admission_transfer op is incomplete')
  }
  const admissionRef = db.collection(ADMISSIONS).doc(admissionId)
  const oldIds = [...new Set([oldClaimId, legacyOldClaimId].filter(Boolean))]
  const claimIds = [...new Set([...oldIds, newClaimId])]
  const claimRefs = new Map(claimIds.map((id) => [id, db.collection('bed_claims').doc(id)]))
  return db.runTransaction(async (tx) => {
    const admissionSnap = await tx.get(admissionRef)
    const claimSnaps = new Map()
    for (const [id, ref] of claimRefs) claimSnaps.set(id, await tx.get(ref))
    if (!admissionSnap.exists) throw new PermanentError('admission no longer exists')
    const current = admissionSnap.data() || {}
    if (orgOf(current) !== orgId) throw new PermanentError('admission belongs to a different hospital')
    if (current.status !== 'active') throw new PermanentError('only active admissions can be transferred')
    const destination = claimSnaps.get(newClaimId)
    if (destination?.exists) {
      const claim = destination.data() || {}
      if (orgOf(claim) !== orgId || claim.admission_id !== admissionId) throw new PermanentError('destination bed is occupied by another admission')
    }
    const prior = Array.isArray(current.transfer_history) ? current.transfer_history.at(-1) : null
    if (prior && current.ward_name === wardName && String(current.bed_number) === String(bedNumber) &&
        prior.at === transferAt && prior.reason === reason && destination?.exists && destination.data()?.admission_id === admissionId) {
      return { id: admissionId, deduped: true }
    }
    const source = oldIds.map((id) => ({ id, snap: claimSnaps.get(id) })).find(({ snap }) => snap?.exists && snap.data()?.admission_id === admissionId)
    if (!source) throw new PermanentError('current bed claim is missing; review the bed board before transferring')
    if (orgOf(source.snap.data()) !== orgId) throw new PermanentError('current bed claim belongs to another hospital')
    const history = Array.isArray(current.transfer_history) ? current.transfer_history : []
    tx.update(admissionRef, {
      ward_name: wardName,
      bed_number: bedNumber,
      transfer_history: [...history, {
        at: transferAt,
        from_ward: current.ward_name || '',
        from_bed: String(current.bed_number || ''),
        to_ward: wardName,
        to_bed: bedNumber,
        reason,
        staff_id: op.actor?.uid || '',
        staff_name: op.actor?.name || op.actor?.email || '',
      }],
      updated_at: FieldValue.serverTimestamp(),
    })
    if (newClaimId !== source.id) {
      tx.set(claimRefs.get(newClaimId), {
        organization_id: orgId, ward_name: wardName, bed_number: bedNumber,
        admission_id: admissionId, patient_id: current.patient_id || '', created_at: FieldValue.serverTimestamp(),
      })
      for (const id of oldIds) {
        if (id === newClaimId) continue
        const snap = claimSnaps.get(id)
        if (snap?.exists && snap.data()?.admission_id === admissionId) tx.delete(claimRefs.get(id))
      }
    }
    return { id: admissionId, transferred: true }
  })
}

export async function handleBillingPayment(db, op) {
  const { invoiceId, paymentId, amountKobo, method, reference, notes, labOrderId } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !invoiceId || !paymentId || !Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw new PermanentError('billing_payment op is incomplete')
  }
  const invoiceRef = db.collection(INVOICES).doc(invoiceId)
  const paymentRef = db.collection(PAYMENTS).doc(paymentId)
  const labRef = labOrderId ? db.collection(LAB_ORDERS).doc(labOrderId) : null
  return db.runTransaction(async (tx) => {
    const invoiceSnap = await tx.get(invoiceRef)
    const paymentSnap = await tx.get(paymentRef)
    const labSnap = labRef ? await tx.get(labRef) : null
    if (paymentSnap.exists) {
      const existing = paymentSnap.data() || {}
      if (orgOf(existing) === orgId && existing.invoice_id === invoiceId && Number(existing.amount_kobo) === amountKobo) {
        return { id: paymentId, deduped: true, paidKobo: Number(invoiceSnap.data()?.paid_kobo || 0) }
      }
      throw new PermanentError('payment id already belongs to another payment')
    }
    if (!invoiceSnap.exists) throw new PermanentError('invoice no longer exists')
    const invoice = invoiceSnap.data() || {}
    if (orgOf(invoice) !== orgId) throw new PermanentError('invoice belongs to a different hospital')
    const newPaid = Math.max(0, Number(invoice.paid_kobo) || 0) + amountKobo
    const total = Math.max(0, Number(invoice.total_kobo) || 0)
    const status = newPaid >= total ? 'paid' : (newPaid > 0 ? 'part-paid' : 'unpaid')
    const actor = op.actor || {}
    const receiptNumber = 'REC-' + paymentId.slice(0, 8).toUpperCase()
    tx.update(invoiceRef, { paid_kobo: newPaid, status, updated_at: FieldValue.serverTimestamp() })
    tx.create(paymentRef, {
      invoice_id: invoiceId,
      invoice_number: invoice.invoice_number || invoiceId,
      lab_order_id: labOrderId || '',
      patient_id: invoice.patient_id || '',
      patient_name: invoice.patient_name || '',
      amount_kobo: amountKobo,
      amount_naira: amountKobo / 100,
      method,
      reference: reference || '',
      receipt_number: receiptNumber,
      paid_by: actor.name || actor.email || actor.uid || '',
      paid_at: FieldValue.serverTimestamp(),
      organization_id: orgId,
      notes: notes || '',
    })
    if (labRef && labSnap?.exists && orgOf(labSnap.data()) === orgId) {
      tx.update(labRef, { paid_kobo: newPaid, payment_recorded_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() })
    }
    return { id: paymentId, receiptNumber, paidKobo: newPaid, status }
  })
}

export async function handleMedicationAdminister(db, op) {
  const { requestId, doseId, lineId, qty, route, site, note } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !requestId || !doseId || !lineId || !(qty > 0)) throw new PermanentError('medication_administer op is incomplete')
  const requestRef = db.collection(REQUESTS).doc(requestId)
  const doseRef = db.collection('medication_administrations').doc(doseId)
  return db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef)
    const doseSnap = await tx.get(doseRef)
    if (doseSnap.exists) {
      const existing = doseSnap.data() || {}
      if (orgOf(existing) === orgId && existing.medication_request_id === requestId && Number(existing.qty) === Number(qty)) {
        return { id: doseId, deduped: true }
      }
      throw new PermanentError('dose id already belongs to another medication event')
    }
    if (!requestSnap.exists) throw new PermanentError('prescription no longer exists')
    const requestData = requestSnap.data() || {}
    if (orgOf(requestData) !== orgId) throw new PermanentError('prescription belongs to a different hospital')
    const request = { id: requestId, ...requestData }
    const lines = toRequestItems(requestData)
    const line = lines.find((item) => item.line_id === lineId)
    if (!line) throw new PermanentError('prescription line no longer exists')
    if (exceedsOrder(line, qty)) throw new PermanentError('dose exceeds the remaining prescribed quantity')
    const event = buildDoseEvent({
      request, line, qty, route, site, note,
      user: { uid: op.actor?.uid || '', displayName: op.actor?.name || op.actor?.email || '' },
      activeOrg: orgId, now: FieldValue.serverTimestamp(),
    })
    const { items } = applyAdministration(lines, { [line.line_id]: qty })
    tx.update(requestRef, { items, updated_at: FieldValue.serverTimestamp() })
    tx.create(doseRef, event)
    const updatedLine = items.find((item) => item.line_id === lineId)
    return { id: doseId, remaining: lineRemainingToGive(updatedLine), givenTotal: lineGiven(updatedLine) }
  })
}

export async function handleStockReceive(db, op) {
  const { drugId, movementId, qty, batch, expiry, supplier, unitCost, invoiceRef } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !drugId || !movementId || !(qty > 0)) throw new PermanentError('stock_receive op is incomplete')
  if (!Number.isFinite(Date.parse(expiry)) || new Date(expiry).getTime() <= Date.now()) throw new PermanentError('stock batch expiry must be in the future')
  const lotRef = db.collection('stock_lots').doc(drugId)
  const movementRef = db.collection('stock_movements').doc(movementId)
  return db.runTransaction(async (tx) => {
    const lotSnap = await tx.get(lotRef)
    const movementSnap = await tx.get(movementRef)
    if (movementSnap.exists) {
      const movement = movementSnap.data() || {}
      if (orgOf(movement) === orgId && movement.drug_id === drugId && movement.type === 'in' && Number(movement.qty) === Number(qty)) {
        return { id: drugId, movementId, newStock: Number(lotSnap.data()?.stock || 0), deduped: true }
      }
      throw new PermanentError('stock movement id already belongs to another entry')
    }
    if (!lotSnap.exists) throw new PermanentError('stock lot no longer exists')
    const lot = lotSnap.data() || {}
    if (orgOf(lot) !== orgId) throw new PermanentError('stock lot belongs to a different hospital')
    const newStock = (Number(lot.stock) || 0) + Number(qty)
    const actor = op.actor || {}
    tx.update(lotRef, {
      stock: newStock, batch, expiry,
      purchase_price: unitCost != null ? Number(unitCost) : lot.purchase_price,
      status: newStock === 0 ? 'Out' : (newStock < 20 ? 'Low' : 'OK'),
      updated_at: FieldValue.serverTimestamp(),
    })
    tx.create(movementRef, {
      type: 'in', organization_id: orgId, drug_id: drugId, sku: lot.sku || '', name: lot.name || '',
      qty, batch, expiry, supplier: supplier || lot.supplier || '', unit_cost: unitCost || 0,
      invoice_ref: invoiceRef || '', received_at: FieldValue.serverTimestamp(),
      created_by: actor.uid || null, created_by_name: actor.name || actor.email || '',
      created_at: FieldValue.serverTimestamp(),
    })
    return { id: drugId, movementId, newStock }
  })
}

export async function handlePharmacyDispense(db, op) {
  const { dispensationId, patientId, patientName, medicationRequestId, items } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !dispensationId || !Array.isArray(items) || !items.length) throw new PermanentError('pharmacy_dispense op is incomplete')
  const lotRefs = new Map(items.map((item) => [item.drugId, db.collection('stock_lots').doc(item.drugId)]))
  const moveRefs = items.map((item) => db.collection('stock_movements').doc(item.movementId))
  const ticketRef = db.collection('dispensations').doc(dispensationId)
  const requestRef = medicationRequestId ? db.collection(REQUESTS).doc(medicationRequestId) : null
  return db.runTransaction(async (tx) => {
    const ticketSnap = await tx.get(ticketRef)
    const lotSnaps = new Map()
    for (const [id, ref] of lotRefs) lotSnaps.set(id, await tx.get(ref))
    const moveSnaps = await Promise.all(moveRefs.map((ref) => tx.get(ref)))
    const requestSnap = requestRef ? await tx.get(requestRef) : null
    if (ticketSnap.exists) {
      const ticket = ticketSnap.data() || {}
      if (orgOf(ticket) === orgId) return { dispensationId, deduped: true }
      throw new PermanentError('dispensation id already belongs to another hospital')
    }
    if (moveSnaps.some((snap) => snap.exists)) throw new PermanentError('one or more stock movement ids are already in use')
    if (requestRef && !requestSnap?.exists) throw new PermanentError('prescription request no longer exists')
    const requestData = requestSnap?.data() || {}
    if (requestSnap && orgOf(requestData) !== orgId) throw new PermanentError('prescription belongs to a different hospital')
    const existingLines = requestSnap ? toRequestItems(requestData) : []
    const issued = {}
    let mappable = true
    const aggregate = new Map()
    const structured = []
    for (const item of items) {
      const snap = lotSnaps.get(item.drugId)
      if (!snap?.exists) throw new PermanentError('stock lot ' + item.drugId + ' no longer exists')
      const lot = snap.data() || {}
      if (orgOf(lot) !== orgId) throw new PermanentError('stock lot belongs to a different hospital')
      aggregate.set(item.drugId, (aggregate.get(item.drugId) || 0) + Number(item.requestedQty))
      const lineId = item.lineId || (existingLines.length === 1 ? existingLines[0].line_id : '')
      const line = lineId ? existingLines.find((row) => row.line_id === lineId) : null
      if (line && line.external) throw new PermanentError('external prescriptions cannot be issued from hospital stock')
      if (requestSnap && lineId) issued[lineId] = (issued[lineId] || 0) + Number(item.requestedQty)
      else if (requestSnap) mappable = false
      structured.push({ item, lot, lineId })
    }
    for (const [drugId, total] of aggregate) {
      const lot = lotSnaps.get(drugId).data() || {}
      if ((Number(lot.stock) || 0) < total) throw new PermanentError('insufficient stock for ' + (lot.name || drugId))
    }
    const actor = op.actor || {}
    for (const [drugId, total] of aggregate) {
      const lot = lotSnaps.get(drugId).data() || {}
      const remaining = Math.max(0, (Number(lot.stock) || 0) - total)
      tx.update(lotRefs.get(drugId), { stock: remaining, batch: remaining > 0 ? (lot.batch || '') : '',
        expiry: remaining > 0 ? (lot.expiry || '') : '', status: remaining === 0 ? 'Out' : (remaining < 20 ? 'Low' : 'OK'),
        updated_at: FieldValue.serverTimestamp() })
    }
    for (const { item, lot, lineId } of structured) {
      tx.create(moveRefs[items.indexOf(item)], { type: 'out', organization_id: orgId, drug_id: item.drugId,
        sku: lot.sku || '', name: lot.name || '', qty: Number(item.requestedQty), batch: lot.batch || '', expiry: lot.expiry || '',
        patient_id: patientId || '', patient_name: patientName || '', dispensation_id: dispensationId,
        medication_request_id: medicationRequestId || '', created_by: actor.uid || null,
        created_by_name: actor.name || actor.email || '', created_at: FieldValue.serverTimestamp(), line_id: lineId || '' })
    }
    const ticketItems = structured.map(({ item, lot }) => ({ drug_id: item.drugId, sku: lot.sku || '', name: lot.name || '',
      batch: lot.batch || '', qty: Number(item.requestedQty), unit: lot.unit || 'tabs' }))
    tx.create(ticketRef, { patient_id: patientId || '', patient_name: patientName || '', items: JSON.stringify(ticketItems),
      by: actor.name || actor.email || '', status: 'dispensed', organization_id: orgId,
      created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp(), medication_request_id: medicationRequestId || '' })
    let requestProgress = null
    if (requestRef) {
      if (mappable) {
        const applied = applyIssue(existingLines, issued)
        const patch = { items: applied.items, status: statusForProgress(applied), updated_at: FieldValue.serverTimestamp() }
        if (applied.outstanding === 0) patch.dispensed_at = FieldValue.serverTimestamp()
        tx.update(requestRef, patch)
        requestProgress = applied
      } else {
        tx.update(requestRef, { status: 'Dispensed', dispensed_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() })
      }
    }
    return { dispensationId, patientId, patientName, requestProgress }
  })
}

export async function handleStockCreate(db, op) {
  const { drugId, movementId, drug } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !drugId || !drug || orgOf(drug) !== orgId) throw new PermanentError('stock_create op is incomplete')
  const lotRef = db.collection('stock_lots').doc(drugId)
  const movementRef = movementId ? db.collection('stock_movements').doc(movementId) : null
  return db.runTransaction(async (tx) => {
    const lotSnap = await tx.get(lotRef)
    const movementSnap = movementRef ? await tx.get(movementRef) : null
    if (lotSnap.exists) {
      if (orgOf(lotSnap.data()) === orgId && Number(lotSnap.data()?.stock) === Number(drug.stock)) return { id: drugId, deduped: true }
      throw new PermanentError('stock lot id already belongs to another item')
    }
    if (movementSnap?.exists) throw new PermanentError('opening movement id is already in use')
    tx.create(lotRef, { ...drug, created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() })
    if (movementRef) tx.create(movementRef, { type: 'opening', organization_id: orgId, drug_id: drugId,
      sku: drug.sku || drug.drug_code || '', name: drug.name || '', qty: Number(drug.stock), batch: drug.batch || '', expiry: drug.expiry || '',
      reference: 'opening balance', created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '',
      created_at: FieldValue.serverTimestamp() })
    return { id: drugId, movementId: movementId || '' }
  })
}

export async function handleStockCorrect(db, op) {
  const { drugId, movementId, countedQty, reason } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !drugId || !movementId || !Number.isFinite(countedQty) || countedQty < 0) throw new PermanentError('stock_correct op is incomplete')
  const lotRef = db.collection('stock_lots').doc(drugId)
  const moveRef = db.collection('stock_movements').doc(movementId)
  return db.runTransaction(async (tx) => {
    const [lotSnap, moveSnap] = await Promise.all([tx.get(lotRef), tx.get(moveRef)])
    if (moveSnap.exists) return { id: drugId, movementId, deduped: true }
    if (!lotSnap.exists || orgOf(lotSnap.data()) !== orgId) throw new PermanentError('stock lot does not belong to this hospital')
    const lot = lotSnap.data() || {}
    tx.update(lotRef, { stock: countedQty, status: countedQty === 0 ? 'Out' : (countedQty < 20 ? 'Low' : 'OK'), updated_at: FieldValue.serverTimestamp() })
    tx.create(moveRef, { type: 'adjust', organization_id: orgId, drug_id: drugId, sku: lot.sku || '', name: lot.name || '',
      qty: countedQty, counted_qty: countedQty, batch: lot.batch || '', expiry: lot.expiry || '', reason: reason || '',
      created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '', created_at: FieldValue.serverTimestamp() })
    return { id: drugId, newStock: countedQty }
  })
}

export async function handleStockUpdate(db, op) {
  const { drugId, movementId, fields } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !drugId || !movementId || !Number.isFinite(fields?.stock)) throw new PermanentError('stock_update op is incomplete')
  const lotRef = db.collection('stock_lots').doc(drugId)
  const moveRef = db.collection('stock_movements').doc(movementId)
  return db.runTransaction(async (tx) => {
    const [lotSnap, moveSnap] = await Promise.all([tx.get(lotRef), tx.get(moveRef)])
    if (moveSnap.exists) return { id: drugId, deduped: true }
    if (!lotSnap.exists || orgOf(lotSnap.data()) !== orgId) throw new PermanentError('stock lot does not belong to this hospital')
    const prior = lotSnap.data() || {}
    const actor = op.actor || {}
    const now = FieldValue.serverTimestamp()
    tx.update(lotRef, { ...fields, updated_at: now })
    tx.create(moveRef, { type: 'adjust', organization_id: orgId, drug_id: drugId, sku: fields.sku || prior.sku || '',
      name: fields.name || prior.name || '', qty: Number(fields.stock) - (Number(prior.stock) || 0), batch: fields.batch ?? prior.batch ?? '',
      expiry: fields.expiry ?? prior.expiry ?? '', reason: 'Stock adjustment via item edit', counted_qty: Number(fields.stock),
      created_by: actor.uid || null, created_by_name: actor.name || actor.email || '', created_at: now })
    return { id: drugId, newStock: Number(fields.stock) }
  })
}

export async function handlePharmacyReverse(db, op) {
  const { requestId, lineId, movementId, ticketId, preview = {} } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !requestId || !lineId || !movementId || !ticketId) throw new PermanentError('pharmacy_reverse op is incomplete')
  const requestRef = db.collection(REQUESTS).doc(requestId)
  const lotRef = db.collection('stock_lots').doc(preview.drugId)
  const moveRef = db.collection('stock_movements').doc(movementId)
  const ticketRef = db.collection('dispensations').doc(ticketId)
  return db.runTransaction(async (tx) => {
    const [requestSnap, lotSnap, moveSnap, ticketSnap] = await Promise.all([tx.get(requestRef), tx.get(lotRef), tx.get(moveRef), tx.get(ticketRef)])
    if (ticketSnap.exists && moveSnap.exists) return { ticketId, deduped: true }
    if (!requestSnap.exists || orgOf(requestSnap.data()) !== orgId) throw new PermanentError('prescription belongs to a different hospital')
    if (!lotSnap.exists || orgOf(lotSnap.data()) !== orgId) throw new PermanentError('stock lot belongs to a different hospital')
    const request = requestSnap.data() || {}
    const lines = toRequestItems(request)
    const line = lines.find((item) => item.line_id === lineId)
    if (!line || line.external || line.drug_id !== preview.drugId) throw new PermanentError('prescription line cannot be reversed')
    const qty = Number(line.dispensed_qty) || 0
    if (qty <= 0) throw new PermanentError('prescription line has no issued quantity')
    const lot = lotSnap.data() || {}
    const batch = lot.batch || preview.batch || ''
    const expiry = lot.expiry || preview.expiry || ''
    const next = lines.map((item) => item.line_id === lineId ? { ...item, dispensed_qty: 0 } : item)
    const progress = requestProgress(next)
    const restoredStock = (Number(lot.stock) || 0) + qty
    tx.update(lotRef, { stock: restoredStock, batch, expiry, status: restoredStock === 0 ? 'Out' : (restoredStock < 20 ? 'Low' : 'OK'), updated_at: FieldValue.serverTimestamp() })
    tx.create(moveRef, { type: 'in', organization_id: orgId, drug_id: line.drug_id, sku: lot.sku || '', name: lot.name || line.medicine || '',
      qty, batch, expiry, reason: 'Dispense reversed', patient_id: request.patient_id || '', medication_request_id: requestId, line_id: lineId,
      created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '', created_at: FieldValue.serverTimestamp() })
    tx.create(ticketRef, { patient_id: request.patient_id || '', patient_name: request.patient_name || '',
      items: JSON.stringify([{ drug_id: line.drug_id, sku: lot.sku || '', name: lot.name || line.medicine || '', batch, qty, unit: lot.unit || 'tabs' }]),
      by: op.actor?.name || op.actor?.email || '', status: 'reversed', reason: 'Dispense reversed for "' + (line.medicine || 'medicine') + '"',
      organization_id: orgId, medication_request_id: requestId, line_id: lineId, created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() })
    tx.update(requestRef, { items: next, status: statusForProgress(progress), reason: 'Dispense reversed', dispensed_at: null, updated_at: FieldValue.serverTimestamp() })
    return { ticketId, newStock: (Number(lot.stock) || 0) + qty }
  })
}

export async function handleFileUpload(db, op) {
  const { kind, id, metadata, contentType, contentBase64, remove } = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId || !kind || !id) throw new PermanentError('file_upload op is incomplete')
  const collectionName = kind === 'patient_photo' ? 'patient_photos' : 'result_images'
  const parentRef = db.collection(collectionName).doc(id)
  const blobRef = parentRef.collection('blob').doc('data')
  const linkedRef = !remove && kind === 'patient_photo' && metadata?.patient_id
    ? db.collection('patients').doc(metadata.patient_id)
    : !remove && kind === 'result_image'
      ? db.collection(metadata?.kind === 'imaging' ? 'imaging_orders' : 'lab_orders').doc(metadata?.order_id || '')
      : null
  return db.runTransaction(async (tx) => {
    const parent = await tx.get(parentRef)
    const linked = linkedRef ? await tx.get(linkedRef) : null
    if (remove) {
      if (parent.exists && orgOf(parent.data()) !== orgId) throw new PermanentError('file belongs to a different hospital')
      if (parent.exists) tx.delete(parentRef)
      tx.delete(blobRef)
      return { id, removed: true }
    }
    if (!metadata || orgOf(metadata) !== orgId || !contentBase64) throw new PermanentError('file metadata does not match this hospital')
    if (parent.exists && orgOf(parent.data()) !== orgId) throw new PermanentError('file id already belongs to a different hospital')
    if (!linked?.exists || orgOf(linked.data()) !== orgId) throw new PermanentError('linked patient or order does not belong to this hospital')
    if (parent.exists && kind === 'result_image') {
      if (orgOf(parent.data()) === orgId) return { id, deduped: true }
      throw new PermanentError('result image id belongs to a different hospital')
    }
    const bytes = Buffer.from(contentBase64, 'base64')
    const blobData = { bytes, content_type: contentType, organization_id: orgId }
    if (kind === 'result_image') tx.create(parentRef, { ...metadata, created_at: FieldValue.serverTimestamp() })
    else tx.set(parentRef, { ...metadata, updated_at: FieldValue.serverTimestamp() })
    if (kind === 'result_image') tx.create(blobRef, blobData)
    else tx.set(blobRef, blobData)
    return { id }
  })
}

export const HANDLERS = {
  rx_mirror: handleRxMirror,
  lab_snapshot: handleLabSnapshot,
  admission_create: handleAdmissionCreate,
  admission_discharge: handleAdmissionDischarge,
  admission_transfer: handleAdmissionTransfer,
  billing_payment: handleBillingPayment,
  medication_administer: handleMedicationAdminister,
  stock_receive: handleStockReceive,
  pharmacy_dispense: handlePharmacyDispense,
  stock_create: handleStockCreate,
  stock_correct: handleStockCorrect,
  stock_update: handleStockUpdate,
  pharmacy_reverse: handlePharmacyReverse,
  file_upload: handleFileUpload,
  document_mutation: handleDocumentMutation,
}

// Exported for tests and for the Queue's legacy-data note.
export const HANDLER_KINDS = Object.keys(HANDLERS)
export function isKnownHandler(kind) {
  return !!HANDLERS[kind]
}
