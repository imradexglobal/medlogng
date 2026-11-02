import assert from 'node:assert/strict'
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, query, where, orderBy, limit, Timestamp } from 'firebase/firestore'
import { serializeFirestoreQuery } from '../../src/lib/firestoreQuery.js'
import { applyQuerySpec, validateQuerySpec } from '../../hub/querySpec.js'
import { createOfflineQueryCache } from '../../hub/offlineQueryCache.js'

const app = initializeApp({ projectId: 'offline-query-test' }, 'offline-query-test')
const db = getFirestore(app)
const q = query(collection(db, 'admissions'), where('organization_id', '==', 'hospital-1'),
  where('status', 'in', ['active', 'discharged']), orderBy('created_at', 'desc'), limit(25))
const serialized = serializeFirestoreQuery(q)
assert.deepEqual(serialized, {
  collection: 'admissions',
  filters: [
    { field: 'organization_id', op: '==', value: 'hospital-1' },
    { field: 'status', op: 'in', value: ['active', 'discharged'] },
  ],
  orderBy: [{ field: 'created_at', dir: 'desc' }], limit: 25, startAt: null, endAt: null,
})
const timestampQuery = serializeFirestoreQuery(query(collection(db, 'admissions'),
  where('organization_id', '==', 'hospital-1'), where('created_at', '>=', Timestamp.fromDate(new Date('2026-01-01T00:00:00Z')))))
assert.equal(timestampQuery.filters[1].value.__firestoreType, 'timestamp')

const validated = validateQuerySpec(serialized, { orgId: 'hospital-1', uid: 'staff-1' })
assert.equal(validated.collection, 'admissions')
const calls = []
const builder = {
  where(...args) { calls.push(['where', ...args]); return this },
  orderBy(...args) { calls.push(['orderBy', ...args]); return this },
  limit(...args) { calls.push(['limit', ...args]); return this },
}
assert.equal(applyQuerySpec({ collection: (name) => { calls.push(['collection', name]); return builder } }, validated), builder)
assert.deepEqual(calls.map((x) => x[0]), ['collection', 'where', 'where', 'orderBy', 'limit'])
assert.throws(() => validateQuerySpec({ ...serialized, filters: [] }, { orgId: 'hospital-1', uid: 'staff-1' }), /scoped to the selected hospital/)
assert.throws(() => validateQuerySpec({ ...serialized, collection: 'organization_memberships', filters: [
  { field: 'organization_id', op: '==', value: 'hospital-1' },
] }, { orgId: 'hospital-1', uid: 'staff-1' }), /signed-in user/)

const persisted = { index: [], rows: new Map() }
const makeCache = () => createOfflineQueryCache({
  loadIndex: async () => persisted.index,
  saveIndex: async (text) => { persisted.index = JSON.parse(text) },
  loadEntry: async (id) => persisted.rows.get(id) || null,
  saveEntry: async (id, text) => { persisted.rows.set(id, text) },
  removeEntry: async (id) => { persisted.rows.delete(id) },
  log: { warn() {}, error() {} },
})
const cache = makeCache()
await cache.initialize()
await cache.set({ orgId: 'hospital-1', query: serialized }, [{ id: 'admission-1', data: { status: 'active' } }])
assert.equal((await cache.get({ orgId: 'hospital-1', query: serialized })).docs[0].id, 'admission-1')
const restartedCache = makeCache()
await restartedCache.initialize()
assert.equal((await restartedCache.get({ orgId: 'hospital-1', query: serialized })).docs[0].data.status, 'active')
assert.equal(await restartedCache.get({ orgId: 'hospital-2', query: serialized }), null,
  'query cache keys are isolated by hospital')
console.log('LAN query serialization, hospital scoping and durable exact-query cache passed.')
