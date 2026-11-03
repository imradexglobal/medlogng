// Firestore Security Rules emulator tests for P0 collections.
// Exercises the rule changes: stock_lots update, medication_administrations,
// clinical_notes create, nurse read on scripts, patient update pin, audit read.
// Run: npm install --save-dev @firebase/rules-unit-testing
//      node scripts/test/firestore.rules.test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let passed = 0
let failed = 0
const activeEnvironments = new Set()

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name) }
  catch (e) {
    failed++
    console.error('  FAIL ' + name)
    console.error('       ' + (e?.message || e))
  } finally {
    // A failed assertion must not leave Firestore SDK clients holding open
    // sockets and hanging the test process.
    for (const cleanup of [...activeEnvironments]) await cleanup()
  }
}

let rulesLoaded = false

// Attempt to load the rules emulator; skip gracefully if not installed.
let { initializeTestEnvironment } = {}
try {
  ({ initializeTestEnvironment } = await import('@firebase/rules-unit-testing'))
  rulesLoaded = true
} catch {}

// If emulator isn't available, just report a skip so CI doesn't fail hard.
if (!rulesLoaded || !process.env.FIRESTORE_EMULATOR_HOST) {
  const reason = !rulesLoaded
    ? 'not installed — run `npm i -D @firebase/rules-unit-testing@^5`'
    : 'Firestore emulator is not running — run `firebase emulators:exec --only firestore --project medlogng-test "node scripts/test/firestore.rules.test.mjs"`'
  console.log('  SKIP (skipped) ' + reason)
  process.exitCode = 0
} else {

// ---- shared setup -----------------------------------------------------------

const PROJECT_ID = 'medlogng-test'
const RULES_SOURCE = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8')

async function env(auth) {
  const e = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES_SOURCE },
  })
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    activeEnvironments.delete(cleanup)
    await e.cleanup()
  }
  activeEnvironments.add(cleanup)
  await e.clearFirestore()
  const context = auth ? e.authenticatedContext(auth.uid) : e.unauthenticatedContext()
  return {
    firestore: () => context.firestore(),
    seed: async (collectionName, id, data) => e.withSecurityRulesDisabled(async (admin) => {
      await admin.firestore().collection(collectionName).doc(id).set(data)
    }),
    cleanup,
  }
}

// ---- stock_lots update ------------------------------------------------------

await test('stock_lots update: pharmacist may edit stock fields only', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()

  // Seed existing lot
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_pharmacist1', {
    user_id: 'pharmacist1', organization_id: 'org_1', status: 'active',
    capabilities: ['prescription.dispense'],
  })
  await e.seed('stock_lots', 'lot_1', {
    organization_id: 'org_1', name: 'Metformin', stock: 100, batch: 'B1',
    expiry: '2028-01-01', status: 'OK', updated_at: new Date(),
  })

  const lot = db.collection('stock_lots').doc('lot_1')
  await lot.update({ stock: 95, price: 3000 })
  const snap = await lot.get()
  assert.equal(snap.data().stock, 95)
  await e.cleanup()
})

await test('stock_lots update: cannot change organization_id', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_pharmacist1', {
    user_id: 'pharmacist1', organization_id: 'org_1', status: 'active',
    capabilities: ['prescription.dispense'],
  })
  await e.seed('stock_lots', 'lot_1', {
    organization_id: 'org_1', name: 'Metformin', stock: 100, batch: 'B1',
    expiry: '2028-01-01', status: 'OK', updated_at: new Date(),
  })
  await e.seed('organizations', 'org_2', { name: 'Org2', status: 'active' })

  const lot = db.collection('stock_lots').doc('lot_1')
  await assert.rejects(
    lot.update({ organization_id: 'org_2' }),
    /permission-denied/
  )
  await e.cleanup()
})

// ---- medication_administrations ---------------------------------------------

await test('medication_administrations create: nurse may record a dose', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_nurse1', {
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })

  await db.collection('medication_administrations').doc('admin_1').set({
    organization_id: 'org_1', patient_id: 'p1', drug_id: 'd1',
    administered_qty: 1, given_at: new Date(), route: 'oral',
  })
  const snap = await db.collection('medication_administrations').doc('admin_1').get()
  assert.equal(snap.data().administered_qty, 1)
  await e.cleanup()
})

await test('medication_administrations create: pharmacist without administer cannot create', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_pharmacist1', {
    user_id: 'pharmacist1', organization_id: 'org_1', status: 'active',
    capabilities: ['prescription.dispense'],
  })

  await assert.rejects(
    db.collection('medication_administrations').doc('admin_1').set({
      organization_id: 'org_1', patient_id: 'p1', drug_id: 'd1',
      administered_qty: 1, given_at: new Date(), route: 'oral',
    }),
    /permission-denied/
  )
  await e.cleanup()
})

await test('medication_administrations update/delete are append-only (denied)', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_nurse1', {
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await e.seed('medication_administrations', 'admin_1', {
    organization_id: 'org_1', patient_id: 'p1', drug_id: 'd1',
    administered_qty: 1, given_at: new Date(), route: 'oral',
  })

  const ref = db.collection('medication_administrations').doc('admin_1')
  await assert.rejects(ref.update({ administered_qty: 2 }), /permission-denied/)
  await assert.rejects(ref.delete(), /permission-denied/)
  await e.cleanup()
})

// ---- clinical_notes create --------------------------------------------------

await test('clinical_notes create: encounter.create holder may create', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_doctor1', {
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['encounter.create'],
  })

  await db.collection('clinical_notes').doc('note_1').set({
    organization_id: 'org_1', patient_id: 'p1', encounter_id: 'e1',
    note_text: 'Patient stable.', created_at: new Date(),
  })
  const snap = await db.collection('clinical_notes').doc('note_1').get()
  assert.equal(snap.data().note_text, 'Patient stable.')
  await e.cleanup()
})

// ---- nurse read on scripts --------------------------------------------------

await test('medication_requests read: nurse with medication.administer may read', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_nurse1', {
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await e.seed('medication_requests', 'rx_1', {
    organization_id: 'org_1', patient_id: 'p1', status: 'Requested', items: [],
  })

  const snap = await db.collection('medication_requests').doc('rx_1').get()
  assert.ok(snap.exists)
  await e.cleanup()
})

// ---- patient update pin -----------------------------------------------------

await test('patient update: requires patient.demographics.update', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_doctor1', {
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['patient.create'], // NOT patient.demographics.update
  })
  await e.seed('patients', 'p1', {
    organization_id: 'org_1', surname: 'Doe', status: 'active',
  })

  const ref = db.collection('patients').doc('p1')
  await assert.rejects(
    ref.update({ surname: 'Smith' }),
    /permission-denied/
  )
  await e.cleanup()
})

await test('patient update: org pin prevents cross-org change', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org1', status: 'active' })
  await e.seed('organizations', 'org_2', { name: 'Org2', status: 'active' })
  await e.seed('organization_memberships', 'org_1_doctor1', {
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['patient.demographics.update'],
  })
  await e.seed('patients', 'p1', {
    organization_id: 'org_1', surname: 'Doe', status: 'active',
  })

  const ref = db.collection('patients').doc('p1')
  await assert.rejects(
    ref.update({ organization_id: 'org_2', surname: 'Smith' }),
    /permission-denied/
  )
  await e.cleanup()
})

// ---- audit read tighten -----------------------------------------------------

await test('audit read: super-admin may read', async () => {
  const e = await env({ uid: 'super' })
  const db = e.firestore()
  await e.seed('platform_admins', 'super', {})
  await e.seed('audit_events', 'audit_1', {
    actor_user_id: 'super', organization_id: 'org_1', action: 'test',
  })

  const snap = await db.collection('audit_events').doc('audit_1').get()
  assert.ok(snap.exists)
  await e.cleanup()
})

await test('audit read: admin.roles.manage holder may read', async () => {
  const e = await env({ uid: 'admin1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_admin1', {
    user_id: 'admin1', organization_id: 'org_1', status: 'active',
    capabilities: ['admin.roles.manage'],
  })
  await e.seed('audit_events', 'audit_1', {
    actor_user_id: 'admin1', organization_id: 'org_1', action: 'test',
  })

  const snap = await db.collection('audit_events').doc('audit_1').get()
  assert.ok(snap.exists)
  await e.cleanup()
})

await test('audit read: plain member cannot read audit', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_nurse1', {
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await e.seed('audit_events', 'audit_1', {
    actor_user_id: 'admin1', organization_id: 'org_1', action: 'test',
  })

  await assert.rejects(
    db.collection('audit_events').doc('audit_1').get(),
    /permission-denied/,
    'unauthorized audit reads must be denied, not returned as an empty document',
  )
  await e.cleanup()
})

// ---- bed_claims (stale claim takeover) --------------------------------------

async function bedClaimEnv(uid = 'nurse1') {
  const e = await env({ uid })
  await e.seed('organizations', 'org_1', { name: 'Org', status: 'active' })
  await e.seed('organization_memberships', 'org_1_' + uid, {
    user_id: uid, organization_id: 'org_1', status: 'active',
    capabilities: ['beds.manage'],
  })
  return e
}

function admissionDoc(id, overrides = {}) {
  return {
    organization_id: 'org_1', patient_id: 'p_' + id, status: 'active',
    ward_name: 'Ward A', bed_number: 'B1', ...overrides,
  }
}

function claimDoc(admissionId, overrides = {}) {
  return {
    organization_id: 'org_1', admission_id: admissionId,
    ward_name: 'Ward A', bed_number: 'B1', ...overrides,
  }
}

await test('bed_claims read: missing claim is a free bed, not a permission error', async () => {
  const e = await bedClaimEnv()
  const db = e.firestore()

  const snap = await db.collection('bed_claims').doc('org_1_ward-a_b1').get()
  assert.equal(snap.exists, false)
  await e.cleanup()
})

await test('bed_claims create: claiming a free bed for an active admission is allowed', async () => {
  const e = await bedClaimEnv()
  const db = e.firestore()

  const batch = db.batch()
  batch.set(db.collection('admissions').doc('adm_new'), admissionDoc('adm_new'))
  batch.set(db.collection('bed_claims').doc('org_1_ward-a_b1'), claimDoc('adm_new'))
  await batch.commit()

  const snap = await db.collection('bed_claims').doc('org_1_ward-a_b1').get()
  assert.equal(snap.data().admission_id, 'adm_new')
  await e.cleanup()
})

await test('bed_claims update: stale claim from a discharged stay may be taken over', async () => {
  const e = await bedClaimEnv()
  const db = e.firestore()
  // The previous stay still sits in Ward A / B1 but has been discharged, so
  // its leftover claim must not lock the bed forever.
  await e.seed('admissions', 'adm_old', admissionDoc('adm_old', { status: 'discharged' }))
  await e.seed('bed_claims', 'org_1_ward-a_b1', claimDoc('adm_old'))

  const batch = db.batch()
  batch.set(db.collection('admissions').doc('adm_new'), admissionDoc('adm_new'))
  batch.set(db.collection('bed_claims').doc('org_1_ward-a_b1'), claimDoc('adm_new'))
  await batch.commit()

  const snap = await db.collection('bed_claims').doc('org_1_ward-a_b1').get()
  assert.equal(snap.data().admission_id, 'adm_new')
  await e.cleanup()
})

await test('bed_claims update: live claim for the same bed cannot be overwritten', async () => {
  const e = await bedClaimEnv()
  const db = e.firestore()
  await e.seed('admissions', 'adm_old', admissionDoc('adm_old'))
  await e.seed('bed_claims', 'org_1_ward-a_b1', claimDoc('adm_old'))

  const batch = db.batch()
  batch.set(db.collection('admissions').doc('adm_new'), admissionDoc('adm_new'))
  batch.set(db.collection('bed_claims').doc('org_1_ward-a_b1'), claimDoc('adm_new'))
  await assert.rejects(batch.commit(), /permission-denied/)
  await e.cleanup()
})

await test('bed_claims delete: orphan claim (holder removed) may be released', async () => {
  const e = await bedClaimEnv()
  await e.seed('bed_claims', 'org_1_ward-a_b1', claimDoc('adm_deleted'))

  await e.firestore().collection('bed_claims').doc('org_1_ward-a_b1').delete()
  await e.cleanup()
})

// ---- summary ----------------------------------------------------------------

console.log('')
console.log('  Passed: ' + passed + ' / ' + (passed + failed))
if (failed > 0) process.exitCode = 1
}
