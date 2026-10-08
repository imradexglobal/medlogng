// Pure admission / bed rules — no Firebase imports (unit-testable).
// Same pattern as features/encounters/domain.js and features/orgs/domain.js.
//
// Relationship to encounters follows HL7 FHIR (R4 §Encounter / R5 §Encounter):
// an admission is a stay that hangs OFF the encounter that triggered it, so the
// link is stored on the admission (`encounter_id`) and is deliberately
// one-directional — the same shape as `Encounter.partOf`. Nothing writes an
// `admission_id` back onto the encounter, so the two documents can never drift
// out of sync. Reverse lookups go through `indexAdmissionsByEncounter`.

export const ADMISSION_ACTIVE = 'active'
export const ADMISSION_DISCHARGED = 'discharged'

export const ADMISSION_TYPES = ['Emergency', 'Elective', 'Transfer', 'Observation']

// Two writers have historically written the `admissions` collection with
// different vocabularies:
//   - admissionService.createAdmission() → status 'active' | 'discharged',
//     plus ward_name / bed_number / attending_provider
//   - the "Admit patient" form on the patient chart → status 'Admitted',
//     plus ward / bed / doctor
// Both are understood here, so an admission recorded from the patient chart is
// still counted against bed occupancy. A missing or unknown status counts as
// ACTIVE: an admission only stops holding a bed once it is explicitly
// discharged, which is the safe direction to fail in.
const STATUS_ALIASES = {
  active: ADMISSION_ACTIVE,
  admitted: ADMISSION_ACTIVE,
  inpatient: ADMISSION_ACTIVE,
  observation: ADMISSION_ACTIVE,
  pending: ADMISSION_ACTIVE,
  discharged: ADMISSION_DISCHARGED,
  discharge: ADMISSION_DISCHARGED,
  closed: ADMISSION_DISCHARGED,
  deceased: ADMISSION_DISCHARGED,
  absconded: ADMISSION_DISCHARGED,
  transferout: ADMISSION_DISCHARGED,
  home: ADMISSION_DISCHARGED,
}

// Firestore Timestamps, epoch millis and Firestore's { seconds } shape all have
// to survive the trip through the offline cache.
export function tsMillis(v) {
  if (v == null) return 0
  if (typeof v.toMillis === 'function') return v.toMillis()
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function admissionStatus(raw) {
  const key = String((raw && typeof raw === 'object' ? raw.status : raw) ?? '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!key) return ADMISSION_ACTIVE
  return STATUS_ALIASES[key] || ADMISSION_ACTIVE
}

export function isAdmissionActive(raw) {
  return admissionStatus(raw) === ADMISSION_ACTIVE
}

// Canonical admission row (camelCase) for both writers described above.
export function normalizeAdmission(r) {
  const raw = r || {}
  const createdAt = tsMillis(raw.created_at)
  return {
    id: raw.id || '',
    patientId: raw.patient_id || '',
    patientName: raw.patient_name || '',
    organizationId: raw.organization_id || '',
    // The one-way link back to the encounter that triggered this admission.
    encounterId: raw.encounter_id || '',
    wardName: raw.ward_name || raw.ward || '',
    bedNumber: String(raw.bed_number ?? raw.bed ?? raw.bed_label ?? ''),
    admissionType: raw.admission_type || '',
    admissionReason: raw.admission_reason || raw.reason || '',
    attendingProvider: raw.attending_provider || raw.doctor || raw.admitting_doctor || '',
    status: admissionStatus(raw),
    admissionDate: tsMillis(raw.admission_date) || createdAt,
    dischargeDate: tsMillis(raw.discharge_date),
    dischargeReason: raw.discharge_reason || '',
    dischargeNotes: raw.discharge_notes || '',
    createdAt,
    raw,
  }
}

export function normalizeAdmissions(list) {
  return (list || []).map(normalizeAdmission)
}

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()

export function occupiedInWard(admissions, wardName) {
  const key = String(wardName || '').trim()
  if (!key) return 0
  return (admissions || []).filter((a) => a.status === ADMISSION_ACTIVE && sameText(a.wardName, key)).length
}

// Per-ward occupancy, including wards that have no configured capacity yet and
// wards that are holding more patients than their stated bed count.
export function wardOccupancy(admissions, wards) {
  const rows = (wards || []).map((w) => ({
    name: w.name || '',
    totalBeds: Number(w.totalBeds ?? w.total_beds ?? 0) || 0,
    occupied: 0,
  }))
  const byName = new Map(rows.map((r) => [String(r.name || '').trim().toLowerCase(), r]))
  for (const a of admissions || []) {
    if (a.status !== ADMISSION_ACTIVE) continue
    const row = byName.get(String(a.wardName || '').trim().toLowerCase())
    if (row) row.occupied += 1
  }
  return rows.map((r) => ({
    ...r,
    free: Math.max(0, r.totalBeds - r.occupied),
    pct: r.totalBeds ? Math.round((r.occupied / r.totalBeds) * 100) : 0,
    overCapacity: r.totalBeds > 0 && r.occupied > r.totalBeds,
    unconfigured: r.totalBeds === 0,
  }))
}

export function occupancySummary(admissions, wards) {
  const rows = (admissions || []).map((a) => (a && a.raw !== undefined ? a : normalizeAdmission(a)))
  const active = rows.filter((a) => a.status === ADMISSION_ACTIVE)
  const discharged = rows.filter((a) => a.status === ADMISSION_DISCHARGED)
  const wardRows = wardOccupancy(rows, wards)
  const totalBeds = wardRows.reduce((s, r) => s + r.totalBeds, 0)
  return {
    active: active.length,
    discharged: discharged.length,
    total: rows.length,
    totalBeds,
    free: totalBeds ? Math.max(0, totalBeds - active.length) : 0,
    occupancyPct: totalBeds ? Math.round((active.length / totalBeds) * 100) : 0,
    // Patients in a ward that has no capacity configured are real occupied
    // beds; the page shows "—" rather than a misleading 100% or 0%.
    hasCapacity: totalBeds > 0,
    wards: wardRows,
  }
}

// One patient holds at most one bed at a time. Catching this before the write
// prevents the duplicate-occupancy bug that a `status` the counter did not
// recognise would otherwise cause.
export function activeAdmissionForPatient(admissions, patientId) {
  const pid = String(patientId || '')
  if (!pid) return null
  return (admissions || []).find((a) => a.status === ADMISSION_ACTIVE && String(a.patientId || '') === pid) || null
}

// Group admissions by the encounter that triggered them. Views fetch the org's
// admissions once and join in memory, so an encounter list never issues one
// query per row.
export function indexAdmissionsByEncounter(admissions) {
  const m = new Map()
  for (const a of admissions || []) {
    const eid = String(a.encounterId || '').trim()
    if (!eid) continue
    if (!m.has(eid)) m.set(eid, [])
    m.get(eid).push(a)
  }
  for (const list of m.values()) list.sort((x, y) => (y.admissionDate || y.createdAt) - (x.admissionDate || x.createdAt))
  return m
}

export function activeAdmissionForEncounter(index, encounterId) {
  const list = index && typeof index.get === 'function' ? index.get(String(encounterId || '').trim()) : null
  if (!list || !list.length) return null
  return list.find((a) => a.status === ADMISSION_ACTIVE) || null
}

export function admissionsForEncounter(index, encounterId) {
  const list = index && typeof index.get === 'function' ? index.get(String(encounterId || '').trim()) : null
  return list ? list.slice() : []
}

// Returns an error message, or null when the admission is safe to write.
// `ctx.admissions` and `ctx.wards` are normalized rows.
export function validateAdmissionInput(v, ctx = {}) {
  const { wards = [], admissions = [], encounter = null } = ctx
  const values = v || {}

  const patientId = String(values.patient_id || '').trim()
  if (!patientId) return 'Patient is required.'

  // The linked encounter must be the patient's own, or the link would file this
  // bed under someone else's clinical story.
  if (values.encounter_id && encounter) {
    const encPid = String(encounter.patientId || encounter.patient_id || '')
    if (encPid && encPid !== patientId) {
      return 'That encounter belongs to a different patient.'
    }
  }

  const held = activeAdmissionForPatient(admissions, patientId)
  if (held) {
    return 'This patient already holds a bed — ' + (held.wardName || 'ward unknown') + ' · ' + (held.bedNumber || 'bed unknown') +
      '. Discharge or transfer them first.'
  }

  const wardName = String(values.ward_name || '').trim()
  if (!wardName) return 'Ward is required.'
  const bedNumber = String(values.bed_number || '').trim()
  if (!bedNumber) return 'Bed is required.'

  const ward = (wards || []).find((w) => sameText(w.name, wardName))
  // No ward master yet: the bed cannot be capacity-checked, so it is allowed
  // through and surfaced as "unconfigured" on the wards grid.
  if (!ward) return null

  const total = Number(ward.totalBeds ?? ward.total_beds ?? 0) || 0
  const occ = occupiedInWard(admissions, ward.name)
  if (total > 0 && occ >= total) {
    return wardName + ' is full (' + occ + ' / ' + total + '). Transfer or discharge first.'
  }
  const bedTaken = (admissions || []).find((a) =>
    a.status === ADMISSION_ACTIVE && sameText(a.wardName, ward.name) && sameText(a.bedNumber, bedNumber))
  if (bedTaken) {
    return 'Bed ' + bedNumber + ' in ' + wardName + ' is already occupied by ' + (bedTaken.patientName || 'another patient') + '.'
  }
  return null
}

export function validateDischargeInput(v) {
  if (!String((v || {}).reason || '').trim()) return 'Discharge reason is required.'
  return null
}

export function validateWardCapacity(newTotal, admissions, wardName) {
  const n = Number(newTotal)
  if (!Number.isFinite(n) || n < 1) return 'Total beds must be at least 1.'
  const occ = occupiedInWard(admissions, wardName)
  if (n < occ) return 'Cannot set below current occupancy (' + occ + ').'
  return null
}
