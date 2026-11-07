import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { createOfflineQueryCache } from '../../hub/offlineQueryCache.js'
import { makeHandler } from '../../hub/server.js'
import { createDeviceSessions, deviceProofPayload } from '../../hub/deviceSessions.js'

const authCalls = []
let pendingRows = []
let offline = false
const authenticator = {
  verify: async () => {
    if (offline) throw Object.assign(new Error('Expired token.'), { status: 401, expose: true })
    return { uid: 'staff-1', email: 'staff@example.test', displayName: 'Staff One' }
  },
  authorize: async (_identity, orgId, capability) => {
    authCalls.push({ orgId, capability })
    if (offline) throw Object.assign(new Error('Firestore unavailable.'), { code: 'unavailable' })
    if (orgId !== 'hospital-1') throw Object.assign(new Error('Wrong hospital.'), { status: 403, expose: true })
    if (capability === 'billing.invoice') throw Object.assign(new Error('No invoice capability.'), { status: 403, expose: true })
    if (capability === 'billing.payment') return { orgId, membership: { capabilities: ['billing.payment'] } }
    return { orgId, membership: { capabilities: ['beds.manage', 'billing.payment'] } }
  },
}
const db = {
  collection: (collectionName) => {
    const query = {
      where() { return this }, orderBy() { return this }, startAt() { return this }, startAfter() { return this },
      endAt() { return this }, endBefore() { return this }, limit() { return this },
      async get() {
        if (collectionName === 'invoices') return { docs: [{ id: 'invoice-1', data: () => ({
          organization_id: 'hospital-1', status: 'unpaid', total_kobo: 12500,
        }) }] }
        return { docs: [{ id: 'admission-1', data: () => ({
          organization_id: 'hospital-1', status: 'active', created_at: new Date('2026-10-01T12:00:00Z'),
        }) }] }
      },
    }
    return query
  },
}
const cache = createOfflineQueryCache({ log: { warn() {}, error() {} } })
await cache.initialize()
const sessions = createDeviceSessions({ log: { error() {} } })
await sessions.initialize()
const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const session = await sessions.register({ identity: { uid: 'staff-1', email: 'staff@example.test' }, orgId: 'hospital-1',
  publicKey: keyPair.publicKey.export({ format: 'jwk' }),
  authorization: { uid: 'staff-1', orgId: 'hospital-1', membership: { status: 'active', capabilities: ['beds.manage', 'billing.payment'] } },
})
const handler = makeHandler({
  cfg: { allowedOrigins: [] }, queue: { pendingForOrg: () => pendingRows }, relay: {}, db, authReady: true, authenticator,
  staticDir: '', serveStatic: null, log: { info() {}, warn() {}, error() {} },
  deviceSessions: sessions, offlineQueryCache: cache,
})

async function call(body, signedOffline = false) {
  const raw = JSON.stringify(body)
  const request = Readable.from([Buffer.from(raw)])
  request.method = 'POST'
  request.url = '/device/data/query'
  request.headers = {
    host: 'hospital.test', origin: 'https://hospital.test',
    'content-type': 'application/json', 'x-medilog-client': 'medilogng-web',
    authorization: 'Bearer valid-test-token',
  }
  if (signedOffline) {
    const timestamp = String(Date.now())
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    const bodyHash = createHash('sha256').update(raw).digest('hex')
    const payload = deviceProofPayload({ method: 'POST', url: request.url, contentType: 'application/json', bodyHash, timestamp, nonce })
    request.headers['x-device-device'] = session.deviceId
    request.headers['x-device-timestamp'] = timestamp
    request.headers['x-device-nonce'] = nonce
    request.headers['x-device-body-sha256'] = bodyHash
    request.headers['x-device-signature'] = sign('sha256', Buffer.from(payload), {
      key: keyPair.privateKey, dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  }
  request.socket = { encrypted: true, remoteAddress: '10.0.0.12', localPort: 8787 }
  const response = {
    headers: {}, setHeader(k, v) { this.headers[k] = v },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) },
    end(text) { this.body = text },
  }
  await handler(request, response)
  return { status: response.status, json: JSON.parse(response.body || '{}') }
}

const querySpec = { collection: 'admissions', filters: [
  { field: 'organization_id', op: '==', value: 'hospital-1' },
], orderBy: [{ field: 'created_at', dir: 'desc' }], limit: 20, startAt: null, endAt: null }
const accepted = await call({ orgId: 'hospital-1', query: querySpec })
assert.equal(accepted.status, 200)
assert.equal(accepted.json.source, 'cloud')
assert.equal(accepted.json.docs[0].id, 'admission-1')
assert.deepEqual(authCalls[0], { orgId: 'hospital-1', capability: '' })

offline = true
const savedQuery = await call({ orgId: 'hospital-1', query: querySpec }, true)
assert.equal(savedQuery.status, 200)
assert.equal(savedQuery.json.source, 'host-cache', 'a signed LAN session can read the saved result when Firestore is unavailable')
assert.equal(savedQuery.json.docs[0].data.status, 'active')
offline = false

const noScope = await call({ orgId: 'hospital-1', query: { ...querySpec, filters: [] } })
assert.equal(noScope.status, 400, 'the Host must refuse unscoped queries')

authCalls.length = 0
const cashier = await call({ orgId: 'hospital-1', query: { ...querySpec, collection: 'invoices' } })
assert.equal(cashier.status, 200, 'billing.payment is sufficient for invoice reads where rules allow it')
assert.deepEqual(authCalls.map((x) => x.capability), ['', 'billing.invoice', 'billing.payment'])

pendingRows = [{ kind: 'document_mutation', orgId: 'hospital-1', status: 'queued', addedAt: Date.now(),
  actor: { uid: 'staff-1', name: 'Staff One' }, args: { mutations: [{ collection: 'appointments', id: 'appointment-pending', action: 'create',
    data: { organization_id: 'hospital-1', status: 'scheduled', patient_id: 'patient-1' } }] } }]
const sharedPending = await call({ orgId: 'hospital-1', query: { ...querySpec, collection: 'appointments', filters: [
  { field: 'organization_id', op: '==', value: 'hospital-1' }, { field: 'status', op: '==', value: 'scheduled' },
] } })
assert.equal(sharedPending.status, 200)
assert.equal(sharedPending.json.docs.some((row) => row.id === 'appointment-pending'), true,
  'the LAN host overlays an accepted offline create onto the shared query')
pendingRows = []

const wrongHospital = await call({ orgId: 'hospital-2', query: {
  ...querySpec, filters: [{ field: 'organization_id', op: '==', value: 'hospital-2' }],
} })
assert.equal(wrongHospital.status, 403)
console.log('Host query endpoint enforces hospital scope and read capabilities before serving cloud results.')
