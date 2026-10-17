// End-to-end smoke test for the LAN hub (Phase 2).
//
// Requires the Firestore emulator:   firebase emulators:start --only firestore
// Skips cleanly (exit 0) when it is not reachable, so plain `npm run test:hub`
// never fails a machine that just has no emulator running.
//
// Covers: HTTP auth + validation, durable queueing, duplicate rejection,
// relay delivery, HANDLER-level replay dedup (the double-quantity guard),
// line merging into one open script, and the permanent-error path.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EMU = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'
const [EMU_HOST, EMU_PORT] = EMU.split(':')

// Must be set before hub modules read them.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'medlogng'
process.env.FIRESTORE_EMULATOR_HOST = EMU

let passed = 0
let failed = 0
async function t(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (e) {
    failed += 1
    console.error('  FAIL ' + name + ' — ' + (e?.message || e))
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function emulatorUp() {
  try {
    const res = await fetch('http://' + EMU_HOST + ':' + EMU_PORT + '/', { signal: AbortSignal.timeout(1500) })
    return res.status < 500
  } catch {
    return false
  }
}

if (!(await emulatorUp())) {
  console.log('[hub-smoke] Firestore emulator not reachable at ' + EMU + ' — SKIPPED.')
  console.log('[hub-smoke] start it with:  firebase emulators:start --only firestore')
  process.exit(0)
}

const TOKEN = 'smoke-test-token'
const tmp = mkdtempSync(join(tmpdir(), 'medilogng-hub-'))
const queueFile = join(tmp, 'queue.json')
const orgId = 'test-hub-org'
const encId = 'test-hub-enc-' + Date.now().toString(36)
const patientId = 'test-hub-patient-1'

const { startHub } = await import('../../hub/server.js')
const { initFirestore, HANDLERS } = await import('../../hub/handlers.js')

const hub = await startHub({ port: 0, token: TOKEN, queueFile, relayMs: 60 * 60 * 1000 })
const db = initFirestore(hub.cfg) // same app instance — returns the shared db
const base = 'http://127.0.0.1:' + hub.server.address().port

const post = (body, token = TOKEN) =>
  fetch(base + '/outbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-token': token },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))

const rxOp = {
  clientOpKey: 'v1:rx_mirror:smoke-1',
  kind: 'rx_mirror',
  orgId,
  actor: { uid: 'doctor-1', email: 'doc@example.test' },
  createdAt: new Date().toISOString(),
  args: {
    patientId,
    patientName: 'Hub Smoke Patient',
    encounterId: encId,
    lines: [{ medicine: 'Metformin', dosage: '500mg', quantity: 30, unit: 'tabs', instructions: 'bd' }],
  },
}
const labOp = {
  clientOpKey: 'v1:lab_snapshot:smoke-1',
  kind: 'lab_snapshot',
  orgId,
  createdAt: new Date().toISOString(),
  args: {
    encounterId: encId,
    labOrder: { lab_order_id: 'lab_smoke_1', tests: ['FBC'], status: 'requested' },
  },
}

try {
  // ---- seed (emulator-only docs) ------------------------------------------
  await db.collection('encounters').doc(encId).set({
    organization_id: orgId,
    patient_id: patientId,
    patient_name: 'Hub Smoke Patient',
    status: 'planned',
    lab_orders: [],
  })

  await t('health endpoint reports ready + online', async () => {
    const r = await fetch(base + '/health')
    assert.equal(r.status, 200)
    const h = await r.json()
    assert.equal(h.ok, true)
    assert.equal(h.firestoreReady, true)
    assert.equal(h.internet, true) // emulator counts as reachable
    assert.equal(h.queue.total, 0)
    assert.equal(h.servesApp, existsSync(resolve('dist', 'index.html')))
  })

  // ---- app serving (skipped when dist/ has not been built) -----------------
  if (existsSync(resolve('dist', 'index.html'))) {
    await t('serves the EMR app from the same port', async () => {
      const r = await fetch(base + '/')
      assert.equal(r.status, 200)
      assert.match(r.headers.get('content-type') || '', /text\/html/)
      assert.match(r.headers.get('cache-control') || '', /no-cache/)
      const html = await r.text()
      assert.match(html, /<div id="app">/)
      // The sync token is injected so ward PCs need zero configuration.
      assert.ok(html.includes('window.__MEDILOG_HUB_TOKEN__="' + TOKEN + '"'), 'token injected into HTML')
    })

    await t('client-side routes fall back to the app (SPA)', async () => {
      const r = await fetch(base + '/consultation/some-encounter-id')
      assert.equal(r.status, 200)
      assert.match(r.headers.get('content-type') || '', /text\/html/)
      const html = await r.text()
      assert.match(html, /<div id="app">/)
    })

    await t('service worker is never cached', async () => {
      const r = await fetch(base + '/sw.js')
      assert.equal(r.status, 200)
      assert.match(r.headers.get('cache-control') || '', /no-cache/)
    })

    await t('path traversal is refused', async () => {
      // Raw HTTP (fetch normalizes ../ away before it reaches the server).
      const rawStatus = (path) => new Promise((resolveStatus) => {
        const req = httpRequest({ host: '127.0.0.1', port: hub.server.address().port, path, method: 'GET' }, (res) => {
          res.resume()
          resolveStatus(res.statusCode)
        })
        req.on('error', () => resolveStatus(0))
        req.end()
      })
      const s1 = await rawStatus('/../hub/config.js')
      const s2 = await rawStatus('/%2e%2e/hub/config.js')
      assert.ok(s1 === 403 || s1 === 404, 'plain traversal got ' + s1)
      assert.ok(s2 === 403 || s2 === 404, 'encoded traversal got ' + s2)
    })
  } else {
    console.log('  (skipped app-serving tests — run `npm run build` first)')
  }

  await t('rejects missing/wrong token', async () => {
    const r = await post({ ops: [rxOp] }, 'wrong-token')
    assert.equal(r.status, 401)
    const r2 = await post({ ops: [rxOp] }, '')
    assert.equal(r2.status, 401)
  })

  await t('rejects malformed ops (400, nothing queued)', async () => {
    const r = await post({ ops: [{ clientOpKey: 'x', kind: 'not_a_kind', orgId, args: {} }] })
    assert.equal(r.status, 400)
    const h = await (await fetch(base + '/health')).json()
    assert.equal(h.queue.total, 0)
  })

  await t('accepts valid ops durably before any internet write', async () => {
    const r = await post({ ops: [rxOp, labOp] })
    assert.equal(r.status, 200)
    assert.equal(r.json.accepted, 2)
    assert.equal(r.json.duplicates, 0)
    assert.equal(r.json.queue.queued, 2)
  })

  await t('duplicate push is rejected as duplicate, not re-stored', async () => {
    const r = await post({ ops: [rxOp, labOp] })
    assert.equal(r.status, 200)
    assert.equal(r.json.accepted, 0)
    assert.equal(r.json.duplicates, 2)
  })

  await t('relay delivers both ops to the emulator', async () => {
    await sleep(200) // let any startup tick finish
    let r = await hub.relay.runOnce()
    if (r.delivered < 2) {
      await sleep(300)
      r = await hub.relay.runOnce()
    }
    assert.equal(r.delivered, 2, 'delivered=' + r.delivered)
    const h = await (await fetch(base + '/health')).json()
    assert.equal(h.queue.delivered, 2)
    assert.equal(h.queue.queued, 0)
  })

  await t('rx landed as ONE request with the line + sync key', async () => {
    const snap = await db.collection('medication_requests')
      .where('patient_id', '==', patientId)
      .where('organization_id', '==', orgId).get()
    assert.equal(snap.size, 1, 'expected exactly one request doc')
    const doc = snap.docs[0].data()
    assert.equal(doc.items.length, 1)
    assert.equal(doc.items[0].medicine, 'Metformin')
    assert.equal(doc.items[0].quantity, 30)
    assert.ok(doc.sync_keys.includes(rxOp.clientOpKey))
    assert.equal(doc.created_via, 'lan-hub')
  })

  await t('lab landed on the encounter exactly once', async () => {
    const enc = (await db.collection('encounters').doc(encId).get()).data()
    assert.equal(enc.lab_orders.length, 1)
    assert.equal(enc.lab_orders[0].id, 'lab_smoke_1')
  })

  await t('HANDLER replay is a no-op (no doubled quantities)', async () => {
    const res1 = await HANDLERS.rx_mirror(db, rxOp)
    assert.equal(res1.deduped, true)
    const res2 = await HANDLERS.lab_snapshot(db, labOp)
    assert.equal(res2.deduped, true)
    const snap = await db.collection('medication_requests')
      .where('patient_id', '==', patientId).get()
    assert.equal(snap.docs[0].data().items[0].quantity, 30, 'quantity must stay 30')
    const enc = (await db.collection('encounters').doc(encId).get()).data()
    assert.equal(enc.lab_orders.length, 1, 'lab order must stay single')
  })

  await t('second prescription joins the SAME open script', async () => {
    const second = {
      ...rxOp,
      clientOpKey: 'v1:rx_mirror:smoke-2',
      args: { ...rxOp.args, lines: [{ medicine: 'Paracetamol', dosage: '1g', quantity: 10 }] },
    }
    const r = await post({ ops: [second] })
    assert.equal(r.json.accepted, 1)
    await hub.relay.runOnce()
    const snap = await db.collection('medication_requests')
      .where('patient_id', '==', patientId).get()
    assert.equal(snap.size, 1, 'still ONE request doc')
    assert.equal(snap.docs[0].data().items.length, 2, 'two lines in it')
  })

  await t('missing encounter becomes a permanent error, not a retry storm', async () => {
    const bad = {
      ...labOp,
      clientOpKey: 'v1:lab_snapshot:smoke-bad',
      args: { ...labOp.args, encounterId: 'does-not-exist' },
    }
    const r = await post({ ops: [bad] })
    assert.equal(r.json.accepted, 1)
    await hub.relay.runOnce()
    await sleep(100)
    await hub.relay.runOnce()
    const h = await (await fetch(base + '/health')).json()
    assert.equal(h.queue.error, 1, 'one error recorded')
    assert.equal(h.queue.queued, 0, 'not left retrying')
  })
} finally {
  // ---- cleanup -------------------------------------------------------------
  try {
    const snap = await db.collection('medication_requests').where('patient_id', '==', patientId).get()
    for (const d of snap.docs) await d.ref.delete()
    await db.collection('encounters').doc(encId).delete().catch(() => {})
  } catch { /* emulator already gone */ }
  await hub.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log('[hub-smoke] ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
