// Durable outbox queue for the hospital hub.
//
// Design: a single JSON state file rewritten atomically (write temp + rename)
// on every change. No database engine, no native compilation — the hub PC only
// needs Node. Hospital-scale volumes (a few ops per minute, even during an
// outage) make a full rewrite every transition negligible, and rename-atomicity
// means a power cut can never leave a half-written queue: you get either the
// old file or the new one.
//
// Op lifecycle:
//   queued -> sending -> delivered          (relay succeeded)
//              |      -> queued (backoff)   (transient: internet blip)
//              |      -> error              (permanent: bad data, needs a human)
//
// clientOpKey is the idempotency key the browser device sends. Accepting the
// same op twice (lost HTTP response, device retry) is safe: `add` returns
// duplicate instead of storing it again.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export const OP_STATUS = ['queued', 'sending', 'delivered', 'error']
const DELIVERED_KEEP_MS = 7 * 24 * 3600 * 1000 // prune delivered/error after 7 days

function freshState() {
  return { version: 1, savedAt: 0, ops: {} }
}

export function createQueue(file) {
  let state = freshState()

  // Load whatever was durable on disk. A corrupt file is moved aside rather
  // than crashing the hub — losing the queue is bad, refusing to start forever
  // is worse; the browser devices keep their own copy and will re-push.
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.ops) state = parsed
    } catch {
      try { renameSync(file, file + '.corrupt-' + Date.now()) } catch { /* best effort */ }
      state = freshState()
    }
  }

  function save() {
    state.savedAt = Date.now()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  }

  function prune() {
    const now = Date.now()
    let changed = false
    for (const [k, op] of Object.entries(state.ops)) {
      const doneAt = op.deliveredAt || (op.status === 'error' ? op.updatedAt : 0)
      if (doneAt && now - doneAt > DELIVERED_KEEP_MS) {
        delete state.ops[k]
        changed = true
      }
    }
    if (changed) save()
  }

  return {
    // Returns { accepted: true } for a new op, { duplicate: true } for a
    // replay of one we already hold (or already delivered).
    add(op) {
      const key = op.clientOpKey
      if (state.ops[key]) return { duplicate: true }
      state.ops[key] = {
        clientOpKey: key,
        kind: op.kind,
        args: op.args,
        orgId: op.orgId,
        actor: op.actor || null,
        createdAt: op.createdAt || '',
        status: 'queued',
        attempts: 0,
        lastError: '',
        nextAt: 0,
        addedAt: Date.now(),
        updatedAt: Date.now(),
        deliveredAt: 0,
      }
      save()
      return { accepted: true }
    },

    // Oldest ready ops, marked 'sending' durably before they are handed to the
    // relay — so a relay crash mid-delivery is retried, never lost.
    claimReady(limit, now = Date.now()) {
      const ready = Object.values(state.ops)
        .filter((o) => o.status === 'queued' && (o.nextAt || 0) <= now)
        .sort((a, b) => a.addedAt - b.addedAt)
        .slice(0, limit)
      if (!ready.length) return []
      for (const op of ready) {
        op.status = 'sending'
        op.updatedAt = now
      }
      save()
      return ready.map((o) => ({ ...o }))
    },

    markDelivered(key) {
      const op = state.ops[key]
      if (!op) return
      op.status = 'delivered'
      op.deliveredAt = Date.now()
      op.updatedAt = op.deliveredAt
      op.lastError = ''
      save()
    },

    // Transient failure: back to the queue with a doubling backoff
    // (5s, 10s, 20s ... capped at 5 minutes) so a dead internet link is not
    // hammered, while recovery is still fast.
    markRetry(key, err, now = Date.now()) {
      const op = state.ops[key]
      if (!op) return
      op.attempts = (op.attempts || 0) + 1
      op.lastError = String(err?.message || err || '').slice(0, 300)
      const backoff = Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(op.attempts, 8))
      op.status = 'queued'
      op.nextAt = now + backoff
      op.updatedAt = now
      save()
    },

    // Permanent failure (bad data, missing encounter, wrong org). Kept visible
    // so the health page can show it, and retried from the queue file by hand
    // or by a fixed client push if ever needed.
    markError(key, err, now = Date.now()) {
      const op = state.ops[key]
      if (!op) return
      op.attempts = (op.attempts || 0) + 1
      op.lastError = String(err?.message || err || '').slice(0, 300)
      op.status = 'error'
      op.updatedAt = now
      save()
    },

    // Requeue ops stuck in 'sending' from a previous (crashed) relay run.
    requeueStuck(now = Date.now()) {
      let n = 0
      for (const op of Object.values(state.ops)) {
        if (op.status === 'sending') {
          op.status = 'queued'
          op.updatedAt = now
          n += 1
        }
      }
      if (n) save()
      return n
    },

    counts() {
      const c = { queued: 0, sending: 0, delivered: 0, error: 0, total: 0 }
      for (const op of Object.values(state.ops)) {
        c[op.status] = (c[op.status] || 0) + 1
        c.total += 1
      }
      return c
    },

    get(key) {
      return state.ops[key] ? { ...state.ops[key] } : null
    },

    prune,
    // Test helper: drop everything (including the file) — never used in
    // production paths.
    reset() {
      state = freshState()
      try { unlinkSync(file) } catch { /* already gone */ }
    },
  }
}
