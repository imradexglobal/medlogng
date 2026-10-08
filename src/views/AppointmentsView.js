// Appointments — day schedule with Firestore persistence (offline-first, cached).
import { shell, statusBadge, formModal, toast, closeModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgAppointments, createAppointment, updateAppointmentStatus, myAppointmentCaps,
} from '../services/appointmentService.js'
import { listOrgPatients } from '../services/patientService.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

const CLINICS = ['General Outpatient Department (GOPD)', 'Antenatal', 'Cardiology', 'Endocrine', 'Pediatrics', 'Surgery', 'Eye', 'ENT']
const APPOINTMENT_TYPES = ['Review', 'Follow-up', 'Initial consultation', 'Emergency', 'Referral']
const DOCTORS = ['Dr. A. Balogun', 'Dr. N. Eze', 'Dr. K. Adamu', 'Dr. O. Adeyemo']

export async function AppointmentsView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myAppointmentCaps()

  if (!activeOrg) {
    shell(app, {
      active: '/appointments',
      title: 'Appointments',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let appointments = []
  let patients = []
  let chip = 'All'

  shell(app, {
    active: '/appointments',
    title: 'Appointments',
    subtitle: 'Day schedule · clinics',
    actions:
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canCreate ? '<button class="btn" id="bookBtn">+ Book appointment</button>' : ''),
    body:
      '<div class="grid4"><div class="stat"><em>Scheduled</em><strong id="appoint-scheduled">0</strong><span>today across clinics</span></div>' +
      '<div class="stat"><em>Checked-in</em><strong id="appoint-checked-in">0</strong><span>queue updated live</span></div>' +
      '<div class="stat"><em>No-shows</em><strong id="appoint-noshow">0</strong><span>follow-up list ready</span></div>' +
      '<div class="stat"><em>Total</em><strong id="appoint-total">0</strong><span>all appointments</span></div></div>' +
      '<div class="card"><div class="toolbar"><div class="chips" id="appt-chips">' +
      ['All', ...CLINICS].map((c, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') +
      '</div></div>' +
      '<div class="tblwrap"><table class="tbl" id="appt-tbl"><tr><th>Time</th><th>Patient</th><th>Clinic</th><th>Doctor</th><th>Type</th><th>Status</th><th></th></tr>' +
      '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</table></div></div>',
  })

  async function load() {
    try {
      const [appts, pats] = await Promise.all([
        listOrgAppointments(activeOrg),
        listOrgPatients(activeOrg).catch(() => []),
      ])
      appointments = appts
      patients = pats
      render()
    } catch (e) {
      console.error('[appointments] list failed:', e)
      toast('Could not load appointments: ' + friendlyWriteError(e))
    }
  }

  function render() {
    const shown = appointments.filter((a) => chip === 'All' || a.clinic === chip)
    const schedEl = document.getElementById('appoint-scheduled')
    const checkEl = document.getElementById('appoint-checked-in')
    const noshowEl = document.getElementById('appoint-noshow')
    const totalEl = document.getElementById('appoint-total')
    if (schedEl) schedEl.textContent = String(appointments.filter((a) => a.status === 'scheduled').length)
    if (checkEl) checkEl.textContent = String(appointments.filter((a) => a.status === 'checked-in').length)
    if (noshowEl) noshowEl.textContent = String(appointments.filter((a) => a.status === 'no-show').length)
    if (totalEl) totalEl.textContent = String(appointments.length)

    const tbl = document.getElementById('appt-tbl')
    if (!tbl) return
    const head = '<tr><th>Time</th><th>Patient</th><th>Clinic</th><th>Doctor</th><th>Type</th><th>Status</th><th></th></tr>'
    const rows = shown.map((a) =>
      '<tr>' +
      '<td><strong>' + esc(a.time) + '</strong></td>' +
      '<td>' + (a.patientName ? '<a href="#/patients/' + esc(a.patientId) + '"><strong>' + esc(a.patientName) + '</strong></a>' : '—') + '</td>' +
      '<td>' + esc(a.clinic) + '</td>' +
      '<td>' + esc(a.doctor) + '</td>' +
      '<td>' + esc(a.type) + '</td>' +
      '<td>' + statusBadge(a.status) + '</td>' +
      '<td>' + (a.status === 'scheduled' && caps.canCreate ? '<button class="btn ghost sm" data-checkin="' + esc(a.id) + '">Check-in</button>' : '') + '</td>' +
      '</tr>').join('')
    tbl.innerHTML = head + (rows || '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">No appointments yet</td></tr>')
    tbl.querySelectorAll('[data-checkin]').forEach((b) => {
      b.onclick = async () => {
        try {
          await updateAppointmentStatus(b.getAttribute('data-checkin'), 'checked-in')
          toast('Checked in')
          await load()
        } catch (e) { toast(friendlyWriteError(e, 'Check-in failed')) }
      }
    })
  }

  function openBookForm() {
    if (!patients.length) {
      toast('No patients registered yet — register a patient first.')
      return
    }
    const patientOpts = patients.map((p) => ({ value: p.pid, label: p.name + ' · ' + (p.mrn || p.pid) }))
    formModal({
      title: 'Book appointment',
      submitLabel: 'Book slot',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'select', options: patientOpts, required: true },
        { name: 'clinic', label: 'Clinic', type: 'select', options: CLINICS, required: true },
        { name: 'doctor', label: 'Doctor', type: 'select', options: DOCTORS },
        { name: 'time', label: 'Date/Time', placeholder: 'e.g. 2026-09-27 10:40', required: true },
        { name: 'type', label: 'Appointment type', type: 'select', options: APPOINTMENT_TYPES },
        { name: 'reason', label: 'Reason', full: true, placeholder: 'Chief complaint or reason' },
      ],
      onSubmit: async (v) => {
        try {
          const sel = patients.find((p) => p.pid === v.patient_id)
          await createAppointment({
            patient_id: v.patient_id,
            patient_name: sel ? sel.name : v.patient_id,
            clinic: v.clinic,
            doctor: v.doctor,
            time: v.time,
            type: v.type,
            reason: v.reason,
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Appointment booked')
        await load()
      },
    })
  }

  document.getElementById('refreshBtn').onclick = load
  const bookBtn = document.getElementById('bookBtn')
  if (bookBtn) bookBtn.onclick = openBookForm
  document.querySelectorAll('#appt-chips .chip').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('#appt-chips .chip').forEach((x) => x.classList.remove('on'))
      c.classList.add('on')
      chip = c.getAttribute('data-c')
      render()
    }
  })
  wireToast(app)

  await load()
}
