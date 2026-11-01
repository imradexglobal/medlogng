// Medication administration data layer — the bedside half of the medication
// chain (ordered → issued → GIVEN).
//
// One transaction records one dose: an append-only event in
// `medication_administrations` plus the matching `administered_qty` bump on
// the prescription line. The event collection is append-only per
// firestore.rules, so a documented mistake is corrected by a REVERSAL event
// (same collection, type:'reversed'), never by rewriting what happened.
import {
  db, collection, query, where, getDocs, getDoc, doc, runTransaction, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import {
  toRequestItems, toQty,
} from '../features/pharmacy/requests.js'
import {
  ADMIN_ROUTES, isValidRoute, lineGiven, lineRemainingToGive, exceedsOrder,
  applyAdministration, applyReversal, buildDoseEvent,
} from '../features/pharmacy/administration.js'
import { currentStaffName } from '../lib/staffName.js'

const REQUESTS = 'medication_requests'
const DOSES = 'medication_administrations'

// ---- capability check --------------------------------------------------------
export function myAdminCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canAdminister: can(me, 'medication.administer'),
    // Reading the trail needs no capability beyond being signed in (rules),
    // so every surface can show "given 1 of 2" even without the give button.
    canReverse: can(me, 'medication.administer'),
  }
}

// ---- read models -------------------------------------------------------------
function toDoseRow(d) {
  return { id: d.id, ...d }
}

function sortDoses(rows) {
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0))
  return [...rows].sort((a, b) => ms(b.administered_at || b.created_at) - ms(a.administered_at || a.created_at))
}

// Every dose given on one encounter (outpatient trail).
export async function listEncounterAdministrations(encounterId) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg || !encounterId) return []
  const snap = await getDocs(query(
    collection(db, DOSES),
    where('organization_id', '==', activeOrg),
    where('encounter_id', '==', encounterId),
  ))
  return sortDoses(snap.docs.map((d) => toDoseRow({ ...d.data(), id: d.id })))
}

// Every dose given during one inpatient stay (ward trail).
export async function listSessionAdministrations(sessionId) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg || !sessionId) return []
  const snap = await getDocs(query(
    collection(db, DOSES),
    where('organization_id', '==', activeOrg),
    where('admission_session_id', '==', sessionId),
  ))
  return sortDoses(snap.docs.map((d) => toDoseRow({ ...d.data(), id: d.id })))
}

// The patient chart trail (any encounter, any stay).
export async function listPatientAdministrations(patientId) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg || !patientId) return []
  const snap = await getDocs(query(
    collection(db, DOSES),
    where('organization_id', '==', activeOrg),
    where('patient_id', '==', patientId),
  ))
  return sortDoses(snap.docs.map((d) => toDoseRow({ ...d.data(), id: d.id })))
}

// ---- give one dose -----------------------------------------------------------
// input: { requestId, lineId?, qty, route, site?, note? }
// Returns the event plus the line's new remaining, so the caller can toast
// "given 1 of 3 — 2 remaining" without a second fetch.
export async function administerDose(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!myAdminCaps().canAdminister) {
    throw new Error('Your role cannot record medication administration (missing "medication.administer" capability). Ask an administrator.')
  }

  const qty = Number(input?.qty)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Dose quantity must be greater than zero.')
  const route = isValidRoute(input?.route) ? String(input.route).toLowerCase() : 'oral'
  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    const reqRef = doc(db, REQUESTS, input.requestId)
    const reqSnap = await tx.get(reqRef)
    if (!reqSnap.exists()) throw new Error('This prescription no longer exists.')
    const request = { id: reqSnap.id, ...reqSnap.data() }

    const lines = toRequestItems(reqSnap.data())
    if (!lines.length) throw new Error('This prescription has no medicine lines.')
    // A one-line script needs no line id from the caller; anything else must
    // say which line the dose belongs to.
    const line = input.lineId
      ? lines.find((l) => l.line_id === input.lineId)
      : (lines.length === 1 ? lines[0] : null)
    if (!line) throw new Error('Which line was given? Reopen the prescription and try again.')

    // The hard stop: never more units than the prescriber ordered. The issued
    // balance is only a warning (ward stock may bridge it) — see the UI.
    if (exceedsOrder(line, qty)) {
      const remaining = lineRemainingToGive(line)
      throw new Error(
        remaining === 0
          ? `"${line.medicine}" has already been given in full (${toQty(line.quantity, 1)} of ${toQty(line.quantity, 1)}).`
          : `Only ${remaining} of "${line.medicine}" left to give (ordered ${toQty(line.quantity, 1)}, given ${lineGiven(line)}).`,
      )
    }

    const event = buildDoseEvent({
      request, line, qty, route,
      site: input?.site || '', note: input?.note || '',
      user: { uid: user?.uid, displayName: currentStaffName() }, activeOrg, now,
    })

    const { items } = applyAdministration(lines, { [line.line_id]: qty })
    tx.update(reqRef, { items, updated_at: now })

    const doseRef = doc(collection(db, DOSES))
    tx.set(doseRef, event)

    try {
      await logAudit({
        action: 'medication.administered',
        organizationId: activeOrg,
        details: `${request.patient_name || ''} · ${qty}x ${line.medicine} (${route})`,
      })
    } catch (e) {
      console.warn('[medication-admin] audit append failed:', e?.message)
    }

    const remaining = lineRemainingToGive(items.find((l) => l.line_id === line.line_id))
    return { administrationId: doseRef.id, event, remaining, givenTotal: lineGiven(items.find((l) => l.line_id === line.line_id)) }
  })
}

// ---- take a documented dose back --------------------------------------------
// input: { administrationId, reason? }
// The original event is never touched (append-only). A reversal event is
// written beside it and the line's counter drops by the same amount.
export async function reverseDose(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!myAdminCaps().canReverse) {
    throw new Error('Your role cannot reverse medication administration (missing "medication.administer" capability). Ask an administrator.')
  }

  const doseRef = doc(db, DOSES, input?.administrationId || '')
  const doseSnap = await getDoc(doseRef)
  if (!doseSnap || !doseSnap.exists()) throw new Error('That dose record no longer exists.')
  const dose = doseSnap.data()
  if (dose.type === 'reversed') throw new Error('That dose has already been reversed.')
  if (dose.organization_id && dose.organization_id !== activeOrg) throw new Error('That dose belongs to another hospital.')

  // A second reversal of the same event would double-refund the counter.
  const already = await getDocs(query(collection(db, DOSES), where('reverses_id', '==', input.administrationId)))
  if (!already.empty) throw new Error('That dose has already been reversed.')

  const qty = toQty(dose.qty, 1)
  const reason = String(input?.reason || '').trim()
  const now = serverTimestamp()

  return runTransaction(db, async (tx) => {
    const reqRef = doc(db, REQUESTS, dose.medication_request_id)
    const reqSnap = await tx.get(reqRef)
    if (!reqSnap.exists()) throw new Error('The prescription this dose belongs to no longer exists.')
    const request = { id: reqSnap.id, ...reqSnap.data() }

    const lines = toRequestItems(reqSnap.data())
    const line = lines.find((l) => l.line_id === dose.line_id) || lines[0]
    const { items } = applyReversal(lines, dose.line_id, qty)
    tx.update(reqRef, { items, updated_at: now })

    const event = buildDoseEvent({
      request, line, qty,
      route: dose.route, site: dose.site, note: reason ? 'Reversed: ' + reason : 'Reversed',
      user: { uid: user?.uid, displayName: currentStaffName() }, activeOrg, now, type: 'reversed', reversesId: input.administrationId,
    })
    const revRef = doc(collection(db, DOSES))
    tx.set(revRef, event)

    try {
      await logAudit({
        action: 'medication.administration.reversed',
        organizationId: activeOrg,
        details: `${request.patient_name || ''} · ${qty}x ${dose.medicine}${reason ? ' · ' + reason : ''}`,
      })
    } catch (e) {
      console.warn('[medication-admin] audit append failed:', e?.message)
    }

    return { reversalId: revRef.id, remaining: line ? lineRemainingToGive(items.find((l) => l.line_id === (line?.line_id || ''))) : 0 }
  })
}

export { ADMIN_ROUTES, lineGiven, lineRemainingToGive }
