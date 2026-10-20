// Appointments — day schedule with Firestore persistence (offline-first, cached).
import { shell, statusBadge, formModal, toast, closeModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgAppointments, listOrgAppointmentsPage, subscribeOrgAppointments, createAppointment, updateAppointmentStatus, myAppointmentCaps,
} from '../services/appointmentService.js'
import { listOrgPatientsPage, formatPhone } from '../services/patientService.js'
import { createLoadMore } from '../components/loadMore.js'
import { onCleanup } from '../lib/lifecycle.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteAppointment } from '../services/deleteService.js'

const CLINICS = ['General Outpatient Department (GOPD)', 'Antenatal', 'Cardiology', 'Endocrine', 'Pediatrics', 'Surgery', 'Eye', 'ENT']
const APPOINTMENT_TYPES = ['Review', 'Follow-up', 'Initial consultation', 'Emergency', 'Referral']
const DOCTORS = ['Dr. A. Balogun', 'Dr. N. Eze', 'Dr. K. Adamu', 'Dr. O. Adeyemo']

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function nowMin() {
  return new Date().toISOString().slice(0, 16)
}

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
  let search = ''
  let selectedDate = todayISO()
  let unsubs = []
  let watchedOrg = activeOrg
  let cursor = null
  let hasMore = false
  let loading = false

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
      '<div class="card"><div class="toolbar" style="gap:10px;align-items:flex-start">' +
      '<label class="fld" style="margin:0"><span>Date</span><input type="date" id="appt-date" class="input" style="width:170px;padding:8px 10px;border:1px solid var(--emr-line);border-radius:10px;font-size:.86rem" /></label>' +
      '<input type="search" id="appt-search" placeholder="Search patient by name, MRN or phone…" class="input" style="width:250px;padding:8px 12px;border:1px solid var(--emr-line);border-radius:10px;font-size:.86rem" />' +
      '<div class="chips" id="appt-chips">' +
      ['All', ...CLINICS].map((c, i) => '<button class="chip' + (i === 0 ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') +
      '</div></div>' +
      '<div id="appt-empty" style="display:none;text-align:center;padding:48px 24px"><p class="mut" style="font-size:1rem;margin-bottom:12px">No appointments for this day yet.</p>' +
      (caps.canCreate ? '<button class="btn" id="emptyBookBtn">+ Book first appointment</button>' : '') +
      '</div>' +
      '<div class="tblwrap"><table class="tbl" id="appt-tbl"><thead><tr><th>Time</th><th>Patient</th><th>Clinic</th><th>Doctor</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">Loading…</td></tr>' +
      '</tbody></table><div class="loadmore" data-loadmore="1"></div></div></div>',
  })

  const more = createLoadMore(loadMore)

  async function loadMore() {
    if (loading) return
    const first = cursor == null && appointments.length === 0
    loading = true
    more.setLoading(true)
    const wrap = document.querySelector('#appt-tbl')?.closest('.tblwrap')
    wrap?.classList.add('is-loading')
    try {
      const [pg, pats] = await Promise.all([
        listOrgAppointmentsPage(activeOrg, { cursor }),
        first ? listOrgPatientsPage(activeOrg, { pageSize: 50 }).then((r) => r.rows).catch(() => []) : Promise.resolve(patients),
      ])
      const seen = new Set(appointments.map((a) => a.id))
      appointments = first ? pg.rows : [...appointments, ...pg.rows.filter((a) => !seen.has(a.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      patients = pats
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
    } catch (e) {
      console.error('[appointments] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) toast('Could not load appointments: ' + friendlyWriteError(e))
      else more.setError('Could not load more — retry')
    } finally {
      wrap?.classList.remove('is-loading')
    }
  }

  function reload() {
    appointments = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive)
  }

  function shown() {
    return appointments.filter((a) => {
      if (selectedDate && String(a.time || '').slice(0, 10) !== selectedDate) return false
      if (chip !== 'All' && a.clinic !== chip) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          String(a.patientName || '').toLowerCase().includes(q) ||
          String(a.patientId || '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }

  function render() {
    const rows = shown()
    const schedEl = document.getElementById('appoint-scheduled')
    const checkEl = document.getElementById('appoint-checked-in')
    const noshowEl = document.getElementById('appoint-noshow')
    const totalEl = document.getElementById('appoint-total')
    if (schedEl) schedEl.textContent = String(rows.filter((a) => a.status === 'scheduled').length)
    if (checkEl) checkEl.textContent = String(rows.filter((a) => a.status === 'checked-in').length)
    if (noshowEl) noshowEl.textContent = String(rows.filter((a) => a.status === 'no-show').length)
    if (totalEl) totalEl.textContent = String(rows.length)

    const empty = document.getElementById('appt-empty')
    const tblWrap = document.querySelector('#appt-tbl')?.closest('.tblwrap')
    const dateInput = document.getElementById('appt-date')
    if (dateInput) dateInput.value = selectedDate

    if (empty && tblWrap) {
      if (rows.length === 0) {
        empty.style.display = ''
        tblWrap.style.display = 'none'
        return
      }
      empty.style.display = 'none'
      tblWrap.style.display = ''
    }

    const tbl = document.getElementById('appt-tbl')
    if (!tbl) return
    const head = '<thead><tr><th>Time</th><th>Patient</th><th>Clinic</th><th>Doctor</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>'
    const rowsHtml = rows.map((a) => {
      const timeLabel = String(a.time || '')
      const timeShort = timeLabel.slice(11, 16) || timeLabel
      const actions = []
      if (a.status === 'scheduled') {
        actions.push({ label: 'Check-in', dataAction: 'check-in' })
        if (caps.canUpdate) actions.push({ label: 'Cancel', tone: 'danger', dataAction: 'cancelled' })
      } else if (a.status === 'checked-in' && caps.canUpdate) {
        actions.push({ label: 'Complete', dataAction: 'completed' })
        actions.push({ label: 'No-show', tone: 'warn', dataAction: 'no-show' })
        actions.push({ label: 'Cancel', tone: 'danger', dataAction: 'cancelled' })
      }
      if (canDeleteRecords()) actions.push({ label: 'Delete', tone: 'danger', dataAction: 'delete' })
      return '<tr>' +
        '<td><strong>' + esc(timeShort) + '</strong></td>' +
        '<td>' + (a.patientName ? '<a href="#/patients/' + esc(a.patientId) + '"><strong>' + esc(a.patientName) + '</strong></a>' : '—') + '</td>' +
        '<td>' + esc(a.clinic) + '</td>' +
        '<td>' + esc(a.doctor) + '</td>' +
        '<td>' + esc(a.type) + '</td>' +
        '<td>' + statusBadge(a.status) + '</td>' +
        '<td>' + kebabCell({ rowId: a.id, items: actions }) + '</td>' +
        '</tr>'
    }).join('')
    tbl.innerHTML = head + '<tbody>' + (rowsHtml || '<tr><td colspan="7" class="mut" style="text-align:center;padding:22px 8px">No appointments match your filters.</td></tr>') + '</tbody>'
    more.mount(tbl.closest('.tblwrap'))

    wireKebabs(tbl, async (rowId, action) => {
      const appt = appointments.find((a) => a.id === rowId)
      if (!appt) return
      if (action === 'check-in' || action === 'completed' || action === 'no-show' || action === 'cancelled') {
        try {
          await updateAppointmentStatus(rowId, action)
          const idx = appointments.findIndex((a) => a.id === rowId)
          if (idx >= 0) {
            appointments[idx] = { ...appointments[idx], status: action, updated_at: Date.now() }
            render()
          }
          toast(String(action).charAt(0).toUpperCase() + String(action).slice(1))
        } catch (e) { toast(friendlyWriteError(e, 'Status update failed')) }
        return
      }
      if (action === 'delete') {
        confirmDelete('this appointment', () => deleteAppointment(rowId), reload)
      }
    })
  }

  function openBookForm() {
    if (!patients.length) {
      toast('Loading patients…')
      listOrgPatientsPage(activeOrg, { pageSize: 50 }).then((r) => {
        patients = r.rows
        openBookForm()
      }).catch(() => {
        toast('Could not load patients.')
      })
      return
    }
    const patientOpts = patients.map((p) => ({
      value: p.pid,
      label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
    }))
    formModal({
      title: 'Book appointment',
      submitLabel: 'Book slot',
      fields: [
        { name: 'patient_id', label: 'Patient', type: 'text', list: 'patient-list', listOptions: patientOpts, searchable: true, required: true, placeholder: 'Type patient name, MRN or mobile…' },
        { name: 'clinic', label: 'Clinic', type: 'select', options: CLINICS, required: true },
        { name: 'doctor', label: 'Doctor', type: 'select', options: DOCTORS },
        { name: 'time', label: 'Date/Time', type: 'datetime-local', required: true, min: nowMin() },
        { name: 'type', label: 'Appointment type', type: 'select', options: APPOINTMENT_TYPES },
        { name: 'reason', label: 'Reason', full: true, placeholder: 'Chief complaint or reason' },
      ],
      onSubmit: async (v) => {
        try {
          const sel = patients.find((p) => p.pid === v.patient_id)
          if (!sel) throw new Error('Please select a valid patient from the list.')
          const apptTime = Date.parse(String(v.time))
          if (isNaN(apptTime)) throw new Error('Invalid date/time selected.')
          if (apptTime <= Date.now()) throw new Error('Appointment time must be in the future.')
          await createAppointment({
            patient_id: v.patient_id,
            patient_name: sel.name,
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
        reload()
      },
    })
  }

  document.getElementById('refreshBtn').onclick = reload
  const bookBtn = document.getElementById('bookBtn')
  if (bookBtn) bookBtn.onclick = openBookForm
  const emptyBookBtn = document.getElementById('emptyBookBtn')
  if (emptyBookBtn) emptyBookBtn.onclick = openBookForm

  const dateInput = document.getElementById('appt-date')
  if (dateInput) {
    dateInput.onchange = () => {
      selectedDate = dateInput.value || todayISO()
      render()
    }
  }

  const searchInput = document.getElementById('appt-search')
  if (searchInput) {
    let searchTimer = null
    searchInput.oninput = () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        search = searchInput.value.trim()
        render()
      }, 500)
    }
  }

  document.querySelectorAll('#appt-chips .chip').forEach((c) => {
    c.onclick = () => {
      document.querySelectorAll('#appt-chips .chip').forEach((x) => x.classList.remove('on'))
      c.classList.add('on')
      chip = c.getAttribute('data-c')
      render()
    }
  })
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    unsubs.push(
      subscribeOrgAppointments(watchedOrg,
        (rows) => {
          const seen = new Set(appointments.map((a) => a.id))
          const merged = [...rows.filter((a) => !seen.has(a.id)), ...appointments]
          const byId = new Map()
          for (const a of merged) {
            if (!byId.has(a.id)) byId.set(a.id, a)
            else byId.set(a.id, { ...byId.get(a.id), ...a })
          }
          appointments = [...byId.values()]
            .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
            .slice(0, 500)
          render()
        },
        (e) => {
          console.warn('[appointments] live update failed; refreshing once:', e?.message || e)
          listOrgAppointments(watchedOrg)
            .then((r) => { appointments = r; render() })
            .catch(() => {})
        }),
    )
  }

  onCleanup(() => {
    teardownListeners()
    unsubAuth()
  })

  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    subscribeLive()
  })

  await loadMore()
  subscribeLive()
}
