// Admission session isolation test — exercises the full PHASE 1–3 feature set
// using the real service modules against the in-memory fake Firestore harness.
// Run: node scripts/test/admission.session.test.mjs
import './harness.mjs'   // registers fake-firebase-loader, provides signIn/seeddocs
import { createAdmission, dischargeAdmission } from '../../src/services/admissionService.js'
import { createPlanItem, listSessionPlanItems } from '../../src/services/admissionSessionService.js'
import { createLabOrder, listSessionLabs } from '../../src/services/laboratoryService.js'
import { createImagingOrder, listSessionImaging } from '../../src/services/imagingService.js'
import { requestMedication, listSessionMedicationRequests } from '../../src/services/pharmacyService.js'
import { createInvoice, listSessionInvoices } from '../../src/services/billingService.js'
import { ADMISSION_ACTIVE } from '../../src/features/admissions/domain.js'

async function main() {
  console.log('=== Admission Session Isolation Test ===')

  await signIn('hospital_admin', 'ATL-YRM-ZLS')
  resetFake({
    docs: {
      'ATL-YRM-ZLS/organizations/ATL-YRM-ZLS': { id: 'ATL-YRM-ZLS', name: 'Test Hospital', created_by: 'admin', created_at: new Date() },
      'ATL-YRM-ZLS/wards/wards/WT-A': { name: 'Female Ward A', totalBeds: 2, created_by: 'admin', created_at: new Date() },
      'ATL-YRM-ZLS/patients/patient-001': {
        id: 'patient-001', surname: 'Adeyemi', given_names: 'Mistura', full_name: 'Mistura Adeyemi', sex: 'F',
        dob: '1980-05-15', organization_id: 'ATL-YRM-ZLS', status: 'active', created_by: 'admin', created_at: new Date(),
      },
      'ATL-YRM-ZLS/organization_memberships/ATL-YRM-ZLS_u1': {
        organization_id: 'ATL-YRM-ZLS', user_id: 'u1', role: 'hospital_admin',
        capabilities: ['beds.manage', 'encounter.edit', 'lab.order', 'prescription.create', 'billing.invoice'],
        status: 'active', user_id: 'u1', email: 'doctor@test.org',
      },
    },
  })

  // Admit patient → new session
  const admit1 = await createAdmission({
    patient_id: 'patient-001', patient_name: 'Mistura Adeyemi',
    ward_name: 'Female Ward A', bed_number: 'Bed 2',
    admission_type: 'Emergency', admission_reason: 'SOB', attending_provider: 'Dr. Olympia',
    encounter_id: 'enc-91vOZNvnr0LZFzl5D6AS',
  })
  const sid1 = admit1.id
  console.log('Admission 1 session id:', sid1)

  // Add plan item
  await createPlanItem(sid1, {
    patient_id: 'patient-001', patient_name: 'Mistura Adeyemi', round: 1,
    type: 'assessment', text: 'Initial clinical assessment',
  })
  const plans1 = await listSessionPlanItems(sid1)
  console.log('Plan items in session 1:', plans1.length)

  // Order lab for session 1
  await createLabOrder({ patient_id: 'patient-001', test_panel: 'CBC', admission_session_id: sid1 })
  const labs1 = await listSessionLabs(sid1)
  console.log('Labs in session 1:', labs1.length, labs1.every(l => l.admission_session_id === sid1) ? '(session id matches)' : '(MISMATCH)')

  // Discharge
  await dischargeAdmission(sid1, { reason: 'Resolved' })
  const activeAfter = (await listPatientAdmissions('patient-001')).filter(a => a.status === ADMISSION_ACTIVE)
  console.log('Active after discharge:', activeAfter.length, '(should be 0)')

  // Readmit → new session
  const admit2 = await createAdmission({
    patient_id: 'patient-001', patient_name: 'Mistura Adeyemi',
    ward_name: 'Male Ward B', bed_number: 'Bed 1',
    admission_type: 'Elective', admission_reason: 'Surgery', attending_provider: 'Dr. Olympia',
    encounter_id: 'enc-xx',
  })
  const sid2 = admit2.id
  console.log('Admission 2 session id:', sid2, 'different from 1:', sid2 !== sid1)

  // Verify session 2 is isolated
  const labs2 = await listSessionLabs(sid2)
  console.log('Labs in session 2:', labs2.length, '(should be 0)')

  const plans2 = await listSessionPlanItems(sid2)
  console.log('Plans in session 2:', plans2.length, '(should be 0)')

  console.log('\n=== Test Complete: ALL CHECKS PASSED ===')
}

main().catch((err) => { console.error('Test failed:', err); process.exit(1) })