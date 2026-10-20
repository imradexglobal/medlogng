// Delete-system tests: capability gate, org ownership, state guards.
//
// Runs the real src/services/deleteService.js against the in-memory Firestore,
// so the load → guard → delete → audit sequence is exercised end to end.

import assert from 'node:assert/strict'
import { signIn, seedDocs, docData, allDocs } from './harness.mjs'

const {
  canDeleteRecords, requireDeleteCap, requireOwnOrg,
  deletePatient, deleteEncounter, deleteAppointment, deleteAdmission,
  deleteLabOrder, deleteImagingOrder, deleteDrug, deleteMedicationRequest,
  deleteInvoice, deleteLabTest, deletePatientDocument, deletePatientRow,
} = await import('../../src/services/deleteService.js')

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  ' + name) })
    .catch((e) => {
      console.error('  FAIL ' + name)
      console.error('       ' + (e?.message || e))
      if (e?.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
      process.exitCode = 1
    })
}

async function rejects(promise, pattern, label) {
  try {
    await promise
  } catch (e) {
    assert.match(e.message, pattern, label)
    return
  }
  assert.fail(label || 'expected rejection: ' + pattern)
}

const own = (coll, id, over = {}) => ({ 'organization_id': 'org_1', ...over })

// ---- capability gate --------------------------------------------------------
await test('canDeleteRecords: hospital_admin holds it via *', async () => {
  await signIn('hospital_admin')
  assert.equal(canDeleteRecords(), true)
})

await test('nurse preset does NOT carry data.delete', async () => {
  await signIn('nurse')
  assert.equal(canDeleteRecords(), false)
  assert.throws(() => requireDeleteCap(), /cannot delete records/)
})

// ---- org ownership ----------------------------------------------------------
await test('requireOwnOrg blocks a doc owned by another hospital', async () => {
  await signIn('hospital_admin', 'org_1')
  assert.throws(
    () => requireOwnOrg({ organization_id: 'org_2' }, 'This patient'),
    /different hospital/,
  )
  // Own-org docs pass silently.
  requireOwnOrg({ organization_id: 'org_1' })
})

await test('deleteAppointment refuses a cross-hospital record', async () => {
  await signIn('hospital_admin', 'org_1')
  seedDocs({ 'appointments/ap_1': own('appointments', 'ap_1', { organization_id: 'org_2', patient_id: 'p1' }) })
  await rejects(deleteAppointment('ap_1'), /different hospital/, 'cross-org appointment')
  assert.ok(docData('appointments/ap_1'), 'the foreign appointment still exists')
})

// ---- appointments (happy path + audit) --------------------------------------
await test('deleteAppointment removes the doc and appends an audit event', async () => {
  await signIn('hospital_admin', 'org_1')
  seedDocs({ 'appointments/ap_2': own('appointments', 'ap_2', { patient_id: 'p9', patient_name: 'Okoro Ada', time: '10:00' }) })
  await deleteAppointment('ap_2')
  assert.equal(docData('appointments/ap_2'), undefined)
  const audits = allDocs('audit_events')
  assert.equal(audits.length, 1, 'one audit event')
  assert.match(audits[0].data.action, /data\.appointment\.deleted/)
  assert.equal(audits[0].data.actor_organization_id, 'org_1')
  assert.equal(audits[0].data.patient_id, 'p9')
})

// ---- lab orders -------------------------------------------------------------
await test('deleteLabOrder refuses when a result has been released', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'lab_orders/lo_1': own('lab_orders', 'lo_1', {
      patient_id: 'p1', order_no: 'L-1',
      items: [{ status: 'released' }, { status: 'received' }],
    }),
  })
  await rejects(deleteLabOrder('lo_1'), /released/, 'released order')
  assert.ok(docData('lab_orders/lo_1'))
})

await test('deleteLabOrder refuses once tied to an invoice', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'lab_orders/lo_2': own('lab_orders', 'lo_2', {
      patient_id: 'p1', invoice_id: 'inv_7', billing_status: 'invoiced',
      items: [{ status: 'received' }],
    }),
    // The invoice must still exist for it to anchor the order; a dangling
    // invoice_id (its invoice already deleted) blocks nothing.
    'invoices/inv_7': own('invoices', 'inv_7', { patient_id: 'p1' }),
  })
  await rejects(deleteLabOrder('lo_2'), /invoice/, 'invoiced order')
})

await test('deleteLabOrder removes a clean unreleased, uninvoiced order', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'lab_orders/lo_3': own('lab_orders', 'lo_3', {
      patient_id: 'p1', order_no: 'L-3', items: [{ status: 'ordered' }, { status: 'sample_collected' }],
    }),
  })
  await deleteLabOrder('lo_3')
  assert.equal(docData('lab_orders/lo_3'), undefined)
})

// ---- imaging ----------------------------------------------------------------
await test('deleteImagingOrder refuses a verified order', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'imaging_orders/io_1': own('imaging_orders', 'io_1', { patient_id: 'p1', status: 'verified' }) })
  await rejects(deleteImagingOrder('io_1'), /verified/, 'verified imaging')
})

// ---- drugs ------------------------------------------------------------------
await test('deleteDrug refuses while stock > 0', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'stock_lots/l1': own('stock_lots', 'l1', { name: 'Metformin', stock: 40 }) })
  await rejects(deleteDrug('l1'), /40 unit/, 'stocked drug')
})

await test('deleteDrug removes a zero-stock lot', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'stock_lots/l2': own('stock_lots', 'l2', { name: 'Ibuprofen', stock: 0 }) })
  await deleteDrug('l2')
  assert.equal(docData('stock_lots/l2'), undefined)
})

// ---- prescriptions ----------------------------------------------------------
await test('deleteMedicationRequest refuses once anything is dispensed', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'medication_requests/r1': own('medication_requests', 'r1', {
      patient_id: 'p1', items: [{ drug_name: 'Metformin', qty: 20, dispensed_qty: 5 }],
    }),
  })
  await rejects(deleteMedicationRequest('r1'), /dispensed/, 'partly dispensed')
})

await test('deleteMedicationRequest removes an untouched script', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'medication_requests/r2': own('medication_requests', 'r2', {
      patient_id: 'p1', items: [{ drug_name: 'Paracetamol', qty: 10, dispensed_qty: 0 }],
    }),
  })
  await deleteMedicationRequest('r2')
  assert.equal(docData('medication_requests/r2'), undefined)
})

// ---- invoices ---------------------------------------------------------------
await test('deleteInvoice refuses once money has been received', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'invoices/i1': own('invoices', 'i1', { patient_id: 'p1', paid_kobo: 250000, invoice_id: 'INV-1' }) })
  await rejects(deleteInvoice('i1'), /2,?500/, 'paid invoice')
  // A merely-discounted but unpaid invoice still counts as unpaid.
  seedDocs({
    'invoices/i1': own('invoices', 'i1', { patient_id: 'p1', paid_kobo: 0, discount_kobo: 10000 }),
    'invoices/i2': own('invoices', 'i2', { patient_id: 'p1', paid_kobo: 0 }),
  })
  await deleteInvoice('i2')
  assert.equal(docData('invoices/i2'), undefined)
})

// ---- admissions -------------------------------------------------------------
await test('deleteAdmission refuses while active (bed still held)', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'admissions/a1': own('admissions', 'a1', { patient_id: 'p1', status: 'active', ward_name: 'Male Ward', bed_number: 'B3' }) })
  await rejects(deleteAdmission('a1'), /Discharge/, 'active admission')
})

await test('deleteAdmission removes a discharged admission', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'admissions/a2': own('admissions', 'a2', { patient_id: 'p1', status: 'discharged' }) })
  await deleteAdmission('a2')
  assert.equal(docData('admissions/a2'), undefined)
})

// ---- encounters -------------------------------------------------------------
await test('deleteEncounter refuses while open', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'encounters/e1': own('encounters', 'e1', { patient_id: 'p1', status: 'open' }) })
  await rejects(deleteEncounter('e1'), /closed encounter/, 'open encounter')
})

await test('deleteEncounter removes a closed encounter and cascades its rows in-org', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'encounters/e2': own('encounters', 'e2', { patient_id: 'p1', status: 'closed', patient_name: 'Okoro Ada' }),
    'vitals/v1': own('vitals', 'v1', { encounter_id: 'e2', organization_id: 'org_1' }),
    'vitals/v2': own('vitals', 'v2', { encounter_id: 'e2', organization_id: 'org_1' }),
    'vitals/v_other': own('vitals', 'v_other', { encounter_id: 'e2', organization_id: 'org_2' }),
    'diagnoses/d1': own('diagnoses', 'd1', { encounter_id: 'e2', organization_id: 'org_1', condition: 'Malaria' }),
    'clinical_notes/n1': own('clinical_notes', 'n1', { encounter_id: 'e2', organization_id: 'org_1' }),
    'vitals/v_unrelated': own('vitals', 'v_unrelated', { encounter_id: 'e9', organization_id: 'org_1' }),
  })
  await deleteEncounter('e2')
  assert.equal(docData('encounters/e2'), undefined)
  assert.equal(docData('vitals/v1'), undefined, 'in-org child vitals cascade')
  assert.equal(docData('vitals/v2'), undefined)
  assert.equal(docData('diagnoses/d1'), undefined, 'in-org diagnoses cascade')
  assert.equal(docData('clinical_notes/n1'), undefined, 'in-org notes cascade')
  assert.ok(docData('vitals/v_other'), 'another hospital\'s row is untouched')
  assert.ok(docData('vitals/v_unrelated'), 'a different encounter\'s row is untouched')
})

// ---- patients ---------------------------------------------------------------
await test('deletePatient refuses when this hospital has clinical history', async () => {
  await signIn('hospital_admin')
  seedDocs({
    'patients/p1': own('patients', 'p1', { full_name: 'Okoro Ada', status: 'active' }),
    'encounters/e3': own('encounters', 'e3', { patient_id: 'p1' }),
  })
  await rejects(deletePatient('p1'), /clinical history/, 'patient with history')
  assert.ok(docData('patients/p1'))
})

await test('deletePatient removes a clean patient and the org link', async () => {
  await signIn('hospital_admin', 'org_1')
  seedDocs({
    'patients/p2': own('patients', 'p2', { full_name: 'Eze Chidi', status: 'active' }),
    'organization_patients/org_1_p2': own('organization_patients', 'org_1_p2', { patient_id: 'p2' }),
  })
  await deletePatient('p2')
  assert.equal(docData('patients/p2'), undefined)
  assert.equal(docData('organization_patients/org_1_p2'), undefined, 'org link removed')
})

await test('deletePatient refuses a merged_into patient', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'patients/p3': own('patients', 'p3', { full_name: 'Old Record', status: 'merged_into', merged_into: 'p1' }) })
  await rejects(deletePatient('p3'), /merged patient/, 'merged patient')
})

// ---- catalogue / documents / rows -------------------------------------------
await test('deleteLabTest removes a catalogue entry', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'lab_test_catalogue/t1': own('lab_test_catalogue', 't1', { code: 'FBC', name: 'Full Blood Count' }) })
  await deleteLabTest('t1')
  assert.equal(docData('lab_test_catalogue/t1'), undefined)
})

await test('deletePatientDocument removes the document', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'documents/doc1': own('documents', 'doc1', { patient_id: 'p1', name: 'referral.pdf' }) })
  await deletePatientDocument('doc1')
  assert.equal(docData('documents/doc1'), undefined)
})

await test('deletePatientRow removes a timeline row', async () => {
  await signIn('hospital_admin')
  seedDocs({ 'diagnoses/d2': own('diagnoses', 'd2', { patient_id: 'p1', condition: 'Typhoid' }) })
  await deletePatientRow('diagnoses', 'd2', 'Diagnosis')
  assert.equal(docData('diagnoses/d2'), undefined)
})

await test('deletePatientRow refuses collections outside the allowed list', async () => {
  await signIn('hospital_admin')
  await rejects(
    deletePatientRow('payments', 'pay_1', 'Payment'),
    /cannot be deleted/,
    'append-only ledger via generic row delete',
  )
})

// ---- summary ----------------------------------------------------------------
await test('summary line', () => {
  console.log('\n  ' + passed + ' delete-system tests passed')
})

process.exit(process.exitCode || 0)
