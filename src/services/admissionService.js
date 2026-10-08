// Admissions / bed management data layer (direct Firestore, Spark plan: no backend).
//
// Relationship to encounters follows HL7 FHIR: an admission is a stay that
// hangs off the encounter that triggered it, so `encounter_id` is stored on the
// admission and the link is one-directional (the shape of `Encounter.partOf`).
// No `admission_id` is written back onto the encounter — one writer, one field,
// no chance of the two documents disagreeing. Reverse lookups query by
// `encounter_id` (see the composite index in firestore.indexes.json).
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { getPatient } from './patientService.js'
import { getEncounter } from './consultationService.js'
import { listOrgWards } from './wardService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import {
  ADMISSION_ACTIVE, ADMISSION_DISCHARGED, ADMISSION_TYPES,
  normalizeAdmission, normalizeAdmissions, occupancySummary, wardOccupancy,
  activeAdmissionForPatient, activeAdmissionForEncounter, indexAdmissionsByEncounter,
  admissionsForEncounter, validateAdmissionInput, validateDischargeInput,
  occupiedInWard, validateWardCapacity,
} from '../features/admissions/domain.js'

const ADMISSIONS = 'admissions'

// Pure rules live in features/admissions/domain.js so the smoke test can
// exercise them without pulling in Firebase. Re-exported for the views.
export {
  ADMISSION_ACTIVE, ADMISSION_DISCHARGED, ADMISSION_TYPES,
  occupancySummary, wardOccupancy, occupiedInWard,
  activeAdmissionForPatient, activeAdmissionForEncounter, indexAdmissionsByEncounter,
  admissionsForEncounter, validateAdmissionInput, validateDischargeInput, validateWardCapacity,
  normalizeAdmission, normalizeAdmissions,
}

// ---- capability check --------------------------------------------------------
// Capability name MUST match firestore.rules ('beds.manage' guards
// admissions/wards/beds). Do not rename without updating the rules.
export function myAdmissionCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canAdmit: can(me, 'beds.manage'),
    canDischarge: can(me, 'beds.manage'),
  }
}

// ---- model shape -----------------------------------------------------------
// Canonical shape + the legacy `ward`/`bed`/`doctor`/`Admitted` vocabulary are
// both handled in normalizeAdmission, so admissions written by the patient
// chart remain visible here.
function toAdmissionRow(r) {
  return normalizeAdmission(r)
}

// ---- reads ---------------------------------------------------------------
export async function listOrgAdmissions(orgId) {
  const snap = await getDocs(query(collection(db, ADMISSIONS), where('organization_id', '==', orgId)))
  const rows = normalizeAdmissions(snap.docs.map((d) => toAdmissionRow({ ...d.data(), id: d.id })))
  rows.sort((a, b) => (b.admissionDate || b.createdAt) - (a.admissionDate || a.createdAt))
  return rows
}

// Get single admission
export async function getAdmission(aid) {
  const snap = await getDoc(doc(db, ADMISSIONS, aid))
  if (!snap.exists()) return null
  return toAdmissionRow({ ...snap.data(), id: snap.id })
}

// List admissions for a specific patient
export async function listPatientAdmissions(pid) {
  const snap = await getDocs(query(collection(db, ADMISSIONS), where('patient_id', '==', pid)))
  const rows = normalizeAdmissions(snap.docs.map((d) => toAdmissionRow({ ...d.data(), id: d.id })))
  rows.sort((a, b) => (b.admissionDate || b.createdAt) - (a.admissionDate || a.createdAt))
  return rows
}

// ---- encounter linkage ---------------------------------------------------
// Every admission made from an encounter, in one query (needs the
// organization_id + encounter_id composite index). Unlinked admissions are not
// returned, so callers should treat "no rows" as "not linked", not "no history".
export async function listAdmissionsByEncounter(orgId, encounterId) {
  if (!orgId || !encounterId) return []
  const snap = await getDocs(query(
    collection(db, ADMISSIONS),
    where('organization_id', '==', orgId),
    where('encounter_id', '==', encounterId),
  ))
  const rows = normalizeAdmissions(snap.docs.map((d) => toAdmissionRow({ ...d.data(), id: d.id })))
  rows.sort((a, b) => (b.admissionDate || b.createdAt) - (a.admissionDate || a.createdAt))
  return rows
}

// The patient's current bed, if any. Views fetch the org's admissions once and
// use this instead of a query per row.
export async function findActiveAdmissionForPatient(orgId, patientId) {
  const rows = await listPatientAdmissions(patientId)
  const mine = rows.filter((r) => (r.raw?.organization_id || '') === orgId)
  return activeAdmissionForPatient(mine, patientId)
}

export async function findActiveAdmissionForEncounter(orgId, encounterId) {
  return activeAdmissionForEncounter(indexAdmissionsByEncounter(await listAdmissionsByEncounter(orgId, encounterId)), encounterId)
}

// ---- create ---------------------------------------------------------------
export async function createAdmission(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAdmissionCaps()
  if (!caps.canAdmit) {
    throw new Error('Your role cannot admit patients (missing "beds.manage" capability). Ask an administrator.')
  }

  const pid = String(input.patient_id || '').trim()
  if (!pid) throw new Error('Patient is required.')

  // Verify patient exists (single doc read, not a scan of the org's patients).
  const patient = await getPatient(pid)
  if (!patient) throw new Error('Patient not found.')
  const patientOrg = patient.organizationId ?? patient.organization_id ?? ''
  if (patientOrg && patientOrg !== activeOrg) {
    throw new Error('Selected patient is not registered at this hospital.')
  }

  // Resolve the linked encounter, if any. This is the FHIR one-way link; it is
  // verified against the same patient so a bed can never be filed under someone
  // else's clinical story.
  let encounter = null
  const encounterId = String(input.encounter_id || '').trim()
  if (encounterId) {
    encounter = await getEncounter(encounterId)
    if (!encounter) throw new Error('The linked encounter could not be found.')
    const encOrg = encounter.raw?.organization_id || ''
    if (encOrg && encOrg !== activeOrg) throw new Error('The linked encounter belongs to a different hospital.')
  }

  // Bed availability is re-checked here, against fresh reads, so a stale page
  // cannot write an over-capacity or double-booked admission.
  const [wards, admissions] = await Promise.all([
    listOrgWards(activeOrg).catch(() => []),
    listOrgAdmissions(activeOrg).catch(() => []),
  ])
  const invalid = validateAdmissionInput(
    { patient_id: pid, ward_name: input.ward_name, bed_number: input.bed_number, encounter_id: encounterId },
    { wards, admissions, encounter },
  )
  if (invalid) throw new Error(invalid)

  const admissionId = doc(collection(db, ADMISSIONS)).id
  const now = serverTimestamp()
  const admission = {
    patient_id: pid,
    patient_name: input.patient_name || patient.name || '',
    organization_id: activeOrg,
    // One-way link back to the encounter that triggered this admission ('' when
    // the patient walked in without one).
    encounter_id: encounterId,
    ward_name: String(input.ward_name || '').trim(),
    bed_number: String(input.bed_number || '').trim(),
    admission_type: input.admission_type || '',
    admission_reason: input.admission_reason || '',
    attending_provider: input.attending_provider || '',
    status: ADMISSION_ACTIVE,
    created_by: user?.uid || null,
    created_by_name: user?.email || '',
    created_at: now,
    updated_at: now,
  }

  await setDoc(doc(db, ADMISSIONS, admissionId), admission)

  try {
    await logAudit({
      action: 'admission.created',
      organizationId: activeOrg,
      patientId: pid,
      details: 'Admission ' + admissionId + ' - ' + admission.ward_name + ' · ' + admission.bed_number +
        ' for ' + admission.patient_name + (encounterId ? ' (from encounter ' + encounterId + ')' : ''),
    })
  } catch (e) {
    console.warn('[admissions] audit append failed:', e?.message)
  }
  return { id: admissionId, ...admission }
}

// ---- discharge ------------------------------------------------------------
export async function dischargeAdmission(admissionId, dischargeInput) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  // Rules require `beds.manage` for admission updates.
  if (!can(myActiveMembership(), 'beds.manage')) {
    throw new Error('Your role cannot discharge patients (missing "beds.manage" capability). Ask an administrator to re-save your role.')
  }

  const invalid = validateDischargeInput(dischargeInput)
  if (invalid) throw new Error(invalid)

  const adm = await getAdmission(admissionId)
  if (!adm) throw new Error('Admission not found.')
  if (adm.status !== ADMISSION_ACTIVE) {
    throw new Error('This admission is already discharged (' + adm.status + ').')
  }

  const now = serverTimestamp()
  const dischargeData = {
    status: ADMISSION_DISCHARGED,
    discharge_date: now,
    discharge_reason: String(dischargeInput.reason || '').trim(),
    discharge_notes: String(dischargeInput.notes || '').trim(),
    discharged_by: user?.uid || null,
    discharged_by_name: user?.email || '',
    updated_at: now,
  }

  await updateDoc(doc(db, ADMISSIONS, admissionId), dischargeData)

  try {
    await logAudit({
      action: 'admission.discharged',
      organizationId: activeOrg,
      patientId: adm.patientId,
      details: 'Admission ' + admissionId + ' discharged - ' + (dischargeData.discharge_reason || ''),
    })
  } catch (e) {
    console.warn('[admissions] audit append failed:', e?.message)
  }
  return true
}

// ---- wards ---------------------------------------------------------------
// Re-exported from wardService so a view that manages beds needs one import.
export { listOrgWards, createWard, updateWardBeds, myWardCaps } from './wardService.js'

// Bed capacity cannot drop below the patients already holding a bed.
export async function validateWardBedsChange(orgId, wardId, newTotal) {
  const wards = await listOrgWards(orgId)
  const w = wards.find((x) => x.id === wardId)
  if (!w) return 'Ward not found.'
  const admissions = await listOrgAdmissions(orgId)
  return validateWardCapacity(newTotal, admissions, w.name)
}
