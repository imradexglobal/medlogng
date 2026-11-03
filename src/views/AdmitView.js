// Admit page — full-page admission form (replaces the modal popup).
// Route: #/admissions/new?enc=<id>&ward=<wardId>&bed=<n>
// When `enc` is supplied (deep-link from Consultations), the patient and
// encounter are pre-selected and linked. When admitted directly without an
// encounter, the user picks a patient and an encounter is auto-created so
// every admission carries a clinical thread.
import { shell, toast, wireToast, wireSearchableSelect } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  createAdmission, listOrgWards, listOrgAdmissions, validateAdmissionInput, ADMISSION_TYPES,
} from '../services/admissionService.js'
import {
  createEncounter, findOpenEncounterForPatient,
} from '../services/consultationService.js'
import { listOrgPatientsPage, formatPhone } from '../services/patientService.js'
import { getClinicalStaff } from '../services/authService.js'
import { can } from '../features/admin/roles.js'
import { myActiveMembership } from '../services/authService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { normalizeBedId } from '../features/admissions/domain.js'

export async function AdmitView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const me = myActiveMembership()
  const canAdmit = can(me, 'beds.manage')

  if (!activeOrg) {
    shell(app, {
      active: '/admissions',
      title: 'Admit patient',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  if (!canAdmit) {
    shell(app, {
      active: '/admissions',
      title: 'Admit patient',
      subtitle: 'Requires admission capability',
      body: '<div class="card"><p class="sub">Your role cannot admit patients (missing <code>beds.manage</code> capability). Ask an administrator to grant it.</p><a class="btn ghost" href="#/admissions">← Admissions & beds</a></div>',
    })
    return
  }

  const encId = String(params.enc || '')
  const preselectWardId = String(params.ward || '')
  const preselectBed = String(params.bed || '')

  let wards = []
  let admissions = []
  let patients = []
  let clinicalStaff = []
  let encounter = null
  let preselectPatient = null

  shell(app, {
    active: '/admissions',
    title: 'Admit patient',
    subtitle: encId ? 'From encounter' : 'Direct admission',
    actions: '<a class="btn ghost" href="#/admissions">← Admissions & beds</a>',
    body: '<div id="admit-page">Loading…</div>',
  })
  wireToast(app)

  async function load() {
    try {
      const [w, pats, staff, a] = await Promise.all([
        listOrgWards(activeOrg).catch(() => []),
        listOrgPatientsPage(activeOrg, { pageSize: 200 }).then((r) => r.rows).catch(() => []),
        getClinicalStaff(activeOrg).catch(() => []),
        listOrgAdmissions(activeOrg).catch(() => []),
      ])
      wards = w
      patients = pats
      clinicalStaff = staff
      admissions = a
    } catch (e) {
      console.error('[admit] load failed:', e)
    }

    if (encId) {
      try {
        const { getEncounter } = await import('../services/consultationService.js')
        encounter = await getEncounter(encId)
        if (encounter) {
          preselectPatient = patients.find((p) => p.pid === encounter.patientId) ||
            { pid: encounter.patientId, name: encounter.patientName || encounter.patientId }
        }
      } catch { /* encounter lookup failed — user picks patient manually */ }
    }

    render()
  }

  function freeBedsFor(wardName) {
    const ward = wards.find((w) => w.name === wardName)
    if (!ward || !ward.totalBeds) return { free: [], total: 0, occupied: 0 }
    const occupied = new Set(
      admissions
        .filter((a) => a.status === 'active' && String(a.wardName).trim().toLowerCase() === wardName.trim().toLowerCase() && a.bedNumber)
        .map((a) => normalizeBedId(a.bedNumber))
    )
    const allBeds = Array.from({ length: ward.totalBeds }, (_, i) => normalizeBedId(String(i + 1)))
    const free = allBeds.filter((bed) => !occupied.has(bed))
    return { free, total: ward.totalBeds, occupied: occupied.size }
  }

  function bedField(wardName) {
    const { free, total, occupied } = freeBedsFor(wardName)
    if (!total) {
      return '<input class="input" id="fld-bed_number" required placeholder="Enter bed label; ward capacity is not configured" />' +
        '<small class="mut">Capacity is not configured for this ward — type any bed label.</small>'
    }
    if (!free.length) {
      return '<select class="input" id="fld-bed_number" required disabled><option value="">No beds available in this ward</option></select>' +
        '<small class="mut" style="color:#b91c1c">' + esc(wardName) + ' is at configured capacity (' + occupied + '/' + total + ').</small>'
    }
    const normalizedRequested = normalizeBedId(preselectBed)
    return '<select class="input" id="fld-bed_number" required>' +
      free.map((bed) =>
        '<option value="' + bed + '"' + (bed === normalizedRequested ? ' selected' : '') + '>' + bed + '</option>'
      ).join('') +
      '</select>' +
      '<small class="mut"><strong style="color:#047857">' + free.length + ' available</strong> of ' + total + ' configured beds · ' + occupied + ' occupied.</small>'
  }

  function render() {
    const root = document.getElementById('admit-page')
    if (!root) return

    const preselectWard = preselectWardId ? wards.find((w) => w.id === preselectWardId) : null
    const fixedPatient = encounter && encounter.patientId ? preselectPatient : null
    const defaultReason = encounter?.chiefComplaint || encounter?.chief_complaint || ''

    const patientOpts = fixedPatient
      ? [{ value: fixedPatient.pid, label: (fixedPatient.name || fixedPatient.pid) + ' · ' + (fixedPatient.mrn || fixedPatient.pid) }]
      : patients.map((p) => ({
        value: p.pid,
        label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
      }))

    let wardFieldHtml
    if (wards.length) {
      wardFieldHtml = '<select class="input" id="fld-ward_name" required>' +
        wards.map((w) => {
          const selected = preselectWard && preselectWard.name === w.name ? ' selected' : ''
          const { free, total } = freeBedsFor(w.name)
          const avail = total ? ' (' + free.length + '/' + total + ' free)' : ''
          return '<option value="' + esc(w.name) + '"' + selected + '>' + esc(w.name) + avail + '</option>'
        }).join('') +
        '</select>'
    } else {
      wardFieldHtml = '<input class="input" id="fld-ward_name" disabled placeholder="No wards created yet" />' +
        '<small class="mut" style="color:#b91c1c">Create a ward in Administration → Wards before admitting.</small>'
    }

    let providerFieldHtml
    if (clinicalStaff.length) {
      providerFieldHtml = '<select class="input" id="fld-attending_provider">' +
        clinicalStaff.map((s) => '<option value="' + esc(s.value || s.label || '') + '">' + esc(s.label || s.value || '') + '</option>').join('') +
        '</select>'
    } else {
      providerFieldHtml = '<input class="input" id="fld-attending_provider" placeholder="e.g. Dr. N. Eze" />'
    }

    const contextCard = encounter
      ? '<div class="card" style="margin-bottom:14px">' +
          '<div class="card-head"><h3 style="margin:0">From encounter</h3>' +
            '<a class="btn ghost sm" href="#/consultations?enc=' + encodeURIComponent(encounter.id) + '">Open encounter →</a></div>' +
          '<p class="sub" style="margin:0"><strong>' + esc(encounter.patientName || preselectPatient?.name || '—') + '</strong> · ' +
            esc(String(encounter.id).slice(0, 8)) + '… · ' + esc(encounter.status || 'open') +
            (defaultReason ? ' · complaint: ' + esc(defaultReason) : '') +
          '</p></div>'
      : ''

    root.innerHTML =
      contextCard +
      '<div class="card">' +
        '<div class="card-head"><h3 style="margin:0">' + (encId ? 'Admit patient (from encounter)' : 'Admit patient') + '</h3></div>' +
        '<div class="fgrid" id="admit-fields">' +
          '<label>Patient<select class="input" id="fld-patient_id" required>' +
            (fixedPatient
              ? '<option value="' + esc(fixedPatient.pid) + '" selected>' + esc((fixedPatient.name || fixedPatient.pid) + ' · ' + (fixedPatient.mrn || fixedPatient.pid)) + '</option>'
              : '<option value="">— select patient —</option>' + patientOpts.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('')) +
          '</select></label>' +
          '<label>Ward' + wardFieldHtml + '</label>' +
          '<label>Available bed' + bedField(preselectWard?.name || (wards[0] && wards[0].name) || '') + '</label>' +
          '<label>Admission type<select class="input" id="fld-admission_type">' +
            ADMISSION_TYPES.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('') +
          '</select></label>' +
          '<label>Attending doctor' + providerFieldHtml + '</label>' +
          '<label>Reason<textarea class="input" id="fld-admission_reason" rows="2" placeholder="e.g. Observation">' + esc(defaultReason) + '</textarea></label>' +
        '</div>' +
        '<div class="mrow" style="margin-top:14px">' +
          '<button class="btn ghost" id="admitCancel">Cancel</button>' +
          '<button class="btn" id="admitSave">Confirm admission</button>' +
        '</div>' +
        '<div id="admitErr" class="err" style="margin-top:10px"></div>' +
      '</div>'

    const patientSelect = document.getElementById('fld-patient_id')
    if (patientSelect && !fixedPatient) wireSearchableSelect(null, patientSelect)
    if (wards.length) wireSearchableSelect(null, document.getElementById('fld-ward_name'))
    if (clinicalStaff.length) wireSearchableSelect(null, document.getElementById('fld-attending_provider'))

    document.getElementById('admitCancel').onclick = () => { window.location.hash = '#/admissions' }
    document.getElementById('fld-ward_name')?.addEventListener('change', () => {
      const label = document.querySelector('label:has(#fld-bed_number)')
      if (label) label.innerHTML = 'Available bed' + bedField(document.getElementById('fld-ward_name').value)
    })

    document.getElementById('admitSave').onclick = async () => {
      const errEl = document.getElementById('admitErr')
      errEl.textContent = ''
      const btn = document.getElementById('admitSave')
      btn.disabled = true
      btn.textContent = 'Admitting…'
      try {
        const v = {
          patient_id: document.getElementById('fld-patient_id').value,
          ward_name: document.getElementById('fld-ward_name').value,
          bed_number: document.getElementById('fld-bed_number').value,
          admission_type: document.getElementById('fld-admission_type').value,
          attending_provider: document.getElementById('fld-attending_provider').value,
          admission_reason: document.getElementById('fld-admission_reason').value,
        }
        const invalid = validateAdmissionInput(v, { wards, admissions, encounter })
        if (invalid) { throw new Error(invalid) }

        const pid = v.patient_id
        const patient = patients.find((p) => p.pid === pid) || preselectPatient || { name: '' }

        let encToLink = encounter
        if (!encounter) {
          try {
            const existing = await findOpenEncounterForPatient(pid, activeOrg)
            if (existing) {
              encToLink = existing
            } else {
              const created = await createEncounter({
                patient_id: pid,
                patient_name: patient.name || '',
                status: 'arrived',
                type: '',
                clinician: v.attending_provider || '',
                chief_complaint: v.admission_reason || '',
              })
              encToLink = created
            }
          } catch (e) {
            throw new Error('Could not create/find encounter for this patient: ' + friendlyWriteError(e))
          }
        }

        const saved = await createAdmission({
          patient_id: pid,
          patient_name: patient.name || '',
          ward_name: v.ward_name,
          bed_number: v.bed_number,
          admission_type: v.admission_type,
          admission_reason: v.admission_reason,
          attending_provider: v.attending_provider,
          encounter_id: encToLink ? encToLink.id : '',
        })
        toast(saved.pendingSync || encToLink?.pendingSync
          ? 'Admission saved on this device; it will sync when connected.'
          : 'Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)

        // Prefer workspace so care can start immediately
        if (saved?.id) {
          window.location.hash = '#/admissions/' + encodeURIComponent(saved.id)
        } else {
          window.location.hash = '#/admissions'
        }
      } catch (e) {
        errEl.textContent = friendlyWriteError(e, 'Admission failed.')
        btn.disabled = false
        btn.textContent = 'Confirm admission'
      }
    }
  }

  load()
  onCleanup(() => {})
}
