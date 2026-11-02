// Admissions / bed management data layer (direct Firestore, Spark plan: no backend).
//
// Relationship to encounters follows HL7 FHIR: an admission is a stay that
// hangs off the encounter that triggered it, so `encounter_id` is stored on the
// admission and the link is one-directional (the shape of `Encounter.partOf`).
// No `admission_id` is written back onto the encounter — one writer, one field,
// no chance of the two documents disagreeing. Reverse lookups query by
// `encounter_id` (see the composite index in firestore.indexes.json).
import {
  db, collection, query, where, getDocs, doc, setDoc, serverTimestamp, orderBy, limit,
  startAfter, writeBatch,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { getPatientForOrg } from './patientService.js'
import { getEncounter } from './consultationService.js'
import { listOrgWards } from './wardService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import {
  ADMISSION_ACTIVE, ADMISSION_DISCHARGED, ADMISSION_TYPES,
  normalizeAdmission, normalizeAdmissions, occupancySummary, wardOccupancy,
  activeAdmissionForPatient, activeAdmissionForEncounter, indexAdmissionsByEncounter,
  admissionsForEncounter, validateAdmissionInput, validateDischargeInput,
  occupiedInWard, validateWardCapacity, tsMillis, normalizeWardId, normalizeBedId,
} from '../features/admissions/domain.js'
import { watchQuery } from './live.js'
import { currentStaffName } from '../lib/staffName.js'
import { getDocTolerant, getDocsTolerant, isOffline } from '../lib/offlineRead.js'

const ADMISSIONS = 'admissions'

// Live listeners are bounded to the 100 most recent rows (cost control);
// list* stays unbounded so a manual refresh still shows everything.
// Admissions sort by admissionDate||createdAt, and admissionDate always
// falls back to created_at, so ordering the live query by created_at matches.
const LIVE_LIMIT = 100

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
function buildOrgAdmissionsQuery(orgId) {
  return query(collection(db, ADMISSIONS), where('organization_id', '==', orgId))
}

function mapAdmissionDoc(d) {
  return toAdmissionRow({ ...d.data(), id: d.id })
}

function normalizeAndSortAdmissions(rows) {
  const normalized = normalizeAdmissions(rows)
  normalized.sort((a, b) => (b.admissionDate || b.createdAt) - (a.admissionDate || a.createdAt))
  return normalized
}

export async function listOrgAdmissions(orgId) {
  const snap = await getDocsTolerant(buildOrgAdmissionsQuery(orgId))
  return normalizeAndSortAdmissions(snap.docs.map(mapAdmissionDoc))
}

// Next chunk of the newest-first list (cursor-walked for infinite scroll).
// Needs index:
// admissions: organization_id ASC + created_at DESC.
export const ADMISSIONS_PAGE = 25

export async function listOrgAdmissionsPage(orgId, { pageSize = ADMISSIONS_PAGE, cursor = null } = {}) {
  const { runChunk } = await import('./pagination.js')
  const base = query(
    collection(db, ADMISSIONS),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: normalizeAndSortAdmissions(docs.map(mapAdmissionDoc)), hasMore, cursor: next }
}


// Live query: same org scope + row shape as listOrgAdmissions, but bounded
// to the 100 most recent (orderBy+limit needs the composite index in
// firestore.indexes.json — deploy it or the listener falls back to one-shot).
function buildOrgAdmissionsLiveQuery(orgId) {
  return query(
    collection(db, ADMISSIONS),
    where('organization_id', '==', orgId),
    orderBy('created_at', 'desc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgAdmissions(orgId, onRows, onError) {
  return watchQuery(
    buildOrgAdmissionsLiveQuery(orgId),
    mapAdmissionDoc,
    (rows) => onRows(normalizeAndSortAdmissions(rows)),
    onError,
  )
}

// Get single admission
export async function getAdmission(aid) {
  const snap = await getDocTolerant(doc(db, ADMISSIONS, aid))
  if (!snap.exists()) return null
  return toAdmissionRow({ ...snap.data(), id: snap.id })
}

// List admissions for a specific patient (bounded to the 50 most recent rows)
export async function listPatientAdmissions(pid, { limitN = 50 } = {}) {
  const snap = await getDocs(query(collection(db, ADMISSIONS), where('patient_id', '==', pid), limit(limitN)))
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

// Bed claim documents prevent double-booking: one doc per canonical
// (org, ward, bed), created in the same offline-persisted write batch as the
// admission. Firestore rules arbitrate competing claims when batches sync.
const BED_CLAIMS = 'bed_claims'

function bedClaimKey(orgId, wardName, bedNumber) {
  return String(orgId || '') + '_' + normalizeWardId(wardName) + '_' + normalizeBedId(bedNumber)
}

function legacyBedClaimKey(orgId, wardName, bedNumber) {
  return String(orgId || '') + '_' + normalizeWardId(wardName) + '_' + String(bedNumber || '').trim().toLowerCase()
}

export { bedClaimKey }

// Firestore batches are persisted and applied optimistically by the configured
// IndexedDB cache while offline. Return promptly for offline/slow connections;
// the SDK retains the atomic batch and applies rules when it reaches Firestore.
async function commitAdmissionBatch(batch) {
  const pending = batch.commit()
  let timedOut = false
  const reportLateFailure = (e) => {
    console.warn('[admissions] queued write was rejected during sync:', e?.message || e)
    if (timedOut && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('medilog-admission-sync-error', {
        detail: { message: 'An admission update could not sync. Reopen Admissions to review it; the bed may have been taken or your access may have changed.' },
      }))
    }
  }
  pending.catch(reportLateFailure)
  if (isOffline()) { timedOut = true; return { pendingSync: true } }
  let timer
  const result = await Promise.race([
    pending.then(() => ({ pendingSync: false })),
    new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve({ pendingSync: true }) }, 1800) }),
  ])
  clearTimeout(timer)
  return result
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
  const patient = await getPatientForOrg(activeOrg, pid)
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

  // Validate against cached/current ward and admission reads. The atomic batch
  // and Firestore rules remain authoritative if another device races offline.
  const wards = await listOrgWards(activeOrg).catch(() => [])
  const admissions = await listOrgAdmissions(activeOrg).catch(() => [])
  const invalid = validateAdmissionInput(
    { patient_id: pid, ward_name: input.ward_name, bed_number: input.bed_number, encounter_id: encounterId },
    { wards, admissions, encounter },
  )
  if (invalid) throw new Error(invalid)

  const admissionId = doc(collection(db, ADMISSIONS)).id
  const now = serverTimestamp()
  const wardName = String(input.ward_name || '').trim()
  const bedNumber = normalizeBedId(input.bed_number)
  const admission = {
    patient_id: pid,
    patient_name: input.patient_name || patient.name || '',
    organization_id: activeOrg,
    // One-way link back to the encounter that triggered this admission ('' when
    // the patient walked in without one).
    encounter_id: encounterId,
    ward_name: wardName,
    bed_number: bedNumber,
    admission_type: input.admission_type || '',
    admission_reason: input.admission_reason || '',
    attending_provider: input.attending_provider || '',
    status: ADMISSION_ACTIVE,
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: now,
    updated_at: now,
  }

  // One atomic local-first batch persists both the admission and its claim.
  // Rules reject a competing claim when offline writes reach Firestore.
  const bedClaimRef = doc(db, BED_CLAIMS, bedClaimKey(activeOrg, wardName, bedNumber))
  const admissionRef = doc(db, ADMISSIONS, admissionId)
  const batch = writeBatch(db)
  batch.set(admissionRef, admission)
  batch.set(bedClaimRef, {
        organization_id: activeOrg,
        ward_name: wardName,
        bed_number: bedNumber,
        admission_id: admissionId,
        patient_id: pid,
        created_at: now,
      })
  const writeResult = await commitAdmissionBatch(batch)

  try {
    void logAudit({
      action: 'admission.created',
      organizationId: activeOrg,
      patientId: pid,
      details: 'Admission ' + admissionId + ' - ' + admission.ward_name + ' · ' + admission.bed_number +
        ' for ' + admission.patient_name + (encounterId ? ' (from encounter ' + encounterId + ')' : ''),
    })
  } catch (e) {
    console.warn('[admissions] audit append failed:', e?.message)
  }
  return { id: admissionId, ...admission, ...writeResult }
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
  const dischargeType = String(dischargeInput.dischargeType || 'discharged').trim().toLowerCase()
  const dischargeDate = dischargeInput.dischargeDate ? tsMillis(dischargeInput.dischargeDate) : now
  const dischargeData = {
    status: ADMISSION_DISCHARGED,
    discharge_date: dischargeDate,
    discharge_type: dischargeType,
    discharge_reason: String(dischargeInput.reason || '').trim(),
    discharge_notes: String(dischargeInput.notes || '').trim(),
    discharged_by: user?.uid || null,
    discharged_by_name: currentStaffName(),
    updated_at: now,
  }

  const admissionRef = doc(db, ADMISSIONS, admissionId)
  const claimRef = doc(db, BED_CLAIMS, bedClaimKey(activeOrg, adm.wardName, adm.bedNumber))
  // Discharge and claim release commit together. If claim cleanup fails, the
  // admission remains active and visibly occupies the bed for retry.
  const batch = writeBatch(db)
  batch.update(admissionRef, dischargeData)
  batch.delete(claimRef)
  const legacyClaimPath = legacyBedClaimKey(activeOrg, adm.wardName, adm.bedNumber)
  if (legacyClaimPath !== claimRef.id) batch.delete(doc(db, BED_CLAIMS, legacyClaimPath))
  const writeResult = await commitAdmissionBatch(batch)

  try {
    void logAudit({
      action: 'admission.discharged',
      organizationId: activeOrg,
      patientId: adm.patientId,
      details: 'Admission ' + admissionId + ' discharged - ' + (dischargeData.discharge_reason || ''),
    })
  } catch (e) {
    console.warn('[admissions] audit append failed:', e?.message)
  }
  return writeResult
}

// Transfer location and both claims in one local-first batch, so a rejected
// target claim cannot leave the admission or old claim partially updated.
export async function transferAdmission(admissionId, input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (!can(myActiveMembership(), 'beds.manage')) throw new Error('Your role cannot transfer patients (missing "beds.manage" capability).')
  const adm = await getAdmission(admissionId)
  if (!adm || adm.status !== ADMISSION_ACTIVE) throw new Error('This admission is not active.')
  const wards = await listOrgWards(activeOrg)
  const admissions = await listOrgAdmissions(activeOrg)
  const wardName = String(input.ward_name || '').trim()
  const bedNumber = normalizeBedId(input.bed_number)
  const reason = String(input.reason || '').trim()
  if (!reason) throw new Error('Transfer reason is required.')
  const invalid = validateAdmissionInput({ patient_id: adm.patientId, ward_name: wardName, bed_number: bedNumber }, {
    wards, admissions: admissions.filter((a) => a.id !== admissionId),
  })
  if (invalid) throw new Error(invalid)
  const oldClaim = doc(db, BED_CLAIMS, bedClaimKey(activeOrg, adm.wardName, adm.bedNumber))
  const newClaim = doc(db, BED_CLAIMS, bedClaimKey(activeOrg, wardName, bedNumber))
  const admissionRef = doc(db, ADMISSIONS, admissionId)
  const now = serverTimestamp()
  const transferAt = Date.now()
  const batch = writeBatch(db)
  batch.update(admissionRef, {
      ward_name: wardName, bed_number: bedNumber, updated_at: now,
      transfer_history: [...(Array.isArray(adm.raw?.transfer_history) ? adm.raw.transfer_history : []), { at: transferAt, from_ward: adm.wardName, from_bed: adm.bedNumber, to_ward: wardName, to_bed: bedNumber, reason, staff_id: user?.uid || '', staff_name: currentStaffName() }],
    })
  batch.set(newClaim, { organization_id: activeOrg, ward_name: wardName, bed_number: bedNumber, admission_id: admissionId, patient_id: adm.patientId, created_at: now })
  if (oldClaim.path !== newClaim.path) {
    batch.delete(oldClaim)
    const legacyOldPath = legacyBedClaimKey(activeOrg, adm.wardName, adm.bedNumber)
    if (legacyOldPath !== oldClaim.id && legacyOldPath !== newClaim.id) batch.delete(doc(db, BED_CLAIMS, legacyOldPath))
  }
  const writeResult = await commitAdmissionBatch(batch)
  void logAudit({ action: 'admission.transferred', organizationId: activeOrg, patientId: adm.patientId,
    details: 'Admission ' + admissionId + ' transferred from ' + adm.wardName + ' · ' + adm.bedNumber + ' to ' + wardName + ' · ' + bedNumber + ' (' + reason + ')' })
  return writeResult
}

// ---- wards ---------------------------------------------------------------
// Re-exported from wardService so a view that manages beds needs one import.
export { listOrgWards, subscribeOrgWards, createWard, updateWardBeds, myWardCaps } from './wardService.js'

// Bed capacity cannot drop below the patients already holding a bed.
export async function validateWardBedsChange(orgId, wardId, newTotal) {
  const wards = await listOrgWards(orgId)
  const w = wards.find((x) => x.id === wardId)
  if (!w) return 'Ward not found.'
  const admissions = await listOrgAdmissions(orgId)
  return validateWardCapacity(newTotal, admissions, w.name)
}
