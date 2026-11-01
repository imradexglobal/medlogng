// Start encounter — FULL-PAGE form (route: #/encounters/new?pid=<id>&name=<who>).
//
// This used to be a formModal popup squeezed into the modal card, which left
// the fields (and the suggestion list under the Reason tags) cramped. Like
// AdmitView ("full-page admission form — replaces the modal popup"), it is a
// proper page now — but deliberately NOT a navigation entry: it is reached
// only from the places that start encounters (consultations queue, patient
// list kebab, patient chart header / dashboard), all of which just navigate
// here with the patient pre-selected via ?pid=.
//
// Canonical behaviour (shared by every entry point through this ONE page):
//   • Type    — ENCOUNTER_TYPES from consultationService (single source)
//   • Reason  — tags input: this patient's past complaints first (when the
//               patient is known), then the common-complaints list
//   • Guard   — "open encounter exists" card rendered IN the page (no popup)
//               with a deep link to the existing encounter — before the form
//               when the patient is known, and again on submit as a backstop
//   • Create  — createEncounter() (patient check, duplicate guard, audit log)
//   • After   — deep-link straight into the encounter workspace
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { navigate } from '../router.js'
import {
  createEncounter, ENCOUNTER_TYPES, findOpenEncounterForPatient, myEncounterCaps,
} from '../services/consultationService.js'
import {
  listOrgPatientsPage, formatPhone, listPatientDocs, getPatient,
} from '../services/patientService.js'
import { getClinicalStaff } from '../services/authService.js'
import { createAllergyTagInput } from '../components/AllergyTagInput.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

// Common presenting complaints offered in the chief-complaint field. Same UX
// as the allergy picker on patient registration: search, click or Enter to
// add a pill, free text still allowed for anything not on the list.
const COMMON_COMPLAINTS = [
  'Fever', 'Headache', 'Cough', 'Cough with blood', 'Catarrh', 'Sore throat',
  'Chest pain', 'Shortness of breath', 'Difficulty breathing', 'Palpitations',
  'Abdominal pain', 'Stomach upset', 'Heartburn', 'Nausea', 'Vomiting',
  'Diarrhea', 'Constipation', 'Poor appetite', 'Weight loss', 'Weight gain',
  'Fatigue', 'Weakness', 'Dizziness', 'Fainting', 'Seizure', 'Insomnia',
  'Back pain', 'Joint pain', 'Neck pain', 'Shoulder pain', 'Knee pain',
  'Numbness', 'Tingling', 'Swelling of legs', 'Swelling of face', 'Swelling',
  'Urinary frequency', 'Burning urination', 'Dark urine', 'Yellow eyes',
  'Rash', 'Itching', 'Hives', 'Bleeding', 'Night sweats',
  'Ear pain', 'Ear discharge', 'Eye pain', 'Red eye', 'Blurred vision',
  'Tooth pain', 'Missed period', 'Vaginal discharge', 'Pelvic pain',
  'Painful menstruation', 'Heavy menstruation', 'Infertility concern',
  'Hypertension review', 'Diabetes review', 'Asthma review', 'Malaria symptoms',
  'Typhoid symptoms', 'COVID-19 symptoms', 'Anaemia symptoms',
  'Antenatal follow-up', 'Postnatal review', 'Family planning',
  'Immunization', 'Medication refill', 'Lab results review',
  'Injury', 'Road traffic accident', 'Follow-up review',
]

export async function StartEncounterView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const pid = String(params.pid || '')
  const patientName = String(params.name || '')

  // Cancel target: back to the patient's chart when we came from one,
  // otherwise to the consultations worklist.
  const cancelHref = pid ? '#/patients/' + encodeURIComponent(pid) : '#/consultations'

  if (!activeOrg) {
    shell(app, {
      active: '/consultations',
      title: 'Start encounter',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  if (!myEncounterCaps().canCreate) {
    shell(app, {
      active: '/consultations',
      title: 'Start encounter',
      subtitle: 'Requires encounter capability',
      body: '<div class="card"><p class="sub">Your role cannot create encounters (missing <code>encounter.create</code> capability). Ask an administrator to grant it.</p><a class="btn ghost" href="#/consultations">← Consultations</a></div>',
    })
    return
  }

  let patients = []
  let staff = []
  let pastReasons = []
  let blockedBy = null // an already-open encounter, when detected
  let reasonInput = null

  shell(app, {
    active: '/consultations',
    title: 'Start encounter',
    subtitle: 'Patient · Type · Clinician · Reason',
    actions: '<a class="btn ghost" href="#/consultations">← Consultations</a>',
    body: '<div id="startEncPage" class="card">Loading…</div>',
  })
  wireToast(app)

  // Patient summary for the pre-selected case: the list page may not have the
  // MRN at hand, so read the record itself (never blocks the form).
  async function loadPatientSummary() {
    if (!pid) return null
    try {
      const p = await getPatient(pid)
      if (p) return { pid, name: p.name || patientName, mrn: p.mrn || '' }
    } catch { /* fall back to the name carried in the query */ }
    return { pid, name: patientName, mrn: '' }
  }

  async function load() {
    const [pats, clinicalStaff, fixedPatient] = await Promise.all([
      pid ? Promise.resolve([]) : listOrgPatientsPage(activeOrg, { pageSize: 200 }).then((r) => r.rows).catch(() => []),
      getClinicalStaff(activeOrg).catch(() => []),
      loadPatientSummary(),
    ])
    patients = pats
    staff = clinicalStaff

    // Duplicate guard up front — the page renders the "already open" card
    // instead of a form that would only be rejected on submit.
    if (pid) {
      try { blockedBy = await findOpenEncounterForPatient(pid, activeOrg) } catch { /* re-checked on submit */ }
      try {
        const past = await listPatientDocs('encounters', pid)
        pastReasons = (past.rows || []).flatMap((en) =>
          String(en.reason || en.chief_complaint || '').split(/[,;]+/))
      } catch { /* the common list alone is a perfectly good fallback */ }
    }

    render(fixedPatient)
  }

  function render(fixedPatient) {
    const root = document.getElementById('startEncPage')
    if (!root) return
    if (reasonInput) { reasonInput.destroy(); reasonInput = null }

    // ---- already-open encounter: full-width notice instead of the form ----
    if (blockedBy) {
      const ref = blockedBy.id ? String(blockedBy.id).slice(0, 8) + '…' : ''
      const type = esc(blockedBy.type || blockedBy.raw?.encounter_type || blockedBy.raw?.reason || '')
      const status = blockedBy.status ? ' · ' + esc(blockedBy.status) : ''
      root.innerHTML =
        '<div class="card-head"><h3 style="margin:0">Open encounter already exists</h3></div>' +
        '<p class="sub"><strong>' + esc(fixedPatient?.name || patientName || 'This patient') + '</strong>' +
        ' already has an open encounter' + (ref ? ' (' + esc(ref) + ')' : '') + status +
        (type ? ' — ' + type : '') + '. Close it before opening a new one.</p>' +
        '<div class="mrow">' +
        '<a class="btn ghost" href="' + cancelHref + '">Cancel</a>' +
        (blockedBy.id
          ? '<a class="btn" href="#/consultations?enc=' + encodeURIComponent(blockedBy.id) + '">Go to encounter →</a>'
          : '') +
        '</div>'
      return
    }

    // ---- the form ----------------------------------------------------------
    const reasonSuggestions = [...new Set(
      [...pastReasons.map((r) => r.trim()).filter(Boolean), ...COMMON_COMPLAINTS],
    )]

    const patientFieldHtml = fixedPatient
      ? '<label>Patient<input class="input" value="' +
        esc((fixedPatient.name || fixedPatient.pid) + (fixedPatient.mrn ? ' · ' + fixedPatient.mrn : '')) +
        '" disabled /></label>'
      : '<label>Patient<select class="input" id="encPatient">' +
        '<option value="">— select patient —</option>' +
        patients.map((p) => '<option value="' + esc(p.pid) + '">' +
          esc(p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key)) +
          '</option>').join('') +
        '</select></label>'

    const clinicianFieldHtml = staff.length
      ? '<label>Clinician<select class="input" id="encClinician">' +
        '<option value="">— select clinician —</option>' +
        staff.map((s) => '<option value="' + esc(s.value || s.label || '') + '">' + esc(s.label || s.value || '') + '</option>').join('') +
        '</select></label>'
      : '<label>Clinician (no staff on file — type a name)<input class="input" id="encClinician" placeholder="e.g. Dr. N. Eze" /></label>'

    root.innerHTML =
      '<div class="card-head"><h3 style="margin:0">' +
      (fixedPatient ? 'New encounter for ' + esc(fixedPatient.name || fixedPatient.pid) : 'New encounter') +
      '</h3></div>' +
      '<div class="fgrid">' +
      patientFieldHtml +
      '<label>Type<select class="input" id="encType">' +
      '<option value="">— select type —</option>' +
      ENCOUNTER_TYPES.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('') +
      '</select></label>' +
      clinicianFieldHtml +
      '<label style="grid-column:1/-1">Reason / chief complaint' +
      '<div class="allergy-tag-container" id="encReasonTags"></div>' +
      '</label>' +
      '</div>' +
      '<div class="mrow" style="margin-top:14px">' +
      '<a class="btn ghost" href="' + cancelHref + '">Cancel</a>' +
      '<button class="btn" id="encSave">Open encounter →</button>' +
      '</div>' +
      '<div id="encErr" class="err" style="margin-top:10px"></div>'

    // Searchable pill input for the reason — the same component the modal
    // used, now with room to grow: suggestions drop over the page instead of
    // being boxed in by the modal card.
    reasonInput = createAllergyTagInput(document.getElementById('encReasonTags'), {
      value: [],
      suggestions: reasonSuggestions,
      name: 'chief_complaint',
      placeholder: 'Search common complaints, or type your own — Enter adds',
    })

    document.getElementById('encSave').onclick = submit
  }

  async function submit() {
    const errEl = document.getElementById('encErr')
    errEl.textContent = ''
    const btn = document.getElementById('encSave')
    btn.disabled = true
    try {
      const chosenPid = pid || String(document.getElementById('encPatient').value || '').trim()
      const type = String(document.getElementById('encType').value || '').trim()
      const clinician = String(document.getElementById('encClinician').value || '').trim()
      const reason = (reasonInput?.getValue() || []).join(', ')

      if (!chosenPid) throw new Error('Select a patient.')
      if (!type) throw new Error('Select the encounter type.')
      if (!clinician) throw new Error('Select the clinician.')
      if (!reason) throw new Error('Add at least one reason for this encounter.')

      let name = patientName
      if (!name && !pid) {
        const opt = patients.find((p) => p.pid === chosenPid)
        name = opt ? opt.name : ''
      }

      // Duplicate guard: swap the page to the notice instead of a raw error.
      // createEncounter() re-checks too (race backstop).
      try {
        const existing = await findOpenEncounterForPatient(chosenPid, activeOrg)
        if (existing) {
          blockedBy = existing
          render(fixedPatientFor(chosenPid, name))
          return
        }
      } catch (e) {
        console.warn('[encounters] open-encounter check failed:', e?.message)
      }

      try {
        const created = await createEncounter({
          patient_id: chosenPid,
          patient_name: name,
          status: 'arrived',
          type,
          clinician,
          chief_complaint: reason,
        })
        toast('Encounter opened' + (name ? ' for ' + esc(name) : ''))
        navigate('/consultations?enc=' + encodeURIComponent(created.id))
      } catch (e) {
        throw new Error(friendlyWriteError(e))
      }
    } catch (e) {
      errEl.textContent = e?.message || 'Could not open the encounter.'
      btn.disabled = false
    }
  }

  // Patient summary used when a duplicate surfaces on submit for the picker
  // case (the page swaps to the notice card).
  function fixedPatientFor(chosenPid, name) {
    if (pid) return null // the caller already has the real summary
    const opt = patients.find((p) => p.pid === chosenPid)
    return { pid: chosenPid, name: name || opt?.name || '', mrn: opt?.mrn || '' }
  }

  load()
}
