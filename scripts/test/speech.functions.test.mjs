import assert from 'node:assert/strict'
import { createSpeechHealthHandler, createSpeechHttpHandler } from '../../functions/index.js'

const audit = []
let providerCalls = 0
const store = {
  collection(name) {
    if (name === 'organization_memberships') return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ status: 'active', capabilities: ['encounter.edit'] }) }) }) }
    if (name === 'encounters') return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ organization_id: 'hospital-1', patient_id: 'patient-1' }) }) }) }
    if (name === 'audit_events') return {
      add: async (event) => { audit.push(event); return { id: 'audit-' + audit.length } },
      doc: (id) => ({
        create: async (event) => { if (audit.some((row) => row.document_id === id)) throw Object.assign(new Error('exists'), { code: 6 }); audit.push({ ...event, document_id: id }) },
        update: async (event) => { const row = audit.find((entry) => entry.document_id === id); if (row) Object.assign(row, event) },
      }),
    }
    throw new Error('Unexpected collection ' + name)
  },
}
const auth = { verifyIdToken: async (token, revoked) => {
  assert.equal(token, 'synthetic-valid-firebase-id-token')
  assert.equal(revoked, true)
  return { uid: 'clinician-1' }
} }
const response = () => ({ code: 0, headers: {}, payload: null, set(k, v) { this.headers[k] = v; return this }, status(code) { this.code = code; return this }, json(payload) { this.payload = payload; return this }, end() { return this } })
const req = ({ method = 'POST', origin = 'https://medlogng.web.app', authHeader = 'Bearer synthetic-valid-firebase-id-token', orgId = 'hospital-1', patientId = 'patient-1', encounterId = 'encounter-1', requestId = 'synthetic-request-0001', contentType = 'audio/wav' } = {}) => ({
  method, headers: { origin, authorization: authHeader, 'x-medilog-client': 'medilogng-web', 'x-speech-request-id': requestId, 'content-type': contentType },
  query: { orgId, patientId, encounterId }, rawBody: (() => { const b = Buffer.alloc(1024); b.write('RIFF'); b.write('WAVE', 8); return b })(),
  get(name) { return this.headers[String(name).toLowerCase()] || '' },
})

const handler = createSpeechHttpHandler({
  store, auth,
  provider: async ({ audio, contentType, apiKey, endpoint }) => {
    providerCalls++
    assert.equal(audio.length, 1024); assert.equal(contentType, 'audio/wav')
    assert.equal(apiKey, 'server-only'); assert.equal(endpoint, 'https://api.in.deepgram.com')
    return { text: 'synthetic generated transcript', model: 'nova-3-medical' }
  },
  secret: () => 'server-only', endpoint: () => 'https://api.in.deepgram.com', allowClinicalAudio: () => true,
  timestamp: () => 'test-time', log: { error() {} },
})

const ok = response()
await handler(req(), ok)
assert.equal(ok.code, 200)
assert.equal(ok.payload.text, 'synthetic generated transcript')
assert.equal(providerCalls, 1)
assert.equal(audit.length, 1)
assert.equal(audit[0].patient_id, 'patient-1')
assert.equal(audit[0].actor_user_id, 'clinician-1')
assert.equal(audit[0].request_id, 'synthetic-request-0001')
assert.equal(audit[0].status, 'completed')
const duplicate = response()
await handler(req(), duplicate)
assert.equal(duplicate.code, 409)
assert.equal(providerCalls, 1, 'duplicate request id must not repeat provider processing')

const denied = response()
await handler(req({ authHeader: '' }), denied)
assert.equal(denied.code, 401)
assert.equal(providerCalls, 1, 'unauthenticated audio must never reach the provider')
const wrongOrigin = response()
await handler(req({ origin: 'https://evil.example' }), wrongOrigin)
assert.equal(wrongOrigin.code, 403)
assert.equal(providerCalls, 1)

const unavailable = createSpeechHttpHandler({ store, auth, provider: async () => assert.fail('disabled backend must not invoke provider'), secret: () => 'server-only', endpoint: () => 'https://api.in.deepgram.com', allowClinicalAudio: () => false })
const disabled = response()
await unavailable(req(), disabled)
assert.equal(disabled.code, 503)

const health = createSpeechHealthHandler({ store, auth, checkProvider: async () => true, secret: () => 'server-only', endpoint: () => 'https://api.in.deepgram.com', allowClinicalAudio: () => true })
const healthResponse = response()
await health({ ...req({ method: 'GET' }), get(name) { return this.headers[String(name).toLowerCase()] || '' } }, healthResponse)
assert.equal(healthResponse.code, 200)
assert.deepEqual(healthResponse.payload, { ok: true, available: true, provider: 'deepgram' })
console.log('Firebase speech authentication, live permission, encounter binding, audit and disabled-provider tests passed')
