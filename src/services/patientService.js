// Patient registry data layer (direct Firestore, Spark plan: no backend).
//
// Model (matches firestore.rules exactly):
//   patients/{pid}                     — canonical, global registry doc.
//                                        create: surname + status 'active'
//                                        update: any signed-in user
//                                        delete: never
//   organization_patients/{orgId}_{pid} — org-scoped row used for listing.
//                                        create: patient.create capability
//                                        update: patient.demographics.update
// Both docs are written in one batch so they can never drift apart.
import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, runTransaction, serverTimestamp, limit,
  orderBy,
} from '../firebase.js'
import { runChunk } from './pagination.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import {
  normalizePhone, phoneKey, parseSearchTerm, matchesPatient,
} from '../features/patients/search.js'
import { logAudit } from './adminService.js'
import { currentStaffName } from '../lib/staffName.js'

const ORG_PATIENTS = 'organization_patients'

// ---- capabilities -----------------------------------------------------------
export function myPatientCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canCreate: can(me, 'patient.create'),
    canUpdate: can(me, 'patient.demographics.update'),
  }
}

// ---- phone handling ---------------------------------------------------------
// The rules live in features/patients/search.js so they are unit-testable
// without Firebase; re-exported here because every view already imports them
// from this module.
export { normalizePhone, phoneKey, formatPhone, phoneSearchDigits, phoneMatches, parseSearchTerm, patientHaystack, matchesPatient, MIN_PHONE_DIGITS } from '../features/patients/search.js'

// ---- validation -------------------------------------------------------------
// Only surname, given names and phone are compulsory (product decision).
export function validatePatient(v) {
  if (!v.surname || v.surname.trim().length < 2) return 'Surname is required.'
  if (!v.given_names || v.given_names.trim().length < 1) return 'Given name(s) required.'
  if (!normalizePhone(v.phone)) return 'Enter a valid Nigerian phone number (e.g. 0803 123 4567).'
  if (v.dob && !/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) return 'Date of birth must be a real date.'
  if (!v.next_of_kin_first_name || v.next_of_kin_first_name.trim().length < 1) return 'Next of kin first name is required.'
  if (!v.next_of_kin_last_name || v.next_of_kin_last_name.trim().length < 1) return 'Next of kin last name is required.'
  if (!normalizePhone(v.next_of_kin_phone)) return 'Enter a valid Nigerian phone number for next of kin (e.g. 0803 123 4567).'
  if (!v.next_of_kin_address || v.next_of_kin_address.trim().length < 5) return 'Next of kin address is required.'
  return null
}

// ---- row shaping ------------------------------------------------------------
function tsMillis(t) {
  return t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : 0)
}

function ageFrom(dob) {
  if (!dob) return ''
  const d = new Date(dob)
  if (isNaN(d.getTime())) return ''
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000)))
}

function fullName(r) {
  return [r.given_names, r.surname].filter(Boolean).join(' ').trim()
}

function nextOfKinName(r) {
  return [r.next_of_kin_first_name, r.next_of_kin_last_name].filter(Boolean).join(' ').trim()
}

function allergyArrayToString(arr) {
  if (!arr) return 'None known'
  if (Array.isArray(arr)) {
    return arr.length > 0 ? arr.join(', ') : 'None known'
  }
  return String(arr || '').trim() || 'None known'
}

export function toPatientRow(r) {
  return {
    pid: r.patient_id,
    id: r.patient_id,
    mrn: r.mrn || '',
    name: fullName(r),
    surname: r.surname || '',
    given_names: r.given_names || '',
    sex: r.sex || '',
    dob: r.dob || '',
    age: ageFrom(r.dob),
    phone: r.phone || '',
    phone_key: r.phone_key || '',
    payer: r.payer || 'Self-pay',
    address: r.address || '',
    blood_group: r.blood_group || '',
    genotype: r.genotype || '',
    allergy: Array.isArray(r.allergy) ? r.allergy : (r.allergy || []),
    allergy_display: allergyArrayToString(r.allergy),
    occupation: r.occupation || '',
    next_of_kin_first_name: r.next_of_kin_first_name || '',
    next_of_kin_last_name: r.next_of_kin_last_name || '',
    next_of_kin_name: nextOfKinName(r),
    next_of_kin_phone: r.next_of_kin_phone || '',
    next_of_kin_phone_key: r.next_of_kin_phone_key || '',
    next_of_kin_address: r.next_of_kin_address || '',
    status: r.status === 'active' ? 'Active' : (r.status || 'Active'),
    registered: tsMillis(r.created_at),
    raw: r,
  }
}

// ---- reads ------------------------------------------------------------------
// Next chunk of the registry list, cursor-walked for infinite scroll. Orders by
// patient_id (always present, stable) so the walk never skips/duplicates rows.
// Needs index:
// organization_patients: organization_id ASC + patient_id ASC.
export const PATIENTS_PAGE = 25

export async function listOrgPatientsPage(orgId, { pageSize = PATIENTS_PAGE, cursor = null } = {}) {
  const base = query(
    collection(db, ORG_PATIENTS),
    where('organization_id', '==', orgId),
    orderBy('patient_id', 'asc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  const rows = docs
    .map((d) => {
      const data = d.data() || {}
      const pid = data.patient_id ||
        (d.id.startsWith(orgId + '_') ? d.id.slice(orgId.length + 1) : d.id)
      return toPatientRow({ ...data, patient_id: pid })
    })
    .filter((r) => !!r.pid)
  // Deliberately keep the Firestore order (organization_id + patient_id).
  // Re-sorting by name after the cursor walk would skip or duplicate rows
  // across pages as new patients are inserted between chunks.
  return { rows, hasMore, cursor: next }
}


// Legacy full fetch — kept for dropdowns, duplicate checks and cached search.
// DO NOT use for the registry table (use listOrgPatientsPage instead).
export async function listOrgPatients(orgId) {
  const snap = await getDocs(query(collection(db, ORG_PATIENTS), where('organization_id', '==', orgId)))
  const rows = snap.docs
    .map((d) => {
      const data = d.data() || {}
      // Doc id is `{orgId}_{pid}` — recover the pid if the field is missing.
      const pid = data.patient_id ||
        (d.id.startsWith(orgId + '_') ? d.id.slice(orgId.length + 1) : d.id)
      return toPatientRow({ ...data, patient_id: pid })
    })
    .filter((r) => !!r.pid)
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// Complete list for pickers (lab order, billing invoice) that must be able to
// find ANY registered patient by name, MRN or mobile. The page API returns one
// bounded, patient_id-ordered chunk, so a capped read silently hides everyone
// past that chunk from the picker. Walks the cursor to exhaustion.
export async function listOrgPatientsAll(orgId, { chunkSize = 300, max = 5000 } = {}) {
  const all = []
  let cursor = null
  for (;;) {
    const pg = await listOrgPatientsPage(orgId, { pageSize: chunkSize, cursor })
    all.push(...pg.rows)
    if (!pg.hasMore || !pg.rows.length || all.length >= max) break
    cursor = pg.cursor
  }
  return all
}

export async function getPatient(pid) {
  const snap = await getDoc(doc(db, 'patients', pid))
  if (!snap.exists()) return null
  const r = { ...snap.data(), patient_id: snap.id }
  return toPatientRow(r)
}

// ---- on-demand registry resolution ------------------------------------------
// Queues and bed boards join names from a BOUNDED index (one page of
// organization_patients), so a patient past that page — or an encounter/admission
// whose snapshot lost `patient_name` — rendered as "Unknown patient". This pulls
// the canonical registry doc (org link as fallback) straight into the caller's
// index instead.
export async function getPatientForOrg(orgId, pid) {
  if (!pid) return null
  try {
    const row = await getPatient(pid)
    if (row) return row
  } catch {
    // Canonical read failed (offline / never written) — try the org link below.
  }
  if (!orgId) return null
  try {
    const snap = await getDoc(doc(db, ORG_PATIENTS, orgId + '_' + pid))
    if (!snap.exists()) return null
    const data = snap.data() || {}
    const id = data.patient_id ||
      (snap.id.startsWith(orgId + '_') ? snap.id.slice(orgId.length + 1) : snap.id)
    return toPatientRow({ ...data, patient_id: id })
  } catch {
    return null
  }
}

// One filler per view instance. It tracks pids in flight and pids known to be
// absent so a render storm can never queue duplicate reads, and it only reports
// `true` when a row actually landed — a failed fetch must not trigger the
// re-render that would retry it forever. Callers clear `reset()` on reload.
export function createPatientIndexFiller(orgId) {
  const pending = new Set()
  const missing = new Set()
  return {
    async fill(index, pids = []) {
      const need = [...new Set(pids)]
        .filter((id) => id && !index.has(id) && !pending.has(id) && !missing.has(id))
      if (!need.length) return false
      need.forEach((id) => pending.add(id))
      let added = 0
      try {
        await Promise.all(need.map(async (id) => {
          const row = await getPatientForOrg(orgId, id)
          if (row) { index.set(id, row); added++ }
          else missing.add(id)
        }))
      } finally {
        need.forEach((id) => pending.delete(id))
      }
      return added > 0
    },
    reset() { missing.clear() },
  }
}

export async function listPatientEncounters(pid, { limitN = 50 } = {}) {
  const snap = await getDocs(query(collection(db, 'encounters'), where('patient_id', '==', pid), limit(limitN)))
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  rows.sort((a, b) => tsMillis(b.created_at) - tsMillis(a.created_at))
  return rows
}

// ---- open-encounter duplicate check ---------------------------------------
// Mirrors consultationService (kept local to avoid a circular import:
// consultationService imports listOrgPatients/createPatientDoc from here).
// Open = any status other than `closed` (case-insensitive), covering both
// shapes in this collection (`arrived`… from Consultations, `Open` from
// Patient 360).
export function isEncounterOpenStatus(status) {
  return String(status || '').trim().toLowerCase() !== 'closed'
}

export async function findOpenEncounterForPatient(pid, orgId = '') {
  if (!pid) return null
  let rows = []
  try {
    rows = await listPatientEncounters(pid)
  } catch (e) {
    console.warn('[patients] open-encounter check read failed:', e?.message)
    return null
  }
  const open = rows.filter((r) => {
    if (!isEncounterOpenStatus(r?.status)) return false
    const rowOrg = r?.organization_id || ''
    if (orgId && rowOrg && rowOrg !== orgId) return false
    return true
  })
  return open.length ? open[0] : null
}

// Pre-check whether a patient has any clinical trail in this hospital that
// would block deletion: encounters, admissions, invoices. Returns { deletable: boolean, trail: string[] }.
export async function patientHasClinicalTrail(pid, orgId) {
  if (!pid || !orgId) return { deletable: true, trail: [] }
  const trail = []
  try {
    const encSnap = await getDocs(query(
      collection(db, 'encounters'),
      where('patient_id', '==', pid),
      where('organization_id', '==', orgId),
      limit(1),
    ))
    if (!encSnap.empty) trail.push(encSnap.size + ' encounter(s)')
  } catch { /* ignore read errors — treat as deletable */ }
  try {
    const admSnap = await getDocs(query(
      collection(db, 'admissions'),
      where('patient_id', '==', pid),
      where('organization_id', '==', orgId),
      limit(1),
    ))
    if (!admSnap.empty) trail.push(admSnap.size + ' admission(s)')
  } catch { /* ignore */ }
  try {
    const invSnap = await getDocs(query(
      collection(db, 'invoices'),
      where('patient_id', '==', pid),
      where('organization_id', '==', orgId),
      limit(1),
    ))
    if (!invSnap.empty) trail.push(invSnap.size + ' invoice(s)')
  } catch { /* ignore */ }
  return { deletable: trail.length === 0, trail }
}

export function openEncounterExistsError(existing) {
  let when = 'date unknown'
  try {
    const m = tsMillis(existing?.created_at)
    if (m) when = new Date(m).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })
  } catch { /* keep fallback */ }
  const ref = existing?.id ? ' (' + String(existing.id).slice(0, 8) + '…' : ''
  const status = existing?.status ? ', ' + existing.status : ''
  return new Error(
    'This patient already has an open encounter' + ref + status + ', opened ' + when +
    '). Close it before opening a new one.'
  )
}

// Generic child read: every clinical collection stores patient_id, so one
// equality filter (no composite index needed) fetches a patient's rows.
export async function listPatientDocs(coll, pid, { limitN = 50 } = {}) {
  try {
    const snap = await getDocs(query(collection(db, coll), where('patient_id', '==', pid), limit(limitN)))
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    rows.sort((a, b) => tsMillis(b.created_at) - tsMillis(a.created_at))
    return { rows, error: null }
  } catch (e) {
    console.warn('[patients] load failed:', coll, e?.message)
    return { rows: [], error: friendlyPatientError(e) }
  }
}

// Generic child create, capability-gated client-side (Rules stay authoritative).
export async function createPatientDoc(coll, pid, data, cap) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  if (cap && !can(myActiveMembership(), cap)) {
    throw new Error('Your role cannot do this (missing "' + cap + '" capability). Ask an administrator.')
  }

  const encounterData = {
    ...data,
    patient_id: pid,
    organization_id: activeOrg,
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  }

  // Duplicate guard: one open encounter per patient per hospital. The check and
  // the write run inside a single Firestore transaction so two concurrent calls
  // can never both pass the guard and create two open encounters.
  if (coll === 'encounters') {
    return await runTransaction(db, async (transaction) => {
      const encQuery = query(
        collection(db, 'encounters'),
        where('patient_id', '==', pid),
      )
      const snap = await transaction.get(encQuery)
      const open = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => {
          if (!isEncounterOpenStatus(r?.status)) return false
          const rowOrg = r?.organization_id || ''
          if (activeOrg && rowOrg && rowOrg !== activeOrg) return false
          return true
        })
      if (open.length) throw openEncounterExistsError(open[0])
      const ref = doc(collection(db, coll))
      transaction.set(ref, encounterData)
      return ref.id
    })
  }

  const ref = doc(collection(db, coll))
  await setDoc(ref, encounterData)
  try {
    await logAudit({ action: 'patient.' + coll + '.created', organizationId: activeOrg, patientId: pid, details: String(data.condition || data.medicine || data.encounter_type || coll) })
  } catch (e) {
    console.warn('[patients] audit append failed:', e?.message)
  }
  return ref.id
}

// Duplicate screen by phone, surname & given_names.
// Checks local org patients first (offline), then global patients (online, all hospitals).
// Returns match info with source ('local' or 'cloud') and hospital name, or null if no match.
async function findDuplicate(orgId, surname, given_names, key, excludePid = '') {
  // Step 1: Check local org patients (offline first)
  let localRows = []
  try {
    localRows = await listOrgPatients(orgId)
  } catch {
    return null
  }

  // Check local name+phone match (surname + given_names + phone_key)
  const localNameMatch = localRows.find(
    (r) =>
      r.surname.trim().toLowerCase() ===
        (surname || '').trim().toLowerCase() &&
      r.given_names.trim().toLowerCase() ===
        (given_names || '').trim().toLowerCase() &&
      r.phone_key === key &&
      r.pid !== excludePid
  )

  // Check local phone-only match
  const localPhoneMatch = localRows.find(
    (r) => r.phone_key === key && r.pid !== excludePid
  )

  // If we have a local match, return it immediately (offline-first)
  if (localNameMatch) {
    return {
      type: 'name_phone',
      existing: localNameMatch,
      source: 'local',
      hospital: orgId,
    }
  }
  if (localPhoneMatch) {
    return {
      type: 'phone',
      existing: localPhoneMatch,
      source: 'local',
      hospital: orgId,
    }
  }

  // Step 2: Check global patients online (all hospitals except current to avoid duplicate returns)
  // Query the global patients collection for active patients. We intentionally do
  // NOT use `organization_id != orgId` here: Firestore's `!=` excludes documents
  // where the field is missing, and paired with `limit(20)` it silently drops
  // matches past the first page. Fetch a larger page and exclude the current
  // hospital in memory instead.
  const cloudMatches = []
  try {
    const patientsCol = collection(db, 'patients')
    const q = query(
      patientsCol,
      where('status', '==', 'active'),
      limit(100),
    )
    const snap = await getDocs(q)
    const allOther = snap.docs.map((d) => {
      const data = d.data() || {}
      const pid = d.id
      return toPatientRow({ ...data, patient_id: pid })
    }).filter((r) => r.organization_id !== orgId && r.pid)

    // Filter by name + phone similarity
    const namePhoneInCloud = allOther.find(
      (r) =>
        r.surname.trim().toLowerCase() ===
          (surname || '').trim().toLowerCase() &&
        r.given_names.trim().toLowerCase() ===
          (given_names || '').trim().toLowerCase() &&
        r.phone_key === key
    )

    const phoneInCloud = allOther.find(
      (r) => r.phone_key === key
    )

    // Build cloud matches array with hospital info
    if (namePhoneInCloud) {
      cloudMatches.push({
        type: 'name_phone',
        existing: namePhoneInCloud,
        source: 'cloud',
        hospital: namePhoneInCloud.organization_id,
      })
    }
    if (phoneInCloud && !cloudMatches.some((m) => m.existing.pid === phoneInCloud.pid)) {
      cloudMatches.push({
        type: 'phone',
        existing: phoneInCloud,
        source: 'cloud',
        hospital: phoneInCloud.organization_id,
      })
    }
  } catch (e) {
    console.warn('[patients] global duplicate check failed:', e?.message)
  }

  // Prefer local match; if none, return best cloud match
  if (localNameMatch) {
    return {
      type: 'name_phone',
      existing: localNameMatch,
      source: 'local',
      hospital: orgId,
    }
  }
  if (localPhoneMatch) {
    return {
      type: 'phone',
      existing: localPhoneMatch,
      source: 'local',
      hospital: orgId,
    }
  }

  // Return best cloud match if exists
  if (cloudMatches.length > 0) {
    // Sort: name_phone priority over phone
    cloudMatches.sort((a, b) => (a.type === 'name_phone' ? -1 : 1))
    return cloudMatches[0]
  }

  return null
}

// Returns warning info for display; does NOT throw.
// caller can decide whether to proceed or not.
function duplicateWarning(dupInfo) {
  const { type, existing, source, hospital } = dupInfo
  const name = existing.name || existing.given_names + ' ' + existing.surname
  const hospitalName = hospital || '(hospital ' + (source === 'local' ? existing.organization_id : 'unknown') + ')'
  return {
    type,
    message:
      type === 'name_phone'
        ? `A patient named ${name} from ${hospitalName} already has the same surname, given names and mobile number. Proceed anyway?`
        : `This mobile number already belongs to ${name} from ${hospitalName}. Proceed anyway?`,
    existing,
  }
}

// ---- create -----------------------------------------------------------------
export async function registerPatient(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected — pick your hospital in Administration first.')
  const caps = myPatientCaps()
  if (!caps.canCreate) {
    throw new Error('Your role cannot register patients (missing "patient.create" capability). Ask an administrator to change your role.')
  }
  const invalid = validatePatient(input)
  if (invalid) throw new Error(invalid)

  const key = phoneKey(input.phone)
  const kinKey = phoneKey(input.next_of_kin_phone)
  const force = input.force === true
  if (!force) {
    const dupInfo = await findDuplicate(activeOrg, input.surname, input.given_names, key)
    if (dupInfo) {
      const warning = duplicateWarning(dupInfo)
      // Return warning info so the UI can show it and let the user decide.
      // The caller (UI) can choose to proceed or abort.
      return { warning, existing: dupInfo.existing }
    }
  }

  const pid = doc(collection(db, 'patients')).id
  const mrn = 'IMR-' + pid.slice(0, 6).toUpperCase()
  const now = serverTimestamp()
  const base = {
    surname: String(input.surname).trim(),
    search_surname_norm: String(input.surname).trim().toLowerCase(),
    given_names: String(input.given_names).trim(),
    full_name: fullName({ surname: input.surname, given_names: input.given_names }),
    phone: '+234' + key,
    phone_key: key,
    sex: input.sex || '',
    dob: input.dob || '',
    address: String(input.address || '').trim(),
    blood_group: input.blood_group || '',
    genotype: input.genotype || '',
    payer: input.payer || 'Self-pay',
    allergy: Array.isArray(input.allergy) ? input.allergy : (String(input.allergy || '').trim() || 'None known'),
    occupation: String(input.occupation || '').trim(),
    next_of_kin_first_name: String(input.next_of_kin_first_name || '').trim(),
    next_of_kin_last_name: String(input.next_of_kin_last_name || '').trim(),
    next_of_kin_phone: kinKey ? '+234' + kinKey : '',
    next_of_kin_phone_key: kinKey,
    next_of_kin_address: String(input.next_of_kin_address || '').trim(),
    status: 'active',
  }
  const batch = writeBatch(db)
  batch.set(doc(db, 'patients', pid), {
    ...base,
    mrn,
    organization_id: activeOrg,
    created_by: user?.uid || null,
    created_at: now,
    updated_at: now,
  })
  batch.set(doc(db, ORG_PATIENTS, activeOrg + '_' + pid), {
    ...base,
    mrn,
    patient_id: pid,
    organization_id: activeOrg,
    created_by: user?.uid || null,
    created_at: now,
    updated_at: now,
  })
  await batch.commit()
  invalidateSearchCache()

  try {
    await logAudit({ action: 'patient.created', organizationId: activeOrg, patientId: pid, details: base.full_name + ' · ' + mrn })
  } catch (e) {
    console.warn('[patients] audit append failed:', e?.message)
  }
  return { pid, mrn, name: base.full_name }
}

// ---- update -----------------------------------------------------------------
export async function updatePatient(pid, input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myPatientCaps()
  if (!caps.canUpdate) {
    throw new Error('Your role cannot edit patient details (missing "patient.demographics.update" capability). Ask an administrator to change your role.')
  }
  const invalid = validatePatient(input)
  if (invalid) throw new Error(invalid)

  const key = phoneKey(input.phone)
  const kinKey = phoneKey(input.next_of_kin_phone)
  // `force` skips the duplicate check — same escape hatch as registerPatient,
  // used when the user confirms "this is a different person" in the duplicate
  // warning modal. Without it "Save anyway" silently re-warned forever.
  if (input.force !== true) {
    const dupInfo = await findDuplicate(activeOrg, input.surname, input.given_names, key, pid)
    if (dupInfo) {
      const warning = duplicateWarning(dupInfo)
      // Return warning info so the UI can show it and let the user decide.
      // The caller (UI) can choose to proceed or abort.
      return { warning, existing: dupInfo.existing }
    }
  }

  const patch = {
    surname: String(input.surname).trim(),
    search_surname_norm: String(input.surname).trim().toLowerCase(),
    given_names: String(input.given_names).trim(),
    full_name: fullName({ surname: input.surname, given_names: input.given_names }),
    phone: '+234' + key,
    phone_key: key,
    sex: input.sex || '',
    dob: input.dob || '',
    address: String(input.address || '').trim(),
    blood_group: input.blood_group || '',
    genotype: input.genotype || '',
    payer: input.payer || 'Self-pay',
    allergy: Array.isArray(input.allergy) ? input.allergy : (String(input.allergy || '').trim() || 'None known'),
    occupation: String(input.occupation || '').trim(),
    next_of_kin_first_name: String(input.next_of_kin_first_name || '').trim(),
    next_of_kin_last_name: String(input.next_of_kin_last_name || '').trim(),
    next_of_kin_phone: kinKey ? '+234' + kinKey : '',
    next_of_kin_phone_key: kinKey,
    next_of_kin_address: String(input.next_of_kin_address || '').trim(),
    updated_at: serverTimestamp(),
  }

  const now = serverTimestamp()
  const orgDocId = activeOrg + '_' + pid
  const orgRef = doc(db, ORG_PATIENTS, orgDocId)
  const patRef = doc(db, 'patients', pid)
  const [orgSnap, patSnap] = await Promise.all([getDoc(orgRef), getDoc(patRef)])
  if (!patSnap.exists()) throw new Error('This patient record no longer exists.')

  const batch = writeBatch(db)
  batch.update(patRef, patch)
  if (orgSnap.exists()) {
    batch.update(orgRef, patch)
  } else {
    // Org link missing (record written outside this hospital): recreate it so
    // the patient shows up in this hospital's list again.
    batch.set(orgRef, {
      ...patch,
      mrn: patSnap.data().mrn || '',
      patient_id: pid,
      organization_id: activeOrg,
      status: 'active',
      created_by: user?.uid || null,
      created_at: now,
    })
  }
  await batch.commit()
  invalidateSearchCache()

  try {
    await logAudit({ action: 'patient.updated', organizationId: activeOrg, patientId: pid, details: patch.full_name })
  } catch (e) {
    console.warn('[patients] audit append failed:', e?.message)
  }
  return true
}

// ---- errors -----------------------------------------------------------------
export function friendlyPatientError(e, fallback = 'Something went wrong. Please retry.') {
  const code = e?.code || ''
  if (code === 'permission-denied' || /permission|denied|allow/i.test(e?.message || '')) {
    return 'Not allowed — your role does not have this capability. Ask an administrator.'
  }
  if (code === 'failed-precondition' || /index/i.test(e?.message || '')) {
    return 'This query needs a Firestore index — open the browser console link to create it, then retry.'
  }
  if (code === 'unavailable' || /offline|network/i.test(e?.message || '')) {
    return 'You are offline — changes are saved on this device and will sync when you reconnect.'
  }
  return e?.message || fallback
}

// ---- search cache -----------------------------------------------------------
const searchCache = new Map()
const CLOUD_CACHE_TTL = 5 * 60 * 1000
const LOCAL_CACHE_TTL = 1 * 60 * 1000

function getCachedSearch(key, ttl) {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > ttl) {
    searchCache.delete(key)
    return null
  }
  return entry.value
}

function setCachedSearch(key, value) {
  searchCache.set(key, { value, timestamp: Date.now() })
}

export function invalidateSearchCache() {
  searchCache.clear()
}

// ---- global search -----------------------------------------------------------
// Search patients across all hospitals by name, patient ID, MRN or mobile number.
// 1. First returns matches from the current hospital (local data).
// 2. Then appends matches from other hospitals (cloud), filtering out the
//    current hospital to avoid duplicate returns.
// `query` is a free-text search box entry (string) or an already-parsed one
// from parseSearchTerm — the parsing is what tells a mobile number apart from
// a name, so callers must NOT split the term themselves.
// Returns { local: [...], cloud: [...] }
export async function searchPatientsGlobally(search) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) return { local: [], cloud: [] }

  const parsed = typeof search === 'object' && search !== null ? search : parseSearchTerm(search)
  if (!parsed || !parsed.term) return { local: [], cloud: [] }

  const localKey = 'local:' + activeOrg + ':' + parsed.term
  const cloudKey = 'cloud:' + parsed.term

  const cachedLocal = getCachedSearch(localKey, LOCAL_CACHE_TTL)
  const cachedCloud = getCachedSearch(cloudKey, CLOUD_CACHE_TTL)

  if (cachedLocal && cachedCloud) {
    return { local: cachedLocal, cloud: cachedCloud }
  }

  let localMatches = cachedLocal || []
  if (!cachedLocal) {
    const localRows = await listOrgPatients(activeOrg)
    localMatches = localRows.filter((r) => matchesPatient(r, parsed))
    localMatches.sort((a, b) => a.name.localeCompare(b.name))
    setCachedSearch(localKey, localMatches)
  }

  let cloudMatches = cachedCloud || []
  if (!cachedCloud) {
    try {
      const patientsCol = collection(db, 'patients')
      let q

      if (parsed.isPhone) {
        const digits = parsed.phoneDigits
        q = query(
          patientsCol,
          where('phone_key', '>=', digits),
          where('phone_key', '<', digits + '\uf8ff'),
          where('status', '==', 'active'),
          limit(20)
        )
      } else {
        const surnameTerm = (parsed.surname || '').toLowerCase()
        q = query(
          patientsCol,
          where('search_surname_norm', '>=', surnameTerm),
          where('search_surname_norm', '<', surnameTerm + '\uf8ff'),
          where('status', '==', 'active'),
          limit(20)
        )
      }

      const snap = await getDocs(q)
      cloudMatches = snap.docs
        .map((d) => {
          const data = d.data() || {}
          if (data.organization_id === activeOrg) return null
          return toPatientRow({ ...data, patient_id: d.id })
        })
        .filter(Boolean)
        .filter((r) => matchesPatient(r, parsed))
      cloudMatches.sort((a, b) => a.name.localeCompare(b.name))
      setCachedSearch(cloudKey, cloudMatches)
    } catch (e) {
      console.warn('[patients] global search cloud failed:', e?.message)
      cloudMatches = []
    }
  }

  return { local: localMatches, cloud: cloudMatches }
}

export async function getAllAllergiesFromDB(orgId) {
  try {
    const rows = await listOrgPatients(orgId || authStore.getState().activeOrg)
    const seen = new Set()
    const results = []
    for (const r of rows) {
      let arr = []
      if (Array.isArray(r.allergy)) arr = r.allergy
      else if (r.allergy && typeof r.allergy === 'string') {
        const s = r.allergy.trim()
        if (!s || s.toLowerCase() === 'none known') arr = []
        else arr = s.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      }
      for (const a of arr) {
        const key = a.toLowerCase()
        if (key && !seen.has(key)) {
          seen.add(key)
          results.push(a)
        }
      }
    }
    results.sort((a, b) => a.localeCompare(b))
    return results
  } catch (e) {
    console.warn('[patients] getAllAllergiesFromDB failed:', e?.message)
    return []
  }
}
