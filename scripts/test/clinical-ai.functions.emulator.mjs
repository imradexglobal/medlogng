import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const requireFunctions = createRequire(new URL('../../functions/package.json', import.meta.url))
const admin = requireFunctions('firebase-admin')
const projectId = process.env.GCLOUD_PROJECT || 'demo-medlogng'
const fetchImpl = globalThis.fetch
const baseAuth = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts'
const baseCallable = 'http://127.0.0.1:5001/' + projectId + '/us-central1/'
const adminApp = admin.initializeApp({ projectId }, 'clinical-ai-emulator-' + Date.now())
const db = admin.firestore(adminApp)
const suffix = Math.random().toString(36).slice(2, 10)
const orgId = 'synthetic-org-' + suffix
const patientId = 'synthetic-patient-' + suffix
const encounterId = 'synthetic-encounter-' + suffix
const email = 'clinical-ai-' + suffix + '@example.test'
let idToken = ''
let uid = ''

async function createUser() {
  const response = await fetchImpl(baseAuth + ':signUp?key=emulator-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'EmulatorOnly-12345', returnSecureToken: true }),
  })
  assert.equal(response.ok, true, 'Auth emulator user creation should succeed')
  const result = await response.json()
  idToken = result.idToken
  return result.localId
}

async function call(name, data, token = idToken) {
  return fetchImpl(baseCallable + name, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ data }),
  })
}

try {
  uid = await createUser()
  await db.collection('organization_memberships').doc(orgId + '_' + uid).set({ status: 'active', capabilities: ['encounter.edit'] })
  await db.collection('encounters').doc(encounterId).set({ organization_id: orgId, patient_id: patientId })
  const body = { orgId, patientId, encounterId }

  const unauthenticated = await call('recordClinicalDraftReview', { ...body, action: 'approved' }, '')
  assert.notEqual(unauthenticated.status, 200)
  const wrongPatient = await call('recordClinicalDraftReview', { ...body, patientId: 'wrong-patient', action: 'approved' })
  assert.notEqual(wrongPatient.status, 200)

  const generated = await call('generateClinicalDraft', { ...body, transcript: 'Patient reports a cough.' })
  assert.notEqual(generated.status, 200, 'unapproved provider must fail closed')
  const generatedError = await generated.json()
  assert.match(JSON.stringify(generatedError), /FAILED_PRECONDITION|No approved clinical AI provider/)

  const reviewed = await call('recordClinicalDraftReview', { ...body, action: 'approved', acceptedSuggestions: ['S:0'], rejectedSuggestions: ['A:0'] })
  assert.equal(reviewed.status, 200)
  const audits = await db.collection('audit_events').where('record_id', '==', encounterId).get()
  assert.equal(audits.docs.length, 1)
  assert.equal(audits.docs[0].data().actor_user_id, uid)
  assert.deepEqual(audits.docs[0].data().accepted_suggestions, ['S:0'])
  assert.deepEqual(audits.docs[0].data().rejected_suggestions, ['A:0'])
  console.log('Firebase Functions emulator integration passed: Auth, encounter binding, fail-closed provider and audit write')
} finally {
  try {
    if (uid) await db.collection('organization_memberships').doc(orgId + '_' + uid).delete()
    await db.collection('encounters').doc(encounterId).delete()
    const audits = await db.collection('audit_events').where('record_id', '==', encounterId).get()
    await Promise.all(audits.docs.map((doc) => doc.ref.delete()))
  } catch {}
  if (idToken) await fetchImpl(baseAuth + ':delete?key=emulator-key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
  }).catch(() => {})
  await adminApp.delete().catch(() => {})
}
