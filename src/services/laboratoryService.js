// Laboratory data layer (direct Firestore, Spark plan: no backend).
// Workflow: Order → Accepted → Specimen collected → Processing → Completed → Verified
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'

const LABS = 'lab_orders'

// ---- capability check --------------------------------------------------------
export function myLabCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canOrder: can(me, 'lab.order'),
    canResult: can(me, 'lab.result.enter'),
    canVerify: can(me, 'lab.result.verify'),
  }
}

// ---- model shape -----------------------------------------------------------
function toLabRow(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    encounterId: r.encounter_id || '',
    testPanel: r.test_panel || '',
    priority: r.priority || 'Routine',
    status: r.status || 'order',
    orderedBy: r.ordered_by || '',
    orderedByName: r.ordered_by_name || '',
    orderedAt: r.ordered_at ? (typeof r.ordered_at.toMillis === 'function' ? r.ordered_at.toMillis() : r.ordered_at) : 0,
    result: r.result || null,
    verifiedBy: r.verified_by || '',
    verifiedAt: r.verified_at ? (typeof r.verified_at.toMillis === 'function' ? r.verified_at.toMillis() : r.verified_at) : null,
    acceptedAt: r.accepted_at ? (typeof r.accepted_at.toMillis === 'function' ? r.accepted_at.toMillis() : r.accepted_at) : null,
    processingAt: r.processing_at ? (typeof r.processing_at.toMillis === 'function' ? r.processing_at.toMillis() : r.processing_at) : null,
    completedAt: r.completed_at ? (typeof r.completed_at.toMillis === 'function' ? r.completed_at.toMillis() : r.completed_at) : null,
    cancelledAt: r.cancelled_at ? (typeof r.cancelled_at.toMillis === 'function' ? r.cancelled_at.toMillis() : r.cancelled_at) : null,
    collectedAt: r.collected_at ? (typeof r.collected_at.toMillis === 'function' ? r.collected_at.toMillis() : r.collected_at) : null,
    processedAt: r.processed_at ? (typeof r.processed_at.toMillis === 'function' ? r.processed_at.toMillis() : r.processed_at) : null,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
export async function listPatientLabs(pid) {
  const snap = await getDocs(query(collection(db, LABS), where('patient_id', '==', pid)))
  const rows = snap.docs.map((d) => toLabRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.orderedAt - a.orderedAt)
  return rows
}

export async function listOrgLabs(orgId) {
  const snap = await getDocs(query(collection(db, LABS), where('organization_id', '==', orgId)))
  const rows = snap.docs.map((d) => toLabRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.orderedAt - a.orderedAt)
  return rows
}

export async function getLabOrder(lid) {
  const snap = await getDoc(doc(db, LABS, lid))
  if (!snap.exists()) return null
  return toLabRow({ ...snap.data(), id: snap.id })
}

// ---- create ---------------------------------------------------------------
export async function createLabOrder(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myLabCaps()
  if (!caps.canOrder) {
    throw new Error('Your role cannot order lab tests (missing "lab.order" capability). Ask an administrator.')
  }

  const pid = input.patient_id
  if (!pid) throw new Error('Patient is required.')
  if (!input.test_panel) throw new Error('Test panel is required.')

  const orderId = doc(collection(db, LABS)).id
  const now = serverTimestamp()
  const labOrder = {
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    encounter_id: input.encounter_id || '',
    test_panel: input.test_panel || '',
    priority: input.priority || 'Routine',
    status: 'order',
    ordered_by: user?.uid || null,
    ordered_by_name: user?.email || '',
    ordered_at: now,
  }

  await setDoc(doc(db, LABS, orderId), labOrder)

  try {
    await logAudit({ action: 'lab.order.created', organizationId: activeOrg, patientId: pid, details: 'Lab order ' + orderId + ' - ' + input.test_panel + ' for ' + input.patient_name })
  } catch (e) {
    console.warn('[labs] audit append failed:', e?.message)
  }
  return { id: orderId, ...labOrder }
}

// Fail fast with a friendly message: `lab_orders` update requires
// `lab.order` OR `lab.result.verify` per firestore.rules.
function requireLabUpdate() {
  const me = myActiveMembership()
  if (!can(me, 'lab.order') && !can(me, 'lab.result.verify')) {
    throw new Error('Your role cannot update lab orders (missing "lab.order" or "lab.result.verify" capability). Ask an administrator to re-save your role.')
  }
}

// ---- status update --------------------------------------------------------
export async function updateLabStatus(labId, status) {
  const validStatuses = ['order', 'accepted', 'specimen-collected', 'processing', 'completed', 'verified', 'cancelled']
  if (!validStatuses.includes(status)) throw new Error('Invalid lab status: ' + status)
  requireLabUpdate()

  const updateData = { status, updated_at: serverTimestamp() }

  // Record the timestamp for each workflow transition.
  if (status === 'accepted') updateData.accepted_at = serverTimestamp()
  if (status === 'specimen-collected') updateData.collected_at = serverTimestamp()
  if (status === 'processing') updateData.processing_at = serverTimestamp()
  if (status === 'completed') {
    updateData.processed_at = serverTimestamp()
    updateData.completed_at = serverTimestamp()
  }
  if (status === 'verified') updateData.verified_at = serverTimestamp()
  if (status === 'cancelled') updateData.cancelled_at = serverTimestamp()

  await updateDoc(doc(db, LABS, labId), updateData)

  return true
}

// ---- add result ---------------------------------------------------------
export async function addLabResult(labId, resultData) {
  requireLabUpdate()
  const updateData = {
    result: resultData,
    updated_at: serverTimestamp(),
  }

  // Only allow result entry if the lab order is in 'completed' or 'verified' state
  // Actually, per the workflow, result can be entered after processing
  await updateDoc(doc(db, LABS, labId), updateData)

  return true
}

// ---- add verification -------------------------------------------------
export async function addLabVerification(labId, verifiedById, verifiedByName) {
  requireLabUpdate()
  await updateDoc(doc(db, LABS, labId), {
    status: 'verified',
    verified_by: verifiedById || '',
    verified_by_name: verifiedByName || '',
    updated_at: serverTimestamp(),
  })

  return true
}