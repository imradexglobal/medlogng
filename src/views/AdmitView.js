// Admit page — full-page admission form (replaces the modal popup).
// Route: #/admissions/new?enc=<id>&ward=<wardId>
// When `enc` is supplied (deep-link from Consultations), the patient and
// encounter are pre-selected and linked. When admitted directly without an
// encounter, the user picks a patient and an encounter is auto-created so
// every admission carries a clinical thread.
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  createAdmission, listOrgWards, validateAdmissionInput, ADMISSION_TYPES,
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

  let wards = []
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
      const [w, pats, staff] = await Promise.all([
        listOrgWards(activeOrg).catch(() => []),
        listOrgPatientsPage(activeOrg, { pageSize: 200 }).then((r) => r.rows).catch(() => []),
        getClinicalStaff(activeOrg).catch(() => []),
      ])
      wards = w
      patients = pats
      clinicalStaff = staff
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

  function render() {
    const root = document.getElementById('admit-page')
    if (!root) return

    const preselectWard = preselectWardId ? wards.find((w) => w.id === preselectWardId) : null
    const fixedPatient = encounter && encounter.patientId ? preselectPatient : null

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
          return '<option value="' + esc(w.name) + '"' + selected + '>' + esc(w.name) + '</option>'
        }).join('') +
        '</select>'
    } else {
      wardFieldHtml = '<input class="input" id="fld-ward_name" required placeholder="e.g. Ward A" />'
    }

    let providerFieldHtml
    if (clinicalStaff.length) {
      providerFieldHtml = '<select class="input" id="fld-attending_provider">' +
        clinicalStaff.map((s) => '<option value="' + esc(s.value || s.label || '') + '">' + esc(s.label || s.value || '') + '</option>').join('') +
        '</select>'
    } else {
      providerFieldHtml = '<input class="input" id="fld-attending_provider" placeholder="e.g. Dr. N. Eze" />'
    }

    root.innerHTML =
      '<div class="card">' +
      '<div class="card-head"><h3 style="margin:0">' + (encId ? 'Admit patient (from encounter)' : 'Admit patient') + '</h3></div>' +
      '<div class="fgrid" id="admit-fields">' +
      '<label>Patient<select class="input" id="fld-patient_id" required>' +
      (fixedPatient
        ? '<option value="' + esc(fixedPatient.pid) + '" selected>' + esc((fixedPatient.name || fixedPatient.pid) + ' · ' + (fixedPatient.mrn || fixedPatient.pid)) + '</option>'
        : '<option value="">— select patient —</option>' + patientOpts.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('')) +
      '</select></label>' +
      '<label>Ward' + wardFieldHtml + '</label>' +
      '<label>Bed<input class="input" id="fld-bed_number" required placeholder="e.g. Bed 1" /></label>' +
      '<label>Admission type<select class="input" id="fld-admission_type">' +
      ADMISSION_TYPES.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('') +
      '</select></label>' +
      '<label>Attending doctor' + providerFieldHtml + '</label>' +
      '<label>Reason<textarea class="input" id="fld-admission_reason" rows="2" placeholder="e.g. Observation"></textarea></label>' +
      '</div>' +
      '<div class="mrow" style="margin-top:14px">' +
      '<button class="btn ghost" id="admitCancel">Cancel</button>' +
      '<button class="btn" id="admitSave">Confirm admission</button>' +
      '</div>' +
      '<div id="admitErr" class="err" style="margin-top:10px"></div>' +
      '</div>'

    document.getElementById('admitCancel').onclick = () => { window.location.hash = '#/admissions' }
    document.getElementById('admitSave').onclick = async () => {
      const errEl = document.getElementById('admitErr')
      errEl.textContent = ''
      const btn = document.getElementById('admitSave')
      btn.disabled = true
      try {
        const v = {
          patient_id: document.getElementById('fld-patient_id').value,
          ward_name: document.getElementById('fld-ward_name').value,
          bed_number: document.getElementById('fld-bed_number').value,
          admission_type: document.getElementById('fld-admission_type').value,
          attending_provider: document.getElementById('fld-attending_provider').value,
          admission_reason: document.getElementById('fld-admission_reason').value,
        }
        const invalid = validateAdmissionInput(v, { wards, admissions: [], encounter })
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

        await createAdmission({
          patient_id: pid,
          patient_name: patient.name || '',
          ward_name: v.ward_name,
          bed_number: v.bed_number,
          admission_type: v.admission_type,
          admission_reason: v.admission_reason,
          attending_provider: v.attending_provider,
          encounter_id: encToLink ? encToLink.id : '',
        })
        toast('Patient admitted to ' + v.ward_name + ' · ' + v.bed_number)
        window.location.hash = '#/admissions'
      } catch (e) {
        errEl.textContent = e?.message || 'Admission failed.'
        btn.disabled = false
      }
    }
  }

  load()
  onCleanup(() => {})
}
