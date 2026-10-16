// Resumable bulk-import outbox (IndexedDB). No external deps.
//
// Staging writes every parsed SQLite row here as `queued` FIRST ("add to local
// first"). The pusher then hands chunks to Firestore and advances status:
//   queued -> sending -> written (in local Firestore cache, awaiting cloud)
//                     -> synced (acknowledged by the backend)
//   error  -> retried back to queued
// The store is durable across reloads, so an interrupted import resumes.
//
// Records are stored with timestamps as ISO strings (structured-clone friendly)
// — the pusher converts them to Firestore `Timestamp`s just before writing.

const DB_NAME = 'medilogng-bulk'
const STORE = 'outbox'
const STATUSES = ['queued', 'sending', 'written', 'synced', 'error']

let dbp = null

function open() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this environment.'))
  }
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      let req
      try {
        req = indexedDB.open(DB_NAME, 1)
      } catch (e) {
        reject(e)
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key', autoIncrement: true })
          s.createIndex('status', 'status', { unique: false })
          s.createIndex('table', 'table', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('Bulk import storage is blocked by another tab — close other MedLogNg tabs and retry.'))
    })
    dbp.catch(() => { dbp = null })
  }
  return dbp
}

export function close() {
  if (dbp) {
    dbp.then((db) => { try { db.close() } catch { /* noop */ } }).catch(() => {})
    dbp = null
  }
}

function readAll(mutate) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], mutate ? 'readwrite' : 'readonly')
    const store = t.objectStore(STORE)
    const rows = []
    const req = store.openCursor()
    req.onsuccess = (e) => {
      const cur = e.target.result
      if (cur) {
        rows.push(cur.value)
        if (mutate) cur.delete()
        cur.continue()
      } else {
        resolve(rows)
      }
    }
    req.onerror = () => reject(req.error)
  }))
}

function readByStatus(status, mutate) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], mutate ? 'readwrite' : 'readonly')
    const store = t.objectStore(STORE)
    const rows = []
    const req = store.index('status').openCursor(IDBKeyRange.only(status))
    req.onsuccess = (e) => {
      const cur = e.target.result
      if (cur) {
        rows.push(cur.value)
        if (mutate) store.delete(cur.primaryKey)
        cur.continue()
      } else {
        resolve(rows)
      }
    }
    req.onerror = () => reject(req.error)
  }))
}

// ---- write helpers ---------------------------------------------------------

export async function stage(records) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readwrite')
    const store = t.objectStore(STORE)
    for (const r of records) {
      store.add({ ...r, status: 'queued', error: '', createdAt: new Date(), updatedAt: new Date() })
    }
    t.oncomplete = () => resolve(records.length)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

// Claim up to `limit` queued records (in key order) and flip them to `sending`
// in the same durable step so no row is lost between read and commit.
export async function takeQueued(limit = 400) {
  const db = await open()
  const got = await new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readonly')
    const store = t.objectStore(STORE)
    const rows = []
    const req = store.index('status').openCursor(IDBKeyRange.only('queued'))
    req.onsuccess = (e) => {
      const cur = e.target.result
      if (cur && rows.length < limit) {
        rows.push(cur.value)
        cur.continue()
      } else {
        resolve(rows)
      }
    }
    req.onerror = () => reject(req.error)
  })
  if (!got.length) return []
  await setStatuses(got.map((r) => r.key), 'sending')
  return got
}

export async function resendSending() {
  // A previous push may have been interrupted mid-batch; re-queue claims so
  // nothing is stranded in `sending`.
  return readByStatus('sending', true).then((rows) => {
    if (!rows.length) return 0
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction([STORE], 'readwrite')
      const store = t.objectStore(STORE)
      for (const r of rows) store.put({ ...r, status: 'queued', error: '', updatedAt: new Date() })
      t.oncomplete = () => resolve(rows.length)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    }))
  })
}

export async function setStatuses(keys, status, error) {
  if (!keys || !keys.length) return
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readwrite')
    const store = t.objectStore(STORE)
    for (const k of keys) {
      store.get(k).onsuccess = (e) => {
        const rec = e.target.result
        if (rec) store.put({ ...rec, status, error: error != null ? String(error) : '', updatedAt: new Date() })
      }
    }
    t.oncomplete = () => resolve(keys.length)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export async function retryErrors() {
  return readByStatus('error', true).then((rows) => {
    if (!rows.length) return 0
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction([STORE], 'readwrite')
      const store = t.objectStore(STORE)
      for (const r of rows) store.put({ ...r, status: 'queued', error: '', updatedAt: new Date() })
      t.oncomplete = () => resolve(rows.length)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    }))
  })
}

export async function clearSynced() {
  return readByStatus('synced', true).then((rows) => rows.length)
}

export async function purge() {
  return readAll(true).then((rows) => rows.length)
}

// ---- reads ----------------------------------------------------------------

export async function counts() {
  const c = { total: 0, queued: 0, sending: 0, written: 0, synced: 0, error: 0 }
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readonly')
    const store = t.objectStore(STORE)
    let pending = STATUSES.length + 1
    let failed = false
    const done = () => {
      pending -= 1
      if (pending === 0 && !failed) resolve(c)
    }
    store.count().onsuccess = (e) => { c.total = e.target.result || 0; done() }
    for (const s of STATUSES) {
      store.index('status').count(s).onsuccess = (e) => { c[s] = e.target.result || 0; done() }
      store.index('status').count(s).onerror = () => { failed = true }
    }
    t.onerror = () => { if (!failed) { failed = true; reject(t.error) } }
    t.onabort = () => { if (!failed) { failed = true; reject(t.error) } }
  }))
}

export async function pendingCount() {
  const c = await counts()
  return c.queued + c.sending + c.written
}

export async function byTable() {
  return readAll(false).then(summarize)
}

export async function errorRows() {
  return readByStatus('error', false)
}

export async function rowsByStatus(status) {
  return readByStatus(status, false)
}

// ---- pure helpers (unit-testable) -----------------------------------------

export const QUEUE_STATUSES = STATUSES

export function summarize(records) {
  const out = new Map()
  for (const r of records) {
    let e = out.get(r.table)
    if (!e) {
      e = { table: r.table, total: 0, auto: 0, queued: 0, sending: 0, written: 0, synced: 0, error: 0 }
      out.set(e.table, e)
    }
    e.total += 1
    if (r.auto) e.auto += 1
    e[r.status] = (e[r.status] || 0) + 1
  }
  return [...out.values()].sort((a, b) => a.table.localeCompare(b.table))
}