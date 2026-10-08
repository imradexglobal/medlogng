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
  db, collection, query, where, getDocs, getDoc, doc, setDoc, writeBatch, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'

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
// Accepts 0803…, 234803…, +234 803… → canonical '0XXXXXXXXXX' or '' if invalid.
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('234')) d = '0' + d.slice(3)
  else if (d.length === 10) d = '0' + d
  return /^0\d{10}$/.test(d) ? d : ''
}

export function phoneKey(raw) {
  const local = normalizePhone(raw)
  return local ? local.slice(1) : ''
}

export function formatPhone(phone, key) {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('234')) {
    return '+234 ' + d.slice(3, 6) + ' ' + d.slice(6, 9) + ' ' + d.slice(9)
  }
  if (key) return '+234 ' + String(key).replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3')
  return phone || '—'
}

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

export async function getPatient(pid) {
  const snap = await getDoc(doc(db, 'patients', pid))
  if (!snap.exists()) return null
  const r = { ...snap.data(), patient_id: snap.id }
  return toPatientRow(r)
}

export async function listPatientEncounters(pid) {
  const snap = await getDocs(query(collection(db, 'encounters'), where('patient_id', '==', pid)))
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
export async function listPatientDocs(coll, pid) {
  try {
    const snap = await getDocs(query(collection(db, coll), where('patient_id', '==', pid)))
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
  // Duplicate guard: one open encounter per patient per hospital. Rejects the
  // create so the caller must close the existing encounter first.
  if (coll === 'encounters') {
    const existing = await findOpenEncounterForPatient(pid, activeOrg)
    if (existing) throw openEncounterExistsError(existing)
  }
  const ref = doc(collection(db, coll))
  await setDoc(ref, {
    ...data,
    patient_id: pid,
    organization_id: activeOrg,
    created_by: user?.uid || null,
    created_by_name: user?.email || '',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  })
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
  // Query the global patients collection, filtering out the current hospital
  const cloudMatches = []
  try {
    const patientsCol = collection(db, 'patients')
    const q = query(
      patientsCol,
      where('organization_id', '!=', orgId), // exclude current hospital
      where('status', '==', 'active')
    )
    const snap = await getDocs(q)
    const allOther = snap.docs.map((d) => {
      const data = d.data() || {}
      const pid = d.id
      return toPatientRow({ ...data, patient_id: pid })
    })

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
  const dupInfo = await findDuplicate(activeOrg, input.surname, input.given_names, key, pid)
  if (dupInfo) {
    const warning = duplicateWarning(dupInfo)
    // Return warning info so the UI can show it and let the user decide.
    // The caller (UI) can choose to proceed or abort.
    return { warning, existing: dupInfo.existing }
  }

  const patch = {
    surname: String(input.surname).trim(),
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

// ---- global search -----------------------------------------------------------
// Search patients across all hospitals.
// 1. First returns matches from the current hospital (local data).
// 2. Then appends matches from other hospitals (cloud), filtering out the
//    current hospital to avoid duplicate returns.
// Returns { local: [...], cloud: [...] }
export async function searchPatientsGlobally(surname, given_names, phone) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) return { local: [], cloud: [] }

  const key = phoneKey(phone)
  const localRows = await listOrgPatients(activeOrg)

  // --- Local matches (current hospital) ---
  const localMatches = localRows.filter((r) => {
    const nameMatch =
      (!surname || r.surname.trim().toLowerCase().includes(surname.trim().toLowerCase())) &&
      (!given_names ||
        r.given_names
          .trim()
          .toLowerCase()
          .includes(given_names.trim().toLowerCase()))
    const phoneMatch = !key || r.phone_key === key
    return nameMatch && phoneMatch
  })

  const cloudMatches = []
  try {
    const patientsCol = collection(db, 'patients')
    const q = query(patientsCol, where('status', '==', 'active'))
    const snap = await getDocs(q)
    const allOther = snap.docs
      .map((d) => {
        const data = d.data() || {}
        const pid = d.id
        return toPatientRow({ ...data, patient_id: pid })
      })
      .filter((r) => r.organization_id !== activeOrg)
    cloudMatches.push(
      ...allOther.filter((r) => {
        const nameMatch =
          (!surname ||
            r.surname
              .trim()
              .toLowerCase()
              .includes(surname.trim().toLowerCase())) &&
          (!given_names ||
            r.given_names
              .trim()
              .toLowerCase()
              .includes(given_names.trim().toLowerCase()))
        const phoneMatch = !key || r.phone_key === key
        return nameMatch && phoneMatch
      })
    )
  } catch (e) {
    console.warn('[patients] global search cloud failed:', e?.message)
  }

  // Sort local first, then cloud, both by name
  localMatches.sort((a, b) => a.name.localeCompare(b.name))
  cloudMatches.sort((a, b) => a.name.localeCompare(b.name))

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
