// Shared forward-chunked reads (direct Firestore, Spark plan: no backend).
//
// Pattern: every org list orders by a stable field, and the caller holds a
// single `cursor` — the last DocumentSnapshot of the chunk it has already
// loaded. Passing it back to runChunk() walks one step forward; a null cursor
// starts at the top. This is what backs the "load more when you reach the
// bottom" lists in components/loadMore.js: there is no page number to seek to,
// so no offset read and no cursor-per-position cache is ever needed.
// Requires the composite indexes in firestore.indexes.json
// (organization_id + order field). Deploy them or Firestore throws
// failed-precondition with a console link to create the index.
import {
  db, collection, query, where, getDocs, getCountFromServer, startAfter, limit,
} from '../firebase.js'

// Read the next `pageSize` docs after `cursor` (or from the top when it is
// null). Returns the docs, whether another chunk exists, and the cursor to
// hand back next time. A short or empty chunk is the only end-of-list signal
// a forward scan gets — Firestore will not tell us there is no page 4.
export async function runChunk(baseQ, { pageSize, cursor = null } = {}) {
  const snap = await getDocs(query(baseQ, ...(cursor ? [startAfter(cursor)] : []), limit(pageSize)))
  const docs = snap.docs
  return {
    docs,
    hasMore: docs.length === pageSize,
    cursor: docs.length ? docs[docs.length - 1] : cursor,
  }
}

// Cheap total, for the Dashboard/Reports stat cards — billed as a count, not a
// read per document. Falls back to null when counts are unavailable offline.
export async function countOrgDocs(coll, orgId, orgField = 'organization_id', filters = []) {
  try {
    const snap = await getCountFromServer(
      query(collection(db, coll), where(orgField, '==', orgId), ...filters),
    )
    return snap.data().count
  } catch {
    return null
  }
}
