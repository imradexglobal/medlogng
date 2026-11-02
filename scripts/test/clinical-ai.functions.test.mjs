import assert from 'node:assert/strict'
import { createClinicalAiHandlers } from '../../functions/index.js'

const collections = new Map()
const auditRows = []
function seed(collection, id, value) { collections.set(collection + '/' + id, value) }
const store = {
  collection(name) {
    return {
      doc(id) { return { async get() { const value = collections.get(name + '/' + id); return { exists: !!value, data: () => value } } } },
      async add(value) { auditRows.push(value); return { id: 'audit-' + auditRows.length } },
    }
  },
}
const transcript = 'Patient reports a cough for three days. No fever.'
const quote = 'Patient reports a cough for three days.'
const draft = { schemaVersion: 1, fields: {
  S: [{ text: 'Patient reports cough for three days.', provenance: 'patient-reported', certainty: 'clear', evidence: [{ start: 0, end: quote.length, quote }] }],
  O: [], A: [], P: [],
}, unresolved: ['No examination findings were supplied.'], conflicts: [] }
const config = { orgId: 'synthetic-hospital', patientId: 'synthetic-patient', encounterId: 'synthetic-encounter' }
seed('organization_memberships', config.orgId + '_clinician', { status: 'active', capabilities: ['encounter.edit'] })
seed('encounters', config.encounterId, { organization_id: config.orgId, patient_id: config.patientId })
let providerCalls = 0
const handlers = createClinicalAiHandlers({ store, provider: async () => { providerCalls += 1; return draft }, timestamp: () => 'synthetic-time', log: { error() {} } })
const clinician = { auth: { uid: 'clinician' }, data: { ...config, transcript } }

await assert.rejects(() => handlers.generate({ data: { ...config, transcript } }), (error) => error.code === 'unauthenticated')
await assert.rejects(() => handlers.generate({ auth: { uid: 'unprivileged' }, data: { ...config, transcript } }), (error) => error.code === 'permission-denied')
await assert.rejects(() => handlers.generate({ ...clinician, data: { ...config, patientId: 'other-patient', transcript } }), (error) => error.code === 'permission-denied')
await assert.rejects(() => handlers.review({ auth: { uid: 'unprivileged' }, data: { ...config, action: 'approved' } }), (error) => error.code === 'permission-denied')
assert.equal(providerCalls, 0, 'authorization failures never invoke model processing')

const generated = await handlers.generate(clinician)
assert.equal(generated.ok, true)
assert.equal(generated.binding.uid, 'clinician')
assert.equal(providerCalls, 1)
assert.equal(auditRows[0].action, 'clinical_draft.generated')
assert.equal(auditRows[0].record_id, config.encounterId)
assert.equal(auditRows[0].occurredAt, 'synthetic-time')
await handlers.review({ ...clinician, data: { ...config, action: 'approved', acceptedSuggestions: ['S:0'], rejectedSuggestions: ['A:0'] } })
assert.equal(auditRows[1].action, 'clinical_draft.approved')
assert.equal(auditRows[1].actor_user_id, 'clinician')
assert.deepEqual(auditRows[1].accepted_suggestions, ['S:0'])
assert.deepEqual(auditRows[1].rejected_suggestions, ['A:0'])
await assert.rejects(() => handlers.review({ ...clinician, data: { ...config, action: 'approved', acceptedSuggestions: ['S:999999'] } }), (error) => error.code === 'invalid-argument')

const noProvider = createClinicalAiHandlers({ store, provider: async () => { throw Object.assign(new Error('No approved provider'), { code: 'failed-precondition' }) }, log: { error() {} } })
await assert.rejects(() => noProvider.generate(clinician), (error) => error.code === 'failed-precondition')
console.log('Firebase clinical AI policy tests passed: auth, capability, patient binding, evidence validation, audit, and fail-closed provider')
