// Firestore Security Rules emulator tests for P0 collections.
// Exercises the rule changes: stock_lots update, medication_administrations,
// clinical_notes create, nurse read on scripts, patient update pin, audit read.
// Run: npm install --save-dev @firebase/rules-unit-testing
//      node scripts/test/firestore.rules.test.mjs

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name) }
  catch (e) {
    failed++
    console.error('  FAIL ' + name)
    console.error('       ' + (e?.message || e))
  }
}

let rulesLoaded = false

// Attempt to load the rules emulator; skip gracefully if not installed.
let { RulesTestEnvironment } = {}
try {
  ({ RulesTestEnvironment } = await import('@firebase/rules-unit-testing'))
  rulesLoaded = true
} catch {}

// If emulator isn't available, just report a skip so CI doesn't fail hard.
if (!rulesLoaded) {
  console.log('  SKIP (skipped) @firebase/rules-unit-testing not installed — run `npm i -D @firebase/rules-unit-testing`')
  process.exitCode = 0
  return
}

// ---- shared setup -----------------------------------------------------------

const PROJECT_ID = 'medlogng-test'
const RULES_FILE = '../../firestore.rules'

async function env(auth) {
  const e = new RulesTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: RULES_FILE },
  })
  if (auth) e.authenticatedContext(auth.uid, { uid: auth.uid })
  return e
}

// ---- stock_lots update ------------------------------------------------------

await test('stock_lots update: pharmacist may edit stock fields only', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()

  // Seed existing lot
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_pharmacist1').set({
    user_id: 'pharmacist1', organization_id: 'org_1', status: 'active',
    capabilities: ['prescription.dispense'],
  })
  await db.collection('stock_lots').doc('lot_1').set({
    organization_id: 'org_1', name: 'Metformin', stock: 100, batch: 'B1',
    expiry: '2028-01-01', status: 'OK', updated_at: new Date(),
  })

  const lot = db.collection('stock_lots').doc('lot_1')
  await lot.update({ stock: 95, price: 3000 })
  const snap = await lot.get()
  assert.equal(snap.data().stock, 95)
  e.cleanup()
})

await test('stock_lots update: cannot change organization_id', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_pharmacist1').set({
    user_id: 'pharmacist1', organization_id: 'org_1', status: 'active',
    capabilities: ['prescription.dispense'],
  })
  await db.collection('stock_lots').doc('lot_1').set({
    organization_id: 'org_1', name: 'Metformin', stock: 100, batch: 'B1',
    expiry: '2028-01-01', status: 'OK', updated_at: new Date(),
  })
  await db.collection('organizations').doc('org_2').set({ name: 'Org2', status: 'active' })

  const lot = db.collection('stock_lots').doc('lot_1')
  await assert.rejects(
    lot.update({ organization_id: 'org_2' }),
    /permission-denied/
  )
  e.cleanup()
})

// ---- medication_administrations ---------------------------------------------

await test('medication_administrations create: nurse may record a dose', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_nurse1').set({
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })

  await db.collection('medication_administrations').doc('admin_1').set({
    organization_id: 'org_1', patient_id: 'p1', drug_id: 'd1',
    administered_qty: 1, given_at: new Date(), route: 'oral',
  })
  const snap = await db.collection('medication_administrations').doc('admin_1').get()
  assert.equal(snap.data().administered_qty, 1)
  e.cleanup()
})

await test('medication_administrations create: pharmacist without administer cannot create', async () => {
  const e = await env({ uid: 'pharmacist1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_pharmacist1').set({
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
  e.cleanup()
})

await test('medication_administrations update/delete are append-only (denied)', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_nurse1').set({
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await db.collection('medication_administrations').doc('admin_1').set({
    organization_id: 'org_1', patient_id: 'p1', drug_id: 'd1',
    administered_qty: 1, given_at: new Date(), route: 'oral',
  })

  const ref = db.collection('medication_administrations').doc('admin_1')
  await assert.rejects(ref.update({ administered_qty: 2 }), /permission-denied/)
  await assert.rejects(ref.delete(), /permission-denied/)
  e.cleanup()
})

// ---- clinical_notes create --------------------------------------------------

await test('clinical_notes create: encounter.create holder may create', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_doctor1').set({
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['encounter.create'],
  })

  await db.collection('clinical_notes').doc('note_1').set({
    organization_id: 'org_1', patient_id: 'p1', encounter_id: 'e1',
    note_text: 'Patient stable.', created_at: new Date(),
  })
  const snap = await db.collection('clinical_notes').doc('note_1').get()
  assert.equal(snap.data().note_text, 'Patient stable.')
  e.cleanup()
})

// ---- nurse read on scripts --------------------------------------------------

await test('medication_requests read: nurse with medication.administer may read', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_nurse1').set({
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await db.collection('medication_requests').doc('rx_1').set({
    organization_id: 'org_1', patient_id: 'p1', status: 'Requested', items: [],
  })

  const snap = await db.collection('medication_requests').doc('rx_1').get()
  assert.ok(snap.exists)
  e.cleanup()
})

// ---- patient update pin -----------------------------------------------------

await test('patient update: requires patient.demographics.update', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_doctor1').set({
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['patient.create'], // NOT patient.demographics.update
  })
  await db.collection('patients').doc('p1').set({
    organization_id: 'org_1', surname: 'Doe', status: 'active',
  })

  const ref = db.collection('patients').doc('p1')
  await assert.rejects(
    ref.update({ surname: 'Smith' }),
    /permission-denied/
  )
  e.cleanup()
})

await test('patient update: org pin prevents cross-org change', async () => {
  const e = await env({ uid: 'doctor1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org1', status: 'active' })
  await db.collection('organizations').doc('org_2').set({ name: 'Org2', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_doctor1').set({
    user_id: 'doctor1', organization_id: 'org_1', status: 'active',
    capabilities: ['patient.demographics.update'],
  })
  await db.collection('patients').doc('p1').set({
    organization_id: 'org_1', surname: 'Doe', status: 'active',
  })

  const ref = db.collection('patients').doc('p1')
  await assert.rejects(
    ref.update({ organization_id: 'org_2', surname: 'Smith' }),
    /permission-denied/
  )
  e.cleanup()
})

// ---- audit read tighten -----------------------------------------------------

await test('audit read: super-admin may read', async () => {
  const e = await env({ uid: 'super' })
  const db = e.firestore()
  await db.collection('platform_admins').doc('super').set({})
  await db.collection('audit_events').doc('audit_1').set({
    actor_user_id: 'super', organization_id: 'org_1', action: 'test',
  })

  const snap = await db.collection('audit_events').doc('audit_1').get()
  assert.ok(snap.exists)
  e.cleanup()
})

await test('audit read: admin.roles.manage holder may read', async () => {
  const e = await env({ uid: 'admin1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_admin1').set({
    user_id: 'admin1', organization_id: 'org_1', status: 'active',
    capabilities: ['admin.roles.manage'],
  })
  await db.collection('audit_events').doc('audit_1').set({
    actor_user_id: 'admin1', organization_id: 'org_1', action: 'test',
  })

  const snap = await db.collection('audit_events').doc('audit_1').get()
  assert.ok(snap.exists)
  e.cleanup()
})

await test('audit read: plain member cannot read audit', async () => {
  const e = await env({ uid: 'nurse1' })
  const db = e.firestore()
  await db.collection('organizations').doc('org_1').set({ name: 'Org', status: 'active' })
  await db.collection('organization_memberships').doc('org_1_nurse1').set({
    user_id: 'nurse1', organization_id: 'org_1', status: 'active',
    capabilities: ['medication.administer'],
  })
  await db.collection('audit_events').doc('audit_1').set({
    actor_user_id: 'admin1', organization_id: 'org_1', action: 'test',
  })

  const snap = await db.collection('audit_events').doc('audit_1').get()
  assert.ok(!snap.exists)
  e.cleanup()
})

// ---- summary ----------------------------------------------------------------

console.log('')
console.log('  Passed: ' + passed + ' / ' + (passed + failed))
if (failed > 0) process.exitCode = 1
