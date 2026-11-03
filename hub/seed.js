// Offline cache seed — warms the Host's offline query cache with the canonical
// organisation-scoped reads so ward tablets can work with no prior online
// session. Runs only when the Host has a live Firestore connection; the result
// is the same durable cache the relay already serves during outages.
//
// It is deliberately narrow:
//   - one read per canonical collection, org-scoped, no filters, capped at
//     MAX_SEED_DOCS per collection (the cache's own MAX_CACHED_QUERY_DOCS is
//     10000, so this stays well under it)
//   - no client-supplied payloads — every row comes from Firestore
//   - failures are logged and skipped, never fatal: a partial seed still
//     leaves the Host able to serve whatever it got

import { applyQuerySpec, MAX_CACHED_QUERY_DOCS, serializeFirestoreData } from './querySpec.js'

// Canonical reads a hospital needs offline. Each entry is the collection +
// the org-scoped filter the Host's own query validator requires.
const SEED_COLLECTIONS = [
  { collection: 'patients', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'organization_patients', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'encounters', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'vitals', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'allergies', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'diagnoses', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'appointments', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'admissions', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'wards', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'admission_plan_items', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'documents', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'lab_test_catalogue', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'lab_settings', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'imaging_orders', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'result_images', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'stock_lots', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'medication_requests', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'medication_administrations', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'dispensations', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'stock_movements', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'bed_claims', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'invoices', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'payments', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'claims', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'coverages', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'plans', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'price_catalogue', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'patient_photos', filters: [{ field: 'organization_id', op: '==', value: null }] },
  { collection: 'organization_memberships', filters: [{ field: 'organization_id', op: '==', value: null }] },
]

// Per-collection cap. The cache rejects >10000 docs per query, so this stays
// well under it and keeps the seed bounded on a busy hospital.
const MAX_SEED_DOCS = 5000

export async function seedOfflineCache(db, offlineQueryCache, orgId, log = console) {
  if (!db || !offlineQueryCache || !orgId) {
    return { ok: false, error: 'Offline cache seed requires Firestore, the cache and an org id.' }
  }
  const summary = { orgId, collections: 0, docs: 0, failed: [], startedAt: Date.now() }
  for (const entry of SEED_COLLECTIONS) {
    const filters = entry.filters.map((f) => ({ ...f, value: orgId }))
    const spec = { orgId, collection: entry.collection, filters, orderBy: [], limit: MAX_SEED_DOCS, startAt: null, endAt: null }
    try {
      const query = applyQuerySpec(db, spec)
      const snap = await query.get()
      const docs = snap.docs.map((item) => ({ id: item.id, data: serializeFirestoreData(item.data() || {}) }))
      await offlineQueryCache.set(spec, docs)
      summary.collections += 1
      summary.docs += docs.length
    } catch (error) {
      summary.failed.push({ collection: entry.collection, error: String(error?.message || error).slice(0, 200) })
      log.warn('[hub] offline seed skipped ' + entry.collection + ':', error?.message || error)
    }
  }
  summary.elapsedMs = Date.now() - summary.startedAt
  log.info('[hub] offline cache seed complete', summary.collections, 'collections,', summary.docs, 'docs', summary.failed.length ? ('(' + summary.failed.length + ' skipped)') : '')
  return summary
}