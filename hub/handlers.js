// Hub-side delivery handlers — the server twin of the browser outbox.
//
// The browser outbox replays ops by re-running the browser service functions;
// the hub cannot (they import the browser SDK + auth store), so each op kind
// gets a small admin-SDK implementation here. The RULES are not duplicated:
// line normalisation and merge semantics are imported from the app's pure
// module `src/features/pharmacy/requests.js`, so browser and hub can never
// disagree about what "same medicine, same dosage" means.
//
// Idempotency (safe re-delivery — the whole point of a relay):
//   rx_mirror  — every op carries a stable sync key; it is recorded on the
//                request doc in `sync_keys`, and a replay with a key we
//                already hold is skipped before any write happens. This
//                protects against BOTH the hub re-sending and the browser
//                racing the hub (ack lost after a successful cloud write).
//   lab_snapshot — keyed by lab_order_id, same as the browser path.

import { existsSync } from 'node:fs'
import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
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

// firebase-admin: emulator mode needs no key file (FIRESTORE_EMULATOR_HOST).
// Production picks credentials in a fixed order so a missing key is reported
// at startup instead of failing mysteriously on the first relay tick.
export function initFirestore(cfg) {
  if (getApps().length) return getFirestore()
  if (cfg.emulator) {
    initializeApp({ projectId: cfg.projectId })
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({ credential: applicationDefault(), projectId: cfg.projectId })
  } else if (existsSync(cfg.keyFile)) {
    initializeApp({ credential: cert(cfg.keyFile), projectId: cfg.projectId })
  } else {
    // No explicit credentials: try ADC (gcloud auth / attached service account).
    // If that is also missing, the first Firestore call fails with a clear
    // credentials error and the health page shows firestoreReady:false.
    initializeApp({ projectId: cfg.projectId })
  }
  return getFirestore()
}

// ---- rx_mirror -------------------------------------------------------------
// Server twin of pharmacyService.requestMedicationLines (without the browser
// capability check — the prescriber's client already enforced it before the
// op was queued; the hub enforces possession of the shared token).

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
    .filter((r) => isOpenRequest(r.status) || r.status === REQUEST_STATUS.EXTERNAL)
  return open[0] || null
}

export async function handleRxMirror(db, op) {
  const args = op.args || {}
  const orgId = op.orgId || ''
  if (!orgId) throw new PermanentError('op has no organization id')
  if (!args.patientId) throw new PermanentError('rx_mirror op has no patientId')

  const lines = (args.lines || [])
    .map((l, i) => toLine(l, i))
    .filter((l) => l.medicine || l.drug_id)
  if (!lines.length) throw new PermanentError('rx_mirror op has no usable medicine lines')

  const syncKey = op.clientOpKey || ''
  const col = db.collection(REQUESTS)

  // 1. Replay guard — a single-field array-contains query needs no composite
  //    index, and sync keys are unique per op so cross-hospital hits are
  //    impossible.
  if (syncKey) {
    const dup = await col.where('sync_keys', 'array-contains', syncKey).limit(1).get()
    if (!dup.empty) return { id: dup.docs[0].id, deduped: true, created: false }
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

  const ref = col.doc()
  await ref.set({
    patient_id: args.patientId,
    patient_name: args.patientName || '',
    encounter_id: args.encounterId || '',
    admission_session_id: args.admissionSessionId || '',
    organization_id: orgId,
    items: lines,
    status: REQUEST_STATUS.REQUESTED,
    created_by: op.actor?.uid || null,
    created_by_name: op.actor?.email || '',
    // Traceability: this script arrived via the hospital hub, not a browser.
    created_via: 'lan-hub',
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

  const ref = db.collection(ENCOUNTERS).doc(encounterId)
  const snap = await ref.get()
  if (!snap.exists) throw new PermanentError('encounter ' + encounterId + ' does not exist')
  const data = snap.data()
  if (data.organization_id && data.organization_id !== op.orgId) {
    throw new PermanentError('encounter belongs to a different hospital')
  }

  const id = labOrder.lab_order_id || ('lab_' + Date.now().toString(36))
  const existing = data.lab_orders || []
  if (existing.some((o) => o && o.id === id)) return { id, deduped: true }

  await ref.update({
    lab_orders: [...existing, { ...labOrder, id, ordered_at: Date.now() }],
    updated_at: FieldValue.serverTimestamp(),
  })
  return { id, deduped: false }
}

export const HANDLERS = {
  rx_mirror: handleRxMirror,
  lab_snapshot: handleLabSnapshot,
}
