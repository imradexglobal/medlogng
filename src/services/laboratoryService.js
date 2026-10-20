// Laboratory data layer (direct Firestore, Spark plan: no backend).
//
// LIMS workflow (per ordered test / "item"):
//   ordered → sample_collected → received → result_entered → validated → released
//   exceptions: rejected | cancelled
// The parent `lab_orders` doc keeps the legacy fields (tests[], test_panel,
// status, result, verified_by…) so every pre-existing module — patient chart,
// admission workspace, reports, encounter snapshots — keeps reading the same
// shapes it always did. New workflow data lives in `items[]`; legacy orders
// without items are normalised on read (see features/labs/domain.js).
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { listOrgTests } from './labCatalogueService.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'
import {
  ITEM_STATUS, ITEM_STATUS_META, normalizeLabItems, buildOrderItem, buildAdhocItem,
  deriveOrderStatus, orderStatusFromItemsOrLegacy, buildOrderNo, buildAccessionNo,
  validateResultValues, flagValues, formatItemResultText, sanitizeComponent,
} from '../features/labs/domain.js'
import { currentStaffName } from '../lib/staffName.js'

const LABS = 'lab_orders'

// Catalogue offered by the order forms (single source of truth). Free text is
// still accepted by the services, so adding here only widens the picker.
// (Superseded at runtime by the configurable catalogue when one is set up —
// see LabNewOrderView — but kept so legacy forms never render empty.)
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
    canCollect: can(me, 'lab.sample.collect') || can(me, 'lab.order'), // legacy fallback: existing memberships predate lab.sample.collect
    canResult: can(me, 'lab.result.enter'),
    canVerify: can(me, 'lab.result.verify'),
    canCatalogue: can(me, 'lab.catalogue.manage'),
    canBill: can(me, 'billing.invoice'),
  }
}

function requireCap(fn, message) {
  const caps = myLabCaps()
  if (!caps[fn]) throw new Error(message)
}

// ---- model shape -----------------------------------------------------------
function tsMs(v) {
  return v ? (typeof v.toMillis === 'function' ? v.toMillis() : v) : null
}

function toItemRow(it) {
  return {
    ...it,
    statusLabel: (ITEM_STATUS_META[it.status] || { label: it.status }).label,
    statusCls: (ITEM_STATUS_META[it.status] || { cls: '' }).cls,
    resultText: formatItemResultText(it),
  }
}

function toLabRow(r) {
  const items = normalizeLabItems(r).map(toItemRow)
  const orderStatus = orderStatusFromItemsOrLegacy(r, items)
  const totalKobo = Array.isArray(r.items) && r.items.length
    ? (r.total_kobo ?? r.items.reduce((s, it) => s + (Number(it.price_kobo) || 0), 0))
    : (r.total_kobo || 0)
  return {
    id: r.id,
    orderNo: r.order_no || buildOrderNo(r.id),
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    encounterId: r.encounter_id || '',
    admissionSessionId: r.admission_session_id || '',
    source: r.source === 'standalone' ? 'standalone' : 'hospital',
    testPanel: r.test_panel || '',
    tests: normalizeTests(r),
    items,
    // External orders are printed for the patient to take to an outside lab;
    // the returned report is attached back to this same order.
    facility: r.facility === 'external' ? 'external' : 'internal',
    priority: r.priority || 'Routine',
    status: orderStatus,
    legacyStatus: r.status || 'order',
    note: r.note || '',
    totalKobo,
    invoiceId: r.invoice_id || '',
    billingStatus: r.billing_status || 'unbilled',
    orderedBy: r.ordered_by || '',
    orderedByName: r.ordered_by_name || '',
    orderedAt: tsMs(r.ordered_at),
    result: r.result || null,
    resultDisplay: formatTestResult(r.result) || items.map((it) => it.resultText).filter(Boolean).join('; '),
    verifiedBy: r.verified_by || '',
    verifiedAt: tsMs(r.verified_at),
    acceptedAt: tsMs(r.accepted_at),
    processingAt: tsMs(r.processing_at),
    completedAt: tsMs(r.completed_at),
    cancelledAt: tsMs(r.cancelled_at),
    collectedAt: tsMs(r.collected_at),
    processedAt: tsMs(r.processed_at),
    createdAt: tsMs(r.created_at),
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
  return snap.docs.map((d) => toLabRow({ ...d.data(), id: d.id }))
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

// ---- refresh frozen order snapshots from live catalogue --------------------
// Back-fills blank ref_low/ref_high/ref_text on existing order item snapshots
// from the current catalogue. Never overwrites ranges already set on an order.
export async function refreshOrderSnapshotsFromCatalogue() {
  const me = myActiveMembership()
  if (!can(me, 'lab.catalogue.manage')) {
    throw new Error('Your role cannot manage the laboratory catalogue (missing "lab.catalogue.manage" capability).')
  }
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')

  const orders = await listOrgLabs(activeOrg)
  if (!orders.length) throw new Error('No lab orders found.')

  const catalogue = await listOrgTests(activeOrg, { includeInactive: false })
  const byId = new Map(catalogue.map((t) => [t.id, t]))

  let updatedOrders = 0
  let updatedItems = 0
  let updatedComponents = 0

  for (const order of orders) {
    const raw = order.raw
    const items = Array.isArray(raw.items) ? [...raw.items] : []
    let orderChanged = false

    for (const it of items) {
      if (!it.test_id) continue // skip adhoc / free-text items
      const test = byId.get(it.test_id)
      if (!test) continue

      const snap = it.snapshot || {}
      const snapComps = Array.isArray(snap.components) ? [...snap.components] : []
      const catComps = Array.isArray(test.raw?.components) ? test.raw.components : []
      let itemChanged = false

      for (const sc of snapComps) {
        const catComp = catComps.find((c) => c.id === sc.id) ||
          catComps.find((c) => String(c.name || '').toUpperCase() === String(sc.name || '').toUpperCase())
        if (!catComp) continue

        if ((sc.ref_low == null || sc.ref_low === '') && catComp.ref_low != null) {
          sc.ref_low = catComp.ref_low
          itemChanged = true
          updatedComponents++
        }
        if ((sc.ref_high == null || sc.ref_high === '') && catComp.ref_high != null) {
          sc.ref_high = catComp.ref_high
          itemChanged = true
          updatedComponents++
        }
        if ((sc.ref_text == null || sc.ref_text === '') && catComp.ref_text != null && String(catComp.ref_text).trim() !== '') {
          sc.ref_text = catComp.ref_text
          itemChanged = true
          updatedComponents++
        }
      }

      if (itemChanged) {
        it.snapshot = { ...snap, components: snapComps }
        updatedItems++
        orderChanged = true
      }
    }

    if (orderChanged) {
      await updateDoc(doc(db, LABS, order.id), { items, updated_at: serverTimestamp() })
      updatedOrders++
    }
  }

  return { updatedOrders, updatedItems, updatedComponents }
}

// Raw patient doc for flag interpretation (sex, dob). Read is open by rules.
async function getPatientForFlags(pid) {
  try {
    const snap = await getDoc(doc(db, 'patients', pid))
    if (!snap.exists()) return {}
    const p = snap.data()
    return { sex: p.sex || '', dob: p.dob || '', name: [p.surname, p.given_names].filter(Boolean).join(' ') || p.full_name || '' }
  } catch {
    return {}
  }
}

// ---- create ---------------------------------------------------------------
// Accepts either catalogue-backed tests (test_ids: ['tid1', …]) or plain
// names (tests: ['FBC', …]). A plain name that matches an ACTIVE catalogue
// test (by name or code, case-insensitive) is automatically upgraded to a
// catalogue-backed item with a frozen configuration + price snapshot.
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
  const testIds = Array.isArray(input.test_ids) ? input.test_ids.map(String).filter(Boolean) : []
  if (!tests.length && !testIds.length) throw new Error('Select at least one test.')

  // Resolve catalogue entries once for the whole order.
  let catalogue = []
  if (testIds.length || tests.length) {
    try {
      const { listOrgTests } = await import('./labCatalogueService.js')
      catalogue = await listOrgTests(activeOrg, { includeInactive: false })
    } catch (e) {
      console.warn('[labs] catalogue load failed; falling back to free-text tests:', e?.message)
    }
  }
  const byId = new Map(catalogue.map((t) => [t.id, t]))
  const byKey = new Map()
  for (const t of catalogue) {
    byKey.set(String(t.name).toLowerCase(), t)
    if (t.code) byKey.set(String(t.code).toLowerCase(), t)
  }

  const items = []
  const seen = new Set()
  for (const tid of testIds) {
    const t = byId.get(tid)
    if (!t) throw new Error('Test not found in catalogue (id ' + tid + ') — refresh and retry.')
    if (seen.has(t.id)) continue
    seen.add(t.id)
    items.push(buildOrderItem({ test: t, itemIndex: items.length }))
  }
  for (const name of tests) {
    const t = byKey.get(String(name).toLowerCase())
    if (t) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      items.push(buildOrderItem({ test: t, itemIndex: items.length }))
    } else {
      items.push(buildAdhocItem({ name }))
    }
  }
  if (!items.length) throw new Error('Select at least one test.')

  const orderId = doc(collection(db, LABS)).id
  const orderNo = buildOrderNo(orderId)
  items.forEach((it, i) => { it.accession_no = buildAccessionNo(orderNo, i) })
  const totalKobo = items.reduce((s, it) => s + (Number(it.price_kobo) || 0), 0)
  const testNames = items.map((it) => it.test_name)
  const now = serverTimestamp()
  const labOrder = {
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    encounter_id: input.encounter_id || '',
    admission_session_id: input.admission_session_id || '',
    source: input.source === 'standalone' ? 'standalone' : (input.encounter_id || input.admission_session_id ? 'hospital' : 'standalone'),
    order_no: orderNo,
    items,
    total_kobo: totalKobo,
    invoice_id: '',
    billing_status: 'unbilled',
    note: String(input.note || '').trim(),
    test_panel: testNames.join(', '),
    tests: testNames,
    facility: input.facility === 'external' ? 'external' : 'internal',
    priority: input.priority || 'Routine',
    status: 'order',
    ordered_by: user?.uid || null,
    ordered_by_name: currentStaffName(),
    ordered_at: now,
  }

  await setDoc(doc(db, LABS, orderId), labOrder)

  try {
    await logAudit({
      action: 'lab.order.created', organizationId: activeOrg, patientId: pid,
      details: 'Order ' + orderNo + ' (' + orderId + ') · ' + testNames.join(', ') + ' · ' + input.patient_name,
    })
  } catch (e) {
    console.warn('[labs] audit append failed:', e?.message)
  }
  return { id: orderId, ...labOrder }
}

// Fail fast with a friendly message: `lab_orders` update requires a lab
// capability per firestore.rules.
function requireLabUpdate() {
  const me = myActiveMembership()
  if (!can(me, 'lab.order') && !can(me, 'lab.result.verify') && !can(me, 'lab.result.enter') && !can(me, 'lab.sample.collect')) {
    throw new Error('Your role cannot update lab orders (missing a laboratory capability). Ask an administrator to re-save your role.')
  }
}

async function mutateOrder(lid, mutate, audit) {
  const rawSnap = await getDoc(doc(db, LABS, lid))
  if (!rawSnap.exists()) throw new Error('Lab order not found.')
  const raw = { ...rawSnap.data(), id: lid }
  const items = normalizeLabItems(raw).map((it) => ({ ...it }))
  const result = await mutate(items, raw)
  const status = deriveOrderStatus(items)
  // Legacy denormalisation: keep tests[] / test_panel / order-level result in
  // step so patient chart, admission workspace and reports stay accurate.
  const releasedTexts = items
    .filter((it) => it.status === ITEM_STATUS.RELEASED || it.status === ITEM_STATUS.VALIDATED || it.status === ITEM_STATUS.RESULT_ENTERED)
    .map((it) => formatItemResultText(it)).filter(Boolean)
  const patch = {
    items,
    status,
    tests: items.map((it) => it.test_name),
    test_panel: items.map((it) => it.test_name).join(', '),
    updated_at: serverTimestamp(),
  }
  if (releasedTexts.length) {
    const map = {}
    items.forEach((it) => {
      const t = formatItemResultText(it)
      if (t) map[it.test_name] = t
    })
    patch.result = map
  }
  if (items.some((it) => it.status === ITEM_STATUS.SAMPLE_COLLECTED || it.status === ITEM_STATUS.RECEIVED || it.status === ITEM_STATUS.RESULT_ENTERED || it.status === ITEM_STATUS.VALIDATED || it.status === ITEM_STATUS.RELEASED)) {
    if (!raw.collected_at) patch.collected_at = serverTimestamp()
  }
  if (items.some((it) => it.status === ITEM_STATUS.RECEIVED || it.status === ITEM_STATUS.RESULT_ENTERED || it.status === ITEM_STATUS.VALIDATED || it.status === ITEM_STATUS.RELEASED)) {
    if (!raw.processing_at) patch.processing_at = serverTimestamp()
    if (!raw.processed_at) patch.processed_at = serverTimestamp()
  }
  if (items.every((it) => it.status === ITEM_STATUS.RELEASED || it.status === ITEM_STATUS.CANCELLED) && items.some((it) => it.status === ITEM_STATUS.RELEASED)) {
    if (!raw.completed_at) patch.completed_at = serverTimestamp()
    if (!raw.verified_at) patch.verified_at = serverTimestamp()
  }
  if (items.every((it) => it.status === ITEM_STATUS.CANCELLED)) {
    if (!raw.cancelled_at) patch.cancelled_at = serverTimestamp()
  }
  await updateDoc(doc(db, LABS, lid), patch)
  if (audit) {
    try { await logAudit(audit) } catch (e) { console.warn('[labs] audit append failed:', e?.message) }
  }
  return result
}

function pushHistory(item, entry) {
  const history = Array.isArray(item.history) ? item.history.slice() : []
  history.push(entry)
  // Bounded: the last 20 transitions per test keep the doc small.
  item.history = history.slice(-20)
}

// ---- status update (legacy whole-order API) ---------------------------------
// Kept for AdmissionWorkspaceView and older callers. For item-based orders it
// fans the transition out across every active item; legacy orders fall back
// to the original single-status behaviour.
const validStatuses = ['order', 'accepted', 'specimen-collected', 'processing', 'completed', 'verified', 'cancelled']

export async function updateLabStatus(labId, status) {
  if (!validStatuses.includes(status)) throw new Error('Invalid lab status: ' + status)
  requireLabUpdate()
  const { user } = authStore.getState()
  const rawSnap = await getDoc(doc(db, LABS, labId))
  if (!rawSnap.exists()) throw new Error('Lab order not found.')
  const raw = { ...rawSnap.data(), id: labId }
  const hasItems = Array.isArray(raw.items) && raw.items.length

  if (!hasItems) {
    // Original behaviour for legacy orders.
    const updateData = { status, updated_at: serverTimestamp() }
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

  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const at = Date.now()
    for (const it of items) {
      if (it.status === ITEM_STATUS.CANCELLED || it.status === ITEM_STATUS.RELEASED) continue
      if (status === 'accepted') {
        // Acceptance is implicit in collection readiness; keep item state.
        continue
      }
      if (status === 'specimen-collected' && it.status === ITEM_STATUS.ORDERED) {
        it.status = ITEM_STATUS.SAMPLE_COLLECTED
        it.collection = { collected_at: at, collected_by: who.by, collected_by_name: who.byName, received_at: null, received_by: '', received_by_name: '', reject_reason: '' }
        pushHistory(it, { action: 'collected', at, by: who.by, by_name: who.byName, detail: 'via bulk order step' })
      }
      if (status === 'processing' && (it.status === ITEM_STATUS.SAMPLE_COLLECTED || it.status === ITEM_STATUS.ORDERED)) {
        if (it.status === ITEM_STATUS.ORDERED) {
          it.collection = { collected_at: at, collected_by: who.by, collected_by_name: who.byName, received_at: at, received_by: who.by, received_by_name: who.byName, reject_reason: '' }
        } else if (it.collection) {
          it.collection.received_at = at
          it.collection.received_by = who.by
          it.collection.received_by_name = who.byName
        }
        it.status = ITEM_STATUS.RECEIVED
        pushHistory(it, { action: 'received', at, by: who.by, by_name: who.byName, detail: 'via bulk order step' })
      }
      if (status === 'cancelled') {
        it.status = ITEM_STATUS.CANCELLED
        pushHistory(it, { action: 'cancelled', at, by: who.by, by_name: who.byName, detail: 'via bulk order step' })
      }
      if (status === 'verified' && (it.status === ITEM_STATUS.VALIDATED || it.status === ITEM_STATUS.RESULT_ENTERED)) {
        if (it.result) {
          it.status = ITEM_STATUS.RELEASED
          it.result.released_by = who.by
          it.result.released_by_name = who.byName
          it.result.released_at = at
          if (!it.result.validated_by) {
            it.result.validated_by = who.by
            it.result.validated_by_name = who.byName
            it.result.validated_at = at
          }
          pushHistory(it, { action: 'released', at, by: who.by, by_name: who.byName, detail: 'via bulk order step' })
        }
      }
    }
    return true
  }, {
    action: 'lab.order.status', organizationId: raw.organization_id, patientId: raw.patient_id,
    details: raw.order_no || labId + ' → ' + status,
  })

  // Mirror legacy timestamps at order level for old readers.
  const updateData = { updated_at: serverTimestamp() }
  if (status === 'accepted') updateData.accepted_at = serverTimestamp()
  if (status === 'cancelled') updateData.cancelled_at = serverTimestamp()
  await updateDoc(doc(db, LABS, labId), updateData)
  return true
}

// ---- sample workflow (per item) ---------------------------------------------
export async function collectItems(labId, itemIds = [], note = '') {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canCollect) throw new Error('Your role cannot collect samples (missing "lab.sample.collect" or "lab.order" capability).')
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items, raw) => {
    const targets = items.filter((it) => (!itemIds.length || itemIds.includes(it.item_id)) && it.status === ITEM_STATUS.ORDERED)
    if (!targets.length) throw new Error('No tests are awaiting collection for that selection.')
    for (const it of targets) {
      it.status = ITEM_STATUS.SAMPLE_COLLECTED
      it.collection = {
        collected_at: at, collected_by: who.by, collected_by_name: who.byName,
        received_at: null, received_by: '', received_by_name: '', reject_reason: '',
        note: String(note || '').trim(),
        specimen_type: it.specimen_type || (it.snapshot && it.snapshot.specimen_type) || '',
      }
      pushHistory(it, { action: 'collected', at, by: who.by, by_name: who.byName, detail: note || '' })
    }
    return targets.length
  }, {
    action: 'lab.sample.collected', organizationId: authStore.getState().activeOrg, patientId: undefined,
    details: (labId) + ' · ' + itemIds.length + ' test(s)',
  })
  return true
}

export async function receiveItems(labId, itemIds = []) {
  requireLabUpdate()
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const targets = items.filter((it) => (!itemIds.length || itemIds.includes(it.item_id)) && it.status === ITEM_STATUS.SAMPLE_COLLECTED)
    if (!targets.length) throw new Error('No collected samples waiting to be received.')
    for (const it of targets) {
      it.status = ITEM_STATUS.RECEIVED
      if (!it.collection) it.collection = { collected_at: at, collected_by: '', collected_by_name: '', reject_reason: '' }
      it.collection.received_at = at
      it.collection.received_by = who.by
      it.collection.received_by_name = who.byName
      pushHistory(it, { action: 'received', at, by: who.by, by_name: who.byName, detail: '' })
    }
    return targets.length
  }, {
    action: 'lab.sample.received', organizationId: authStore.getState().activeOrg,
    details: labId + ' · ' + itemIds.length + ' sample(s)',
  })
  return true
}

export async function rejectItem(labId, itemId, reason) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canCollect) throw new Error('Your role cannot reject samples (missing "lab.sample.collect" or "lab.order" capability).')
  const clean = String(reason || '').trim()
  if (!clean) throw new Error('A rejection / recollection reason is required.')
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (it.status === ITEM_STATUS.RELEASED) throw new Error('A released test cannot be rejected.')
    it.status = ITEM_STATUS.REJECTED
    if (!it.collection) it.collection = { collected_at: at, collected_by: '', collected_by_name: '', reject_reason: '' }
    it.collection.reject_reason = clean
    pushHistory(it, { action: 'rejected', at, by: who.by, by_name: who.byName, detail: clean })
    return true
  }, {
    action: 'lab.sample.rejected', organizationId: authStore.getState().activeOrg,
    details: labId + ' · ' + itemId + ' · ' + clean,
  })
  return true
}

export async function recollectItem(labId, itemId) {
  requireLabUpdate()
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (it.status !== ITEM_STATUS.REJECTED) throw new Error('Only rejected tests can be sent for recollection.')
    it.status = ITEM_STATUS.ORDERED
    it.collection = null
    pushHistory(it, { action: 'recollection', at, by: who.by, by_name: who.byName, detail: 'returned to collection queue' })
    return true
  }, {
    action: 'lab.sample.recollection', organizationId: authStore.getState().activeOrg,
    details: labId + ' · ' + itemId,
  })
  return true
}

export async function cancelItem(labId, itemId, reason = '') {
  requireLabUpdate()
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (it.status === ITEM_STATUS.RELEASED) throw new Error('A released test cannot be cancelled.')
    it.status = ITEM_STATUS.CANCELLED
    pushHistory(it, { action: 'cancelled', at, by: who.by, by_name: who.byName, detail: String(reason || '').trim() })
    return true
  }, {
    action: 'lab.test.cancelled', organizationId: authStore.getState().activeOrg,
    details: labId + ' · ' + itemId + (reason ? ' · ' + reason : ''),
  })
  return true
}

// ---- results (per item) ------------------------------------------------------
// Save the structured result for one ordered test. `values` is keyed by
// component id: { [componentId]: { value, remark } }. Flags (L/H) are computed
// from the SNAPSHOT reference configuration + patient sex/age at entry time.
// `draft: true` keeps the item in its current workflow state.
export async function saveItemResult(labId, itemId, { values = {}, note = '', draft = false } = {}) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canResult) {
    throw new Error('Your role cannot enter lab results (missing "lab.result.enter" capability). Ask an administrator.')
  }
  const { activeOrg, user } = authStore.getState()
  const rawSnap = await getDoc(doc(db, LABS, labId))
  if (!rawSnap.exists()) throw new Error('Lab order not found.')
  const raw = { ...rawSnap.data(), id: labId }
  const existing = normalizeLabItems(raw).find((it) => it.item_id === itemId)
  if (!existing) throw new Error('Test not found on this order.')
  if (existing.status === ITEM_STATUS.RELEASED) {
    throw new Error('This result has already been released. A correction must be audited — contact an administrator.')
  }
  // Workflow state first: results cannot appear before the sample is received.
  if (existing.status !== ITEM_STATUS.RECEIVED && existing.status !== ITEM_STATUS.RESULT_ENTERED && existing.status !== ITEM_STATUS.VALIDATED) {
    throw new Error('Receive the sample before entering results (current state: ' + existing.status + ').')
  }

  const snapshot = existing.snapshot || {
    test_id: '', name: existing.test_name, code: '', category: '', specimen_type: '',
    components: [sanitizeComponent({ id: 'legacy_result', name: 'Result', display_name: 'Result', result_type: 'text' }).component],
  }
  const check = validateResultValues(snapshot, values, { draft })
  if (!check.ok) throw new Error(check.error)
  const patient = await getPatientForFlags(raw.patient_id)
  const flagged = flagValues(check.values, snapshot, { ...patient, resultNow: Date.now() })

  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  const prior = existing.result && !existing.result.draft ? existing.result : null
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (it.status === ITEM_STATUS.RELEASED) throw new Error('This result has already been released.')
    if (it.status !== ITEM_STATUS.RECEIVED && it.status !== ITEM_STATUS.RESULT_ENTERED && it.status !== ITEM_STATUS.VALIDATED) {
      // Results cannot appear out of thin air — bounce back into the flow.
      throw new Error('Receive the sample before entering results (current state: ' + it.status + ').')
    }
    it.result = {
      values: flagged,
      note: String(note || '').trim(),
      draft: !!draft,
      entered_by: who.by,
      entered_by_name: who.byName,
      entered_at: at,
      validated_by: draft ? (it.result?.validated_by || '') : '',
      validated_by_name: draft ? (it.result?.validated_by_name || '') : '',
      validated_at: draft ? (it.result?.validated_at || null) : null,
      released_by: '',
      released_by_name: '',
      released_at: null,
    }
    if (!draft) it.status = ITEM_STATUS.RESULT_ENTERED
    pushHistory(it, {
      action: draft ? 'result.draft' : (prior ? 'result.edited' : 'result.entered'),
      at, by: who.by, by_name: who.byName,
      detail: prior ? 'previous values replaced' : '',
    })
    return true
  }, {
    action: prior ? 'lab.result.edited' : 'lab.result.entered',
    organizationId: activeOrg, patientId: raw.patient_id,
    details: (raw.order_no || labId) + ' · ' + it_name(existing) + (draft ? ' · draft' : ''),
  })
  return true
}

function it_name(it) {
  return it.test_name || it.item_id
}

export async function validateItem(labId, itemId) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canVerify) {
    throw new Error('Your role cannot validate lab results (missing "lab.result.verify" capability). Ask an administrator.')
  }
  const { activeOrg, user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (!it.result || !Object.keys(it.result.values || {}).length && !it.result.legacy_text) {
      throw new Error('Enter (or import) a result before validating.')
    }
    if (it.status !== ITEM_STATUS.RESULT_ENTERED && it.status !== ITEM_STATUS.VALIDATED) {
      throw new Error('Only tests with entered results can be validated (current state: ' + it.status + ').')
    }
    it.status = ITEM_STATUS.VALIDATED
    it.result.draft = false
    it.result.validated_by = who.by
    it.result.validated_by_name = who.byName
    it.result.validated_at = at
    pushHistory(it, { action: 'validated', at, by: who.by, by_name: who.byName, detail: '' })
    return true
  }, {
    action: 'lab.result.validated', organizationId: activeOrg, patientId: undefined,
    details: labId + ' · ' + itemId,
  })
  return true
}

export async function releaseItem(labId, itemId) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canVerify) {
    throw new Error('Your role cannot release lab results (missing "lab.result.verify" capability). Ask an administrator.')
  }
  const { activeOrg, user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  await mutateOrder(labId, (items) => {
    const it = items.find((x) => x.item_id === itemId)
    if (!it) throw new Error('Test not found on this order.')
    if (!it.result) throw new Error('Enter a result before releasing.')
    if (it.status !== ITEM_STATUS.VALIDATED && it.status !== ITEM_STATUS.RELEASED) {
      throw new Error('Validate the result before releasing it (current state: ' + it.status + ').')
    }
    if (!it.result.validated_by) {
      it.result.validated_by = who.by
      it.result.validated_by_name = who.byName
      it.result.validated_at = at
    }
    it.status = ITEM_STATUS.RELEASED
    it.result.released_by = who.by
    it.result.released_by_name = who.byName
    it.result.released_at = at
    pushHistory(it, { action: 'released', at, by: who.by, by_name: who.byName, detail: '' })
    return true
  }, {
    action: 'lab.result.released', organizationId: activeOrg, patientId: undefined,
    details: labId + ' · ' + itemId,
  })
  return true
}

export async function releaseOrder(labId) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canVerify) throw new Error('Your role cannot release lab results (missing "lab.result.verify" capability).')
  const rawSnap = await getDoc(doc(db, LABS, labId))
  if (!rawSnap.exists()) throw new Error('Lab order not found.')
  const items = normalizeLabItems({ ...rawSnap.data() })
  const releasable = items.filter((it) => it.status === ITEM_STATUS.VALIDATED)
  if (!releasable.length) throw new Error('No validated tests are waiting for release on this order.')
  for (const it of releasable) {
    await releaseItem(labId, it.item_id)
  }
  return true
}

// ---- add result (legacy API) -------------------------------------------------
// Kept for older callers: a { testName: text } map (or plain string) is written
// as legacy_text results and moves the tests to result_entered.
export async function addLabResult(labId, resultData) {
  requireLabUpdate()
  const caps = myLabCaps()
  if (!caps.canResult && !caps.canVerify) {
    throw new Error('Your role cannot enter lab results (missing "lab.result.enter" capability). Ask an administrator.')
  }
  const { user } = authStore.getState()
  const at = Date.now()
  const who = { by: user?.uid || '', byName: currentStaffName() }
  const map = (resultData && typeof resultData === 'object' && !Array.isArray(resultData)) ? resultData : null
  await mutateOrder(labId, (items, raw) => {
    for (const it of items) {
      if (it.status === ITEM_STATUS.CANCELLED || it.status === ITEM_STATUS.REJECTED) continue
      let text = ''
      if (map) text = String(map[it.test_name] ?? '')
      else text = String(resultData ?? '')
      if (!text && items.length === 1 && !map) text = String(resultData ?? '')
      if (!text) continue
      const snapshot = it.snapshot || {
        test_id: '', name: it.test_name, code: '', category: '', specimen_type: '',
        components: [sanitizeComponent({ id: 'legacy_result', name: 'Result', display_name: 'Result', result_type: 'text' }).component],
      }
      const comp = snapshot.components[0] || { id: 'legacy_result' }
      it.snapshot = snapshot
      it.result = {
        values: { [comp.id]: { value: text, remark: '', flag: '' } },
        legacy_text: text,
        note: '',
        draft: false,
        entered_by: who.by, entered_by_name: who.byName, entered_at: at,
        validated_by: '', validated_by_name: '', validated_at: null,
        released_by: '', released_by_name: '', released_at: null,
      }
      if (it.status !== ITEM_STATUS.VALIDATED && it.status !== ITEM_STATUS.RELEASED) it.status = ITEM_STATUS.RESULT_ENTERED
      pushHistory(it, { action: 'result.entered', at, by: who.by, by_name: who.byName, detail: 'legacy entry' })
    }
    // Keep the top-level legacy `result` in step for older readers.
    raw.result = map || resultData
    return true
  }, {
    action: 'lab.result.entered', organizationId: authStore.getState().activeOrg,
    details: labId + ' · legacy entry',
  })
  return true
}

// ---- add verification (legacy API) -------------------------------------------
export async function addLabVerification(labId, verifiedById, verifiedByName) {
  requireLabUpdate()
  const { activeOrg, user } = authStore.getState()
  const at = Date.now()
  const who = {
    by: verifiedById || user?.uid || '',
    byName: verifiedByName || currentStaffName(),
  }
  await mutateOrder(labId, (items) => {
    for (const it of items) {
      if (!it.result || it.status === ITEM_STATUS.CANCELLED || it.status === ITEM_STATUS.REJECTED) continue
      if (!it.result.validated_by) {
        it.result.validated_by = who.by
        it.result.validated_by_name = who.byName
        it.result.validated_at = at
      }
      it.status = ITEM_STATUS.RELEASED
      it.result.released_by = who.by
      it.result.released_by_name = who.byName
      it.result.released_at = at
      pushHistory(it, { action: 'released', at, by: who.by, by_name: who.byName, detail: 'legacy verification' })
    }
    return true
  }, {
    action: 'lab.result.released', organizationId: activeOrg, details: labId + ' · legacy verification',
  })
  // Also stamp the legacy top-level fields.
  await updateDoc(doc(db, LABS, labId), {
    status: 'verified',
    verified_by: who.by,
    verified_by_name: who.byName,
    verified_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  })
  return true
}

// ---- billing stamp ------------------------------------------------------------
// Called by the billing integration after an invoice is created for an order.
export async function stampLabInvoice(labId, invoiceId) {
  requireLabUpdate()
  await updateDoc(doc(db, LABS, labId), {
    invoice_id: invoiceId,
    billing_status: 'invoiced',
    updated_at: serverTimestamp(),
  })
  return true
}

// ---- billing unstamp ------------------------------------------------------------
// Reverses stampLabInvoice: clears the invoice tie from a lab order so it
// can be deleted later. Safe to call even if the order was never stamped.
export async function unstampLabInvoice(labId) {
  await updateDoc(doc(db, LABS, labId), {
    invoice_id: '',
    billing_status: 'unbilled',
    updated_at: serverTimestamp(),
  })
  return true
}

export { ITEM_STATUS, ITEM_STATUS_META }
