// Pharmacy data layer (direct Firestore, Spark plan: no backend).
// Catalog + inventory + dispensing + batches/expiry.
//
// Collection names MUST match firestore.rules: inventory lives in `stock_lots`
// and dispense tickets in `dispensations` (both guarded by the
// `prescription.dispense` capability). Dispensations are append-only per the
// rules (no update), so status changes are recorded as new docs, never edits.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, runTransaction, serverTimestamp, orderBy, limit, startAfter,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'
import { generateSku, isExactNameMatch, isSimilarName } from '../utils/sku.js'
import {
  toRequestItems, applyIssue, statusForProgress, normalizeRequest, toLine, mergeRequestLine,
  lineOutstanding, isOpenRequest, REQUEST_STATUS, requestProgress, toQty, freshLineId,
} from '../features/pharmacy/requests.js'

const DRUGS = 'stock_lots'
const DISPENSE = 'dispensations'
const REQUESTS = 'medication_requests'

// Dispensations are bounded to the 100 most recent (cost control); drugs is a
// name-sorted catalogue of bounded size, so it stays unbounded.
const LIVE_LIMIT = 100

// ---- capability check --------------------------------------------------------
export function myPharmacyCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canManageInventory: can(me, 'prescription.dispense'),
    canDispense: can(me, 'prescription.dispense'),
  }
}

// ---- model shape -----------------------------------------------------------
function toDrugRow(r) {
  return {
    id: r.id,
    name: r.name || '',
    drug_code: r.drug_code || '',
    strength: r.strength || '',
    pack_size: r.pack_size || '',
    sku: r.sku || '',
    unit: r.unit || 'tabs',
    stock: r.stock || 0,
    price: r.price || 0,
    batch: r.batch || '',
    expiry: r.expiry || '',
    status: r.status || 'OK',
    supplier: r.supplier || '',
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    raw: r,
  }
}

function toDispenseRow(r) {
  return {
    id: r.id,
    patientId: r.patient_id || '',
    patientName: r.patient_name || '',
    items: r.items || '',
    by: r.by || '',
    // Dispensation docs store lowercase status ('dispensed'), but statusBadge keys
    // on the capitalised labels ('Dispensed'), so every pharmacy-issued ticket
    // rendered as an unstyled pill. Normalise for display only — the stored value
    // is unchanged.
    status: /dispensed/i.test(r.status || '') ? 'Dispensed' : (/pending/i.test(r.status || '') ? 'Pending' : (r.status || 'Pending')),
    time: r.time || '',
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
function buildOrgDrugsQuery(orgId) {
  return query(collection(db, DRUGS), where('organization_id', '==', orgId))
}

function mapDrugDoc(d) {
  return toDrugRow({ ...d.data(), id: d.id })
}

function sortDrugs(rows) {
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export async function listOrgDrugs(orgId) {
  const snap = await getDocs(buildOrgDrugsQuery(orgId))
  return sortDrugs(snap.docs.map(mapDrugDoc))
}

// Chunked lists, cursor-walked for infinite scroll. Drugs order by name (stable
// catalogue order); dispensations newest first. Needs indexes:
// stock_lots: organization_id ASC + name ASC
// dispensations: organization_id ASC + created_at DESC
export const DRUGS_PAGE = 50
export const DISPENSE_PAGE = 25

export async function listOrgDrugsPage(orgId, { pageSize = DRUGS_PAGE, cursor = null } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, DRUGS),
    where('organization_id', '==', orgId),
    orderBy('name', 'asc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: sortDrugs(docs.map(mapDrugDoc)), hasMore, cursor: next }
}


// Same query, same ordering and row shape as listOrgDrugs, pushed on every change.
export function subscribeOrgDrugs(orgId, onRows, onError) {
  return watchQuery(
    buildOrgDrugsQuery(orgId),
    mapDrugDoc,
    (rows) => onRows(sortDrugs(rows)),
    onError,
  )
}

function buildOrgDispenseQuery(orgId) {
  return query(collection(db, DISPENSE), where('organization_id', '==', orgId))
}

function mapDispenseDoc(d) {
  return toDispenseRow({ ...d.data(), id: d.id })
}

function sortDispense(rows) {
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

export async function listOrgDispense(orgId) {
  const snap = await getDocs(buildOrgDispenseQuery(orgId))
  return sortDispense(snap.docs.map(mapDispenseDoc))
}

export async function listOrgDispensePage(orgId, { pageSize = DISPENSE_PAGE, cursor = null } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, DISPENSE),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: sortDispense(docs.map(mapDispenseDoc)), hasMore, cursor: next }
}

// Same query, same ordering and row shape as listOrgDispense, pushed on every change.
// Live query: same org scope + row shape as listOrgDispense, but bounded to
// the 100 most recent (orderBy+limit needs the composite index in
// firestore.indexes.json — deploy it or the listener falls back to one-shot).
function buildOrgDispenseLiveQuery(orgId) {
  return query(
    collection(db, DISPENSE),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgDispense(orgId, onRows, onError) {
  return watchQuery(
    buildOrgDispenseLiveQuery(orgId),
    mapDispenseDoc,
    (rows) => onRows(sortDispense(rows)),
    onError,
  )
}

// Get single drug
export async function getDrug(did) {
  const snap = await getDoc(doc(db, DRUGS, did))
  if (!snap.exists()) return null
  return toDrugRow({ ...snap.data(), id: snap.id })
}

// ---- name uniqueness check -------------------------------------------------
// Scans the org catalogue for exact and fuzzy name matches.
//   exact   — case-insensitive 100% match → caller should hard-reject.
//   similar — high-similarity match (typo-level) → caller should warn.
export async function findDrugNameMatches(orgId, name) {
  const drugs = await listOrgDrugs(orgId)
  const exact = drugs.find((d) => isExactNameMatch(d.name, name)) || null
  const similar = drugs.filter((d) => isSimilarName(d.name, name))
  return { exact, similar }
}

// ---- prescriber-facing catalogue ---------------------------------------------
// Prescribing is only offered against what the hospital can actually issue.
// `inStockDrugs` is the single definition of "prescribable" shared by the
// consultation workspace and the patient chart, so the two can never disagree
// about which medicines a clinician is allowed to pick.
export function inStockDrugs(drugs) {
  return (drugs || []).filter((d) => Number(d.stock || 0) > 0)
}

// Options for a formModal `select`. The on-hand count is in the label because
// that is what the prescriber needs to judge the quantity they are about to
// request; `value` stays the lot id so dispensing can resolve straight to a
// stock_lots doc instead of re-matching on a display name.
export function drugPickerOptions(drugs) {
  return inStockDrugs(drugs).map((d) => ({
    value: d.id,
    label: d.name + (d.sku ? ' · ' + d.sku : '') + ' — ' + Number(d.stock || 0) + ' ' + (d.unit || 'tabs') + ' in stock',
  }))
}

// ---- create / update drug ------------------------------------------------
export async function createDrug(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPharmacyCaps()
  if (!caps.canManageInventory) {
    throw new Error('Your role cannot manage medication inventory (missing "prescription.dispense" capability). Ask an administrator.')
  }

  const did = doc(collection(db, DRUGS)).id
  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    const drugRef = doc(db, DRUGS, did)

    // If opening stock > 0, create an 'opening' movement in the same transaction
    const openingQty = Number(input.stock) || 0
    if (openingQty > 0) {
      tx.set(drugRef, {
        name: input.name || '',
        drug_code: (input.drug_code || '').trim().toUpperCase(),
        strength: input.strength || '',
        pack_size: input.pack_size || '',
        organization_id: activeOrg,
        sku: input.sku || generateSku(input.drug_code, input.strength, input.pack_size) || '',
        unit: input.unit || 'tabs',
        stock: openingQty,
        price: input.price || 0,
        batch: input.batch || '',
        expiry: input.expiry || '',
        status: openingQty === 0 ? 'Out' : (openingQty < 20 ? 'Low' : 'OK'),
        supplier: input.supplier || '',
        created_by: user?.uid || null,
        created_by_name: user?.email || '',
        created_at: now,
        updated_at: now,
      })

      // Create 'opening' movement
      const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
      const movementRef = doc(db, 'stock_movements', movementId)
      tx.set(movementRef, {
        type: 'opening',
        organization_id: activeOrg,
        drug_id: did,
        sku: input.sku || input.drug_code || '',
        name: input.name || '',
        qty: openingQty,
        batch: input.batch || '',
        expiry: input.expiry || '',
        reference: 'opening balance',
        created_by: user?.uid || null,
        created_by_name: user?.email || '',
        created_at: now,
      })
    } else {
      // No opening stock — create lot doc with stock=0
      tx.set(drugRef, {
        name: input.name || '',
        drug_code: (input.drug_code || '').trim().toUpperCase(),
        strength: input.strength || '',
        pack_size: input.pack_size || '',
        organization_id: activeOrg,
        sku: input.sku || generateSku(input.drug_code, input.strength, input.pack_size) || '',
        unit: input.unit || 'tabs',
        stock: 0,
        price: input.price || 0,
        batch: input.batch || '',
        expiry: input.expiry || '',
        status: 'Out',
        supplier: input.supplier || '',
        created_by: user?.uid || null,
        created_by_name: user?.email || '',
        created_at: now,
        updated_at: now,
      })
    }

    try {
      await logAudit({ action: 'drug.created', organizationId: activeOrg, details: (input.name || '') + ' · ' + (input.sku || '') })
    } catch (e) {
      console.warn('[pharmacy] audit append failed:', e?.message)
    }

    // Firestore requires every read to precede every write inside a transaction, so
    // the created doc is echoed back from the values written above rather than
    // re-read. A tx.get() here failed the commit with FAILED_PRECONDITION, which
    // meant "+ Add item" never worked whenever opening stock was > 0.
    return {
      id: did,
      name: input.name || '',
      drug_code: (input.drug_code || '').trim().toUpperCase(),
      strength: input.strength || '',
      pack_size: input.pack_size || '',
      organization_id: activeOrg,
      sku: input.sku || generateSku(input.drug_code, input.strength, input.pack_size) || '',
      unit: input.unit || 'tabs',
      price: input.price || 0,
      batch: input.batch || '',
      expiry: input.expiry || '',
      supplier: input.supplier || '',
    }
  })
}

export async function updateDrug(did, input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')

  const now = serverTimestamp()
  const drugRef = doc(db, DRUGS, did)

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(drugRef)
    if (!snap.exists()) throw new Error('Drug not found')
    const data = snap.data()

    // Create adjust movement with reason — replaces blind stock overwrite
    const adjustQty = Number(input.stock) - (data.stock || 0)
    const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
    const movementRef = doc(db, 'stock_movements', movementId)
    tx.set(movementRef, {
      type: 'adjust',
      organization_id: data.organization_id,
      drug_id: did,
      sku: data.sku,
      name: data.name,
      qty: adjustQty, // signed: positive if increasing, negative if decreasing
      batch: input.batch || data.batch,
      expiry: input.expiry || data.expiry,
      reason: input.reason || 'Stock adjustment via UI',
      counted_qty: Number(input.stock) || 0,
      created_by: user?.uid || null, // note: user may not be in scope; adjust per app needs
      created_by_name: user?.email || '',
      created_at: now,
    })

    // Update drug fields
    tx.update(drugRef, {
      name: input.name,
      drug_code: input.drug_code || '',
      strength: input.strength || '',
      pack_size: input.pack_size || '',
      sku: input.sku || generateSku(input.drug_code, input.strength, input.pack_size) || '',
      unit: input.unit,
      stock: input.stock,
      price: input.price,
      batch: input.batch,
      expiry: input.expiry,
      status: input.status,
      supplier: input.supplier,
      updated_at: now,
    })

    return true
  })
}

// ---- receive batch (intake) -------------------------------------------------
// Validates qty > 0 and expiry >= today (warn if < 6 months),
// creates an 'in' movement in stock_movements, increments lot.stock,
// syncs lot batch/expiry to the soonest-expiry open batch, and audits.

export async function receiveBatch(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPharmacyCaps()
  if (!caps.canDispense) {
    throw new Error('Your role cannot manage medication inventory (missing "prescription.dispense" capability). Ask an administrator.')
  }

  const did = input.drugId // the stock_lots doc id
  const lotRef = doc(db, DRUGS, did)
  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(lotRef)
    if (!snap.exists()) throw new Error('Drug not found')
    const data = snap.data()

    const qty = Number(input.qty)
    if (qty <= 0) throw new Error('Qty must be greater than zero.')

    const expiryDate = new Date(input.expiry)
    const today = new Date()
    if (expiryDate < today) throw new Error('Expiry date must be in the future.')

    // Warn if expiry is less than 6 months from today
    const sixMonthsLater = new Date(today.getTime() + 6 * 30 * 24 * 60 * 60 * 1000)
    if (expiryDate < sixMonthsLater) {
      console.warn('[pharmacy] Batch expiry within 6 months:', input.expiry)
    }

    // Generate a movement ID and create the 'in' movement
    const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
    const movementRef = doc(db, 'stock_movements', movementId)
    tx.set(movementRef, {
      type: 'in',
      organization_id: activeOrg,
      drug_id: did,
      sku: data.sku,
      name: data.name,
      qty: qty,
      batch: input.batch,
      expiry: input.expiry,
      supplier: input.supplier || data.supplier,
      unit_cost: input.unit_cost || 0,
      invoice_ref: input.invoice_ref || '',
      received_at: now,
      created_by: user?.uid || null,
      created_by_name: user?.email || '',
      created_at: now,
    })

    // Update lot stock and sync batch/expiry to the new batch
    const newStock = (data.stock || 0) + qty
    tx.update(lotRef, {
      stock: newStock,
      batch: input.batch,
      expiry: input.expiry,
      // Keep the derived status in step with stock, so restocking a lot that had
      // fallen to zero stops reading "Out".
      status: newStock === 0 ? 'Out' : (newStock < 20 ? 'Low' : 'OK'),
      updated_at: now,
    })

    try {
      await logAudit({ action: 'stock.received', organizationId: activeOrg, details: `${data.name} · ${qty} · ${input.batch}` })
    } catch (e) {
      console.warn('[pharmacy] audit append failed:', e?.message)
    }

    return { id: did, newStock }
  })
}

// ---- dispense (issue stock) -------------------------------------------------
// Reads ALL affected lots in the transaction, checks onHand >= requested,
// creates 'out' movement(s) with FEFO batch selection, decrements lot.stock,
// creates a dispensations ticket, and folds the issue back into the originating
// medication request. All in ONE transaction, then audit.
//
// A request is a whole prescription (many lines). Issuing part of it is normal —
// stock runs short — so the request carries a `dispensed_qty` per line and is
// only 'Dispensed' once every line is fully issued. The request doc is READ
// inside this same transaction, so the line state and the stock movement can
// never disagree.

export async function dispense(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPharmacyCaps()
  if (!caps.canDispense) {
    throw new Error('Your role cannot dispense medication (missing "prescription.dispense" capability). Ask an administrator.')
  }

  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    // input: { items: [{ drugId, requestedQty, lineId? }], patientId, patientName,
    //          medicationRequestId? }
    const { items, patientId, patientName, medicationRequestId } = input
    if (!Array.isArray(items) || !items.length) throw new Error('Nothing selected to dispense.')

    // Read all affected lot docs in this transaction
    const lotRefs = items.map((it) => doc(db, DRUGS, it.drugId))
    const lotSnaps = await Promise.all(lotRefs.map((ref) => tx.get(ref)))

    // The originating request is read here too (a read, so it must precede any
    // write below) and its lines are updated from the same transaction.
    const reqRef = medicationRequestId ? doc(db, 'medication_requests', medicationRequestId) : null
    const reqSnap = reqRef ? await tx.get(reqRef) : null
    if (reqRef && !reqSnap.exists()) throw new Error('This prescription request no longer exists.')

    // External lines are filled at an outside pharmacy, so an issue aimed at one
    // is refused here — it must never decrement in-house stock or be recorded as
    // dispensed against a medicine this hospital does not hold.
    if (reqSnap && reqSnap.exists()) {
      const existingLines = toRequestItems(reqSnap.data())
      for (const it of items) {
        const lineId = it.lineId || (existingLines.length === 1 ? existingLines[0].line_id : '')
        const line = lineId ? existingLines.find((l) => l.line_id === lineId) : null
        if (line && line.external) {
          throw new Error(`"${line.medicine || 'This medicine'}" is an external prescription and cannot be dispensed from in-house stock.`)
        }
      }
    }

    // Check each lot exists and has sufficient stock
    for (let i = 0; i < lotSnaps.length; i++) {
      const snap = lotSnaps[i]
      if (!snap.exists()) throw new Error(`Drug ${items[i].drugId} not found`)
      const data = snap.data()
      const requested = Number(items[i].requestedQty)
      if (requested <= 0) throw new Error(`Qty must be greater than zero for ${data.name || ''}`)
      if ((data.stock || 0) < requested) {
        throw new Error(`Insufficient stock for ${data.name || ''}. On hand: ${data.stock || 0}, requested: ${requested}`)
      }
    }

    // Ticket id is minted up front so each 'out' movement can carry it. It was
    // previously written as '' with a "will be set later" comment and never
    // backfilled, which left every movement untraceable to its ticket.
    const dispensationId = 'disp_' + Date.now() + Math.random().toString(36).slice(2)

    // Build out movements and decrement stock
    for (let i = 0; i < lotSnaps.length; i++) {
      const snap = lotSnaps[i]
      const data = snap.data()
      const requested = Number(items[i].requestedQty)
      const batch = data.batch || '' // current batch (soonest-expiry open batch)
      const expiry = data.expiry || ''

      // Create 'out' movement
      const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
      const movementRef = doc(db, 'stock_movements', movementId)
      tx.set(movementRef, {
        type: 'out',
        organization_id: activeOrg,
        drug_id: items[i].drugId,
        sku: data.sku,
        name: data.name,
        qty: requested,
        batch: batch,
        expiry: expiry,
        patient_id: patientId,
        patient_name: patientName,
        dispensation_id: dispensationId,
        medication_request_id: medicationRequestId || '',
        created_by: user?.uid || null,
        created_by_name: user?.email || '',
        created_at: now,
      })

      // Decrement lot stock
      const newStock = (data.stock || 0) - requested
      const remaining = newStock > 0 ? newStock : 0
      const lotRef = doc(db, DRUGS, items[i].drugId)
      tx.update(lotRef, {
        stock: remaining,
        // The lot doc holds one open batch at a time. Once it is exhausted the
        // batch/expiry are cleared so the Batches tab cannot keep listing a
        // batch that has nothing left in it.
        batch: remaining > 0 ? data.batch : '',
        expiry: remaining > 0 ? data.expiry : '',
        // status is derived from stock. It was only ever set at create time, so
        // a lot drawn down to zero by dispensing kept reading "Low" next to
        // "0 tabs" in the Inventory tab.
        status: remaining === 0 ? 'Out' : (remaining < 20 ? 'Low' : 'OK'),
        updated_at: now,
      })
    }

    // Create dispensations ticket with structured items
    const itemsString = JSON.stringify(
      items.map((it, idx) => {
        const lotSnap = lotSnaps[idx].data()
        return {
          drug_id: it.drugId,
          sku: lotSnap.sku,
          name: lotSnap.name,
          batch: lotSnap.batch || '',
          qty: Number(it.requestedQty),
          unit: lotSnap.unit || 'tabs',
        }
      })
    )

    const dispenseRef = doc(db, 'dispensations', dispensationId)
    tx.set(dispenseRef, {
      patient_id: patientId,
      patient_name: patientName,
      items: itemsString,
      by: user?.email || '',
      status: 'dispensed',
      organization_id: activeOrg,
      created_at: now,
      updated_at: now,
      medication_request_id: medicationRequestId || '',
    })

    // Fold the issue back into the request's lines. Legacy single-line docs are
    // folded into a one-item list first, so they follow the same path.
    let requestProgress = null
    if (medicationRequestId) {
      const existingItems = toRequestItems(reqSnap.data())
      const issued = {}
      let mappable = true
      for (const it of items) {
        const lineId = it.lineId || (existingItems.length === 1 ? existingItems[0].line_id : '')
        if (!lineId) { mappable = false; continue }
        issued[lineId] = (issued[lineId] || 0) + Number(it.requestedQty)
      }
      const patch = { updated_at: now }
      if (mappable) {
        const applied = applyIssue(existingItems, issued)
        patch.items = applied.items
        patch.status = statusForProgress(applied)
        requestProgress = applied
      } else {
        // Lines could not be matched to a request line. The legacy blanket
        // status is safer than writing a wrong quantity onto the wrong line.
        patch.status = 'Dispensed'
        patch.dispensed_at = now
      }
      if (requestProgress && requestProgress.outstanding === 0) patch.dispensed_at = now
      tx.update(reqRef, patch)
    }

    try {
      await logAudit({ action: 'dispense.created', organizationId: activeOrg, details: `${patientName} · ${items.map((it) => `${it.requestedQty}x`).join(' · ')}` })
    } catch (e) {
      console.warn('[pharmacy] audit append failed:', e?.message)
    }

    return {
      dispensationId,
      patientId,
      patientName,
      requestProgress,
      items: items.map((it, idx) => ({
        drugId: it.drugId,
        requestedQty: it.requestedQty,
        lineId: it.lineId || '',
        lotStock: (lotSnaps[idx].data()?.stock || 0) - Number(it.requestedQty),
      })),
    }
  })
}

// ---- reverse a dispense (one medicine line) ---------------------------------
// Undoes ONE issued line: the units go back on the shelf, that line's
// `dispensed_qty` drops to zero so the medicine is editable again, and the
// request's status is re-derived — a fully dispensed script returns to
// `Requested`, so every prescribing surface offers Adjust once more.
//
// The original 'out' movement and dispense ticket stay exactly as they were:
// they record what physically left the cupboard. The undo is written as a
// compensating 'in' movement plus an append-only 'reversed' ticket, so the
// ledger still balances and nothing is rewritten after the fact.
export async function reverseDispenseIssue({ requestId, lineId }) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPharmacyCaps()
  if (!caps.canDispense) {
    throw new Error('Your role cannot reverse a dispense (missing "prescription.dispense" capability). Ask an administrator.')
  }
  if (!requestId || !lineId) throw new Error('Nothing selected to reverse.')
  const now = serverTimestamp()
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))

  // Read the request and lot up front purely to validate the line and to learn
  // whether the lot's batch/expiry were cleared on the way to zero. The
  // transaction re-reads both before writing, so this cannot race a dispense.
  const preSnap = await getDoc(doc(db, REQUESTS, requestId))
  if (!preSnap.exists()) throw new Error('This prescription no longer exists.')
  if (preSnap.data().organization_id !== activeOrg) throw new Error('This prescription belongs to a different hospital.')
  const preLine = toRequestItems({ id: preSnap.id, ...preSnap.data() }).find((l) => l.line_id === lineId)
  if (!preLine) throw new Error('That medicine is no longer on this prescription.')
  const medicine = preLine.medicine || 'This medicine'
  if (preLine.external) {
    throw new Error('"' + medicine + '" is an external prescription — it never left in-house stock, so there is nothing to reverse.')
  }
  if (toQty(preLine.dispensed_qty, 0) <= 0) {
    throw new Error('"' + medicine + '" has not been dispensed, so there is nothing to reverse.')
  }
  if (!preLine.drug_id) {
    throw new Error('"' + medicine + '" is not matched to a catalogue item, so its stock cannot be returned.')
  }

  const lotRef = doc(db, DRUGS, preLine.drug_id)
  const preLot = await getDoc(lotRef)
  if (!preLot.exists()) {
    throw new Error('The catalogue item for "' + medicine + '" no longer exists — its stock was not returned.')
  }
  // A lot drawn down to zero loses its batch/expiry, and the 'out' movement is
  // the only record of which batch went out — read it back so returned units
  // do not come back as stock with no batch left to dispense from.
  let restore = null
  if (!preLot.data().batch) {
    const moves = await getDocs(query(
      collection(db, 'stock_movements'),
      where('medication_request_id', '==', requestId),
      where('drug_id', '==', preLine.drug_id),
    ))
    const out = moves.docs
      .map((d) => d.data())
      .filter((m) => m && m.type === 'out' && m.batch)
      .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0]
    if (out) restore = { batch: out.batch || '', expiry: out.expiry || '' }
  }

  return runTransaction(db, async (tx) => {
    const reqRef = doc(db, REQUESTS, requestId)
    const reqSnap = await tx.get(reqRef)
    if (!reqSnap.exists()) throw new Error('This prescription no longer exists.')
    const data = reqSnap.data()
    if (data.organization_id !== activeOrg) throw new Error('This prescription belongs to a different hospital.')

    const items = toRequestItems({ id: reqSnap.id, ...data })
    const line = items.find((l) => l.line_id === lineId)
    if (!line || line.external) throw new Error('"' + medicine + '" can no longer be reversed.')
    const qty = toQty(line.dispensed_qty, 0)
    if (qty <= 0) throw new Error('"' + medicine + '" has not been dispensed, so there is nothing to reverse.')

    const lotSnap = await tx.get(lotRef)
    if (!lotSnap.exists()) throw new Error('The catalogue item for "' + medicine + '" no longer exists — its stock was not returned.')
    const lot = lotSnap.data()
    const batch = lot.batch || (restore ? restore.batch : '')
    const expiry = lot.expiry || (restore ? restore.expiry : '')
    const newStock = Number(lot.stock || 0) + qty

    const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
    tx.set(doc(db, 'stock_movements', movementId), {
      type: 'in',
      organization_id: activeOrg,
      drug_id: line.drug_id,
      sku: lot.sku || '',
      name: lot.name || medicine,
      qty,
      batch,
      expiry,
      reason: 'Dispense reversed',
      patient_id: data.patient_id || '',
      medication_request_id: requestId,
      line_id: lineId,
      created_by: user?.uid || null,
      created_by_name: user?.email || '',
      created_at: now,
    })

    tx.update(lotRef, {
      stock: newStock,
      batch,
      expiry,
      // status is derived from stock, exactly as dispense() keeps it.
      status: newStock === 0 ? 'Out' : (newStock < 20 ? 'Low' : 'OK'),
      updated_at: now,
    })

    // Dispensations are append-only (firestore.rules: update is false), so the
    // undo is a second ticket on the same request rather than an edit.
    const ticketId = 'rev_' + Date.now() + Math.random().toString(36).slice(2)
    tx.set(doc(db, DISPENSE, ticketId), {
      patient_id: data.patient_id || '',
      patient_name: data.patient_name || '',
      items: JSON.stringify([{
        drug_id: line.drug_id, sku: lot.sku || '', name: lot.name || medicine,
        batch, qty, unit: lot.unit || 'tabs',
      }]),
      by: user?.email || '',
      status: 'reversed',
      reason: 'Dispense reversed for "' + medicine + '"',
      organization_id: activeOrg,
      medication_request_id: requestId,
      line_id: lineId,
      created_at: now,
      updated_at: now,
    })

    const next = items.map((l) => (l.line_id === lineId ? { ...l, dispensed_qty: 0 } : l))
    const progress = requestProgress(next)
    tx.update(reqRef, {
      items: next,
      status: statusForProgress(progress),
      reason: 'Dispense reversed',
      // A reversal always leaves this line owing its full quantity again, so
      // the script can no longer be complete.
      dispensed_at: null,
      updated_at: now,
    })

    try {
      await logAudit({
        action: 'dispense.reversed',
        organizationId: activeOrg,
        details: `${data.patient_name || 'patient'} · ${qty} × ${medicine}`,
      })
    } catch (e) {
      console.warn('[pharmacy] audit append failed:', e?.message)
    }

    return { requestId, lineId, qty, medicine, newStock, items: next, status: statusForProgress(progress) }
  })
}

// ---- medication requests (prescription orders) ------------------------------
// One request = one prescription script for one patient/encounter, holding every
// line the prescriber wrote. Prescribing a second drug joins the open script
// rather than creating a rival row, which is what makes the pharmacy queue
// readable: one row per patient to open, not one row per pill box.

// The open script for this patient/encounter, if any. Scoped by encounter when
// there is one, otherwise by patient, so a chart-side prescription still groups
// per patient rather than scattering. Additionally, when an admission session id
// is supplied the search is scoped by admission_session_id so that inpatient
// scripts group per stay rather than per patient.
export async function findOpenRequest({ patientId, encounterId = '', admissionSessionId = '' }) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) return null
  const constraints = [where('organization_id', '==', activeOrg)]
  if (admissionSessionId) {
    constraints.push(where('admission_session_id', '==', admissionSessionId))
  } else if (encounterId) {
    constraints.push(where('encounter_id', '==', encounterId))
  } else if (patientId) {
    constraints.push(where('patient_id', '==', patientId))
  } else {
    return null
  }
  const snap = await getDocs(query(collection(db, REQUESTS), ...constraints))
  // Only an open script absorbs a new line; a dispensed one is history and the
  // next prescription must start a fresh order. An all-external script is still
  // "open" for prescribing (it is never dispensed), so further lines append to
  // it rather than spawning a duplicate request per medicine.
  const open = snap.docs
    .map((d) => normalizeRequest({ id: d.id, ...d.data() }))
    .filter((r) => isOpenRequest(r.status) || r.status === REQUEST_STATUS.EXTERNAL)
  return open[0] || null
}

// Append a prescribed line to the patient's open script, or start a new one.
// Requires `prescription.create` — the prescriber's capability. Dispensing stays
// with `prescription.dispense`, so a doctor can write the script and a
// pharmacist can issue it.
// Optional `admissionSessionId` scopes the request to the admission stay; when
// provided the script groups per stay rather than per patient/encounter.
export async function requestMedication(args) {
  return requestMedicationLines({ ...args, lines: [args.line] })
}

// The same, for a whole script written in one go: every line lands on ONE
// request in ONE write, so a four-drug prescription is one order with four
// lines rather than four racing writes that could each open their own order.
//
// `syncKey` (optional) is the outbox's idempotency key: a replayed handoff
// (cloud retry after a lost ack, or hub relay racing the browser) carries the
// same key, and a request already stamped with it short-circuits — without
// this, a replay would re-merge the same lines and double every quantity.
export async function requestMedicationLines({ patientId, patientName = '', encounterId = '', lines = [], admissionSessionId = '', syncKey = '' }) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const me = myActiveMembership()
  if (!can(me, 'prescription.create')) {
    throw new Error('Your role cannot prescribe (missing "prescription.create" capability).')
  }
  if (!patientId) throw new Error('A patient is required for a prescription.')
  const normalised = (lines || [])
    .map((l, i) => toLine(l, i))
    .filter((l) => l.medicine || l.drug_id)
  if (!normalised.length) throw new Error('Choose at least one medicine to prescribe.')

  // Replay guard (single-field array-contains needs no composite index).
  if (syncKey) {
    const replay = await getDocs(query(collection(db, REQUESTS), where('sync_keys', 'array-contains', syncKey)))
    if (replay.docs.length) {
      const d = replay.docs[0]
      return { id: d.id, items: toRequestItems({ id: d.id, ...d.data() }), deduped: true, created: false }
    }
  }

  const existing = await findOpenRequest({ patientId, encounterId, admissionSessionId })
  const now = serverTimestamp()

  if (existing) {
    let items = existing.items
    for (const line of normalised) items = mergeRequestLine(items, line)
    const updateData = {
      items,
      updated_at: now,
    }
    //Stamp admission_session_id when updating an existing request
    if (admissionSessionId && existing.raw?.admission_session_id !== admissionSessionId) {
      updateData.admission_session_id = admissionSessionId
    }
    if (syncKey) {
      const seen = new Set(existing.raw?.sync_keys || [])
      seen.add(syncKey)
      updateData.sync_keys = [...seen]
    }
    await updateDoc(doc(db, REQUESTS, existing.id), updateData)
    return { id: existing.id, items, created: false }
  }

  const ref = doc(collection(db, REQUESTS))
  const requestData = {
    patient_id: patientId,
    patient_name: patientName,
    encounter_id: encounterId,
    admission_session_id: admissionSessionId || '',
    organization_id: activeOrg,
    items: normalised,
    status: REQUEST_STATUS.REQUESTED,
    created_by: user?.uid || null,
    created_by_name: user?.email || '',
    created_at: now,
    updated_at: now,
    ...(syncKey ? { sync_keys: [syncKey] } : {}),
  }
  await setDoc(ref, requestData)
  return { id: ref.id, items: normalised, created: true }
}

// Rewrite an OPEN script in place — the "adjust the last prescription" path.
//
// The prescriber may change quantities, dosages and instructions, add lines and
// drop ones they never issued, but the pharmacy's record of what actually left
// the cupboard is inviolable: a line with an issued quantity cannot be removed,
// and a quantity can never be dragged below what has already gone out. Only an
// open script can be adjusted; a dispensed one is history and a correction
// there is a new prescription, not a rewrite of the old one.
export async function updateRequestItems(requestId, incomingLines) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const me = myActiveMembership()
  if (!can(me, 'prescription.create')) {
    throw new Error('Your role cannot prescribe (missing "prescription.create" capability).')
  }
  const snap = await getDoc(doc(db, REQUESTS, requestId))
  if (!snap.exists()) throw new Error('This prescription no longer exists.')
  const data = snap.data()
  if (data.organization_id !== activeOrg) throw new Error('This prescription belongs to a different hospital.')
  const current = normalizeRequest({ id: snap.id, ...data })
  if (!isOpenRequest(current.status) && current.status !== REQUEST_STATUS.EXTERNAL) {
    throw new Error('This prescription has already been dispensed — start a new one instead.')
  }

  const takenIds = new Set(current.items.map((x) => x.line_id))
  const next = (incomingLines || []).map((l, i) => {
    const line = toLine(l, i)
    // A line the form added new carries no id of its own. It must not borrow
    // one the script already uses — the position-derived default collides as
    // soon as a line is inserted — or the edit would land on someone else's
    // line and inherit its issued quantity.
    if (!l?.line_id && takenIds.has(line.line_id)) line.line_id = freshLineId(takenIds)
    takenIds.add(line.line_id)
    const prev = current.items.find((x) => x.line_id === line.line_id)
    const issued = prev ? toQty(prev.dispensed_qty, 0) : 0
    if (issued > 0 && toQty(line.quantity, 1) < issued) {
      throw new Error('"' + (line.medicine || 'This medicine') + '" cannot be reduced below the ' + issued + ' already issued.')
    }
    return { ...line, dispensed_qty: issued }
  }).filter((line) => line.medicine || line.drug_id)

  if (!next.length) throw new Error('A prescription must keep at least one medicine.')
  // A line the pharmacy has already issued against is part of the dispensing
  // record — the prescriber can edit it, but not make it disappear.
  const missingIssued = current.items
    .filter((x) => toQty(x.dispensed_qty, 0) > 0)
    .filter((x) => !next.some((l) => l.line_id === x.line_id))
  if (missingIssued.length) {
    throw new Error('"' + (missingIssued[0].medicine || 'A medicine') + '" has been partly issued and must stay on the prescription.')
  }

  const status = statusForProgress(requestProgress(next))
  const items = next
  await updateDoc(doc(db, REQUESTS, requestId), { items, status, updated_at: serverTimestamp() })
  return { id: requestId, items, status }
}

// Every script written for one encounter, newest first — what the consultation
// workspace shows as one expandable row per prescription.
export async function listRequestsForEncounter(encounterId) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg || !encounterId) return []
  const snap = await getDocs(query(
    collection(db, REQUESTS),
    where('organization_id', '==', activeOrg),
    where('encounter_id', '==', encounterId),
  ))
  const rows = snap.docs.map((d) => normalizeRequest({ id: d.id, ...d.data() }))
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))
  rows.sort((a, b) => ms(b.raw?.created_at) - ms(a.raw?.created_at))
  return rows
}

// The pharmacy queue: every request in the org, newest first, each normalised so
// legacy single-drug documents read as a one-line script.
export async function listOrgRequests(orgId) {
  const snap = await getDocs(query(
    collection(db, REQUESTS),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
  ))
  return snap.docs.map((d) => normalizeRequest({ id: d.id, ...d.data() }))
}

function sortRequests(rows) {
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))
  return [...rows].sort((a, b) => ms(b.raw?.created_at) - ms(a.raw?.created_at))
}

// Same org scope + normalisation as listOrgRequests, pushed on every change so
// the pharmacy sees a new script the moment a prescriber places one — no
// manual Refresh. Bounded to the 100 most recent (cost control). Requires the
// composite index organization_id ASC + created_at DESC — see
// firestore.indexes.json; the listener degrades to the one-shot fallback in
// the view if it is missing.
function buildOrgRequestsLiveQuery(orgId) {
  return query(
    collection(db, REQUESTS),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgRequests(orgId, onRows, onError) {
  return watchQuery(
    buildOrgRequestsLiveQuery(orgId),
    (d) => normalizeRequest({ id: d.id, ...d.data() }),
    (rows) => onRows(sortRequests(rows)),
    onError,
  )
}

export async function listSessionMedicationRequests(sid) {
  const snap = await getDocs(query(
    collection(db, REQUESTS),
    where('admission_session_id', '==', sid),
  ))
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
}

export async function getRequest(requestId) {
  const snap = await getDoc(doc(db, REQUESTS, requestId))
  if (!snap.exists()) return null
  return normalizeRequest({ id: snap.id, ...snap.data() })
}

// ---- correct stock (adjustment via ledger) ----------------------------------
// Creates a signed 'adjust' movement with reason, sets lot.stock to the
// counted value in the same transaction. Replaces blind "Adjust stock" overwrite.

export async function correctStock(drugId, countedQty, reason) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPharmacyCaps()
  if (!caps.canDispense) {
    throw new Error('Your role cannot manage medication inventory (missing "prescription.dispense" capability).')
  }

  const lotRef = doc(db, DRUGS, drugId)
  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(lotRef)
    if (!snap.exists()) throw new Error('Drug not found')
    const data = snap.data()

    const newStock = Number(countedQty)
    if (isNaN(newStock)) throw new Error('Counted quantity must be a valid number.')

    // Create 'adjust' movement
    const movementId = 'mov_' + Date.now() + Math.random().toString(36).slice(2)
    const movementRef = doc(db, 'stock_movements', movementId)
    tx.set(movementRef, {
      type: 'adjust',
      organization_id: activeOrg,
      drug_id: drugId,
      sku: data.sku,
      name: data.name,
      qty: countedQty, // may be signed if reducing; but we store the absolute counted value
      batch: data.batch,
      expiry: data.expiry,
      reason: reason || '',
      counted_qty: countedQty,
      created_by: user?.uid || null,
      created_by_name: user?.email || '',
      created_at: now,
    })

    // Set lot stock to the counted value
    tx.update(lotRef, {
      stock: newStock,
      updated_at: now,
    })

    try {
      await logAudit({ action: 'stock.adjusted', organizationId: activeOrg, details: `${data.name} · counted ${countedQty} · reason: ${reason || '—'}` })
    } catch (e) {
      console.warn('[pharmacy] audit append failed:', e?.message)
    }

    return { id: drugId, newStock }
  })
}

// ---- create / update drug ------------------------------------------------

// ---- dispense record ----------------------------------------------------
export async function createDispense(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')

  const dispenseId = doc(collection(db, DISPENSE)).id
  const now = serverTimestamp()
  const dispense = {
    patient_id: input.patient_id || '',
    patient_name: input.patient_name || '',
    items: input.items || '',
    by: input.by || user?.email || '',
    status: 'pending',
    time: now,
    organization_id: activeOrg,
    created_at: now,
    updated_at: now,
  }

  await setDoc(doc(db, DISPENSE, dispenseId), dispense)

  try {
    await logAudit({ action: 'dispense.created', organizationId: activeOrg, details: input.patient_name + ' · ' + input.items })
  } catch (e) {
    console.warn('[pharmacy] audit append failed:', e?.message)
  }
  return { id: dispenseId, ...dispense }
}

// NOTE: dispensations are append-only per firestore.rules (update: false).
// Record follow-ups (e.g. "dispensed") as a new dispense doc via
// createDispense, never by editing an existing one.
export async function createDispenseFollowUp(input) {
  return createDispense(input)
}