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
  toLine, mergeRequestLine, normalizeRequest, isOpenRequest, REQUEST_STATUS,
} from '../src/features/pharmacy/requests.js'

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

export const HANDLERS = {
  rx_mirror: handleRxMirror,
  lab_snapshot: handleLabSnapshot,
}

// Exported for tests and for the Queue's legacy-data note.
export const HANDLER_KINDS = Object.keys(HANDLERS)
export function isKnownHandler(kind) {
  return !!HANDLERS[kind]
}
