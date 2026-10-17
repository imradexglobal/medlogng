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
// encounter merges into ONE request — see scripts/test/requests.test.mjs),
// AND every row carries a stable sync key that is recorded on the written
// doc, so a replay can never double quantities even across transports.
//
// Two transports, one queue (Phase 2): drain() tries the cloud first; when
// the internet is gone (or dies mid-batch) the same rows are POSTed to the
// hospital LAN hub instead — a small on-premise service that stores them
// durably and relays to Firestore when connectivity returns. The hub is
// optional: without a configured URL nothing changes.
//
// Handlers are loaded with dynamic import() so consultationService.js can
// import this module without an import cycle.

const DB_NAME = 'medilogng-handoffs'
const STORE = 'outbox'
const DRAIN_INTERVAL_MS = 30000
const BATCH_LIMIT = 50

const HANDLERS = {
  // consultation -> pharmacy: append lines to the open script / open a new one.
  // syncKey is the row's stable id — stamped on the request doc so replays
  // (cloud retry, hub relay, or both racing) apply exactly once.
  rx_mirror: async (args, syncKey) => {
    const { requestMedicationLines } = await import('./pharmacyService.js')
    return requestMedicationLines({ ...args, syncKey })
  },
  // consultation -> encounter snapshot: the lab doc is primary, this is the
  // clinician-facing copy that could not be written at order time
  lab_snapshot: async (args) => {
    const { addLabOrder } = await import('./consultationService.js')
    return addLabOrder(args.encounterId, args.labOrder)
  },
}

export const OUTBOX_KINDS = Object.keys(HANDLERS)

// ---- hospital hub (Phase 2/3) -------------------------------------------------
// Endpoint + secret, resolved at call time. Three sources, in order:
//   1. localStorage override (testing: set 'medilogng.hubUrl' from the console)
//   2. build-time VITE_HUB_URL / VITE_HUB_TOKEN
//   3. AUTO-DETECT: when the app itself is being served from a host PC
//      (http://<host-ip>:8787), handoffs post back to the SAME address —
//      no configuration exists on ward PCs at all, and the hub injects the
//      sync token into the HTML it serves (see hub/server.js).

let sameOriginHub = null // null = not probed yet

async function detectSameOriginHub() {
  if (sameOriginHub !== null) return sameOriginHub
  if (typeof window === 'undefined' || !window.location
      || (window.location.protocol !== 'http:' && window.location.protocol !== 'https:')) {
    sameOriginHub = false
    return false
  }
  try {
    const res = await fetch(window.location.origin + '/health', { signal: AbortSignal.timeout(2500) })
    if (!res.ok) { sameOriginHub = false; return false }
    const h = await res.json()
    sameOriginHub = !!(h && h.ok && String(h.version || '').startsWith('hub-'))
  } catch {
    sameOriginHub = false // any non-hub server (Vite dev, hosting SPA fallback) lands here
  }
  return sameOriginHub
}

async function hubConfig() {
  let url = ''
  let token = ''
  try {
    url = localStorage.getItem('medilogng.hubUrl') || ''
    token = localStorage.getItem('medilogng.hubToken') || ''
  } catch { /* storage disabled */ }
  if (!url && import.meta.env?.VITE_HUB_URL) url = String(import.meta.env.VITE_HUB_URL)
  if (!token && import.meta.env?.VITE_HUB_TOKEN) token = String(import.meta.env.VITE_HUB_TOKEN)
  if (!token && typeof window !== 'undefined' && window.__MEDILOG_HUB_TOKEN__) {
    token = String(window.__MEDILOG_HUB_TOKEN__) // injected by the serving hub
  }
  if (!url && await detectSameOriginHub()) url = window.location.origin
  return { url: url.replace(/\/+$/, ''), token }
}

// What most recently delivered an op — the shell badge shows the difference
// between "synced to cloud" and "sent via hospital hub".
let lastMode = ''
let lastModeAt = 0

export function getSyncMode() {
  return { mode: lastMode, at: lastModeAt }
}

// Stable identity for one row, shared by BOTH transports: the cloud path
// stamps it as medication_requests.sync_keys, the hub path sends it as
// clientOpKey. A row that somehow goes out twice applies exactly once.
function opKeyFor(row) {
  return 'v1:' + row.kind + ':' + row.key
}

const HUB_TIMEOUT_MS = 6000

// POST claimed rows to the LAN hub. Claim already removed them from
// IndexedDB, so: 2xx -> done (hub owns them now); anything else -> requeue.
async function pushToHub(rows) {
  const { url, token } = await hubConfig()
  if (!url || !rows.length) return false
  let orgId = ''
  let actor = null
  try {
    const { authStore } = await import('../store/authStore.js')
    const st = authStore.getState()
    orgId = st.activeOrg || ''
    actor = st.user ? { uid: st.user.uid || null, email: st.user.email || '' } : null
  } catch { /* no auth context — the hub will reject a missing orgId */ }
  const ops = rows.map((r) => ({
    clientOpKey: opKeyFor(r),
    kind: r.kind,
    args: r.args,
    orgId,
    actor,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : '',
  }))
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), HUB_TIMEOUT_MS)
  try {
    const res = await fetch(url + '/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-token': token },
      body: JSON.stringify({ ops }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn('[handoff] hospital hub rejected batch:', res.status)
      return false
    }
    lastMode = 'hub'
    lastModeAt = Date.now()
    console.info('[handoff] delivered via hospital hub:', rows.length)
    return true
  } catch (e) {
    console.warn('[handoff] hospital hub unreachable:', e?.message || e)
    return false
  } finally {
    clearTimeout(t)
  }
}

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
  // Drain even when the browser says offline: drain() itself picks the
  // transport (hub if configured, cloud otherwise) and costs nothing when
  // neither is reachable.
  drain().catch(() => {})
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

// Transport order: cloud first (fastest path when the internet works), hub
// as the fallback — used when the browser is offline at drain start, or when
// the cloud dies mid-batch. Once the cloud fails once in a pass, everything
// left in this drain goes to the hub rather than timing out row by row.
// Rows the cloud already delivered are never re-sent; rows that fail with an
// unknown ack state may go out on both transports, which sync_keys makes a
// no-op.
export async function drain() {
  if (running) return 0
  running = true
  let delivered = 0
  let preferHub = false // set once the cloud has failed this drain
  try {
    await resendSending()
    for (let pass = 0; pass < 10; pass++) {
      const batch = await readByStatus('queued', true) // claim durably first
      if (!batch.length) break
      const take = batch.slice(0, BATCH_LIMIT)
      const back = batch.slice(BATCH_LIMIT)
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false

      if (offline || preferHub) {
        // Tail first: it was claimed out of IndexedDB, so it must go back
        // before anything else can re-claim it (crash-safety).
        for (const r of back) await putRow({ ...r, status: 'queued' })
        if (await pushToHub(take)) {
          delivered += take.length
          continue // next pass picks up the re-queued tail
        }
        for (const r of take) await putRow({ ...r, status: 'queued' })
        break // no transport is answering — stop hammering
      }

      let stopCloud = false
      const forHub = []

      for (const row of take) {
        if (stopCloud) { forHub.push(row); continue }
        const handler = HANDLERS[row.kind]
        if (!handler) continue // claimed + dropped: unknown kind is never retryable
        try {
          await handler(row.args, opKeyFor(row))
          await deleteRows([row.key]) // no-op when the claim already removed it
          delivered += 1
          lastMode = 'cloud'
          lastModeAt = Date.now()
          console.info('[handoff] delivered', row.kind, '#' + row.key)
        } catch (e) {
          const next = nextStateAfterFailure(e)
          if (next === 'queued') {
            stopCloud = true
            preferHub = true
            forHub.push(row)
          } else {
            await putRow({ ...row, status: 'error', attempts: (row.attempts || 0) + 1, lastError: String(e?.message || e) })
            console.warn('[handoff] failed', row.kind, e?.message || e)
          }
        }
      }

      // Cloud stopped mid-batch: everything undelivered tries the hospital
      // hub before it goes back to waiting.
      let hubOk = true
      if (forHub.length) {
        hubOk = await pushToHub(forHub)
        if (hubOk) delivered += forHub.length
        else for (const r of forHub) await putRow({ ...r, status: 'queued' })
      }

      // Put the un-tried tail back before deciding whether to continue.
      for (const r of back) await putRow({ ...r, status: 'queued' })
      if (!hubOk || forHub.length || back.length) break
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
