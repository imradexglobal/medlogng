// Medication requests — one prescription ORDER, many lines.
//
// A request is the pharmacy's equivalent of an invoice: one document for one
// patient/encounter script, holding every line the prescriber wrote. Previously
// each prescribed drug became its own `medication_requests` document, so a
// three-drug script appeared as three unrelated rows and the pharmacist had no
// way to see the script as a whole.
//
// Everything here is pure so the rules that matter — how a legacy single-line
// document is read, how a new line joins an existing script, when a request
// counts as finished — can be tested without Firestore.

// Statuses a request moves through. A request is only 'Dispensed' once every
// line is fully issued; partial issues are visible rather than hidden.
export const REQUEST_STATUS = {
  REQUESTED: 'Requested',
  PARTIAL: 'Partially dispensed',
  DISPENSED: 'Dispensed',
  DECLINED: 'Declined',
  // A script whose every line is sourced from an external pharmacy. It is kept
  // for the clinical record but never touches in-house stock, so it is not a
  // "waiting to be dispensed" request.
  EXTERNAL: 'External',
}

// Statuses that still need a pharmacist. A new script can only be appended to a
// request that is open; once it is dispensed or declined, the next prescription
// starts a fresh order.
export function isOpenRequest(status) {
  return status === REQUEST_STATUS.REQUESTED || status === REQUEST_STATUS.PARTIAL
}

// Quantities arrive from free-text prescription forms, so they may be a number,
// a numeric string, or blank. Anything unusable becomes 1 rather than NaN,
// because a line with no quantity still has to be dispensed somehow.
export function toQty(value, fallback = 1) {
  if (value === '' || value == null) return fallback
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// One line of a script, in a shape the UI and the dispense service agree on.
// `quantity` is the stored shape; `qty` is what the prescription form hands
// back, so both spellings normalise to the same line.
export function toLine(raw, index = 0) {
  const source = raw || {}
  return {
    // Stable identity for a line within its request. Legacy rows have no line
    // id, so it is derived from position; new lines get an explicit one.
    line_id: source.line_id || 'line_' + index,
    drug_id: source.drug_id || '',
    sku: source.sku || '',
    medicine: source.medicine || source.name || '',
    unit: source.unit || '',
    dosage: source.dosage || '',
    instructions: source.instructions || '',
    quantity: toQty(source.quantity ?? source.qty, 1),
    // How much has actually been issued. Absent on new lines, and on every
    // legacy row, which is exactly the "nothing issued yet" case.
    dispensed_qty: toQty(source.dispensed_qty, 0),
    // External lines are sourced from an outside pharmacy: the prescriber can
    // write them without the drug being in the in-house catalogue, and they are
    // excluded from every stock/issue calculation.
    external: !!source.external,
  }
}

// A line id must stay unique inside its script. New lines default to a
// position-derived id, which is fine on a fresh script but collides the moment
// a line is inserted above one already written or an issued line is kept while
// others are dropped — so a fresh id is carved out of what is already taken.
export function freshLineId(taken) {
  const has = taken instanceof Set ? taken : new Set(taken)
  let n = 0
  while (has.has('line_' + n)) n++
  return 'line_' + n
}

// Reads the line list off a request document.
//
// Docs written before this model stored a single drug at the top level
// (`medicine`, `drug_id`, `quantity`) with no `items`. Those must keep working —
// the pharmacy has live rows in that shape — so they are folded into a one-line
// list here rather than being rejected or shown as empty.
export function toRequestItems(doc) {
  if (!doc) return []
  if (Array.isArray(doc.items) && doc.items.length) {
    return doc.items.map((it, i) => toLine(it, i))
  }
  const hasLegacyLine = doc.medicine || doc.drug_id || doc.quantity != null
  if (!hasLegacyLine) return []
  return [toLine({
    drug_id: doc.drug_id,
    sku: doc.sku,
    medicine: doc.medicine,
    unit: doc.unit,
    dosage: doc.dosage,
    instructions: doc.instructions,
    quantity: doc.quantity,
    dispensed_qty: doc.dispensed_qty,
  }, 0)]
}

// Full request row for the pharmacy queue.
export function normalizeRequest(doc) {
  const items = toRequestItems(doc)
  const progress = requestProgress(items)
  // Status is derived from what has actually been issued, but an explicit
  // terminal status (Declined) always wins, and an unknown stored status is
  // preserved rather than silently rewritten.
  const stored = doc?.status || REQUEST_STATUS.REQUESTED
  let status = stored
  if (isOpenRequest(stored) || stored === REQUEST_STATUS.EXTERNAL) {
    if (progress.internalLineCount === 0 && progress.externalCount > 0) {
      // Every line is external: nothing for the in-house pharmacy to issue.
      status = REQUEST_STATUS.EXTERNAL
    } else {
      status = progress.outstanding === 0 && progress.total > 0
        ? REQUEST_STATUS.DISPENSED
        : (progress.dispensed > 0 ? REQUEST_STATUS.PARTIAL : REQUEST_STATUS.REQUESTED)
    }
  }
  return {
    id: doc?.id || '',
    patientId: doc?.patient_id || '',
    patientName: doc?.patient_name || '',
    encounterId: doc?.encounter_id || '',
    prescribedBy: doc?.created_by_name || doc?.prescribed_by_name || '',
    status,
    items,
    ...progress,
    raw: doc,
  }
}

// What has been asked for, what has gone out, and what is still owed. External
// lines are skipped entirely: they are filled outside the hospital and must
// never influence the in-house pharmacy balance or the request's status.
export function requestProgress(items) {
  const lines = items || []
  let total = 0
  let dispensed = 0
  let externalCount = 0
  let internalLineCount = 0
  for (const l of lines) {
    if (l?.external) { externalCount += 1; continue }
    internalLineCount += 1
    const qty = toQty(l?.quantity, 1)
    const done = toQty(l?.dispensed_qty, 0)
    total += qty
    dispensed += Math.min(done, qty)
  }
  return {
    total,
    dispensed,
    outstanding: Math.max(0, total - dispensed),
    isComplete: internalLineCount > 0 && total > 0 && dispensed >= total,
    lineCount: lines.length,
    internalLineCount,
    externalCount,
  }
}

export function lineOutstanding(line) {
  return Math.max(0, toQty(line?.quantity, 1) - toQty(line?.dispensed_qty, 0))
}

export function isLineOutstanding(line) {
  return lineOutstanding(line) > 0
}

// A line with no catalogue match still has to be visible to the pharmacist, so
// a free-text line counts as owed rather than being silently dropped. External
// lines are self-describing (a typed name), so they are "resolved" without a
// catalogue id.
export function isLineResolvable(line) {
  return !!line?.drug_id || !!line?.external
}

// Adds a prescribed line to an existing script.
//
// Same medicine with the same dosage and instructions accumulates into one line
// (prescribing "Metformin 500mg, 30" twice means 60, not two 30s). Anything else
// is appended, so a script can carry several strengths or schedules of the same
// drug. The prescription order is preserved, because a script is read top to
// bottom.
export function mergeRequestLine(items, line) {
  const next = (items || []).map((l, i) => toLine(l, i))
  const incoming = toLine(line, next.length)
  const dup = next.find((l) =>
    l.drug_id === incoming.drug_id &&
    l.medicine === incoming.medicine &&
    l.dosage === incoming.dosage &&
    l.instructions === incoming.instructions &&
    l.external === incoming.external)
  if (dup) {
    return next.map((l) => (l.line_id === dup.line_id
      ? { ...l, quantity: toQty(l.quantity, 1) + incoming.quantity }
      : l))
  }
  // Nothing matched, so this really is a new line: give it an id no line on
  // this script already holds.
  const taken = new Set(next.map((l) => l.line_id))
  if (taken.has(incoming.line_id)) incoming.line_id = freshLineId(taken)
  next.push(incoming)
  return next
}

// Applies an issue to a set of lines and returns the new list plus the status
// the request should now hold. Pure: callers pass what was issued.
export function applyIssue(items, issuedByLineId) {
  const next = (items || []).map((l, i) => {
    const line = toLine(l, i)
    // External lines are never issued from in-house stock, so an issue aimed at
    // one is ignored rather than recorded against a medicine we do not hold.
    if (line.external) return line
    const issued = toQty(issuedByLineId?.[line.line_id], 0)
    if (issued <= 0) return line
    return {
      ...line,
      // Never let an over-issue record more than was prescribed; the service
      // rejects that case, but the stored number must stay coherent anyway.
      dispensed_qty: Math.min(toQty(line.quantity, 1), toQty(line.dispensed_qty, 0) + issued),
    }
  })
  return { items: next, ...requestProgress(next) }
}

export function statusForProgress(progress) {
  if (!progress || !progress.lineCount) return REQUEST_STATUS.REQUESTED
  if (progress.internalLineCount === 0 && progress.externalCount > 0) return REQUEST_STATUS.EXTERNAL
  if (progress.outstanding === 0) return REQUEST_STATUS.DISPENSED
  if (progress.dispensed > 0) return REQUEST_STATUS.PARTIAL
  return REQUEST_STATUS.REQUESTED
}