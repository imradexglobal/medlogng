// Consultations / encounters data layer (direct Firestore, Spark plan: no backend).
// Every encounter is linked to a patient and optionally to an appointment.
// Workflow: Arrival → Vitals → Consultation → Diagnosis → Plan → Close
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { getPatient, createPatientDoc } from './patientService.js'
import { can } from '../features/admin/roles.js'
import { ENCOUNTER_STATUS_FLOW, furtherStatus, stageForTrigger, ENCOUNTER_STATUS_FLOW_META } from '../features/encounters/domain.js'
import { logAudit } from './adminService.js'

const ENCOUNTERS = 'encounters'

export const ENCOUNTER_TYPES = ['General Outpatient Department (GOPD) review', 'Antenatal', 'Emergency', 'Follow-up']

// The workflow order and the status clamp live in features/encounters/domain.js
// (pure, no Firebase) so the smoke test can exercise the real thing. Re-exported
// here because this module is what the views import.
export { ENCOUNTER_STATUS_FLOW, furtherStatus, ENCOUNTER_STATUS_FLOW_META }

// ---- capability check --------------------------------------------------------
export function myEncounterCaps() {
  const me = myActiveMembership()
  const canEdit = can(me, 'encounter.edit')
  return {
    membership: me,
    canCreate: can(me, 'encounter.create'),
    canEdit,
    // Narrow bump of `status` alone (nurse triage) — held by doctors too,
    // since they hold `encounter.edit`.
    canBumpStatus: canEdit || can(me, 'encounter.status.advance'),
    canClose: canEdit || can(me, 'encounter.close'),
  }
}

// ---- model shape -----------------------------------------------------------
function toEncounterRow(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    appointmentId: r.appointment_id || '',
    status: r.status || 'arrived',
    chiefComplaint: r.chief_complaint || '',
    type: r.type || '',
    clinician: r.clinician || '',
    vitals: r.vitals || {},
    diagnosis: r.diagnosis || '',
    treatmentPlan: r.treatment_plan || '',
    prescription: r.prescription || {},
    labOrders: r.lab_orders || [],
    createdAt: r.created_at ? (typeof r.created_at.toMillis === 'function' ? r.created_at.toMillis() : r.created_at) : 0,
    updatedAt: r.updated_at ? (typeof r.updated_at.toMillis === 'function' ? r.updated_at.toMillis() : r.updated_at) : 0,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
export async function listPatientEncounters(pid) {
  const snap = await getDocs(query(collection(db, ENCOUNTERS), where('patient_id', '==', pid)))
  const rows = snap.docs.map((d) => toEncounterRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

// ---- open-encounter duplicate check ---------------------------------------
// An encounter is "open" when its status is anything other than `closed`
// (case-insensitive, so both `closed` and `Closed` count as closed; every
// other status — `arrived`, `in-consultation`, `Open`, … — counts as open).
export function isEncounterOpenStatus(status) {
  return String(status || '').trim().toLowerCase() !== 'closed'
}

export function isOpenEncounter(row) {
  if (!row) return false
  const status = row.status ?? row.raw?.status
  return isEncounterOpenStatus(status)
}

// Returns the patient's open encounter in this hospital (most recent first),
// or null when the patient has no open encounter. Scoped to `orgId` when the
// doc carries `organization_id` so legacy rows without one still match.
export async function findOpenEncounterForPatient(pid, orgId = '') {
  if (!pid) return null
  const rows = await listPatientEncounters(pid)
  const open = rows.filter((r) => {
    if (!isOpenEncounter(r)) return false
    const rowOrg = r.raw?.organization_id || ''
    if (orgId && rowOrg && rowOrg !== orgId) return false
    return true
  })
  return open.length ? open[0] : null
}

function formatEncounterWhen(row) {
  const ts = row?.createdAt || 0
  if (!ts) return 'date unknown'
  try {
    return new Date(ts).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return 'date unknown'
  }
}

// Friendly rejection used by every "start encounter" entry point.
export function openEncounterExistsError(existing) {
  const ref = existing?.id ? ' (' + String(existing.id).slice(0, 8) + '…' : ''
  const status = existing?.status ? ', ' + existing.status : ''
  const when = existing ? ', opened ' + formatEncounterWhen(existing) : ''
  return new Error(
    'This patient already has an open encounter' + ref + status + when +
    '). Close it before opening a new one.'
  )
}

// List all encounters for the active organization
export async function listOrgEncounters(orgId) {
  const snap = await getDocs(query(collection(db, ENCOUNTERS), where('organization_id', '==', orgId), limit(200)))
  const rows = snap.docs.map((d) => toEncounterRow({ ...d.data(), id: d.id }))
  rows.sort((a, b) => b.createdAt - a.createdAt)
  return rows
}

// Get single encounter
export async function getEncounter(eid) {
  const snap = await getDoc(doc(db, ENCOUNTERS, eid))
  if (!snap.exists()) return null
  return toEncounterRow({ ...snap.data(), id: snap.id })
}

// ---- create ---------------------------------------------------------------
export async function createEncounter(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myEncounterCaps()
  if (!caps.canCreate) {
    throw new Error('Your role cannot create encounters (missing "encounter.create" capability). Ask an administrator.')
  }

  const pid = input.patient_id
  if (!pid) throw new Error('Patient is required.')

  // Verify patient exists globally (patients are not org-owned)
  const patient = await getPatient(pid)
  if (!patient) throw new Error('Patient not found.')

  // Duplicate guard: one open encounter per patient per hospital. The caller
  // must close the existing encounter before a new one can be opened.
  // (Client-side only — rules stay authoritative; a race between two devices
  // can still create two rows, which the queue surfaces for manual close.)
  try {
    const existing = await findOpenEncounterForPatient(pid, activeOrg)
    if (existing) throw openEncounterExistsError(existing)
  } catch (e) {
    if (/already has an open encounter/i.test(e?.message || '')) throw e
    console.warn('[encounters] open-encounter check skipped:', e?.message)
  }

  const encounterId = doc(collection(db, ENCOUNTERS)).id
  const now = serverTimestamp()
  const encounter = {
    patient_id: pid,
    patient_name: input.patient_name || patient.name || '',
    organization_id: activeOrg,
    appointment_id: input.appointment_id || '',
    status: input.status || 'arrived',
    type: input.type || '',
    clinician: input.clinician || '',
    chief_complaint: input.chief_complaint || '',
    vitals: input.vitals || {},
    diagnosis: input.diagnosis || '',
    treatment_plan: input.treatment_plan || '',
    prescription: input.prescription || {},
    lab_orders: input.lab_orders || [],
    created_by: user?.uid || null,
    created_by_name: user?.email || '',
    created_at: now,
    updated_at: now,
  }

  await setDoc(doc(db, ENCOUNTERS, encounterId), encounter)

  try {
    await logAudit({ action: 'encounter.created', organizationId: activeOrg, patientId: pid, details: 'Encounter ' + encounterId + ' for ' + input.patient_name })
  } catch (e) {
    console.warn('[encounters] audit append failed:', e?.message)
  }
  return { id: encounterId, ...encounter }
}

// Fail fast with a friendly message when the caller cannot pass the rules
// (`encounters` update requires `encounter.edit`). Without this, Firestore
// answers with a raw "Missing or insufficient permissions."
function requireEncounterEdit() {
  if (!can(myActiveMembership(), 'encounter.edit')) {
    throw new Error('Your role cannot update encounters (missing "encounter.edit" capability). Ask an administrator to re-save your role.')
  }
}

// ---- status update --------------------------------------------------------
export async function updateEncounterStatus(id, status) {
  if (!ENCOUNTER_STATUS_FLOW.includes(status)) throw new Error('Invalid encounter status: ' + status)
  requireEncounterEdit()

  await updateDoc(doc(db, ENCOUNTERS, id), {
    status,
    updated_at: serverTimestamp(),
  })

  try {
    const enc = await getEncounter(id)
    await logAudit({
      action: 'encounter.' + status,
      organizationId: enc?.raw?.organization_id || '',
      patientId: enc?.patientId || '',
      details: 'Encounter ' + id + ' status updated to ' + status,
    })
  } catch (e) {
    console.warn('[encounters] audit append failed:', e?.message)
  }
  return true
}

// Moves the encounter to whatever stage `trigger` proves, unless it is already
// at or past it. Writes only on a real move, so no redundant doc write and no
// duplicate audit row. Best-effort: a failed status bump must not undo the
// clinical action the caller just saved, so callers wrap this in try/catch.
async function advanceTo(id, current, trigger) {
  const target = stageForTrigger(trigger)
  if (!target) return false
  const next = furtherStatus(current, target)
  if (next === current) return false
  try {
    await updateEncounterStatus(id, next)
    return true
  } catch (e) {
    console.warn('[encounters] auto-advance to ' + next + ' skipped:', e?.message)
    return false
  }
}

// ---- add diagnosis --------------------------------------------------------
// Writes the diagnosis on the encounter AND mirrors it into the patient's
// `diagnoses` collection (the same collection PatientDetail reads), so there
// is one clinical record, not two. The mirror is best-effort: if the caller
// lacks `diagnosis.create`, the encounter update still stands and a warning
// is logged instead of failing the whole action.
export async function addDiagnosis(encounterId, diagnosis) {
  requireEncounterEdit()
  const encRef = doc(db, ENCOUNTERS, encounterId)
  const encSnap = await getDoc(encRef)
  const existingList = encSnap.exists() ? (encSnap.data().diagnoses || []) : []
  const currentStatus = encSnap.exists() ? (encSnap.data().status || '') : ''
  await updateDoc(encRef, {
    diagnosis: diagnosis,
    diagnoses: [...existingList, { condition: diagnosis, added_at: Date.now() }],
    updated_at: serverTimestamp(),
  })
  // A recorded diagnosis means the assessment is done — move the workflow on.
  await advanceTo(encounterId, currentStatus, 'diagnosis')
  try {
    const enc = await getEncounter(encounterId)
    if (enc && enc.patientId) {
      await createPatientDoc('diagnoses', enc.patientId, {
        condition: String(diagnosis), status: 'Active', encounter_id: encounterId,
      }, 'diagnosis.create')
    }
  } catch (e) {
    console.warn('[encounters] diagnoses mirror skipped:', e?.message)
  }
  return true
}

// ---- update note -----------------------------------------------------------
export async function updateEncounterNote(encounterId, note) {
  requireEncounterEdit()
  // The current status is needed to know whether the note actually moves the
  // encounter into consultation.
  const encSnap = await getDoc(doc(db, ENCOUNTERS, encounterId))
  const currentStatus = encSnap.exists() ? (encSnap.data().status || '') : ''
  await updateDoc(doc(db, ENCOUNTERS, encounterId), {
    chief_complaint: note || '',
    updated_at: serverTimestamp(),
  })
  await advanceTo(encounterId, currentStatus, 'note')
  return true
}

// ---- record vitals ---------------------------------------------------------
// Always mirrors to the patient's `vitals` collection (the PatientDetail + unified
// timeline source) using `vitals.create`, so nurses can record vitals even though
// they cannot edit the encounter. The mirror is the nurse's source of truth; the
// encounter doc itself is touched only as far as the caller is allowed:
//   - `encounter.edit` (doctor/admin)       → write vitals block AND advance the
//     workflow (`arrived` → `vitals-taken`), so the queue reflects the triage.
//   - `encounter.status.advance` (nurse)     → advance `status` only. This is the
//     one narrow write a nurse may make on the encounter; it is matched by a
//     field-restricted rule in firestore.rules, so no other field can change.
// A nurse without either capability leaves the encounter untouched.
export async function recordEncounterVitals(encounterId, v) {
  const enc = await getEncounter(encounterId)
  if (!enc) throw new Error('Encounter not found.')

  if (enc.patientId) {
    try {
      await createPatientDoc('vitals', enc.patientId, {
        bp_systolic: v.bp_systolic ?? null, bp_diastolic: v.bp_diastolic ?? null,
        pulse: v.pulse ?? null, temp_c: v.temp_c ?? null, spo2: v.spo2 ?? null,
        note: v.note || '', encounter_id: encounterId,
      }, 'vitals.create')
    } catch (e) {
      console.warn('[encounters] vitals mirror skipped:', e?.message)
    }
  }

  const me = myActiveMembership()
  const canEditEncounter = can(me, 'encounter.edit')
  const canAdvanceStatus = canEditEncounter || can(me, 'encounter.status.advance')
  if (canAdvanceStatus && furtherStatus(enc.status, 'vitals-taken') !== enc.status) {
    // Write the vitals block only for those who may edit the encounter as a
    // whole; a status-advancer must not rewrite vitals on someone else's behalf.
    await updateDoc(doc(db, ENCOUNTERS, encounterId), {
      ...(canEditEncounter
        ? {
          vitals: {
            BP: (v.bp_systolic != null && v.bp_diastolic != null) ? v.bp_systolic + '/' + v.bp_diastolic : '',
            Pulse: v.pulse ?? '', Temp: v.temp_c ?? '', SpO2: v.spo2 ?? '',
          },
        }
        : {}),
      status: furtherStatus(enc.status, 'vitals-taken'),
      updated_at: serverTimestamp(),
    })
  }
  return true
}

// ---- add treatment plan ---------------------------------------------------
export async function addTreatmentPlan(encounterId, plan) {
  requireEncounterEdit()
  const encSnap = await getDoc(doc(db, ENCOUNTERS, encounterId))
  const currentStatus = encSnap.exists() ? (encSnap.data().status || '') : ''
  await updateDoc(doc(db, ENCOUNTERS, encounterId), {
    treatment_plan: plan,
    updated_at: serverTimestamp(),
  })
  await advanceTo(encounterId, currentStatus, 'plan')
  return true
}

// ---- add prescription ---------------------------------------------------
// Mirrors into `medication_requests` (PatientDetail + pharmacy queue source)
// best-effort, same pattern as addDiagnosis. No dispense ticket is created
// here: dispensing requires `prescription.dispense` (pharmacist), which the
// prescriber does not hold — the pharmacist dispenses from the request.
export async function addPrescription(encounterId, prescription) {
  requireEncounterEdit()
  const encSnap = await getDoc(doc(db, ENCOUNTERS, encounterId))
  const currentStatus = encSnap.exists() ? (encSnap.data().status || '') : ''
  await updateDoc(doc(db, ENCOUNTERS, encounterId), {
    prescription: prescription,
    updated_at: serverTimestamp(),
  })
  // Treatment prescribed means the plan is being set.
  await advanceTo(encounterId, currentStatus, 'prescription')
  try {
    const enc = await getEncounter(encounterId)
    if (enc && enc.patientId) {
      await createPatientDoc('medication_requests', enc.patientId, {
        medicine: prescription.medicine || prescription.name || 'Prescription',
        dosage: prescription.dosage || '',
        quantity: prescription.qty || prescription.quantity || '',
        instructions: prescription.instructions || '',
        status: 'Requested',
        encounter_id: encounterId,
      }, 'prescription.create')
    }
  } catch (e) {
    console.warn('[encounters] prescription mirror skipped:', e?.message)
  }
  return true
}

// ---- add lab order --------------------------------------------------------
export async function addLabOrder(encounterId, labOrder) {
  requireEncounterEdit()
  const encounterRef = doc(db, ENCOUNTERS, encounterId)
  const encSnap = await getDoc(encounterRef)
  const existing = encSnap.exists() ? (encSnap.data().lab_orders || []) : []
  const currentStatus = encSnap.exists() ? (encSnap.data().status || '') : ''
  const newLabOrder = { ...labOrder, id: labOrder.lab_order_id || ('lab_' + Date.now().toString(36)), ordered_at: Date.now() }
  await updateDoc(encounterRef, {
    lab_orders: [...existing, newLabOrder],
    updated_at: serverTimestamp(),
  })
  // Investigations ordered are part of the Plan (the P of SOAP).
  await advanceTo(encounterId, currentStatus, 'lab_order')
  return true
}