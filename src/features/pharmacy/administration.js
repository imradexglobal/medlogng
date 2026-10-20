// Medication administration — doses actually GIVEN to the patient.
//
// A prescription line carries two stock quantities already: `quantity` (the
// whole course the prescriber ordered) and `dispensed_qty` (what has left the
// pharmacy cupboard). This module owns the third: `administered_qty` — how
// many of those units the patient has swallowed, received IV, or otherwise
// been given. The chain the UI reads is: ordered 3 → issued 3 → given 1 →
// 2 still to give.
//
// Everything here is pure so the rules that matter — a dose can never exceed
// the ordered course, a reversed dose comes off the counter, external lines
// are administrable even though the pharmacy never issued them — can be
// tested without Firestore.

import { toQty, toLine } from './requests.js'

// How a dose reached the patient. Captured per event so an injection is as
// first-class as a tablet, and the chart can say "IM, left deltoid" rather
// than guessing from free text.
export const ADMIN_ROUTES = ['oral', 'iv', 'im', 'sc', 'topical', 'other']

export function isValidRoute(route) {
  return ADMIN_ROUTES.includes(String(route || '').toLowerCase())
}

// What has been given on one line so far.
export function lineGiven(line) {
  return toQty(line?.administered_qty, 0)
}

// The whole course minus what has been given. This is the number the client's
// example is about: order 3, give 1, "2 remaining to be collected".
export function lineRemainingToGive(line) {
  return Math.max(0, toQty(line?.quantity, 1) - lineGiven(line))
}

export function isLineFullyGiven(line) {
  return lineRemainingToGive(line) === 0
}

// The hard stop: a patient can never receive more units than the prescriber
// ordered, no matter who is pressing the button.
export function exceedsOrder(line, qty) {
  return lineGiven(line) + toQty(qty, 0) > toQty(line?.quantity, 1)
}

// The soft warning: for an in-house line the pharmacy may not have issued
// enough to cover this dose (ward stock can bridge the gap, and external
// lines were never issued at all). The UI warns; it does not block.
export function overIssuedWarn(line, qty) {
  if (!line || line.external) return false
  return lineGiven(line) + toQty(qty, 0) > toQty(line?.dispensed_qty, 0)
}

// Applies a dose to a set of lines and returns the new list. Pure: callers
// pass what was given, keyed by line id. Each line's counter is clamped to
// the ordered quantity so a bad caller can never write an impossible total.
export function applyAdministration(items, givenByLineId) {
  const next = (items || []).map((l, i) => {
    const line = toLine(l, i)
    const given = toQty(givenByLineId?.[line.line_id], 0)
    if (given <= 0) return line
    const ordered = toQty(line.quantity, 1)
    return {
      ...line,
      administered_qty: Math.min(ordered, lineGiven(line) + given),
    }
  })
  return { items: next }
}

// Script-level progress: what the whole script has given and what is still
// owed to the patient. External lines count here — the patient still swallows
// medicine bought outside the hospital — unlike the pharmacy's issue maths,
// which must ignore them.
export function adminProgress(items) {
  const lines = items || []
  let ordered = 0
  let given = 0
  let lineCount = 0
  let completeLines = 0
  for (const l of lines) {
    lineCount += 1
    const total = toQty(l?.quantity, 1)
    const done = Math.min(lineGiven(l), total)
    ordered += total
    given += done
    if (done >= total) completeLines += 1
  }
  return {
    ordered,
    given,
    toGive: Math.max(0, ordered - given),
    isComplete: lineCount > 0 && given >= ordered,
    completeLines,
    lineCount,
  }
}

// Takes a dose back off a line (a documented error, a rejected dose). Clamped
// at zero — a counter that has already been corrected once stays corrected.
export function applyReversal(items, lineId, qty) {
  const back = toQty(qty, 0)
  if (back <= 0) return { items: (items || []).map((l, i) => toLine(l, i)) }
  const next = (items || []).map((l, i) => {
    const line = toLine(l, i)
    if (line.line_id !== lineId) return line
    return { ...line, administered_qty: Math.max(0, lineGiven(line) - back) }
  })
  return { items: next }
}

// The dose event the service writes — one document per administration, plus
// one per reversal. Built here so the shape is shared between the service,
// the tests, and anything that reads the collection later.
export function buildDoseEvent({
  request, line, qty, route, site = '', note = '',
  user, activeOrg, now, type = 'given', reversesId = '',
}) {
  return {
    patient_id: request?.patient_id || '',
    patient_name: request?.patient_name || '',
    encounter_id: request?.encounter_id || '',
    admission_session_id: request?.admission_session_id || '',
    medication_request_id: request?.id || '',
    line_id: line?.line_id || '',
    medicine: line?.medicine || '',
    unit: line?.unit || '',
    dosage: line?.dosage || '',
    qty: toQty(qty, 1),
    route: isValidRoute(route) ? String(route).toLowerCase() : 'oral',
    site: site || '',
    note: note || '',
    type,
    reverses_id: reversesId || '',
    administered_by: user?.uid || '',
    // Prefer the display name — the service passes the staff name here so a
    // dose reads "given by A. Okafor", not by their sign-in email.
    administered_by_name: user?.displayName || user?.email || '',
    organization_id: activeOrg || '',
    administered_at: now,
    created_at: now,
    updated_at: now,
  }
}
