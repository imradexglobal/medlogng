// Laboratory data layer (direct Firestore, Spark plan: no backend).
// Workflow: Order → Accepted → Specimen collected → Processing → Completed → Verified
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit,
  startAfter,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'

const LABS = 'lab_orders'

// Catalogue offered by the order forms (single source of truth). Free text is
// still accepted by the services, so adding here only widens the picker.
export const LAB_TEST_OPTIONS = [
  'Full Blood Count (FBC)', 'ESR', 'Malaria RDT', 'Widal test', 'Blood film for parasites',
  'Urinalysis', 'Urine culture & sensitivity', 'Stool analysis', 'Lipid profile', 'HbA1c',
  'Fasting blood glucose', 'Liver function test', 'Urea & electrolytes', 'Serum creatinine',
  'HIV screening', 'Hepatitis B (HBsAg)', 'Hepatitis C (HCV)', 'Pregnancy test (HCG)',
  'Blood group & genotype', 'Prothrombin time / INR', 'Thyroid function test', 'CRP',
]

// A multi-test order keeps the individual tests in `tests` and a denormalised
// `test_panel` summary. Legacy orders written before multi-test only have the
// summary, so the summary is promoted to a one-element list on read.
export function normalizeTests(r) {
  if (Array.isArray(r.tests) && r.tests.length) {
    return r.tests.map((t) => (typeof t === 'string' ? t : (t && t.name) || '')).map((t) => String(t).trim()).filter(Boolean)
  }
  const summary = String(r.test_panel || '').trim()
  return summary ? [summary] : []
}

// Result values are free text (legacy string) or an object map keyed by test
// name (new multi-test orders). Render both to one readable line.
export function formatTestResult(result) {
  if (result == null || result === '') return ''
  if (typeof result === 'string') return result
  if (Array.isArray(result)) return result.map((v) => String(v)).filter(Boolean).join('; ')
  if (typeof result === 'object') {
    return Object.entries(result)
      .map(([k, v]) => (v == null || v === '' ? String(k) : k + ': ' + v))
      .join('; ')
  }
  return String(result)
}

// Normalise an order form's test input into { summary, tests }.
export function normalizeTestInput(input) {
  const tests = Array.isArray(input.tests)
    ? input.tests.map((t) => String(t || '').trim()).filter(Boolean)
    : (input.test_panel ? [String(input.test_panel).trim()] : [])
  return { tests, summary: tests.join(', ') }
}

// Live listeners are bounded to the 100 most recent rows (cost control);
// list* stays unbounded so a manual refresh still shows everything.
const LIVE_LIMIT = 100

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
    tests: normalizeTests(r),
    // External orders are printed for the patient to take to an outside lab;
    // the returned report is attached back to this same order.
    facility: r.facility === 'external' ? 'external' : 'internal',
    priority: r.priority || 'Routine',
    status: r.status || 'order',
    orderedBy: r.ordered_by || '',
    orderedByName: r.ordered_by_name || '',
    orderedAt: r.ordered_at ? (typeof r.ordered_at.toMillis === 'function' ? r.ordered_at.toMillis() : r.ordered_at) : 0,
    result: r.result || null,
    resultDisplay: formatTestResult(r.result),
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
export async function listPatientLabs(pid, { limitN = 50 } = {}) {
  const snap = await getDocs(query(collection(db, LABS), where('patient_id', '==', pid), limit(limitN)))
  const rows = snap.docs.map((d) => toLabRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.orderedAt - a.orderedAt)
  return rows
}

function buildOrgLabsQuery(orgId) {
  return query(collection(db, LABS), where('organization_id', '==', orgId))
}

function mapLabDoc(d) {
  return toLabRow({ ...d.data(), id: d.id })
}

function sortLabs(rows) {
  rows.sort((a, b) => b.orderedAt - a.orderedAt)
  return rows
}

export async function listOrgLabs(orgId) {
  const snap = await getDocs(buildOrgLabsQuery(orgId))
  return sortLabs(snap.docs.map(mapLabDoc))
}

export async function listSessionLabs(sid) {
  const snap = await getDocs(query(
    collection(db, LABS),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

// Next chunk of the newest-first list (cursor-walked for infinite scroll).
// Needs index:
// lab_orders: organization_id ASC + ordered_at DESC.
export const LABS_PAGE = 20

export async function listOrgLabsPage(orgId, { pageSize = LABS_PAGE, cursor = null } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, LABS),
    where('organization_id', '==', orgId),
    orderBy('ordered_at', 'desc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: sortLabs(docs.map(mapLabDoc)), hasMore, cursor: next }
}


// Live query: same org scope + row shape as listOrgLabs, but bounded to the
// 100 most recent (orderBy+limit needs the composite index in
// firestore.indexes.json — deploy it or the listener falls back to one-shot).
function buildOrgLabsLiveQuery(orgId) {
  return query(
    collection(db, LABS),
    where('organization_id', '==', orgId),
    orderBy('ordered_at', 'desc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgLabs(orgId, onRows, onError) {
  return watchQuery(
    buildOrgLabsLiveQuery(orgId),
    mapLabDoc,
    (rows) => onRows(sortLabs(rows)),
    onError,
  )
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
  const { tests, summary } = normalizeTestInput(input)
  if (!tests.length) throw new Error('Select at least one test.')

  const orderId = doc(collection(db, LABS)).id
  const now = serverTimestamp()
  const labOrder = {
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    encounter_id: input.encounter_id || '',
    admission_session_id: input.admission_session_id || '',
    test_panel: summary,
    tests,
    facility: input.facility === 'external' ? 'external' : 'internal',
    priority: input.priority || 'Routine',
    status: 'order',
    ordered_by: user?.uid || null,
    ordered_by_name: user?.email || '',
    ordered_at: now,
  }

  await setDoc(doc(db, LABS, orderId), labOrder)

  try {
    await logAudit({ action: 'lab.order.created', organizationId: activeOrg, patientId: pid, details: 'Lab order ' + orderId + ' - ' + summary + ' for ' + input.patient_name })
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