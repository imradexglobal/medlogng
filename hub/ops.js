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
const ADMISSION_ARGS = new Set(['admissionId', 'claimId', 'admission'])
const ADMISSION_DISCHARGE_ARGS = new Set(['admissionId', 'claimId', 'legacyClaimId', 'dischargeData'])
const ADMISSION_TRANSFER_ARGS = new Set(['admissionId', 'oldClaimId', 'newClaimId', 'legacyOldClaimId', 'wardName', 'bedNumber', 'reason', 'transferAt', 'transferHistory', 'newClaim'])
const BILLING_PAYMENT_ARGS = new Set(['invoiceId', 'paymentId', 'amountKobo', 'method', 'reference', 'notes', 'labOrderId', 'preview'])
const MEDICATION_ADMINISTER_ARGS = new Set(['requestId', 'doseId', 'lineId', 'qty', 'route', 'site', 'note', 'preview'])
const STOCK_RECEIVE_ARGS = new Set(['drugId', 'movementId', 'qty', 'batch', 'expiry', 'supplier', 'unitCost', 'invoiceRef', 'preview'])
const PHARMACY_DISPENSE_ARGS = new Set(['dispensationId', 'patientId', 'patientName', 'medicationRequestId', 'items'])
const STOCK_CREATE_ARGS = new Set(['drugId', 'movementId', 'drug', 'preview'])
const STOCK_CORRECT_ARGS = new Set(['drugId', 'movementId', 'countedQty', 'reason', 'preview'])
const STOCK_UPDATE_ARGS = new Set(['drugId', 'movementId', 'fields', 'previousStock'])
const STOCK_REVERSE_ARGS = new Set(['requestId', 'lineId', 'movementId', 'ticketId', 'preview'])
const FILE_UPLOAD_ARGS = new Set(['kind', 'id', 'metadata', 'contentType', 'contentBase64', 'remove'])
const MUTATION_ARGS = new Set(['mutations'])

const MUTATION_CAPS = {
  patients: { create: 'patient.create', update: 'patient.demographics.update' },
  organization_patients: { create: 'patient.create', update: 'patient.demographics.update', delete: 'data.delete' },
  documents: { create: 'documents.upload', update: 'documents.upload', delete: 'data.delete' },
  appointments: { create: 'appointment.create', update: 'appointment.update', delete: 'data.delete' },
  encounters: { create: 'encounter.create', update: 'encounter.edit', delete: 'data.delete' },
  vitals: { create: 'vitals.create', update: 'vitals.create', delete: 'data.delete' },
  allergies: { create: 'diagnosis.create', update: 'diagnosis.create', delete: 'data.delete' },
  diagnoses: { create: 'diagnosis.create', update: 'diagnosis.create', delete: 'data.delete' },
  admission_plan_items: { create: 'encounter.edit', update: 'encounter.edit' },
  imaging_orders: { create: 'lab.order', update: 'lab.workflow', delete: 'data.delete' },
  lab_orders: { create: 'lab.order', update: 'lab.workflow', delete: 'data.delete' },
  wards: { create: 'beds.manage', update: 'beds.manage', delete: 'data.delete' },
  lab_test_catalogue: { create: 'lab.catalogue.manage', update: 'lab.catalogue.manage', delete: 'data.delete' },
  lab_settings: { create: 'lab.catalogue.manage', update: 'lab.catalogue.manage', merge: 'lab.catalogue.manage' },
  price_catalogue: { create: 'billing.invoice', update: 'billing.invoice', merge: 'billing.invoice', delete: 'billing.invoice' },
}

export const OP_ALLOWLIST = {
  rx_mirror: { capability: 'prescription.create' },
  lab_snapshot: { capability: 'lab.order' },
  admission_create: { capability: 'beds.manage' },
  admission_discharge: { capability: 'beds.manage' },
  admission_transfer: { capability: 'beds.manage' },
  billing_payment: { capability: 'billing.payment' },
  medication_administer: { capability: 'medication.administer' },
  stock_receive: { capability: 'prescription.dispense' },
  pharmacy_dispense: { capability: 'prescription.dispense' },
  stock_create: { capability: 'prescription.dispense' },
  stock_correct: { capability: 'prescription.dispense' },
  stock_update: { capability: 'prescription.dispense' },
  pharmacy_reverse: { capability: 'prescription.dispense' },
  file_upload: { capability: 'dynamic' },
  document_mutation: { capability: 'dynamic' },
}

export function capabilityFor(kind, args = null) {
  if (kind === 'document_mutation') {
    const first = args?.mutations?.[0]
    return capabilitiesForMutationArgs(args)[0] || MUTATION_CAPS[first?.collection]?.[first?.action] || ''
  }
  if (kind === 'file_upload') return args?.kind === 'patient_photo' ? 'patient.demographics.update' : 'lab.result.enter'
  return OP_ALLOWLIST[kind]?.capability || ''
}

export function capabilitiesForMutationArgs(args) {
  const first = args?.mutations?.[0]
  if (!first) return []
  if (args.mutations.some((m) => mutationCapabilityGroup(m) !== mutationCapabilityGroup(first))) return []
  if (first.collection === 'encounters' && first.action === 'update' && mutationCapabilityGroup(first) === 'encounter.status.advance') {
    return ['encounter.edit', 'encounter.status.advance']
  }
  if (['lab_orders', 'imaging_orders'].includes(first.collection) && first.action === 'update') {
    const keys = Object.keys(first.data || {})
    if (first.collection === 'lab_orders') {
      const invoiceFields = new Set(['invoice_id', 'billing_status', 'invoice_total_kobo', 'updated_at'])
      const paymentFields = new Set(['paid_kobo', 'payment_recorded_at', 'updated_at'])
      if (keys.length && keys.every((key) => invoiceFields.has(key))) return ['billing.invoice']
      if (keys.length && keys.every((key) => paymentFields.has(key))) return ['billing.payment']
    }
    return ['lab.order', 'lab.sample.collect', 'lab.result.enter', 'lab.result.verify']
  }
  const capability = MUTATION_CAPS[first.collection]?.[first.action]
  return capability && capability !== 'lab.workflow' ? [capability] : []
}

function mutationCapabilityGroup(mutation) {
  const { collection, action, data = {} } = mutation
  if (collection === 'encounters' && action === 'update' && Object.keys(data).every((key) => ['status', 'updated_at'].includes(key))) return 'encounter.status.advance'
  if (collection === 'lab_orders' && action === 'update') {
    const keys = Object.keys(data)
    if (keys.length && keys.every((key) => ['invoice_id', 'billing_status', 'invoice_total_kobo', 'updated_at'].includes(key))) return 'billing.invoice'
    if (keys.length && keys.every((key) => ['paid_kobo', 'payment_recorded_at', 'updated_at'].includes(key))) return 'billing.payment'
    return 'lab.workflow'
  }
  if (collection === 'imaging_orders' && action === 'update') return 'lab.workflow'
  return MUTATION_CAPS[collection]?.[action] || ''
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

export function validateAdmissionCreateArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, ADMISSION_ARGS, 'args')
  const admissionId = str(args.admissionId, 128, 'args.admissionId', { required: true })
  const claimId = str(args.claimId, 320, 'args.claimId', { required: true })
  if (!ID_RE.test(admissionId)) throw new Error('args.admissionId is not a valid record id')
  if (!isPlainObject(args.admission)) throw new Error('args.admission must be an object')
  const allowed = new Set(['patient_id', 'patient_name', 'organization_id', 'encounter_id', 'ward_name', 'bed_number', 'admission_type', 'admission_reason', 'attending_provider', 'status'])
  rejectUnknown(args.admission, allowed, 'args.admission')
  const a = args.admission
  const admission = {
    patient_id: str(a.patient_id, 128, 'admission.patient_id', { required: true }),
    patient_name: str(a.patient_name, 200, 'admission.patient_name'),
    organization_id: str(a.organization_id, 100, 'admission.organization_id', { required: true }),
    encounter_id: str(a.encounter_id, 128, 'admission.encounter_id'),
    ward_name: str(a.ward_name, 120, 'admission.ward_name', { required: true }),
    bed_number: str(a.bed_number, 40, 'admission.bed_number', { required: true }),
    admission_type: str(a.admission_type, 100, 'admission.admission_type'),
    admission_reason: str(a.admission_reason, 1000, 'admission.admission_reason'),
    attending_provider: str(a.attending_provider, 200, 'admission.attending_provider'),
    status: str(a.status, 30, 'admission.status', { required: true }),
  }
  if (!ID_RE.test(admission.patient_id)) throw new Error('admission.patient_id is not a valid record id')
  if (admission.encounter_id && !ID_RE.test(admission.encounter_id)) throw new Error('admission.encounter_id is not a valid record id')
  if (admission.organization_id !== orgId) throw new Error('admission organization does not match op organization')
  if (admission.status !== 'active') throw new Error('only active admissions can be created offline')
  const normalizedWard = admission.ward_name.trim().toLowerCase()
  const bedText = admission.bed_number.trim().toLowerCase()
  const bedMatch = bedText.match(/^(?:bed\s*)?(\d+)$/)
  const normalizedBed = bedMatch ? String(Number(bedMatch[1])) : bedText.replace(/\s+/g, ' ')
  if (claimId !== orgId + '_' + normalizedWard + '_' + normalizedBed) throw new Error('claimId does not match the admission bed')
  return { admissionId, claimId, admission }
}

export function validateAdmissionDischargeArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, ADMISSION_DISCHARGE_ARGS, 'args')
  const admissionId = str(args.admissionId, 128, 'args.admissionId', { required: true })
  const claimId = str(args.claimId, 320, 'args.claimId', { required: true })
  const legacyClaimId = str(args.legacyClaimId, 320, 'args.legacyClaimId')
  if (!ID_RE.test(admissionId)) throw new Error('args.admissionId is not a valid record id')
  if (!isPlainObject(args.dischargeData)) throw new Error('args.dischargeData must be an object')
  rejectUnknown(args.dischargeData, new Set(['status', 'discharge_date', 'discharge_type', 'discharge_reason', 'discharge_notes']), 'dischargeData')
  const d = args.dischargeData
  const status = str(d.status, 30, 'dischargeData.status', { required: true })
  const dischargeType = str(d.discharge_type, 30, 'dischargeData.discharge_type', { required: true })
  if (status !== 'discharged') throw new Error('dischargeData.status must be discharged')
  if (!['discharged', 'absconded', 'transferout', 'deceased'].includes(dischargeType)) throw new Error('discharge type is invalid')
  let dischargeDate = d.discharge_date
  if (typeof dischargeDate === 'string') {
    const ms = Date.parse(dischargeDate)
    if (!Number.isFinite(ms)) throw new Error('discharge date is invalid')
    dischargeDate = ms
  }
  if (typeof dischargeDate !== 'number' || !Number.isFinite(dischargeDate)) throw new Error('discharge date is invalid')
  return { admissionId, claimId, legacyClaimId, dischargeData: {
    status, discharge_date: dischargeDate, discharge_type: dischargeType,
    discharge_reason: str(d.discharge_reason, 2000, 'dischargeData.discharge_reason', { required: true }),
    discharge_notes: str(d.discharge_notes, 6000, 'dischargeData.discharge_notes'),
  } }
}

export function validateAdmissionTransferArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, ADMISSION_TRANSFER_ARGS, 'args')
  const admissionId = str(args.admissionId, 128, 'args.admissionId', { required: true })
  const oldClaimId = str(args.oldClaimId, 320, 'args.oldClaimId', { required: true })
  const newClaimId = str(args.newClaimId, 320, 'args.newClaimId', { required: true })
  const legacyOldClaimId = str(args.legacyOldClaimId, 320, 'args.legacyOldClaimId')
  const wardName = str(args.wardName, 120, 'args.wardName', { required: true })
  const bedNumber = str(args.bedNumber, 40, 'args.bedNumber', { required: true })
  const reason = str(args.reason, 2000, 'args.reason', { required: true })
  const transferAt = num(args.transferAt, 9e15, 'args.transferAt')
  if (!ID_RE.test(admissionId) || !transferAt) throw new Error('admission transfer reference or time is invalid')
  const wardKey = wardName.trim().toLowerCase()
  const bedText = bedNumber.trim().toLowerCase()
  const match = bedText.match(/^(?:bed\s*)?(\d+)$/)
  const bedKey = match ? String(Number(match[1])) : bedText.replace(/\s+/g, ' ')
  if (newClaimId !== orgId + '_' + wardKey + '_' + bedKey) throw new Error('new bed claim does not match the transfer destination')
  if (!Array.isArray(args.transferHistory) || args.transferHistory.length > 500) throw new Error('transferHistory is invalid')
  const transferHistory = sanitizeMutationValue(args.transferHistory, 0, 'transferHistory')
  if (!isPlainObject(args.newClaim) || args.newClaim.organization_id !== orgId ||
      args.newClaim.admission_id !== admissionId || args.newClaim.ward_name !== wardName ||
      String(args.newClaim.bed_number) !== bedNumber || !isPlainObject(args.newClaim)) {
    throw new Error('newClaim does not match the transfer destination')
  }
  return { admissionId, oldClaimId, newClaimId, legacyOldClaimId, wardName, bedNumber, reason, transferAt, transferHistory,
    newClaim: { organization_id: orgId, ward_name: wardName, bed_number: bedNumber, admission_id: admissionId, patient_id: str(args.newClaim.patient_id, 128, 'newClaim.patient_id', { required: true }) } }
}

export function validateBillingPaymentArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, BILLING_PAYMENT_ARGS, 'args')
  const invoiceId = str(args.invoiceId, 128, 'args.invoiceId', { required: true })
  const paymentId = str(args.paymentId, 128, 'args.paymentId', { required: true })
  const amountKobo = num(args.amountKobo, 1e12, 'args.amountKobo')
  const method = str(args.method, 60, 'args.method', { required: true })
  const reference = str(args.reference, 160, 'args.reference')
  const notes = str(args.notes, 1000, 'args.notes')
  const labOrderId = str(args.labOrderId, 128, 'args.labOrderId')
  if (!ID_RE.test(invoiceId) || !ID_RE.test(paymentId)) throw new Error('invoice or payment id is invalid')
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) throw new Error('payment amount must be a positive whole number of kobo')
  if (labOrderId && !ID_RE.test(labOrderId)) throw new Error('lab order id is invalid')
  const preview = isPlainObject(args.preview) ? sanitizeMutationValue(args.preview, 0, 'payment preview') : {}
  if (Object.keys(preview).some((key) => !['patient_id', 'patient_name', 'invoice_number', 'total_kobo', 'paid_kobo'].includes(key))) {
    throw new Error('payment preview has an unsupported field')
  }
  return { invoiceId, paymentId, amountKobo, method, reference, notes, labOrderId, preview }
}

export function validateMedicationAdministerArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, MEDICATION_ADMINISTER_ARGS, 'args')
  const requestId = str(args.requestId, 128, 'args.requestId', { required: true })
  const doseId = str(args.doseId, 128, 'args.doseId', { required: true })
  const lineId = str(args.lineId, 128, 'args.lineId', { required: true })
  const qty = num(args.qty, 1e7, 'args.qty')
  const route = str(args.route, 20, 'args.route', { required: true }).toLowerCase()
  const site = str(args.site, 100, 'args.site')
  const note = str(args.note, 1000, 'args.note')
  if (![requestId, doseId, lineId].every((id) => ID_RE.test(id))) throw new Error('medication administration record id is invalid')
  if (!qty || qty <= 0) throw new Error('dose quantity must be greater than zero')
  if (!['oral', 'iv', 'im', 'sc', 'topical', 'other'].includes(route)) throw new Error('medication route is invalid')
  const preview = isPlainObject(args.preview) ? sanitizeMutationValue(args.preview, 0, 'medication preview') : {}
  if (Object.keys(preview).some((key) => !['patient_id', 'patient_name', 'encounter_id', 'admission_session_id', 'medicine', 'unit', 'dosage', 'quantity'].includes(key))) {
    throw new Error('medication preview has an unsupported field')
  }
  return { requestId, doseId, lineId, qty, route, site, note, preview }
}

export function validateStockReceiveArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, STOCK_RECEIVE_ARGS, 'args')
  const drugId = str(args.drugId, 128, 'args.drugId', { required: true })
  const movementId = str(args.movementId, 128, 'args.movementId', { required: true })
  const qty = num(args.qty, 1e9, 'args.qty')
  const batch = str(args.batch, 100, 'args.batch', { required: true })
  const expiry = str(args.expiry, 40, 'args.expiry', { required: true })
  const supplier = str(args.supplier, 200, 'args.supplier')
  const unitCost = num(args.unitCost, 1e12, 'args.unitCost')
  const invoiceRef = str(args.invoiceRef, 160, 'args.invoiceRef')
  if (!ID_RE.test(drugId) || !ID_RE.test(movementId)) throw new Error('stock receipt id is invalid')
  if (!qty || qty <= 0 || !Number.isFinite(Date.parse(expiry))) throw new Error('stock quantity or expiry is invalid')
  const preview = isPlainObject(args.preview) ? sanitizeMutationValue(args.preview, 0, 'stock preview') : {}
  if (Object.keys(preview).some((key) => !['name', 'sku', 'unit', 'stock', 'purchase_price'].includes(key))) throw new Error('stock preview has an unsupported field')
  return { drugId, movementId, qty, batch, expiry, supplier, unitCost: unitCost || 0, invoiceRef, preview }
}

export function validatePharmacyDispenseArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, PHARMACY_DISPENSE_ARGS, 'args')
  const dispensationId = str(args.dispensationId, 128, 'args.dispensationId', { required: true })
  const patientId = str(args.patientId, 128, 'args.patientId')
  const patientName = str(args.patientName, 200, 'args.patientName')
  const medicationRequestId = str(args.medicationRequestId, 128, 'args.medicationRequestId')
  if (!ID_RE.test(dispensationId) || (patientId && !ID_RE.test(patientId)) || (medicationRequestId && !ID_RE.test(medicationRequestId))) {
    throw new Error('dispensation reference is invalid')
  }
  if (!Array.isArray(args.items) || !args.items.length || args.items.length > 20) throw new Error('dispense items are invalid')
  const items = args.items.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error('dispense item must be an object')
    rejectUnknown(raw, new Set(['drugId', 'requestedQty', 'lineId', 'movementId', 'preview']), 'dispense item')
    const drugId = str(raw.drugId, 128, 'item.drugId', { required: true })
    const movementId = str(raw.movementId, 128, 'item.movementId', { required: true })
    const requestedQty = num(raw.requestedQty, 1e9, 'item.requestedQty')
    const lineId = str(raw.lineId, 128, 'item.lineId')
    if (!ID_RE.test(drugId) || !ID_RE.test(movementId) || (lineId && !ID_RE.test(lineId)) || !requestedQty || requestedQty <= 0) {
      throw new Error('dispense item reference or quantity is invalid')
    }
    const preview = isPlainObject(raw.preview) ? sanitizeMutationValue(raw.preview, 0, 'dispense preview') : {}
    if (Object.keys(preview).some((key) => !['sku', 'name', 'unit', 'batch', 'expiry'].includes(key))) throw new Error('dispense preview has an unsupported field')
    return { drugId, movementId, requestedQty, lineId, preview }
  })
  return { dispensationId, patientId, patientName, medicationRequestId, items }
}

export function validateStockCreateArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, STOCK_CREATE_ARGS, 'args')
  const drugId = str(args.drugId, 128, 'args.drugId', { required: true })
  const movementId = str(args.movementId, 128, 'args.movementId')
  if (!ID_RE.test(drugId) || (movementId && !ID_RE.test(movementId))) throw new Error('stock creation reference is invalid')
  if (!isPlainObject(args.drug) || args.drug.organization_id !== orgId) throw new Error('stock item must belong to the selected hospital')
  const drug = sanitizeMutationValue(args.drug, 0, 'drug')
  if (Object.keys(drug).some((k) => !['name','drug_code','strength','pack_size','organization_id','sku','unit','stock','price','purchase_price','batch','expiry','status','supplier'].includes(k))) throw new Error('stock item contains unsupported fields')
  if (!drug.name || !Number.isFinite(drug.stock) || drug.stock < 0 || (drug.stock > 0 && !movementId)) throw new Error('stock item details are invalid')
  return { drugId, movementId, drug }
}

export function validateStockCorrectArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, STOCK_CORRECT_ARGS, 'args')
  const drugId = str(args.drugId, 128, 'args.drugId', { required: true })
  const movementId = str(args.movementId, 128, 'args.movementId', { required: true })
  const countedQty = num(args.countedQty, 1e12, 'args.countedQty')
  const reason = str(args.reason, 1000, 'args.reason')
  const preview = isPlainObject(args.preview) ? sanitizeMutationValue(args.preview, 0, 'stock correction preview') : {}
  if (Object.keys(preview).some((k) => !['name','sku','batch','expiry'].includes(k))) throw new Error('stock correction preview contains unsupported fields')
  if (!ID_RE.test(drugId) || !ID_RE.test(movementId) || countedQty === undefined) throw new Error('stock correction details are invalid')
  return { drugId, movementId, countedQty, reason, preview }
}

export function validateStockUpdateArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, STOCK_UPDATE_ARGS, 'args')
  const drugId = str(args.drugId, 128, 'args.drugId', { required: true })
  const movementId = str(args.movementId, 128, 'args.movementId', { required: true })
  const previousStock = num(args.previousStock, 1e12, 'args.previousStock')
  if (!ID_RE.test(drugId) || !ID_RE.test(movementId) || !isPlainObject(args.fields)) throw new Error('stock update reference is invalid')
  const fields = sanitizeMutationValue(args.fields, 0, 'stock update fields')
  const allowed = new Set(['name','drug_code','strength','pack_size','sku','unit','stock','price','purchase_price','batch','expiry','status','supplier'])
  if (Object.keys(fields).some((key) => !allowed.has(key)) || !Number.isFinite(fields.stock) || fields.stock < 0) throw new Error('stock update fields are invalid')
  return { drugId, movementId, fields, previousStock: previousStock || 0 }
}

export function validatePharmacyReverseArgs(args) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, STOCK_REVERSE_ARGS, 'args')
  const requestId = str(args.requestId, 128, 'args.requestId', { required: true })
  const lineId = str(args.lineId, 128, 'args.lineId', { required: true })
  const movementId = str(args.movementId, 128, 'args.movementId', { required: true })
  const ticketId = str(args.ticketId, 128, 'args.ticketId', { required: true })
  if (![requestId, lineId, movementId, ticketId].every((v) => ID_RE.test(v))) throw new Error('dispense reversal reference is invalid')
  const preview = isPlainObject(args.preview) ? sanitizeMutationValue(args.preview, 0, 'reversal preview') : {}
  if (Object.keys(preview).some((k) => !['drugId','batch','expiry','medicine','patientId','patientName','qty'].includes(k))) throw new Error('reversal preview contains unsupported fields')
  if (preview.drugId && !ID_RE.test(preview.drugId)) throw new Error('reversal drug id is invalid')
  if (preview.qty !== undefined && (!Number.isFinite(preview.qty) || preview.qty <= 0)) throw new Error('reversal quantity is invalid')
  return { requestId, lineId, movementId, ticketId, preview }
}

export function validateFileUploadArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, FILE_UPLOAD_ARGS, 'args')
  const kind = str(args.kind, 20, 'args.kind', { required: true })
  const id = str(args.id, 128, 'args.id', { required: true })
  const remove = args.remove === true
  if (args.remove !== undefined && typeof args.remove !== 'boolean') throw new Error('args.remove must be a boolean')
  if (!['patient_photo', 'result_image'].includes(kind) || !ID_RE.test(id)) throw new Error('file reference is invalid')
  if (kind === 'patient_photo' && !remove && id.length > 128) throw new Error('patient photo reference is invalid')
  if (remove) {
    if (kind !== 'patient_photo' || args.metadata !== undefined || args.contentBase64 !== undefined) throw new Error('only patient photos can be removed')
    return { kind, id, remove: true }
  }
  if (!isPlainObject(args.metadata) || args.metadata.organization_id !== orgId) throw new Error('file metadata must belong to the selected hospital')
  const contentType = str(args.contentType, 100, 'args.contentType', { required: true })
  const contentBase64 = str(args.contentBase64, 1250000, 'args.contentBase64', { required: true })
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || Buffer.from(contentBase64, 'base64').length > 920 * 1024) throw new Error('file payload is invalid or too large')
  if (kind === 'patient_photo' && !contentType.startsWith('image/')) throw new Error('patient photo must be an image')
  if (kind === 'result_image' && !contentType.startsWith('image/') && contentType !== 'application/pdf') throw new Error('result attachment must be an image or PDF')
  const metadata = sanitizeMutationValue(args.metadata, 0, 'file metadata')
  if (metadata.content_type !== contentType || Number(metadata.size_bytes) !== Buffer.from(contentBase64, 'base64').length) throw new Error('file metadata does not match its payload')
  if (kind === 'result_image' && (!['lab', 'imaging'].includes(metadata.kind) || !ID_RE.test(String(metadata.order_id || '')))) throw new Error('result image must reference a valid lab or imaging order')
  if (kind === 'patient_photo' && metadata.patient_id !== id) throw new Error('photo patient id must match the file reference')
  if (Object.keys(metadata).some((k) => !['patient_id','organization_id','content_type','size_bytes','width','height','updated_by','updated_by_name','updated_at','kind','order_id','caption','created_by','created_by_name','created_at'].includes(k))) throw new Error('file metadata contains unsupported fields')
  return { kind, id, metadata, contentType, contentBase64 }
}

export function validateDocumentMutationArgs(args, orgId) {
  if (!isPlainObject(args)) throw new Error('args must be an object')
  rejectUnknown(args, MUTATION_ARGS, 'args')
  if (!Array.isArray(args.mutations) || !args.mutations.length || args.mutations.length > 20) {
    throw new Error('args.mutations must contain 1–20 writes')
  }
  const mutations = args.mutations.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error('mutations[' + index + '] must be an object')
    rejectUnknown(raw, new Set(['collection', 'id', 'action', 'data']), 'mutations[' + index + ']')
    const collection = str(raw.collection, 80, 'mutation.collection', { required: true })
    const id = str(raw.id, 128, 'mutation.id', { required: true })
    const action = str(raw.action, 12, 'mutation.action', { required: true })
    if (!ID_RE.test(id)) throw new Error('mutation id is invalid')
    if (!MUTATION_CAPS[collection]?.[action]) throw new Error('collection/action is not available for LAN sync')
    let data = null
    if (action !== 'delete') {
      if (!isPlainObject(raw.data)) throw new Error('mutation data must be an object')
      data = sanitizeMutationValue(raw.data, 0, 'mutation.data')
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 450 * 1024) throw new Error('mutation data is too large')
      delete data.created_by
      delete data.created_by_name
      if (Object.keys(data).length > 80) throw new Error('mutation data has too many fields')
      if (action === 'create' && data.organization_id !== orgId) throw new Error('new record must belong to the selected hospital')
      if (data.organization_id !== undefined && data.organization_id !== orgId) throw new Error('record hospital cannot be changed')
      if (collection === 'organization_patients' &&
          (!id.startsWith(orgId + '_') || (data.patient_id && id !== orgId + '_' + data.patient_id) ||
           (action === 'create' && !data.patient_id))) {
        throw new Error('hospital patient link id does not match the selected hospital and patient')
      }
    } else if (raw.data !== undefined) throw new Error('delete mutation cannot include data')
    return { collection, id, action, data }
  })
  if (!capabilitiesForMutationArgs({ mutations }).length) throw new Error('one handoff batch must use a single permission scope')
  return { mutations }
}

function sanitizeMutationValue(value, depth, field) {
  if (depth > 10) throw new Error(field + ' is nested too deeply')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(field + ' contains a non-finite number')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 20000) throw new Error(field + ' contains an overlong string')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error(field + ' contains too many items')
    return value.map((item, i) => sanitizeMutationValue(item, depth + 1, field + '[' + i + ']'))
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length > 100) throw new Error(field + ' has too many fields')
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key) || !/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new Error(field + ' has an invalid field name')
      out[key] = sanitizeMutationValue(item, depth + 1, field + '.' + key)
    }
    return out
  }
  throw new Error(field + ' contains an unsupported value')
}

const VALIDATORS = {
  rx_mirror: validateRxArgs,
  lab_snapshot: validateLabArgs,
  admission_create: (args, orgId) => validateAdmissionCreateArgs(args, orgId),
  admission_discharge: validateAdmissionDischargeArgs,
  admission_transfer: (args, orgId) => validateAdmissionTransferArgs(args, orgId),
  billing_payment: validateBillingPaymentArgs,
  medication_administer: validateMedicationAdministerArgs,
  stock_receive: validateStockReceiveArgs,
  pharmacy_dispense: validatePharmacyDispenseArgs,
  stock_create: (args, orgId) => validateStockCreateArgs(args, orgId),
  stock_correct: validateStockCorrectArgs,
  stock_update: (args, orgId) => validateStockUpdateArgs(args, orgId),
  pharmacy_reverse: validatePharmacyReverseArgs,
  file_upload: (args, orgId) => validateFileUploadArgs(args, orgId),
  document_mutation: (args, orgId) => validateDocumentMutationArgs(args, orgId),
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
    args = VALIDATORS[kind](raw.args, orgId)
  } catch (e) {
    return { error: at + '.args: ' + String(e?.message || e) }
  }
  return { op: { clientOpKey, kind, orgId, args, createdAt } }
}
