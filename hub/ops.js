// Operation allowlist + request schemas for the hub.
//
// The Admin SDK can write anything. A generic "run this Firestore operation"
// endpoint would therefore be a remote-admin API, so the hub exposes exactly
// two operations and validates every field before the op is queued:
//
//   rx_mirror   -> prescription.create
//   lab_snapshot-> lab.order
//
// Values are normalised to plain strings/numbers/booleans; unknown top-level
// arguments and unknown per-line fields are rejected. The historical `actor`
// field is ignored (never trusted) so older clients still work, but a client
// can no longer choose who the write is attributed to.

const KEY_RE = /^[A-Za-z0-9_:.\-]{1,160}$/
const ORG_RE = /^[A-Za-z0-9_-]{1,100}$/
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

const RX_ARGS = new Set(['patientId', 'patientName', 'encounterId', 'admissionSessionId', 'lines'])
const RX_LINE = new Set([
  'line_id', 'drug_id', 'sku', 'medicine', 'name', 'unit', 'dosage', 'instructions',
  'quantity', 'qty', 'dispensed_qty', 'administered_qty', 'external',
])
const LAB_ARGS = new Set(['encounterId', 'labOrder'])

export const OP_ALLOWLIST = {
  rx_mirror: { capability: 'prescription.create' },
  lab_snapshot: { capability: 'lab.order' },
}

export function capabilityFor(kind) {
  return OP_ALLOWLIST[kind]?.capability || ''
}

export function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function str(v, max, field, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new Error(field + ' is required')
    return ''
  }
  if (typeof v !== 'string') throw new Error(field + ' must be a string')
  if (v.length > max) throw new Error(field + ' is too long (max ' + max + ' characters)')
  if (required && !v.trim()) throw new Error(field + ' is required')
  return v
}

function num(v, max, field) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(field + ' must be a number')
  if (v < 0 || v > max) throw new Error(field + ' is out of range')
  return v
}

function bool(v, field) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new Error(field + ' must be true or false')
  return v
}

function rejectUnknown(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(where + ' has an unsupported field: ' + key)
  }
}

// Bounded recursive sanitiser for the small, free-form labOrder snapshot. It
// accepts only JSON primitives, caps depth/size, and refuses prototype keys.
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
export function sanitizeBounded(value, depth = 0, field = 'value') {
  if (depth > 3) throw new Error(field + ' is nested too deeply')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(field + ' contains a non-finite number')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 600) throw new Error(field + ' contains a string that is too long')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error(field + ' contains too many items')
    return value.map((v, i) => sanitizeBounded(v, depth + 1, field + '[' + i + ']'))
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length > 50) throw new Error(field + ' has too many fields')
    const out = {}
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(field + ' contains a forbidden field name')
      if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key)) throw new Error(field + ' contains an invalid field name')
      out[key] = sanitizeBounded(value[key], depth + 1, field + '.' + key)
    }
    return out
  }
  throw new Error(field + ' contains an unsupported value')
}

function validateRxLine(raw, index) {
  if (!isPlainObject(raw)) throw new Error('lines[' + index + '] must be an object')
  rejectUnknown(raw, RX_LINE, 'lines[' + index + ']')
  const at = 'lines[' + index + '].'
  const line = {
    line_id: str(raw.line_id, 80, at + 'line_id'),
    drug_id: str(raw.drug_id, 128, at + 'drug_id'),
    sku: str(raw.sku, 128, at + 'sku'),
    medicine: str(raw.medicine ?? raw.name, 200, at + 'medicine'),
    unit: str(raw.unit, 40, at + 'unit'),
    dosage: str(raw.dosage, 80, at + 'dosage'),
    instructions: str(raw.instructions, 500, at + 'instructions'),
  }
  const quantity = num(raw.quantity, 1e7, at + 'quantity')
  const qty = num(raw.qty, 1e7, at + 'qty')
  const dispensed = num(raw.dispensed_qty, 1e7, at + 'dispensed_qty')
  const administered = num(raw.administered_qty, 1e7, at + 'administered_qty')
  const external = bool(raw.external, at + 'external')
  if (quantity !== undefined) line.quantity = quantity
  if (qty !== undefined) line.qty = qty
  if (dispensed !== undefined) line.dispensed_qty = dispensed
  if (administered !== undefined) line.administered_qty = administered
  if (external !== undefined) line.external = external
  if (!line.medicine && !line.drug_id) {
    throw new Error(at + 'needs a medicine name or drug_id')
  }
  return line
}

export function validateRxArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, RX_ARGS, 'args')
  const patientId = str(args.patientId, 128, 'args.patientId', { required: true })
  if (!ID_RE.test(patientId)) throw new Error('args.patientId is not a valid record id')
  const encounterId = str(args.encounterId, 128, 'args.encounterId')
  const admissionSessionId = str(args.admissionSessionId, 128, 'args.admissionSessionId')
  if (encounterId && !ID_RE.test(encounterId)) throw new Error('args.encounterId is not a valid record id')
  if (admissionSessionId && !ID_RE.test(admissionSessionId)) throw new Error('args.admissionSessionId is not a valid record id')
  const patientName = str(args.patientName, 200, 'args.patientName')
  if (!Array.isArray(args.lines) || args.lines.length < 1) {
    throw new Error('args.lines must be a non-empty array')
  }
  if (args.lines.length > 100) throw new Error('args.lines has too many items (max 100)')
  const lines = args.lines.map(validateRxLine)
  return { patientId, patientName, encounterId, admissionSessionId, lines }
}

export function validateLabArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, LAB_ARGS, 'args')
  const encounterId = str(args.encounterId, 128, 'args.encounterId', { required: true })
  if (!ID_RE.test(encounterId)) throw new Error('args.encounterId is not a valid record id')
  if (!isPlainObject(args.labOrder)) throw new Error('args.labOrder must be an object')
  const labOrder = sanitizeBounded(args.labOrder, 0, 'args.labOrder')
  if (!Object.keys(labOrder).length) throw new Error('args.labOrder must not be empty')
  if (labOrder.lab_order_id !== undefined && typeof labOrder.lab_order_id !== 'string') {
    throw new Error('args.labOrder.lab_order_id must be a string')
  }
  if (typeof labOrder.lab_order_id === 'string' && labOrder.lab_order_id.length > 128) {
    throw new Error('args.labOrder.lab_order_id is too long')
  }
  return { encounterId, labOrder }
}

const VALIDATORS = {
  rx_mirror: validateRxArgs,
  lab_snapshot: validateLabArgs,
}

// Returns { op } on success or { error } with a safe, client-readable message.
// Index is included so a batch can point at the offending entry.
export function validateOp(raw, index = 0) {
  const at = 'op[' + index + ']'
  if (!isPlainObject(raw)) return { error: at + ' is not an object' }

  for (const key of Object.keys(raw)) {
    if (['clientOpKey', 'kind', 'orgId', 'args', 'createdAt', 'actor'].includes(key)) continue
    return { error: at + ' has an unsupported field: ' + key }
  }

  const clientOpKey = raw.clientOpKey
  if (typeof clientOpKey !== 'string' || !KEY_RE.test(clientOpKey)) {
    return { error: at + '.clientOpKey missing or malformed' }
  }
  const kind = raw.kind
  if (typeof kind !== 'string' || !OP_ALLOWLIST[kind]) {
    return { error: at + '.kind is not supported: ' + String(kind).slice(0, 40) }
  }
  const orgId = raw.orgId
  if (typeof orgId !== 'string' || !ORG_RE.test(orgId)) {
    return { error: at + '.orgId missing or malformed' }
  }
  let createdAt = ''
  if (raw.createdAt !== undefined && raw.createdAt !== null) {
    if (typeof raw.createdAt !== 'string' || raw.createdAt.length > 40) {
      return { error: at + '.createdAt must be an ISO timestamp string' }
    }
    createdAt = raw.createdAt
  }

  let args
  try {
    args = VALIDATORS[kind](raw.args)
  } catch (e) {
    return { error: at + '.args: ' + String(e?.message || e) }
  }
  return { op: { clientOpKey, kind, orgId, args, createdAt } }
}
