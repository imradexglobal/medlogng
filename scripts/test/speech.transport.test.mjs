import assert from 'node:assert/strict'
import { getSpeechBackend, transcribeRecording } from '../../src/services/speechTransport.js'

const user = { getIdToken: async () => 'synthetic-firebase-id-token' }
const jsonResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload })
let calls = []
const hostBackend = await getSpeechBackend({ orgId: 'hospital-1', user, origin: 'https://host.hospital.test', fetchImpl: async (url, options) => {
  calls.push([String(url), options])
  return jsonResponse({ ok: true, available: true, provider: 'deepgram' })
} })
assert.equal(hostBackend.kind, 'host')
assert.equal(calls[0][0], 'https://host.hospital.test/speech/health?orgId=hospital-1')
assert.equal(calls[0][1].headers.Authorization, 'Bearer synthetic-firebase-id-token')
assert.equal(calls[0][1].headers['x-medilog-client'], 'medilogng-web')

calls = []
const cloudBaseUrl = 'https://us-central1-medlogng.cloudfunctions.net/'
const cloudBackend = await getSpeechBackend({ orgId: 'hospital-1', user, origin: 'https://medlogng.web.app', cloudBaseUrl,
  fetchImpl: async (url, options) => {
    calls.push([String(url), options])
    return calls.length === 1
      ? { ...jsonResponse({ ok: true, available: false }), headers: { get: () => 'application/json' } }
      : jsonResponse({ ok: true, available: true, provider: 'deepgram' })
  } })
assert.equal(cloudBackend.kind, 'firebase')
assert.match(calls[1][0], /^https:\/\/us-central1-medlogng\.cloudfunctions\.net\/speechHealth\?orgId=hospital-1$/)

let posted
const transcription = await transcribeRecording({ backend: cloudBackend, blob: new Blob([Buffer.alloc(1024)], { type: 'audio/wav' }),
  orgId: 'hospital-1', patientId: 'patient-1', encounterId: 'encounter-1', requestId: 'request-synthetic-001',
  fetchImpl: async (url, options) => {
    posted = { url: new URL(url), options }
    return jsonResponse({ ok: true, status: 'completed', text: 'synthetic transcript', model: 'nova-3-medical', processingMs: 1234 })
  } })
assert.equal(transcription.text, 'synthetic transcript')
assert.equal(transcription.processingMs, 1234)
assert.equal(posted.url.searchParams.get('patientId'), 'patient-1')
assert.equal(posted.url.searchParams.get('encounterId'), 'encounter-1')
assert.equal(posted.options.headers['X-Speech-Request-Id'], 'request-synthetic-001')
assert.equal(posted.options.headers.Authorization, 'Bearer synthetic-firebase-id-token')

const unavailable = await getSpeechBackend({ orgId: 'hospital-1', user, origin: 'https://medlogng.web.app', cloudBaseUrl,
  fetchImpl: async () => ({ ...jsonResponse({ ok: true, available: false }), headers: { get: () => 'application/json' } }) })
assert.equal(unavailable, null)
const hostingRewrite = await getSpeechBackend({ orgId: 'hospital-1', user, origin: 'https://medlogng.web.app', cloudBaseUrl,
  fetchImpl: async (_url, options) => {
    if (options.signal?.aborted) throw Error('unexpected abort')
    return { ...jsonResponse({}), headers: { get: () => 'text/html' } }
  } })
assert.equal(hostingRewrite, null, 'Hosting rewrite must not be mistaken for a transcription service')

console.log('Host and Firebase speech backend detection, auth header and manual transcription transport passed')
