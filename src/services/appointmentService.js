import {
  db, collection, query, where, getDocs, getDoc, doc, setDoc, updateDoc, serverTimestamp, orderBy, limit,
  startAfter,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { myActiveMembership } from './authService.js'
import { listOrgPatients } from './patientService.js'
import { can } from '../features/admin/roles.js'
import { logAudit } from './adminService.js'
import { watchQuery } from './live.js'
import { runChunk } from './pagination.js'
import { currentStaffName } from '../lib/staffName.js'

const APPOINTMENTS = 'appointments'

// Live listeners are bounded to the 100 most recent rows (cost control);
// list* stays unbounded so a manual refresh still shows everything.
const LIVE_LIMIT = 100

// ---- capability check --------------------------------------------------------
export function myAppointmentCaps() {
  const me = myActiveMembership()
  return {
    membership: me,
    canCreate: can(me, 'appointment.create'),
    canUpdate: can(me, 'appointment.update'),
  }
}

// ---- model shape ------------------------------------------------------------
function toAppointmentRow(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name || '',
    time: r.time || '',
    clinic: r.clinic || '',
    doctor: r.doctor || '',
    type: r.type || '',
    reason: r.reason || '',
    status: r.status || 'scheduled',
    checkedIn: r.checkedIn || false,
    createdAt: r.created_at ? r.created_at.toMillis ? r.created_at.toMillis() : 0 : 0,
    raw: r,
  }
}

// ---- reads ---------------------------------------------------------------
// Single equality filter only (no composite index needed, works offline).
// Extra filtering is done client-side.
function buildOrgAppointmentsQuery(orgId) {
  return query(collection(db, APPOINTMENTS), where('organization_id', '==', orgId))
}

function mapAppointmentDoc(d) {
  return toAppointmentRow({ ...d.data(), id: d.id })
}

// Client-side filter + sort shared by listOrgAppointments and
// subscribeOrgAppointments so live rows are byte-for-byte identical in shape.
function applyAppointmentFilters(rows, filters = {}) {
  if (filters.status) rows = rows.filter((r) => r.status === filters.status)
  if (filters.clinic) rows = rows.filter((r) => r.clinic === filters.clinic)
  // Sort by appointment time ascending (earliest slot first)
  rows.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
  return rows
}

export async function listOrgAppointments(orgId, filters = {}) {
  const snap = await getDocs(buildOrgAppointmentsQuery(orgId))
  return applyAppointmentFilters(snap.docs.map(mapAppointmentDoc), filters)
}

// Next chunk of the newest-first list (cursor-walked for infinite scroll).
// Needs index:
// appointments: organization_id ASC + created_at DESC.
export const APPOINTMENTS_PAGE = 25

export async function listOrgAppointmentsPage(orgId, { pageSize = APPOINTMENTS_PAGE, cursor = null, ...filters } = {}) {
  const base = query(
    collection(db, APPOINTMENTS),
    where('organization_id', '==', orgId),
    orderBy('time', 'asc'),
  )
  const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize, cursor })
  return { rows: applyAppointmentFilters(docs.map(mapAppointmentDoc), filters), hasMore, cursor: next }
}


// Live query: same org scope + row shape as listOrgAppointments, but bounded
// to the 100 most recent (orderBy+limit needs the composite index in
// firestore.indexes.json — deploy it or the listener falls back to one-shot).
function buildOrgAppointmentsLiveQuery(orgId) {
  return query(
    collection(db, APPOINTMENTS),
    where('organization_id', '==', orgId),
    orderBy('time', 'asc'),
    limit(LIVE_LIMIT),
  )
}

export function subscribeOrgAppointments(orgId, onRows, onError) {
  return watchQuery(
    buildOrgAppointmentsLiveQuery(orgId),
    mapAppointmentDoc,
    (rows) => onRows(applyAppointmentFilters(rows)),
    onError,
  )
}

// ---- create ---------------------------------------------------------------
export async function createAppointment(input) {
  const { activeOrg, user } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')
  const caps = myAppointmentCaps()
  if (!caps.canCreate) {
    throw new Error('Your role cannot create appointments (missing "appointment.create" capability). Ask an administrator.')
  }

  // Validate required fields
  if (!input.patient_id) throw new Error('Patient is required.')
  if (!input.time) throw new Error('Date/time is required.')
  if (!input.clinic) throw new Error('Clinic/department is required.')

  // Validate the appointment time is parseable and in the future
  const apptTime = Date.parse(String(input.time))
  if (isNaN(apptTime)) throw new Error('Invalid date/time — use the date picker.')
  if (apptTime <= Date.now()) throw new Error('Appointment time must be in the future.')

  // Prevent double-booking at the same slot
  if (await checkAppointmentConflict(activeOrg, input.time)) {
    throw new Error('An appointment is already booked at this time. Choose a different slot.')
  }

  const pid = input.patient_id
  // Verify patient exists in this organization
  try {
    const patients = await listOrgPatients(activeOrg)
    if (!patients.some((p) => p.pid === pid)) {
      throw new Error('Selected patient is not registered at this hospital.')
    }
  } catch (e) {
    throw new Error('Could not verify patient: ' + e.message)
  }

  const appointmentId = doc(collection(db, APPOINTMENTS)).id
  const now = serverTimestamp()
  const appointment = {
    patient_id: pid,
    patient_name: input.patient_name || '',
    organization_id: activeOrg,
    time: input.time,
    clinic: input.clinic,
    doctor: input.doctor || '',
    type: input.type || '',
    reason: input.reason || '',
    status: 'scheduled',
    checkedIn: false,
    created_by: user?.uid || null,
    created_by_name: currentStaffName(),
    created_at: now,
    updated_at: now,
  }

  await setDoc(doc(db, APPOINTMENTS, appointmentId), appointment)

  try {
    await logAudit({ action: 'appointment.created', organizationId: activeOrg, patientId: pid, details: 'Appointment ' + appointmentId + ' for ' + input.patient_name })
  } catch (e) {
    console.warn('[appointments] audit append failed:', e?.message)
  }
  return { id: appointmentId, ...appointment }
}

// ---- status update --------------------------------------------------------
export async function updateAppointmentStatus(id, status) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) throw new Error('No hospital selected.')

  const validStatuses = ['scheduled', 'checked-in', 'completed', 'cancelled', 'no-show']
  if (!validStatuses.includes(status)) throw new Error('Invalid appointment status: ' + status)
  // Rules require `appointment.update` for appointment status changes.
  if (!can(myActiveMembership(), 'appointment.update')) {
    throw new Error('Your role cannot update appointments (missing "appointment.update" capability). Ask an administrator to re-save your role.')
  }

  await updateDoc(doc(db, APPOINTMENTS, id), {
    status,
    updated_at: serverTimestamp(),
  })

  try {
    await logAudit({ action: 'appointment.' + status, organizationId: activeOrg, patientId: id, details: 'Appointment ' + id + ' status updated to ' + status })
  } catch (e) {
    console.warn('[appointments] audit append failed:', e?.message)
  }
  return true
}

// ---- conflict detection ---------------------------------------------------
// Client-side scan of the org list (no composite index, works offline).
export async function checkAppointmentConflict(orgId, time, excludeId = '') {
  const rows = await listOrgAppointments(orgId)
  const timeMs = typeof time === 'number' ? time : Date.parse(String(time))
  if (isNaN(timeMs)) return false
  return rows.some((a) => {
    if (a.id === excludeId) return false
    if (a.status !== 'scheduled' && a.status !== 'checked-in') return false
    const aptMs = typeof a.time === 'number' ? a.time : Date.parse(String(a.time))
    return aptMs === timeMs
  })
}