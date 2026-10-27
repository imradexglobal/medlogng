// Relay loop — the hub's store-and-forward engine.
//
// Every tick: (1) probe Firestore, (2) if reachable, deliver the oldest ready
// ops in order, (3) record how the probe went so /health can tell the truth
// to anyone debugging a stuck sync.
//
// Delivery classification:
//   PermanentError        -> 'error' (bad payload — retries would never pass)
//   anything else         -> back to 'queued' with doubling backoff (internet
//                            blips, quota, transient unavailability)
//
// Ordering: ops are claimed FIFO by addedAt, so a prescription created before
// an edit-ish sequence still lands in creation order. Ops are independent
// (each writes its own request/encounter), so concurrency inside one batch
// matters less than FIFO admission — the claim step serialises that.
//
// Auditing: every applied (or permanently rejected) write is appended to
// audit_events with the identity the hub verified at accept time. Audit is
// best-effort and never blocks the queue.

import { PermanentError } from './handlers.js'

const PROBE_DOC = '_hub_probe/status' // never written — reading a missing doc still proves the network
const PROBE_TIMEOUT_MS = 4000

function timeout(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

export function createRelay({ db, queue, handlers, cfg, log = console, audit = null }) {
  let lastContact = null // ISO time of the last successful probe
  let lastProbeAt = 0
  let lastError = ''
  let online = false
  let running = false
  let probing = null

  // A Firestore round-trip proves the link. A "not found" answer counts as
  // online (the request crossed the wire); only transport failures are offline.
  // The probe is capped so a half-open connection can never hang a tick (or
  // /health) forever.
  function probe() {
    if (probing) return probing
    lastProbeAt = Date.now()
    probing = (async () => {
      if (!db) {
        online = false
        lastError = 'firestore not initialised (missing credentials?)'
        return false
      }
      try {
        const read = db.doc(PROBE_DOC).get()
        const winner = await Promise.race([
          read.then(() => 'ok').catch((e) => { throw e }),
          timeout(PROBE_TIMEOUT_MS).then(() => 'timeout'),
        ])
        if (winner === 'timeout') {
          online = false
          lastError = 'Firestore probe timed out after ' + PROBE_TIMEOUT_MS + 'ms'
          return false
        }
        online = true
        lastContact = new Date().toISOString()
        lastError = ''
        return true
      } catch (e) {
        online = false
        lastError = String(e?.message || e).slice(0, 300)
        return false
      }
    })()
    probing.finally(() => { probing = null })
    return probing
  }

  // One delivery pass. Exported for tests so they don't have to wait for the
  // timer. Returns { delivered, retried, failed, skipped }.
  async function runOnce(now = Date.now()) {
    if (running) return { delivered: 0, retried: 0, failed: 0, skipped: 1 }
    running = true
    try {
      queue.requeueStuck(now) // leftovers from a crashed previous run
      if (!(await probe())) return { delivered: 0, retried: 0, failed: 0, skipped: 1, offline: true }

      const batch = queue.claimReady(10, now)
      let delivered = 0
      let retried = 0
      let failed = 0
      for (const op of batch) {
        const queueKey = op.queueKey || op.clientOpKey
        const handler = handlers[op.kind]
        if (!handler) {
          const err = new PermanentError('unknown op kind: ' + op.kind)
          queue.markError(queueKey, err, now)
          failed += 1
          if (audit) await audit.failed(op, err.message)
          continue
        }
        try {
          const result = await handler(db, op)
          queue.markDelivered(queueKey)
          delivered += 1
          if (audit) await audit.delivered(op, result)
          if (result?.deduped) log.info('[hub] delivered (replay, skipped as already applied)', op.kind, op.clientOpKey)
          else log.info('[hub] delivered', op.kind, op.clientOpKey)
        } catch (e) {
          if (e instanceof PermanentError || e?.permanent) {
            queue.markError(queueKey, e, now)
            failed += 1
            if (audit) await audit.failed(op, e.message)
            log.warn('[hub] failed permanently', op.kind, op.clientOpKey, '—', e.message)
          } else {
            queue.markRetry(queueKey, e, now)
            retried += 1
            log.warn('[hub] will retry', op.kind, op.clientOpKey, '—', e?.message || e)
          }
        }
      }
      return { delivered, retried, failed, skipped: 0 }
    } finally {
      running = false
    }
  }

  let timer = null

  function start() {
    if (timer) return
    const tick = () => {
      runOnce().catch((e) => log.error('[hub] relay tick crashed:', e?.message || e))
    }
    queue.requeueStuck()
    tick()
    timer = setInterval(tick, cfg.relayMs)
    if (typeof timer.unref === 'function') timer.unref()
    log.info('[hub] relay started, every', cfg.relayMs + 'ms')
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function status() {
    return { online, lastContact, lastProbeAt: lastProbeAt || null, lastError }
  }

  // Called by /health. It must answer quickly even when Firestore is wedged:
  // the probe is throttled and the wait is capped, so the endpoint returns the
  // last known picture instead of leaving the tray on "not responding".
  async function refreshStatus({ timeoutMs = 2500 } = {}) {
    const now = Date.now()
    if (now - lastProbeAt > 10000 && !probing) {
      await Promise.race([probe(), timeout(timeoutMs)])
    } else if (probing) {
      await Promise.race([probing, timeout(timeoutMs)])
    }
    return status()
  }

  return { start, stop, runOnce, status, refreshStatus, probe }
}
