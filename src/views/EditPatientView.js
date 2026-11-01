// Modern Edit Demographics page — stepper UI for editing patient details.
import { shell, toast, wireToast } from '../components/shell.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'
import { payerOptions } from '../services/payerService.js'
import { updatePatient, myPatientCaps, friendlyPatientError, formatPhone, getAllAllergiesFromDB } from '../services/patientService.js'
import { authStore } from '../store/authStore.js'
import { createAllergyTagInput, parseAllergyString, DEFAULT_ALLERGY_SUGGESTIONS } from '../components/AllergyTagInput.js'

const EDIT_STEPS = [
  { id: 'personal', label: 'Personal Data', icon: '👤' },
  { id: 'blood', label: 'Blood & Allergies', icon: '🩸' },
  { id: 'kin', label: 'Next of Kin', icon: '👨‍👩‍👧' },
]
const SEXES = [{ value: '', label: '— Select —' }, { value: 'Female', label: 'Female' }, { value: 'Male', label: 'Male' }]
const BLOOD_GROUPS = [
  { value: '', label: '— Select —' },
  { value: 'A+', label: 'A+' }, { value: 'A-', label: 'A-' },
  { value: 'B+', label: 'B+' }, { value: 'B-', label: 'B-' },
  { value: 'AB+', label: 'AB+' }, { value: 'AB-', label: 'AB-' },
  { value: 'O+', label: 'O+' }, { value: 'O-', label: 'O-' },
]
const GENOTYPES = [
  { value: '', label: '— Select —' },
  { value: 'AA', label: 'AA' }, { value: 'AS', label: 'AS' },
  { value: 'SS', label: 'SS' }, { value: 'AC', label: 'AC' },
  { value: 'SC', label: 'SC' }, { value: 'CC', label: 'CC' },
]

export async function EditPatientView(app, params) {
  const pid = params.id
  const { activeOrg } = authStore.getState()
  const caps = myPatientCaps()

  if (!activeOrg || !caps.canUpdate) {
    shell(app, { active: '/patients', title: 'Edit Patient', subtitle: 'Permission denied',
      body: '<div class="card empty-state"><div class="empty-icon">🔒</div><p>Cannot edit — no hospital selected or insufficient permissions.</p><a class="btn ghost" href="#/patients">← Back to patients</a></div>' })
    return
  }

  // Load patient data
  const { getPatient } = await import('../services/patientService.js')
  let patient = null
  try {
    patient = await getPatient(pid)
  } catch (e) {
    shell(app, { active: '/patients', title: 'Edit Patient', subtitle: 'Not found',
      body: '<div class="card empty-state"><div class="empty-icon">🔍</div><p>Could not load patient: ' + esc(friendlyPatientError(e)) + '</p><a class="btn ghost" href="#/patients">← Back to patients</a></div>' })
    return
  }
  if (!patient) {
    shell(app, { active: '/patients', title: 'Edit Patient', subtitle: 'Not found',
      body: '<div class="card empty-state"><div class="empty-icon">🔍</div><p>Patient not found.</p><a class="btn ghost" href="#/patients">← Back to patients</a></div>' })
    return
  }

  let payerOpts = []
  try { payerOpts = await payerOptions(patient.payer) } catch (e) { console.warn('[patients] payer options unavailable:', e?.message) }
  if (!payerOpts.length) payerOpts = [{ value: 'Self-pay', label: 'Self-pay' }]

  // Initialize form with existing patient data
  const formData = {
    surname: patient.surname || '',
    given_names: patient.given_names || '',
    phone: patient.phone_key || '',
    sex: patient.sex || '',
    dob: patient.dob || '',
    payer: patient.payer || 'Self-pay',
    blood_group: patient.blood_group || '',
    genotype: patient.genotype || '',
    allergy: parseAllergyString(patient.allergy),
    occupation: patient.occupation || '',
    next_of_kin_first_name: patient.next_of_kin_first_name || '',
    next_of_kin_last_name: patient.next_of_kin_last_name || '',
    next_of_kin_phone: patient.next_of_kin_phone_key || '',
    next_of_kin_address: patient.next_of_kin_address || '',
    address: patient.address || '',
  }

  let currentStep = 0
  let submitError = null
  let isSubmitting = false
  let allergyTagInput = null
  let dbAllergiesLoaded = false
  let mergedAllergySuggestions = [...DEFAULT_ALLERGY_SUGGESTIONS]

  async function loadDBAllergies() {
    if (dbAllergiesLoaded) return
    try {
      const fromDB = await getAllAllergiesFromDB()
      const seen = new Set()
      const merged = []
      for (const s of [...fromDB, ...DEFAULT_ALLERGY_SUGGESTIONS]) {
        const key = s.trim().toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        merged.push(s.trim())
      }
      mergedAllergySuggestions = merged
      dbAllergiesLoaded = true
      if (allergyTagInput) {
        allergyTagInput.updateSuggestions(mergedAllergySuggestions)
      }
    } catch (e) {
      console.warn('[edit] load DB allergies failed:', e?.message)
    }
  }

  function render() {
    const progress = ((currentStep + 1) / EDIT_STEPS.length * 100).toFixed(0)
    const step = EDIT_STEPS[currentStep]

    shell(app, {
      active: '/patients',
      title: 'Edit ' + patient.name,
      subtitle: `Step ${currentStep + 1} of ${EDIT_STEPS.length} — ${step.label}`,
      actions: '<a class="btn ghost" href="#/patients/' + pid + '">← Back to patient</a>',
      body: `
        <div class="reg-container">
          <div class="progress-bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Step ${currentStep + 1} of ${EDIT_STEPS.length} — ${step.label}">
            <div class="progress-fill" style="width: ${progress}%"></div>
            <div class="progress-steps">
              ${EDIT_STEPS.map((s, i) => `<span class="step-dot ${i < currentStep ? 'done' : ''} ${i === currentStep ? 'active' : ''}" data-step="${i}">${i < currentStep ? '✓' : s.icon}</span>`).join('')}
            </div>
          </div>

          ${submitError ? `<div class="alert error" role="alert">${esc(submitError)}</div>` : ''}

          <form id="editForm" class="reg-form" novalidate>
            <div class="step-panel" data-step="personal" style="${currentStep === 0 ? '' : 'display:none'}">
              <fieldset>
                <legend><span class="legend-icon">👤</span> Personal Information</legend>
                <div class="form-grid">
                  <div class="field required">
                    <label for="surname">Surname <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="surname" name="surname" value="${esc(formData.surname)}" placeholder="e.g. Okafor" autocomplete="family-name" required aria-required="true" />
                  </div>
                  <div class="field required">
                    <label for="given_names">Given name(s) <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="given_names" name="given_names" value="${esc(formData.given_names)}" placeholder="e.g. Ada Chidi" autocomplete="given-name" required aria-required="true" />
                  </div>
                  <div class="field required">
                    <label for="phone">Phone (+234) <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="tel" id="phone" name="phone" value="${esc(formData.phone)}" placeholder="0803 123 4567" autocomplete="tel" required aria-required="true" inputmode="tel" />
                  </div>
                  <div class="field">
                    <label for="sex">Sex</label>
                    <select id="sex" name="sex" autocomplete="sex">
                      ${SEXES.map(s => `<option value="${esc(s.value)}"${formData.sex === s.value ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label for="dob">Date of birth</label>
                    <input type="date" id="dob" name="dob" value="${esc(formData.dob)}" autocomplete="bday" max="${new Date().toISOString().split('T')[0]}" />
                  </div>
                  <div class="field">
                    <label for="occupation">Occupation</label>
                    <input type="text" id="occupation" name="occupation" value="${esc(formData.occupation)}" placeholder="e.g. Teacher, Engineer, Student" autocomplete="organization-title" />
                  </div>
                  <div class="field">
                    <label for="payer">Payer / Insurance</label>
                    <select id="payer" name="payer" autocomplete="off">
                      ${payerOpts.map(o => `<option value="${esc(o.value)}"${formData.payer === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field full">
                    <label for="address">Home address (LGA, State)</label>
                    <textarea id="address" name="address" rows="2" placeholder="e.g. 12 Allen Ave, Ikeja, Lagos" autocomplete="street-address">${esc(formData.address)}</textarea>
                  </div>
                </div>
              </fieldset>
            </div>

            <div class="step-panel" data-step="blood" style="${currentStep === 1 ? '' : 'display:none'}">
              <fieldset>
                <legend><span class="legend-icon">🩸</span> Blood Group & Allergies</legend>
                <div class="form-grid">
                  <div class="field">
                    <label for="blood_group">Blood group (ABO/Rh)</label>
                    <select id="blood_group" name="blood_group" autocomplete="off">
                      ${BLOOD_GROUPS.map(b => `<option value="${esc(b.value)}"${formData.blood_group === b.value ? ' selected' : ''}>${esc(b.label || b.value)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label for="genotype">Genotype</label>
                    <select id="genotype" name="genotype" autocomplete="off">
                      ${GENOTYPES.map(g => `<option value="${esc(g.value)}"${formData.genotype === g.value ? ' selected' : ''}>${esc(g.label || g.value)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field full">
                    <label for="allergy">Known allergies</label>
                    <div id="allergyTagContainer" class="allergy-tag-container"></div>
                    <p class="field-hint">Press Enter to add. Click × to remove. Suggestions appear as you type.</p>
                  </div>
                </div>
              </fieldset>
            </div>

            <div class="step-panel" data-step="kin" style="${currentStep === 2 ? '' : 'display:none'}">
              <fieldset>
                <legend><span class="legend-icon">👨‍👩‍👧</span> Next of Kin (Emergency Contact)</legend>
                <div class="form-grid">
                  <div class="field required">
                    <label for="next_of_kin_first_name">First name <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="next_of_kin_first_name" name="next_of_kin_first_name" value="${esc(formData.next_of_kin_first_name)}" placeholder="e.g. Chidi" autocomplete="given-name" required aria-required="true" />
                  </div>
                  <div class="field required">
                    <label for="next_of_kin_last_name">Last name <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="text" id="next_of_kin_last_name" name="next_of_kin_last_name" value="${esc(formData.next_of_kin_last_name)}" placeholder="e.g. Okafor" autocomplete="family-name" required aria-required="true" />
                  </div>
                  <div class="field required">
                    <label for="next_of_kin_phone">Phone (+234) <span class="required-mark" aria-hidden="true">*</span></label>
                    <input type="tel" id="next_of_kin_phone" name="next_of_kin_phone" value="${esc(formData.next_of_kin_phone)}" placeholder="0803 123 4567" autocomplete="tel" inputmode="tel" required aria-required="true" />
                  </div>
                  <div class="field required full">
                    <label for="next_of_kin_address">Address <span class="required-mark" aria-hidden="true">*</span></label>
                    <textarea id="next_of_kin_address" name="next_of_kin_address" rows="2" placeholder="e.g. 12 Allen Ave, Ikeja, Lagos" autocomplete="street-address" required aria-required="true">${esc(formData.next_of_kin_address)}</textarea>
                  </div>
                </div>
                <p class="step-hint">This person will be contacted in case of emergency. All fields are required.</p>
              </fieldset>
            </div>

            <div class="form-actions">
              ${currentStep > 0 ? '<button type="button" class="btn ghost" id="prevBtn">← Previous</button>' : '<div class="spacer"></div>'}
              <div class="actions-right">
                ${currentStep < EDIT_STEPS.length - 1
                  ? '<button type="button" class="btn primary" id="nextBtn">Next →</button>'
                  : `<button type="submit" class="btn primary" id="submitBtn" ${isSubmitting ? 'disabled' : ''}>
                      ${isSubmitting ? '<span class="spinner"></span> Saving…' : 'Save Changes'}
                    </button>`}
              </div>
            </div>
          </form>
        </div>
      `,
    })

    wireForm()
  }

  function wireForm() {
    const form = document.getElementById('editForm')

    // Initialize allergy tag input when blood step is visible
    if (currentStep === 1) {
      initAllergyTagInput()
    }

    document.getElementById('prevBtn')?.addEventListener('click', () => goToStep(currentStep - 1))
    document.getElementById('nextBtn')?.addEventListener('click', () => {
      if (validateCurrentStep()) goToStep(currentStep + 1)
    })

    form.querySelectorAll('.step-dot.done').forEach(dot => {
      dot.style.cursor = 'pointer'
      dot.addEventListener('click', () => goToStep(Number(dot.dataset.step)))
    })

    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      collectFormData()
      submitError = null

      const invalid = validateForm(formData)
      if (invalid) {
        submitError = invalid
        render()
        return
      }

      isSubmitting = true
      const submitBtn = document.getElementById('submitBtn')
      if (submitBtn) {
        submitBtn.disabled = true
        submitBtn.innerHTML = '<span class="spinner"></span> Saving…'
      }

      try {
        // updatePatient RETURNS { warning, existing } for a duplicate match —
        // it does not throw. The old code only inspected the catch block, so a
        // duplicate edit fell through to the success path and toasted "Saved"
        // while nothing had been written.
        const res = await updatePatient(pid, formData)
        if (res && res.warning) {
          isSubmitting = false
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Changes' }
          showDuplicateWarning(res, formData)
          return
        }
        toast('Saved ' + formData.given_names + ' ' + formData.surname + ' to Firestore')
        navigate('/patients/' + pid)
      } catch (e) {
        isSubmitting = false
        submitError = friendlyPatientError(e)
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save Changes' }
        render()
      }
    })

    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        const fields = Array.from(form.querySelectorAll('.step-panel:not([style*="display:none"]) input, .step-panel:not([style*="display:none"]) select'))
        const idx = fields.indexOf(e.target)
        if (idx === fields.length - 1 && currentStep < EDIT_STEPS.length - 1) {
          e.preventDefault()
          if (validateCurrentStep()) goToStep(currentStep + 1)
        }
      }
    })

    form.querySelectorAll('input[type="tel"]').forEach(input => {
      input.addEventListener('input', () => {
        let v = input.value.replace(/\D/g, '')
        if (v.startsWith('234')) v = '0' + v.slice(3)
        if (v.length > 11) v = v.slice(0, 11)
        input.value = v
        formData[input.name] = v
      })
    })
  }

  function initAllergyTagInput() {
    const container = document.getElementById('allergyTagContainer')
    if (!container || allergyTagInput) return

    loadDBAllergies()

    allergyTagInput = createAllergyTagInput(container, {
      value: formData.allergy || [],
      suggestions: mergedAllergySuggestions,
      name: 'allergy',
      onChange: (tags) => { formData.allergy = tags },
    })
  }

  function destroyAllergyTagInput() {
    if (allergyTagInput) {
      allergyTagInput.destroy()
      allergyTagInput = null
    }
  }

  function goToStep(step) {
    if (step < 0 || step >= EDIT_STEPS.length) return
    collectFormData()
    // Destroy allergy tag input when leaving blood step
    if (currentStep === 1 && step !== 1) destroyAllergyTagInput()
    currentStep = step
    const form = document.getElementById('editForm')
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    render()
  }

  function collectFormData() {
    const form = document.getElementById('editForm')
    if (!form) return
    new FormData(form).forEach((v, k) => { formData[k] = v })
    // Allergy is handled separately via tag input hidden field
    const allergyJson = formData.allergy_json
    if (allergyJson) {
      try { formData.allergy = JSON.parse(allergyJson) } catch { formData.allergy = [] }
    } else if (formData.allergy && typeof formData.allergy === 'string') {
      try { formData.allergy = JSON.parse(formData.allergy) } catch { formData.allergy = [] }
    }
  }

  function validateCurrentStep() {
    collectFormData()
    const stepId = EDIT_STEPS[currentStep].id
    if (stepId === 'personal') {
      if (!formData.surname || formData.surname.trim().length < 2) { submitError = 'Surname is required.'; render(); return false }
      if (!formData.given_names || formData.given_names.trim().length < 1) { submitError = 'Given name(s) required.'; render(); return false }
      if (!formData.phone || formData.phone.trim().length < 10) { submitError = 'Enter a valid Nigerian phone number (e.g. 0803 123 4567).'; render(); return false }
      if (formData.dob && !/^\d{4}-\d{2}-\d{2}$/.test(formData.dob)) { submitError = 'Date of birth must be a real date.'; render(); return false }
    }
    if (stepId === 'kin') {
      if (!formData.next_of_kin_first_name || formData.next_of_kin_first_name.trim().length < 1) { submitError = 'Next of kin first name is required.'; render(); return false }
      if (!formData.next_of_kin_last_name || formData.next_of_kin_last_name.trim().length < 1) { submitError = 'Next of kin last name is required.'; render(); return false }
      if (!formData.next_of_kin_phone || formData.next_of_kin_phone.trim().length < 10) { submitError = 'Enter a valid Nigerian phone number for next of kin (e.g. 0803 123 4567).'; render(); return false }
      if (!formData.next_of_kin_address || formData.next_of_kin_address.trim().length < 5) { submitError = 'Next of kin address is required.'; render(); return false }
    }
    submitError = null
    return true
  }

  function validateForm(v) {
    if (!v.surname || v.surname.trim().length < 2) return 'Surname is required.'
    if (!v.given_names || v.given_names.trim().length < 1) return 'Given name(s) required.'
    if (!v.phone || v.phone.trim().length < 10) return 'Enter a valid Nigerian phone number (e.g. 0803 123 4567).'
    if (v.dob && !/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) return 'Date of birth must be a real date.'
    if (!v.next_of_kin_first_name || v.next_of_kin_first_name.trim().length < 1) return 'Next of kin first name is required.'
    if (!v.next_of_kin_last_name || v.next_of_kin_last_name.trim().length < 1) return 'Next of kin last name is required.'
    if (!v.next_of_kin_phone || v.next_of_kin_phone.trim().length < 10) return 'Enter a valid Nigerian phone number for next of kin (e.g. 0803 123 4567).'
    if (!v.next_of_kin_address || v.next_of_kin_address.trim().length < 5) return 'Next of kin address is required.'
    return null
  }

  function showDuplicateWarning(res, data) {
    const { warning, existing } = res
    const modalHtml = `
      <div class="modal-card warning">
        <div class="modal-icon">⚠</div>
        <h3>Possible Duplicate Patient</h3>
        <p>${esc(warning.message)}</p>
        <div class="kv">
          <div><em>Existing patient</em><strong>${esc(existing.name)}</strong></div>
          <div><em>MRN</em><strong>${esc(existing.mrn)}</strong></div>
          <div><em>Phone</em><strong>${esc(formatPhone(existing.phone, existing.phone_key))}</strong></div>
        </div>
        <p class="modal-hint">Save anyway if this is a different person.</p>
      </div>
    `
    import('../components/shell.js').then(({ formModal, closeModal }) => {
      formModal({
        title: 'Possible duplicate patient',
        submitLabel: 'Save anyway',
        body: modalHtml,
        onSubmit: async () => {
          closeModal()
          try {
            await updatePatient(pid, { ...data, force: true })
            toast('Saved ' + data.given_names + ' ' + data.surname + ' to Firestore')
            navigate('/patients/' + pid)
          } catch (e) {
            submitError = friendlyPatientError(e)
            render()
          }
        },
      })
    })
  }

  render()
}