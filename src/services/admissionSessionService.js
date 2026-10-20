// Admission Session data layer — session-scoped reads and plan-item CRUD.
// Pure reads (signedIn) for clinical workspace; writes gated by existing capabilities
// (beds.manage / encounter.edit / lab.order / prescription.create / billing.invoice)
// so no role migration is required.

import {
  db, collection, query, where, getDocs, getDoc, setDoc, updateDoc, serverTimestamp,
  doc,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import {
  PLAN_TYPES, PLAN_STATUSES, planStatus, isPlanCompleted, isPlanRemoved,
  validatePlanItem, groupByPlanType, buildSessionTimeline, nextRound,
} from '../features/admissions/plan.js'
import { MODALITIES, imagingStatus, validateImagingOrder } from '../features/admissions/imaging.js'
import {
  listOrgWards,
} from './wardService.js'
import { currentStaffName } from '../lib/staffName.js'

const ADMISSION_PLAN_ITEMS = 'admission_plan_items'

// ---- capability check --------------------------------------------------------
export function myAdmissionSessionCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canEditPlan: can(me, 'encounter.edit'),        // gated by encounter.edit
    canDischarge: can(me, 'beds.manage'),
    canOrderLabs: can(me, 'lab.order'),           // also gates imaging orders
    canPrescribe: can(me, 'prescription.create'),
    canBill: can(me, 'billing.invoice'),
  }
}

// ---- model shape -----------------------------------------------------------
function planItemRow(r) {
  return { ...r, status: planStatus(r) }
}

function imagingOrderRow(r) {
  return { ...r, status: imagingStatus(r) }
}

// ---- plan-item CRUD --------------------------------------------------------

export async function createPlanItem(admissionSessionId, input) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAdmissionSessionCaps()
  if (!caps.canEditPlan) {
    throw new Error('Your role cannot edit clinical plan items (missing "encounter.edit" capability). Ask an administrator.')
  }

  const validation = validatePlanItem(input)
  if (validation) throw new Error('Invalid plan item: ' + validation.join('. '))

  const sessionId = String(admissionSessionId || '').trim()
  if (!sessionId) throw new Error('Admission session id is required.')

  const now = new Date()
  const serverNow = serverTimestamp()
  const item = {
    admission_session_id: sessionId,
    patient_id: input.patient_id,
    patient_name: input.patient_name,
    organization_id: activeOrg,
    encounter_id: input.encounter_id || '',
    round: Number(input.round || 1),
    type: String(input.type || '').trim().toLowerCase(),
    status: 'planned',
    text: String(input.text || '').trim(),
    revisions: [{ text: input.text, by: currentStaffName(), at: now }],
    created_by: authStore.getState().user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: serverNow,
    updated_by: authStore.getState().user?.uid || null,
    updated_by_name: currentStaffName(),
    updated_at: serverNow,
  }

  const autoId = doc(collection(db, ADMISSION_PLAN_ITEMS)).id
  const ref = doc(db, ADMISSION_PLAN_ITEMS, autoId)
  item.id = autoId
  await setDoc(ref, item)
  return { id: autoId, ...item }
}

export async function getPlanItem(sid, itemId) {
  const snap = await getDoc(doc(db, ADMISSION_PLAN_ITEMS, itemId))
  if (!snap.exists()) return null
  return planItemRow({ ...snap.data(), id: snap.id })
}

export async function listSessionPlanItems(sid) {
  const snap = await getDocs(query(
    collection(db, ADMISSION_PLAN_ITEMS),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => planItemRow({ ...d.data(), id: d.id }))
}

export async function updatePlanItem(sid, itemId, input) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAdmissionSessionCaps()
  if (!caps.canEditPlan) {
    throw new Error('Your role cannot edit clinical plan items.')
  }

  const validation = validatePlanItem(input)
  if (validation) throw new Error('Invalid plan item: ' + validation.join('. '))

  const now = new Date()
  const serverNow = serverTimestamp()
  const updates = {
    text: String(input.text || '').trim(),
    round: Number(input.round || 1),
    type: String(input.type || '').trim().toLowerCase(),
    updated_at: serverNow,
    updated_by: authStore.getState().user?.uid || null,
    updated_by_name: currentStaffName(),
    // Append revision instead of overwriting
    revisions: [
      ...(await getPlanItem(sid, itemId)).revisions,
      { text: input.text, by: currentStaffName(), at: now },
    ],
  }

  await updateDoc(doc(db, ADMISSION_PLAN_ITEMS, itemId), updates)
  return getPlanItem(sid, itemId)
}

export async function updatePlanStatus(sid, itemId, status) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAdmissionSessionCaps()
  if (!caps.canEditPlan) {
    throw new Error('Your role cannot update clinical plan items.')
  }

  const next = String(status || '').trim().toLowerCase()
  if (!PLAN_STATUSES.includes(next)) throw new Error('Invalid plan status: ' + status)

  await updateDoc(doc(db, ADMISSION_PLAN_ITEMS, itemId), {
    status: next,
    updated_at: serverTimestamp(),
    updated_by: authStore.getState().user?.uid || null,
    updated_by_name: currentStaffName(),
  })
  return getPlanItem(sid, itemId)
}

export async function removePlanItem(sid, itemId, reason) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAdmissionSessionCaps()
  if (!caps.canEditPlan) {
    throw new Error('Your role cannot remove clinical plan items.')
  }

  const reasonTxt = String(reason || '').trim() || 'removed by user'
  const now = new Date()
  const existing = await getPlanItem(sid, itemId)
  await updateDoc(doc(db, ADMISSION_PLAN_ITEMS, itemId), {
    status: 'removed',
    updated_at: serverTimestamp(),
    updated_by: authStore.getState().user?.uid || null,
    updated_by_name: currentStaffName(),
    revisions: [
      ...(existing?.revisions || []),
      { text: 'Removed: ' + reasonTxt, by: currentStaffName(), at: now },
    ],
  })
  return getPlanItem(sid, itemId)
}

// ---- session-scoped lab orders -------------------------------------------

export async function listSessionLabs(sid) {
  const snap = await getDocs(query(
    collection(db, 'lab_orders'),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

// ---- session-scoped imaging orders ---------------------------------------

export async function listSessionImaging(sid) {
  const snap = await getDocs(query(
    collection(db, 'imaging_orders'),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => imagingOrderRow({ ...d.data(), id: d.id }))
}

// ---- session-scoped medication requests --------------------------------

export async function listSessionMedicationRequests(sid) {
  const snap = await getDocs(query(
    collection(db, 'medication_requests'),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

// ---- session-scoped invoices -------------------------------------------

export async function listSessionInvoices(sid) {
  const snap = await getDocs(query(
    collection(db, 'invoices'),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

// ---- build timeline ------------------------------------------------------

export function buildSessionTimelineFn(admission, planItems, labOrders, imagingOrders, medicationRequests, invoices) {
  return buildSessionTimeline(admission, planItems, labOrders, imagingOrders, medicationRequests, invoices)
}

// ---- next round ----------------------------------------------------------

export function nextRoundFn(admission, existingPlanItems) {
  return nextRound(admission, existingPlanItems)
}