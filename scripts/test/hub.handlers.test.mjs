// Hub handler tests — with fake Firestore ownership
// Run with: node scripts/test/hub.handlers.test.mjs
// Tests rx_mirror and lab_snapshot handlers with a mock db that has
// org-scoped encounter/patient/admission docs. No real Firestore
// credentials required.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { HANDLERS, isKnownHandler } from '../../hub/handlers.js'

const passed = []
const failed = []

function test(name, fn) {
  try {
    fn()
    passed.push(name)
    console.log('  ok  ' + name)
  } catch (e) {
    failed.push(name)
    console.error('  FAIL ' + name + ' — ' + (e.message || e))
  }
}

// --- Mock Firestore db with org-scoped docs ---

function makeMockDb(orgId) {
  const docs = new Map()
  const collectionRefs = new Map()

  function getDoc(docRef) {
    const key = docRef.collection + '::' + docRef.docId
    const stored = docs.get(key)
    return {
      exists: stored !== undefined,
      data: () => stored || null,
    }
  }

  function setDoc(docRef, data) {
    const key = docRef.collection + '::' + docRef.docId
    docs.set(key, data)
  }

  function updateDoc(docRef, data) {
    const key = docRef.collection + '::' + docRef.docId
    const old = docs.get(key) || {}
    docs.set(key, { ...old, ...data })
  }

  function collection(collectionName) {
    if (!collectionRefs.has(collectionName)) {
      collectionRefs.set(collectionName, { docs: [], where: [], getDocs: async () => ({ docs: [] }) })
    }
    return {
      doc: function (docId) {
        return {
          get: async () => ({ exists: true, data: () => docs.get(collectionName + '::' + docId) || null }),
          set: async (data) => setDoc({ collection: collectionName, docId }, data),
          update: async (data) => updateDoc({ collection: collectionName, docId }, data),
        }
      },
      where: function () { return this },
      get: async function () {
        const all = [...docs.entries()]
          .filter(([k, v]) => k.startsWith(collectionName + '::'))
          .map(([k, v]) => ({ id: k.slice(collectionName.length + 2), ...v }))
        return { docs: all }
      },
    }
  }

  return {
    collection,
    getDoc,
    setDoc,
    updateDoc,
    ...collectionRefs.get(orgId || 'default'),
  }
}

console.log('hub.handlers tests')

// --- Test 1: isKnownHandler ---

test('isKnownHandler returns true for known kinds', () => {
  assert.ok(isKnownHandler('rx_mirror'), 'rx_mirror should be known')
  assert.ok(isKnownHandler('lab_snapshot'), 'lab_snapshot should be known')
  assert.ok(!isKnownHandler('bad_kind'), 'bad_kind should not be known')
})

// --- Test 2: handleRxMirror with mock db and valid org membership ---

test('handleRxMirror rejects when patient not registered with org', async () => {
  const db = makeMockDb('test-org')
  // No patient doc or org link exists
  try {
    await HANDLERS.rx_mirror(db, {
      args: {
        patientId: 'stranger-patient',
        patientName: 'No Membership',
        encounterId: '',
        admissionSessionId: '',
      },
      orgId: 'test-org',
      clientOpKey: 'test-key',
      actor: { uid: 'user-1' },
    })
    throw new Error('should have thrown PermanentError')
  } catch (e) {
    assert.ok(e.name === 'PermanentError' || String(e.message).includes('not registered'), 'expected ownership error')
  }
})

test('handleRxMirror appends to open script when encounter exists and belongs to org', async () => {
  const db = makeMockDb('test-org')
  // Seed: create an encounter belonging to test-org
  const encId = 'enc-' + Date.now().toString(36)
  await db.collection('encounters').doc(encId).set({
    organization_id: 'test-org',
    patient_id: 'patient-1',
    status: 'open',
  })
  // Seed: create a patient link
  await db.collection('organization_patients').doc('test-org_patient-1').set({
    organization_id: 'test-org',
    patient_id: 'patient-1',
    mrn: '12345',
  })

  const result = await HANDLERS.rx_mirror(db, {
    args: {
      patientId: 'patient-1',
      patientName: 'Test Patient',
      encounterId: encId,
      admissionSessionId: '',
    },
    orgId: 'test-org',
    clientOpKey: 'test-key-1',
    actor: { uid: 'user-1' },
  })

  assert.ok(result.created, 'expected created: true')
  assert.ok(result.id, 'expected request id')
  // Verify the request doc has the right org
  const reqDoc = await db.collection('medication_requests').doc(result.id).get()
  const reqData = reqDoc.data()
  assert.ok(reqData, 'request doc should exist')
  assert.equal(reqData.organization_id, 'test-org', 'request should belong to test-org')
  assert.equal(reqData.created_via, 'lan-hub', 'should be via lan-hub')
})

// --- Test 3: handleLabSnapshot with mock db ---

test('handleLabSnapshot rejects when encounter belongs to different org', async () => {
  const db = makeMockDb('org-A')
  // Create an encounter for org-B
  const encId = 'enc-' + Date.now().toString(36)
  await db.collection('encounters').doc(encId).set({
    organization_id: 'org-B',  // different org!
    patient_id: 'patient-1',
    status: 'open',
  })

  try {
    await HANDLERS.lab_snapshot(db, {
      args: { encounterId: encId, labOrder: { tests: ['FBC'] } },
      orgId: 'org-A',  // requesting org is A
      clientOpKey: 'test-key-2',
      actor: { uid: 'user-1' },
    })
    throw new Error('should have thrown PermanentError')
  } catch (e) {
    assert.ok(e.name === 'PermanentError' || String(e.message).includes('different hospital'), 'expected ownership error')
  }
})

test('handleLabSnapshot creates lab order when encounter belongs to same org', async () => {
  const db = makeMockDb('test-org')
  const encId = 'enc-' + Date.now().toString(36)
  // Seed encounter belonging to test-org
  await db.collection('encounters').doc(encId).set({
    organization_id: 'test-org',
    patient_id: 'patient-1',
    status: 'open',
  })

  const result = await HANDLERS.lab_snapshot(db, {
    args: { encounterId: encId, labOrder: { lab_order_id: 'lab-new-1', tests: ['FBC'], status: 'requested' } },
    orgId: 'test-org',
    clientOpKey: 'test-key-3',
    actor: { uid: 'user-1' },
  })

  assert.ok(result.id, 'expected order id')
  assert.ok(!result.deduped, 'expected not deduped on first write')
  // Verify the encounter was updated
  const encDoc = await db.collection('encounters').doc(encId).get()
  const encData = encDoc.data()
  assert.ok(encData, 'encounter should exist')
  assert.ok(encData.lab_orders && encData.lab_orders.length > 0, 'encounter should have lab_orders')
})

// --- Test 4: edge cases ---

test('handleRxMirror rejects op with no patientId', async () => {
  const db = makeMockDb('test-org')
  try {
    await HANDLERS.rx_mirror(db, {
      args: { patientName: 'No PID', lines: [] },
      orgId: 'test-org',
      clientOpKey: 'test-key',
      actor: { uid: 'user-1' },
    })
    throw new Error('should have thrown')
  } catch (e) {
    assert.ok(e.name === 'PermanentError' || String(e.message).includes('patientId'), 'expected patientId error')
  }
})

test('handleLabSnapshot rejects op with no encounterId', async () => {
  const db = makeMockDb('test-org')
  try {
    await HANDLERS.lab_snapshot(db, {
      args: { labOrder: { tests: ['FBC'] } },
      orgId: 'test-org',
      clientOpKey: 'test-key',
      actor: { uid: 'user-1' },
    })
    throw new Error('should have thrown')
  } catch (e) {
    assert.ok(e.name === 'PermanentError' || String(e.message).includes('encounterId'), 'expected encounterId error')
  }
})

// --- Test 5: duplicate detection ---

test('handleRxMirror deduped when same sync key already applied', async () => {
  const db = makeMockDb('test-org')
  const encId = 'enc-' + Date.now().toString(36)
  await db.collection('encounters').doc(encId).set({
    organization_id: 'test-org',
    patient_id: 'patient-1',
    status: 'open',
    items: [{ medicine: 'Aspirin', quantity: 30, unit: 'tablet' }],
  })

  // First write
  const first = await HANDLERS.rx_mirror(db, {
    args: {
      patientId: 'patient-1',
      patientName: 'Test',
      encounterId: encId,
      lines: [{ medicine: 'Aspirin', dosage: '81mg', quantity: 30, unit: 'tablet', instructions: 'bd' }],
    },
    orgId: 'test-org',
    clientOpKey: 'dup-key-1',
    actor: { uid: 'user-1' },
  })
  assert.ok(!first.deduped, 'first write should not be deduped')

  // Second write with same clientOpKey should be deduped
  const second = await HANDLERS.rx_mirror(db, {
    args: {
      patientId: 'patient-1',
      patientName: 'Test',
      encounterId: encId,
      lines: [{ medicine: 'Paracetamol', dosage: '500mg', quantity: 10, unit: 'tablet' }],
    },
    orgId: 'test-org',
    clientOpKey: 'dup-key-1',   // SAME key
    actor: { uid: 'user-1' },
  })
  assert.ok(second.deduped, 'second write with same key should be deduped')
  // Verify quantity stayed 30 (not 40)
  const reqDoc = await db.collection('medication_requests').doc(first.id).get()
  const reqData = reqDoc.data()
  assert.equal(reqData.items.length, 1, 'should still have 1 line after dedup')
})

console.log('\nhub.handlers tests: ' + passed.length + ' passed, ' + failed.length + ' failed')
process.exit(failed.length ? 1 : 0)