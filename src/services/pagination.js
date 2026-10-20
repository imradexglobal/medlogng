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
  db, collection, query, where, getCountFromServer, startAfter, limit,
} from '../firebase.js'
import { getDocsTolerant, withServerCount } from '../lib/offlineRead.js'

// Read the next `pageSize` docs after `cursor` (or from the top when it is
// null). Returns the docs, whether another chunk exists, and the cursor to
// hand back next time. A short or empty chunk is the only end-of-list signal
// a forward scan gets — Firestore will not tell us there is no page 4.
// Offline-tolerant: falls back to the IndexedDB cache so lists open instantly
// without a connection instead of waiting on a network timeout.
export async function runChunk(baseQ, { pageSize, cursor = null } = {}) {
  const snap = await getDocsTolerant(query(baseQ, ...(cursor ? [startAfter(cursor)] : []), limit(pageSize)))
  const docs = snap.docs
  return {
    docs,
    hasMore: docs.length === pageSize,
    cursor: docs.length ? docs[docs.length - 1] : cursor,
  }
}

// Cheap total, for the Dashboard/Reports stat cards — billed as a count, not a
// read per document. Offline (or a dead connection) falls back to counting
// the locally cached docs, then to null.
export async function countOrgDocs(coll, orgId, orgField = 'organization_id', filters = []) {
  return await withServerCount(query(collection(db, coll), where(orgField, '==', orgId), ...filters))
}
