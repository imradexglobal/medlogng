import assert from 'node:assert/strict'
import { handleDocumentMutation } from '../../hub/handlers.js'

const rows = new Map()
const key = (ref) => ref.collection + '/' + ref.id
const db = {
  collection(collection) {
    return { doc(id) { return { collection, id } } }
  },
  async runTransaction(fn) {
    const writes = []
    const tx = {
      async get(ref) {
        const value = rows.get(key(ref))
        return { exists: value !== undefined, data: () => value }
      },
      create(ref, data) { writes.push(['create', ref, data]) },
      update(ref, data) { writes.push(['update', ref, data]) },
      set(ref, data) { writes.push(['set', ref, data]) },
      delete(ref) { writes.push(['delete', ref]) },
    }
    const result = await fn(tx)
    for (const [action, ref, data] of writes) {
      if (action === 'create' && rows.has(key(ref))) throw new Error('already exists')
      if (action === 'delete') rows.delete(key(ref))
      else if (action === 'update') rows.set(key(ref), { ...rows.get(key(ref)), ...data })
      else rows.set(key(ref), data)
    }
    return result
  },
}
const op = {
  kind: 'document_mutation', orgId: 'hospital-1', clientOpKey: 'patient-op-1',
  actor: { uid: 'staff-1', name: 'Staff One' }, authorizedCapability: 'patient.create',
  args: { mutations: [
    { collection: 'patients', id: 'patient-1', action: 'create', data: { organization_id: 'hospital-1', full_name: 'Example' } },
    { collection: 'organization_patients', id: 'hospital-1_patient-1', action: 'create', data: { organization_id: 'hospital-1', patient_id: 'patient-1', full_name: 'Example' } },
  ] },
}
await handleDocumentMutation(db, op)
assert.equal(rows.get('patients/patient-1').created_by, 'staff-1')
assert.equal(rows.get('organization_patients/hospital-1_patient-1').patient_id, 'patient-1')
await handleDocumentMutation(db, op) // safe idempotent replay after a lost acknowledgement
assert.equal(rows.size, 2)
rows.set('patients/foreign-patient', { organization_id: 'hospital-2', full_name: 'Private' })
await assert.rejects(() => handleDocumentMutation(db, { ...op, args: { mutations: [
  { collection: 'patients', id: 'foreign-patient', action: 'update', data: { full_name: 'Wrong tenant' } },
] } }), /different hospital/)
console.log('LAN document mutation handler writes atomic patient links, replays idempotently, and enforces hospital ownership.')
