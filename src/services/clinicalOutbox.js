// Clinical handoff outbox (IndexedDB). No external deps.
//
// The Firestore SDK queues the write it was *given* — but several
// cross-department handoffs depend on a fresh network read first (the
// prescription mirror must FIND the open script before it can append), so when
// that read fails the step used to be swallowed and the other department never
// received the handoff. Every such step now lands here instead:
//
//   enqueue(kind, args)  -> row status 'queued'   (durable, survives reload)
//   drain()              -> runs the matching service function
//                         -> success      : row deleted (nothing pending)
//                         -> transient err: back to 'queued' (offline — retry)
//                         -> permanent err: 'error' (permission/validation)
//
// Ops store { kind, args }, not raw payloads: drain() re-runs the existing
// service function, which is already idempotent (prescribing twice for one
// encounter merges into ONE request — see scripts/test/requests.test.mjs).
// That is also what makes a replay safe once the LAN hub (Phase 2) starts
// re-delivering these ops.
//
// Handlers are loaded with dynamic import() so consultationService.js can
// import this module without an import cycle.

const DB_NAME = 'medilogng-handoffs'
const STORE = 'outbox'
const DRAIN_INTERVAL_MS = 30000
const BATCH_LIMIT = 50

const HANDLERS = {
  // consultation -> pharmacy: append lines to the open script / open a new one
  rx_mirror: async (args) => {
    const { requestMedicationLines } = await import('./pharmacyService.js')
    return requestMedicationLines(args)
  },
  // consultation -> encounter snapshot: the lab doc is primary, this is the
  // clinician-facing copy that could not be written at order time
  lab_snapshot: async (args) => {
    const { addLabOrder } = await import('./consultationService.js')
    return addLabOrder(args.encounterId, args.labOrder)
  },
}

export const OUTBOX_KINDS = Object.keys(HANDLERS)

// Offline problems retry forever; rule/validation problems never fix
// themselves, so they surface as 'error' immediately instead of burning
// retries. Pure — unit-testable.
export function isTransientError(e) {
  const code = e?.code || ''
  if (['unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'resource-exhausted'].includes(code)) return true
  return /offline|network|timeout|failed to fetch|load failed/i.test(String(e?.message || ''))
}

export function nextStateAfterFailure(e) {
  return isTransientError(e) ? 'queued' : 'error'
}

// ---- listeners -------------------------------------------------------------

const listeners = new Set()

export function onUpdate(cb) {
  listeners.add(cb)
  pendingCount().then((n) => { try { cb(n) } catch { /* noop */ } }).catch(() => {})
  return () => listeners.delete(cb)
}

async function notify() {
  let n = 0
  try { n = await pendingCount() } catch { /* storage unavailable */ }
  for (const cb of [...listeners]) {
    try { cb(n) } catch { /* a broken listener must not stop the sync */ }
  }
}

// ---- storage (same discipline as bulkQueue.js) -----------------------------

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
          const s = db.createObjectStore(STORE, { keyPath: 'opId', autoIncrement: true })
          s.createIndex('status', 'status', { unique: false })
          s.createIndex('kind', 'kind', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('Handoff storage is blocked by another tab — close other MediLog NG tabs and retry.'))
    })
    dbp.catch(() => { dbp = null })
  }
  return dbp
}

// ---- write helpers ---------------------------------------------------------

export async function enqueue(kind, args) {
  if (!HANDLERS[kind]) throw new Error('Unknown handoff kind: ' + kind)
  const db = await open()
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readwrite')
    t.objectStore(STORE).add({
      kind,
      args,
      status: 'queued',
      attempts: 0,
      lastError: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
  console.info('[handoff] queued', kind)
  notify()
  if (typeof navigator === 'undefined' || navigator.onLine !== false) drain().catch(() => {})
  return true
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
        rows.push({ key: cur.primaryKey, ...cur.value })
        if (mutate) cur.delete()
        cur.continue()
      } else {
        resolve(rows)
      }
    }
    req.onerror = () => reject(req.error)
  }))
}

function putRow(row) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readwrite')
    t.objectStore(STORE).put({ ...row, updatedAt: new Date() })
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  }))
}

function deleteRows(keys) {
  if (!keys.length) return Promise.resolve()
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readwrite')
    const store = t.objectStore(STORE)
    for (const k of keys) store.delete(k)
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  }))
}

// A drain interrupted mid-batch leaves rows in 'sending'; re-queue them so
// nothing is stranded (same idea as bulkQueue.resendSending).
async function resendSending() {
  const rows = await readByStatus('sending', true)
  if (!rows.length) return 0
  for (const r of rows) {
    await putRow({ ...r, status: 'queued' })
  }
  return rows.length
}

export async function retryErrors() {
  const rows = await readByStatus('error', true)
  for (const r of rows) await putRow({ ...r, status: 'queued', lastError: '' })
  if (rows.length) notify()
  return rows.length
}

// ---- reads -----------------------------------------------------------------

export async function counts() {
  const c = { queued: 0, sending: 0, error: 0, total: 0 }
  const db = await open()
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE], 'readonly')
    const store = t.objectStore(STORE)
    let pending = 4
    let failed = false
    const done = () => { pending -= 1; if (pending === 0 && !failed) resolve() }
    store.count().onsuccess = (e) => { c.total = e.target.result || 0; done() }
    for (const s of ['queued', 'sending', 'error']) {
      store.index('status').count(s).onsuccess = (e) => { c[s] = e.target.result || 0; done() }
      store.index('status').count(s).onerror = () => { failed = true }
    }
    t.onerror = () => { if (!failed) { failed = true; reject(t.error) } }
    t.onabort = () => { if (!failed) { failed = true; reject(t.error) } }
  })
  return c
}

export async function pendingCount() {
  try {
    const c = await counts()
    return c.total
  } catch {
    return 0
  }
}

// ---- drain -----------------------------------------------------------------

let running = false

export async function drain() {
  if (running) return 0
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0
  running = true
  let delivered = 0
  try {
    await resendSending()
    for (let pass = 0; pass < 10; pass++) {
      const batch = await readByStatus('queued', true) // claim durably first
      if (!batch.length) break
      const take = batch.slice(0, BATCH_LIMIT)
      const back = batch.slice(BATCH_LIMIT)
      let stopPass = false

      for (const row of take) {
        const handler = HANDLERS[row.kind]
        if (!handler) {
          await deleteRows([row.key]) // unknown kind — never retryable
          continue
        }
        try {
          await handler(row.args)
          await deleteRows([row.key])
          delivered += 1
          console.info('[handoff] delivered', row.kind, '#' + row.key)
        } catch (e) {
          const next = nextStateAfterFailure(e)
          await putRow({ ...row, status: next, attempts: (row.attempts || 0) + 1, lastError: String(e?.message || e) })
          console.warn('[handoff] ' + (next === 'error' ? 'failed' : 'will retry'), row.kind, e?.message || e)
          if (next === 'queued') stopPass = true // network is gone — stop hammering
        }
      }

      // Put the un-tried tail back before deciding whether to continue.
      for (const r of back) await putRow({ ...r, status: 'queued' })
      if (stopPass || back.length) break
    }
  } finally {
    running = false
    notify()
  }
  return delivered
}

// ---- lifecycle -------------------------------------------------------------

let started = false

export function startOutboxSync() {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', () => { drain().catch(() => {}) })
  setInterval(() => { drain().catch(() => {}) }, DRAIN_INTERVAL_MS)
  drain().catch(() => {}) // leftovers from a previous session
}
