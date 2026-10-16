// Imaging order data layer (direct Firestore, Spark plan: no backend).
// Modelled on laboratoryService — reuses the existing `lab.order` capability,
// so no new role/migration is needed. Workflow: order → accepted → in-progress →
// completed → verified | cancelled. No separate imaging system was previously
// available; this is a deliberate lightweight add-on.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit,
  startAfter,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'

const IMAGING_ORDERS = 'imaging_orders'

// A multi-study order keeps individual studies in `studies` and a denormalised
// `study` summary. Legacy orders only have the summary, promoted to a
// one-element list on read.
export function normalizeStudies(r) {
  if (Array.isArray(r.studies) && r.studies.length) {
    return r.studies.map((s) => (typeof s === 'string' ? s : (s && s.name) || '')).map((s) => String(s).trim()).filter(Boolean)
  }
  const summary = String(r.study || '').trim()
  return summary ? [summary] : []
}

export function normalizeStudyInput(input) {
  const studies = Array.isArray(input.studies)
    ? input.studies.map((s) => String(s || '').trim()).filter(Boolean)
    : (input.study ? [String(input.study).trim()] : [])
  return { studies, summary: studies.join(', ') }
}

// One order can carry several imaging requests — e.g. a chest X-ray and a brain
// MRI at once. Each request is a modality + study pair, kept in `items`. A
// legacy order (single modality, plain studies[]) is read back as pairs so the
// rest of the app only ever sees one shape.
export function normalizeImagingItems(r) {
  if (Array.isArray(r.items) && r.items.length) {
    return r.items
      .map((it) => (typeof it === 'string'
        ? { modality: String(r.modality || '').trim(), study: String(it).trim() }
        : { modality: String((it && it.modality) || r.modality || '').trim(), study: String((it && (it.study || it.name)) || '').trim() }))
      .filter((it) => it.modality || it.study)
  }
  return normalizeStudies(r).map((s) => ({ modality: String(r.modality || '').trim(), study: s }))
}

// Normalise an order form into pair items plus the denormalised fields the list
// and print views read. Accepts either a modality + studies[] (legacy form) or
// an explicit items[] of { modality, study } pairs (multi-modality form).
export function normalizeImagingInput(input) {
  let items
  if (Array.isArray(input.items) && input.items.length) {
    items = input.items.map((it) => ({
      modality: String((it && it.modality) || '').trim(),
      study: String((it && it.study) || '').trim(),
    }))
  } else {
    const studies = Array.isArray(input.studies)
      ? input.studies
      : (input.study ? [input.study] : [])
    items = studies.map((s) => ({ modality: String(input.modality || '').trim(), study: String(s || '').trim() }))
  }
  items = items.filter((it) => it.modality || it.study)
  const studies = items.map((it) => it.study).filter(Boolean)
  const modalities = [...new Set(items.map((it) => it.modality).filter(Boolean))]
  return { items, modalities, studies, summary: studies.join(', ') }
}

// Live listeners are bounded to the 100 most recent rows (cost control);
// list* stays unbounded so a manual refresh still shows everything.
const LIVE_LIMIT = 100

// ---- capability check --------------------------------------------------------
export function myImagingCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canOrder: can(me, 'lab.order'),       // also gates imaging orders (design choice)
    canVerify: can(me, 'lab.result.verify'),
  }
}

// ---- model shape -----------------------------------------------------------
function toImagingRow(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    encounterId: r.encounter_id || '',
    modality: r.modality || '',
    modalities: [...new Set(normalizeImagingItems(r).map((it) => it.modality).filter(Boolean))],
    study: r.study || '',
    studies: normalizeStudies(r),
    items: normalizeImagingItems(r),
    facility: r.facility === 'external' ? 'external' : 'internal',
    priority: r.priority || 'Routine',
    status: r.status || 'order',
    indication: r.indication || '',
    orderedBy: r.ordered_by || '',
    orderedByName: r.ordered_by_name || '',
    orderedAt: r.ordered_at ? (typeof r.ordered_at.toMillis === 'function' ? r.ordered_at.toMillis() : r.ordered_at) : 0,
    completedAt: r.completed_at ? (typeof r.completed_at.toMillis === 'function' ? r.completed_at.toMillis() : r.completed_at) : 0,
    verifiedAt: r.verified_at ? (typeof r.verified_at.toMillis === 'function' ? r.verified_at.toMillis() : r.verified_at) : 0,
    result: r.result || null,
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
function buildOrgImagingQuery(orgId) {
  return query(collection(db, IMAGING_ORDERS), where('organization_id', '==', orgId))
}

function mapImagingDoc(d) {
  return toImagingRow({ ...d.data(), id: d.id })
}

export async function listOrgImaging(orgId) {
  const snap = await getDocs(buildOrgImagingQuery(orgId))
  return snap.docs.map(mapImagingDoc).sort((a, b) => b.orderedAt - a.orderedAt)
}

export function subscribeOrgImaging(orgId, onRows, onError) {
  return watchQuery(
    query(
      collection(db, IMAGING_ORDERS),
      where('organization_id', '==', orgId),
      orderBy('ordered_at', 'desc'),
      limit(LIVE_LIMIT),
    ),
    mapImagingDoc,
    (rows) => onRows(rows),
    onError,
  )
}

// Get single imaging order
export async function getImagingOrder(iid) {
  const snap = await getDoc(doc(db, IMAGING_ORDERS, iid))
  if (!snap.exists()) return null
  return toImagingRow({ ...snap.data(), id: snap.id })
}

// ---- create ---------------------------------------------------------------
export async function createImagingOrder(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myImagingCaps()
  if (!caps.canOrder) {
    throw new Error('Your role cannot order imaging (missing "lab.order" capability). Ask an administrator.')
  }

  const pid = input.patient_id
  if (!pid) throw new Error('Patient is required.')
  const { items, modalities, studies, summary } = normalizeImagingInput(input)
  if (!items.length) throw new Error('At least one imaging study is required.')
  const modality = modalities[0] || input.modality || ''

  const orderId = doc(collection(db, IMAGING_ORDERS)).id
  const now = serverTimestamp()
  const imagingOrder = {
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    encounter_id: input.encounter_id || '',
    admission_session_id: input.admission_session_id || '',
    modality,
    modalities,
    study: summary,
    studies,
    items,
    // External orders are printed for the patient to take to an outside
    // facility; the returned report is attached back to this same order.
    facility: input.facility === 'external' ? 'external' : 'internal',
    priority: input.priority || 'Routine',
    status: 'order',
    indication: input.indication || '',
    ordered_by: user?.uid || null,
    ordered_by_name: user?.email || '',
    ordered_at: now,
  }

  await setDoc(doc(db, IMAGING_ORDERS, orderId), imagingOrder)

  try {
    await logAudit({
      action: 'imaging.order.created',
      organizationId: activeOrg,
      patientId: pid,
      details: 'Imaging order ' + orderId + ' - ' + modality + ' · ' + summary + ' for ' + input.patient_name,
    })
  } catch (e) {
    console.warn('[imaging] audit append failed:', e?.message)
  }
  return { id: orderId, ...imagingOrder }
}

// ---- update status --------------------------------------------------------
export async function updateImagingOrderStatus(iid, status) {
  const validStatuses = ['order', 'accepted', 'in-progress', 'completed', 'verified', 'cancelled']
  if (!validStatuses.includes(status)) throw new Error('Invalid imaging status: ' + status)

  const imaging = await getImagingOrder(iid)
  if (!imaging) throw new Error('Imaging order not found.')

  await updateDoc(doc(db, IMAGING_ORDERS, iid), {
    status,
    updated_at: serverTimestamp(),
  })
  return imaging
}

// ---- radiologist report ---------------------------------------------------
// Records the report text and moves the order to completed. Verification is a
// separate step (verifyImagingOrder) so entry and sign-off stay distinct.
export async function addImagingResult(iid, reportText) {
  const imaging = await getImagingOrder(iid)
  if (!imaging) throw new Error('Imaging order not found.')
  await updateDoc(doc(db, IMAGING_ORDERS, iid), {
    result: String(reportText || '').trim(),
    status: 'completed',
    completed_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  })
  return true
}

export async function verifyImagingOrder(iid, verifiedByName) {
  const imaging = await getImagingOrder(iid)
  if (!imaging) throw new Error('Imaging order not found.')
  const { user } = authStore.getState()
  await updateDoc(doc(db, IMAGING_ORDERS, iid), {
    status: 'verified',
    verified_by: user?.uid || null,
    verified_by_name: String(verifiedByName || user?.email || '').trim(),
    verified_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  })
  return true
}

// ---- list session imaging ------------------------------------------------

export async function listSessionImaging(sid) {
  const snap = await getDocs(query(
    collection(db, IMAGING_ORDERS),
    where('admission_session_id', '==', sid),
  ))
  // Raw session docs (matching listSessionLabs) so the workspace reads the same
  // snake_case shape for both order types. Passing the snapshot straight to
  // toImagingRow left every field but the id undefined.
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}